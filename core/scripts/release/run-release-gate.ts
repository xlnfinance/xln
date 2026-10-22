#!/usr/bin/env bun

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import type { Readable } from 'node:stream';
import { GATE_CHILD_PROCESS_DETACHED, terminateGateProcessGroup } from './gate-child-process';

import { assertMinDiskFree, getMinDiskFreeBytes } from '../../support/storage-monitor';
import {
  cleanupTestArtifactsBeforeRun,
  TEST_ARTIFACT_CLEANUP_DONE_ENV,
  withoutTestArtifactCleanupDoneEnv,
} from '../e2e/harness/test-artifact-cleanup';
import { XLN_RELEASE_PATHS } from '../../../tools/release-snapshot/scope.ts';

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

// Cross-j and hash-ladder tests are a release family, not a hand-maintained
// sample. Discovering the family makes every new edge-case suite enter the
// release gate automatically; a static list previously left nine financial
// suites green locally but invisible to CI/release.
const isCrossJRuntimeCoreTest = (name: string): boolean =>
  name.endsWith('.test.ts') &&
  (name.includes('cross-j') ||
    name.includes('cross-jurisdiction') ||
    name.includes('hash-ladder') ||
    name.includes('pull-registry'));

const collectCrossJRuntimeCoreTests = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap(entry => {
      const path = `${directory}/${entry.name}`;
      // This family executes the TS engine. Required Rust production and
      // semantic checks run through their own owning gates.
      if (entry.isDirectory()) return entry.name === 'rscore' ? [] : collectCrossJRuntimeCoreTests(path);
      return entry.isFile() && isCrossJRuntimeCoreTest(entry.name) ? [path] : [];
    });

const CROSS_J_RUNTIME_CORE_TESTS = collectCrossJRuntimeCoreTests('core/__tests__').sort();

if (CROSS_J_RUNTIME_CORE_TESTS.length === 0) {
  throw new Error('RELEASE_GATE_CROSS_J_TEST_FAMILY_EMPTY');
}

const RUNTIME_CORE_TESTS = [
  'core/__tests__/testing/audit/audit-failfast-regressions-part-1.test.ts',
  'core/__tests__/testing/audit/audit-failfast-regressions-part-2.test.ts',
  'core/__tests__/testing/audit/audit-failfast-regressions-part-3.test.ts',
  'core/__tests__/testing/audit/audit-failfast-regressions-part-4.test.ts',
  'core/__tests__/testing/audit/audit-failfast-regressions-part-5.test.ts',
  'core/__tests__/testing/audit/audit-failfast-regressions-part-6.test.ts',
  // Current lending admission must preserve signed-command authority and exact
  // rejection behavior while admitting the existing production product.
  'core/__tests__/proofs/fx-admission.test.ts',
  'core/__tests__/runtime/ingress/recovery/lending-production-admission.test.ts',
  'core/__tests__/finance/lending/rejected-draw.test.ts',
  'core/__tests__/finance/lending/stale-repayment.test.ts',
  'core/__tests__/finance/lending/loan-covenant.test.ts',
  'core/__tests__/finance/state/lending.test.ts',
  'core/__tests__/finance/state/lending-funding.test.ts',
  'core/__tests__/storage/durability/lending-real-crash-recovery.test.ts',
  'core/__tests__/storage/runtime/storage-canonical-hash.test.ts',
  'core/__tests__/storage/recovery/storage-crash-recovery.test.ts',
  'core/__tests__/storage/recovery/portable/local-commit-outbox-replay.test.ts',
  'core/__tests__/storage/history/storage-frame-journal-retention.test.ts',
  'core/__tests__/jurisdiction/submission/recovery/j-submit-crash-recovery.test.ts',
  'core/__tests__/jurisdiction/submission/recovery/j-submit-real-rpc-crash-recovery.test.ts',
  'core/__tests__/jurisdiction/submission/recovery/j-submit-durability.test.ts',
  'core/__tests__/jurisdiction/submission/tron-signed-transaction.test.ts',
  'core/__tests__/jurisdiction/adapter/tron/tron-broadcast.test.ts',
  'core/__tests__/jurisdiction/adapter/tron/tron-finality.test.ts',
  'core/__tests__/registration/numbered/tron-registration-finality.test.ts',
  'core/__tests__/registration/numbered/tron-registration-replacement.test.ts',
  'core/__tests__/registration/numbered/numbered-registration-intent.test.ts',
  'core/__tests__/registration/numbered/numbered-registration-rpc.test.ts',
  'core/__tests__/operations/health/native-server-jurisdiction.test.ts',
  'tests/frontend/move/external-recipient.test.ts',
  ...CROSS_J_RUNTIME_CORE_TESTS,
  'core/__tests__/entity/boundaries/entity-frame-j-broadcast-continuation.test.ts',
  'core/__tests__/storage/recovery/runtime-recovery-timestamp.test.ts',
  'core/__tests__/network/relay/relay-router.test.ts',
  'core/__tests__/network/pathfinding/direct-runtime-bun.test.ts',
  'core/__tests__/network/p2p/p2p-connect-idempotent.test.ts',
  'core/__tests__/network/p2p/p2p-direct-policy.test.ts',
  'core/__tests__/security/dispute/proof-builder.test.ts',
  'core/__tests__/security/dispute/dispute-hanko-monotonicity.test.ts',
  'core/__tests__/security/authority/transformer-ordering.test.ts',
  'core/__tests__/orchestrator/health/orchestrator-health-model.test.ts',
  'core/__tests__/orchestrator/recovery/orchestrator-reset-guard.test.ts',
  'core/__tests__/jurisdiction/history/jreplica-state-root.test.ts',
  'core/__tests__/storage/recovery/persistence-inspect.test.ts',
  'core/__tests__/security/watchtower/watchtower-rpc-last-resort.test.ts',
  'core/__tests__/security/watchtower/watchtower-restart-resilience.test.ts',
  'core/__tests__/security/policy/terminal-resource-bounds.test.ts',
  'native/__tests__/desktop-security.test.ts',
  'native/__tests__/extension-security.test.ts',
  'native/__tests__/capacitor-config.test.ts',
  'native/__tests__/native-build-options.test.ts',
  'native/__tests__/native-deeplink.test.ts',
  'native/__tests__/lazy-entity-id.test.ts',
  'native/__tests__/watchtower-recovery-flow.test.ts',
]
  .map(path => {
    if (!existsSync(path)) throw new Error(`RELEASE_GATE_TEST_MISSING:${path}`);
    return path;
  })
  .join(' ');

const RELEASE_PATHS = XLN_RELEASE_PATHS.join(' ');

const quickSteps: GateStep[] = [
  { name: 'frontend generated aliases', command: 'cd frontend && bunx svelte-kit sync', timeoutMs: 60_000 },
  { name: 'source checks', command: 'bun run check:src', timeoutMs: 600_000 },
  // GitHub needed 29.2s for the unit portion alone, then the contract proof was
  // killed by the old 30s watchdog. Keep both portions and allow cold CI setup.
  { name: 'release integrity tests', command: 'bun run test:release-integrity', timeoutMs: 120_000 },
  // The complete family takes ~160s locally, including its real-clock tower.
  // CI needs headroom for slower execution without dropping any assertions.
  { name: 'runtime core unit tests', command: `bun test ${RUNTIME_CORE_TESTS}`, timeoutMs: 420_000 },
  {
    name: 'bilateral same-height collision',
    command: 'bun run test:consensus:collision',
    timeoutMs: 120_000,
  },
  {
    name: 'diff whitespace check',
    command: `git diff --check -- ${RELEASE_PATHS}`,
    timeoutMs: 30_000,
  },
];

const ciPreE2eSteps: GateStep[] = [
  ...quickSteps,
  { name: 'flow E2E coverage contract', command: 'bun run test:e2e:coverage', timeoutMs: 30_000 },
  { name: 'frontend check', command: 'bun run check:frontend', timeoutMs: 180_000 },
  { name: 'contract full suite', command: 'bun run test:contracts:full', timeoutMs: 240_000 },
  {
    name: 'signed exit gas budget',
    command:
      "bun run stand:run --reason signed-exit-gas --timeout-ms 180000 -- forge test --root jurisdictions --match-contract 'Dispute(GasAdmission|IngressGas|CounterGas)Test|FundingExitTest' --fuzz-seed 0x20261012 -vv && bun core/scripts/checks/contracts/check-exit-gas-bytecode.ts",
    timeoutMs: 190_000,
  },
  { name: 'RPC settlement parity', command: 'bun run test:rpc-settlement', timeoutMs: 240_000 },
  { name: 'security audit pack', command: 'bun run security:audit-pack', timeoutMs: 30_000 },
  { name: 'storage WAL smoke', command: 'bun run test:persistence:cli', timeoutMs: 120_000 },
  { name: 'watchtower smoke', command: 'bun run test:watchtower:smoke', timeoutMs: 120_000 },
  { name: 'bootstrap soundcheck', command: 'bun run prod:bootstrap:soundcheck', timeoutMs: 1_200_000 },
];

// React is the launch wallet. Each group uses the existing production stand,
// its real contracts and an isolated state directory retained as CI evidence.
const walletE2eSteps: GateStep[] = (
  [
    [
      'React payment and admission E2E',
      'e2e-payment.spec.ts,e2e-lending-availability.spec.ts,e2e-reserve-funding.spec.ts',
      'payment',
    ],
    ['React direct credit E2E', 'e2e-direct-credit.spec.ts', 'direct-credit'],
    ['React collateral and signed credit request E2E', 'e2e-collateral.spec.ts', 'credit-request'],
    ['React dispute E2E', 'e2e-dispute-finality.spec.ts', 'dispute'],
    ['React offline protection E2E', 'e2e-dispute-protection.spec.ts', 'protection'],
    // Separate real fresh-device restores keep each stand inside its existing
    // budget; the combined four-test group measured 242.5s against 240s.
    ['React file recovery E2E', 'e2e-file-restore.spec.ts', 'file-recovery'],
    ['React tower recovery E2E', 'e2e-tower-restore.spec.ts,e2e-sovereignty.spec.ts', 'recovery'],
    [
      'React lending E2E',
      'e2e-lending.spec.ts,lending/e2e-bank-policy.spec.ts,lending/e2e-demand.spec.ts,lending/e2e-principal.spec.ts,lending/e2e-unfunded.spec.ts',
      'lending',
    ],
    ['React onboarding and ownership E2E', 'e2e-demo-sync.spec.ts,e2e-tutorial-company.spec.ts', 'ownership'],
  ] as const
)
  .map<GateStep>(([name, tests, directory]) => ({
    name,
    command:
      `XLN_LOCAL_PROD_SMOKE_DIR=.logs/gates/react-${directory} ` +
      `XLN_LOCAL_PROD_SMOKE_WALLET_TESTS=${tests} ` +
      `bun run stand:run --reason react-${directory} --timeout-ms 240000 -- bun run prod:smoke:local`,
    timeoutMs: 300_000,
  }))
  .concat([
    {
      name: 'React production build',
      command:
        'NODE_ENV=production XLN_UI_BASE=/ XLN_UI_STACK_ORIGIN= ' +
        'bun run stand:run --reason react-production-build --timeout-ms 240000 -- bun run --cwd "$PWD/ui" build',
      timeoutMs: 300_000,
    },
    {
      name: 'React production artifact E2E',
      command:
        'XLN_LOCAL_PROD_SMOKE_WALLET_ARTIFACT_DIR="$PWD/ui/dist" ' +
        'XLN_LOCAL_PROD_SMOKE_DIR=.logs/gates/react-production ' +
        'XLN_LOCAL_PROD_SMOKE_WALLET_TESTS=e2e-production-wallet.spec.ts ' +
        'bun run stand:run --reason react-production --timeout-ms 240000 -- bun run prod:smoke:local',
      timeoutMs: 300_000,
    },
  ]);

const ciSteps: GateStep[] = [...ciPreE2eSteps, ...walletE2eSteps];

const releaseSteps: GateStep[] = [
  ...ciPreE2eSteps,
  { name: 'bootstrap epoch rotation', command: 'bun run prod:bootstrap:rotation', timeoutMs: 1_200_000 },
  // Live recording, verified export and W1/W4 replay require one complete WAL per
  // scenario. The 600s budget interrupted the final 39-frame replay (11s alone).
  { name: 'deterministic replay oracle', command: 'bun run check:determinism', timeoutMs: 720_000 },
  { name: 'real WebSocket P2P relay', command: 'bun run test:p2p:relay', timeoutMs: 240_000 },
  // Keep the full deterministic scenario catalog in the release contract.
  // The isolated RPC runner below intentionally exercises only its expensive
  // core subset; without this step multi-sig/rapid-fire and other pure flows
  // could regress while every documented release command stayed green.
  { name: 'all deterministic scenarios', command: 'bun core/scenarios/run.ts --set=all', timeoutMs: 1_200_000 },
  { name: 'RPC system scenarios', command: 'bun run test:system:parallel', timeoutMs: 1_200_000 },
  {
    name: 'cross-j system scenario',
    command: 'bun core/scenarios/run.ts cross-j --mode=rpc --single',
    timeoutMs: 600_000,
  },
  {
    name: 'MM mesh system scenario',
    command: 'bun core/scenarios/run.ts mm-mesh --mode=rpc --single',
    timeoutMs: 600_000,
  },
  { name: 'hub 10k storage benchmark', command: 'bun run bench:radapter:hub10k', timeoutMs: 1_200_000 },
  { name: 'frozen core final', command: 'bun run frozen-core:check', timeoutMs: 30_000 },
  { name: 'Foundation release Hanko', command: 'bun run foundation-release:verify', timeoutMs: 30_000 },
  // Frozen Svelte and deferred product journeys remain outside launch evidence.
  ...walletE2eSteps,
];

// A release candidate has not been deployed yet, so querying the current production
// endpoint cannot validate this SHA. Deployment topology health stays mandatory in
// the mainnet/capped-testnet preflight and the post-deploy operations gate.

const profileSteps: Record<GateProfile, GateStep[]> = {
  quick: [...quickSteps, { name: 'frozen core final', command: 'bun run frozen-core:check', timeoutMs: 30_000 }],
  ci: [...ciSteps, { name: 'frozen core final', command: 'bun run frozen-core:check', timeoutMs: 30_000 }],
  release: releaseSteps,
};

function parseProfile(): GateProfile {
  const args = process.argv.slice(2);
  const explicit =
    args.find(arg => arg.startsWith('--profile='))?.split('=')[1] ||
    args.find(arg => arg === '--quick' || arg === '--ci' || arg === '--release')?.slice(2);
  if (explicit === 'quick' || explicit === 'ci' || explicit === 'release') return explicit;
  if (process.env['CI'] === 'true') return 'ci';
  return 'quick';
}

async function runStep(step: GateStep): Promise<StepResult> {
  const startedAt = Date.now();
  const proc: ChildProcessByStdio<null, Readable, Readable> = spawn('sh', ['-lc', step.command], {
    cwd: process.cwd(),
    env: withoutTestArtifactCleanupDoneEnv(),
    detached: GATE_CHILD_PROCESS_DETACHED,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const prefix = `[${step.name}]`;
  proc.stdout.on('data', chunk => process.stdout.write(`${prefix} ${chunk.toString()}`));
  proc.stderr.on('data', chunk => process.stderr.write(`${prefix} ${chunk.toString()}`));

  let timer: ReturnType<typeof setTimeout> | null = null;
  let termination: Promise<void> | null = null;
  const code = await new Promise<number | null>((resolve, reject) => {
    proc.once('error', reject);
    proc.once('exit', resolve);
    if (step.timeoutMs && step.timeoutMs > 0) {
      timer = setTimeout(() => {
        termination = terminateGateProcessGroup(proc);
      }, step.timeoutMs);
      timer.unref();
    }
  });
  if (timer) clearTimeout(timer);
  if (termination) await termination;

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
  if (profile !== 'quick') {
    console.log(`Disk guard: minFreeBytes=${getMinDiskFreeBytes()}`);
  }
  steps.forEach((step, index) => {
    console.log(`${index + 1}. ${step.name}`);
    console.log(`   ${step.command}`);
    console.log(`   timeoutMs=${step.timeoutMs ?? 0}`);
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
  if (process.argv.includes('--plan')) {
    printPlan(profile, steps);
    return;
  }
  cleanupTestArtifactsBeforeRun({ reason: `release-gate:${profile}` });
  process.env[TEST_ARTIFACT_CLEANUP_DONE_ENV] = '1';
  if (profile !== 'quick') assertMinDiskFree();
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

main().catch(error => {
  console.error('Release gate runner failed:', error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
