/** Filesystem-backed scope ownership and immutable evidence-artifact checks. */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  computeFileFingerprint,
  listCurrentSourceFiles,
  matchesAuditGlob,
} from './fingerprint';
import type { AuditEvidence, AuditRegistry } from './types';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const validateModuleGlobs = (
  registry: AuditRegistry,
  files: readonly string[],
): string[] => {
  const errors: string[] = [];
  for (const module of registry.modules) {
    for (const pattern of module.sourceGlobs) {
      if (!files.some(path => matchesAuditGlob(path, pattern))) {
        errors.push(`module ${module.id} source glob matches no current file: ${pattern}`);
      }
    }
    for (const pattern of module.testGlobs) {
      if (!files.some(path => matchesAuditGlob(path, pattern))) {
        errors.push(`module ${module.id} test glob matches no current file: ${pattern}`);
      }
    }
  }
  return errors;
};

const validateInvariantGlobs = (
  registry: AuditRegistry,
  files: readonly string[],
): string[] => {
  const errors: string[] = [];
  const modules = new Map(registry.modules.map(module => [module.id, module]));
  for (const invariant of registry.invariants) {
    const module = modules.get(invariant.moduleId);
    if (!module) continue;
    for (const [kind, patterns, modulePatterns] of [
      ['source', invariant.sourceGlobs, module.sourceGlobs],
      ['test', invariant.testGlobs, module.testGlobs],
    ] as const) {
      for (const pattern of patterns) {
        const matches = files.filter(path => matchesAuditGlob(path, pattern));
        if (matches.length === 0) {
          errors.push(`invariant ${invariant.id} ${kind} glob matches no current file: ${pattern}`);
        }
        for (const path of matches) {
          if (!modulePatterns.some(modulePattern => matchesAuditGlob(path, modulePattern))) {
            errors.push(`invariant ${invariant.id} ${kind} file is outside module scope: ${path}`);
          }
        }
      }
    }
  }
  return errors;
};

const validateScopeOwnership = (
  registry: AuditRegistry,
  files: readonly string[],
): string[] => {
  const excluded = (path: string): boolean => registry.scope.exclusions.some(
    exclusion => matchesAuditGlob(path, exclusion.glob),
  );
  const isTest = (path: string): boolean => registry.scope.testGlobs.some(
    pattern => matchesAuditGlob(path, pattern),
  );
  const sourceUniverse = files.filter(path => (
    registry.scope.sourceGlobs.some(pattern => matchesAuditGlob(path, pattern))
    && !isTest(path)
    && !excluded(path)
  ));
  const testUniverse = files.filter(path => isTest(path) && !excluded(path));
  const errors: string[] = [];
  for (const path of sourceUniverse) {
    const owned = registry.modules.some(module => (
      module.sourceGlobs.some(pattern => matchesAuditGlob(path, pattern))
      && !module.exclusions.some(exclusion => matchesAuditGlob(path, exclusion.glob))
    ));
    if (!owned) errors.push(`in-scope source has no module owner: ${path}`);
  }
  for (const path of testUniverse) {
    const owned = registry.modules.some(module => module.testGlobs.some(
      pattern => matchesAuditGlob(path, pattern),
    ));
    if (!owned) errors.push(`in-scope test has no module owner: ${path}`);
  }
  return errors;
};

const readArtifact = (path: string, errors: string[]): unknown => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    errors.push(`evidence artifact is not valid JSON: ${path}`);
    return undefined;
  }
};

const arraysEqual = (left: unknown, right: readonly string[]): boolean =>
  Array.isArray(left)
  && left.length === right.length
  && left.every((item, index) => item === right[index]);

/** Prevent a valid artifact from being relabeled as proof of a different claim. */
export const validateEvidenceArtifactBinding = (
  evidence: AuditEvidence,
  artifact: unknown,
): string[] => {
  if (!isRecord(artifact) || artifact['schemaVersion'] !== 2 || !Array.isArray(artifact['evidence'])) {
    return [`evidence ${evidence.id} artifact schema must equal 2`];
  }
  const entries = artifact['evidence'].filter(candidate => isRecord(candidate) && candidate['id'] === evidence.id);
  if (entries.length !== 1) return [`evidence ${evidence.id} must have exactly one artifact entry`];
  const entry = entries[0]!;
  const matches = entry['invariantId'] === evidence.invariantId
    && entry['kind'] === evidence.kind
    && entry['command'] === evidence.command
    && entry['state'] === evidence.state
    && entry['summary'] === evidence.summary
    && entry['sourceSha'] === evidence.sourceSha
    && entry['moduleFingerprint'] === evidence.moduleFingerprint
    && entry['recordedAt'] === evidence.recordedAt
    && arraysEqual(entry['agentRunIds'], evidence.agentRunIds)
    && artifact['environmentFingerprint'] === evidence.environmentFingerprint;
  return matches ? [] : [`evidence ${evidence.id} does not exactly match its artifact`];
};

const validateEvidenceArtifacts = (registry: AuditRegistry, root: string): string[] => {
  const errors: string[] = [];
  const artifactRoot = resolve(root, 'audits/evidence');
  const cache = new Map<string, unknown>();
  for (const evidence of registry.evidence) {
    const absolutePath = resolve(root, evidence.artifactPath);
    if (!absolutePath.startsWith(`${artifactRoot}/`)) {
      errors.push(`evidence ${evidence.id} artifact escapes audits/evidence`);
      continue;
    }
    if (!existsSync(absolutePath)) {
      errors.push(`evidence ${evidence.id} artifact is missing: ${evidence.artifactPath}`);
      continue;
    }
    if (computeFileFingerprint(absolutePath) !== evidence.artifactFingerprint) {
      errors.push(`evidence ${evidence.id} artifact fingerprint mismatch`);
      continue;
    }
    if (!cache.has(absolutePath)) cache.set(absolutePath, readArtifact(absolutePath, errors));
    const artifact = cache.get(absolutePath);
    errors.push(...validateEvidenceArtifactBinding(evidence, artifact));
  }
  return errors;
};

export const validateAuditRegistryRoot = (registry: AuditRegistry, root: string): string[] => {
  const files = listCurrentSourceFiles(root);
  return [
    ...(existsSync(resolve(root, registry.protocol)) ? [] : [`protocol file is missing: ${registry.protocol}`]),
    ...validateModuleGlobs(registry, files),
    ...validateInvariantGlobs(registry, files),
    ...validateScopeOwnership(registry, files),
    ...validateEvidenceArtifacts(registry, root),
  ];
};
