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

test('capped testnet gate arg parser supports preflight and dry run', () => {
  const parsed = parseCappedGateArgs(['--skip-soak', '--dry-run', '--allow-dirty', '--policy', 'ops/x.json', '--out=out.json']);
  expect(parsed).toEqual({
    policyPath: 'ops/x.json',
    skipSoak: true,
    dryRun: true,
    allowDirty: true,
    outPath: 'out.json',
  });
});
