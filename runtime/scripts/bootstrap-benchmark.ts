#!/usr/bin/env bun

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type BootstrapStage = {
  stage: string;
  elapsedMs: number;
  at: string;
  details?: unknown;
};

type BootstrapMetrics = {
  schema: 'xln-local-prod-bootstrap-benchmark-v1';
  elapsedMs: number;
  stages: BootstrapStage[];
  bootstrapHash: string;
  runtimeStateHash: string;
  entityStateHash: string;
  workDir: string;
};

type BootstrapBenchmarkSummary = {
  schema: 'xln-bootstrap-benchmark-summary-v1';
  runs: number;
  outDir: string;
  bootstrapHash: string;
  rawEntityStateStable: boolean;
  entityStateHashes: string[];
  runtimeStateHashes: string[];
  elapsedMs: number[];
  stages: Array<Record<string, number>>;
};

const repoRoot = process.cwd();

const argValue = (name: string): string | null => {
  const prefix = `--${name}=`;
  return process.argv.find(arg => arg.startsWith(prefix))?.slice(prefix.length) ?? null;
};

const positiveInteger = (value: string | undefined | null, fallback: number): number => {
  const parsed = Number(value ?? '');
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
};

const timestampForPath = (): string =>
  new Date().toISOString().replace(/[:.]/g, '-');

const runs = positiveInteger(argValue('runs') ?? process.env['XLN_BOOTSTRAP_BENCH_RUNS'], 2);
const portBase = positiveInteger(argValue('port-base') ?? process.env['XLN_BOOTSTRAP_BENCH_PORT_BASE'], 19600);
const outDir = argValue('out-dir') ??
  process.env['XLN_BOOTSTRAP_BENCH_DIR'] ??
  join(repoRoot, '.logs', 'bootstrap-benchmark', timestampForPath());
const assertRawStateHashStable = process.env['XLN_BOOTSTRAP_BENCH_ASSERT_RAW_STATE_HASH'] === '1';

const isHash64 = (value: unknown): value is string =>
  typeof value === 'string' && /^(?:0x)?[a-f0-9]{64}$/i.test(value);

const requireMetricsHash = (metrics: BootstrapMetrics, run: number): void => {
  if (!isHash64(metrics.bootstrapHash)) {
    throw new Error(`BOOTSTRAP_BENCH_RUN_${run}_BOOTSTRAP_HASH_INVALID: ${String(metrics.bootstrapHash)}`);
  }
  if (!isHash64(metrics.runtimeStateHash)) {
    throw new Error(`BOOTSTRAP_BENCH_RUN_${run}_RUNTIME_HASH_INVALID: ${String(metrics.runtimeStateHash)}`);
  }
  if (!isHash64(metrics.entityStateHash)) {
    throw new Error(`BOOTSTRAP_BENCH_RUN_${run}_ENTITY_HASH_INVALID: ${String(metrics.entityStateHash)}`);
  }
};

const runSmoke = async (index: number): Promise<BootstrapMetrics> => {
  const run = index + 1;
  const runDir = join(outDir, `run-${String(run).padStart(2, '0')}`);
  const metricsPath = join(runDir, 'bootstrap-metrics.json');
  const runPortBase = portBase + index * 100;
  console.log(`[bootstrap-benchmark] run=${run}/${runs} portBase=${runPortBase} dir=${runDir}`);
  await new Promise<void>((resolve, reject) => {
    const proc = spawn('bun', ['runtime/scripts/local-prod-smoke.ts'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        XLN_LOCAL_PROD_SMOKE_PORT_BASE: String(runPortBase),
        XLN_LOCAL_PROD_SMOKE_DIR: runDir,
        XLN_LOCAL_PROD_SMOKE_METRICS_JSON: metricsPath,
      },
      stdio: 'inherit',
    });
    proc.once('error', reject);
    proc.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`BOOTSTRAP_BENCH_SMOKE_FAILED run=${run} code=${String(code)} signal=${String(signal)}`));
    });
  });
  if (!existsSync(metricsPath)) {
    throw new Error(`BOOTSTRAP_BENCH_METRICS_MISSING run=${run} path=${metricsPath}`);
  }
  const metrics = JSON.parse(readFileSync(metricsPath, 'utf8')) as BootstrapMetrics;
  requireMetricsHash(metrics, run);
  if (!metrics.stages.some(stage => stage.stage === 'system:ready')) {
    throw new Error(`BOOTSTRAP_BENCH_SYSTEM_READY_STAGE_MISSING run=${run}`);
  }
  return metrics;
};

if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const metrics: BootstrapMetrics[] = [];
for (let index = 0; index < runs; index += 1) {
  metrics.push(await runSmoke(index));
}

const first = metrics[0];
if (!first) throw new Error('BOOTSTRAP_BENCH_NO_RUNS');
for (let index = 1; index < metrics.length; index += 1) {
  const current = metrics[index]!;
  if (current.bootstrapHash !== first.bootstrapHash) {
    throw new Error(
      `BOOTSTRAP_BENCH_BOOTSTRAP_HASH_DRIFT run=1:${first.bootstrapHash} run=${index + 1}:${current.bootstrapHash}`,
    );
  }
  if (assertRawStateHashStable && current.entityStateHash !== first.entityStateHash) {
    throw new Error(
      `BOOTSTRAP_BENCH_ENTITY_HASH_DRIFT run=1:${first.entityStateHash} run=${index + 1}:${current.entityStateHash}`,
    );
  }
}

const rawEntityStateStable = metrics.every(entry => entry.entityStateHash === first.entityStateHash);
const summary: BootstrapBenchmarkSummary = {
  schema: 'xln-bootstrap-benchmark-summary-v1',
  runs,
  outDir,
  bootstrapHash: first.bootstrapHash,
  rawEntityStateStable,
  entityStateHashes: metrics.map(entry => entry.entityStateHash),
  runtimeStateHashes: metrics.map(entry => entry.runtimeStateHash),
  elapsedMs: metrics.map(entry => entry.elapsedMs),
  stages: metrics.map(entry =>
    Object.fromEntries(entry.stages.map(stage => [stage.stage, stage.elapsedMs])),
  ),
};
const summaryPath = join(outDir, 'summary.json');
writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
console.log(`[bootstrap-benchmark] summary=${summaryPath}`);
console.log(`[bootstrap-benchmark] ${JSON.stringify(summary)}`);
console.log('[bootstrap-benchmark] green');
