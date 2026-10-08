import { strict as assert } from 'node:assert';
import { resolve } from 'node:path';
import * as runtime from '../../../core/runtime';
import { deriveSignerKeySync } from '../../../core/account/crypto';
import { getLiveJAdapter } from '../../../core/runtime/j-submit/live-jadapters';
import { readStorageFrameRecord } from '../../../core/storage/read/read';
import { safeStringify } from '../../../core/protocol/serialization';
import type { EntityTx } from '../../../core/types/entity-tx';
import { buildExternalToReserveTx, buildReserveToCollateralTx, buildMoveSettlementContinuation, buildBroadcastTx }
  from '../../../frontend/src/lib/components/Entity/account/entity-action-txs';
import { hubSeed, userSeed, hubs, users, amount, replica, walletFor, account,
  allAccounts, waitFor, dumpFailure, startCrossTransport } from '../cross-swap-context';

// Return the exact tokens withdrawn after the cross-chain swap through the
// ordinary wallet deposit → collateral → automatic external withdrawal path.
// A progress marker forbids blindly resubmitting after an uncertain result.
const data = resolve(process.env['XLN_TRON_STAND_PATH'] || resolve(import.meta.dir, '../../../db/native-tron-release-20260918'));
assert.equal(process.env['XLN_DB_PATH'], `${data}/cross-runtime`);
assert.equal(process.env['XLN_JURISDICTIONS_PATH'], `${data}/dual-jurisdictions.json`);
const restore = process.argv.includes('--restore');
const progressPath = `${data}/automatic-withdraw-progress.json`;
assert.equal(await Bun.file(progressPath).exists(), restore, 'Inspect receipts/WAL before resuming an existing attempt');
const recovery = await Bun.file(`${data}/cross-withdraw-restore.json`).json();
const previous = restore ? await Bun.file(`${data}/automatic-withdraw.json`).json() : null;
const token = await Bun.file(`${data}/token.json`).json();
const hub = hubs[1], user = users[1];
const hubEnv = await runtime.main(hubSeed, { numericSignerPrewarmCount: 1 });
const userEnv = await runtime.main(userSeed, { numericSignerPrewarmCount: 1 });
const envs = [hubEnv, userEnv];
const wallet = walletFor(userEnv);
const adapter = getLiveJAdapter(userEnv, user.network);
assert(adapter?.mode === 'tron');
let transport: ReturnType<typeof startCrossTransport> | null = null;
const startHeight = restore ? previous.startHeight : userEnv.state.height;
const snapshot = () => ({ accounts: allAccounts(hubEnv, userEnv),
  reserve: replica(userEnv, user).state.reserves.get(1) ?? 0n,
  nonce: replica(userEnv, user).state.jBatchState?.entityNonce ?? 0,
  pending: Boolean(replica(userEnv, user).state.jBatchState?.sentBatch),
  workspace: Boolean(account(userEnv, user, hub)?.state.settlementWorkspace),
  continuations: replica(userEnv, user).state.settlementContinuations?.size ?? 0,
});
const send = async (entityTxs: EntityTx[]) => {
  await wallet.send({ runtimeTxs: [], entityInputs: [{ entityId: user.entityId, signerId: user.signerId, entityTxs }] });
};
const save = async (stage: string) => {
  await Bun.write(progressPath, safeStringify({ stage, startHeight, snapshot: snapshot() }, 2));
  console.log('AUTOMATIC_WITHDRAW_STAGE', stage);
};
try {
  if (restore) assert.deepEqual(JSON.parse(safeStringify(snapshot())), previous.final);
  else {
    assert.deepEqual(JSON.parse(safeStringify(snapshot().accounts)), recovery.final.accounts);
    assert.equal(snapshot().nonce, 1);
    assert.equal(snapshot().pending || snapshot().workspace || snapshot().continuations > 0, false);
    assert.equal(await adapter.getEntityNonce(user.entityId), 1n);
    assert.equal(await adapter.getErc20Balance(token.evm, user.signerId), amount);
    assert.equal(await adapter.getCollateral(hub.entityId, user.entityId, 1), 0n);
    assert.equal(await adapter.getReserves(user.entityId, 1), 0n);
    await save('approving');
    await adapter.approveErc20(deriveSignerKeySync(userSeed, user.name), token.evm, adapter.addresses.depository, amount);
    for (const env of envs) runtime.startRuntimeLoop(env);
    assert(userEnv.runtimeId);
    await wallet.connect({ mode: 'embedded', runtimeId: userEnv.runtimeId });
    transport = startCrossTransport(hubEnv, userEnv);
    for (const env of envs) runtime.startJurisdictionWatchers(env);
    await waitFor('hub connected', () => Boolean(userEnv.gossip.getProfile(hub.entityId)));
    await save('deposit-submitting');
    await send([buildExternalToReserveTx({ contractAddress: token.evm, amount, internalTokenId: 1 }), buildBroadcastTx()]);
    await waitFor('automatic test deposit', () => snapshot().nonce === 2 && snapshot().reserve === amount && !snapshot().pending, 30_000);
    await save('collateral-submitting');
    await send([buildReserveToCollateralTx({ selfEntityId: user.entityId, counterpartyEntityId: hub.entityId, tokenId: 1, amount }), buildBroadcastTx()]);
    await waitFor('automatic test collateral', () => snapshot().nonce === 3 && !snapshot().pending &&
      snapshot().accounts[1]!.user.view.outCollateral === amount && snapshot().accounts[1]!.hub.view.collateral === amount, 30_000);
    await save('withdrawal-submitting');
    await send([{ type: 'settle_propose', data: { counterpartyEntityId: hub.entityId,
      executorIsLeft: user.entityId < hub.entityId, memo: 'asset-c2r', ops: [{ type: 'c2r', tokenId: 1, amount }],
      continuation: buildMoveSettlementContinuation(user.entityId, 1, amount, { type: 'r2e', recipientEoa: user.signerId }, true),
    } }]);
    await waitFor('automatic withdrawal finalized', () => {
      const value = snapshot();
      return value.nonce === 4 && value.reserve === 0n && !value.pending && !value.workspace && value.continuations === 0 &&
        !account(hubEnv, hub, user)?.state.settlementWorkspace && value.accounts[1]!.user.root === value.accounts[1]!.hub.root;
    }, 30_000);
    for (const env of envs) await runtime.stopJurisdictionWatchersAndWait(env);
    for (const env of envs) assert(await runtime.waitForRuntimeWorkDrained(env, 10_000));
    for (const env of envs) assert(await runtime.stopRuntimeLoopAndWait(env, 10_000));
  }
  const final = snapshot();
  assert.equal(final.nonce, 4);
  assert.equal(final.reserve, 0n);
  assert.equal(final.pending || final.workspace || final.continuations > 0, false);
  for (const [index, pair] of final.accounts.entries()) {
    assert.equal(pair.user.root, pair.hub.root);
    assert.equal(pair.user.pending || pair.hub.pending, false);
    assert.equal(pair.user.queued + pair.hub.queued + pair.user.offers + pair.user.pulls, 0);
    assert.deepEqual(JSON.parse(safeStringify(pair.user.view)), recovery.final.accounts[index].user.view);
  }
  assert.equal(await adapter.getEntityNonce(user.entityId), 4n);
  assert.equal(await adapter.getErc20Balance(token.evm, user.signerId), amount);
  assert.equal(await adapter.getCollateral(hub.entityId, user.entityId, 1), 0n);
  assert.equal(await adapter.getReserves(user.entityId, 1), 0n);
  const anchors = [];
  for (const env of envs) {
    const frame = await readStorageFrameRecord(runtime.getRuntimeWalDb(env), env.state.height);
    assert(frame);
    anchors.push({ runtimeId: env.runtimeId, height: env.state.height, frameHash: frame.frameHash, postStateHash: frame.postStateHash });
  }
  const events = [];
  for (let height = startHeight + 1; height <= userEnv.state.height; height++) {
    const frame = await readStorageFrameRecord(runtime.getRuntimeWalDb(userEnv), height);
    assert(frame);
    events.push(...frame.runtimeInput.entityInputs.flatMap(input => [...(input.jPrefixAttestations?.values() ?? [])])
      .flatMap(prefix => prefix.blocks.flatMap(block => block.events)));
  }
  const receipts = events.filter(event => event.type === 'HankoBatchProcessed');
  assert.deepEqual(receipts.map(event => event.data.nonce), [2, 3, 4]);
  if (restore) assert.deepEqual(anchors, previous.anchors);
  await Bun.write(`${data}/automatic-withdraw${restore ? '-restore' : ''}.json`, safeStringify({
    kind: 'NATIVE_AUTOMATIC_ACCOUNT_WITHDRAWAL', restore, startHeight, final, receipts, anchors,
    externalTokens: amount, scope: 'Private native TVM, canonical automatic continuation; no manual settle_execute or rendered UI',
  }, 2));
  await save(restore ? 'restored' : 'complete');
  console.log('NATIVE_AUTOMATIC_WITHDRAW_VERIFIED', safeStringify({ restore, anchors, receipts }));
} catch (error) {
  await dumpFailure(`${data}/automatic-withdraw-failure.json`, envs, error);
  throw error;
} finally {
  wallet.disconnect();
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
