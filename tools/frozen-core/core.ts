import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, posix, resolve, sep } from 'node:path';

import type {
  FrozenCoreManifest,
  FrozenCoreSnapshot,
  FrozenFileBaseline,
  FrozenFileState,
  FrozenTreeNode,
} from './types.ts';

const LEAF_DOMAIN = Buffer.from('xln:frozen-core:leaf:v1\0');
const DIRECTORY_DOMAIN = Buffer.from('xln:frozen-core:directory:v1\0');
const IMPORT_PATTERN = /(?:import|export)\s+(?:[^'";]*?\sfrom\s*)?['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)|import\(\s*['"]([^'"]+)['"]\s*\)/g;
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.svelte'];

function sha256(...parts: Array<string | Buffer>): string {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return `0x${hash.digest('hex')}`;
}

function rawHash(buffer: Buffer): string {
  return sha256(buffer);
}

function assertSafePath(root: string, path: string): string {
  if (!path || path.startsWith('/') || path.includes('\\')) throw new Error(`FROZEN_CORE_INVALID_PATH:${path}`);
  const absolute = resolve(root, path);
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) throw new Error(`FROZEN_CORE_PATH_ESCAPE:${path}`);
  return absolute;
}

function fileMode(absolute: string): FrozenFileBaseline['mode'] {
  return (statSync(absolute).mode & 0o111) !== 0 ? '100755' : '100644';
}

export function hashFrozenFile(root: string, path: string): Pick<FrozenFileBaseline, 'path' | 'mode' | 'contentHash' | 'leafHash'> {
  const absolute = assertSafePath(root, path);
  if (!existsSync(absolute)) throw new Error(`FROZEN_CORE_FILE_MISSING:${path}`);
  if (lstatSync(absolute).isSymbolicLink()) throw new Error(`FROZEN_CORE_SYMLINK_FORBIDDEN:${path}`);
  if (!lstatSync(absolute).isFile()) throw new Error(`FROZEN_CORE_NOT_FILE:${path}`);
  const mode = fileMode(absolute);
  const contentHash = rawHash(readFileSync(absolute));
  const leafHash = sha256(LEAF_DOMAIN, path, '\0', mode, '\0', Buffer.from(contentHash.slice(2), 'hex'));
  return { path, mode, contentHash, leafHash };
}

function hashDirectory(path: string, children: FrozenTreeNode[]): string {
  const sorted = [...children].sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  const parts: Array<string | Buffer> = [DIRECTORY_DOMAIN, path, '\0'];
  for (const child of sorted) parts.push(child.kind === 'directory' ? 'D\0' : 'F\0', child.name, '\0', Buffer.from(child.hash.slice(2), 'hex'));
  return sha256(...parts);
}

export function buildFrozenTree(files: Array<Pick<FrozenFileBaseline, 'path' | 'leafHash'>>): FrozenTreeNode {
  const root: FrozenTreeNode = { kind: 'directory', name: 'xln', path: '', hash: '', children: [] };
  for (const file of [...files].sort((left, right) => left.path < right.path ? -1 : 1)) {
    const parts = file.path.split('/');
    let parent = root;
    for (const part of parts.slice(0, -1)) {
      const path = parent.path ? `${parent.path}/${part}` : part;
      let directory = parent.children?.find((child) => child.kind === 'directory' && child.name === part);
      if (!directory) {
        directory = { kind: 'directory', name: part, path, hash: '', children: [] };
        parent.children?.push(directory);
      }
      parent = directory;
    }
    parent.children?.push({ kind: 'file', name: parts.at(-1)!, path: file.path, hash: file.leafHash });
  }
  const finalize = (node: FrozenTreeNode): string => {
    if (node.kind === 'file') return node.hash;
    for (const child of node.children ?? []) finalize(child);
    node.children?.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    node.hash = hashDirectory(node.path, node.children ?? []);
    return node.hash;
  };
  finalize(root);
  return root;
}

function resolveImport(source: string, specifier: string, root: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = posix.normalize(posix.join(posix.dirname(source), specifier));
  const candidates = [base, ...SOURCE_EXTENSIONS.map((extension) => `${base}${extension}`), ...SOURCE_EXTENSIONS.map((extension) => `${base}/index${extension}`)];
  return candidates.find((candidate) => existsSync(assertSafePath(root, candidate)) && lstatSync(assertSafePath(root, candidate)).isFile()) ?? null;
}

function mutableDependencies(root: string, source: string, frozenPaths: Set<string>): string[] {
  const text = readFileSync(assertSafePath(root, source), 'utf8');
  const resolved = [...text.matchAll(IMPORT_PATTERN)]
    .map((match) => match[1] || match[2] || match[3])
    .filter(Boolean)
    .map((specifier) => resolveImport(source, specifier!, root))
    .filter((path): path is string => Boolean(path) && !frozenPaths.has(path!));
  return [...new Set(resolved)].sort();
}

export function readFrozenManifest(path: string): FrozenCoreManifest {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as FrozenCoreManifest;
  if (parsed.schemaVersion !== 1 || parsed.algorithm !== 'sha256' || !Array.isArray(parsed.files)) {
    throw new Error(`FROZEN_CORE_MANIFEST_INVALID:${path}`);
  }
  const paths = parsed.files.map((file) => file.path);
  if (new Set(paths).size !== paths.length) throw new Error('FROZEN_CORE_DUPLICATE_PATH');
  return parsed;
}

export function collectFrozenCore(root: string, manifest: FrozenCoreManifest, release: string): FrozenCoreSnapshot {
  const frozenPaths = new Set(manifest.files.map((file) => file.path));
  const files: FrozenFileState[] = manifest.files.map((expected) => {
    const current = hashFrozenFile(root, expected.path);
    const approval = [...manifest.approvals].reverse().find((entry) => entry.path === expected.path && entry.release === release && entry.newLeafHash === current.leafHash);
    const changed = current.contentHash !== expected.contentHash || current.leafHash !== expected.leafHash || current.mode !== expected.mode;
    return {
      ...expected,
      ...current,
      expectedContentHash: expected.contentHash,
      expectedLeafHash: expected.leafHash,
      status: changed ? 'MODIFIED' : approval ? 'APPROVED CHANGE' : 'UNCHANGED',
      approvalComment: approval?.comment ?? null,
      mutableDependencies: mutableDependencies(root, expected.path, frozenPaths),
    };
  });
  const modified = files.filter((file) => file.status === 'MODIFIED');
  if (modified[0]) {
    const details = modified.map((file) => `${file.path}\n  expected ${file.expectedContentHash}\n  actual   ${file.contentHash}`).join('\n');
    throw new Error(`FROZEN_CORE_VIOLATION\n${details}\nApproval required: bun run frozen-core:approve`);
  }
  const tree = buildFrozenTree(files);
  if (tree.hash !== manifest.rootHash) throw new Error(`FROZEN_CORE_ROOT_MISMATCH expected=${manifest.rootHash} actual=${tree.hash}`);
  const dependencies = files.flatMap((file) => file.mutableDependencies.map((dependency) => ({ source: file.path, dependency })));
  return {
    schemaVersion: 1,
    algorithm: 'sha256',
    status: files.some((file) => file.status === 'APPROVED CHANGE') ? 'APPROVED CHANGE' : 'UNCHANGED',
    rootHash: tree.hash,
    expectedRootHash: manifest.rootHash,
    files,
    tree,
    mutableDependencies: dependencies,
  };
}

export function createFrozenManifest(root: string, paths: string[], release: string, reason: string): FrozenCoreManifest {
  const files = paths.map((path) => ({ ...hashFrozenFile(root, path), frozenAtRelease: release, reason }));
  return { schemaVersion: 1, algorithm: 'sha256', rootHash: buildFrozenTree(files).hash, files, approvals: [] };
}

export function renderFrozenTree(snapshot: FrozenCoreSnapshot): string {
  const lines = [
    `xln / FROZEN CORE / ${snapshot.status}`,
    `root ${snapshot.rootHash}`,
    '',
    `[D] ${snapshot.tree.name}/  ${snapshot.tree.hash}`,
  ];
  const renderChildren = (node: FrozenTreeNode, prefix: string) => {
    const children = node.children ?? [];
    children.forEach((child, index) => {
      const last = index === children.length - 1;
      const marker = child.kind === 'directory' ? '[D]' : '[F]';
      lines.push(`${prefix}${last ? '`-- ' : '|-- '}${marker} ${child.name}${child.kind === 'directory' ? '/' : ''}  ${child.hash}`);
      if (child.kind === 'directory') renderChildren(child, `${prefix}${last ? '    ' : '|   '}`);
    });
  };
  renderChildren(snapshot.tree, '');
  if (snapshot.mutableDependencies.length) lines.push('', `dependency boundary: ${snapshot.mutableDependencies.length} mutable imports (warning)`);
  return lines.join('\n');
}
