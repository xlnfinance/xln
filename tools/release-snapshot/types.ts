export type FileCategory = 'source' | 'test' | 'contract' | 'docs' | 'config' | 'asset';

export type RawMetrics = {
  bytes: number;
  lines: number;
  code: number;
  comments: number;
  blanks: number;
  complexity: number;
  imports: number;
  exports: number;
  dependencies: number;
  dependents: number;
  todos: number;
  fixmes: number;
  hacks: number;
  consoleCalls: number;
  dynamicImports: number;
  anyUsages: number;
  tsIgnores: number;
};

export type MetricDelta = Pick<RawMetrics, 'bytes' | 'lines' | 'code' | 'complexity'>;

export type FileSnapshot = {
  path: string;
  name: string;
  entryType: 'file' | 'symlink';
  extension: string;
  language: string;
  category: FileCategory;
  sha256: string;
  metrics: RawMetrics;
  complexityPerKloc: number;
  dependencies: string[];
  dependents: string[];
  testsFor: string[];
  testedBy: string[];
  delta: MetricDelta | null;
};

export type AggregateMetrics = RawMetrics & {
  files: number;
  directories: number;
  sourceFiles: number;
  testFiles: number;
  sourceCode: number;
  testCode: number;
  untestedSourceFiles: number;
  oversizedFiles: number;
  hotspotFiles: number;
  complexityPerKloc: number;
  testCodeRatio: number;
};

export type TreeNode = {
  kind: 'directory' | 'file';
  name: string;
  path: string;
  category?: FileCategory;
  metrics: AggregateMetrics;
  delta: MetricDelta | null;
  children?: TreeNode[];
};

export type ExcludedFile = {
  path: string;
  bytes: number;
  reason: 'generated' | 'vendor' | 'release-artifact';
};

export type ReleaseSnapshot = {
  schemaVersion: 1;
  toolVersion: string;
  collector: {
    name: 'scc';
    version: string;
  };
  release: {
    version: string;
    tag: string;
    generatedAt: string;
    sourceCommit: string;
    previousVersion: string | null;
  };
  repository: {
    name: 'xln';
    metrics: AggregateMetrics;
    delta: MetricDelta | null;
    changes: {
      added: number;
      removed: number;
      modified: number;
    };
    languages: Record<string, { files: number; code: number; complexity: number }>;
    categories: Record<string, { files: number; code: number; complexity: number }>;
    circularDependencies: string[][];
    longestDependencyChain: string[];
    hotspots: Array<{ path: string; code: number; complexity: number; complexityPerKloc: number }>;
    largestFiles: Array<{ path: string; code: number; bytes: number }>;
  };
  tree: TreeNode;
  files: FileSnapshot[];
  excluded: ExcludedFile[];
};

export type ReleaseManifestEntry = {
  version: string;
  tag: string;
  generatedAt: string;
  markdown: string;
  snapshot: string;
  sourceCommit: string;
  metrics: AggregateMetrics;
  modules: Record<string, AggregateMetrics>;
};

export type ReleaseManifest = {
  schemaVersion: 1;
  latest: string;
  releases: ReleaseManifestEntry[];
};
