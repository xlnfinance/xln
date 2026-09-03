import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const manifestCache = new Map<string, ReadonlyMap<string, string>>();

function manifestEntries(packageRoot: string): ReadonlyMap<string, string> {
  const cached = manifestCache.get(packageRoot);
  if (cached !== undefined) return cached;
  const entries = new Map<string, string>();
  let manifest: string;
  try {
    manifest = readFileSync(resolve(packageRoot, 'MANIFEST.sha256'), 'utf8');
  } catch {
    throw new Error('BRAINVAULT_MANIFEST_UNAVAILABLE');
  }
  for (const [lineIndex, line] of manifest.trim().split('\n').entries()) {
    const match = line.match(/^([0-9a-f]{64})  (.+)$/);
    if (match === null) throw new Error(`BRAINVAULT_MANIFEST_LINE_INVALID:${lineIndex + 1}`);
    const path = match[2]!;
    const parts = path.split('/');
    if (isAbsolute(path) || path.includes('\\')
      || parts.some(part => part === '' || part === '.' || part === '..')) {
      throw new Error(`BRAINVAULT_MANIFEST_PATH_INVALID:${lineIndex + 1}`);
    }
    if (entries.has(path)) throw new Error(`BRAINVAULT_MANIFEST_PATH_DUPLICATE:${lineIndex + 1}`);
    entries.set(path, match[1]!);
  }
  manifestCache.set(packageRoot, entries);
  return entries;
}

export function verifyBundledFile(file: string, packageRoot: string): string {
  const requestedRoot = resolve(packageRoot);
  const requestedTarget = resolve(file);
  const requestedPath = relative(requestedRoot, requestedTarget).split(sep).join('/');
  if (requestedPath === '' || requestedPath === '..' || requestedPath.startsWith('../')) {
    throw new Error('BRAINVAULT_BINARY_OUTSIDE_PACKAGE');
  }
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(requestedTarget);
  } catch {
    throw new Error('BRAINVAULT_BINARY_UNAVAILABLE');
  }
  if (!stat.isFile()) throw new Error('BRAINVAULT_BINARY_NOT_REGULAR');

  let root: string;
  let target: string;
  try {
    root = realpathSync(requestedRoot);
    target = realpathSync(requestedTarget);
  } catch {
    throw new Error('BRAINVAULT_BINARY_UNAVAILABLE');
  }
  const actualPath = relative(root, target).split(sep).join('/');
  if (actualPath === '..' || actualPath.startsWith('../')) {
    throw new Error('BRAINVAULT_BINARY_OUTSIDE_PACKAGE');
  }
  if (actualPath !== requestedPath) throw new Error('BRAINVAULT_BINARY_PATH_ALIAS');
  const path = requestedPath;
  const expected = manifestEntries(root).get(path);
  if (expected === undefined) throw new Error('BRAINVAULT_BINARY_UNMANIFESTED');
  if ((stat.mode & 0o022) !== 0) throw new Error('BRAINVAULT_BINARY_WRITABLE_BY_OTHERS');
  let contents: Buffer;
  try {
    contents = readFileSync(target);
  } catch {
    throw new Error('BRAINVAULT_BINARY_UNREADABLE');
  }
  const actual = createHash('sha256').update(contents).digest('hex');
  if (actual !== expected) throw new Error('BRAINVAULT_BINARY_HASH_MISMATCH');
  return target;
}

export function verifyBundledExecutable(executable: string, packageRoot: string): string {
  const target = verifyBundledFile(executable, packageRoot);
  if ((lstatSync(target).mode & 0o111) === 0) throw new Error('BRAINVAULT_BINARY_NOT_EXECUTABLE');
  return target;
}
