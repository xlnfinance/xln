import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { safeStringify } from '../../core/protocol/serialization';
import { git } from './git';
import { validateUpdates } from './pre-push';
import { verify } from './verify';

const temporary = mkdtempSync(join(tmpdir(), 'xln-verification-scope-'));
let sequence = 0;
const write = (root: string, path: string, value: string): void => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), value);
};
const fixture = (branch: string): string => {
  const root = join(temporary, String(sequence++));
  mkdirSync(root);
  git(root, ['init', '-b', branch]);
  git(root, ['config', 'user.name', 'Verification Test']);
  git(root, ['config', 'user.email', 'verification@example.invalid']);
  write(
    root,
    'package.json',
    safeStringify({ scripts: { check: 'bun check.ts', 'test:contracts:full': 'bun check.ts' } }),
  );
  write(root, 'check.ts', 'console.log("scope check ran");');
  for (const path of ['brainvault/package.json', 'core/fixture.ts', '.githooks/pre-push', 'input.txt']) {
    write(root, path, 'committed\n');
  }
  git(root, ['add', '.']);
  git(root, ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'verification scope fixture']);
  return root;
};
afterAll(() => rmSync(temporary, { recursive: true, force: true }));

test.each(['main', 'testnets_deploy'])(
  'checks XLN on %s while preserving independent BrainVault work',
  async branch => {
    const root = fixture(branch);
    write(root, 'brainvault/package.json', 'staged owner edit\n');
    git(root, ['add', 'brainvault/package.json']);
    write(root, 'brainvault/package.json', 'unstaged owner edit\n');
    write(root, 'brainvault/new.txt', 'untracked owner edit\n');
    const indexBefore = git(root, ['ls-files', '--stage', '-z']);
    const result = await verify(root);
    expect(result.passed).toBe(true);
    expect(result.before.tracked).toEqual(['brainvault/package.json']);
    expect(result.before.untracked).toEqual(['brainvault/new.txt']);
    expect(result.after).toEqual(result.before);
    expect(git(root, ['ls-files', '--stage', '-z'])).toBe(indexBefore);
    expect(readFileSync(join(root, 'brainvault/package.json'), 'utf8')).toBe('unstaged owner edit\n');
    expect(readFileSync(join(root, 'brainvault/new.txt'), 'utf8')).toBe('untracked owner edit\n');
    expect(readFileSync(result.logPath, 'utf8')).toContain('scope check ran');
  },
);

test.each(['core/fixture.ts', '.githooks/pre-push', 'input.txt'])(
  'still rejects dirty XLN or unclassified source: %s',
  async path => {
    const root = fixture('main');
    write(root, 'brainvault/package.json', 'independent edit\n');
    write(root, path, 'XLN edit\n');
    const result = await verify(root);
    expect(result.passed).toBe(false);
    expect(result.problem).toBe('VERIFY_DIRTY_SOURCE:tracked=1:untracked=0');
    expect(result.command.result).toBeNull();
    expect(result.before.tracked).toContain(path);
  },
);

test.each([
  ['core/fixture.ts', 'brainvault/fixture.ts', 'core/fixture.ts'],
  ['brainvault/package.json', 'core/package.json', 'core/package.json'],
])('rejects a staged rename across the release boundary: %s -> %s', async (from, to, xlnPath) => {
  const root = fixture('main');
  git(root, ['mv', from, to]);
  const result = await verify(root);
  expect(result.passed).toBe(false);
  expect(result.problem).toBe('VERIFY_DIRTY_SOURCE:tracked=1:untracked=0');
  expect(result.before.tracked).toContain(xlnPath);
  expect(result.command.result).toBeNull();
});

test.each(['main', 'testnets_deploy'])('independent work on %s cannot hide tracked index flags', async branch => {
  const root = fixture(branch);
  git(root, ['update-index', '--assume-unchanged', 'brainvault/package.json']);
  write(root, 'brainvault/package.json', 'hidden owner edit\n');
  const result = await verify(root);
  expect(result.problem).toBe('VERIFY_HIDDEN_INDEX_PATHS:count=1');
  expect(result.command.result).toBeNull();
  expect(result.before.hiddenTracked).toEqual(['brainvault/package.json']);
});

test.each(['main', 'testnets_deploy'])('requires branch-matched exact HEAD updates on %s', branch => {
  const head = '1'.repeat(40);
  const zero = '0'.repeat(40);
  const ref = `refs/heads/${branch}`;
  const other = `refs/heads/${branch === 'main' ? 'testnets_deploy' : 'main'}`;
  const update = (local: string, remote: string): string => `${local} ${head} ${remote} ${zero}\n`;
  expect(validateUpdates(update(ref, ref), head, branch)).toBe(true);
  expect(validateUpdates(update('HEAD', ref), head, branch)).toBe(true);
  expect(validateUpdates(`(delete) ${zero} refs/heads/retired ${head}\n`, head, branch)).toBe(false);
  for (const [local, remote] of [
    [ref, other],
    [other, ref],
    ['HEAD', other],
    ['refs/tags/v1', ref],
    [ref, 'refs/tags/v1'],
    ['refs/heads/task', 'refs/heads/task'],
  ] as const) {
    expect(() => validateUpdates(update(local, remote), head, branch)).toThrow('VERIFY_PUSH_REQUIRES_CURRENT_BRANCH');
  }
  expect(() => validateUpdates(update(ref, ref) + update('HEAD', other), head, branch)).toThrow(
    'VERIFY_PUSH_REQUIRES_CURRENT_BRANCH',
  );
  expect(() => validateUpdates(`${ref} ${'2'.repeat(40)} ${ref} ${zero}\n`, head, branch)).toThrow(
    'VERIFY_PUSH_REQUIRES_EXACT_HEAD',
  );
});

test.each(['HEAD', 'task'])('rejects a push from unapproved branch %s', branch => {
  const head = '1'.repeat(40);
  expect(() => validateUpdates(`HEAD ${head} refs/heads/main ${'0'.repeat(40)}\n`, head, branch)).toThrow(
    'VERIFY_PUSH_REQUIRES_CURRENT_BRANCH',
  );
});

test.each(['HEAD', 'task'])('rejects unapproved branch %s without running checks', async branch => {
  const root = fixture('main');
  git(root, ['checkout', ...(branch === 'HEAD' ? ['--detach'] : ['-b', branch])]);
  const result = await verify(root);
  expect(result.passed).toBe(false);
  expect(result.problem).toBe(`VERIFY_BRANCH_NOT_ALLOWED:branch=${branch}`);
  expect(result.command.result).toBeNull();
});
