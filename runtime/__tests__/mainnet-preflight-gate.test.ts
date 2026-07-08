import { expect, test } from 'bun:test';

import { MAINNET_GATE } from '../scripts/mainnet-gate-constants';
import {
  buildMainnetPreflightSteps,
  parseMainnetPreflightArgs,
} from '../scripts/run-mainnet-preflight-gate';

test('mainnet preflight builds money, recovery, health, and full e2e evidence by default', () => {
  const steps = buildMainnetPreflightSteps({ includeSoak: false, includeScale: false });
  const categories = steps.map(step => step.category);
  const commands = steps.map(step => step.command);

  expect(categories).toEqual([
    'source',
    'invariant',
    'security',
    'release',
    'e2e',
    'recovery',
    'health',
  ]);
  expect(commands).toContain('bun run check');
  expect(commands).toContain('bun run gate:release');
  expect(commands).toContain('bun run test:e2e:full');
  expect(commands).toContain('bun run prod:health:capped-testnet');
  expect(commands.some(command => command.includes('derive-delta-property.test.ts'))).toBe(true);
});

test('mainnet preflight opts into one-hour soak and bounded radapter scale evidence', () => {
  const steps = buildMainnetPreflightSteps({ includeSoak: true, includeScale: true });

  expect(steps.map(step => step.command)).toContain('bun run bench:radapter:hub100k:hot10k');
  expect(steps.map(step => step.command)).toContain(
    `bun runtime/scripts/run-soak-gate.ts --profile=release --minutes=${MAINNET_GATE.soakMinutes}`,
  );
  expect(MAINNET_GATE.soakMinutes).toBe(60);
  expect(MAINNET_GATE.regressionThresholdPct).toBe(20);
});

test('mainnet preflight arg parser supports dry-run reports and explicit heavy gates', () => {
  expect(parseMainnetPreflightArgs([
    '--dry-run',
    '--allow-dirty',
    '--include-soak',
    '--include-scale',
    '--out',
    'out.json',
  ])).toEqual({
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
