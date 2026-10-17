import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../verification/git';

const temporary = mkdtempSync(join(tmpdir(), 'xln-remote-checkout-'));
const script = join(import.meta.dir, 'prepare-remote-main.sh');
let sequence = 0;
afterAll(() => rmSync(temporary, { recursive: true, force: true }));

const commit = (root: string, name: string): string => {
  git(root, ['add', '.']);
  git(root, ['-c', 'commit.gpgsign=false', 'commit', '-qm', name]);
  return git(root, ['rev-parse', 'HEAD']).trim();
};

const fixture = () => {
  const root = join(temporary, String(sequence++));
  mkdirSync(root);
  git(root, ['init', '--bare', '--initial-branch=main', 'origin.git']);
  const origin = join(root, 'origin.git');
  git(root, ['clone', origin, 'seed']);
  const seed = join(root, 'seed');
  git(seed, ['config', 'user.name', 'Checkout Regression']);
  git(seed, ['config', 'user.email', 'checkout@example.invalid']);
  writeFileSync(join(seed, '.gitignore'), 'operator.env\n');
  writeFileSync(join(seed, 'owner.txt'), 'committed source\n');
  const before = commit(seed, 'base');
  git(seed, ['push', 'origin', 'main']);
  git(root, ['clone', origin, 'remote']);
  const remote = join(root, 'remote');
  writeFileSync(join(seed, 'current.txt'), 'current canonical source\n');
  const target = commit(seed, 'current');
  git(seed, ['push', 'origin', 'main']);
  return { seed, remote, origin, before, target };
};

const prepare = (root: string, target: string) =>
  Bun.spawnSync(['bash', script], {
    cwd: root,
    env: { ...process.env, EXPECTED_DEPLOY_SHA: target },
    stdout: 'pipe',
    stderr: 'pipe',
  });

test('fast-forwards clean main to the exact published SHA and preserves ignored operator data and origin', () => {
  const f = fixture();
  writeFileSync(join(f.remote, 'operator.env'), 'private operator configuration\n');
  expect(prepare(f.remote, f.target).exitCode).toBe(0);
  expect(git(f.remote, ['rev-parse', 'HEAD']).trim()).toBe(f.target);
  expect(git(f.remote, ['symbolic-ref', '--short', 'HEAD']).trim()).toBe('main');
  expect(git(f.remote, ['remote', 'get-url', 'origin']).trim()).toBe(f.origin);
  expect(readFileSync(join(f.remote, 'operator.env'), 'utf8')).toBe('private operator configuration\n');
  expect(readFileSync(join(f.remote, 'current.txt'), 'utf8')).toBe('current canonical source\n');
  expect(prepare(f.remote, f.target).exitCode).toBe(0);
});

test('rejects dirty tracked and untracked owner source without changing any bytes or HEAD', () => {
  const f = fixture();
  writeFileSync(join(f.remote, 'owner.txt'), 'uncommitted owner edit\n');
  writeFileSync(join(f.remote, 'owner file $keep.txt'), 'untracked owner source\n');
  const result = prepare(f.remote, f.target);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain('REMOTE_DEPLOY_DIRTY_SOURCE');
  expect(readFileSync(join(f.remote, 'owner.txt'), 'utf8')).toBe('uncommitted owner edit\n');
  expect(readFileSync(join(f.remote, 'owner file $keep.txt'), 'utf8')).toBe('untracked owner source\n');
  expect(git(f.remote, ['rev-parse', 'HEAD']).trim()).toBe(f.before);
  expect(existsSync(join(f.remote, 'current.txt'))).toBe(false);
});

for (const flag of ['--assume-unchanged', '--skip-worktree']) {
  test(`rejects ${flag} without clearing the flag or overwriting hidden edits`, () => {
    const f = fixture();
    git(f.remote, ['update-index', flag, 'owner.txt']);
    writeFileSync(join(f.remote, 'owner.txt'), 'hidden owner edit\n');
    const indexBefore = git(f.remote, ['ls-files', '-v']);
    expect(git(f.remote, ['diff', '--name-only'])).toBe('');
    const result = prepare(f.remote, f.target);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain('REMOTE_DEPLOY_HIDDEN_INDEX_PATHS');
    expect(readFileSync(join(f.remote, 'owner.txt'), 'utf8')).toBe('hidden owner edit\n');
    expect(git(f.remote, ['ls-files', '-v'])).toBe(indexBefore);
    expect(git(f.remote, ['rev-parse', 'HEAD']).trim()).toBe(f.before);
  });
}

test('refuses a newly tracked path that collides with ignored operator data', () => {
  const f = fixture();
  writeFileSync(join(f.remote, 'operator.env'), 'private operator configuration\n');
  writeFileSync(join(f.seed, 'operator.env'), 'new tracked file\n');
  git(f.seed, ['add', '-f', 'operator.env']);
  const target = commit(f.seed, 'tracked collision');
  git(f.seed, ['push', 'origin', 'main']);
  expect(prepare(f.remote, target).exitCode).not.toBe(0);
  expect(readFileSync(join(f.remote, 'operator.env'), 'utf8')).toBe('private operator configuration\n');
  expect(git(f.remote, ['rev-parse', 'HEAD']).trim()).toBe(f.before);
});

test('preserves a divergent local main commit instead of rewriting it', () => {
  const f = fixture();
  git(f.remote, ['config', 'user.name', 'Checkout Regression']);
  git(f.remote, ['config', 'user.email', 'checkout@example.invalid']);
  writeFileSync(join(f.remote, 'local.txt'), 'local owner source\n');
  const local = commit(f.remote, 'local owner work');
  const result = prepare(f.remote, f.target);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain('REMOTE_DEPLOY_NON_FAST_FORWARD');
  expect(git(f.remote, ['rev-parse', 'HEAD']).trim()).toBe(local);
  expect(readFileSync(join(f.remote, 'local.txt'), 'utf8')).toBe('local owner source\n');
});

test('rejects detached HEAD without switching or creating a branch', () => {
  const f = fixture();
  git(f.remote, ['checkout', '--detach']);
  const result = prepare(f.remote, f.target);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain('REMOTE_DEPLOY_REQUIRES_MAIN');
  expect(git(f.remote, ['rev-parse', 'HEAD']).trim()).toBe(f.before);
  expect(git(f.remote, ['branch', '--list']).includes('* (HEAD detached')).toBe(true);
});
