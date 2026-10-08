import { readStorageFrameRecord } from '../../../core/storage/read/read';
import { markLocalJSubmitRuntimeTx } from '../../../core/runtime/j-submit/j-submit-state';
/** Real native expiry after the canonical batch raw is committed, before any broadcast. */
import { strict as assert } from 'node:assert';
import { getBytes, zeroPadValue } from 'ethers';
import * as runtime from '../../../core/runtime';
import { createJAdapter } from '../../../core/jurisdiction/adapter';
import { deriveSignerAddressSync } from '../../../core/account/crypto';
import { getLiveJAdapter } from '../../../core/runtime/j-submit/live-jadapters';
import { decodeSignedTronTransaction } from '../../../core/jurisdiction/adapter/operations/tron-transaction';
import { createEmptyBatch } from '../../../core/jurisdiction/machine/batch';
import { prepareSignedBatch } from '../../../core/hanko/batch';
import { getNextJSubmitRetryTimestamp } from '../../../core/runtime/j-submit/j-submit-scheduler';
import { safeStringify } from '../../../core/protocol/serialization';

const stand = process.env['XLN_TRON_STAND_PATH'];
const seed = process.env['XLN_TRON_FINANCIAL_SEED'];
const evidence = process.env['XLN_TRON_FINANCIAL_EVIDENCE'];
assert(stand && seed && evidence);
const phase = Bun.argv[2];
const proofPath = `${evidence}/prepared.json`;
if (!phase || phase === 'replace' || phase === 'replacement-cycle') {
  for (const step of phase === 'replacement-cycle' ? ['prepare', 'replace-crash', 'recover-replaced'] : phase === 'replace' ? ['replace-crash', 'recover-replaced'] : ['prepare', 'recover-expired']) {
    const child = Bun.spawn([process.execPath, import.meta.filename, step], { env: process.env, stdout: 'inherit', stderr: 'inherit' });
    assert.equal(await child.exited, step === 'prepare' || step === 'replace-crash' ? 137 : 0, `financial expiry phase ${step}`);
  }
  process.exit(0);
}
const graph = await Bun.file(`${stand}/graph.json`).json();
const token = await Bun.file(`${stand}/token.json`).json();
let proof: { raw: string; hash: string; entityId: string; nonce: string } | undefined;
if (phase === 'recover-expired' || phase === 'replace-crash') {
  proof = await Bun.file(proofPath).json();
  assert(proof);
  const expiration = Number(decodeSignedTronTransaction(proof.raw).expiration);
  const deadline = Date.now() + 100_000;
  for (;;) {
    const response = await fetch(`${graph.chain.defaultSolidityHost}/walletsolidity/getnowblock`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    assert(response.ok);
    const block = await response.json();
    if (block.block_header.raw_data.timestamp > expiration) break;
    assert(Date.now() < deadline, 'financial expiry deadline');
    await Bun.sleep(1_000);
  }
}
const env = await runtime.loadEnvFromDB(deriveSignerAddressSync(seed, '1').toLowerCase(), seed);
assert(env);
env.scenarioMode = true;
const adapter = getLiveJAdapter(env, 'Native TVM');
assert(adapter && adapter.mode === 'tron');
const replica = [...env.state.eReplicas.values()][0];
assert(replica && env.state.eReplicas.size === 1);
const entityId = replica.entityId;
const signerId = replica.signerId;
const pendingRaw = () => env.infrastructure?.pendingCommittedJOutbox?.flatMap(input => input.jTxs)
  .flatMap(tx => tx.type === 'batch' && tx.data.runtimeSubmitAttempt?.rawTransaction ? [tx.data.runtimeSubmitAttempt.rawTransaction] : []);
const drive = async (done: () => boolean) => {
  const deadline = Date.now() + 30_000;
  while (!done()) {
    assert(Date.now() < deadline, `financial frame deadline:${safeStringify({ height: env.state.height, local: replica.jSubmitState })}`);
    await adapter.pollNow();
    await runtime.processRuntime(env, []);
    await Bun.sleep(100);
  }
};
try {
  adapter.startWatching(env);
  if (phase === 'prepare') {
    assert(!(await Bun.file(proofPath).exists()));
    assert.equal(await adapter.getReserves(entityId, 1), 0n);
    const key = '0'.repeat(63) + '1';
    const foundation = await createJAdapter({ mode: 'tron', chainId: graph.chainId, rpcUrl: graph.chain.defaultRpc,
      tronFullHost: graph.chain.defaultFullHost, tronSolidityHost: graph.chain.defaultSolidityHost, privateKey: key,
      fromReplica: { contracts: graph.contracts, entityProviderDeploymentBlock: graph.entityProviderDeploymentBlock } });
    const fund = createEmptyBatch();
    fund.externalTokenToReserve.push({ entity: entityId, contractAddress: token.evm, tokenType: 0, externalTokenId: 0n, internalTokenId: 1, amount: 100n });
    const foundationId = zeroPadValue('0x01', 32);
    const signed = prepareSignedBatch(fund, foundationId, getBytes(`0x${key}`), BigInt(adapter.chainId), adapter.addresses.depository, await adapter.getEntityNonce(foundationId));
    await foundation.processBatch(signed.encodedBatch, signed.hankoData, signed.nextNonce);
    await foundation.close();
    await drive(() => env.state.eReplicas.get(`${entityId}:${signerId}`)?.state.reserves.get(1) === 100n);
    const nonce = await adapter.getEntityNonce(entityId);
    adapter.broadcastPreparedTransaction = async raw => {
      assert.equal(pendingRaw()?.[0], raw, 'raw must already be WAL-owned before broadcast');
      const decoded = decodeSignedTronTransaction(raw);
      assert.equal(await adapter.provider.getTransactionReceipt(decoded.hash), null);
      await Bun.write(proofPath, safeStringify({ raw, hash: decoded.hash, entityId, nonce: String(nonce) }, 2));
      process.kill(process.pid, 'SIGKILL');
      throw new Error('SIGKILL failed');
    };
    await runtime.processRuntime(env, [{ entityId, signerId, entityTxs: [
      { type: 'r2e', data: { tokenId: 1, amount: 100n, receivingEntity: zeroPadValue(signerId, 32) } },
      { type: 'j_broadcast', data: {} },
    ] }]);
    await drive(() => false);
  } else {
    if (!proof) proof = await Bun.file(proofPath).json();
    assert(proof && proof.entityId === entityId);
    if (phase !== 'recover-replaced') assert.deepEqual(pendingRaw(), [proof.raw]);
    if (phase === 'replace-crash' || phase === 'recover-replaced') {
      if (phase === 'replace-crash') adapter.broadcastPreparedTransaction = async raw => {
        assert.notEqual(raw, proof?.raw);
        assert.deepEqual(pendingRaw(), [raw]);
        const frame = await readStorageFrameRecord(runtime.getRuntimeWalDb(env), env.state.height);
        const accepted = frame?.runtimeInput.runtimeTxs?.find(tx => tx.type === 'replaceJPreparedTransaction');
        assert(accepted);
        await Bun.write(`${evidence}/replacement-prepared.json`, safeStringify({ raw, hash: decodeSignedTronTransaction(raw).hash, accepted }, 2));
        process.kill(process.pid, 'SIGKILL');
        throw new Error('replacement SIGKILL failed');
      };
      else {
        const replaced = await Bun.file(`${evidence}/replacement-prepared.json`).json();
        assert.deepEqual(pendingRaw(), [replaced.raw]);
        runtime.enqueueRuntimeInput(env, { runtimeTxs: [markLocalJSubmitRuntimeTx(replaced.accepted)], entityInputs: [] });
      }
      const nextRetry = getNextJSubmitRetryTimestamp(env);
      if (nextRetry !== null) env.state.timestamp = Math.max(env.state.timestamp, nextRetry);
      await drive(() => env.state.eReplicas.get(`${entityId}:${signerId}`)?.state.reserves.get(1) === 0n);
      assert.equal(await adapter.getReserves(entityId, 1), 0n);
      assert.equal(await adapter.getEntityNonce(entityId), BigInt(proof.nonce) + 1n);
      assert.equal(await adapter.provider.getTransactionReceipt(proof.hash), null);
      const replaced = await Bun.file(`${evidence}/replacement-prepared.json`).json();
      assert.equal(await adapter.broadcastPreparedTransaction(replaced.raw), replaced.hash);
      assert.equal(await adapter.getEntityNonce(entityId), BigInt(proof.nonce) + 1n);
      await Bun.write(`${evidence}/replacement-result.json`, safeStringify({ entityId, nonce: String(await adapter.getEntityNonce(entityId)), reserve: '0', oldReceipt: null, pending: pendingRaw() }, 2));
      console.log('NATIVE_FINANCIAL_REPLACEMENT_GREEN');
    } else {
    await drive(() => Boolean(env.state.eReplicas.get(`${entityId}:${signerId}`)?.jSubmitState?.lastFailure));
    const state = env.state.eReplicas.get(`${entityId}:${signerId}`)?.jSubmitState;
    const result = { hash: proof.hash, retainedRaw: pendingRaw()?.[0] === proof.raw,
      receipt: await adapter.provider.getTransactionReceipt(proof.hash), reserve: String(await adapter.getReserves(entityId, 1)),
      nonce: String(await adapter.getEntityNonce(entityId)), state };
    await Bun.write(`${evidence}/expired-result.json`, safeStringify(result, 2));
    console.log('NATIVE_FINANCIAL_EXPIRED', safeStringify(result));
    assert(result.retainedRaw && result.receipt === null && result.reserve === '100' && result.nonce === proof.nonce);
    }
  }
} finally {
  await adapter.stopWatchingAndWait();
  await runtime.closeRuntimeDb(env);
  await runtime.closeInfraDb(env);
  await adapter.close();
}
process.exit(0);
