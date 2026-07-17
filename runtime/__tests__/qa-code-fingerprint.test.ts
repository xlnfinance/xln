import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  REPOSITORY_STATUS_PREVIEW_MAX_CHARS,
  assertRepositoryCodeFingerprintStable,
  computeRepositoryCodeFingerprint,
  createRepositoryCodeDriftGuard,
} from '../qa/code-fingerprint';

const temporaryRoots: string[] = [];
const fingerprintCli = join(import.meta.dir, '..', 'qa', 'code-fingerprint-cli.ts');

const runGit = (root: string, args: readonly string[]): string => {
  const result = Bun.spawnSync(['git', ...args], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) {
    throw new Error(`TEST_GIT_FAILED:${args[0]}:${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString().trim();
};

const createRepository = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'xln-code-fingerprint-'));
  temporaryRoots.push(root);
  runGit(root, ['init', '--quiet', '--initial-branch=main']);
  runGit(root, ['config', 'user.email', 'qa@example.invalid']);
  runGit(root, ['config', 'user.name', 'xln qa']);
  writeFileSync(join(root, 'tracked.txt'), 'tracked-v1\n');
  runGit(root, ['add', '--', 'tracked.txt']);
  runGit(root, ['commit', '--quiet', '-m', 'fixture']);
  return root;
};

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('repository code fingerprint', () => {
  test('deterministically fingerprints HEAD, branch, status, tracked and untracked bytes', () => {
    const root = createRepository();
    const dangerousName = 'literal;$(touch injected).txt';
    writeFileSync(join(root, dangerousName), 'untracked-v1\n');

    const first = computeRepositoryCodeFingerprint({ root });
    const second = computeRepositoryCodeFingerprint({ root });

    expect(second).toEqual(first);
    expect(first).toMatchObject({
      schemaVersion: 1,
      gitBranch: 'main',
      dirty: true,
      gitStatusEntryCount: 1,
      gitStatusTruncated: false,
      sourceFileCount: 2,
      sourceBytes: Buffer.byteLength('tracked-v1\nuntracked-v1\n'),
      missingFileCount: 0,
    });
    expect(first.gitHead).toMatch(/^[0-9a-f]{40}$/);
    expect(first.gitStatus).toContain(dangerousName);
    expect(first.gitStatusHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.snapshotHash).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(join(root, 'injected'))).toBe(false);
  });

  test('detects same-status, same-size byte drift and latches the first failure', () => {
    const root = createRepository();
    const path = join(root, 'untracked.txt');
    writeFileSync(path, 'alpha');
    const start = computeRepositoryCodeFingerprint({ root });

    writeFileSync(path, 'omega');
    const end = computeRepositoryCodeFingerprint({ root });
    expect(end.gitStatusHash).toBe(start.gitStatusHash);
    expect(end.sourceBytes).toBe(start.sourceBytes);
    expect(end.codeHash).not.toBe(start.codeHash);
    expect(() => assertRepositoryCodeFingerprintStable(start, end)).toThrow(
      `QA_CODE_DRIFT:changed=content:start=${start.snapshotHash}:end=${end.snapshotHash}`,
    );

    let now = 0;
    let current = start;
    let reads = 0;
    const guard = createRepositoryCodeDriftGuard({
      expected: start,
      minIntervalMs: 1_000,
      now: () => now,
      compute: () => {
        reads += 1;
        return current;
      },
    });
    guard.assertStable();
    current = end;
    now = 1_001;
    expect(() => guard.assertStable()).toThrow('QA_CODE_DRIFT:changed=content');
    current = start;
    expect(() => guard.assertStable(true)).toThrow('QA_CODE_DRIFT:changed=content');
    expect(reads).toBe(2);
  });

  test('bounds status output without weakening its exact status hash', () => {
    const root = createRepository();
    for (let index = 0; index < 48; index += 1) {
      writeFileSync(join(root, `untracked-${String(index).padStart(2, '0')}-${'x'.repeat(180)}.txt`), 'x');
    }

    const fingerprint = computeRepositoryCodeFingerprint({ root });
    expect(fingerprint.gitStatusEntryCount).toBe(48);
    expect(fingerprint.gitStatusTruncated).toBe(true);
    expect(fingerprint.gitStatus.length).toBeLessThanOrEqual(REPOSITORY_STATUS_PREVIEW_MAX_CHARS);
    expect(fingerprint.gitStatusHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('CLI snapshots a repository and guard rejects byte drift during a command', () => {
    const root = createRepository();
    const snapshot = Bun.spawnSync(['bun', fingerprintCli, 'snapshot'], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(snapshot.exitCode).toBe(0);
    expect(JSON.parse(snapshot.stdout.toString())).toMatchObject({
      schemaVersion: 1,
      gitBranch: 'main',
      dirty: false,
    });

    const guarded = Bun.spawnSync([
      'bun',
      fingerprintCli,
      'guard',
      '--',
      'bun',
      '-e',
      'await Bun.write("drift.txt", "changed\\n")',
    ], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(guarded.exitCode).toBe(2);
    expect(guarded.stderr.toString()).toContain('QA_CODE_DRIFT:changed=status,content');
  });
});
