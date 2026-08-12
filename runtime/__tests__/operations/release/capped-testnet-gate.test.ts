import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  buildCappedTestnetGateSteps,
  parseCappedGateArgs,
  validateCappedTestnetPolicy,
  type CappedTestnetPolicy,
} from '../../../scripts/release/run-capped-testnet-gate';
import { MAINNET_GATE, MAINNET_GATE_LABELS } from '../../../scripts/release/mainnet-gate-constants';

const validPolicy = (): CappedTestnetPolicy => ({
  $schema: MAINNET_GATE_LABELS.cappedPolicySchema,
  name: MAINNET_GATE_LABELS.cappedPolicyName,
  scope: ['landing', 'all-current-user-facing-flows'],
  riskCapUsd: null,
  riskCapEnforcement: 'not_implemented',
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

test('capped testnet policy fails closed until the cap has executable enforcement', () => {
  expect(validateCappedTestnetPolicy(validPolicy())).toEqual([
    'CAPPED_TESTNET_EXECUTABLE_RISK_CAP_ENFORCEMENT_MISSING',
  ]);
});

test('capped testnet policy rejects operator-only cap claims and weak exceptions', () => {
  const policy = {
    ...validPolicy(),
    riskCapUsd: 10_001,
    riskCapEnforcement: 'operator_config',
    exceptionPolicy: {
      p0: 'owner_signoff_required',
      p1: 'forbidden',
      p2: 'owner_signoff_required',
      p3: 'issue_required',
    },
  };

  expect(validateCappedTestnetPolicy(policy)).toContain('POLICY_UNENFORCED_RISK_CAP_CLAIM:10001');
  expect(validateCappedTestnetPolicy(policy)).toContain(
    'POLICY_RISK_CAP_ENFORCEMENT_MUST_ADMIT_MISSING:operator_config',
  );
  expect(validateCappedTestnetPolicy(policy)).toContain('POLICY_P0_EXCEPTION_INVALID');
});

test('capped testnet gate includes agreed one-hour soak unless explicitly skipped', () => {
  const full = buildCappedTestnetGateSteps(validPolicy(), { skipSoak: false });
  expect(full.map(step => step.command)).toContain('bun runtime/scripts/release/run-soak-gate.ts --profile=release --minutes=60');

  const preflight = buildCappedTestnetGateSteps(validPolicy(), { skipSoak: true });
  expect(preflight.some(step => step.command.includes('--minutes=60'))).toBe(false);
});

test('package capped soak script matches the agreed one-hour policy', () => {
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts?: Record<string, string> };
  expect(packageJson.scripts?.['soak:capped-testnet']).toBe(
    `bun runtime/scripts/release/run-soak-gate.ts --profile=release --minutes=${MAINNET_GATE.soakMinutes}`,
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
  const source = readFileSync('runtime/scripts/release/run-capped-testnet-gate.ts', 'utf8');
  expect(source).toContain('cleanupTestArtifactsBeforeRun({');
  expect(source).toContain("reason: 'capped-testnet'");
  expect(source).toContain('TEST_ARTIFACT_CLEANUP_DONE_ENV');
  expect(source).toContain("import { sanitizeChildProcessEnv } from '../../api/server/child-process-env';");
  expect(source).toContain('env: sanitizeChildProcessEnv(process.env)');
  expect(source.indexOf('cleanupTestArtifactsBeforeRun({')).toBeLessThan(
    source.indexOf('writeReport(args.outPath, baseReport)'),
  );
});

test('capped testnet timeout terminates the entire spawned process group', () => {
  const source = readFileSync('runtime/scripts/release/run-capped-testnet-gate.ts', 'utf8');
  expect(source).toContain("import { GATE_CHILD_PROCESS_DETACHED, terminateGateProcessGroup } from './gate-child-process';");
  expect(source).toContain('detached: GATE_CHILD_PROCESS_DETACHED');
  expect(source).toContain('termination = terminateGateProcessGroup(proc)');
  expect(source).not.toContain("proc.kill('SIGTERM')");
  expect(source).not.toContain("proc.kill('SIGKILL')");
});
