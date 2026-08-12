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
  const process = readFileSync(join(repoRoot, 'runtime/runtime/frame/process.ts'), 'utf8');
  const postCommit = readFileSync(
    join(repoRoot, 'runtime/runtime/frame/lifecycle/post-commit.ts'),
    'utf8',
  );
  const hubNode = readFileSync(join(repoRoot, 'runtime/orchestrator/hub-node.ts'), 'utf8');
  const mmNode = readMarketMakerNodeSource();
  const orchestrator = readFileSync(join(repoRoot, 'runtime/orchestrator/orchestrator.ts'), 'utf8');

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
