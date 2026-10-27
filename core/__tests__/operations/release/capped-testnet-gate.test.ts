import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { safeStringify } from '../../../protocol/serialization';
import { runGateSteps } from '../../../scripts/release/gate-child-process';

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
  riskCapEnforcement: 'not_applicable',
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

test('public testnet policy permits open funding while retaining recovery and authority gates', () => {
  expect(validateCappedTestnetPolicy(validPolicy())).toEqual([]);
  expect(validateCappedTestnetPolicy({ ...validPolicy(), recoverySlaSeconds: 61 }))
    .toContain('POLICY_RECOVERY_SLA_INVALID:61');
  expect(validateCappedTestnetPolicy({ ...validPolicy(), riskCapUsd: undefined }))
    .toContain('POLICY_GLOBAL_RISK_CAP_FORBIDDEN:undefined');
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

  expect(validateCappedTestnetPolicy(policy)).toContain('POLICY_GLOBAL_RISK_CAP_FORBIDDEN:10001');
  expect(validateCappedTestnetPolicy(policy)).toContain(
    'POLICY_RISK_CAP_ENFORCEMENT_NOT_APPLICABLE:operator_config',
  );
  expect(validateCappedTestnetPolicy(policy)).toContain('POLICY_P0_EXCEPTION_INVALID');
});

test('capped testnet gate includes agreed one-hour soak unless explicitly skipped', () => {
  const full = buildCappedTestnetGateSteps(validPolicy(), { skipSoak: false });
  expect(full.map(step => step.command)).toContain('bun core/scripts/release/run-soak-gate.ts --profile=release --minutes=60');

  const preflight = buildCappedTestnetGateSteps(validPolicy(), { skipSoak: true });
  expect(preflight.some(step => step.command.includes('--minutes=60'))).toBe(false);
});

test('package capped soak script matches the agreed one-hour policy', () => {
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts?: Record<string, string> };
  expect(packageJson.scripts?.['soak:capped-testnet']).toBe(
    `bun core/scripts/release/run-soak-gate.ts --profile=release --minutes=${MAINNET_GATE.soakMinutes}`,
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
  const source = readFileSync('core/scripts/release/run-capped-testnet-gate.ts', 'utf8');
  expect(source).toContain('cleanupTestArtifactsBeforeRun({');
  expect(source).toContain("reason: 'capped-testnet'");
  expect(source).toContain('TEST_ARTIFACT_CLEANUP_DONE_ENV');
  expect(source).toContain("import { sanitizeChildProcessEnv } from '../../api/server/child-process-env';");
  expect(source).toContain('env: () => sanitizeChildProcessEnv(process.env)');
  expect(source.indexOf('cleanupTestArtifactsBeforeRun({')).toBeLessThan(
    source.indexOf('writeReport(args.outPath, baseReport)'),
  );
});

test('capped testnet timeout terminates the entire spawned process group', () => {
  // All three release gates share one step runner; the group kill lives there.
  for (const gate of ['run-capped-testnet-gate.ts', 'run-mainnet-preflight-gate.ts', 'run-release-gate.ts']) {
    const source = readFileSync(`core/scripts/release/${gate}`, 'utf8');
    expect(source, gate).toContain('await runGateSteps(steps, {');
    expect(source, gate).not.toContain('spawn(');
  }
  const runner = readFileSync('core/scripts/release/gate-child-process.ts', 'utf8');
  expect(runner).toContain('detached: GATE_CHILD_PROCESS_DETACHED');
  expect(runner).toContain('termination = terminateGateProcessGroup(proc)');
  expect(runner).not.toContain("proc.kill('SIGTERM')");
  expect(runner).not.toContain("proc.kill('SIGKILL')");
});

test('a timed-out child exiting zero on SIGTERM fails with 124 and stops the gate', async () => {
  const root = mkdtempSync(join(tmpdir(), 'xln-gate-timeout-'));
  const child = join(root, 'child.ts');
  const marker = join(root, 'terminated');
  const next = join(root, 'next');
  // exec replaces the gate shell: the observed exit code really is zero.
  writeFileSync(child, `process.on('SIGTERM', () => { require('node:fs').writeFileSync(${safeStringify(marker)}, 'zero'); process.exit(0); }); setInterval(() => {}, 1000);`);
  try {
    const result = await runGateSteps([
      { name: 'timeout', command: `exec '${process.execPath}' '${child}'`, timeoutMs: 500 },
      { name: 'next', command: `touch '${next}'`, timeoutMs: 500 },
    ], { label: step => step.name, env: () => process.env });
    expect(readFileSync(marker, 'utf8')).toBe('zero');
    expect(result.results).toHaveLength(1);
    expect(result.firstRed).toMatchObject({ name: 'timeout', status: 'fail', code: 124 });
    expect(existsSync(next)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a successful child without timeout passes and allows the next step', async () => {
  const result = await runGateSteps([
    { name: 'first', command: 'exit 0', timeoutMs: 2_000 },
    { name: 'second', command: 'exit 0', timeoutMs: 2_000 },
  ], { label: step => step.name, env: () => process.env });
  expect(result.results.map(step => [step.status, step.code])).toEqual([['pass', 0], ['pass', 0]]);
  expect(result.firstRed).toBeNull();
});
