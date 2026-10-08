import { strict as assert } from 'node:assert';
import { resolve } from 'node:path';
import { getBytes, hexlify, Wallet } from 'ethers';
import * as runtime from '../../../core/runtime';
import { deriveSignerKeySync } from '../../../core/account/crypto';
import { getLiveJAdapter } from '../../../core/runtime/j-submit/live-jadapters';
import { readStorageFrameRecord } from '../../../core/storage/read/read';
import { safeStringify } from '../../../core/protocol/serialization';
import { isBatchEmpty } from '../../../core/jurisdiction/machine/batch';
import { assertCanonicalSettlementWorkspace } from '../../../core/account/tx/handlers/settlement/transition';
import { buildExternalToReserveTx, buildReserveToCollateralTx, buildMoveSettlementContinuation, buildBroadcastTx, buildReserveToExternalEoaTx }
  from '../../../frontend/src/lib/components/Entity/account/entity-action-txs';
import { hubSeed, userSeed, hubs, users, amount, credit, replica, walletFor, account,
  accountSnapshot, allAccounts, waitFor, dumpFailure, startCrossTransport } from '../cross-swap-context';

const data = resolve(process.env['XLN_TRON_STAND_PATH'] || resolve(import.meta.dir, '../../../db/native-tron-release-20260918'));
assert.equal(process.env['XLN_DB_PATH'], `${data}/cross-runtime`);
assert.equal(process.env['XLN_JURISDICTIONS_PATH'], `${data}/dual-jurisdictions.json`);
const restore = process.argv.includes('--restore');
const inspect = process.argv.includes('--inspect');
const resume = process.argv.includes('--resume');
const progressPath = `${data}/cross-withdraw-progress.json`;
assert.equal(await Bun.file(progressPath).exists(), restore || inspect || resume, 'Existing withdrawal requires receipt/WAL inspection');
const previous = restore ? await Bun.file(`${data}/cross-withdraw.json`).json() : null;
const token = await Bun.file(`${data}/token.json`).json();
const foundationKey = getBytes(`0x${'1'.padStart(64, '0')}`); // Public private-chain fixture signer.
const foundation = new Wallet(hexlify(foundationKey)).address.toLowerCase();
const hub = hubs[1], user = users[1];
const hubEnv = await runtime.main(hubSeed, { numericSignerPrewarmCount: 1 });
const userEnv = await runtime.main(userSeed, { numericSignerPrewarmCount: 1 });
const envs = [hubEnv, userEnv];
const hubWallet = walletFor(hubEnv), userWallet = walletFor(userEnv);
let transport: ReturnType<typeof startCrossTransport> | null = null;
const adapter = getLiveJAdapter(hubEnv, hub.network);
assert(adapter?.mode === 'tron');
const hubKey = deriveSignerKeySync(hubSeed, hub.name);
const funding: Array<{ kind: string; transactionHash: string }> = [];
const snapshot = () => ({ accounts: allAccounts(hubEnv, userEnv),
  hubReserve: replica(hubEnv, hub).state.reserves.get(1) ?? 0n,
  userReserve: replica(userEnv, user).state.reserves.get(1) ?? 0n,
  hubNonce: replica(hubEnv, hub).state.jBatchState?.entityNonce ?? 0,
  userNonce: replica(userEnv, user).state.jBatchState?.entityNonce ?? 0,
  workspace: Boolean(account(userEnv, user, hub)?.state.settlementWorkspace),
  continuationCount: replica(userEnv, user).state.settlementContinuations?.size ?? 0,
});
const save = async (stage: string) => {
  await Bun.write(progressPath, safeStringify({ stage, funding, snapshot: snapshot() }, 2));
  console.log('CROSS_WITHDRAW_STAGE', stage);
};
try {
  if (inspect) {
    await dumpFailure(`${data}/cross-withdraw-inspection.json`, envs, 'Read-only inspection after failed withdrawal');
    console.log('CROSS_WITHDRAW_INSPECTION', safeStringify(snapshot()));
  } else {
  if (restore) assert.deepEqual(JSON.parse(safeStringify(snapshot())), previous.final);
  else {
    if (resume) {
      const progress = await Bun.file(progressPath).json();
      assert.equal(progress.stage, 'withdrawal-submitting', 'Resume only the inspected pre-submission failure');
      funding.push(...progress.funding);
      for (const [env, owner, peer] of [[hubEnv, hub, user], [userEnv, user, hub]] as const) {
        const value = account(env, owner, peer);
        assert(value && !value.pendingFrame && value.mempool.length === 0);
        const workspace = value.state.settlementWorkspace;
        assert(workspace?.status === 'ready_to_submit');
        assert.equal(assertCanonicalSettlementWorkspace(value.state, workspace),
          '0x0556df4e7f68c3c50241ebfce5a5675cbba1cb4e9ced27acf16c35e095fc6bbe');
        const batch = replica(env, owner).state.jBatchState;
        assert(!batch || (!batch.sentBatch && isBatchEmpty(batch.batch)));
      }
      assert.equal(snapshot().continuationCount, 0);
      assert.equal(await adapter.getEntityNonce(user.entityId), 0n);
      assert.equal(await adapter.getEntityNonce(hub.entityId), 2n);
      assert.equal(await adapter.getCollateral(hub.entityId, user.entityId, 1), amount);
      assert.equal(await adapter.getErc20Balance(token.evm, user.signerId), 0n);
      assert.equal(await adapter.getReserves(user.entityId, 1), 0n);
    } else {
    const before = snapshot();
    assert.equal(before.accounts[1]!.user.view.outCapacity, credit + amount);
    assert.equal(before.accounts[1]!.user.view.collateral, 0n);
    assert.equal(before.hubReserve + before.userReserve, 0n);
    assert.equal(await adapter.getErc20Balance(token.evm, foundation), 1_000_000_000_000n);
    assert.equal(await adapter.getErc20Balance(token.evm, hub.signerId), 0n);
    assert.equal(await adapter.getErc20Balance(token.evm, user.signerId), 0n);
    assert.equal(await adapter.getCollateral(hub.entityId, user.entityId, 1), 0n);
    await Bun.write(`${data}/cross-withdraw-before.json`, safeStringify(before, 2));
    await save('funding-started');
    for (const owner of [hub, user]) {
      // Native adapter amounts are SUN; transfer actual TRX to activate and fund each signer.
      const transactionHash = await adapter.transferNative(foundationKey, owner.signerId, 10_000_000_000n);
      funding.push({ kind: `gas-${owner.name}`, transactionHash });
      await save(`gas-funded-${owner.name}`);
    }
    const transactionHash = await adapter.transferErc20(foundationKey, token.evm, hub.signerId, amount);
    funding.push({ kind: 'hub-token-funding', transactionHash });
    assert.equal(await adapter.getErc20Balance(token.evm, hub.signerId), amount);
    await save('hub-tokens-funded');
    await adapter.approveErc20(hubKey, token.evm, adapter.addresses.depository, amount);
    assert.equal(await adapter.getErc20Allowance(token.evm, hub.signerId, adapter.addresses.depository), amount);
    await save('hub-allowance-confirmed');
    }
    for (const env of envs) runtime.startRuntimeLoop(env);
    assert(hubEnv.runtimeId && userEnv.runtimeId);
    await hubWallet.connect({ mode: 'embedded', runtimeId: hubEnv.runtimeId });
    await userWallet.connect({ mode: 'embedded', runtimeId: userEnv.runtimeId });
    transport = startCrossTransport(hubEnv, userEnv);
    for (const env of envs) runtime.startJurisdictionWatchers(env);
    await waitFor('hub profile restored', () => Boolean(userEnv.gossip.getProfile(hub.entityId)));
    if (!resume) {
    await save('deposit-submitting');
    await hubWallet.send({ runtimeTxs: [], entityInputs: [{ entityId: hub.entityId, signerId: hub.signerId,
      entityTxs: [buildExternalToReserveTx({ contractAddress: token.evm, amount, internalTokenId: 1 }), buildBroadcastTx()],
    }] });
    await waitFor('real hub reserve funded', () => snapshot().hubReserve === amount &&
      !replica(hubEnv, hub).state.jBatchState?.sentBatch, 30_000);
    assert.equal(await adapter.getReserves(hub.entityId, 1), amount);
    assert.equal(await adapter.getErc20Balance(token.evm, hub.signerId), 0n);
    await save('collateral-submitting');
    await hubWallet.send({ runtimeTxs: [], entityInputs: [{ entityId: hub.entityId, signerId: hub.signerId,
      entityTxs: [buildReserveToCollateralTx({ selfEntityId: hub.entityId, counterpartyEntityId: user.entityId,
        tokenId: 1, amount }), buildBroadcastTx()],
    }] });
    await waitFor('swap claim backed by real collateral', () => accountSnapshot(userEnv, user, hub).view.outCollateral === amount &&
      accountSnapshot(hubEnv, hub, user).view.collateral === amount && snapshot().hubReserve === 0n &&
      !replica(hubEnv, hub).state.jBatchState?.sentBatch, 30_000);
    assert.equal(await adapter.getCollateral(hub.entityId, user.entityId, 1), amount);
    await Bun.write(`${data}/cross-withdraw-funded.json`, safeStringify(snapshot(), 2));
    await save('withdrawal-submitting');
    }
    // The same Account → external continuation used by the wallet's Move flow.
    // Alice executes only after the hub certifies this exact c2r workspace.
    await userWallet.send({ runtimeTxs: [], entityInputs: [{ entityId: user.entityId, signerId: user.signerId,
      entityTxs: resume ? [
        { type: 'settle_execute', data: { counterpartyEntityId: hub.entityId, disableC2RShortcut: true } },
        buildReserveToExternalEoaTx(user.signerId, 1, amount), buildBroadcastTx(),
      ] : [{ type: 'settle_propose', data: { counterpartyEntityId: hub.entityId,
        executorIsLeft: user.entityId < hub.entityId, memo: 'asset-c2r',
        ops: [{ type: 'c2r', tokenId: 1, amount }],
        continuation: buildMoveSettlementContinuation(user.entityId, 1, amount,
          { type: 'r2e', recipientEoa: user.signerId }, true),
      } }],
    }] });
    await waitFor('withdrawal finalized', () => {
      const value = snapshot(), peer = account(hubEnv, hub, user);
      return value.userNonce === 1 && !value.workspace && !peer?.state.settlementWorkspace &&
        value.continuationCount === 0 && value.accounts[1]!.user.view.outCapacity === credit &&
        !replica(userEnv, user).state.jBatchState?.sentBatch;
    }, 30_000);
    for (const env of envs) await runtime.stopJurisdictionWatchersAndWait(env);
    for (const env of envs) assert(await runtime.waitForRuntimeWorkDrained(env, 10_000), 'Pending financial work');
    for (const env of envs) assert(await runtime.stopRuntimeLoopAndWait(env, 10_000));
  }
  const final = snapshot();
  assert.equal(final.hubReserve + final.userReserve, 0n);
  assert.equal(final.hubNonce, 2);
  assert.equal(final.userNonce, 1);
  assert.equal(final.workspace, false);
  assert.equal(final.continuationCount, 0);
  for (const [index, pair] of final.accounts.entries()) {
    assert.equal(pair.user.root, pair.hub.root);
    assert.equal(pair.user.pending || pair.hub.pending, false);
    assert.equal(pair.user.queued + pair.hub.queued + pair.user.offers + pair.user.pulls, 0);
    assert.equal(pair.user.view.collateral, 0n);
    assert.equal(pair.user.view.outCapacity, index === 1 ? credit : index === 2 ? credit + amount : credit - amount);
  }
  const onchain = { hubReserve: await adapter.getReserves(hub.entityId, 1),
    userReserve: await adapter.getReserves(user.entityId, 1), collateral: await adapter.getCollateral(hub.entityId, user.entityId, 1),
    foundationTokens: await adapter.getErc20Balance(token.evm, foundation),
    hubTokens: await adapter.getErc20Balance(token.evm, hub.signerId), userTokens: await adapter.getErc20Balance(token.evm, user.signerId) };
  assert.deepEqual(onchain, { hubReserve: 0n, userReserve: 0n, collateral: 0n,
    foundationTokens: 1_000_000_000_000n - amount, hubTokens: 0n, userTokens: amount });
  const anchors = [];
  for (const env of envs) {
    const frame = await readStorageFrameRecord(runtime.getRuntimeWalDb(env), env.state.height);
    assert(frame);
    anchors.push({ runtimeId: env.runtimeId, height: env.state.height, frameHash: frame.frameHash, postStateHash: frame.postStateHash });
  }
  if (restore) assert.deepEqual(anchors, previous.anchors);
  await Bun.write(`${data}/cross-withdraw${restore ? '-restore' : ''}.json`, safeStringify({
    kind: 'NATIVE_CROSS_SWAP_EXTERNAL_WITHDRAWAL', restore, resumedSignedWorkspace: restore ? previous.resumedSignedWorkspace : resume,
    final, onchain, anchors, funding: restore ? previous.funding : funding,
    scope: 'Private native TVM, received cross-chain credit claim converted to real external test tokens through hub collateral and signed wallet settlement; no public release claim',
  }, 2));
  await save(restore ? 'restored' : 'complete');
  console.log('NATIVE_CROSS_WITHDRAW_VERIFIED', safeStringify({ restore, anchors, onchain }));
  }
} catch (error) {
  await dumpFailure(`${data}/cross-withdraw-failure.json`, envs, error);
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
