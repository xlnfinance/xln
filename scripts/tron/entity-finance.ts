import { strict as assert } from 'node:assert';
import { resolve } from 'node:path';
import { getBytes, Wallet, zeroPadValue } from 'ethers';
import { main, importEntity, enqueueRuntimeInput, processRuntime, startJurisdictionWatchers,
  stopJurisdictionWatchersAndWait, closeRuntimeDb, closeInfraDb, getRuntimeWalDb } from '../../core/runtime';
import { getLiveJAdapter } from '../../core/runtime/j-submit/live-jadapters';
import { registerSignerKey } from '../../core/account/crypto';
import { encodeBoard, hashBoard } from '../../core/entity/factory';
import type { ConsensusConfig } from '../../core/entity/types';
import { readStorageFrameRecord } from '../../core/storage/read/read';
import { safeStringify } from '../../core/protocol/serialization';

const data = resolve(process.env['XLN_TRON_STAND_PATH'] || resolve(import.meta.dir, '../../db/native-tron-release-20260918'));
assert.equal(process.env.XLN_DB_PATH, `${data}/runtime`);
assert.equal(process.env.XLN_JURISDICTIONS_PATH, `${data}/jurisdictions.json`);
assert.notEqual(process.env.XLN_DISABLE_RUNTIME_RESTORE, '1');
const restore = process.argv.includes('--restore');
const graph = await Bun.file(`${data}/graph.json`).json();
const economic = await Bun.file(`${data}/economic.json`).json();
const previousFile = Bun.file(`${data}/entity-finance.json`);
assert.equal(await previousFile.exists(), restore, 'Choose initial ingestion or restoration explicitly');
const previous = restore ? await previousFile.json() : null;
const recoveryFile = Bun.file(`${data}/entity-restore.json`);
const recoveryAnchor = restore && await recoveryFile.exists() ? await recoveryFile.json() : previous;
const key = `0x${'1'.padStart(64, '0')}`; // Public disposable private-chain signer, never a user wallet.
const signerId = new Wallet(key).address.toLowerCase();
const entityId = zeroPadValue('0x01', 32);
const replicaKey = `${entityId}:${signerId}`;
const name = 'Native TVM';
const runtimeSeed = 'xln-native-local-release-20260918-public-observer';
// Recovery replays signed Entity work before main returns, so load its key first.
registerSignerKey(runtimeSeed, signerId, getBytes(key));
const env = await main(runtimeSeed, { numericSignerPrewarmCount: 1 });
const startHeight = env.state.height;
const db = getRuntimeWalDb(env);
const observations: unknown[] = [];
const summarize = () => {
  const replica = env.state.eReplicas.get(replicaKey);
  assert(replica);
  return { runtimeHeight: env.state.height, entityHeight: replica.state.height,
    entityFrameHash: replica.state.prevFrameHash, finalizedJHeight: replica.state.lastFinalizedJHeight,
    reserve: replica.state.reserves.get(1)?.toString() ?? null,
    nonce: replica.state.jBatchState?.entityNonce ?? null };
};
try {
  const adapter = getLiveJAdapter(env, name);
  assert(adapter);
  assert.equal(adapter.mode, 'tron');
  assert.equal(adapter.chainId, graph.chainId);
  if (restore) {
    assert.equal(env.runtimeId, previous.runtimeId);
    assert.deepEqual(summarize(), recoveryAnchor.final);
    const anchor = await readStorageFrameRecord(db, recoveryAnchor.final.runtimeHeight);
    assert(anchor);
    assert.equal(anchor.frameHash, recoveryAnchor.frameHash);
    assert.equal(anchor.postStateHash, recoveryAnchor.postStateHash);
  } else {
    assert(!env.state.eReplicas.has(replicaKey), 'Existing Entity requires explicit recovery, never reset');
    const config: ConsensusConfig = { mode: 'proposer-based', threshold: 1n,
      validators: [signerId], shares: { [signerId]: 1n }, jurisdiction: {
        name, address: graph.chain.defaultRpc, chainId: graph.chainId,
        depositoryAddress: graph.contracts.depository, entityProviderAddress: graph.contracts.entityProvider,
        registrationBlock: graph.entityProviderDeploymentBlock,
      } };
    const authority = [...(env.infrastructure?.certifiedRegistrationEvidence?.values() ?? [])]
      .find(item => item.entityId === entityId);
    assert(authority);
    assert.equal(hashBoard(encodeBoard(config, env)), authority.boardHash);
    enqueueRuntimeInput(env, { runtimeTxs: [importEntity({ entityId, signerId,
      entitySeed: 'xln-native-local-release-20260918-public-foundation', data: { config, isProposer: true } })],
      entityInputs: [] });
    await processRuntime(env);
    observations.push(summarize());
  }
  startJurisdictionWatchers(env);
  assert(adapter.isWatching());
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await adapter.pollNow();
    await processRuntime(env);
    const state = summarize();
    observations.push(state);
    if (state.finalizedJHeight >= economic.withdrawal.blockNumber && state.nonce === 2) break;
    await Bun.sleep(100);
  }
  await stopJurisdictionWatchersAndWait(env);
  await processRuntime(env);
  const final = summarize();
  assert(final.finalizedJHeight >= economic.withdrawal.blockNumber);
  assert.equal(final.reserve, '0');
  assert.equal(final.nonce, 2);
  assert.equal(await adapter.getReserves(entityId, 1), 0n);
  assert.equal(await adapter.getEntityNonce(entityId), 2n);
  const frames = [];
  for (let height = (restore ? previous.startHeight : startHeight) + 1; height <= env.state.height; height++) {
    const frame = await readStorageFrameRecord(db, height);
    assert(frame);
    frames.push(frame);
  }
  const events = frames.flatMap(frame => frame.runtimeInput.entityInputs)
    .flatMap(input => [...(input.jPrefixAttestations?.values() ?? [])])
    .flatMap(prefix => prefix.blocks.flatMap(block => block.events));
  const reserves = events.filter(event => event.type === 'ReserveUpdated')
    .map(event => ({ block: event.blockNumber, transaction: event.transactionHash,
      entity: event.data.entity, tokenId: event.data.tokenId, balance: String(event.data.newBalance) }));
  assert.deepEqual(reserves, [
    { block: 23, transaction: economic.deposit.transactionHash, entity: entityId, tokenId: 1, balance: '1000000' },
    { block: 24, transaction: economic.withdrawal.txHash, entity: entityId, tokenId: 1, balance: '0' },
  ], 'Committed signed prefix must contain both real receipts, in order, exactly once');
  assert.deepEqual(events.filter(event => event.type === 'HankoBatchProcessed').map(event => event.data.nonce), [1, 2]);
  const head = await readStorageFrameRecord(db, env.state.height);
  assert(head);
  const result = { kind: 'NATIVE_ENTITY_FINANCE', restore, runtimeId: env.runtimeId, startHeight,
    entityId, signerId, chainId: adapter.chainId, mode: adapter.mode,
    ...(restore ? { restoredAnchor: { final: recoveryAnchor.final, frameHash: recoveryAnchor.frameHash,
      postStateHash: recoveryAnchor.postStateHash } } : {}),
    deposit: economic.deposit, withdrawal: economic.withdrawal, observations, final, reserves,
    frameHash: head.frameHash, postStateHash: head.postStateHash, frames,
    scope: 'Private native Tron receipts through canonical Runtime and Entity; no cross-J or public-app claim' };
  await Bun.write(`${data}/entity-${restore ? 'restore' : 'finance'}.json`, safeStringify(result, 2));
  console.log('NATIVE_ENTITY_FINANCE_VERIFIED', safeStringify({ ...result, frames: frames.length }));
} catch (error) {
  await Bun.write(`${data}/entity-finance-failure.json`, safeStringify({ startHeight,
    runtimeHeight: env.state.height, error: String(error), observations,
    replicas: [...env.state.eReplicas.values()].map(replica => ({ entityId: replica.entityId, state: replica.state })) }, 2));
  throw error;
} finally {
  await stopJurisdictionWatchersAndWait(env);
  const adapter = getLiveJAdapter(env, name);
  if (adapter) await adapter.close();
  console.log('NATIVE_ENTITY_CLEANUP_ADAPTER_CLOSED');
  await closeRuntimeDb(env);
  console.log('NATIVE_ENTITY_CLEANUP_RUNTIME_CLOSED');
  await closeInfraDb(env);
  console.log('NATIVE_ENTITY_CLEANUP_INFRA_CLOSED');
}
// Crypto worker pools live until process exit on Bun/macOS. End this bounded
// CLI only after every assertion, awaited evidence write and DB close succeeds.
process.exit(0);
