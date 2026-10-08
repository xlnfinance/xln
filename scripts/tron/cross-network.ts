import { strict as assert } from 'node:assert';
import { resolve } from 'node:path';
import * as runtime from '../../core/runtime';
import { getLiveJAdapter } from '../../core/runtime/j-submit/live-jadapters';
import { assertCertifiedRegistrationEvidenceStore, computeRegistrationEvidenceClaimHash }
  from '../../core/jurisdiction/machine/registration-evidence';
import { readStorageFrameRecord } from '../../core/storage/read/read';
import { safeStringify } from '../../core/protocol/serialization';
import { loadJurisdictionsAsync } from '../../core/jurisdiction/adapter/kernel/jurisdiction-loader';
import { getCertifiedBoardStackKey } from '../../core/jurisdiction/machine/board-registry';

const data = resolve(process.env['XLN_TRON_STAND_PATH'] || resolve(import.meta.dir, '../../db/native-tron-release-20260918'));
assert.equal(process.env.XLN_DB_PATH, `${data}/cross-runtime`);
assert.equal(process.env.XLN_JURISDICTIONS_PATH, `${data}/dual-jurisdictions.json`);
assert.notEqual(process.env.XLN_DISABLE_RUNTIME_RESTORE, '1');
const restore = process.argv.includes('--restore');
const resume = process.argv.includes('--resume');
assert(!(restore && resume));
const priorFile = Bun.file(`${data}/cross-network.json`);
assert.equal(await priorFile.exists(), restore, 'Choose cross-network import or restore explicitly');
const previous = restore ? await priorFile.json() : null;
const configuration = await loadJurisdictionsAsync();
const entries = Object.values(configuration.jurisdictions);
const stacks = new Map(entries.map(entry => [entry.name, getCertifiedBoardStackKey({
  chainId: entry.chainId, depositoryAddress: entry.contracts.depository,
  entityProviderAddress: entry.contracts.entityProvider,
})]));
const env = await runtime.main('xln-native-cross-release-20260918-public-observer', { numericSignerPrewarmCount: 1 });
const restoredFromHeight = env.state.height;
try {
  const db = runtime.getRuntimeWalDb(env);
  if (restore) {
    assert(env.state.height >= previous.runtimeHeight);
    const anchor = await readStorageFrameRecord(db, previous.runtimeHeight);
    assert(anchor);
    assert.equal(anchor.frameHash, previous.frameHash);
    assert.equal(anchor.postStateHash, previous.postStateHash);
    assert.deepEqual([...(env.infrastructure?.certifiedRegistrationEvidence?.values() ?? [])]
      .map(computeRegistrationEvidenceClaimHash).sort(), previous.claimHashes);
  } else if (resume) {
    assert(env.state.height > 0, 'Resume requires an existing committed import');
    for (const entry of entries) assert(env.state.jReplicas.has(entry.name));
  } else {
    assert.equal(env.state.height, 0, 'Fresh cross-network import cannot reuse existing WAL');
    for (const entry of entries) runtime.enqueueRuntimeInput(env, { runtimeTxs: [{ type: 'importJ', data: {
      name: entry.name, chainId: entry.chainId, ticker: entry.currency, rpcs: [entry.rpc], blockTimeMs: entry.blockTimeMs,
      entityProviderDeploymentBlock: entry.entityProviderDeploymentBlock, contracts: entry.contracts,
    } }], entityInputs: [] });
  }
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && entries.some(entry => !getLiveJAdapter(env, entry.name))) {
    await runtime.processRuntime(env);
    await Bun.sleep(50);
  }
  const adapters = entries.map(entry => {
    const adapter = getLiveJAdapter(env, entry.name);
    assert(adapter, `Missing adapter ${entry.name}`);
    assert.equal(adapter.mode, entry.mode);
    assert.equal(adapter.chainId, entry.chainId);
    return adapter;
  });
  runtime.startJurisdictionWatchers(env);
  while (Date.now() < deadline) {
    for (const adapter of adapters) await adapter.pollNow();
    await runtime.processRuntime(env);
    const evidence = [...(env.infrastructure?.certifiedRegistrationEvidence?.values() ?? [])];
    if (entries.every(entry => evidence.some(item => item.stackKey === stacks.get(entry.name)))) break;
    await Bun.sleep(100);
  }
  await runtime.stopJurisdictionWatchersAndWait(env);
  await runtime.processRuntime(env);
  await assertCertifiedRegistrationEvidenceStore(env);
  const evidence = [...(env.infrastructure?.certifiedRegistrationEvidence?.values() ?? [])];
  assert.equal(evidence.length, 2);
  for (const entry of entries) {
    const authority = evidence.find(item => item.stackKey === stacks.get(entry.name));
    assert(authority);
    assert.equal(authority.source, 'FoundationBootstrapped');
    assert.equal(authority.activationHeight, entry.entityProviderDeploymentBlock);
    if (entry.mode === 'tron') assert.equal(authority.receiptKind, 'tron-rpc-attested');
    else {
      assert(authority.receiptKind !== 'tron-rpc-attested');
      assert.match(authority.receiptsRoot, /^0x[0-9a-f]{64}$/i);
    }
  }
  const frame = await readStorageFrameRecord(db, env.state.height);
  assert(frame);
  const result = { kind: 'EVM_NATIVE_TVM_RUNTIME_IMPORT', restore, resume, restoredFromHeight, runtimeId: env.runtimeId,
    runtimeHeight: env.state.height, frameHash: frame.frameHash, postStateHash: frame.postStateHash,
    evidence, claimHashes: evidence.map(computeRegistrationEvidenceClaimHash).sort(),
    jurisdictions: entries.map(entry => ({ name: entry.name, mode: entry.mode, chainId: entry.chainId })),
    scope: 'Two real local chains and authenticated Runtime import/recovery; cross-J financial execution not yet tested' };
  await Bun.write(`${data}/cross-network${restore ? '-restore' : ''}.json`, safeStringify(result, 2));
  console.log('EVM_NATIVE_TVM_CONNECTED', safeStringify(result));
} finally {
  await runtime.stopJurisdictionWatchersAndWait(env);
  await runtime.closeRuntimeDb(env);
  for (const entry of entries) await getLiveJAdapter(env, entry.name)?.close();
  await runtime.closeInfraDb(env);
}
process.exit(0);
