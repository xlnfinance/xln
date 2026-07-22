import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { requiresFoundationAttestation } from '../../frontend/src/lib/releases/release-signature.ts';

const decode = (value: Uint8Array): string => new TextDecoder().decode(value).trim();

const git = (root: string, args: string[]): ReturnType<typeof Bun.spawnSync> => Bun.spawnSync(
  ['git', ...args],
  { cwd: root, stdout: 'pipe', stderr: 'pipe' },
);

const originConfigured = (root: string): boolean => {
  const remotes = git(root, ['remote']);
  if (remotes.exitCode !== 0) {
    throw new Error(`RELEASE_REMOTE_STATUS_FAILED:${decode(remotes.stderr)}`);
  }
  return decode(remotes.stdout).split(/\r?\n/).includes('origin');
};

function assertOriginTagUnpublished(root: string, tag: string): void {
  if (!originConfigured(root)) return;

  // A local ref is not authoritative once the repository has an origin. Query it
  // directly and fail closed on transport/auth failures so a release cannot reuse
  // a tag merely because the local clone is stale or shallow.
  const remoteTag = Bun.spawnSync([
    'git',
    'ls-remote',
    '--exit-code',
    '--tags',
    'origin',
    tag,
    `${tag}^{}`,
  ], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (remoteTag.exitCode === 0) throw new Error(`RELEASE_REMOTE_TAG_ALREADY_EXISTS:${tag}`);
  if (remoteTag.exitCode !== 2) {
    throw new Error(`RELEASE_REMOTE_TAG_STATUS_FAILED:${decode(remoteTag.stderr) || `exit=${remoteTag.exitCode}`}`);
  }
}

export function assertReleaseSourcePublished(
  root: string,
  sourceRef = 'refs/heads/main',
): void {
  const remoteCommit = readRemoteSourceCommit(root, sourceRef);

  const localSource = git(root, ['rev-parse', '--verify', 'HEAD']);
  if (localSource.exitCode !== 0) {
    throw new Error(`RELEASE_SOURCE_COMMIT_FAILED:${decode(localSource.stderr)}`);
  }
  const localCommit = decode(localSource.stdout);
  // Equality is deliberately stronger than ancestry: callers use this only when
  // they require the checked-out tree to be the exact authoritative tip.
  if (localCommit !== remoteCommit) {
    throw new Error(`RELEASE_SOURCE_NOT_AT_REMOTE_TIP:head=${localCommit}:origin=${remoteCommit}:ref=${sourceRef}`);
  }
}

const readRemoteSourceCommit = (root: string, sourceRef: string): string => {
  if (!originConfigured(root)) throw new Error('RELEASE_REMOTE_REQUIRED:origin');
  const remoteSource = git(root, ['ls-remote', '--exit-code', '--heads', 'origin', sourceRef]);
  if (remoteSource.exitCode === 2) throw new Error(`RELEASE_REMOTE_SOURCE_REF_MISSING:${sourceRef}`);
  if (remoteSource.exitCode !== 0) {
    throw new Error(`RELEASE_REMOTE_SOURCE_STATUS_FAILED:${decode(remoteSource.stderr) || `exit=${remoteSource.exitCode}`}`);
  }
  const [remoteCommit, remoteRef] = decode(remoteSource.stdout).split(/\s+/);
  if (!/^[0-9a-f]{40,64}$/i.test(remoteCommit || '') || remoteRef !== sourceRef) {
    throw new Error(`RELEASE_REMOTE_SOURCE_INVALID:${sourceRef}`);
  }
  return remoteCommit!;
};

export function assertReleaseSourceContainedInPublishedRef(
  root: string,
  sourceCommit: string,
  sourceRef = 'refs/heads/main',
): void {
  if (!/^[0-9a-f]{40,64}$/i.test(sourceCommit)) {
    throw new Error(`RELEASE_SOURCE_COMMIT_INVALID:${sourceCommit}`);
  }
  const remoteCommit = readRemoteSourceCommit(root, sourceRef);
  const ancestry = git(root, ['merge-base', '--is-ancestor', sourceCommit, remoteCommit]);
  if (ancestry.exitCode === 1) {
    throw new Error(
      `RELEASE_SOURCE_NOT_IN_REMOTE_REF:source=${sourceCommit}:origin=${remoteCommit}:ref=${sourceRef}`,
    );
  }
  if (ancestry.exitCode !== 0) {
    throw new Error(`RELEASE_REMOTE_SOURCE_ANCESTRY_FAILED:${decode(ancestry.stderr) || `exit=${ancestry.exitCode}`}`);
  }
}

export function assertReleaseTagBindsSource(
  root: string,
  version: string,
  sourceCommit: string,
): void {
  if (!/^[0-9a-f]{40,64}$/i.test(sourceCommit)) {
    throw new Error(`RELEASE_SOURCE_COMMIT_INVALID:${sourceCommit}`);
  }
  const tag = `refs/tags/v${version}`;
  const tagType = git(root, ['cat-file', '-t', tag]);
  if (tagType.exitCode !== 0) throw new Error(`RELEASE_TAG_REQUIRED:v${version}`);
  if (decode(tagType.stdout) !== 'tag') throw new Error(`RELEASE_TAG_NOT_ANNOTATED:v${version}`);

  const tagTarget = git(root, ['rev-parse', '--verify', `${tag}^{commit}`]);
  if (tagTarget.exitCode !== 0) {
    throw new Error(`RELEASE_TAG_TARGET_FAILED:${decode(tagTarget.stderr)}`);
  }
  const targetCommit = decode(tagTarget.stdout);
  const ancestry = git(root, ['merge-base', '--is-ancestor', sourceCommit, targetCommit]);
  if (ancestry.exitCode === 1) {
    throw new Error(`RELEASE_TAG_SOURCE_MISMATCH:source=${sourceCommit}:tag=${targetCommit}`);
  }
  if (ancestry.exitCode !== 0) {
    throw new Error(`RELEASE_TAG_ANCESTRY_FAILED:${decode(ancestry.stderr) || `exit=${ancestry.exitCode}`}`);
  }
}

export function assertCleanReleaseSource(root: string): void {
  const result = Bun.spawnSync(['git', 'status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) {
    throw new Error(`RELEASE_SOURCE_STATUS_FAILED:${new TextDecoder().decode(result.stderr).trim()}`);
  }
  const dirtyPaths = new TextDecoder().decode(result.stdout).trim();
  if (dirtyPaths) throw new Error(`RELEASE_SOURCE_DIRTY:\n${dirtyPaths}`);
}

export function assertReleaseVersionMatchesSource(root: string, requestedVersion: string): void {
  const sourceVersion = readFileSync(resolve(root, 'VERSION'), 'utf8').trim();
  if (requestedVersion !== sourceVersion) {
    throw new Error(`RELEASE_VERSION_SOURCE_MISMATCH:requested=${requestedVersion}:source=${sourceVersion}`);
  }
}

export function assertReleaseSigningConfigured(version: string, signingKeys?: string): void {
  if (requiresFoundationAttestation(version) && !signingKeys) {
    throw new Error(`RELEASE_SIGNING_KEYS_REQUIRED:${version}`);
  }
}

export function assertReleaseUnpublished(root: string, version: string, outputPath: string): void {
  if (existsSync(outputPath)) {
    throw new Error(`RELEASE_SNAPSHOT_ALREADY_EXISTS:${version}:${outputPath}`);
  }
  const tag = `refs/tags/v${version}`;
  const result = Bun.spawnSync(['git', 'rev-parse', '--verify', '--quiet', tag], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode === 0) throw new Error(`RELEASE_TAG_ALREADY_EXISTS:v${version}`);
  if (result.exitCode !== 1) {
    throw new Error(`RELEASE_TAG_STATUS_FAILED:${new TextDecoder().decode(result.stderr).trim()}`);
  }
  assertOriginTagUnpublished(root, tag);
}
