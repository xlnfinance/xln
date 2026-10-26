import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { git } from './git';
import { verify } from './verify';

const temporary = mkdtempSync(join(tmpdir(), 'xln-verification-scope-'));
let sequence = 0;
const write = (root: string, path: string, value: string): void => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), value);
};
const fixture = (): string => {
  const root = join(temporary, String(sequence++));
  mkdirSync(root);
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'Verification Test']);
  git(root, ['config', 'user.email', 'verification@example.invalid']);
  write(
    root,
    'package.json',
    JSON.stringify({ scripts: { check: 'bun check.ts', 'test:contracts:full': 'bun check.ts' } }),
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

test('checks XLN while preserving staged, unstaged and untracked independent BrainVault work', async () => {
  const root = fixture();
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
});

test.each(['core/fixture.ts', '.githooks/pre-push', 'input.txt'])(
  'still rejects dirty XLN or unclassified source: %s',
  async path => {
    const root = fixture();
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
  const root = fixture();
  git(root, ['mv', from, to]);
  const result = await verify(root);
  expect(result.passed).toBe(false);
  expect(result.problem).toBe('VERIFY_DIRTY_SOURCE:tracked=1:untracked=0');
  expect(result.before.tracked).toContain(xlnPath);
  expect(result.command.result).toBeNull();
});

test('independent work cannot hide tracked index flags', async () => {
  const root = fixture();
  git(root, ['update-index', '--assume-unchanged', 'brainvault/package.json']);
  write(root, 'brainvault/package.json', 'hidden owner edit\n');
  const result = await verify(root);
  expect(result.problem).toBe('VERIFY_HIDDEN_INDEX_PATHS:count=1');
  expect(result.command.result).toBeNull();
  expect(result.before.hiddenTracked).toEqual(['brainvault/package.json']);
});
