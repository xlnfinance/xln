import { strict as assert } from 'node:assert';
import { resolve } from 'node:path';
import { main, enqueueRuntimeInput, processRuntime, startJurisdictionWatchers,
  stopJurisdictionWatchersAndWait, closeRuntimeDb, closeInfraDb, getRuntimeWalDb } from '../../core/runtime';
import { getLiveJAdapter } from '../../core/runtime/j-submit/live-jadapters';
import { assertCertifiedRegistrationEvidenceStore, computeRegistrationEvidenceHash,
  computeRegistrationEvidenceClaimHash } from '../../core/jurisdiction/machine/registration-evidence';
import { readStorageFrameRecord, readStorageHead } from '../../core/storage/read/read';
import { safeStringify } from '../../core/protocol/serialization';

const data = resolve(process.env['XLN_TRON_STAND_PATH'] || resolve(import.meta.dir, '../../db/native-tron-release-20260918'));
assert.equal(process.env.XLN_DB_PATH, `${data}/runtime`);
assert.equal(process.env.XLN_JURISDICTIONS_PATH, `${data}/jurisdictions.json`);
assert.notEqual(process.env.XLN_DISABLE_RUNTIME_RESTORE, '1');
const restore = process.argv.includes('--restore');
const resumeImport = process.argv.includes('--resume-import');
assert(!(restore && resumeImport), 'Choose one recovery phase');
const graph = await Bun.file(`${data}/graph.json`).json();
const economic = await Bun.file(`${data}/economic.json`).json();
assert.equal(economic.stage, 'complete');
const previousFile = Bun.file(`${data}/runtime-import.json`);
assert.equal(await previousFile.exists(), restore, 'Explicit import/restore mode must match saved evidence');
const previous = restore ? await previousFile.json() : null;
const name = 'Native TVM';
const env = await main('xln-native-local-release-20260918-public-observer', { numericSignerPrewarmCount: 1 });
const restoredFromHeight = env.state.height;
try {
  const db = getRuntimeWalDb(env);
  if (restore) {
    assert.equal(env.runtimeId, previous.runtimeId);
    // A prior interrupted verification may have committed duplicate observations.
    // Keep those frames; verify the original anchor and unchanged authority.
    assert(env.state.height >= previous.runtimeHeight);
    const restoredFrame = await readStorageFrameRecord(db, previous.runtimeHeight);
    assert(restoredFrame);
    assert.equal(restoredFrame.frameHash, previous.frameHash);
    assert.equal(restoredFrame.postStateHash, previous.postStateHash);
    const restoredEvidence = [...(env.infrastructure?.certifiedRegistrationEvidence?.values() ?? [])];
    assert.deepEqual(restoredEvidence.map(computeRegistrationEvidenceHash), previous.evidenceHashes);
    console.log('NATIVE_RUNTIME_RESTORED_EXACT', env.state.height, restoredFrame.postStateHash);
  } else if (resumeImport) {
    // Explicitly recover the committed import after a reporting failure. Never
    // clear its WAL or submit a second import to manufacture a clean first run.
    assert(env.state.height > 0);
    assert(env.state.jReplicas.has(name));
    const beforePoll = await readStorageFrameRecord(db, env.state.height);
    assert(beforePoll);
    await assertCertifiedRegistrationEvidenceStore(env);
    await Bun.write(`${data}/runtime-recovered-before-poll.json`, safeStringify({
      runtimeHeight: env.state.height, frameHash: beforePoll.frameHash, postStateHash: beforePoll.postStateHash,
      evidence: [...(env.infrastructure?.certifiedRegistrationEvidence?.values() ?? [])],
    }, 2));
  } else {
    assert.equal(env.state.height, 0, 'Fresh import cannot reuse an existing Runtime WAL');
    enqueueRuntimeInput(env, { runtimeTxs: [{ type: 'importJ', data: {
      name, chainId: graph.chainId, ticker: 'TRX', rpcs: [graph.chain.defaultRpc], blockTimeMs: 3000,
      entityProviderDeploymentBlock: graph.entityProviderDeploymentBlock,
      contracts: Object.fromEntries(['account', 'depository', 'entityProvider', 'deltaTransformer']
        .map(key => [key, graph.contracts[key]])),
    } }], entityInputs: [] });
  }
  const deadline = Date.now() + 30_000;
  let adapter = getLiveJAdapter(env, name);
  while (!adapter && Date.now() < deadline) {
    await processRuntime(env);
    adapter = getLiveJAdapter(env, name);
    if (!adapter) await Bun.sleep(50);
  }
  assert(adapter, 'Native Runtime import must install its live adapter');
  assert.equal(adapter.mode, 'tron');
  assert.equal(adapter.chainId, graph.chainId);
  startJurisdictionWatchers(env);
  assert(adapter.isWatching());
  const targetHeight = restore ? previous.observedThroughHeight + 1 : economic.withdrawal.blockNumber;
  while (Date.now() < deadline) {
    await adapter.pollNow();
    await processRuntime(env);
    const evidence = [...(env.infrastructure?.certifiedRegistrationEvidence?.values() ?? [])];
    if (evidence.some(item => item.source === 'FoundationBootstrapped') &&
      (adapter.getWatcherScanProgress?.().scannedThroughHeight ?? -1) >= targetHeight) break;
    await Bun.sleep(100);
  }
  await stopJurisdictionWatchersAndWait(env);
  await processRuntime(env);
  await assertCertifiedRegistrationEvidenceStore(env);
  const jurisdiction = env.state.jReplicas.get(name);
  assert(jurisdiction);
  assert.equal(jurisdiction.watcherReceiptCommitment, 'tron-rpc-attested');
  const evidence = [...(env.infrastructure?.certifiedRegistrationEvidence?.values() ?? [])];
  assert.equal(evidence.length, 1, 'This graph currently contains only the Foundation registration');
  const foundation = evidence[0];
  assert(foundation);
  assert.equal(foundation.source, 'FoundationBootstrapped');
  assert.equal(foundation.activationHeight, graph.entityProviderDeploymentBlock);
  assert.equal(foundation.chainId, graph.chainId);
  assert.equal(foundation.receiptKind, 'tron-rpc-attested');
  assert.equal(foundation.finality, 'tron-solidified');
  assert(!Object.hasOwn(foundation, 'receiptsRoot'), 'RPC attestation is not an execution proof');
  // Registration authority retains its first signed proof. Fresh empty native
  // blocks advance authenticated scan progress, not the Entity-certified WAL cursor.
  const scan = adapter.getWatcherScanProgress?.();
  assert(scan);
  assert(scan.scannedThroughHeight >= targetHeight);
  assert(foundation.observedThroughHeight >= economic.withdrawal.blockNumber);
  const claimHashes = evidence.map(computeRegistrationEvidenceClaimHash);
  if (restore) {
    assert.deepEqual(claimHashes, previous.claimHashes);
    assert.deepEqual(evidence.map(computeRegistrationEvidenceHash), previous.evidenceHashes);
  }
  const head = await readStorageHead(db);
  assert(head);
  assert.equal(head.latestHeight, env.state.height);
  const frame = await readStorageFrameRecord(db, env.state.height);
  assert(frame);
  const frames = [];
  for (let height = restore ? restoredFromHeight + 1 : 1; height <= env.state.height; height++) {
    const committed = await readStorageFrameRecord(db, height);
    assert(committed);
    frames.push(committed);
  }
  assert(frames.some(frame => frame.runtimeInput.runtimeTxs?.some(tx => tx.type === 'recordAuthenticatedJAuthority')));
  const result = { kind: 'NATIVE_RUNTIME_AUTHORITY', restore, resumeImport, restoredFromHeight, runtimeId: env.runtimeId,
    runtimeHeight: env.state.height, frameHash: frame.frameHash, postStateHash: frame.postStateHash,
    chainId: graph.chainId, mode: adapter.mode, observedThroughHeight: scan.scannedThroughHeight,
    authorityObservedThroughHeight: foundation.observedThroughHeight, scan,
    evidence, evidenceHashes: evidence.map(computeRegistrationEvidenceHash), claimHashes, frames,
    scope: 'Real native RPC-attested Runtime authority and WAL; no Entity financial or cross-J claim' };
  await Bun.write(`${data}/runtime-${restore ? 'restore' : 'import'}.json`, safeStringify(result, 2));
  console.log('NATIVE_RUNTIME_AUTHORITY_VERIFIED', safeStringify({ ...result, frames: frames.length }));
} finally {
  await stopJurisdictionWatchersAndWait(env);
  const adapter = getLiveJAdapter(env, name);
  if (adapter) await adapter.close();
  await closeRuntimeDb(env);
  await closeInfraDb(env);
}
