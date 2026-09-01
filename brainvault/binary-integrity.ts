import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

let manifestCache: ReadonlyMap<string, string> | undefined;

function manifestEntries(packageRoot: string): ReadonlyMap<string, string> {
  if (manifestCache !== undefined) return manifestCache;
  const entries = new Map<string, string>();
  for (const line of readFileSync(resolve(packageRoot, 'MANIFEST.sha256'), 'utf8').trim().split('\n')) {
    const match = line.match(/^([0-9a-f]{64})  (.+)$/);
    if (match === null) throw new Error(`BRAINVAULT_MANIFEST_LINE_INVALID:${line}`);
    entries.set(match[2]!, match[1]!);
  }
  manifestCache = entries;
  return entries;
}

export function verifyBundledExecutable(executable: string, packageRoot: string): void {
  const root = realpathSync(packageRoot);
  const target = realpathSync(executable);
  const path = relative(root, target).split(sep).join('/');
  if (path.startsWith('../') || path === '..') throw new Error(`BRAINVAULT_BINARY_OUTSIDE_PACKAGE:${path}`);
  const expected = manifestEntries(root).get(path);
  if (expected === undefined) throw new Error(`BRAINVAULT_BINARY_UNMANIFESTED:${path}`);
  const actual = createHash('sha256').update(readFileSync(target)).digest('hex');
  if (actual !== expected) throw new Error(`BRAINVAULT_BINARY_HASH_MISMATCH:${path}:${actual}:${expected}`);
}
