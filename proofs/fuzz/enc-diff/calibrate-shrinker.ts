import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { safeStringify } from '../../../core/protocol/serialization';
import { sabotageApplies, type CaseFile, type SabotageMode } from './run';

const ROOT = import.meta.dir;
const RUNNER = resolve(ROOT, 'run.ts');
const CORPUS = resolve(ROOT, 'corpus');
const BINARY = resolve(ROOT, 'enc-diff-rust/target/release/enc-diff-rust');
const MODES: Exclude<SabotageMode, 'none'>[] = ['content-hex', 'class-inversion', 'field-divergence'];

type RunSummary = { failures: number; minimized: number; sabotage: SabotageMode };

const parseSummary = (stdout: string): RunSummary => JSON.parse(stdout) as RunSummary;

const assertMinimizedPayloads = (directory: string, mode: SabotageMode): number => {
  const files = readdirSync(directory).filter(file => file.endsWith('.json'));
  if (files.length === 0) throw new Error(`CALIBRATION_NO_MINIMIZED_CASE:${mode}`);
  for (const file of files) {
    const testCase = JSON.parse(readFileSync(resolve(directory, file), 'utf8')) as CaseFile;
    if (!sabotageApplies(mode, testCase)) throw new Error(`CALIBRATION_LOST_TRIGGER:${mode}:${file}`);
  }
  return files.length;
};

const runMode = (directory: string, mode: Exclude<SabotageMode, 'none'>): RunSummary => {
  const minimized = resolve(directory, mode);
  const result = spawnSync(process.execPath, [
    RUNNER,
    '--corpus', CORPUS,
    '--binary', BINARY,
    '--minimized', minimized,
    '--sabotage', mode,
  ], { encoding: 'utf8', timeout: 5_000, maxBuffer: 1 << 24 });
  if (result.status !== 1) throw new Error(`CALIBRATION_EXPECTED_FAILURE:${mode}:status=${String(result.status)}:${result.stderr}`);
  const summary = parseSummary(result.stdout);
  const minimizedFiles = assertMinimizedPayloads(minimized, mode);
  if (summary.failures < 1 || summary.minimized !== minimizedFiles) {
    throw new Error(`CALIBRATION_COUNT_MISMATCH:${mode}:${safeStringify(summary)}`);
  }
  return summary;
};

const run = (): void => {
  const directory = mkdtempSync(join(tmpdir(), 'xln-c1-shrinker-'));
  try {
    const summaries = MODES.map(mode => runMode(directory, mode));
    console.log(`C1_SHRINKER_CALIBRATION_OK ${summaries.map(summary => `${summary.sabotage}=${summary.failures}/${summary.minimized}`).join(' ')}`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

if (import.meta.main) run();
