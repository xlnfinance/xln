import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  buildCappedTestnetGateSteps,
  parseCappedGateArgs,
  validateCappedTestnetPolicy,
  type CappedTestnetPolicy,
} from '../scripts/run-capped-testnet-gate';
import { MAINNET_GATE, MAINNET_GATE_LABELS } from '../scripts/mainnet-gate-constants';

const validPolicy = (): CappedTestnetPolicy => ({
  $schema: MAINNET_GATE_LABELS.cappedPolicySchema,
  name: MAINNET_GATE_LABELS.cappedPolicyName,
  scope: ['landing', 'all-current-user-facing-flows'],
  riskCapUsd: MAINNET_GATE.cappedRiskUsd,
  riskCapEnforcement: 'operator_config',
  expectedTowers: MAINNET_GATE.expectedTowers,
  expectedHubs: MAINNET_GATE.expectedHubs,
  recoverySlaSeconds: MAINNET_GATE.recoverySlaSeconds,
  exceptionPolicy: {
    p0: 'forbidden',
    p1: 'forbidden',
    p2: 'owner_signoff_required',
    p3: 'issue_required',
  },
  externalAuditRequired: false,
  soakMinutes: MAINNET_GATE.soakMinutes,
});

test('capped testnet policy accepts the agreed launch envelope', () => {
  expect(validateCappedTestnetPolicy(validPolicy())).toEqual([]);
});

test('capped testnet policy rejects uncapped risk and weak exceptions', () => {
  const policy = {
    ...validPolicy(),
    riskCapUsd: 10_001,
    exceptionPolicy: {
      p0: 'owner_signoff_required',
      p1: 'forbidden',
      p2: 'owner_signoff_required',
      p3: 'issue_required',
    },
  };

  expect(validateCappedTestnetPolicy(policy)).toContain('POLICY_RISK_CAP_INVALID:10001');
  expect(validateCappedTestnetPolicy(policy)).toContain('POLICY_P0_EXCEPTION_INVALID');
});

test('capped testnet gate includes agreed one-hour soak unless explicitly skipped', () => {
  const full = buildCappedTestnetGateSteps(validPolicy(), { skipSoak: false });
  expect(full.map(step => step.command)).toContain('bun runtime/scripts/run-soak-gate.ts --profile=release --minutes=60');

  const preflight = buildCappedTestnetGateSteps(validPolicy(), { skipSoak: true });
  expect(preflight.some(step => step.command.includes('--minutes=60'))).toBe(false);
});

test('package capped soak script matches the agreed one-hour policy', () => {
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts?: Record<string, string> };
  expect(packageJson.scripts?.['soak:capped-testnet']).toBe(
    `bun runtime/scripts/run-soak-gate.ts --profile=release --minutes=${MAINNET_GATE.soakMinutes}`,
  );
});

test('ops runbook describes the capped gate as one hour', () => {
  const runbook = readFileSync('docs/deployment/ops-runbook.md', 'utf8');
  expect(runbook).toContain('one-hour capped soak');
  expect(runbook).not.toContain('24-hour soak');
});

test('capped testnet gate arg parser supports preflight and dry run', () => {
  const parsed = parseCappedGateArgs([
    '--skip-soak',
    '--dry-run',
    '--allow-dirty',
    '--keep-test-artifacts',
    '--policy',
    'ops/x.json',
    '--out=out.json',
  ]);
  expect(parsed).toEqual({
    policyPath: 'ops/x.json',
    skipSoak: true,
    dryRun: true,
    allowDirty: true,
    keepTestArtifacts: true,
    outPath: 'out.json',
  });
});

test('capped testnet gate starts from cleanup before writing run artifacts', () => {
  const source = readFileSync('runtime/scripts/run-capped-testnet-gate.ts', 'utf8');
  expect(source).toContain('cleanupTestArtifactsBeforeRun({');
  expect(source).toContain("reason: 'capped-testnet'");
  expect(source).toContain('TEST_ARTIFACT_CLEANUP_DONE_ENV');
  expect(source).toContain("import { sanitizeChildProcessEnv } from '../child-process-env';");
  expect(source).toContain('env: sanitizeChildProcessEnv(process.env)');
  expect(source.indexOf('cleanupTestArtifactsBeforeRun({')).toBeLessThan(
    source.indexOf('writeReport(args.outPath, baseReport)'),
  );
});
