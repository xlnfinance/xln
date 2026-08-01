/** Fail-loud schema, reference, and source-ownership validation. */

import { readFileSync } from 'node:fs';

import { sha256Text } from './fingerprint';
import { validateModuleReviews } from './review-validation';
import { validateAuditRegistryRoot } from './root-validation';
import {
  AGENT_RUN_STATES,
  EVIDENCE_KINDS,
  EVIDENCE_STATES,
  FINDING_SEVERITIES,
  FINDING_STATES,
  MODULE_CRITICALITIES,
  REVIEWER_STATES,
  type AuditRegistry,
} from './types';

const SHA_PATTERN = /^[0-9a-f]{7,40}$/;
const FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/;
const ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const FINDING_ID_PATTERN = /^AUD-[A-Z0-9]+(?:-[A-Z0-9]+)*$/;

const uniqueErrors = (errors: readonly string[]): string[] => [...new Set(errors)].sort();

const duplicateIds = (values: readonly Readonly<{ id: string }>[], label: string): string[] => {
  const seen = new Set<string>();
  const errors: string[] = [];
  for (const value of values) {
    if (seen.has(value.id)) errors.push(`${label} id is duplicated: ${value.id}`);
    seen.add(value.id);
  }
  return errors;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const topLevelShapeErrors = (value: unknown): string[] => {
  if (!isRecord(value)) return ['registry root must be an object'];
  const errors: string[] = [];
  if (value['schemaVersion'] !== 1) errors.push('schemaVersion must equal 1');
  if (typeof value['protocol'] !== 'string' || !value['protocol']) errors.push('protocol must be a non-empty path');
  const scope = value['scope'];
  if (!isRecord(scope)) errors.push('scope must be an object');
  else {
    if (!Array.isArray(scope['sourceGlobs'])) errors.push('scope.sourceGlobs must be an array');
    if (!Array.isArray(scope['testGlobs'])) errors.push('scope.testGlobs must be an array');
    if (!Array.isArray(scope['exclusions'])) errors.push('scope.exclusions must be an array');
  }
  if (!isRecord(value['policy'])) errors.push('policy must be an object');
  for (const field of ['modules', 'invariants', 'evidence', 'findings', 'reviewers', 'agentRuns', 'moduleReviews']) {
    if (!Array.isArray(value[field])) errors.push(`${field} must be an array`);
  }
  return errors;
};

export const parseAuditRegistry = (raw: string): AuditRegistry => {
  const value: unknown = JSON.parse(raw);
  const errors = topLevelShapeErrors(value);
  if (errors.length > 0) throw new Error(`AUDIT_REGISTRY_INVALID\n${errors.join('\n')}`);
  return value as AuditRegistry;
};

export const loadAuditRegistry = (path: string): AuditRegistry =>
  parseAuditRegistry(readFileSync(path, 'utf8'));

const dependencyCycleErrors = (registry: AuditRegistry): string[] => {
  const modules = new Map(registry.modules.map(module => [module.id, module]));
  const visited = new Set<string>();
  const active = new Set<string>();
  const errors: string[] = [];
  const visit = (id: string): void => {
    if (active.has(id)) {
      errors.push(`module dependency cycle includes ${id}`);
      return;
    }
    if (visited.has(id)) return;
    visited.add(id);
    active.add(id);
    for (const dependency of modules.get(id)?.dependencies ?? []) visit(dependency);
    active.delete(id);
  };
  for (const module of registry.modules) visit(module.id);
  return errors;
};

export const validateAuditRegistry = (registry: AuditRegistry, root?: string): string[] => {
  const errors = [
    ...duplicateIds(registry.modules, 'module'),
    ...duplicateIds(registry.invariants, 'invariant'),
    ...duplicateIds(registry.evidence, 'evidence'),
    ...duplicateIds(registry.findings, 'finding'),
    ...duplicateIds(registry.reviewers, 'reviewer'),
    ...duplicateIds(registry.agentRuns, 'agent run'),
    ...validateModuleReviews(registry),
  ];
  if (registry.modules.length < 10) errors.push('registry must map at least 10 modules');
  if (registry.scope.sourceGlobs.length === 0) errors.push('audit scope has no source globs');
  if (registry.scope.testGlobs.length === 0) errors.push('audit scope has no test globs');
  for (const exclusion of registry.scope.exclusions) {
    if (!exclusion.glob || !exclusion.reason) errors.push('audit scope has an unexplained exclusion');
  }
  const moduleIds = new Set(registry.modules.map(module => module.id));
  const invariantIds = new Set(registry.invariants.map(invariant => invariant.id));
  const findingIds = new Set(registry.findings.map(finding => finding.id));
  const findingsById = new Map(registry.findings.map(finding => [finding.id, finding]));
  const reviewerIds = new Set(registry.reviewers.map(reviewer => reviewer.id));
  const agentRunIds = new Set(registry.agentRuns.map(run => run.id));
  const invariantsById = new Map(registry.invariants.map(invariant => [invariant.id, invariant]));
  const agentRunsById = new Map(registry.agentRuns.map(run => [run.id, run]));
  const evidenceKinds = new Set<string>(EVIDENCE_KINDS);
  const evidenceStates = new Set<string>(EVIDENCE_STATES);
  const moduleCriticalities = new Set<string>(MODULE_CRITICALITIES);
  const findingSeverities = new Set<string>(FINDING_SEVERITIES);
  const findingStates = new Set<string>(FINDING_STATES);
  const reviewerStates = new Set<string>(REVIEWER_STATES);
  const agentRunStates = new Set<string>(AGENT_RUN_STATES);
  const weightTotal = EVIDENCE_KINDS.reduce((sum, kind) => sum + registry.policy.evidenceWeights[kind], 0);
  for (const kind of EVIDENCE_KINDS) {
    const weight = registry.policy.evidenceWeights[kind];
    if (!Number.isFinite(weight) || weight < 0) errors.push(`evidence weight ${kind} must be finite and non-negative`);
  }
  if (weightTotal !== 100) errors.push(`evidence weights must total 100, got ${weightTotal}`);
  if (registry.policy.releaseCoverageMinimum < 0 || registry.policy.releaseCoverageMinimum > 100) {
    errors.push('releaseCoverageMinimum must be between 0 and 100');
  }
  if (registry.policy.independentConfidenceThreshold < 0 || registry.policy.independentConfidenceThreshold > 100) {
    errors.push('independentConfidenceThreshold must be between 0 and 100');
  }

  for (const module of registry.modules) {
    if (!ID_PATTERN.test(module.id)) errors.push(`invalid module id: ${module.id}`);
    if (!module.title || !module.purpose) errors.push(`module ${module.id} requires title and purpose`);
    if (!moduleCriticalities.has(module.criticality)) errors.push(`module ${module.id} has invalid criticality ${String(module.criticality)}`);
    if (module.structuralDebt < 0 || module.structuralDebt > 100) errors.push(`module ${module.id} structuralDebt must be 0..100`);
    if (module.sourceGlobs.length === 0) errors.push(`module ${module.id} has no source globs`);
    if (module.testGlobs.length === 0) errors.push(`module ${module.id} has no test globs`);
    if (new Set(module.sourceGlobs).size !== module.sourceGlobs.length) errors.push(`module ${module.id} repeats source globs`);
    if (new Set(module.testGlobs).size !== module.testGlobs.length) errors.push(`module ${module.id} repeats test globs`);
    if (new Set(module.dependencies).size !== module.dependencies.length) errors.push(`module ${module.id} repeats dependencies`);
    for (const exclusion of module.exclusions) {
      if (!exclusion.glob || !exclusion.reason) errors.push(`module ${module.id} has an unexplained exclusion`);
    }
    for (const dependency of module.dependencies) {
      if (!moduleIds.has(dependency)) errors.push(`module ${module.id} references unknown dependency ${dependency}`);
      if (dependency === module.id) errors.push(`module ${module.id} depends on itself`);
    }
  }
  errors.push(...dependencyCycleErrors(registry));

  for (const invariant of registry.invariants) {
    if (!ID_PATTERN.test(invariant.id)) errors.push(`invalid invariant id: ${invariant.id}`);
    if (!moduleIds.has(invariant.moduleId)) errors.push(`invariant ${invariant.id} has unknown module ${invariant.moduleId}`);
    if (invariant.importance < 1 || invariant.importance > 100) errors.push(`invariant ${invariant.id} importance must be 1..100`);
    if (invariant.requiredEvidence.length === 0) errors.push(`invariant ${invariant.id} requires no evidence`);
    if (new Set(invariant.requiredEvidence).size !== invariant.requiredEvidence.length) errors.push(`invariant ${invariant.id} repeats required evidence`);
    for (const kind of invariant.requiredEvidence) {
      if (!evidenceKinds.has(kind)) errors.push(`invariant ${invariant.id} has unknown evidence kind ${kind}`);
    }
  }
  for (const module of registry.modules) {
    if (!registry.invariants.some(invariant => invariant.moduleId === module.id)) errors.push(`module ${module.id} has no invariants`);
  }

  for (const evidence of registry.evidence) {
    if (!ID_PATTERN.test(evidence.id)) errors.push(`invalid evidence id: ${evidence.id}`);
    if (!invariantIds.has(evidence.invariantId)) errors.push(`evidence ${evidence.id} has unknown invariant ${evidence.invariantId}`);
    if (!evidenceKinds.has(evidence.kind)) errors.push(`evidence ${evidence.id} has unknown kind ${evidence.kind}`);
    if (!evidenceStates.has(evidence.state)) errors.push(`evidence ${evidence.id} has invalid state ${String(evidence.state)}`);
    if (!SHA_PATTERN.test(evidence.sourceSha)) errors.push(`evidence ${evidence.id} has invalid source SHA`);
    if (!FINGERPRINT_PATTERN.test(evidence.moduleFingerprint)) errors.push(`evidence ${evidence.id} has invalid fingerprint`);
    if (evidence.commandFingerprint !== sha256Text(evidence.command)) errors.push(`evidence ${evidence.id} command fingerprint mismatch`);
    if (!FINGERPRINT_PATTERN.test(evidence.environmentFingerprint)) errors.push(`evidence ${evidence.id} has invalid environment fingerprint`);
    if (!FINGERPRINT_PATTERN.test(evidence.artifactFingerprint)) errors.push(`evidence ${evidence.id} has invalid artifact fingerprint`);
    if (!evidence.artifactPath.startsWith('audits/evidence/')) errors.push(`evidence ${evidence.id} artifact must live under audits/evidence`);
    if (!evidence.command || !evidence.summary) errors.push(`evidence ${evidence.id} requires command and summary`);
    if (!Number.isFinite(Date.parse(evidence.recordedAt))) errors.push(`evidence ${evidence.id} has invalid recordedAt`);
    if (evidence.agentRunIds.length === 0) errors.push(`evidence ${evidence.id} has no attesting agent run`);
    for (const runId of evidence.agentRunIds) {
      if (!agentRunIds.has(runId)) errors.push(`evidence ${evidence.id} has unknown agent run ${runId}`);
      const run = agentRunsById.get(runId);
      if (run && run.state !== 'COMPLETED') errors.push(`evidence ${evidence.id} cites non-completed agent run ${runId}`);
    }
    const invariant = invariantsById.get(evidence.invariantId);
    const attestingRuns = evidence.agentRunIds.flatMap(runId => {
      const run = agentRunsById.get(runId);
      return run ? [run] : [];
    });
    if (invariant && !attestingRuns.some(run => (
      run.moduleIds.includes(invariant.moduleId)
      && run.sourceSha === evidence.sourceSha
    ))) {
      errors.push(
        `evidence ${evidence.id} has no same-run attester scoped to ${invariant.moduleId} on source SHA ${evidence.sourceSha}`,
      );
    }
  }

  for (const invariant of registry.invariants) {
    const items = registry.evidence.filter(evidence => evidence.invariantId === invariant.id);
    const ordinaryReviewers = new Set(items
      .filter(evidence => evidence.kind !== 'independentVerification')
      .flatMap(evidence => evidence.agentRunIds)
      .flatMap(runId => {
        const run = agentRunsById.get(runId);
        return run ? [run.reviewerId] : [];
      }));
    for (const evidence of items.filter(item => item.kind === 'independentVerification')) {
      const independentReviewers = evidence.agentRunIds.flatMap(runId => {
        const run = agentRunsById.get(runId);
        return run ? [run.reviewerId] : [];
      });
      if (!independentReviewers.some(reviewerId => !ordinaryReviewers.has(reviewerId))) {
        errors.push(`evidence ${evidence.id} has no independent reviewer`);
      }
    }
  }

  for (const finding of registry.findings) {
    if (!FINDING_ID_PATTERN.test(finding.id)) errors.push(`invalid finding id: ${finding.id}`);
    if (!moduleIds.has(finding.moduleId)) errors.push(`finding ${finding.id} has unknown module ${finding.moduleId}`);
    if (!SHA_PATTERN.test(finding.sourceSha)) errors.push(`finding ${finding.id} has invalid source SHA`);
    if (finding.confidence < 0 || finding.confidence > 100) errors.push(`finding ${finding.id} confidence must be 0..100`);
    if (!findingSeverities.has(finding.severity)) errors.push(`finding ${finding.id} has invalid severity ${String(finding.severity)}`);
    if (!findingStates.has(finding.state)) errors.push(`finding ${finding.id} has invalid state ${String(finding.state)}`);
    if (finding.invariantIds.length === 0) errors.push(`finding ${finding.id} has no invariants`);
    for (const invariantId of finding.invariantIds) {
      if (!invariantIds.has(invariantId)) errors.push(`finding ${finding.id} has unknown invariant ${invariantId}`);
    }
    if ((finding.state === 'ACCEPTED' || finding.state === 'OWNER_DEFERRED') && !finding.todoRef) {
      errors.push(`finding ${finding.id} in ${finding.state} requires todoRef`);
    }
  }

  for (const reviewer of registry.reviewers) {
    if (!ID_PATTERN.test(reviewer.id)) errors.push(`invalid reviewer id: ${reviewer.id}`);
    if (!reviewer.label || !reviewer.family) errors.push(`reviewer ${reviewer.id} requires label and family`);
    if (!reviewerStates.has(reviewer.state)) errors.push(`reviewer ${reviewer.id} has invalid state ${String(reviewer.state)}`);
  }

  for (const run of registry.agentRuns) {
    if (!ID_PATTERN.test(run.id)) errors.push(`invalid agent run id: ${run.id}`);
    if (!reviewerIds.has(run.reviewerId)) errors.push(`agent run ${run.id} has unknown reviewer ${run.reviewerId}`);
    if (!SHA_PATTERN.test(run.sourceSha)) errors.push(`agent run ${run.id} has invalid source SHA`);
    if (!agentRunStates.has(run.state)) errors.push(`agent run ${run.id} has invalid state ${String(run.state)}`);
    if (run.usefulnessScore < 0 || run.usefulnessScore > 1000) errors.push(`agent run ${run.id} usefulness must be 0..1000`);
    for (const moduleId of run.moduleIds) {
      if (!moduleIds.has(moduleId)) errors.push(`agent run ${run.id} has unknown module ${moduleId}`);
    }
    for (const findingId of [...run.confirmedFindingIds, ...run.candidateFindingIds]) {
      if (!findingIds.has(findingId)) errors.push(`agent run ${run.id} has unknown finding ${findingId}`);
      const finding = findingsById.get(findingId);
      if (finding && !run.moduleIds.includes(finding.moduleId)) {
        errors.push(`agent run ${run.id} is not scoped to finding module ${finding.moduleId}`);
      }
    }
  }

  if (root) errors.push(...validateAuditRegistryRoot(registry, root));
  return uniqueErrors(errors);
};
