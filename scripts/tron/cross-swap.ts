import { strict as assert } from 'node:assert';
import { resolve } from 'node:path';
import * as runtime from '../../core/runtime';
import { defaultAccountDisputeConfigForParties } from '../../core/account/config/dispute-config';
import { getLiveJAdapter } from '../../core/runtime/j-submit/live-jadapters';
import { readStorageFrameRecord } from '../../core/storage/read/read';
import { buildCrossJurisdictionSwapSubmission } from '../../core/runtime/j-submit/api';
import { safeStringify } from '../../core/protocol/serialization';
import { hubs, users, hubSeed, userSeed, credit, amount, replica, walletFor, waitFor, connectChains,
  createParties, enableHubs, account, accountSnapshot, allAccounts, dumpFailure, startCrossTransport } from './cross-swap-context';

const data = resolve(process.env['XLN_TRON_STAND_PATH'] || resolve(import.meta.dir, '../../db/native-tron-release-20260918'));
assert.equal(process.env['XLN_DB_PATH'], `${data}/cross-runtime`);
assert.equal(process.env['XLN_JURISDICTIONS_PATH'], `${data}/dual-jurisdictions.json`);
const resume = process.argv.includes('--resume');
const restore = process.argv.includes('--restore');
assert(!(resume && restore));
const progressPath = `${data}/cross-swap-progress.json`;
assert.equal(await Bun.file(progressPath).exists(), resume || restore, 'Existing swap requires explicit resume/restore');
if (resume) {
  const progress = await Bun.file(progressPath).json();
  assert(['setup', 'credit-ready'].includes(progress.stage),
    'An attempted submission requires receipt/WAL inspection; never rebuild its signed intent on retry');
  assert.equal(await Bun.file(`${data}/cross-swap.json`).exists(), false, 'Completed swap requires restore');
}
const prior = restore ? await Bun.file(`${data}/cross-swap.json`).json() : null;
const hubEnv = await runtime.main(hubSeed, { numericSignerPrewarmCount: 1 });
const userEnv = await runtime.main(userSeed, { numericSignerPrewarmCount: 1 });
assert(hubEnv.runtimeId && userEnv.runtimeId);
assert.notEqual(hubEnv.runtimeId, userEnv.runtimeId);
const envs = [hubEnv, userEnv];
const hubWallet = walletFor(hubEnv);
const userWallet = walletFor(userEnv);
let transport: ReturnType<typeof startCrossTransport> | null = null;
const save = (stage: string) => Bun.write(progressPath, safeStringify({ stage,
  heights: envs.map(env => ({ runtimeId: env.runtimeId, height: env.state.height })) }, 2));
const routeIds = ['native-cross-alice-20260918', 'native-cross-bob-20260918'];
const routes = () => hubs.map(hub => ({ hub: hub.entityId,
  routes: routeIds.map(id => replica(hubEnv, hub).state.crossJurisdictionSwaps?.get(id)) }));
try {
  if (restore) {
    assert.deepEqual(JSON.parse(safeStringify(allAccounts(hubEnv, userEnv))), prior.accounts);
  } else {
    await save('setup');
    for (const env of envs) runtime.startRuntimeLoop(env);
    await hubWallet.connect({ mode: 'embedded', runtimeId: hubEnv.runtimeId! });
    await userWallet.connect({ mode: 'embedded', runtimeId: userEnv.runtimeId! });
    for (const env of envs) await connectChains(env);
    await createParties(hubEnv, hubs, hubSeed, hubWallet);
    await createParties(userEnv, users, userSeed, userWallet);
    await enableHubs(hubEnv, hubWallet);
    transport = startCrossTransport(hubEnv, userEnv);
    // User profiles travel on the authenticated direct connection opened by
    // the first Account proposal; waiting for them before dialing deadlocks setup.
    await waitFor('authenticated hub profiles', () => hubs.every(hub => Boolean(userEnv.gossip.getProfile(hub.entityId))));
    for (const user of users) {
      const hub = hubs.find(hub => hub.network === user.network)!;
      if (!account(userEnv, user, hub)) await userWallet.send({ runtimeTxs: [], entityInputs: [{
        entityId: user.entityId, signerId: user.signerId, entityTxs: [{ type: 'openAccount', data: {
          targetEntityId: hub.entityId, tokenId: 1, creditAmount: credit,
          disputeConfig: defaultAccountDisputeConfigForParties(user.entityId, false, hub.entityId, true),
        } }],
      }] });
      await waitFor(`account ${user.name}`, () => {
        const left = account(userEnv, user, hub), right = account(hubEnv, hub, user);
        return Boolean(left && right && left.currentHeight >= 1 && right.currentHeight >= 1 &&
          !left.pendingFrame && !right.pendingFrame && !left.mempool.length && !right.mempool.length);
      });
      if (accountSnapshot(hubEnv, hub, user).view.peerCreditLimit < credit)
        await hubWallet.send({ runtimeTxs: [], entityInputs: [{ entityId: hub.entityId, signerId: hub.signerId,
          entityTxs: [{ type: 'extendCredit', data: { counterpartyEntityId: user.entityId, tokenId: 1, amount: credit } }],
        }] });
      await waitFor(`credit ${user.name}`, () => {
        const pair = [accountSnapshot(userEnv, user, hub), accountSnapshot(hubEnv, hub, user)] as const;
        return pair.every(value => !value.pending && !value.queued && value.view.ownCreditLimit === credit &&
          value.view.peerCreditLimit === credit) && pair[0].root === pair[1].root;
      });
    }
    await save('credit-ready');
    for (const pair of allAccounts(hubEnv, userEnv)) {
      assert.equal(pair.user.view.outCapacity, credit);
      assert.equal(pair.user.view.inCapacity, credit);
      assert.equal(pair.user.view.collateral, 0n);
    }
    if (!await Bun.file(`${data}/cross-swap-before.json`).exists())
      await Bun.write(`${data}/cross-swap-before.json`, safeStringify(allAccounts(hubEnv, userEnv), 2));
    for (const [index, source, target, sourceHub, targetHub] of [
      [0, users[0], users[1], hubs[0], hubs[1]], [1, users[3], users[2], hubs[1], hubs[0]],
    ] as const) {
      const orderId = routeIds[index]!;
      const known = replica(userEnv, source).state.crossJurisdictionAuthorizations?.has(orderId);
      if (!known) {
        const result = buildCrossJurisdictionSwapSubmission(userEnv, { orderId,
          sourceUserEntityId: source.entityId, sourceHubEntityId: sourceHub.entityId,
          targetHubEntityId: targetHub.entityId, targetUserEntityId: target.entityId,
          sourceUserSignerId: source.signerId, sourceHubSignerId: sourceHub.signerId,
          targetHubSignerId: targetHub.signerId, targetUserSignerId: target.signerId,
          sourceTokenId: 1, sourceAmount: amount, targetTokenId: 1, targetAmount: amount, expiresInMs: 600_000 });
        await save(`submitting-${index}`);
        await userWallet.submitCrossJurisdictionIntent(result.route);
      }
      await waitFor(`route ${index} materialized`, () => hubs.every(hub =>
        Boolean(replica(hubEnv, hub).state.crossJurisdictionSwaps?.get(orderId))));
    }
    await waitFor('both orders settled', () => routes().every(entry => entry.routes.every(route =>
      route?.status === 'settled' && route.filledSourceAmount === amount && route.filledTargetAmount === amount)), 30_000);
    for (const env of envs) await runtime.stopJurisdictionWatchersAndWait(env);
    for (const env of envs) assert(await runtime.waitForRuntimeWorkDrained(env, 10_000), 'Pending financial work');
    for (const env of envs) assert(await runtime.stopRuntimeLoopAndWait(env, 10_000));
  }
  const accounts = allAccounts(hubEnv, userEnv);
  for (const [index, pair] of accounts.entries()) {
    assert.equal(pair.user.root, pair.hub.root);
    assert.equal(pair.user.pending || pair.hub.pending, false);
    assert.equal(pair.user.queued + pair.hub.queued + pair.user.pulls + pair.hub.pulls + pair.user.offers + pair.hub.offers, 0);
    assert.equal(pair.user.view.outCapacity, index === 0 || index === 3 ? credit - amount : credit + amount);
    assert.equal(pair.user.view.collateral, 0n, 'This proof uses explicit bilateral credit, not invented collateral');
  }
  const anchors = [];
  for (const env of envs) {
    const frame = await readStorageFrameRecord(runtime.getRuntimeWalDb(env), env.state.height);
    assert(frame);
    anchors.push({ runtimeId: env.runtimeId, height: env.state.height, frameHash: frame.frameHash, postStateHash: frame.postStateHash });
  }
  if (restore) assert.deepEqual(anchors, prior.anchors);
  await Bun.write(`${data}/cross-swap${restore ? '-restore' : ''}.json`, safeStringify({
    kind: 'PRIVATE_ETHEREUM_NATIVE_TRON_CREDIT_SWAP', restore, anchors, accounts, routes: routes(),
    scope: 'Two sovereign Runtimes over authenticated sockets, private Ethereum and native TVM, bilateral credit; no public deployment or rendered UI claim',
  }, 2));
  await save(restore ? 'restored' : 'complete');
  console.log('NATIVE_CROSS_SWAP_VERIFIED', safeStringify({ restore, anchors }));
} catch (error) {
  await dumpFailure(`${data}/cross-swap-failure.json`, envs, error);
  throw error;
} finally {
  hubWallet.disconnect(); userWallet.disconnect();
  for (const env of envs) {
    await runtime.stopJurisdictionWatchersAndWait(env);
    await runtime.stopRuntimeLoopAndWait(env, 10_000);
    await runtime.stopP2PAndWait(env, 10_000);
    await runtime.closeRuntimeDb(env);
    for (const name of env.state.jReplicas.keys()) await getLiveJAdapter(env, name)?.close();
    await runtime.closeInfraDb(env);
  }
  transport?.close();
}
process.exit(0);
