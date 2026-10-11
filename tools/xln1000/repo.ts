/** Read-only access to one git revision. Nothing here writes to the repository. */
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type Repo = Readonly<{ root: string; sha: string; short: string; commitTimeMs: number }>;

type RunOptions = Readonly<{ cwd?: string; okExitCodes?: readonly number[]; timeoutMs?: number }>;

export const run = (command: readonly string[], options: RunOptions = {}): string => {
  const result = Bun.spawnSync([...command], {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: options.timeoutMs ?? 120_000,
  });
  const ok = options.okExitCodes ?? [0];
  if (!ok.includes(result.exitCode ?? -1)) {
    const stderr = result.stderr.toString().slice(0, 400);
    throw new Error(`XLN1000_COMMAND_FAILED ${command.join(' ')} exit=${String(result.exitCode)}: ${stderr}`);
  }
  return result.stdout.toString();
};

const exitCode = (command: readonly string[]): number =>
  Bun.spawnSync([...command], { stdout: 'ignore', stderr: 'ignore' }).exitCode ?? -1;

const git = (repo: Pick<Repo, 'root'>, args: readonly string[], okExitCodes: readonly number[] = [0]): string =>
  run(['git', '-C', repo.root, ...args], { okExitCodes });

export const openRepo = (root: string, rev: string): Repo => {
  const sha = git({ root }, ['rev-parse', '--verify', `${rev}^{commit}`]).trim();
  const commitTimeMs = Number(git({ root }, ['show', '-s', '--format=%ct', sha]).trim()) * 1000;
  return { root, sha, short: sha.slice(0, 9), commitTimeMs };
};

/** File content at the measured SHA, or null when the path does not exist there. */
export const showAt = (repo: Repo, path: string): string | null =>
  exitCode(['git', '-C', repo.root, 'cat-file', '-e', `${repo.sha}:${path}`]) === 0
    ? git(repo, ['show', `${repo.sha}:${path}`])
    : null;

export const readJsonAt = <T>(repo: Repo, path: string): T | null => {
  const text = showAt(repo, path);
  return text === null ? null : (JSON.parse(text) as T);
};

const stripTreePrefix = (repo: Repo, line: string): string =>
  line.startsWith(`${repo.sha}:`) ? line.slice(repo.sha.length + 1) : line;

/** Line count per tracked text file at the SHA (binary files skipped). */
export const lineCounts = (repo: Repo, paths: readonly string[]): Map<string, number> => {
  const counts = new Map<string, number>();
  if (paths.length === 0) return counts;
  for (const line of git(repo, ['grep', '-I', '-c', '', repo.sha, '--', ...paths], [0, 1]).split('\n')) {
    const match = /^(.+):(\d+)$/.exec(stripTreePrefix(repo, line));
    if (match?.[1] && match[2]) counts.set(match[1], Number(match[2]));
  }
  return counts;
};

export const sumLines = (repo: Repo, paths: readonly string[], keep: (path: string) => boolean): number =>
  [...lineCounts(repo, paths)].reduce((sum, [path, lines]) => sum + (keep(path) ? lines : 0), 0);

export const filesContaining = (repo: Repo, needle: string, paths: readonly string[]): string[] =>
  git(repo, ['grep', '-l', '-F', needle, repo.sha, '--', ...paths], [0, 1])
    .split('\n')
    .filter(Boolean)
    .map(line => stripTreePrefix(repo, line))
    .sort();

/** Which of the literal needles occur anywhere under `paths` at the SHA (one git call). */
export const needlesPresent = (repo: Repo, needles: readonly string[], paths: readonly string[]): Set<string> => {
  if (needles.length === 0) return new Set();
  const args = ['grep', '-F', '-o', '-h', ...needles.flatMap(needle => ['-e', needle]), repo.sha, '--', ...paths];
  return new Set(git(repo, args, [0, 1]).split('\n').filter(Boolean));
};

/** Number of regex matches (ERE) at the SHA under the given pathspecs. */
export const countMatches = (repo: Repo, pattern: string, pathspecs: readonly string[]): number =>
  git(repo, ['grep', '-o', '-E', pattern, repo.sha, '--', ...pathspecs], [0, 1])
    .split('\n')
    .filter(Boolean).length;

export const filesMatching = (repo: Repo, pattern: string, pathspecs: readonly string[]): string[] =>
  git(repo, ['grep', '-l', '-E', pattern, repo.sha, '--', ...pathspecs], [0, 1])
    .split('\n')
    .filter(Boolean)
    .map(line => stripTreePrefix(repo, line));

export const listTree = (repo: Repo, path: string): string[] =>
  git(repo, ['ls-tree', '-r', '--name-only', repo.sha, '--', path]).split('\n').filter(Boolean).sort();

export const commitKnown = (repo: Repo, sha: string): boolean =>
  /^[0-9a-f]{7,40}$/.test(sha) && exitCode(['git', '-C', repo.root, 'cat-file', '-e', `${sha}^{commit}`]) === 0;

/** True when `base` is the measured SHA or one of its ancestors (evidence from later or side commits never counts). */
export const isAncestorOrSelf = (repo: Repo, base: string): boolean => {
  const code = exitCode(['git', '-C', repo.root, 'merge-base', '--is-ancestor', base, repo.sha]);
  if (code === 0 || code === 1) return code === 0;
  throw new Error(`XLN1000_ANCESTRY_FAILED ${base}..${repo.sha} exit=${String(code)}`);
};

/** True when any covered path differs between `base` and the measured SHA. */
export const changedSince = (repo: Repo, base: string, paths: readonly string[]): boolean => {
  const code = exitCode(['git', '-C', repo.root, 'diff', '--quiet', base, repo.sha, '--', ...paths]);
  if (code === 0 || code === 1) return code === 1;
  throw new Error(`XLN1000_DIFF_FAILED ${base}..${repo.sha} exit=${String(code)}`);
};

/** Last commit at or before the SHA that touched `path`: the binding of evidence without its own SHA field. */
export const lastTouch = (repo: Repo, path: string): string | null =>
  git(repo, ['log', '-1', '--format=%H', repo.sha, '--', path]).trim() || null;

export const dirtyPaths = (root: string, paths: readonly string[]): string[] =>
  git({ root }, ['status', '--porcelain', '--', ...paths])
    .split('\n')
    .filter(Boolean);

/** Exports `core/` at the SHA into a content-addressed temp directory (outside the repository). */
export const ensureCoreSnapshot = (repo: Repo): string => {
  const target = join(tmpdir(), `xln1000-core-${repo.sha}`);
  if (existsSync(join(target, 'core'))) return target;
  const staging = `${target}.${String(process.pid)}.partial`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const archive = `${staging}.tar`;
  git(repo, ['archive', '--format=tar', '-o', archive, repo.sha, 'core']);
  run(['tar', '-x', '-f', archive, '-C', staging]);
  rmSync(archive, { force: true });
  if (existsSync(join(target, 'core'))) {
    rmSync(staging, { recursive: true, force: true });
    return target;
  }
  rmSync(target, { recursive: true, force: true });
  renameSync(staging, target);
  return target;
};
