import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createVerificationFixtures } from '../fixtures';
import { git } from '../git';
import { install } from '../install';

const { temporary, fixture, copyGate, commit } = createVerificationFixtures();
afterAll(() => rmSync(temporary, { recursive: true, force: true }));
let sequence = 0;

const remoteFor = (root: string): string => {
  const remote = join(temporary, `remote ${sequence++}.git`);
  git(temporary, ['init', '--bare', remote]);
  git(root, ['remote', 'add', 'local-test', remote]);
  return remote;
};
const addContract = (root: string): void => {
  mkdirSync(join(root, 'jurisdictions/contracts'), { recursive: true });
  writeFileSync(join(root, 'jurisdictions/contracts/Probe.sol'), 'contract Probe {}\n');
  commit(root);
};
const report = (root: string) => {
  const directory = join(root, '.git/xln-verification', git(root, ['rev-parse', 'HEAD']).trim());
  const runs = readdirSync(directory);
  expect(runs.length).toBe(1);
  return JSON.parse(readFileSync(join(directory, runs[0]!, 'result.json'), 'utf8'));
};

test.each(['main', 'testnets_deploy'])(
  'the actual hook uses the destination OID for deployment-only updates on %s',
  branch => {
    const root = fixture();
    if (branch !== 'main') git(root, ['checkout', '-b', branch]);
    copyGate(root);
    install(root);
    const remote = remoteFor(root);
    git(root, ['push', 'local-test', branch]);
    const base = git(remote, ['rev-parse', `refs/heads/${branch}`]).trim();
    expect(report(root).profile.reason).toBe('new-remote-branch');
    addContract(root);
    git(root, ['push', 'local-test', `HEAD:refs/heads/${branch}`]);
    const result = report(root);
    expect(result.passed).toBe(true);
    expect(result.profile.name).toBe('deployment');
    expect(result.profile.base).toBe(base);
    expect(result.contracts).toBeNull();
    expect(git(remote, ['rev-parse', `refs/heads/${branch}`]).trim()).toBe(git(root, ['rev-parse', 'HEAD']).trim());
  },
);

test('a failed deployment command blocks the actual push and preserves the remote', () => {
  const root = fixture(undefined, undefined, 'console.error("deployment-red"); process.exit(9);');
  copyGate(root);
  install(root);
  const remote = remoteFor(root);
  git(root, ['push', 'local-test', 'main']);
  const before = git(remote, ['rev-parse', 'refs/heads/main']);
  addContract(root);
  const pushed = Bun.spawnSync(['git', 'push', 'local-test', 'main'], { cwd: root, timeout: 10_000 });
  expect(pushed.exitCode).not.toBe(0);
  expect(pushed.stderr.toString()).toContain('VERIFY_PUSH_REJECTED');
  expect(git(remote, ['rev-parse', 'refs/heads/main'])).toBe(before);
  expect(report(root).problem).toBe('VERIFY_CHECK_FAILED:exitCode=9');
});
