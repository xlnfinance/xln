#!/usr/bin/env bun

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';

const DEFAULT_POLICY_PATH = 'ops/capped-testnet-policy.json';
const MAX_CAPPED_TESTNET_RISK_USD = 10_000;

type ExceptionPolicy = {
  p0?: string;
  p1?: string;
  p2?: string;
  p3?: string;
};

export type CappedTestnetPolicy = {
  $schema?: string;
  name?: string;
  scope?: unknown;
  riskCapUsd?: unknown;
  riskCapEnforcement?: unknown;
  expectedTowers?: unknown;
  expectedHubs?: unknown;
  recoverySlaSeconds?: unknown;
  exceptionPolicy?: ExceptionPolicy;
  externalAuditRequired?: unknown;
  soakMinutes?: unknown;
};

export type CappedGateArgs = {
  policyPath: string;
  skipSoak: boolean;
  dryRun: boolean;
  allowDirty: boolean;
  outPath: string;
};

export type GateStep = {
  name: string;
  command: string;
  timeoutMs: number;
};

type StepResult = GateStep & {
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

export const parseCappedGateArgs = (argv = process.argv.slice(2)): CappedGateArgs => {
  let policyPath = DEFAULT_POLICY_PATH;
  let outPath = join('.logs', 'gates', `capped-testnet-${timestampForPath()}.json`);
  let skipSoak = false;
  let dryRun = false;
  let allowDirty = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) continue;
    if (arg === '--skip-soak') {
      skipSoak = true;
      continue;
    }
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--allow-dirty') {
      allowDirty = true;
      continue;
    }
    if (arg.startsWith('--policy=')) {
      policyPath = arg.slice('--policy='.length);
      continue;
    }
    if (arg === '--policy') {
      policyPath = readFlagValue(argv, index, arg);
      index += 1;
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
    throw new Error(`Unknown capped-testnet gate argument: ${arg}`);
  }

  return { policyPath, skipSoak, dryRun, allowDirty, outPath };
};

const asFiniteNumber = (value: unknown): number | null => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

export const validateCappedTestnetPolicy = (policy: CappedTestnetPolicy): string[] => {
  const errors: string[] = [];
  if (policy.$schema !== 'xln:capped-testnet-policy:v1') {
    errors.push('POLICY_SCHEMA_INVALID');
  }
  const riskCapUsd = asFiniteNumber(policy.riskCapUsd);
  if (riskCapUsd === null || riskCapUsd <= 0 || riskCapUsd > MAX_CAPPED_TESTNET_RISK_USD) {
    errors.push(`POLICY_RISK_CAP_INVALID:${String(policy.riskCapUsd)}`);
  }
  if (!['operator_config', 'code', 'contract'].includes(String(policy.riskCapEnforcement || ''))) {
    errors.push(`POLICY_RISK_CAP_ENFORCEMENT_INVALID:${String(policy.riskCapEnforcement)}`);
  }
  if (asFiniteNumber(policy.expectedTowers) !== 1) {
    errors.push(`POLICY_EXPECTED_TOWERS_INVALID:${String(policy.expectedTowers)}`);
  }
  if (asFiniteNumber(policy.expectedHubs) !== 3) {
    errors.push(`POLICY_EXPECTED_HUBS_INVALID:${String(policy.expectedHubs)}`);
  }
  const recoverySlaSeconds = asFiniteNumber(policy.recoverySlaSeconds);
  if (recoverySlaSeconds === null || recoverySlaSeconds <= 0 || recoverySlaSeconds > 60) {
    errors.push(`POLICY_RECOVERY_SLA_INVALID:${String(policy.recoverySlaSeconds)}`);
  }
  if (policy.exceptionPolicy?.p0 !== 'forbidden') errors.push('POLICY_P0_EXCEPTION_INVALID');
  if (policy.exceptionPolicy?.p1 !== 'forbidden') errors.push('POLICY_P1_EXCEPTION_INVALID');
  if (policy.exceptionPolicy?.p2 !== 'owner_signoff_required') errors.push('POLICY_P2_EXCEPTION_INVALID');
  if (policy.exceptionPolicy?.p3 !== 'issue_required') errors.push('POLICY_P3_EXCEPTION_INVALID');
  if (policy.externalAuditRequired !== false) {
    errors.push('POLICY_EXTERNAL_AUDIT_SHOULD_BE_FALSE_FOR_CAPPED_TESTNET');
  }
  if (asFiniteNumber(policy.soakMinutes) !== 1440) {
    errors.push(`POLICY_SOAK_MINUTES_INVALID:${String(policy.soakMinutes)}`);
  }
  if (!Array.isArray(policy.scope) || policy.scope.length === 0) {
    errors.push('POLICY_SCOPE_EMPTY');
  }
  return errors;
};

const loadPolicy = (path: string): CappedTestnetPolicy => {
  if (!existsSync(path)) throw new Error(`CAPPED_TESTNET_POLICY_MISSING:${path}`);
  return JSON.parse(readFileSync(path, 'utf8')) as CappedTestnetPolicy;
};

export const buildCappedTestnetGateSteps = (
  policy: CappedTestnetPolicy,
  options: { skipSoak: boolean },
): GateStep[] => {
  const soakMinutes = Math.floor(asFiniteNumber(policy.soakMinutes) ?? 1440);
  const steps: GateStep[] = [
    { name: 'source check', command: 'bun run check', timeoutMs: 1_200_000 },
    { name: 'security audit pack', command: 'bun run security:audit-pack', timeoutMs: 120_000 },
    { name: 'release gate', command: 'bun run gate:release', timeoutMs: 7_200_000 },
    { name: 'full e2e gate', command: 'bun run test:e2e:full', timeoutMs: 7_200_000 },
    { name: 'watchtower smoke', command: 'bun run test:watchtower:smoke', timeoutMs: 240_000 },
    { name: 'capped topology health', command: 'bun run prod:health:capped-testnet', timeoutMs: 180_000 },
  ];
  if (!options.skipSoak) {
    steps.push({
      name: '24h release soak',
      command: `bun runtime/scripts/run-soak-gate.ts --profile=release --minutes=${soakMinutes}`,
      timeoutMs: (soakMinutes + 30) * 60_000,
    });
  }
  return steps;
};

const runTextCommand = async (command: string): Promise<{ code: number | null; stdout: string; stderr: string }> => {
  const proc: ChildProcessByStdio<null, Readable, Readable> = spawn('sh', ['-lc', command], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', chunk => {
    stdout += chunk.toString();
  });
  proc.stderr.on('data', chunk => {
    stderr += chunk.toString();
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    proc.once('error', reject);
    proc.once('exit', resolve);
  });
  return { code, stdout, stderr };
};

const runStep = async (step: GateStep): Promise<StepResult> => {
  const startedAt = Date.now();
  const proc: ChildProcessByStdio<null, Readable, Readable> = spawn('sh', ['-lc', step.command], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const prefix = `[capped:${step.name}]`;
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

const main = async (): Promise<void> => {
  const args = parseCappedGateArgs();
  const policy = loadPolicy(args.policyPath);
  const policyErrors = validateCappedTestnetPolicy(policy);
  if (policyErrors.length > 0) {
    throw new Error(`CAPPED_TESTNET_POLICY_INVALID:${policyErrors.join(',')}`);
  }

  const commit = await runTextCommand('git rev-parse HEAD');
  if (commit.code !== 0) throw new Error(`GIT_COMMIT_UNAVAILABLE:${commit.stderr || commit.stdout}`);
  const dirty = await runTextCommand('git status --short');
  if (dirty.code !== 0) throw new Error(`GIT_STATUS_UNAVAILABLE:${dirty.stderr || dirty.stdout}`);
  if (dirty.stdout.trim() && !args.allowDirty) {
    throw new Error(`CAPPED_TESTNET_DIRTY_WORKTREE:\n${dirty.stdout}`);
  }

  const steps = buildCappedTestnetGateSteps(policy, { skipSoak: args.skipSoak });
  const baseReport = {
    verdict: args.dryRun ? 'DRY_RUN' : 'RUNNING',
    startedAt: new Date().toISOString(),
    commit: commit.stdout.trim(),
    dirtyWorktree: dirty.stdout.trim(),
    policyPath: args.policyPath,
    policy,
    steps,
  };
  writeReport(args.outPath, baseReport);

  console.log('XLN capped-testnet gate');
  console.log(`commit=${commit.stdout.trim()}`);
  console.log(`policy=${args.policyPath}`);
  console.log(`report=${args.outPath}`);
  steps.forEach((step, index) => console.log(`${index + 1}. ${step.name}: ${step.command}`));
  if (args.dryRun) return;

  const results: StepResult[] = [];
  for (const step of steps) {
    const result = await runStep(step);
    results.push(result);
    writeReport(args.outPath, { ...baseReport, verdict: 'RUNNING', results });
    if (result.code !== 0) {
      writeReport(args.outPath, { ...baseReport, verdict: 'CAPPED_TESTNET_FAIL', results });
      process.exit(result.code ?? 1);
    }
  }
  writeReport(args.outPath, {
    ...baseReport,
    verdict: 'CAPPED_TESTNET_PASS',
    finishedAt: new Date().toISOString(),
    results,
  });
  console.log('CAPPED_TESTNET_PASS');
};

if (import.meta.main) {
  main().catch((error) => {
    console.error('CAPPED_TESTNET_FAIL');
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
  });
}
