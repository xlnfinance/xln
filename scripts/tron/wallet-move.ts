import { strict as assert } from 'node:assert';
import { resolve } from 'node:path';
import { getBytes, Wallet, zeroPadValue } from 'ethers';
import * as runtime from '../../core/runtime';
import { EmbeddedRuntimeAdapter } from '../../core/api/runtime-adapter/embedded';
import { getLiveJAdapter } from '../../core/runtime/j-submit/live-jadapters';
import { registerSignerKey } from '../../core/account/crypto';
import { readStorageFrameRecord } from '../../core/storage/read/read';
import { safeStringify } from '../../core/protocol/serialization';
import { buildBroadcastTx, buildExternalToReserveTx, buildReserveToExternalEoaTx }
  from '../../frontend/src/lib/components/Entity/account/entity-action-txs';

const data = resolve(process.env['XLN_TRON_STAND_PATH'] || resolve(import.meta.dir, '../../db/native-tron-release-20260918'));
assert.equal(process.env.XLN_DB_PATH, `${data}/runtime`);
assert.equal(process.env.XLN_JURISDICTIONS_PATH, `${data}/jurisdictions.json`);
assert.notEqual(process.env.XLN_DISABLE_RUNTIME_RESTORE, '1');
const restore = process.argv.includes('--restore');
const progressPath = `${data}/wallet-move-progress.json`;
const reportPath = `${data}/wallet-move.json`;
assert.equal(await Bun.file(progressPath).exists(), restore, 'Existing wallet attempt requires explicit recovery');
const previous = restore ? await Bun.file(reportPath).json() : null;
const graph = await Bun.file(`${data}/graph.json`).json();
const token = await Bun.file(`${data}/token.json`).json();
const key = `0x${'1'.padStart(64, '0')}`; // Public disposable private-chain signer.
const signerId = new Wallet(key).address.toLowerCase();
const entityId = zeroPadValue('0x01', 32);
const seed = 'xln-native-local-release-20260918-public-observer';
registerSignerKey(seed, signerId, getBytes(key));
const env = await runtime.main(seed, { numericSignerPrewarmCount: 1 });
const startHeight = env.state.height;
const wallet = new EmbeddedRuntimeAdapter({ getEnv: () => env,
  enqueueRuntimeInput: runtime.enqueueRuntimeInput,
  validateRuntimeInputAdmission: runtime.validateRuntimeInputAdmission,
  registerRuntimePublishedCallback: runtime.registerRuntimePublishedCallback,
  submitCrossJurisdictionIntent: async (target, route) => {
    await runtime.submitCrossJurisdictionIntent(target, route);
    return { delivered: true };
  },
});
const replica = () => {
  const value = env.state.eReplicas.get(`${entityId}:${signerId}`);
  assert(value);
  return value;
};
const snapshot = () => ({ runtimeHeight: env.state.height, entityHeight: replica().state.height,
  entityFrameHash: replica().state.prevFrameHash, reserve: replica().state.reserves.get(1)?.toString(),
  nonce: replica().state.jBatchState?.entityNonce, pending: Boolean(replica().state.jBatchState?.sentBatch),
  finalizedJHeight: replica().state.lastFinalizedJHeight });
const saveProgress = (stage: string) => Bun.write(progressPath, safeStringify({ stage, startHeight, state: snapshot() }, 2));
const adapter = getLiveJAdapter(env, 'Native TVM');
const driveTo = async (reserve: string, nonce: number) => {
  assert(adapter);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await adapter.pollNow();
    const state = snapshot();
    const failed = replica().state.jBatchState?.sentBatch?.terminalFailure;
    assert(!failed, `NATIVE_WALLET_TERMINAL_FAILURE:${safeStringify(failed)}`);
    if (state.reserve === reserve && state.nonce === nonce && !state.pending) return state;
    await Bun.sleep(100);
  }
  throw new Error(`NATIVE_WALLET_STATE_TIMEOUT:${safeStringify(snapshot())}`);
};
try {
  assert(adapter);
  assert.equal(adapter.mode, 'tron');
  assert.equal(adapter.chainId, graph.chainId);
  const db = runtime.getRuntimeWalDb(env);
  if (restore) {
    assert.deepEqual(snapshot(), previous.final);
    const head = await readStorageFrameRecord(db, previous.final.runtimeHeight);
    assert(head);
    assert.equal(head.frameHash, previous.frameHash);
    assert.equal(head.postStateHash, previous.postStateHash);
  } else {
    assert.equal(snapshot().reserve, '0');
    assert.equal(snapshot().nonce, 2);
    assert.equal(snapshot().pending, false);
    assert.equal(await adapter.getErc20Balance(token.evm, signerId), 1_000_000_000_000n);
    assert(await adapter.getErc20Allowance(token.evm, signerId, graph.contracts.depository) >= 1_000_000n,
      'Previous real deposit must retain sufficient allowance; never invent approval');
    runtime.startRuntimeLoop(env);
    await wallet.connect({ mode: 'embedded', runtimeId: env.runtimeId! });
    assert(wallet.commandReady, wallet.commandReadyReason ?? 'Wallet command lane unavailable');
    await saveProgress('deposit-submitting');
    runtime.startJurisdictionWatchers(env);
    await wallet.send({ runtimeTxs: [], entityInputs: [{ entityId, signerId, entityTxs: [
      buildExternalToReserveTx({ contractAddress: token.evm, internalTokenId: 1, amount: 1_000_000n }),
      buildBroadcastTx(),
    ] }] });
    const funded = await driveTo('1000000', 3);
    assert.equal(await adapter.getReserves(entityId, 1), 1_000_000n);
    assert.equal(await adapter.getErc20Balance(token.evm, signerId), 999_999_000_000n);
    await Bun.write(`${data}/wallet-funded.json`, safeStringify(funded, 2));
    console.log('NATIVE_WALLET_DEPOSIT_COMMITTED', safeStringify(funded));
    await saveProgress('withdrawal-submitting');
    await wallet.send({ runtimeTxs: [], entityInputs: [{ entityId, signerId, entityTxs: [
      buildReserveToExternalEoaTx(signerId, 1, 1_000_000n), buildBroadcastTx(),
    ] }] });
    await driveTo('0', 4);
  }
  await runtime.stopJurisdictionWatchersAndWait(env);
  assert(await runtime.stopRuntimeLoopAndWait(env, 10_000), 'Runtime must finish its active frame');
  const final = snapshot();
  assert.equal(final.reserve, '0');
  assert.equal(final.nonce, 4);
  assert.equal(final.pending, false);
  assert.equal(await adapter.getReserves(entityId, 1), 0n);
  assert.equal(await adapter.getEntityNonce(entityId), 4n);
  assert.equal(await adapter.getErc20Balance(token.evm, signerId), 1_000_000_000_000n);
  const frames = [];
  for (let height = (restore ? previous.startHeight : startHeight) + 1; height <= env.state.height; height++) {
    const frame = await readStorageFrameRecord(db, height);
    assert(frame);
    frames.push(frame);
  }
  const events = frames.flatMap(frame => frame.runtimeInput.entityInputs)
    .flatMap(input => [...(input.jPrefixAttestations?.values() ?? [])])
    .flatMap(prefix => prefix.blocks.flatMap(block => block.events));
  const reserves = events.filter(event => event.type === 'ReserveUpdated' && event.data.entity === entityId);
  assert.deepEqual(reserves.map(event => String(event.data.newBalance)), ['1000000', '0']);
  assert.deepEqual(events.filter(event => event.type === 'HankoBatchProcessed').map(event => event.data.nonce), [3, 4]);
  const head = await readStorageFrameRecord(db, env.state.height);
  assert(head);
  const result = { kind: 'NATIVE_WALLET_MOVE', restore, startHeight, runtimeId: env.runtimeId,
    chainId: adapter.chainId, mode: adapter.mode, final, reserves, frameHash: head.frameHash,
    postStateHash: head.postStateHash, frames,
    scope: 'Real frontend transaction builders and EmbeddedRuntimeAdapter on private native Tron; no rendered UI or cross-J claim' };
  await Bun.write(restore ? `${data}/wallet-restore.json` : reportPath, safeStringify(result, 2));
  await saveProgress(restore ? 'restored' : 'complete');
  console.log('NATIVE_WALLET_MOVE_VERIFIED', safeStringify({ ...result, frames: frames.length }));
} catch (error) {
  await Bun.write(`${data}/wallet-move-failure.json`, safeStringify({ error: String(error), startHeight,
    state: snapshot(), replica: replica(), pendingOutbox: env.infrastructure?.pendingCommittedJOutbox }, 2));
  throw error;
} finally {
  wallet.disconnect();
  await runtime.stopJurisdictionWatchersAndWait(env);
  await runtime.closeRuntimeDb(env);
  if (adapter) await adapter.close();
  await runtime.closeInfraDb(env);
}
// The bounded CLI owns process-lifetime crypto workers; all durable work is closed above.
process.exit(0);
