#!/usr/bin/env bun

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readGateSource, runGateSteps } from './gate-child-process';

import { assertMinDiskFree, getMinDiskFreeBytes } from '../../support/storage-monitor';
import { MAINNET_GATE } from './mainnet-gate-constants';
import {
  cleanupTestArtifactsBeforeRun,
  TEST_ARTIFACT_CLEANUP_DONE_ENV,
  withoutTestArtifactCleanupDoneEnv,
} from '../e2e/harness/test-artifact-cleanup';

export type MainnetPreflightArgs = {
  dryRun: boolean;
  allowDirty: boolean;
  includeSoak: boolean;
  includeScale: boolean;
  keepTestArtifacts: boolean;
  outPath: string;
};

export type MainnetPreflightStep = {
  name: string;
  category: 'source' | 'invariant' | 'security' | 'release' | 'e2e' | 'native' | 'recovery' | 'health' | 'soak' | 'scale';
  command: string;
  timeoutMs: number;
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
  let keepTestArtifacts = false;
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
    if (arg === '--keep-test-artifacts' || arg === '--no-cleanup') {
      keepTestArtifacts = true;
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

  return { dryRun, allowDirty, includeSoak, includeScale, keepTestArtifacts, outPath };
};

// Pay, same-J Swap and Lending (--same-j) plus Cross-swap on genuine TVM. Each phase
// consumes the ledger the previous one left, so the run needs a never-used stand path.
const NATIVE_TRON_PHASES = ['deploy-graph', 'economic', 'runtime-import', 'cross-network', 'cross-swap', 'same-j', 'same-j-restore'];
const NATIVE_TRON_FOUR_FLOWS = [
  'export XLN_TRON_STAND_PATH="$PWD/db/native-tron-preflight-$(date -u +%Y%m%dT%H%M%SZ)"',
  'test ! -e "$XLN_TRON_STAND_PATH"',
  // Same-J replay evidence requires inline Account execution (scripts/tron/flows/same-j-steps.ts).
  ...NATIVE_TRON_PHASES.map(phase => `${phase.startsWith('same-j') ? 'XLN_TS_ACCOUNT_WORKERS=0 ' : ''}`
    + `bun run stand:run --reason preflight-native-${phase} --timeout-ms 600000 -- bun scripts/tron/native-stand.ts --${phase}`),
].join(' && ');

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
        'core/__tests__/finance/state/derive-delta-property.test.ts',
        'core/__tests__/proofs/fx-admission.test.ts',
        'core/__tests__/runtime/observability/env-events-audit-commit.test.ts',
        'core/__tests__/operations/release/capped-testnet-gate.test.ts',
        'core/__tests__/operations/health/prod-health-smoke.test.ts',
      ].join(' '),
      timeoutMs: 240_000,
    },
    { name: 'security audit pack', category: 'security', command: 'bun run security:audit-pack', timeoutMs: 120_000 },
    { name: 'release integration gate', category: 'release', command: 'bun run gate:release', timeoutMs: 7_200_000 },
    { name: 'full browser e2e evidence', category: 'e2e', command: 'bun run test:e2e:full', timeoutMs: 7_200_000 },
    { name: 'native TRON four flows', category: 'native', command: NATIVE_TRON_FOUR_FLOWS, timeoutMs: 4_500_000 },
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
      command: `bun core/scripts/release/run-soak-gate.ts --profile=release --minutes=${MAINNET_GATE.soakMinutes}`,
      timeoutMs: (MAINNET_GATE.soakMinutes + 30) * 60_000,
    });
  }

  return steps;
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
  const { head: gitHead, dirty } = readGateSource();
  if (dirty && !args.allowDirty) throw new Error(`MAINNET_PREFLIGHT_DIRTY_WORKTREE:\n${dirty}`);

  if (!args.dryRun) {
    cleanupTestArtifactsBeforeRun({
      reason: 'mainnet-preflight',
      argv: args.keepTestArtifacts ? ['--keep-test-artifacts'] : process.argv.slice(2),
    });
    process.env[TEST_ARTIFACT_CLEANUP_DONE_ENV] = '1';
    assertMinDiskFree();
  }

  const steps = buildMainnetPreflightSteps(args);
  const report = {
    verdict: args.dryRun ? 'DRY_RUN' : 'RUNNING',
    startedAt: new Date().toISOString(),
    gitHead,
    dirty: Boolean(dirty),
    gitStatus: dirty,
    thresholds: {
      regressionThresholdPct: MAINNET_GATE.regressionThresholdPct,
      soakMinutes: MAINNET_GATE.soakMinutes,
      expectedHubs: MAINNET_GATE.expectedHubs,
      expectedTowers: MAINNET_GATE.expectedTowers,
      minDiskFreeBytes: getMinDiskFreeBytes(),
    },
    args,
    steps,
  };

  writeReport(args.outPath, report);
  printPlan(steps);
  console.log(`gitHead=${gitHead.slice(0, 12)}${dirty ? ' dirty' : ''}`);
  console.log(`minDiskFreeBytes=${getMinDiskFreeBytes()}`);
  console.log(`report=${args.outPath}`);
  if (args.dryRun) return;

  const { results, firstRed } = await runGateSteps(steps, {
    label: step => `mainnet:${step.category}:${step.name}`,
    env: withoutTestArtifactCleanupDoneEnv,
    afterStep: done => writeReport(args.outPath, { ...report, verdict: 'RUNNING', results: done }),
  });
  if (firstRed) {
    writeReport(args.outPath, { ...report, verdict: 'MAINNET_PREFLIGHT_FAIL', results, finishedAt: new Date().toISOString() });
    process.exit(firstRed.code ?? 1);
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
