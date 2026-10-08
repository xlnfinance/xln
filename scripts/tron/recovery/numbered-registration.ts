import { ethers } from 'ethers';
import { createJAdapter } from '../../../core/jurisdiction/adapter';
import { createEmptyEnv, loadEnvFromDB, closeRuntimeDb, closeInfraDb } from '../../../core/runtime';
import { deriveSignerAddressSync } from '../../../core/account/crypto';
import { attachLiveJAdapter, getLiveJAdapter } from '../../../core/runtime/j-submit/live-jadapters';
import { canonicalEntitySeed } from '../../../core/runtime/registration/entity-creation';
import { commitRuntimeInput, processJEvents, setScenarioStorageEnabled } from '../../../core/scenarios/harness/helpers';
import { markLocalNumberedRegistrationTx } from '../../../core/runtime/registration/numbered/numbered-registration-auth';
import { buildNumberedRegistrationRequest, prepareNumberedRegistrationIntent, getNumberedRegistrationRecord,
  submitNumberedRegistrationIntent, buildNumberedRegistrationCompletionRuntimeTxs } from '../../../core/runtime/registration/numbered/numbered-registration-intent';
import { safeStringify } from '../../../core/protocol/serialization';
import { replaceExpiredNumberedRegistrationIntent } from '../../../core/runtime/registration/numbered/numbered-registration-replacement';
import { decodeSignedTronTransaction } from '../../../core/jurisdiction/adapter/operations/tron-transaction';

const stand = process.env['XLN_TRON_STAND_PATH'];
const seed = process.env['XLN_TRON_REGISTRATION_SEED'];
if (!stand || !seed) throw new Error('TRON_REGISTRATION_STAND_AND_SEED_REQUIRED');
const phase = Bun.argv[2];
const runtimeId = deriveSignerAddressSync(seed, '1').toLowerCase();
const evidence = process.env['XLN_TRON_REGISTRATION_EVIDENCE_PATH'] || stand;
const proofPath = `${evidence}/numbered-registration-proof.json`;
function assert(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }

if (!phase || phase === 'expiry' || phase === 'replacement-crash' || phase === 'replacement') {
  const steps = phase === 'replacement' ? ['prepare', 'replace-expired', 'recover-replaced']
    : phase === 'replacement-crash' ? ['replace-expired', 'recover-replaced']
    : ['prepare', phase === 'expiry' ? 'recover-expired' : 'recover'];
  for (const step of steps) {
    const child = Bun.spawn([process.execPath, import.meta.filename, step], { env: process.env, stdout: 'inherit', stderr: 'inherit' });
    const code = await child.exited;
    if (code !== (step === 'prepare' || step === 'replace-expired' ? 137 : 0)) throw new Error(`TRON_REGISTRATION_PHASE_FAILED:${step}:${code}`);
  }
} else if (phase === 'prepare') {
  const graph = await Bun.file(`${stand}/graph.json`).json();
  const env = createEmptyEnv(seed);
  setScenarioStorageEnabled(env, true);
  env.scenarioMode = true;
  const adapter = await createJAdapter({ mode: 'tron', chainId: graph.chainId, rpcUrl: graph.chain.defaultRpc,
    tronFullHost: graph.chain.defaultFullHost, tronSolidityHost: graph.chain.defaultSolidityHost,
    privateKey: '0'.repeat(63) + '1', fromReplica: { contracts: graph.contracts, entityProviderDeploymentBlock: graph.entityProviderDeploymentBlock } });
  const jurisdiction = { name: 'Native TVM', address: graph.chain.defaultRpc, chainId: graph.chainId,
    depositoryAddress: graph.contracts.depository, entityProviderAddress: graph.contracts.entityProvider };
  env.state.jReplicas.set(jurisdiction.name, { name: jurisdiction.name, chainId: graph.chainId, blockNumber: 0n,
    stateRoot: null, mempool: [], blockDelayMs: 0, lastBlockTimestamp: 0, position: { x: 0, y: 0, z: 0 },
    rpcs: [graph.chain.defaultRpc], contracts: graph.contracts, entityProviderDeploymentBlock: graph.entityProviderDeploymentBlock,
    watcherReceiptCommitment: 'tron-rpc-attested', watcherConfirmationDepth: 0 });
  attachLiveJAdapter(env, jurisdiction.name, adapter);
  adapter.startWatching(env);
  const funding = await adapter.signer.sendTransaction({ to: runtimeId, value: 2_000_000_000n });
  await funding.wait();
  const before = await adapter.entityProvider.nextNumber();
  const request = buildNumberedRegistrationRequest(env, { jurisdiction, payerSignerId: runtimeId,
    intentId: ethers.id(seed), entities: [{ name: 'Native durable registration', validators: [runtimeId], threshold: 1n,
      localSignerId: runtimeId, entitySeed: canonicalEntitySeed(seed) }] });
  const pending = await prepareNumberedRegistrationIntent(env, adapter, request, async prepared => {
    await commitRuntimeInput(env, { runtimeTxs: [markLocalNumberedRegistrationTx({ type: 'recordNumberedRegistrationIntent', data: prepared })], entityInputs: [] });
    return 'accepted';
  });
  assert(pending.status === 'pending', 'TRON_REGISTRATION_NOT_PENDING');
  assert(await adapter.entityProvider.nextNumber() === before, 'TRON_REGISTRATION_PREMATURE_BROADCAST');
  await Bun.write(proofPath, safeStringify({ runtimeId, intentId: request.intentId, hash: pending.transactionHash,
    raw: pending.rawTransaction, before: before.toString(), jurisdiction: jurisdiction.name }));
  process.kill(process.pid, 'SIGKILL');
  throw new Error('TRON_REGISTRATION_CRASH_FAILED');
} else if (['recover', 'recover-expired', 'replace-expired', 'recover-replaced'].includes(phase)) {
  const proof = await Bun.file(phase === 'recover-replaced' ? `${evidence}/numbered-registration-replacement-proof.json` : proofPath).json();
  let solidTimestamp = 0;
  const expiration = Number(decodeSignedTronTransaction(proof.raw).expiration);
  if (phase === 'recover-expired' || phase === 'replace-expired') {
    const graph = await Bun.file(`${stand}/graph.json`).json();
    const deadline = Date.now() + 120_000;
    while (solidTimestamp <= expiration) {
      assert(Date.now() < deadline, 'TRON_REGISTRATION_EXPIRY_WAIT_TIMEOUT');
      const response = await fetch(`${graph.chain.defaultSolidityHost}/walletsolidity/getnowblock`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(5_000),
      });
      assert(response.ok, `TRON_REGISTRATION_SOLID_HTTP:${response.status}`);
      const head = await response.json();
      solidTimestamp = head.block_header.raw_data.timestamp;
      assert(Number.isSafeInteger(solidTimestamp) && solidTimestamp > 0, 'TRON_REGISTRATION_SOLID_TIMESTAMP_INVALID');
      if (solidTimestamp <= expiration) await Bun.sleep(1_000);
    }
  }
  const env = await loadEnvFromDB(runtimeId, seed);
  assert(env, 'TRON_REGISTRATION_RESTORE_MISSING');
  env.scenarioMode = true;
  const adapter = getLiveJAdapter(env, proof.jurisdiction);
  assert(adapter, 'TRON_REGISTRATION_ADAPTER_MISSING');
  await adapter.stopWatchingAndWait?.();
  adapter.startWatching(env);
  const pending = getNumberedRegistrationRecord(env, proof.intentId);
  assert(pending?.status === 'pending', 'TRON_REGISTRATION_PENDING_MISSING');
  assert(pending.rawTransaction === proof.raw && pending.transactionHash === proof.hash, 'TRON_REGISTRATION_RESTORE_WIRE_MISMATCH');
  if (phase === 'replace-expired') {
    let acceptedTx: unknown;
    const replacement = await replaceExpiredNumberedRegistrationIntent(env, adapter, pending, async runtimeTxs => {
      await commitRuntimeInput(env, { runtimeTxs, entityInputs: [] });
      acceptedTx = runtimeTxs[0];
      return 'accepted';
    });
    assert(acceptedTx && replacement.transactionHash !== pending.transactionHash, 'TRON_REGISTRATION_REPLACEMENT_NOT_ACCEPTED');
    assert(await adapter.entityProvider.nextNumber() === BigInt(proof.before), 'TRON_REGISTRATION_REPLACEMENT_PREMATURE_BROADCAST');
    assert(await adapter.provider.getTransactionReceipt(replacement.transactionHash) === null, 'TRON_REGISTRATION_REPLACEMENT_ALREADY_BROADCAST');
    await Bun.write(`${evidence}/numbered-registration-replacement-proof.json`, safeStringify({ ...proof,
      previousHash: proof.hash, previousRaw: pending.rawTransaction, request: replacement.request, requestHash: replacement.requestHash,
      raw: replacement.rawTransaction, hash: replacement.transactionHash, acceptedTx }));
    process.kill(process.pid, 'SIGKILL');
    throw new Error('TRON_REGISTRATION_REPLACEMENT_CRASH_FAILED');
  }
  if (phase === 'recover-replaced') {
    await commitRuntimeInput(env, { runtimeTxs: [markLocalNumberedRegistrationTx(proof.acceptedTx)], entityInputs: [] });
    assert(getNumberedRegistrationRecord(env, proof.intentId)?.transactionHash === proof.hash, 'TRON_REGISTRATION_REPLACEMENT_DUPLICATE_CHANGED_WIRE');
    assert(await adapter.entityProvider.nextNumber() === BigInt(proof.before), 'TRON_REGISTRATION_REPLACEMENT_DUPLICATE_BROADCAST');
  }
  if (phase === 'recover-expired') {
    let failure: string | null = null;
    try { await submitNumberedRegistrationIntent(adapter, pending); }
    catch (error) { failure = error instanceof Error ? error.message : String(error); }
    const after = await adapter.entityProvider.nextNumber();
    const retained = getNumberedRegistrationRecord(env, proof.intentId);
    const receipt = await adapter.provider.getTransactionReceipt(proof.hash);
    const result = { kind: 'NATIVE_TRON_NUMBERED_REGISTRATION_EXPIRED_WAL_RECOVERY', failure,
      hash: proof.hash, expiration, solidTimestamp, before: proof.before, after: after.toString(),
      receiptAbsent: receipt === null, retainedRaw: retained?.status === 'pending' && retained.rawTransaction === proof.raw,
      retainedHash: retained?.status === 'pending' && retained.transactionHash === proof.hash };
    await Bun.write(`${evidence}/numbered-registration-expiry-result.json`, safeStringify(result, 2));
    console.info(safeStringify(result));
    await adapter.close();
    await closeRuntimeDb(env);
    await closeInfraDb(env);
    adapter.provider.destroy();
    assert(failure === 'transaction was not mined: TRON_PREPARED_EXPIRATION_REQUIRES_RECONCILIATION', 'TRON_REGISTRATION_EXPIRY_ERROR_UNEXPECTED');
    assert(after === BigInt(proof.before), 'TRON_REGISTRATION_EXPIRED_TX_REGISTERED');
    assert(result.receiptAbsent && result.retainedRaw && result.retainedHash, 'TRON_REGISTRATION_EXPIRED_WIRE_NOT_PRESERVED');
    process.exit(0);
  }
  const submitted = await submitNumberedRegistrationIntent(adapter, pending);
  assert(submitted.kind === 'receipt', 'TRON_REGISTRATION_NO_RECEIPT');
  await processJEvents(env);
  const completion = buildNumberedRegistrationCompletionRuntimeTxs(env, pending, submitted);
  await commitRuntimeInput(env, { runtimeTxs: completion, entityInputs: [] });
  const completed = getNumberedRegistrationRecord(env, proof.intentId);
  assert(completed?.status === 'completed', 'TRON_REGISTRATION_NOT_COMPLETED');
  const after = await adapter.entityProvider.nextNumber();
  assert(after === BigInt(proof.before) + 1n, 'TRON_REGISTRATION_DUPLICATED');
  const duplicate = await submitNumberedRegistrationIntent(adapter, pending);
  assert(duplicate.kind === 'receipt' && duplicate.receipt.hash === proof.hash, 'TRON_REGISTRATION_RETRY_HASH_MISMATCH');
  assert(await adapter.entityProvider.nextNumber() === after, 'TRON_REGISTRATION_RETRY_DUPLICATED');
  const result = { kind: phase === 'recover-replaced' ? 'NATIVE_TRON_NUMBERED_REGISTRATION_REPLACEMENT_WAL_RECOVERY' : 'NATIVE_TRON_NUMBERED_REGISTRATION_WAL_RECOVERY', hash: proof.hash,
    status: submitted.receipt.status, block: submitted.receipt.blockNumber, before: proof.before, after: after.toString(),
    importedEntities: env.state.eReplicas.size, height: env.state.height };
  await Bun.write(`${evidence}/${phase === 'recover-replaced' ? 'numbered-registration-replacement-result.json' : 'numbered-registration-result.json'}`, safeStringify(result, 2));
  console.info(safeStringify(result));
  await adapter.close();
  await closeRuntimeDb(env);
  await closeInfraDb(env);
  adapter.provider.destroy();
} else throw new Error('TRON_REGISTRATION_PHASE_INVALID');
