#!/usr/bin/env bun

/** One H1 Runtime+Entity replay with Rust as the exclusive Account authority. */

import { spawn, spawnSync } from 'node:child_process';
import { accessSync, constants, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

import { safeParse, safeStringify } from '../../../../protocol/serialization';

type ProcessSample = Readonly<{ cpuCores: number; rssKiB: number }>;
type BenchRow = Readonly<{
  workers: number;
  payments: number;
  swaps: number;
  economicOpsPerSecond: number;
  replayMs: number;
  childWallMs: number;
  averageCpuCores: number;
  peakRssMiB: number;
  engineMs: number;
  boundaryMs: number;
  inboundRounds: number;
  outboundRounds: number;
  verification: 'recorded-runtime-root' | 'deep-account-diff';
}>;

const argument = (name: string): string | null => {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return null;
  const value = String(process.argv[index + 1] ?? '').trim();
  if (!value) throw new Error(`RSCORE_ARS_BENCH_ARGUMENT_MISSING:${name}`);
  return value;
};

const requiredArgument = (name: string): string => {
  const value = argument(name);
  if (!value) throw new Error(`RSCORE_ARS_BENCH_ARGUMENT_MISSING:${name}`);
  return value;
};

const parseWorkers = (): number[] => {
  const raw = argument('workers') ?? '1,2,4,8,16';
  const workers = raw.split(',').map(value => Number(value.trim()));
  if (
    workers.length < 1 || new Set(workers).size !== workers.length
    || workers.some(value => !Number.isSafeInteger(value) || value < 1 || value > 256)
  ) throw new Error(`RSCORE_ARS_BENCH_WORKERS_INVALID:${raw}`);
  return workers;
};

const record = (value: unknown, code: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
};

const number = (value: unknown, code: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(code);
  return value;
};

const integer = (value: unknown, code: string): number => {
  const parsed = number(value, code);
  if (!Number.isSafeInteger(parsed)) throw new Error(code);
  return parsed;
};

const processRows = (): ReadonlyArray<Readonly<{
  pid: number;
  parent: number;
  cpuPercent: number;
  rssKiB: number;
}>> => {
  const result = spawnSync('ps', ['-axo', 'pid=,ppid=,%cpu=,rss='], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error('RSCORE_ARS_BENCH_PS_FAILED');
  return result.stdout.trim().split('\n').flatMap(line => {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 4) return [];
    const [pid, parent, cpuPercent, rssKiB] = fields.map(Number);
    if (
      pid === undefined || parent === undefined || cpuPercent === undefined || rssKiB === undefined
      || !Number.isSafeInteger(pid) || !Number.isSafeInteger(parent)
      || !Number.isFinite(cpuPercent) || !Number.isFinite(rssKiB)
    ) return [];
    return [{ pid, parent, cpuPercent, rssKiB }];
  });
};

const sampleProcessTree = (rootPid: number): ProcessSample => {
  const rows = processRows();
  const descendants = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (!descendants.has(row.parent) || descendants.has(row.pid)) continue;
      descendants.add(row.pid);
      changed = true;
    }
  }
  return rows.reduce((total, row) => descendants.has(row.pid) ? {
    cpuCores: total.cpuCores + row.cpuPercent / 100,
    rssKiB: total.rssKiB + row.rssKiB,
  } : total, { cpuCores: 0, rssKiB: 0 });
};

const collectLines = (
  stream: NodeJS.ReadableStream,
  visible: RegExp,
): Promise<string[]> => new Promise(resolveLines => {
  const lines: string[] = [];
  const reader = createInterface({ input: stream });
  reader.on('line', line => {
    lines.push(line);
    if (visible.test(line)) console.log(line);
  });
  reader.on('close', () => resolveLines(lines));
});

const prefixedRecord = (
  lines: readonly string[],
  prefix: string,
): Record<string, unknown> => {
  const line = [...lines].reverse().find(value => value.startsWith(prefix));
  if (!line) throw new Error(`RSCORE_ARS_BENCH_LINE_MISSING:${prefix}`);
  return record(safeParse(line.slice(prefix.length)), `RSCORE_ARS_BENCH_LINE_INVALID:${prefix}`);
};

const validateTrial = (
  reportPath: string,
  stderrLines: readonly string[],
): Readonly<{ trial: Record<string, unknown>; driver: Record<string, unknown> }> => {
  const report = record(safeParse(readFileSync(reportPath, 'utf8')), 'RSCORE_ARS_BENCH_REPORT_INVALID');
  const trials = report['trials'];
  if (!Array.isArray(trials) || trials.length !== 1) throw new Error('RSCORE_ARS_BENCH_TRIAL_COUNT');
  const trial = record(trials[0], 'RSCORE_ARS_BENCH_TRIAL_INVALID');
  if (trial['equivalent'] !== true || trial['frameVerified'] !== true) {
    throw new Error('RSCORE_ARS_BENCH_PARITY_UNVERIFIED');
  }
  if (integer(trial['finalPendingOutbox'], 'RSCORE_ARS_BENCH_OUTBOX_INVALID') !== 0) {
    throw new Error('RSCORE_ARS_BENCH_OUTBOX_NOT_DRAINED');
  }
  const execution = prefixedRecord(stderrLines, 'RSCORE_ACCOUNT_EXECUTION ');
  if (
    integer(execution['typescriptApplyAccountInput'], 'RSCORE_ARS_BENCH_TS_APPLY_INVALID') !== 0
    || integer(execution['typescriptProposeAccountFrame'], 'RSCORE_ARS_BENCH_TS_PROPOSE_INVALID') !== 0
    || integer(execution['authoritativeOperations'], 'RSCORE_ARS_BENCH_AUTHORITY_INVALID') < 1
  ) throw new Error('RSCORE_ARS_BENCH_NOT_RUST_EXCLUSIVE');
  return { trial, driver: prefixedRecord(stderrLines, 'RSCORE_AUTHORITY_DRIVER ') };
};

const runOne = async (
  recording: string,
  binary: string,
  workers: number,
  maxMs: number,
  completeEvidence: boolean,
  deepVerify: boolean,
): Promise<BenchRow> => {
  const output = join(mkdtempSync(join(tmpdir(), `xln-ars-w${workers}-`)), 'report.json');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    XLN_RSCORE_AUTHORITY: '1',
    XLN_RSCORE_AUTHORITY_CUTOVER: '1',
    XLN_RSCORE_AUTHORITY_REPLAY: '1',
    XLN_RSCORE_AUTHORITY_IMPORT: '1',
    XLN_RSCORE_AUTHORITY_RECORD: '1',
    XLN_RSCORE_AUTHORITY_WORKERS: String(workers),
    XLN_RSCORE_BINARY: binary,
    // Replay recordings already contain the canonical TS Runtime root for
    // every frame. Recomputing every Account leaf in TypeScript measures the
    // retired implementation, not Rust authority. Keep that expensive oracle
    // available explicitly for diagnosis without polluting the throughput run.
    XLN_RSCORE_CUTOVER_TRUST_ENGINE: deepVerify ? '0' : '1',
  };
  delete env['XLN_RSCORE_AUTHORITY_RUNTIME_ID'];
  for (const key of Object.keys(env)) if (key.startsWith('XLN_RSCORE_SHADOW')) delete env[key];
  const startedAt = performance.now();
  const child = spawn(process.execPath, [
    'core/scripts/operations/hlt/replay/replay-hub-recording.ts',
    '--recording', recording,
    '--output', output,
    '--mode', 'max',
    ...(completeEvidence ? ['--require-complete-authority-evidence'] : []),
    '--require-rust-account-authority',
  ], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
  if (!child.stdout || !child.stderr) throw new Error('RSCORE_ARS_BENCH_PIPE_MISSING');
  const stdout = collectLines(child.stdout, /^HLT_REPLAY_EQUIVALENT /);
  const stderr = collectLines(child.stderr, /^RSCORE_(AUTHORITY_DRIVER|ACCOUNT_EXECUTION) /);
  const samples: ProcessSample[] = [sampleProcessTree(child.pid ?? 0)];
  const sampler = setInterval(() => samples.push(sampleProcessTree(child.pid ?? 0)), 100);
  const status = await new Promise<number | null>((resolveExit, rejectExit) => {
    child.once('error', rejectExit);
    child.once('exit', resolveExit);
  });
  clearInterval(sampler);
  const [, stderrLines] = await Promise.all([stdout, stderr]);
  const childWallMs = performance.now() - startedAt;
  if (status !== 0) {
    throw new Error(
      `RSCORE_ARS_BENCH_CHILD_FAILED:w=${workers}:status=${String(status)}\n` +
      stderrLines.slice(-20).join('\n'),
    );
  }
  if (childWallMs >= maxMs) throw new Error(`RSCORE_ARS_BENCH_TOO_SLOW:w=${workers}:ms=${childWallMs.toFixed(2)}`);
  const { trial, driver } = validateTrial(output, stderrLines);
  const payments = integer(trial['deliveredPayments'], 'RSCORE_ARS_BENCH_PAYMENTS_INVALID');
  const swaps = integer(trial['matchedEconomicSwaps'], 'RSCORE_ARS_BENCH_SWAPS_INVALID');
  const replayMs = number(trial['elapsedMs'], 'RSCORE_ARS_BENCH_ELAPSED_INVALID');
  const inboundRounds = integer(driver['inboundRounds'], 'RSCORE_ARS_BENCH_INBOUND_INVALID');
  const outboundRounds = integer(driver['outboundRounds'], 'RSCORE_ARS_BENCH_OUTBOUND_INVALID');
  if (inboundRounds !== outboundRounds || inboundRounds < 1) throw new Error('RSCORE_ARS_BENCH_TWO_VISIT_INVALID');
  return {
    workers,
    payments,
    swaps,
    economicOpsPerSecond: (payments + swaps) * 1_000 / replayMs,
    replayMs,
    childWallMs,
    averageCpuCores: samples.reduce((sum, sample) => sum + sample.cpuCores, 0) / samples.length,
    peakRssMiB: Math.max(...samples.map(sample => sample.rssKiB)) / 1024,
    engineMs: number(driver['engineMicros'], 'RSCORE_ARS_BENCH_ENGINE_INVALID') / 1_000,
    boundaryMs: number(driver['waveMicros'], 'RSCORE_ARS_BENCH_BOUNDARY_INVALID') / 1_000,
    inboundRounds,
    outboundRounds,
    verification: deepVerify ? 'deep-account-diff' : 'recorded-runtime-root',
  };
};

const recording = resolve(requiredArgument('recording'));
const binary = resolve(argument('binary') ?? 'rscore/target/release/xln-rscore');
const maxMs = Number(argument('max-ms') ?? '20000');
const completeEvidence = process.argv.includes('--complete-evidence');
const deepVerify = process.argv.includes('--deep-verify');
if (!Number.isSafeInteger(maxMs) || maxMs < 1_000 || maxMs > 120_000) {
  throw new Error(`RSCORE_ARS_BENCH_MAX_MS_INVALID:${String(maxMs)}`);
}
accessSync(recording, constants.R_OK);
accessSync(binary, constants.X_OK);
const rows: BenchRow[] = [];
for (const workers of parseWorkers()) {
  rows.push(await runOne(recording, binary, workers, maxMs, completeEvidence, deepVerify));
}
console.table(rows.map(row => ({
  workers: row.workers,
  economicOpsPerSecond: row.economicOpsPerSecond.toFixed(2),
  replayMs: row.replayMs.toFixed(2),
  cpuCores: row.averageCpuCores.toFixed(2),
  peakRssMiB: row.peakRssMiB.toFixed(1),
  engineMs: row.engineMs.toFixed(2),
  boundaryMs: row.boundaryMs.toFixed(2),
  visits: `${row.inboundRounds}+${row.outboundRounds}`,
  verification: row.verification,
})));
console.log(`RSCORE_ARS_BENCH ${safeStringify({ recording, rows })}`);
