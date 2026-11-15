import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createVerificationFixtures } from '../fixtures';
import { git } from '../git';
import { profileForChanges, verificationBudget } from '../profile';
import { verify } from '../verify';

const { temporary, fixture, commit } = createVerificationFixtures();
afterAll(() => rmSync(temporary, { recursive: true, force: true }));
const write = (root: string, path: string): void => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), 'committed verification input\n');
};

test.each([
  'jurisdictions/contracts/Depository.sol',
  'jurisdictions/tasks/deploy.ts',
  'jurisdictions/scripts/deployment/operator/standalone.ts',
  'jurisdictions/ignition/parameters/ethereum-sepolia.json',
  'frontend/static/contracts/Depository.json',
  'jurisdictions/typechain-types/Depository.ts',
  'frontend/static/contracts/HankoVerifier.json',
  'core/__tests__/orchestrator/standalone-deployment/standalone-deployment-anvil.test.ts',
  'core/jurisdiction/adapter/stack-manager/verification.ts',
  'tools/deployment/check.ts',
])('selects deployment for the owning contract/deployment path %s', path => {
  const profile = profileForChanges([path], 'base');
  expect(profile.name).toBe('deployment');
  expect(verificationBudget(profile)).toBe(1_560_000);
});

test.each([
  'core/runtime/pay.ts',
  'core/account/crypto.ts',
  'core/hanko/index.ts',
  'core/protocol/crypto/index.ts',
  'core/protocol/serialization/index.ts',
  'core/api/server/control/stack-manager.ts',
  'rscore/src/http.rs',
  'frontend/src/app.svelte',
  'ui/src/app.tsx',
  'package.json',
  'bun.lock',
  'tsconfig.json',
  'scripts/verification/verify.ts',
  'unknown.ts',
  'jurisdictions/contracts/HankoVerifier.sol',
  'jurisdictions/contracts/HashLadder.sol',
  'jurisdictions/contracts/Types.sol',
  'jurisdictions/contracts/EntityTypes.sol',
  'jurisdictions/contracts/unknown.ts',
])('keeps full verification for the broader or unknown path %s', path => {
  const profile = profileForChanges(['jurisdictions/contracts/Depository.sol', path], 'base');
  expect(profile.name).toBe('full');
  expect(verificationBudget(profile)).toBe(300_000);
});

test('an empty range does not skip full verification', () => {
  expect(profileForChanges([], 'base').name).toBe('full');
});

test('runs deployment once without an extra Hardhat run and records scope evidence', async () => {
  const root = fixture('throw new Error("full must not run");', 'throw new Error("contracts must not repeat");');
  const base = git(root, ['rev-parse', 'HEAD']).trim();
  write(root, 'jurisdictions/contracts/Probe.sol');
  commit(root);
  const result = await verify(root, base);
  expect(result.passed).toBe(true);
  expect(result.profile).toEqual({
    name: 'deployment',
    reason: 'deployment-only',
    base,
    paths: ['jurisdictions/contracts/Probe.sol'],
  });
  expect(result.command.argv).toEqual([process.execPath, 'run', 'check:deployment']);
  expect(result.command.budgetMs).toBe(1_560_000);
  expect(result.contracts).toBeNull();
  expect(readFileSync(result.logPath, 'utf8')).toContain('fixture-deployment-output');
  expect(JSON.parse(readFileSync(result.resultPath, 'utf8')).schema).toBe(2);
});

test('includes every pending commit instead of classifying only HEAD', async () => {
  const root = fixture();
  const base = git(root, ['rev-parse', 'HEAD']).trim();
  write(root, 'core/runtime/financial.ts');
  commit(root);
  write(root, 'jurisdictions/contracts/Probe.sol');
  commit(root);
  const result = await verify(root, base);
  expect(result.passed).toBe(true);
  expect(result.profile.name).toBe('full');
  expect(result.profile.paths).toContain('core/runtime/financial.ts');
  expect(result.contracts?.result?.exitCode).toBe(0);
});

test('shared proof schema plus generated artifacts still executes full verification', async () => {
  const root = fixture();
  const base = git(root, ['rev-parse', 'HEAD']).trim();
  write(root, 'jurisdictions/contracts/Types.sol');
  write(root, 'frontend/static/contracts/Depository.json');
  commit(root);
  const result = await verify(root, base);
  expect(result.passed).toBe(true);
  expect(result.profile.name).toBe('full');
  expect(result.command.argv).toEqual([process.execPath, 'run', 'check']);
  expect(result.contracts?.result?.exitCode).toBe(0);
  const log = readFileSync(result.logPath, 'utf8');
  expect(log).toContain('fixture-check-output');
  expect(log).toContain('fixture-contracts-output');
  expect(log).not.toContain('fixture-deployment-output');
});

test('a rename cannot hide a deleted broader source behind a deployment destination', async () => {
  const root = fixture();
  const base = git(root, ['rev-parse', 'HEAD']).trim();
  mkdirSync(join(root, 'jurisdictions/contracts'), { recursive: true });
  git(root, ['mv', 'input.txt', 'jurisdictions/contracts/Probe.sol']);
  commit(root);
  const result = await verify(root, base);
  expect(result.profile.name).toBe('full');
  expect(result.profile.paths).toContain('input.txt');
  expect(result.profile.paths).toContain('jurisdictions/contracts/Probe.sol');
});

test('an absent remote branch retains the full commands', async () => {
  const result = await verify(fixture(), '0'.repeat(40));
  expect(result.passed).toBe(true);
  expect(result.profile.reason).toBe('new-remote-branch');
  expect(result.contracts?.result?.exitCode).toBe(0);
});

test('an unavailable base rejects before running either command', async () => {
  const result = await verify(fixture(), 'f'.repeat(40));
  expect(result.passed).toBe(false);
  expect(result.problem).toContain('VERIFY_GIT_FAILED');
  expect(result.command.result).toBeNull();
});

test('a non-ancestor base cannot narrow verification', async () => {
  const root = fixture();
  git(root, ['checkout', '-b', 'side']);
  write(root, 'jurisdictions/contracts/Side.sol');
  commit(root);
  const base = git(root, ['rev-parse', 'HEAD']).trim();
  git(root, ['checkout', 'main']);
  write(root, 'jurisdictions/contracts/Probe.sol');
  commit(root);
  const result = await verify(root, base);
  expect(result.passed).toBe(true);
  expect(result.profile.reason).toBe('non-ancestor-base');
  expect(result.contracts?.result?.exitCode).toBe(0);
});

test('retains a deployment failure and does not run the full commands afterward', async () => {
  const root = fixture(undefined, undefined, 'console.error("deployment-red"); process.exit(9);');
  const base = git(root, ['rev-parse', 'HEAD']).trim();
  write(root, 'jurisdictions/contracts/Probe.sol');
  commit(root);
  const result = await verify(root, base);
  expect(result.passed).toBe(false);
  expect(result.problem).toBe('VERIFY_CHECK_FAILED:exitCode=9');
  expect(result.contracts).toBeNull();
  expect(readFileSync(result.logPath, 'utf8')).toContain('deployment-red');
});

test('deployment verification still rejects source changes made by its command', async () => {
  const root = fixture(undefined, undefined, 'await Bun.write("input.txt", "changed during deployment check");');
  const base = git(root, ['rev-parse', 'HEAD']).trim();
  write(root, 'jurisdictions/contracts/Probe.sol');
  commit(root);
  const result = await verify(root, base);
  expect(result.passed).toBe(false);
  expect(result.problem).toBe('VERIFY_DIRTY_SOURCE:tracked=1:untracked=0');
});
