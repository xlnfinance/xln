#!/usr/bin/env bun

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';

type GateProfile = 'quick' | 'ci' | 'release';

type GateStep = {
  name: string;
  command: string;
  timeoutMs?: number;
};

type StepResult = {
  name: string;
  command: string;
  code: number | null;
  durationMs: number;
};

const RUNTIME_CORE_TESTS = [
  'runtime/__tests__/audit-failfast-regressions.test.ts',
  'runtime/__tests__/storage-canonical-hash.test.ts',
  'runtime/__tests__/storage-crash-recovery.test.ts',
  'runtime/__tests__/storage-frame-journal-retention.test.ts',
  'runtime/__tests__/cross-jurisdiction-swap.test.ts',
  'runtime/__tests__/relay-router.test.ts',
  'runtime/__tests__/direct-runtime-bun.test.ts',
  'runtime/__tests__/p2p-direct-policy.test.ts',
  'runtime/__tests__/proof-builder.test.ts',
  'runtime/__tests__/transformer-ordering.test.ts',
  'runtime/__tests__/server-ingress-receipts.test.ts',
  'runtime/__tests__/watchtower-rpc-last-resort.test.ts',
  'runtime/__tests__/watchtower-restart-resilience.test.ts',
  'native/__tests__/desktop-security.test.ts',
  'native/__tests__/extension-security.test.ts',
  'native/__tests__/capacitor-config.test.ts',
  'native/__tests__/native-build-options.test.ts',
  'native/__tests__/native-deeplink.test.ts',
  'native/__tests__/lazy-entity-id.test.ts',
  'native/__tests__/watchtower-recovery-flow.test.ts',
].join(' ');

const SOUNDCHECK_TARGETS = [
  'runtime/runtime.ts',
  'runtime/entity-consensus.ts',
  'runtime/account-consensus.ts',
  'runtime/entity-tx/apply.ts',
  'runtime/storage',
  'runtime/relay-router.ts',
  'runtime/networking/p2p.ts',
].join(' ');

const quickSteps: GateStep[] = [
  { name: 'source checks', command: 'bun run check:src', timeoutMs: 120_000 },
  { name: 'runtime core unit tests', command: `bun test ${RUNTIME_CORE_TESTS}`, timeoutMs: 180_000 },
  {
    name: 'runtime soundcheck',
    command: `bun tools/soundcheck.ts --skip-tests ${SOUNDCHECK_TARGETS}`,
    timeoutMs: 180_000,
  },
  { name: 'diff whitespace check', command: 'git diff --check', timeoutMs: 30_000 },
];

const ciSteps: GateStep[] = [
  ...quickSteps,
  { name: 'flow E2E coverage contract', command: 'bun run test:e2e:coverage', timeoutMs: 30_000 },
  { name: 'frontend check', command: 'bun run check:frontend', timeoutMs: 180_000 },
  { name: 'contract full suite', command: 'bun run test:contracts:full', timeoutMs: 240_000 },
  { name: 'RPC settlement parity', command: 'bun run test:rpc-settlement', timeoutMs: 240_000 },
  { name: 'security audit pack', command: 'bun run security:audit-pack', timeoutMs: 30_000 },
  { name: 'storage WAL smoke', command: 'bun run test:persistence:cli', timeoutMs: 120_000 },
  { name: 'watchtower smoke', command: 'bun run test:watchtower:smoke', timeoutMs: 120_000 },
  { name: 'fast E2E gate', command: 'bun run test:e2e:fast', timeoutMs: 900_000 },
];

const releaseSteps: GateStep[] = [
  ...ciSteps,
  { name: 'bounded soak gate', command: 'bun run soak:quick', timeoutMs: 2_100_000 },
  { name: 'core E2E gate', command: 'bun run test:e2e:core', timeoutMs: 1_200_000 },
  { name: 'RPC system scenarios', command: 'bun run test:system:parallel', timeoutMs: 1_200_000 },
  { name: 'hub 10k storage benchmark', command: 'bun run bench:radapter:hub10k', timeoutMs: 1_200_000 },
  { name: 'production health smoke', command: 'bun run prod:health', timeoutMs: 60_000 },
];

const profileSteps: Record<GateProfile, GateStep[]> = {
  quick: quickSteps,
  ci: ciSteps,
  release: releaseSteps,
};

function parseProfile(): GateProfile {
  const args = process.argv.slice(2);
  const explicit = args.find(arg => arg.startsWith('--profile='))?.split('=')[1]
    || args.find(arg => arg === '--quick' || arg === '--ci' || arg === '--release')?.slice(2);
  if (explicit === 'quick' || explicit === 'ci' || explicit === 'release') return explicit;
  if (process.env['CI'] === 'true') return 'ci';
  return 'quick';
}

async function runStep(step: GateStep): Promise<StepResult> {
  const startedAt = Date.now();
  const proc: ChildProcessByStdio<null, Readable, Readable> = spawn('sh', ['-lc', step.command], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const prefix = `[${step.name}]`;
  proc.stdout.on('data', chunk => process.stdout.write(`${prefix} ${chunk.toString()}`));
  proc.stderr.on('data', chunk => process.stderr.write(`${prefix} ${chunk.toString()}`));

  let timer: ReturnType<typeof setTimeout> | null = null;
  const code = await new Promise<number | null>((resolve, reject) => {
    proc.once('error', reject);
    proc.once('exit', resolve);
    if (step.timeoutMs && step.timeoutMs > 0) {
      timer = setTimeout(() => {
        proc.kill('SIGTERM');
        setTimeout(() => {
          if (proc.exitCode === null) proc.kill('SIGKILL');
        }, 5_000).unref();
      }, step.timeoutMs);
      timer.unref();
    }
  });
  if (timer) clearTimeout(timer);

  return {
    name: step.name,
    command: step.command,
    code,
    durationMs: Date.now() - startedAt,
  };
}

function printPlan(profile: GateProfile, steps: GateStep[]): void {
  console.log('');
  console.log('='.repeat(76));
  console.log(`XLN release gate: ${profile}`);
  console.log('='.repeat(76));
  steps.forEach((step, index) => {
    console.log(`${index + 1}. ${step.name}`);
    console.log(`   ${step.command}`);
  });
  console.log('='.repeat(76));
  console.log('');
}

function printSummary(profile: GateProfile, results: StepResult[]): void {
  console.log('');
  console.log('='.repeat(76));
  console.log(`XLN release gate summary: ${profile}`);
  console.log('='.repeat(76));
  for (const result of results) {
    const seconds = (result.durationMs / 1000).toFixed(1);
    const status = result.code === 0 ? 'pass' : `fail(${result.code ?? 'signal'})`;
    console.log(`${status.padEnd(12)} ${seconds.padStart(8)}s  ${result.name}`);
  }
  console.log('='.repeat(76));
}

async function main(): Promise<void> {
  const profile = parseProfile();
  const steps = profileSteps[profile];
  printPlan(profile, steps);

  const results: StepResult[] = [];
  for (const step of steps) {
    const result = await runStep(step);
    results.push(result);
    if (result.code !== 0) {
      printSummary(profile, results);
      console.error(`Release gate failed at step: ${step.name}`);
      process.exit(result.code ?? 1);
    }
  }

  printSummary(profile, results);
}

main().catch((error) => {
  console.error('Release gate runner failed:', error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
