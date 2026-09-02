import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import { compareStableText } from '../../core/protocol/serialization';

export type RegularTreeFile = Readonly<{
  path: string;
  sha256: string;
  size: number;
  mode: number;
}>;

const hashBytes = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const portablePath = (pathname: string): string => pathname.split(sep).join('/');

export const snapshotRegularTree = async (
  root: string,
  current = root,
  errorPrefix = 'REGULAR_TREE',
): Promise<readonly RegularTreeFile[]> => {
  const stats = await lstat(current);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`${errorPrefix}_DIRECTORY_INVALID:${portablePath(relative(root, current))}`);
  }
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort(({ name: left }, { name: right }) => compareStableText(left, right));
  const files: RegularTreeFile[] = [];
  for (const entry of entries) {
    const pathname = join(current, entry.name);
    const path = portablePath(relative(root, pathname));
    if (entry.isSymbolicLink()) throw new Error(`${errorPrefix}_SYMLINK:${path}`);
    if (entry.isDirectory()) files.push(...await snapshotRegularTree(root, pathname, errorPrefix));
    else if (entry.isFile()) {
      const [bytes, fileStats] = await Promise.all([readFile(pathname), lstat(pathname)]);
      files.push({ path, sha256: hashBytes(bytes), size: bytes.byteLength, mode: fileStats.mode & 0o777 });
    } else throw new Error(`${errorPrefix}_FILE_TYPE_INVALID:${path}`);
  }
  return files.sort(({ path: left }, { path: right }) => compareStableText(left, right));
};
