/** K: kernel size and clarity, measured on the transitive value-import closure of the declared kernel roots. */
import type { FileInfo } from '../ast';
import { clamp01, gap, linScore, logScore, round, sortedEntries, weightedSum, type Axis } from '../model';
import { sumLines, type Repo } from '../repo';

const KERNEL_ROOTS = [
  'core/account/',
  'core/entity/',
  'core/protocol/',
  'core/hanko/',
  'core/paybook/',
  'core/swapbook/',
  'core/lendbook/',
  'core/types/',
  'core/extensions/',
  'core/pathfinding/',
  'core/jurisdiction/machine/',
  'core/storage/codec/',
  ...[
    'frame',
    'admit',
    'mempool',
    'tx',
    'decode',
    'envelope',
    'swap-cmd',
    'replica',
    'command',
    'config',
    'j-submit',
    'registration',
    'delivery',
    'observability',
  ].map(directory => `core/runtime/${directory}/`),
];
const TOOLING_DIRS = [
  'core/qa/',
  'core/rscore/',
  'core/scripts/',
  'core/scenarios/',
  'core/orchestrator/',
  'core/api/',
];
const PURE_SUPPORT = ['core/support/', 'core/config/', 'core/types/'];
const WEIGHTS = { size: 0.35, long: 0.25, types: 0.15, isolation: 0.25 };
const LONG_FUNCTION_LINES = 40;

type Info = ReadonlyMap<string, FileInfo>;
type Edge = Readonly<{ from: string; to: string }>;

const inKernel = (path: string): boolean => KERNEL_ROOTS.some(root => path.startsWith(root));
const topDir = (path: string): string => path.split('/').slice(0, 2).join('/');
const fileOf = (info: Info, path: string): FileInfo => {
  const file = info.get(path);
  if (!file) throw new Error(`XLN1000_KERNEL_FILE_MISSING ${path}`);
  return file;
};

const closureOf = (info: Info, roots: readonly string[]): Set<string> => {
  const closure = new Set(roots);
  const queue = [...roots];
  for (let path = queue.pop(); path !== undefined; path = queue.pop()) {
    for (const dependency of fileOf(info, path).valueImports) {
      if (closure.has(dependency) || !info.has(dependency)) continue;
      closure.add(dependency);
      queue.push(dependency);
    }
  }
  return closure;
};

const sumCode = (info: Info, files: Iterable<string>): number =>
  [...files].reduce((sum, path) => sum + fileOf(info, path).codeLines, 0);

const countBy = <T>(items: Iterable<T>, key: (item: T) => string, amount: (item: T) => number): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + amount(item));
  return counts;
};

const outEdges = (info: Info, declared: readonly string[]): Edge[] =>
  declared.flatMap(from =>
    fileOf(info, from)
      .valueImports.filter(to => !inKernel(to))
      .map(to => ({ from, to })),
  );

const closureStats = (info: Info, closure: ReadonlySet<string>) => {
  const files = [...closure].sort().map(path => fileOf(info, path));
  const functions = files.flatMap(file => file.functions.map(fn => ({ ...fn, at: `${file.path}:${String(fn.line)}` })));
  const longest = functions.reduce((best, fn) => (fn.codeLines > best.codeLines ? fn : best), {
    codeLines: 0,
    at: '',
    name: '',
  });
  const excess = functions.reduce(
    (sum, fn) => sum + (fn.outer ? Math.max(0, fn.codeLines - LONG_FUNCTION_LINES) : 0),
    0,
  );
  const packages = new Set(files.flatMap(file => file.packages).filter(name => !/^(node:|bun)/.test(name)));
  return {
    functions: functions.length,
    over60: functions.filter(fn => fn.codeLines > 60).length,
    excess,
    longest: { codeLines: longest.codeLines, at: `${longest.at} ${longest.name}` },
    casts: files.reduce((sum, file) => sum + file.casts, 0),
    nonNull: files.reduce((sum, file) => sum + file.nonNull, 0),
    packages: [...packages].sort(),
  };
};

type Edges = Readonly<{ all: readonly Edge[]; tooling: readonly Edge[]; infra: readonly Edge[] }>;

const classifyEdges = (info: Info, declared: readonly string[]): Edges => {
  const all = outEdges(info, declared);
  return {
    all,
    tooling: all.filter(edge => TOOLING_DIRS.some(directory => edge.to.startsWith(directory))),
    infra: all.filter(edge => !PURE_SUPPORT.some(directory => edge.to.startsWith(directory))),
  };
};

const kernelGaps = (sub: Record<keyof typeof WEIGHTS, number>, excess: number, edges: Edges) => [
  gap('K', 'shrink the kernel closure toward 50k code lines', 100 * WEIGHTS.size * (1 - sub.size)),
  gap('K', `cut long-function excess (${String(excess)} lines)`, 100 * WEIGHTS.long * (1 - sub.long)),
  gap('K', 'cut casts and non-null assertions in the closure', 100 * WEIGHTS.types * (1 - sub.types)),
  gap(
    'K',
    `remove kernel imports of infrastructure (${String(edges.infra.length)}) and tooling (${String(edges.tooling.length)})`,
    100 * WEIGHTS.isolation * (1 - sub.isolation),
  ),
];

const kernelRaw = (
  repo: Repo,
  info: Info,
  declared: readonly string[],
  closure: ReadonlySet<string>,
  edges: Edges,
) => ({
  declaredKernelLoc: sumCode(info, declared),
  closureKernelLoc: sumCode(info, closure),
  declaredFiles: declared.length,
  closureFiles: closure.size,
  closureByTop: sortedEntries(countBy(closure, topDir, path => fileOf(info, path).codeLines)),
  edgesOutOfKernel: edges.all.length,
  infraEdges: edges.infra.length,
  toolingEdges: edges.tooling.length,
  edgeTargets: sortedEntries(
    countBy(
      edges.all,
      edge => topDir(edge.to),
      () => 1,
    ),
  ),
  toolingEdgeSample: edges.tooling.slice(0, 12),
  solidityLoc: sumLines(
    repo,
    ['jurisdictions/contracts'],
    path => path.endsWith('.sol') && !/\/(mocks?|test)\//.test(path),
  ),
});

export type KernelResult = Readonly<{ axis: Axis; closureLoc: number }>;

export const measureKernel = (repo: Repo, info: Info): KernelResult => {
  const declared = [...info.keys()].filter(inKernel);
  const closure = closureOf(info, declared);
  const closureLoc = sumCode(info, closure);
  const stats = closureStats(info, closure);
  const edges = classifyEdges(info, declared);
  const excessRatio = stats.excess / closureLoc;
  const typeDebtPerK = (stats.casts + stats.nonNull) / (closureLoc / 1000);
  const sub = {
    size: logScore(closureLoc, 50_000, 200_000),
    long: clamp01(1 - excessRatio / 0.2),
    types: linScore(typeDebtPerK, 1, 15),
    isolation: 0.5 * clamp01(1 - edges.infra.length / 100) + 0.5 * clamp01(1 - edges.tooling.length / 20),
  };
  const score = 100 * weightedSum(sub, WEIGHTS);
  const raw = {
    ...kernelRaw(repo, info, declared, closure, edges),
    ...stats,
    excessRatio: round(excessRatio, 3),
    typeDebtPerK: round(typeDebtPerK, 2),
  };
  const gaps = kernelGaps(sub, stats.excess, edges);
  return {
    axis: { id: 'K', name: 'Kernel size and clarity', weight: 100, score, ceiling: score, sub, gaps, vetoes: [], raw },
    closureLoc,
  };
};
