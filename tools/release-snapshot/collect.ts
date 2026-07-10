import { createHash } from 'node:crypto';
import { extname, posix, relative, resolve } from 'node:path';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';

import type {
  AggregateMetrics,
  ExcludedFile,
  FileCategory,
  FileSnapshot,
  MetricDelta,
  RawMetrics,
  ReleaseSnapshot,
  TreeNode,
} from './types.ts';

type SccFile = {
  Language?: string;
  Location?: string;
  Filename?: string;
  Lines?: number;
  Code?: number;
  Comment?: number;
  Blank?: number;
  Complexity?: number;
  Generated?: boolean;
};

type SccOutput = { languageSummary?: Array<{ Files?: SccFile[] }> };

const ROOT_ORDER = ['runtime', 'jurisdictions', 'frontend', 'docs', 'tools', 'tests', 'native', 'custody', 'scripts'];
const GENERATED_PREFIXES = [
  'jurisdictions/artifacts/',
  'jurisdictions/cache/',
  'jurisdictions/typechain-types/',
  'frontend/static/contracts/',
  'frontend/static/docs-catalog/',
  'frontend/.svelte-kit/',
  'frontend/build/',
  'node_modules/',
  '.logs/',
  'coverage/',
  'dist/',
  'build/',
];
const GENERATED_FILES = new Set([
  'bun.lock',
  'frontend/static/runtime.js',
  'frontend/src/lib/generated/version.ts',
]);
const RELEASE_ARTIFACT_PREFIX = 'docs/releases/';
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.svelte', '.sol', '.md', '.css', '.html', '.sh']);
const ZERO_RAW = (): RawMetrics => ({
  bytes: 0, lines: 0, code: 0, comments: 0, blanks: 0, complexity: 0,
  imports: 0, exports: 0, dependencies: 0, dependents: 0, todos: 0, fixmes: 0,
  hacks: 0, consoleCalls: 0, dynamicImports: 0, anyUsages: 0, tsIgnores: 0,
});

function run(command: string[], cwd: string): string {
  const result = Bun.spawnSync(command, { cwd, stdout: 'pipe', stderr: 'pipe' });
  const stdout = new TextDecoder().decode(result.stdout || new Uint8Array());
  const stderr = new TextDecoder().decode(result.stderr || new Uint8Array());
  if (result.exitCode !== 0) throw new Error(`${command.join(' ')} failed\n${stderr || stdout}`);
  return stdout;
}

function listRepositoryFiles(root: string): string[] {
  return run(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], root)
    .split('\0')
    .filter((path) => path.length > 0)
    .sort();
}

function exclusion(path: string): ExcludedFile['reason'] | null {
  if (path.startsWith(RELEASE_ARTIFACT_PREFIX)) return 'release-artifact';
  if (GENERATED_FILES.has(path) || GENERATED_PREFIXES.some((prefix) => path.startsWith(prefix))) return 'generated';
  if (path.startsWith('.archive/') || path.startsWith('vendor/')) return 'vendor';
  return null;
}

function classify(path: string): FileCategory {
  const lower = path.toLowerCase();
  if (/(^|\/)(__tests__|tests?|e2e)(\/|$)|\.(test|spec)\.[^.]+$/.test(lower)) return 'test';
  if (lower.startsWith('jurisdictions/') && lower.endsWith('.sol')) return 'contract';
  if (lower.startsWith('docs/') || lower.endsWith('.md')) return 'docs';
  if (/\.(png|jpe?g|gif|webp|svg|ico|woff2?|ttf|mp4|webm|wasm)$/.test(lower)) return 'asset';
  if (/(^|\/)(package|tsconfig|vite\.config|svelte\.config|playwright\.config)|\.(json|ya?ml|toml)$/.test(lower)) return 'config';
  return 'source';
}

function collectScc(root: string, paths: string[]): { version: string; files: Map<string, SccFile> } {
  const version = run(['scc', '--version'], root).trim();
  const files = new Map<string, SccFile>();
  const candidates = paths.filter((path) =>
    lstatSync(resolve(root, path)).isFile() && SOURCE_EXTENSIONS.has(extname(path).toLowerCase()));
  for (let offset = 0; offset < candidates.length; offset += 200) {
    const chunk = candidates.slice(offset, offset + 200);
    const parsed = JSON.parse(run(['scc', '--by-file', '--gen', '-f', 'json2', '--no-cocomo', ...chunk], root)) as SccOutput;
    for (const language of parsed.languageSummary ?? []) {
      for (const file of language.Files ?? []) {
        const location = String(file.Location || file.Filename || '').replace(/\\/g, '/').replace(/^\.\//, '');
        if (location) files.set(location, file);
      }
    }
  }
  return { version, files };
}

function readText(buffer: Buffer): string {
  if (buffer.includes(0)) return '';
  return buffer.toString('utf8');
}

function countMatches(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

function dependencySpecifiers(text: string): string[] {
  const pattern = /(?:import|export)\s+(?:[^'";]*?\sfrom\s*)?['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)|import\(\s*['"]([^'"]+)['"]\s*\)/g;
  return [...text.matchAll(pattern)].map((match) => match[1] || match[2] || match[3]).filter(Boolean) as string[];
}

function resolveDependency(from: string, specifier: string, paths: Set<string>): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = posix.normalize(posix.join(posix.dirname(from), specifier));
  const candidates = [base, ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.svelte', '.sol'].map((ext) => `${base}${ext}`)];
  candidates.push(...['.ts', '.tsx', '.js', '.jsx', '.svelte'].map((ext) => `${base}/index${ext}`));
  return candidates.find((candidate) => paths.has(candidate)) ?? null;
}

function metricDelta(current: RawMetrics, previous?: RawMetrics): MetricDelta | null {
  if (!previous) return null;
  return {
    bytes: current.bytes - previous.bytes,
    lines: current.lines - previous.lines,
    code: current.code - previous.code,
    complexity: current.complexity - previous.complexity,
  };
}

function collectFile(root: string, path: string, scc: SccFile | undefined, allPaths: Set<string>, previous?: FileSnapshot): FileSnapshot {
  const absolute = resolve(root, path);
  const entryType = lstatSync(absolute).isSymbolicLink() ? 'symlink' : 'file';
  const buffer = entryType === 'symlink' ? Buffer.from(readlinkSync(absolute)) : readFileSync(absolute);
  const text = buffer.byteLength <= 2_000_000 ? readText(buffer) : '';
  const specifiers = dependencySpecifiers(text);
  const dependencies = [...new Set(specifiers.map((value) => resolveDependency(path, value, allPaths)).filter(Boolean) as string[])].sort();
  const physicalLines = text ? text.split(/\r?\n/).length : 0;
  const metrics: RawMetrics = {
    bytes: buffer.byteLength,
    lines: scc?.Lines ?? physicalLines,
    code: scc?.Code ?? 0,
    comments: scc?.Comment ?? 0,
    blanks: scc?.Blank ?? 0,
    complexity: scc?.Complexity ?? 0,
    imports: specifiers.length,
    exports: countMatches(text, /\bexport\s+(?:default\s+)?(?:const|let|var|function|class|type|interface|enum|\{)/g),
    dependencies: dependencies.length,
    dependents: 0,
    todos: countMatches(text, /\bTODO\b/g),
    fixmes: countMatches(text, /\bFIXME\b/g),
    hacks: countMatches(text, /\bHACK\b/g),
    consoleCalls: countMatches(text, /\bconsole\.(?:log|info|warn|error|debug|trace)\s*\(/g),
    dynamicImports: countMatches(text, /\bimport\s*\(/g),
    anyUsages: countMatches(text, /:\s*any\b|\bas\s+any\b|<any>/g),
    tsIgnores: countMatches(text, /@ts-(?:ignore|nocheck|expect-error)/g),
  };
  return {
    path,
    name: posix.basename(path),
    entryType,
    extension: extname(path).toLowerCase(),
    language: entryType === 'symlink' ? 'Symlink' : scc?.Language || (text ? 'Text' : 'Binary'),
    category: classify(path),
    sha256: createHash('sha256').update(buffer).digest('hex'),
    metrics,
    complexityPerKloc: metrics.code ? Number((metrics.complexity * 1000 / metrics.code).toFixed(2)) : 0,
    dependencies,
    dependents: [],
    testsFor: [],
    testedBy: [],
    delta: metricDelta(metrics, previous?.metrics),
  };
}

function connectFiles(files: FileSnapshot[]): void {
  const byPath = new Map(files.map((file) => [file.path, file]));
  for (const file of files) {
    for (const dependency of file.dependencies) byPath.get(dependency)?.dependents.push(file.path);
  }
  const sourcesByStem = new Map<string, FileSnapshot[]>();
  for (const file of files.filter((candidate) => candidate.category !== 'test')) {
    const stem = file.name.replace(/\.[^.]+$/, '').toLowerCase();
    sourcesByStem.set(stem, [...(sourcesByStem.get(stem) ?? []), file]);
  }
  for (const test of files.filter((candidate) => candidate.category === 'test')) {
    const direct = test.dependencies.filter((path) => byPath.get(path)?.category !== 'test');
    const testStem = test.name.replace(/\.(test|spec)?\.[^.]+$/, '').toLowerCase();
    const inferred = direct.length ? [] : (sourcesByStem.get(testStem) ?? []).map((file) => file.path);
    test.testsFor = [...new Set([...direct, ...inferred])].sort();
    for (const sourcePath of test.testsFor) byPath.get(sourcePath)?.testedBy.push(test.path);
  }
  for (const file of files) {
    file.dependents.sort();
    file.testedBy.sort();
    file.metrics.dependents = file.dependents.length;
  }
}

function aggregate(files: FileSnapshot[], directories: number): AggregateMetrics {
  const raw = files.reduce<RawMetrics>((sum, file) => {
    for (const key of Object.keys(sum) as Array<keyof RawMetrics>) sum[key] += file.metrics[key];
    return sum;
  }, ZERO_RAW());
  const source = files.filter((file) => file.category !== 'test');
  const tests = files.filter((file) => file.category === 'test');
  const sourceCode = source.reduce((sum, file) => sum + file.metrics.code, 0);
  const testCode = tests.reduce((sum, file) => sum + file.metrics.code, 0);
  return {
    ...raw,
    files: files.length,
    directories,
    sourceFiles: source.length,
    testFiles: tests.length,
    sourceCode,
    testCode,
    untestedSourceFiles: source.filter((file) => SOURCE_EXTENSIONS.has(file.extension) && file.testedBy.length === 0).length,
    oversizedFiles: files.filter((file) => file.metrics.code >= 1000).length,
    hotspotFiles: files.filter((file) => file.metrics.complexity >= 150).length,
    complexityPerKloc: raw.code ? Number((raw.complexity * 1000 / raw.code).toFixed(2)) : 0,
    testCodeRatio: sourceCode ? Number((testCode / sourceCode).toFixed(4)) : 0,
  };
}

function buildTree(files: FileSnapshot[], previous?: ReleaseSnapshot): TreeNode {
  const previousNodes = new Map<string, TreeNode>();
  const indexPrevious = (node: TreeNode) => {
    previousNodes.set(node.path, node);
    node.children?.forEach(indexPrevious);
  };
  if (previous) indexPrevious(previous.tree);
  const createDirectory = (name: string, path: string): TreeNode => ({
    kind: 'directory', name, path, metrics: aggregate([], 1), delta: null, children: [],
  });
  const root = createDirectory('xln', '');
  for (const file of files) {
    const parts = file.path.split('/');
    let parent = root;
    for (const part of parts.slice(0, -1)) {
      const path = parent.path ? `${parent.path}/${part}` : part;
      let child = parent.children?.find((node) => node.kind === 'directory' && node.name === part);
      if (!child) {
        child = createDirectory(part, path);
        parent.children?.push(child);
      }
      parent = child;
    }
    parent.children?.push({
      kind: 'file', name: file.name, path: file.path, category: file.category,
      metrics: aggregate([file], 0), delta: file.delta,
    });
  }
  const finalize = (node: TreeNode): FileSnapshot[] => {
    if (node.kind === 'file') return [files.find((file) => file.path === node.path)!];
    const descendants = node.children?.flatMap(finalize) ?? [];
    const directoryCount = (node.children ?? []).filter((child) => child.kind === 'directory')
      .reduce((sum, child) => sum + child.metrics.directories, 0) + 1;
    node.metrics = aggregate(descendants, directoryCount);
    node.delta = metricDelta(node.metrics, previousNodes.get(node.path)?.metrics);
    node.children?.sort((left, right) => {
      if (!node.path) {
        const li = ROOT_ORDER.indexOf(left.name);
        const ri = ROOT_ORDER.indexOf(right.name);
        if (li !== ri) return (li < 0 ? 999 : li) - (ri < 0 ? 999 : ri);
      }
      if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
    return descendants;
  };
  finalize(root);
  return root;
}

function graphAnalysis(files: FileSnapshot[]): { cycles: string[][]; longest: string[] } {
  const graph = new Map(files.map((file) => [file.path, file.dependencies]));
  const cycles = new Map<string, string[]>();
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const findCycles = (node: string) => {
    const currentState = state.get(node) ?? 0;
    if (currentState === 2) return;
    if (currentState === 1) {
      const start = stack.indexOf(node);
      const cycle = [...stack.slice(start), node];
      cycles.set([...cycle.slice(0, -1)].sort().join('|'), cycle);
      return;
    }
    state.set(node, 1);
    stack.push(node);
    for (const dependency of graph.get(node) ?? []) findCycles(dependency);
    stack.pop();
    state.set(node, 2);
  };
  for (const file of files) findCycles(file.path);

  const memo = new Map<string, string[]>();
  const longestFrom = (node: string, active: Set<string>): string[] => {
    const cached = memo.get(node);
    if (cached) return cached;
    if (active.has(node)) return [];
    const nextActive = new Set(active).add(node);
    let tail: string[] = [];
    for (const dependency of graph.get(node) ?? []) {
      const candidate = longestFrom(dependency, nextActive);
      if (candidate.length > tail.length) tail = candidate;
    }
    const result = [node, ...tail];
    memo.set(node, result);
    return result;
  };
  let longest: string[] = [];
  for (const file of files) {
    const candidate = longestFrom(file.path, new Set());
    if (candidate.length > longest.length) longest = candidate;
  }
  return { cycles: [...cycles.values()].sort((a, b) => a.join().localeCompare(b.join())), longest };
}

export function collectSnapshot(input: {
  root: string;
  version: string;
  previous?: ReleaseSnapshot;
}): ReleaseSnapshot {
  const root = resolve(input.root);
  const listed = listRepositoryFiles(root);
  const excluded: ExcludedFile[] = [];
  const included = listed.filter((path) => {
    const reason = exclusion(path);
    if (!reason) return true;
    const absolute = resolve(root, path);
    excluded.push({ path, bytes: lstatSync(absolute).size, reason });
    return false;
  });
  const scc = collectScc(root, included);
  const allPaths = new Set(included);
  const previousFiles = new Map(input.previous?.files.map((file) => [file.path, file]) ?? []);
  const files = included.map((path) => collectFile(root, path, scc.files.get(path), allPaths, previousFiles.get(path)));
  connectFiles(files);
  const tree = buildTree(files, input.previous);
  const graph = graphAnalysis(files);
  const previousPaths = new Set(input.previous?.files.map((file) => file.path) ?? []);
  const currentPaths = new Set(files.map((file) => file.path));
  const modified = files.filter((file) => previousPaths.has(file.path) && file.delta && Object.values(file.delta).some(Boolean)).length;
  const group = (key: 'language' | 'category') => Object.fromEntries([...new Set(files.map((file) => file[key]))].sort().map((value) => {
    const matches = files.filter((file) => file[key] === value);
    return [value, {
      files: matches.length,
      code: matches.reduce((sum, file) => sum + file.metrics.code, 0),
      complexity: matches.reduce((sum, file) => sum + file.metrics.complexity, 0),
    }];
  }));
  return {
    schemaVersion: 1,
    toolVersion: '1.0.0',
    collector: { name: 'scc', version: scc.version },
    release: {
      version: input.version,
      tag: `v${input.version}`,
      generatedAt: new Date().toISOString(),
      sourceCommit: run(['git', 'rev-parse', 'HEAD'], root).trim(),
      previousVersion: input.previous?.release.version ?? null,
    },
    repository: {
      name: 'xln',
      metrics: tree.metrics,
      delta: tree.delta,
      changes: {
        added: files.filter((file) => !previousPaths.has(file.path)).length,
        removed: [...previousPaths].filter((path) => !currentPaths.has(path)).length,
        modified,
      },
      languages: group('language'),
      categories: group('category'),
      circularDependencies: graph.cycles,
      longestDependencyChain: graph.longest,
      hotspots: [...files].sort((a, b) => b.metrics.complexity - a.metrics.complexity).slice(0, 25)
        .map((file) => ({ path: file.path, code: file.metrics.code, complexity: file.metrics.complexity, complexityPerKloc: file.complexityPerKloc })),
      largestFiles: [...files].sort((a, b) => b.metrics.code - a.metrics.code).slice(0, 25)
        .map((file) => ({ path: file.path, code: file.metrics.code, bytes: file.metrics.bytes })),
    },
    tree,
    files,
    excluded,
  };
}
