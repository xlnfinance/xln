import { spawnSync } from 'node:child_process';
import { createHash, type Hash } from 'node:crypto';
import {
  closeSync,
  lstatSync,
  openSync,
  readlinkSync,
  readSync,
  type BigIntStats,
} from 'node:fs';
import { resolve } from 'node:path';

import { sanitizeChildProcessEnv } from '../server/child-process-env';

const FINGERPRINT_DOMAIN = 'xln.repository-code-fingerprint.v1';
const STATUS_PREVIEW_ENTRY_LIMIT = 16;
const STATUS_PREVIEW_PATH_CHARS = 192;
const FILE_READ_BUFFER_BYTES = 64 * 1024;
export const REPOSITORY_STATUS_PREVIEW_MAX_CHARS = 4_096;

export type RepositoryCodeFingerprint = Readonly<{
  schemaVersion: 1;
  gitHead: string;
  gitBranch: string;
  gitStatus: string;
  gitStatusHash: string;
  gitStatusEntryCount: number;
  gitStatusTruncated: boolean;
  dirty: boolean;
  codeHash: string;
  snapshotHash: string;
  sourceFileCount: number;
  sourceBytes: number;
  missingFileCount: number;
}>;

type FingerprintedFiles = Readonly<{
  codeHash: string;
  sourceFileCount: number;
  sourceBytes: number;
  missingFileCount: number;
}>;

type StatusSummary = Readonly<{
  hash: string;
  text: string;
  entryCount: number;
  truncated: boolean;
}>;

const boundedDetail = (value: Buffer | string): string =>
  String(value).replace(/\s+/g, ' ').trim().slice(0, 256);

const runGit = (root: string, args: readonly string[]): Buffer => {
  const result = spawnSync('git', args, {
    cwd: root,
    env: sanitizeChildProcessEnv(process.env),
    stdio: 'pipe',
    encoding: 'buffer',
    shell: false,
  });
  if (result.status === 0) return Buffer.from(result.stdout);
  throw new Error(
    `QA_CODE_FINGERPRINT_GIT_FAILED:command=${args[0]}:exit=${String(result.status)}:detail=${boundedDetail(result.stderr)}`,
  );
};

const splitNullTerminated = (value: Buffer, label: string): Buffer[] => {
  if (value.length === 0) return [];
  if (value[value.length - 1] !== 0) throw new Error(`QA_CODE_FINGERPRINT_${label}_NOT_NULL_TERMINATED`);
  const parts: Buffer[] = [];
  let start = 0;
  for (let cursor = 0; cursor < value.length; cursor += 1) {
    if (value[cursor] !== 0) continue;
    parts.push(value.subarray(start, cursor));
    start = cursor + 1;
  }
  return parts;
};

const boundedPath = (path: Buffer): { text: string; truncated: boolean } => {
  const quoted = JSON.stringify(path.toString('utf8'));
  if (quoted.length <= STATUS_PREVIEW_PATH_CHARS) return { text: quoted, truncated: false };
  return {
    text: `${quoted.slice(0, STATUS_PREVIEW_PATH_CHARS - 4)}..."`,
    truncated: true,
  };
};

const readStatusEntries = (raw: Buffer): Array<{ text: string; pathTruncated: boolean }> => {
  const records = splitNullTerminated(raw, 'STATUS');
  const entries: Array<{ text: string; pathTruncated: boolean }> = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (record.length < 4 || record[2] !== 32) throw new Error('QA_CODE_FINGERPRINT_STATUS_RECORD_INVALID');
    const code = record.subarray(0, 2).toString('ascii');
    const path = boundedPath(record.subarray(3));
    const renamed = code.includes('R') || code.includes('C');
    const origin = renamed ? records[++index] : undefined;
    if (renamed && !origin) throw new Error('QA_CODE_FINGERPRINT_STATUS_RENAME_ORIGIN_MISSING');
    const originPath = origin ? boundedPath(origin) : null;
    entries.push({
      text: originPath ? `${code} ${path.text} <- ${originPath.text}` : `${code} ${path.text}`,
      pathTruncated: path.truncated || Boolean(originPath?.truncated),
    });
  }
  return entries;
};

const summarizeStatus = (raw: Buffer): StatusSummary => {
  const entries = readStatusEntries(raw);
  const visible = entries.slice(0, STATUS_PREVIEW_ENTRY_LIMIT);
  const omitted = entries.length - visible.length;
  const suffix = omitted > 0 ? `\n... +${omitted} entries` : '';
  const text = `${visible.map((entry) => entry.text).join('\n')}${suffix}`;
  if (text.length > REPOSITORY_STATUS_PREVIEW_MAX_CHARS) {
    throw new Error('QA_CODE_FINGERPRINT_STATUS_PREVIEW_BOUND_BROKEN');
  }
  return {
    hash: createHash('sha256').update(raw).digest('hex'),
    text,
    entryCount: entries.length,
    truncated: omitted > 0 || entries.some((entry) => entry.pathTruncated),
  };
};

const updateLength = (hash: Hash, length: bigint): void => {
  if (length < 0n || length > 0xffff_ffff_ffff_ffffn) {
    throw new Error(`QA_CODE_FINGERPRINT_LENGTH_UNSUPPORTED:${String(length)}`);
  }
  const encoded = Buffer.allocUnsafe(8);
  encoded.writeBigUInt64BE(length);
  hash.update(encoded);
};

const updateValue = (hash: Hash, value: Buffer | string): void => {
  const encoded = typeof value === 'string' ? Buffer.from(value) : value;
  updateLength(hash, BigInt(encoded.length));
  hash.update(encoded);
};

const sameFileRevision = (left: BigIntStats, right: BigIntStats): boolean =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.size === right.size &&
  left.mtimeNs === right.mtimeNs &&
  left.ctimeNs === right.ctimeNs;

const hashRegularFile = (hash: Hash, path: Buffer, stats: BigIntStats): number => {
  hash.update('F');
  updateLength(hash, stats.size);
  const fd = openSync(path, 'r');
  const buffer = Buffer.allocUnsafe(FILE_READ_BUFFER_BYTES);
  let bytesReadTotal = 0;
  try {
    for (;;) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      bytesReadTotal += bytesRead;
    }
  } finally {
    closeSync(fd);
  }
  const after = lstatSync(path, { bigint: true });
  if (BigInt(bytesReadTotal) !== stats.size || !sameFileRevision(stats, after)) {
    throw new Error(`QA_CODE_FINGERPRINT_FILE_DRIFT:${boundedPath(path).text}`);
  }
  return bytesReadTotal;
};

const hashPath = (hash: Hash, root: string, relativePath: Buffer): { bytes: number; missing: boolean } => {
  if (relativePath.length === 0 || relativePath[0] === 47) throw new Error('QA_CODE_FINGERPRINT_PATH_INVALID');
  const segments = relativePath.toString('utf8').split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`QA_CODE_FINGERPRINT_PATH_INVALID:${boundedPath(relativePath).text}`);
  }
  updateValue(hash, relativePath);
  const absolutePath = Buffer.concat([Buffer.from(`${root}/`), relativePath]);
  let stats: BigIntStats;
  try {
    stats = lstatSync(absolutePath, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    hash.update('M');
    return { bytes: 0, missing: true };
  }
  if (stats.isFile()) return { bytes: hashRegularFile(hash, absolutePath, stats), missing: false };
  if (stats.isSymbolicLink()) {
    const target = readlinkSync(absolutePath, { encoding: 'buffer' });
    const after = lstatSync(absolutePath, { bigint: true });
    if (!sameFileRevision(stats, after)) {
      throw new Error(`QA_CODE_FINGERPRINT_FILE_DRIFT:${boundedPath(relativePath).text}`);
    }
    hash.update('L');
    updateValue(hash, target);
    return { bytes: target.length, missing: false };
  }
  throw new Error(`QA_CODE_FINGERPRINT_FILE_TYPE_UNSUPPORTED:${boundedPath(relativePath).text}`);
};

const fingerprintFiles = (root: string, rawFiles: Buffer): FingerprintedFiles => {
  const files = splitNullTerminated(rawFiles, 'FILE_LIST').sort(Buffer.compare);
  const hash = createHash('sha256');
  updateValue(hash, FINGERPRINT_DOMAIN);
  let sourceBytes = 0;
  let missingFileCount = 0;
  for (const file of files) {
    const result = hashPath(hash, root, file);
    sourceBytes += result.bytes;
    if (!Number.isSafeInteger(sourceBytes)) throw new Error('QA_CODE_FINGERPRINT_BYTE_COUNT_UNSAFE');
    if (result.missing) missingFileCount += 1;
  }
  return {
    codeHash: hash.digest('hex'),
    sourceFileCount: files.length,
    sourceBytes,
    missingFileCount,
  };
};

const computeSnapshotHash = (values: readonly string[]): string => {
  const hash = createHash('sha256');
  updateValue(hash, FINGERPRINT_DOMAIN);
  for (const value of values) updateValue(hash, value);
  return hash.digest('hex');
};

export const computeRepositoryCodeFingerprint = (
  options: Readonly<{ root?: string }> = {},
): RepositoryCodeFingerprint => {
  const requestedRoot = resolve(options.root ?? process.cwd());
  const root = runGit(requestedRoot, ['rev-parse', '--show-toplevel']).toString('utf8').trim();
  const gitHead = runGit(root, ['rev-parse', '--verify', 'HEAD']).toString('utf8').trim();
  const gitBranch = runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD']).toString('utf8').trim();
  const status = summarizeStatus(runGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']));
  const files = fingerprintFiles(
    root,
    runGit(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']),
  );
  const snapshotHash = computeSnapshotHash([gitHead, gitBranch, status.hash, files.codeHash]);
  return {
    schemaVersion: 1,
    gitHead,
    gitBranch,
    gitStatus: status.text,
    gitStatusHash: status.hash,
    gitStatusEntryCount: status.entryCount,
    gitStatusTruncated: status.truncated,
    dirty: status.entryCount > 0,
    ...files,
    snapshotHash,
  };
};

export const assertRepositoryCodeFingerprintStable = (
  expected: RepositoryCodeFingerprint,
  actual: RepositoryCodeFingerprint,
): void => {
  if (expected.snapshotHash === actual.snapshotHash) return;
  const changed: string[] = [];
  if (expected.gitHead !== actual.gitHead) changed.push('head');
  if (expected.gitBranch !== actual.gitBranch) changed.push('branch');
  if (expected.gitStatusHash !== actual.gitStatusHash) changed.push('status');
  if (expected.codeHash !== actual.codeHash) changed.push('content');
  throw new Error(
    `QA_CODE_DRIFT:changed=${changed.join(',') || 'snapshot'}:start=${expected.snapshotHash}:end=${actual.snapshotHash}`,
  );
};

export type RepositoryCodeDriftGuard = Readonly<{
  assertStable: (force?: boolean) => void;
}>;

export const createRepositoryCodeDriftGuard = (options: Readonly<{
  expected: RepositoryCodeFingerprint;
  compute: () => RepositoryCodeFingerprint;
  minIntervalMs?: number;
  now?: () => number;
}>): RepositoryCodeDriftGuard => {
  const minIntervalMs = Math.max(0, options.minIntervalMs ?? 5_000);
  const now = options.now ?? Date.now;
  let lastCheckAt: number | null = null;
  let failure: Error | null = null;
  return {
    assertStable(force = false): void {
      if (failure) throw failure;
      const checkedAt = now();
      if (!force && lastCheckAt !== null && checkedAt - lastCheckAt < minIntervalMs) return;
      lastCheckAt = checkedAt;
      try {
        assertRepositoryCodeFingerprintStable(options.expected, options.compute());
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
        throw failure;
      }
    },
  };
};
