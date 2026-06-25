#!/usr/bin/env bun

import { spawn, spawnSync, type ChildProcessByStdio } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';

import { MAINNET_GATE } from './mainnet-gate-constants';

export type MainnetPreflightArgs = {
  dryRun: boolean;
  allowDirty: boolean;
  includeSoak: boolean;
  includeScale: boolean;
  outPath: string;
};

export type MainnetPreflightStep = {
  name: string;
  category: 'source' | 'invariant' | 'security' | 'release' | 'e2e' | 'recovery' | 'health' | 'soak' | 'scale';
  command: string;
  timeoutMs: number;
};

type StepResult = MainnetPreflightStep & {
  code: number | null;
  durationMs: number;
};

const timestampForPath = (): string =>
  new Date().toISOString().replace(/[:.]/g, '-');

const readFlagValue = (args: string[], index: number, flag: string): string => {
  const next = args[index + 1];
  if (!next || next.startsWith('--')) throw new Error(`Missing value for ${flag}`);
  return next;
};

export const parseMainnetPreflightArgs = (argv = process.argv.slice(2)): MainnetPreflightArgs => {
  let dryRun = false;
  let allowDirty = false;
  let includeSoak = false;
  let includeScale = false;
  let outPath = join('.logs', 'gates', `mainnet-preflight-${timestampForPath()}.json`);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) continue;
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--allow-dirty') {
      allowDirty = true;
      continue;
    }
    if (arg === '--include-soak') {
      includeSoak = true;
      continue;
    }
    if (arg === '--include-scale') {
      includeScale = true;
      continue;
    }
    if (arg.startsWith('--out=')) {
      outPath = arg.slice('--out='.length);
      continue;
    }
    if (arg === '--out') {
      outPath = readFlagValue(argv, index, arg);
      index += 1;
      continue;
    }
    throw new Error(`Unknown mainnet preflight argument: ${arg}`);
  }

  return { dryRun, allowDirty, includeSoak, includeScale, outPath };
};

export const buildMainnetPreflightSteps = (
  options: Pick<MainnetPreflightArgs, 'includeSoak' | 'includeScale'>,
): MainnetPreflightStep[] => {
  const steps: MainnetPreflightStep[] = [
    { name: 'source and frontend checks', category: 'source', command: 'bun run check', timeoutMs: 1_200_000 },
    {
      name: 'deterministic money invariants',
      category: 'invariant',
      command: [
        'bun test',
        'runtime/__tests__/derive-delta-property.test.ts',
        'runtime/__tests__/env-events-audit-commit.test.ts',
        'runtime/__tests__/capped-testnet-gate.test.ts',
        'runtime/__tests__/prod-health-smoke.test.ts',
      ].join(' '),
      timeoutMs: 240_000,
    },
    { name: 'security audit pack', category: 'security', command: 'bun run security:audit-pack', timeoutMs: 120_000 },
    { name: 'release integration gate', category: 'release', command: 'bun run gate:release', timeoutMs: 7_200_000 },
    { name: 'full browser e2e evidence', category: 'e2e', command: 'bun run test:e2e:full', timeoutMs: 7_200_000 },
    { name: 'watchtower recovery smoke', category: 'recovery', command: 'bun run test:watchtower:smoke', timeoutMs: 240_000 },
    { name: 'one tower / three hub health', category: 'health', command: 'bun run prod:health:capped-testnet', timeoutMs: 180_000 },
  ];

  if (options.includeScale) {
    steps.push({
      name: 'radapter 100k bounded snapshot benchmark',
      category: 'scale',
      command: 'bun run bench:radapter:hub100k:hot10k',
      timeoutMs: 2_400_000,
    });
  }

  if (options.includeSoak) {
    steps.push({
      name: 'one-hour release soak',
      category: 'soak',
      command: `bun runtime/scripts/run-soak-gate.ts --profile=release --minutes=${MAINNET_GATE.soakMinutes}`,
      timeoutMs: (MAINNET_GATE.soakMinutes + 30) * 60_000,
    });
  }

  return steps;
};

const spawnText = (command: string, args: string[]): string | null => {
  const result = spawnSync(command, args, { cwd: process.cwd(), encoding: 'utf8' });
  if (result.status !== 0) return null;
  return String(result.stdout || '').trim();
};

const runTextCommand = async (command: string): Promise<{ code: number | null; stdout: string; stderr: string }> => {
  const proc: ChildProcessByStdio<null, Readable, Readable> = spawn('sh', ['-lc', command], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', chunk => { stdout += chunk.toString(); });
  proc.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const code = await new Promise<number | null>((resolve, reject) => {
    proc.once('error', reject);
    proc.once('exit', resolve);
  });
  return { code, stdout, stderr };
};

const runStep = async (step: MainnetPreflightStep): Promise<StepResult> => {
  const startedAt = Date.now();
  const proc: ChildProcessByStdio<null, Readable, Readable> = spawn('sh', ['-lc', step.command], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const prefix = `[mainnet:${step.category}:${step.name}]`;
  proc.stdout.on('data', chunk => process.stdout.write(`${prefix} ${chunk.toString()}`));
  proc.stderr.on('data', chunk => process.stderr.write(`${prefix} ${chunk.toString()}`));

  const timer = setTimeout(() => {
    proc.kill('SIGTERM');
    setTimeout(() => {
      if (proc.exitCode === null) proc.kill('SIGKILL');
    }, 5_000).unref();
  }, step.timeoutMs);
  timer.unref();

  const code = await new Promise<number | null>((resolve, reject) => {
    proc.once('error', reject);
    proc.once('exit', resolve);
  });
  clearTimeout(timer);
  return { ...step, code, durationMs: Date.now() - startedAt };
};

const writeReport = (path: string, payload: unknown): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`);
};

const printPlan = (steps: MainnetPreflightStep[]): void => {
  console.log('');
  console.log('='.repeat(80));
  console.log('XLN mainnet preflight gate');
  console.log('='.repeat(80));
  steps.forEach((step, index) => {
    console.log(`${index + 1}. [${step.category}] ${step.name}`);
    console.log(`   ${step.command}`);
  });
  console.log('='.repeat(80));
};

const main = async (): Promise<void> => {
  const args = parseMainnetPreflightArgs();
  const gitHead = spawnText('git', ['rev-parse', 'HEAD']);
  if (!gitHead) throw new Error('MAINNET_PREFLIGHT_GIT_HEAD_UNAVAILABLE');

  const dirty = await runTextCommand('git status --short');
  if (dirty.code !== 0) throw new Error(`MAINNET_PREFLIGHT_GIT_STATUS_UNAVAILABLE:${dirty.stderr || dirty.stdout}`);
  if (dirty.stdout.trim() && !args.allowDirty) {
    throw new Error(`MAINNET_PREFLIGHT_DIRTY_WORKTREE:\n${dirty.stdout}`);
  }

  const steps = buildMainnetPreflightSteps(args);
  const report = {
    verdict: args.dryRun ? 'DRY_RUN' : 'RUNNING',
    startedAt: new Date().toISOString(),
    gitHead,
    dirty: Boolean(dirty.stdout.trim()),
    gitStatus: dirty.stdout.trim(),
    thresholds: {
      regressionThresholdPct: MAINNET_GATE.regressionThresholdPct,
      soakMinutes: MAINNET_GATE.soakMinutes,
      expectedHubs: MAINNET_GATE.expectedHubs,
      expectedTowers: MAINNET_GATE.expectedTowers,
      cappedRiskUsd: MAINNET_GATE.cappedRiskUsd,
    },
    args,
    steps,
  };

  writeReport(args.outPath, report);
  printPlan(steps);
  console.log(`gitHead=${gitHead.slice(0, 12)}${dirty.stdout.trim() ? ' dirty' : ''}`);
  console.log(`report=${args.outPath}`);
  if (args.dryRun) return;

  const results: StepResult[] = [];
  for (const step of steps) {
    const result = await runStep(step);
    results.push(result);
    writeReport(args.outPath, { ...report, verdict: 'RUNNING', results });
    if (result.code !== 0) {
      writeReport(args.outPath, { ...report, verdict: 'MAINNET_PREFLIGHT_FAIL', results, finishedAt: new Date().toISOString() });
      process.exit(result.code ?? 1);
    }
  }

  writeReport(args.outPath, {
    ...report,
    verdict: 'MAINNET_PREFLIGHT_PASS',
    finishedAt: new Date().toISOString(),
    results,
  });
  console.log('MAINNET_PREFLIGHT_PASS');
};

if (import.meta.main) {
  main().catch((error) => {
    console.error('MAINNET_PREFLIGHT_FAIL');
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
  });
}
