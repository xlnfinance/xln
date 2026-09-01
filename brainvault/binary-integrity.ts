import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

const manifestCache = new Map<string, ReadonlyMap<string, string>>();

function manifestEntries(packageRoot: string): ReadonlyMap<string, string> {
  const cached = manifestCache.get(packageRoot);
  if (cached !== undefined) return cached;
  const entries = new Map<string, string>();
  for (const line of readFileSync(resolve(packageRoot, 'MANIFEST.sha256'), 'utf8').trim().split('\n')) {
    const match = line.match(/^([0-9a-f]{64})  (.+)$/);
    if (match === null) throw new Error(`BRAINVAULT_MANIFEST_LINE_INVALID:${line}`);
    entries.set(match[2]!, match[1]!);
  }
  manifestCache.set(packageRoot, entries);
  return entries;
}

export function verifyBundledExecutable(executable: string, packageRoot: string): string {
  const root = realpathSync(packageRoot);
  const target = realpathSync(executable);
  const path = relative(root, target).split(sep).join('/');
  if (path.startsWith('../') || path === '..') throw new Error(`BRAINVAULT_BINARY_OUTSIDE_PACKAGE:${path}`);
  const expected = manifestEntries(root).get(path);
  if (expected === undefined) throw new Error(`BRAINVAULT_BINARY_UNMANIFESTED:${path}`);
  const stat = lstatSync(target);
  if (!stat.isFile()) throw new Error(`BRAINVAULT_BINARY_NOT_REGULAR:${path}`);
  if ((stat.mode & 0o022) !== 0) throw new Error(`BRAINVAULT_BINARY_WRITABLE_BY_OTHERS:${path}`);
  const actual = createHash('sha256').update(readFileSync(target)).digest('hex');
  if (actual !== expected) throw new Error(`BRAINVAULT_BINARY_HASH_MISMATCH:${path}:${actual}:${expected}`);
  return target;
}
