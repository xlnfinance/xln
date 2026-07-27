import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(import.meta.dir, '../..');

const readMarketMakerNodeSource = (): string => [
  'mm-node.ts',
  'mm-node-core.ts',
  'mm-node-health.ts',
  'mm-node-run.ts',
].map(file => readFileSync(join(repoRoot, 'runtime/orchestrator', file), 'utf8')).join('\n');

test('bootstrap uses the canonical WAL-before-dispatch commit path', () => {
  const runtime = readFileSync(join(repoRoot, 'runtime/runtime.ts'), 'utf8');
  const hubNode = readFileSync(join(repoRoot, 'runtime/orchestrator/hub-node.ts'), 'utf8');
  const mmNode = readMarketMakerNodeSource();
  const orchestrator = readFileSync(join(repoRoot, 'runtime/orchestrator/orchestrator.ts'), 'utf8');

  const plan = runtime.indexOf('applyDeterministicRuntimeOutputPlan(env, entityOutbox, outputRoutingDeps)');
  const commit = runtime.indexOf('// === COMMIT POINT: persist finalized R-frame ===');
  const save = runtime.indexOf('const saveOutcome = await saveEnvToDB(', commit);
  const recoveryBarrier = runtime.indexOf('const recoveryBarrier = state.recoveryBackupBarrier;', save);
  const dispatch = runtime.indexOf('dispatchEntityOutputs(env, remoteOutputs', recoveryBarrier);

  expect(plan).toBeGreaterThanOrEqual(0);
  expect(commit).toBeGreaterThan(plan);
  expect(save).toBeGreaterThan(commit);
  expect(recoveryBarrier).toBeGreaterThan(save);
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
