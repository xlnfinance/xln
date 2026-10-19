import { resolve } from 'node:path';
import { isXlnReleasePath } from '../../tools/release-snapshot/scope';

export const git = (cwd: string, args: readonly string[]): string => {
  const child = Bun.spawnSync(['git', ...args], { cwd, timeout: 5_000, stdout: 'pipe', stderr: 'pipe' });
  if (child.exitCode !== 0) throw new Error(`VERIFY_GIT_FAILED:${args.join(' ')}:${child.stderr.toString().trim()}`);
  return child.stdout.toString();
};

const paths = (value: string): string[] => value.split('\0').filter(Boolean);

export const repository = (cwd: string): Readonly<{ root: string; commonDir: string }> => {
  const root = git(cwd, ['rev-parse', '--show-toplevel']).trim();
  return { root, commonDir: resolve(root, git(root, ['rev-parse', '--git-common-dir']).trim()) };
};

export const sourceState = (root: string) => ({
  head: git(root, ['rev-parse', 'HEAD']).trim(),
  tree: git(root, ['rev-parse', 'HEAD^{tree}']).trim(),
  branch: git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(),
  tracked: [
    ...new Set([
      ...paths(git(root, ['diff', '--no-renames', '--name-only', '-z', '--ignore-submodules=none'])),
      ...paths(git(root, ['diff', '--cached', '--no-renames', '--name-only', '-z', '--ignore-submodules=none'])),
    ]),
  ].sort(),
  untracked: paths(git(root, ['ls-files', '--others', '--exclude-standard', '-z'])).sort(),
  hiddenTracked: paths(git(root, ['ls-files', '-v', '-z']))
    .filter(line => line[0] === 'S' || /^[a-z]/u.test(line))
    .map(line => line.slice(2))
    .sort(),
});

export type SourceState = ReturnType<typeof sourceState>;

// Only the explicitly independent BrainVault tree is outside this gate. Unknown
// paths still reject; --no-renames preserves both sides of moves across the boundary.
const requiresCleanSource = (path: string): boolean => !path.startsWith('brainvault/') || isXlnReleasePath(path);

export const sourceProblem = (state: SourceState): string | null => {
  if (state.branch !== 'main') return `VERIFY_REQUIRES_MAIN:branch=${state.branch}`;
  if (state.hiddenTracked.length) return `VERIFY_HIDDEN_INDEX_PATHS:count=${state.hiddenTracked.length}`;
  const tracked = state.tracked.filter(requiresCleanSource);
  const untracked = state.untracked.filter(requiresCleanSource);
  if (tracked.length || untracked.length) {
    return `VERIFY_DIRTY_SOURCE:tracked=${tracked.length}:untracked=${untracked.length}`;
  }
  return null;
};
