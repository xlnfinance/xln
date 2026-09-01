import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildHubChildProcessEnv } from '../../../orchestrator/process/hub-runtime-env';

const repoRoot = join(import.meta.dir, '../../../..');

const readMarketMakerNodeSource = (): string => [
  'mm-node.ts',
  'market-maker/node/mm-node-core.ts',
  'market-maker/node/mm-node-health.ts',
  'market-maker/node/mm-node-run.ts',
].map(file => readFileSync(join(repoRoot, 'core/orchestrator', file), 'utf8')).join('\n');

test('bootstrap uses the canonical WAL-before-dispatch commit path', () => {
  const process = readFileSync(join(repoRoot, 'core/runtime/frame/process.ts'), 'utf8');
  const postCommit = readFileSync(
    join(repoRoot, 'core/runtime/frame/lifecycle/post-commit.ts'),
    'utf8',
  );
  const hubNode = readFileSync(join(repoRoot, 'core/orchestrator/hub-node.ts'), 'utf8');
  const mmNode = readMarketMakerNodeSource();
  const orchestrator = readFileSync(join(repoRoot, 'core/orchestrator/orchestrator.ts'), 'utf8');

  const plan = process.indexOf('const outputPlan = planRuntimeFrameOutputs(');
  const commit = process.indexOf('const commit = await commitRuntimeFrame(', plan);
  const effects = process.indexOf('await runCommittedRuntimeEffects(', commit);
  const save = process.indexOf('const outcome = await deps.storage.saveEnvToDB(');
  const publish = process.indexOf('return publishCommittedRuntimeFrame(', save);
  const recoveryBarrier = postCommit.indexOf('await runCommittedRecoveryBarrier(');
  const dispatch = postCommit.indexOf('await dispatchCommittedEntityOutputs(', recoveryBarrier);

  expect(plan).toBeGreaterThanOrEqual(0);
  expect(commit).toBeGreaterThan(plan);
  expect(effects).toBeGreaterThan(commit);
  expect(save).toBeGreaterThanOrEqual(0);
  expect(publish).toBeGreaterThan(save);
  expect(recoveryBarrier).toBeGreaterThanOrEqual(0);
  expect(dispatch).toBeGreaterThan(recoveryBarrier);

  for (const source of [hubNode, mmNode, orchestrator]) {
    expect(source).not.toContain('BOOTSTRAP_PAUSE_STORAGE');
    expect(source).not.toContain('persist-ready-snapshot');
    expect(source).not.toContain('prepare-ready-snapshot');
    expect(source).not.toContain('resume-ready-snapshot');
  }
  expect(mmNode).not.toContain('MARKET_MAKER_DISABLE_STORAGE');
  expect(mmNode).not.toContain('MARKET_MAKER_PERSIST_READY_SNAPSHOT');
});

test('authority evidence captures materialized H1 before MM bootstrap', () => {
  const orchestrator = readFileSync(join(repoRoot, 'core/orchestrator/orchestrator.ts'), 'utf8');
  const resetStartup = readFileSync(join(repoRoot, 'core/orchestrator/process/reset-startup.ts'), 'utf8');
  const hubNode = readFileSync(join(repoRoot, 'core/orchestrator/hub-node.ts'), 'utf8');
  const reset = orchestrator.indexOf('const runReset = async');
  const startupCall = orchestrator.indexOf('await completeResetStartup({', reset);
  const authorityBranch = resetStartup.indexOf(
    "if (process.env['XLN_HLT_AUTHORITY_EVIDENCE'] !== '1') {",
  );
  const nonAuthorityReturn = resetStartup.indexOf('return;', authorityBranch);
  const meshReady = resetStartup.indexOf('await startup.waitForMesh();', nonAuthorityReturn);
  const capture = resetStartup.indexOf('await captureAuthorityEvidenceBase(startup.h1, startup.host);', meshReady);
  const parallel = resetStartup.indexOf('await parallel();', capture);

  expect(reset).toBeGreaterThanOrEqual(0);
  expect(startupCall).toBeGreaterThan(reset);
  expect(authorityBranch).toBeGreaterThanOrEqual(0);
  expect(meshReady).toBeGreaterThan(nonAuthorityReturn);
  expect(capture).toBeGreaterThan(meshReady);
  expect(parallel).toBeGreaterThan(capture);
  expect(resetStartup).toContain('startup.startMarketMaker()');
  expect(hubNode).not.toContain('Commit one empty projection barrier');

  const base = {
    dbPath: '/tmp/h1',
    brainvaultOwnerPath: '/tmp/h1-owner',
    jurisdictionsPath: '/tmp/jurisdictions.json',
    rpcEnv: {},
    orchestratorPid: 1,
    orchestratorOwnerId: 'owner',
    startupTimeoutMs: 1_000,
  } as const;
  const sourceEnv = {
    XLN_HLT_AUTHORITY_EVIDENCE: '1',
    XLN_HLT_ENGINE: 'ts',
    XLN_RUNTIME_SNAPSHOT_EXPORT_PATH: '/tmp/authority-base.json',
    XLN_MAX_ENTITY_INPUTS_PER_RUNTIME_FRAME: '4',
    XLN_MAX_ENTITY_TXS_PER_RUNTIME_FRAME: '8',
  };
  const h1 = buildHubChildProcessEnv({ ...base, hubName: 'H1', sourceEnv });
  const h2 = buildHubChildProcessEnv({ ...base, hubName: 'H2', sourceEnv });
  expect(h1['XLN_STORAGE_MATERIALIZE_PERIOD_FRAMES']).toBeUndefined();
  expect(h1['XLN_HLT_AUTHORITY_EVIDENCE']).toBe('1');
  expect(h1['XLN_RUNTIME_SNAPSHOT_EXPORT_PATH']).toBe('/tmp/authority-base.json');
  expect(h1['XLN_STORAGE_CANONICAL_HASH_PERIOD_FRAMES']).toBe('1');
  expect(h1['XLN_MAX_ENTITY_INPUTS_PER_RUNTIME_FRAME']).toBe('4');
  expect(h1['XLN_MAX_ENTITY_TXS_PER_RUNTIME_FRAME']).toBe('8');
  expect(h2['XLN_STORAGE_MATERIALIZE_PERIOD_FRAMES']).toBeUndefined();
  expect(h2['XLN_HLT_AUTHORITY_EVIDENCE']).toBeUndefined();
  expect(h2['XLN_RUNTIME_SNAPSHOT_EXPORT_PATH']).toBeUndefined();
  expect(h2['XLN_STORAGE_CANONICAL_HASH_PERIOD_FRAMES']).toBeUndefined();
});
