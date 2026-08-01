/** Current-source fingerprints for module ownership and dependency cones. */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, normalize, resolve } from 'node:path';

import type { AuditModule, AuditRegistry } from './types';

export const listCurrentSourceFiles = (root: string): string[] =>
  execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean)
    .filter(path => {
      const absolutePath = resolve(root, path);
      return existsSync(absolutePath) && statSync(absolutePath).isFile();
    })
    .sort();

export const matchesAuditGlob = (path: string, pattern: string): boolean =>
  new Bun.Glob(pattern).match(path);

export const sha256Text = (value: string): string =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`;

export const computeFileFingerprint = (path: string): string =>
  `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;

export const computeEnvironmentFingerprint = (root: string): string => {
  const lockPath = resolve(root, 'bun.lock');
  const lockFingerprint = existsSync(lockPath) ? computeFileFingerprint(lockPath) : 'missing';
  return sha256Text(JSON.stringify({
    platform: process.platform,
    architecture: process.arch,
    bunVersion: Bun.version,
    lockFingerprint,
  }));
};

const moduleOwnFiles = (
  module: AuditModule,
  trackedFiles: readonly string[],
): string[] => {
  const patterns = [...module.sourceGlobs, ...module.testGlobs];
  return trackedFiles.filter(path => (
    patterns.some(pattern => matchesAuditGlob(path, pattern))
    && !module.exclusions.some(exclusion => matchesAuditGlob(path, exclusion.glob))
  ));
};

const moduleOwnSourceFiles = (
  module: AuditModule,
  trackedFiles: readonly string[],
): string[] => trackedFiles.filter(path => (
  module.sourceGlobs.some(pattern => matchesAuditGlob(path, pattern))
  && !module.exclusions.some(exclusion => matchesAuditGlob(path, exclusion.glob))
));

type ImportGraph = ReadonlyMap<string, readonly string[]>;

const importSpecifiers = (source: string): string[] => {
  const specifiers: string[] = [];
  const pattern = /\b(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/gu;
  for (const match of source.matchAll(pattern)) specifiers.push(match[1]!);
  return specifiers;
};

const resolveTrackedImport = (
  sourcePath: string,
  specifier: string,
  tracked: ReadonlySet<string>,
): string | undefined => {
  const joined = normalize(`${dirname(sourcePath)}/${specifier}`).replaceAll('\\', '/');
  if (joined.startsWith('../')) return undefined;
  const withoutJs = joined.replace(/\.(?:c|m)?js$/u, '');
  const candidates = [
    joined,
    `${withoutJs}.ts`,
    `${withoutJs}.tsx`,
    `${withoutJs}.svelte`,
    `${withoutJs}.js`,
    `${withoutJs}.cjs`,
    `${withoutJs}.mjs`,
    `${withoutJs}.sol`,
    `${withoutJs}.json`,
    `${withoutJs}/index.ts`,
    `${withoutJs}/index.tsx`,
    `${withoutJs}/index.js`,
  ];
  return candidates.find(candidate => tracked.has(candidate));
};

const buildImportGraph = (
  root: string,
  trackedFiles: readonly string[],
): ImportGraph => {
  const tracked = new Set(trackedFiles);
  const graph = new Map<string, readonly string[]>();
  const textFile = /\.(?:[cm]?[jt]sx?|svelte|sol)$/u;
  for (const path of trackedFiles.filter(candidate => textFile.test(candidate))) {
    const targets = importSpecifiers(readFileSync(resolve(root, path), 'utf8'))
      .flatMap(specifier => {
        const target = resolveTrackedImport(path, specifier, tracked);
        return target ? [target] : [];
      });
    graph.set(path, [...new Set(targets)].sort());
  }
  return graph;
};

const importClosure = (
  seeds: readonly string[],
  graph: ImportGraph,
): ReadonlySet<string> => {
  const closure = new Set<string>();
  const pending = [...seeds];
  while (pending.length > 0) {
    const path = pending.pop()!;
    if (closure.has(path)) continue;
    closure.add(path);
    for (const target of graph.get(path) ?? []) pending.push(target);
  }
  return closure;
};

const canonicalModuleBoundary = (module: AuditModule, registry: AuditRegistry): string => JSON.stringify({
  id: module.id,
  criticality: module.criticality,
  sourceGlobs: [...module.sourceGlobs].sort(),
  testGlobs: [...module.testGlobs].sort(),
  dependencies: [...module.dependencies].sort(),
  exclusions: [...module.exclusions]
    .map(exclusion => ({ glob: exclusion.glob, reason: exclusion.reason }))
    .sort((left, right) => left.glob.localeCompare(right.glob) || left.reason.localeCompare(right.reason)),
  invariants: registry.invariants
    .filter(invariant => invariant.moduleId === module.id)
    .map(invariant => ({
      id: invariant.id,
      title: invariant.title,
      importance: invariant.importance,
      requiredEvidence: [...invariant.requiredEvidence].sort(),
    }))
    .sort((left, right) => left.id.localeCompare(right.id)),
});

const dependencyClosure = (
  module: AuditModule,
  modules: ReadonlyMap<string, AuditModule>,
  output = new Set<string>(),
): Set<string> => {
  if (output.has(module.id)) return output;
  output.add(module.id);
  for (const dependencyId of module.dependencies) {
    const dependency = modules.get(dependencyId);
    if (dependency) dependencyClosure(dependency, modules, output);
  }
  return output;
};

export const listModuleFingerprintFiles = (
  root: string,
  moduleId: string,
  registry: AuditRegistry,
  trackedFiles = listCurrentSourceFiles(root),
  graph = buildImportGraph(root, trackedFiles),
): string[] => {
  const modules = new Map(registry.modules.map(module => [module.id, module]));
  const module = modules.get(moduleId);
  if (!module) throw new Error(`AUDIT_MODULE_UNKNOWN:${moduleId}`);
  const closure = dependencyClosure(module, modules);
  const closureModules = [...closure].map(id => modules.get(id)!);
  const sourceSeeds = closureModules.flatMap(candidate => moduleOwnSourceFiles(candidate, trackedFiles));
  const sourceClosure = importClosure(sourceSeeds, graph);
  const scopedTests = trackedFiles.filter(path => registry.scope.testGlobs.some(
    pattern => matchesAuditGlob(path, pattern),
  ));
  const reverseTests = scopedTests.filter(path => {
    const imported = importClosure([path], graph);
    return [...sourceClosure].some(sourcePath => imported.has(sourcePath));
  });
  const explicit = closureModules.flatMap(candidate => moduleOwnFiles(candidate, trackedFiles));
  return [...importClosure([...explicit, ...sourceClosure, ...reverseTests], graph)].sort();
};

export const computeModuleFingerprint = (
  root: string,
  moduleId: string,
  registry: AuditRegistry,
  trackedFiles = listCurrentSourceFiles(root),
  graph = buildImportGraph(root, trackedFiles),
): string => {
  const modules = new Map(registry.modules.map(module => [module.id, module]));
  const module = modules.get(moduleId);
  if (!module) throw new Error(`AUDIT_MODULE_UNKNOWN:${moduleId}`);
  const closure = dependencyClosure(module, modules);
  const files = listModuleFingerprintFiles(root, moduleId, registry, trackedFiles, graph);
  const digest = createHash('sha256');
  digest.update('audit-module-fingerprint-v3-import-closure\0');
  digest.update(JSON.stringify({
    sourceGlobs: [...registry.scope.sourceGlobs].sort(),
    testGlobs: [...registry.scope.testGlobs].sort(),
    exclusions: [...registry.scope.exclusions]
      .map(exclusion => ({ glob: exclusion.glob, reason: exclusion.reason }))
      .sort((left, right) => left.glob.localeCompare(right.glob) || left.reason.localeCompare(right.reason)),
  }));
  digest.update('\0');
  for (const id of [...closure].sort()) {
    digest.update(canonicalModuleBoundary(modules.get(id)!, registry));
    digest.update('\0');
  }
  for (const path of files) {
    digest.update(path);
    digest.update('\0');
    digest.update(readFileSync(resolve(root, path)));
    digest.update('\0');
  }
  return `sha256:${digest.digest('hex')}`;
};

export const computeModuleFingerprints = (
  root: string,
  registry: AuditRegistry,
): ReadonlyMap<string, string> => {
  const trackedFiles = listCurrentSourceFiles(root);
  const graph = buildImportGraph(root, trackedFiles);
  return new Map(registry.modules.map(module => [
    module.id,
    computeModuleFingerprint(root, module.id, registry, trackedFiles, graph),
  ]));
};

export const readCurrentSha = (root: string): string =>
  execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
