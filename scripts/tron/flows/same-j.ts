import { strict as assert } from 'node:assert';
import { resolve } from 'node:path';
import * as runtime from '../../../core/runtime';
import { getLiveJAdapter } from '../../../core/runtime/j-submit/live-jadapters';
import { loadJurisdictionsAsync } from '../../../core/jurisdiction/adapter/kernel/jurisdiction-loader';
import { readStorageFrameRecord } from '../../../core/storage/read/read';
import { safeStringify } from '../../../core/protocol/serialization';
import { defaultAccountDisputeConfigForParties } from '../../../core/account/config/dispute-config';
import {
  hubSeed,
  userSeed,
  walletFor,
  waitFor,
  dumpFailure,
  startCrossTransport,
  connectChains,
  createParties,
  enableHubs,
  account,
  accountSnapshot,
  credit,
} from '../cross-swap-context';
import {
  hub,
  alice,
  bob,
  positions,
  pairQuiet,
  configureFees,
  pay,
  swap,
  lending,
  send,
  type Envs,
} from './same-j-steps';

// Pay, same-J Swap and Lending between two sovereign Runtimes whose user and
// hub Entities all live on native TVM. Own a fresh Runtime namespace: no prior
// Cross operation or EVM companion is required. Progress forbids blind retry.
const data = resolve(
  process.env['XLN_TRON_STAND_PATH'] || resolve(import.meta.dir, '../../../db/native-tron-release-20260918'),
);
assert(process.env['XLN_TRON_SAME_J_CASE'], 'An explicit case owns the fresh test identities and preserved WAL');
assert.equal(process.env['XLN_DB_PATH'], `${data}/same-j-runtime`);
assert.equal(process.env['XLN_JURISDICTIONS_PATH'], `${data}/jurisdictions.json`);
const configuration = await loadJurisdictionsAsync();
assert.deepEqual(
  Object.values(configuration.jurisdictions).map(entry => [entry.name, entry.mode]),
  [[hub.network, 'tron']],
);
const restore = process.argv.includes('--restore');
const progressPath = `${data}/same-j-progress.json`;
assert.equal(
  await Bun.file(progressPath).exists(),
  restore,
  'Inspect the WAL before resuming an existing same-J attempt',
);
const previous = restore ? await Bun.file(`${data}/same-j.json`).json() : null;
const hubEnv = await runtime.main(hubSeed, { numericSignerPrewarmCount: 1 });
const userEnv = await runtime.main(userSeed, { numericSignerPrewarmCount: 1 });
const all = [hubEnv, userEnv];
const envs: Envs = { hubEnv, userEnv, hubWallet: walletFor(hubEnv), userWallet: walletFor(userEnv) };
let transport: ReturnType<typeof startCrossTransport> | null = null;
const timings: Record<string, number> = {};
const save = async (stage: string) => {
  await Bun.write(progressPath, safeStringify({ stage, timings, positions: positions(envs) }, 2));
  console.log('SAME_J_STAGE', stage);
};
const timed = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
  await save(`${name}-submitting`);
  const started = performance.now();
  const result = await run();
  timings[name] = Math.round(performance.now() - started);
  await save(`${name}-complete`);
  return result;
};
try {
  let report: Record<string, unknown> = {};
  if (!restore) {
    assert(
      all.every(env => env.state.height === 0),
      'Fresh same-J setup cannot reuse an existing WAL',
    );
    await Bun.write(progressPath, safeStringify({ stage: 'setup-submitting' }, 2));
    for (const env of all) runtime.startRuntimeLoop(env);
    await envs.hubWallet.connect({ mode: 'embedded', runtimeId: hubEnv.runtimeId! });
    await envs.userWallet.connect({ mode: 'embedded', runtimeId: userEnv.runtimeId! });
    for (const env of all) await connectChains(env);
    await createParties(hubEnv, [hub], hubSeed, envs.hubWallet);
    await createParties(userEnv, [alice, bob], userSeed, envs.userWallet);
    await enableHubs(hubEnv, envs.hubWallet, [hub]);
    transport = startCrossTransport(hubEnv, userEnv, { hubs: [hub], users: [alice, bob] });
    await waitFor('TVM hub profile', () => Boolean(userEnv.gossip.getProfile(hub.entityId)), 30_000);
    for (const user of [alice, bob]) {
      await send(envs, user, [
        {
          type: 'openAccount',
          data: {
            targetEntityId: hub.entityId,
            tokenId: 1,
            creditAmount: credit,
            disputeConfig: defaultAccountDisputeConfigForParties(user.entityId, false, hub.entityId, true),
          },
        },
      ]);
      await waitFor(
        `native Account ${user.name}`,
        () => Boolean(account(userEnv, user, hub) && account(hubEnv, hub, user)) && pairQuiet(envs, user),
      );
      await send(envs, hub, [
        { type: 'extendCredit', data: { counterpartyEntityId: user.entityId, tokenId: 1, amount: credit } },
      ]);
      await waitFor(`native signed credit ${user.name}`, () => {
        const pair = [accountSnapshot(userEnv, user, hub), accountSnapshot(hubEnv, hub, user)];
        return (
          pairQuiet(envs, user) &&
          pair.every(value => value.view.ownCreditLimit === credit && value.view.peerCreditLimit === credit)
        );
      });
      const initial = accountSnapshot(userEnv, user, hub);
      assert.equal(initial.view.collateral, 0n);
      assert.equal(initial.view.outCapacity, credit);
      assert.equal(initial.view.inCapacity, credit);
      assert.deepEqual(
        account(userEnv, user, hub)!.state.disputeConfig,
        defaultAccountDisputeConfigForParties(user.entityId, false, hub.entityId, true),
      );
    }
    assert(Object.values(positions(envs)).every(value => value === null || value === 0n));
    assert(all.every(env => [...env.state.eReplicas.values()].every(replica => replica.state.reserves.size === 0)));
    const adapter = getLiveJAdapter(userEnv, hub.network);
    assert(adapter?.mode === 'tron', 'Same-J flows must run on the native TVM adapter');
    assert(all.every(env => env.state.jReplicas.size === 1));
    assert.equal(hubEnv.state.eReplicas.size, 1);
    assert.equal(userEnv.state.eReplicas.size, 2);
    const chain = { chainId: adapter.chainId, depository: adapter.addresses.depository };
    await waitFor('accounts quiet', () => pairQuiet(envs, alice) && pairQuiet(envs, bob), 30_000);
    await timed('fees', () => configureFees(envs));
    const payment = await timed('pay', () => pay(envs));
    const exchange = await timed('swap', () => swap(envs));
    const loan = await timed('lending', () => lending(envs));
    for (const env of all) await runtime.stopJurisdictionWatchersAndWait(env);
    for (const env of all) assert(await runtime.waitForRuntimeWorkDrained(env, 10_000), 'Pending financial work');
    for (const env of all) assert(await runtime.stopRuntimeLoopAndWait(env, 10_000));
    report = { chain, payment, swap: exchange, lending: loan };
  }
  assert(getLiveJAdapter(userEnv, hub.network)?.mode === 'tron', 'Same-J restore must retain the native TVM adapter');
  const final = positions(envs);
  assert(pairQuiet(envs, alice) && pairQuiet(envs, bob), 'Account roots must agree with no pending work');
  if (restore) assert.deepEqual(JSON.parse(safeStringify(final)), previous.final);
  const anchors = [];
  for (const env of all) {
    const frame = await readStorageFrameRecord(runtime.getRuntimeWalDb(env), env.state.height);
    assert(frame);
    anchors.push({
      runtimeId: env.runtimeId,
      height: env.state.height,
      frameHash: frame.frameHash,
      postStateHash: frame.postStateHash,
    });
  }
  if (restore) assert.deepEqual(anchors, previous.anchors);
  await Bun.write(
    `${data}/same-j${restore ? '-restore' : ''}.json`,
    safeStringify(
      {
        kind: 'NATIVE_TVM_SAME_J_PAY_SWAP_LENDING',
        restore,
        ...report,
        timings,
        final,
        anchors,
        scope:
          'Private native TVM hub and users over authenticated sockets; bilateral credit claims, no on-chain movement in these flows',
      },
      2,
    ),
  );
  await save(restore ? 'restored' : 'complete');
  console.log('NATIVE_SAME_J_VERIFIED', safeStringify({ restore, timings, anchors }));
} catch (error) {
  await dumpFailure(`${data}/same-j-failure.json`, all, error);
  throw error;
} finally {
  envs.hubWallet.disconnect();
  envs.userWallet.disconnect();
  for (const env of all) {
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
