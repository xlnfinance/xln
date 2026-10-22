import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { MAINNET_GATE } from '../../../scripts/release/mainnet-gate-constants';

import {
  buildMainnetPreflightSteps,
  parseMainnetPreflightArgs,
} from '../../../scripts/release/run-mainnet-preflight-gate';

const repoRoot = join(import.meta.dir, '..', '..', '..', '..');

for (const profile of ['ci', 'release']) {
  test(`${profile} executes required credit and swap journeys on the owning wallet stand`, () => {
    const plan = spawnSync(
      process.execPath,
      ['core/scripts/release/run-release-gate.ts', `--profile=${profile}`, '--plan'],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 10_000,
      },
    );
    expect(plan.status, plan.stderr).toBe(0);
    for (const file of [
      'e2e-direct-credit.spec.ts',
      'e2e-collateral.spec.ts',
      'e2e-swap.spec.ts',
      'e2e-swap-cancel.spec.ts',
      'e2e-cross-swap.spec.ts',
      'e2e-cross-swap-partial.spec.ts',
    ]) {
      const command = plan.stdout.split('\n').find(line => line.includes(`XLN_LOCAL_PROD_SMOKE_WALLET_TESTS=${file} `));
      expect(command, `${profile} must execute ${file}`).toBeDefined();
      expect(command).toContain('bun run stand:run');
      expect(command).toContain('bun run prod:smoke:local');
    }
  });
}

test('mainnet preflight builds money, recovery, health, and full e2e evidence by default', () => {
  const steps = buildMainnetPreflightSteps({ includeSoak: false, includeScale: false });
  const categories = steps.map(step => step.category);
  const commands = steps.map(step => step.command);

  expect(categories).toEqual(['source', 'invariant', 'security', 'release', 'e2e', 'recovery', 'health']);
  expect(commands).toContain('bun run check');
  expect(commands).toContain('bun run gate:release');
  expect(commands).toContain('bun run test:e2e:full');
  expect(commands).toContain('bun run prod:health:capped-testnet');
  expect(commands.some(command => command.includes('derive-delta-property.test.ts'))).toBe(true);
  // Execute the canonical local/peer rejection and historical-proof vectors.
  // Deferred lending must stay closed; completing it is not a launch requirement.
  expect(commands.some(command => command.includes('core/__tests__/proofs/fx-admission.test.ts'))).toBe(true);
});

test('canonical mainnet package gate always includes soak and scale evidence', () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  expect(pkg.scripts?.['gate:mainnet']).toBe(
    'bun core/scripts/release/run-mainnet-preflight-gate.ts --include-soak --include-scale',
  );
});

test('mainnet preflight opts into one-hour soak and bounded radapter scale evidence', () => {
  const steps = buildMainnetPreflightSteps({ includeSoak: true, includeScale: true });

  expect(steps.map(step => step.command)).toContain('bun run bench:radapter:hub100k:hot10k');
  expect(steps.map(step => step.command)).toContain(
    `bun core/scripts/release/run-soak-gate.ts --profile=release --minutes=${MAINNET_GATE.soakMinutes}`,
  );
  expect(MAINNET_GATE.soakMinutes).toBe(60);
  expect(MAINNET_GATE.regressionThresholdPct).toBe(20);
});

test('mainnet preflight arg parser supports dry-run reports and explicit heavy gates', () => {
  expect(
    parseMainnetPreflightArgs(['--dry-run', '--allow-dirty', '--include-soak', '--include-scale', '--out', 'out.json']),
  ).toEqual({
    dryRun: true,
    allowDirty: true,
    includeSoak: true,
    includeScale: true,
    keepTestArtifacts: false,
    outPath: 'out.json',
  });
});

test('mainnet preflight arg parser accepts explicit test artifact retention', () => {
  expect(parseMainnetPreflightArgs(['--keep-test-artifacts'])).toMatchObject({
    keepTestArtifacts: true,
  });
  expect(parseMainnetPreflightArgs(['--no-cleanup'])).toMatchObject({
    keepTestArtifacts: true,
  });
});

test('mainnet and release gates check disk before expensive browser/runtime gates', () => {
  const mainnetGate = readFileSync(join(repoRoot, 'core/scripts/release/run-mainnet-preflight-gate.ts'), 'utf8');
  const releaseGate = readFileSync(join(repoRoot, 'core/scripts/release/run-release-gate.ts'), 'utf8');

  expect(mainnetGate).toContain(
    "import { assertMinDiskFree, getMinDiskFreeBytes } from '../../support/storage-monitor';",
  );
  expect(mainnetGate).toContain('minDiskFreeBytes: getMinDiskFreeBytes(),');
  expect(mainnetGate).toContain('console.log(`minDiskFreeBytes=${getMinDiskFreeBytes()}`);');
  expect(mainnetGate.indexOf('cleanupTestArtifactsBeforeRun({')).toBeLessThan(
    mainnetGate.indexOf('assertMinDiskFree();'),
  );
  expect(mainnetGate.indexOf('assertMinDiskFree();')).toBeLessThan(mainnetGate.indexOf('printPlan(steps);'));
  expect(releaseGate).toContain(
    "import { assertMinDiskFree, getMinDiskFreeBytes } from '../../support/storage-monitor';",
  );
  expect(releaseGate).toContain('Disk guard: minFreeBytes=${getMinDiskFreeBytes()}');
  expect(releaseGate).toContain("if (profile !== 'quick') assertMinDiskFree();");
  expect(releaseGate.indexOf('cleanupTestArtifactsBeforeRun({ reason: `release-gate:${profile}` })')).toBeLessThan(
    releaseGate.indexOf("if (profile !== 'quick') assertMinDiskFree();"),
  );
});

test('CI source checks allow one cold Rust workspace build', () => {
  const releaseGate = readFileSync(join(repoRoot, 'core/scripts/release/run-release-gate.ts'), 'utf8');
  expect(releaseGate).toContain("{ name: 'source checks', command: 'bun run check:src', timeoutMs: 600_000 }");
});
