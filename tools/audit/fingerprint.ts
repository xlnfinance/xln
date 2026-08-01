/** Current-source fingerprints for module ownership and dependency cones. */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

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

export const computeModuleFingerprint = (
  root: string,
  moduleId: string,
  registry: AuditRegistry,
  trackedFiles = listCurrentSourceFiles(root),
): string => {
  const modules = new Map(registry.modules.map(module => [module.id, module]));
  const module = modules.get(moduleId);
  if (!module) throw new Error(`AUDIT_MODULE_UNKNOWN:${moduleId}`);
  const closure = dependencyClosure(module, modules);
  const files = [...new Set(
    [...closure]
      .flatMap(id => moduleOwnFiles(modules.get(id)!, trackedFiles)),
  )].sort();
  const digest = createHash('sha256');
  digest.update('audit-module-fingerprint-v2\0');
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
  return new Map(registry.modules.map(module => [
    module.id,
    computeModuleFingerprint(root, module.id, registry, trackedFiles),
  ]));
};

export const readCurrentSha = (root: string): string =>
  execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
