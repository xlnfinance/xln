import { expect, test } from 'bun:test';

import {
  buildCappedTestnetGateSteps,
  parseCappedGateArgs,
  validateCappedTestnetPolicy,
  type CappedTestnetPolicy,
} from '../scripts/run-capped-testnet-gate';

const validPolicy = (): CappedTestnetPolicy => ({
  $schema: 'xln:capped-testnet-policy:v1',
  name: 'capped-public-testnet',
  scope: ['landing', 'all-current-user-facing-flows'],
  riskCapUsd: 10_000,
  riskCapEnforcement: 'operator_config',
  expectedTowers: 1,
  expectedHubs: 3,
  recoverySlaSeconds: 60,
  exceptionPolicy: {
    p0: 'forbidden',
    p1: 'forbidden',
    p2: 'owner_signoff_required',
    p3: 'issue_required',
  },
  externalAuditRequired: false,
  soakMinutes: 1440,
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

test('capped testnet gate includes 24h soak unless explicitly skipped', () => {
  const full = buildCappedTestnetGateSteps(validPolicy(), { skipSoak: false });
  expect(full.map(step => step.command)).toContain('bun runtime/scripts/run-soak-gate.ts --profile=release --minutes=1440');

  const preflight = buildCappedTestnetGateSteps(validPolicy(), { skipSoak: true });
  expect(preflight.some(step => step.command.includes('--minutes=1440'))).toBe(false);
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
