import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertCleanReleaseSource,
  assertReleaseSourcePublished,
  assertReleaseTagBindsSource,
  assertReleaseUnpublished,
  assertReleaseSigningConfigured,
  assertReleaseVersionMatchesSource,
} from '../../tools/release-snapshot/source-policy.ts';

function run(root: string, args: string[]): void {
  const result = Bun.spawnSync(args, { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
}

describe('release source policy', () => {
  test('rejects dirty or untracked source while accepting an exact commit', () => {
    const root = mkdtempSync(join(tmpdir(), 'xln-release-source-'));
    try {
      run(root, ['git', 'init', '--quiet']);
      writeFileSync(join(root, 'source.ts'), 'export const value = 1;\n');
      run(root, ['git', 'add', 'source.ts']);
      run(root, ['git', '-c', 'user.name=xln test', '-c', 'user.email=xln@example.test', 'commit', '--quiet', '-m', 'fixture']);
      expect(() => assertCleanReleaseSource(root)).not.toThrow();

      writeFileSync(join(root, 'source.ts'), 'export const value = 2;\n');
      expect(() => assertCleanReleaseSource(root)).toThrow('RELEASE_SOURCE_DIRTY');
      run(root, ['git', 'checkout', '--quiet', '--', 'source.ts']);
      writeFileSync(join(root, 'untracked.ts'), 'export {};\n');
      expect(() => assertCleanReleaseSource(root)).toThrow('RELEASE_SOURCE_DIRTY');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('requires canonical Hanko v1 signing from 0.1.9 onward', () => {
    expect(() => assertReleaseSigningConfigured('0.1.6')).not.toThrow();
    expect(() => assertReleaseSigningConfigured('0.1.8')).not.toThrow();
    expect(() => assertReleaseSigningConfigured('0.1.9')).toThrow('RELEASE_SIGNING_KEYS_REQUIRED');
    expect(() => assertReleaseSigningConfigured('0.1.9', '/secure/keys.json')).not.toThrow();
  });

  test('rejects a release label that does not match the committed source version', () => {
    const root = mkdtempSync(join(tmpdir(), 'xln-release-version-'));
    try {
      writeFileSync(join(root, 'VERSION'), '0.1.7\n');
      expect(() => assertReleaseVersionMatchesSource(root, '0.1.7')).not.toThrow();
      expect(() => assertReleaseVersionMatchesSource(root, '9.9.9'))
        .toThrow('RELEASE_VERSION_SOURCE_MISMATCH:requested=9.9.9:source=0.1.7');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('never overwrites an existing snapshot or reissues an existing release tag', () => {
    const root = mkdtempSync(join(tmpdir(), 'xln-release-immutable-'));
    const output = join(root, 'docs', 'releases', 'data', '0.1.8.json');
    try {
      run(root, ['git', 'init', '--quiet']);
      writeFileSync(join(root, 'VERSION'), '0.1.8\n');
      run(root, ['git', 'add', 'VERSION']);
      run(root, ['git', '-c', 'user.name=xln test', '-c', 'user.email=xln@example.test', 'commit', '--quiet', '-m', 'release source']);
      expect(() => assertReleaseUnpublished(root, '0.1.8', output)).not.toThrow();

      mkdirSync(join(root, 'docs', 'releases', 'data'), { recursive: true });
      writeFileSync(output, '{}\n');
      expect(() => assertReleaseUnpublished(root, '0.1.8', output))
        .toThrow('RELEASE_SNAPSHOT_ALREADY_EXISTS:0.1.8');
      rmSync(output);

      run(root, ['git', 'tag', 'v0.1.8']);
      expect(() => assertReleaseUnpublished(root, '0.1.8', output))
        .toThrow('RELEASE_TAG_ALREADY_EXISTS:v0.1.8');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects a tag that exists only on the origin bare remote', () => {
    const root = mkdtempSync(join(tmpdir(), 'xln-release-origin-'));
    const remote = mkdtempSync(join(tmpdir(), 'xln-release-remote-'));
    const output = join(root, 'docs', 'releases', 'data', '0.1.8.json');
    try {
      run(remote, ['git', 'init', '--quiet', '--bare']);
      run(root, ['git', 'init', '--quiet']);
      writeFileSync(join(root, 'VERSION'), '0.1.8\n');
      run(root, ['git', 'add', 'VERSION']);
      run(root, ['git', '-c', 'user.name=xln test', '-c', 'user.email=xln@example.test', 'commit', '--quiet', '-m', 'release source']);
      run(root, ['git', 'remote', 'add', 'origin', remote]);

      expect(() => assertReleaseUnpublished(root, '0.1.8', output)).not.toThrow();
      run(root, ['git', 'tag', 'v0.1.8']);
      run(root, ['git', 'push', '--quiet', 'origin', 'refs/tags/v0.1.8']);
      run(root, ['git', 'tag', '--delete', 'v0.1.8']);

      expect(() => assertReleaseUnpublished(root, '0.1.8', output))
        .toThrow('RELEASE_REMOTE_TAG_ALREADY_EXISTS:refs/tags/v0.1.8');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(remote, { recursive: true, force: true });
    }
  });

  test('fails closed when a configured origin cannot be queried', () => {
    const root = mkdtempSync(join(tmpdir(), 'xln-release-offline-origin-'));
    const output = join(root, 'docs', 'releases', 'data', '0.1.8.json');
    try {
      run(root, ['git', 'init', '--quiet']);
      writeFileSync(join(root, 'VERSION'), '0.1.8\n');
      run(root, ['git', 'add', 'VERSION']);
      run(root, ['git', '-c', 'user.name=xln test', '-c', 'user.email=xln@example.test', 'commit', '--quiet', '-m', 'release source']);
      run(root, ['git', 'remote', 'add', 'origin', join(root, 'missing.git')]);

      expect(() => assertReleaseUnpublished(root, '0.1.8', output))
        .toThrow('RELEASE_REMOTE_TAG_STATUS_FAILED');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('requires the exact release source to be published at the authoritative main tip', () => {
    const root = mkdtempSync(join(tmpdir(), 'xln-release-published-source-'));
    const remote = mkdtempSync(join(tmpdir(), 'xln-release-published-remote-'));
    try {
      run(remote, ['git', 'init', '--quiet', '--bare']);
      run(root, ['git', 'init', '--quiet', '-b', 'main']);
      writeFileSync(join(root, 'VERSION'), '0.1.8\n');
      run(root, ['git', 'add', 'VERSION']);
      run(root, ['git', '-c', 'user.name=xln test', '-c', 'user.email=xln@example.test', 'commit', '--quiet', '-m', 'published source']);
      run(root, ['git', 'remote', 'add', 'origin', remote]);

      expect(() => assertReleaseSourcePublished(root)).toThrow('RELEASE_REMOTE_SOURCE_REF_MISSING');
      run(root, ['git', 'push', '--quiet', '-u', 'origin', 'main']);
      expect(() => assertReleaseSourcePublished(root)).not.toThrow();

      writeFileSync(join(root, 'VERSION'), '0.1.9\n');
      run(root, ['git', 'add', 'VERSION']);
      run(root, ['git', '-c', 'user.name=xln test', '-c', 'user.email=xln@example.test', 'commit', '--quiet', '-m', 'unpublished source']);
      expect(() => assertReleaseSourcePublished(root)).toThrow('RELEASE_SOURCE_NOT_AT_REMOTE_TIP');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(remote, { recursive: true, force: true });
    }
  });

  test('requires an annotated release tag whose target descends from the signed source', () => {
    const root = mkdtempSync(join(tmpdir(), 'xln-release-tag-binding-'));
    try {
      run(root, ['git', 'init', '--quiet', '-b', 'main']);
      writeFileSync(join(root, 'VERSION'), '0.1.8\n');
      run(root, ['git', 'add', 'VERSION']);
      run(root, ['git', '-c', 'user.name=xln test', '-c', 'user.email=xln@example.test', 'commit', '--quiet', '-m', 'signed source']);
      const sourceCommit = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: root, stdout: 'pipe' });
      const source = new TextDecoder().decode(sourceCommit.stdout).trim();

      writeFileSync(join(root, 'release.txt'), 'attestation\n');
      run(root, ['git', 'add', 'release.txt']);
      run(root, ['git', '-c', 'user.name=xln test', '-c', 'user.email=xln@example.test', 'commit', '--quiet', '-m', 'release artifact']);
      run(root, ['git', '-c', 'user.name=xln test', '-c', 'user.email=xln@example.test', 'tag', '-a', 'v0.1.8', '-m', 'release']);
      expect(() => assertReleaseTagBindsSource(root, '0.1.8', source)).not.toThrow();

      run(root, ['git', 'tag', '-d', 'v0.1.8']);
      run(root, ['git', 'tag', 'v0.1.8']);
      expect(() => assertReleaseTagBindsSource(root, '0.1.8', source)).toThrow('RELEASE_TAG_NOT_ANNOTATED');

      run(root, ['git', 'tag', '-d', 'v0.1.8']);
      run(root, ['git', 'checkout', '--quiet', '--orphan', 'unrelated']);
      run(root, ['git', 'rm', '--quiet', '-rf', '.']);
      writeFileSync(join(root, 'unrelated.txt'), 'unrelated\n');
      run(root, ['git', 'add', 'unrelated.txt']);
      run(root, ['git', '-c', 'user.name=xln test', '-c', 'user.email=xln@example.test', 'commit', '--quiet', '-m', 'unrelated history']);
      run(root, ['git', '-c', 'user.name=xln test', '-c', 'user.email=xln@example.test', 'tag', '-a', 'v0.1.8', '-m', 'wrong release']);
      expect(() => assertReleaseTagBindsSource(root, '0.1.8', source)).toThrow('RELEASE_TAG_SOURCE_MISMATCH');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
