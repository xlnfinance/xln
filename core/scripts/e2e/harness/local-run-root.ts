import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

const RUN_ROOT_MARKER = '.xln-owned-run-root';

const isInside = (parent: string, target: string): boolean => {
  const child = relative(resolve(parent), resolve(target));
  return child !== '' && !child.startsWith('..') && !isAbsolute(child);
};

const assertSafeRunRoot = (target: string, repoRoot: string): void => {
  const forbiddenRoots = [resolve(repoRoot), resolve(homedir()), resolve(tmpdir())];
  if (forbiddenRoots.includes(target)) throw new Error(`LOCAL_RUN_ROOT_TOO_BROAD:${target}`);
  const devRoots = [join(repoRoot, 'db', 'dev'), join(repoRoot, '.logs', 'dev')];
  if (devRoots.some(root => target === resolve(root) || isInside(root, target))) {
    throw new Error(`LOCAL_RUN_ROOT_OVERLAPS_DEV:${target}`);
  }
};

const markerValue = (kind: string): string => `xln-owned-run-root:${kind}\n`;

export const resetOwnedLocalRunRoot = (
  path: string,
  repoRoot: string,
  kind: string,
): string => {
  const target = resolve(path);
  assertSafeRunRoot(target, repoRoot);
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
    throw new Error(`LOCAL_RUN_ROOT_SYMLINK_FORBIDDEN:${target}`);
  }
  const marker = join(target, RUN_ROOT_MARKER);
  if (existsSync(target) && readdirSync(target).length > 0) {
    const actual = existsSync(marker) ? readFileSync(marker, 'utf8') : '';
    if (actual !== markerValue(kind)) {
      throw new Error(`LOCAL_RUN_ROOT_NOT_OWNED:${target}`);
    }
    rmSync(target, { recursive: true, force: true });
  }
  mkdirSync(target, { recursive: true, mode: 0o700 });
  writeFileSync(marker, markerValue(kind), { mode: 0o600 });
  return target;
};
