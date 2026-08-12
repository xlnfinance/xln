/** Derived coverage, quality, staleness, and module-state calculations. */

import type {
  AuditEvidence,
  AuditFinding,
  AuditInvariant,
  AuditModule,
  AuditRegistry,
  AuditStatus,
  EvidenceKind,
  FindingSeverity,
  InvariantAuditStatus,
  ModuleAuditState,
  ModuleAuditStatus,
  ModuleCriticality,
} from './types';
import { computeModuleReviewStatus } from './reviews';

const criticalityWeight: Readonly<Record<ModuleCriticality, number>> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

const severityDebt: Readonly<Record<FindingSeverity, number>> = {
  P0: 45,
  P1: 20,
  P2: 7,
  P3: 2,
};

const findingIsOpen = (finding: AuditFinding): boolean =>
  finding.state !== 'REJECTED' && finding.state !== 'VERIFIED';

const findingCreatesDebt = (finding: AuditFinding): boolean =>
  findingIsOpen(finding) && finding.state !== 'CANDIDATE';

const latestEvidenceByKind = (evidence: readonly AuditEvidence[]): ReadonlyMap<EvidenceKind, AuditEvidence> => {
  const latest = new Map<EvidenceKind, AuditEvidence>();
  for (const item of [...evidence].sort((left, right) => (
    Date.parse(left.recordedAt) - Date.parse(right.recordedAt)
    || left.id.localeCompare(right.id)
  ))) {
    latest.set(item.kind, item);
  }
  return latest;
};

const roundMetric = (value: number): number => Math.round(value * 10) / 10;

const moduleDependencyClosure = (
  module: AuditModule,
  modules: ReadonlyMap<string, AuditModule>,
  output = new Set<string>(),
): ReadonlySet<string> => {
  if (output.has(module.id)) return output;
  output.add(module.id);
  for (const dependencyId of module.dependencies) {
    const dependency = modules.get(dependencyId);
    if (dependency) moduleDependencyClosure(dependency, modules, output);
  }
  return output;
};

const invariantStatus = (
  invariant: AuditInvariant,
  evidence: readonly AuditEvidence[],
  currentFingerprint: string,
  currentEnvironmentFingerprint: string,
  weights: AuditRegistry['policy']['evidenceWeights'],
): InvariantAuditStatus => {
  const all = evidence.filter(item => item.invariantId === invariant.id);
  // Source SHA is provenance, not eligibility: unrelated commits may retain an
  // identical dependency-cone fingerprint and therefore reusable evidence.
  const current = latestEvidenceByKind(all.filter(item => (
    item.moduleFingerprint === currentFingerprint
    && item.environmentFingerprint === currentEnvironmentFingerprint
  )));
  const historical = new Set(all.map(item => item.kind));
  const requiredWeight = invariant.requiredEvidence.reduce((sum, kind) => sum + weights[kind], 0);
  const passedWeight = invariant.requiredEvidence.reduce(
    (sum, kind) => sum + (current.get(kind)?.state === 'PASS' ? weights[kind] : 0),
    0,
  );
  return {
    id: invariant.id,
    moduleId: invariant.moduleId,
    coverage: requiredWeight === 0 ? 0 : roundMetric((passedWeight / requiredWeight) * 100),
    missingEvidence: invariant.requiredEvidence.filter(kind => current.get(kind)?.state !== 'PASS'),
    staleEvidence: invariant.requiredEvidence.filter(kind => historical.has(kind) && !current.has(kind)),
  };
};

const moduleState = (
  coverage: number,
  currentEvidence: number,
  staleEvidence: number,
  findings: readonly AuditFinding[],
): ModuleAuditState => {
  if (findings.some(finding => findingCreatesDebt(finding) && (finding.severity === 'P0' || finding.severity === 'P1'))) {
    return 'BLOCKED';
  }
  if (staleEvidence > 0) return 'STALE';
  if (coverage === 100) return 'AUDITED';
  if (currentEvidence > 0 || findings.length > 0) return 'IN_REVIEW';
  return 'MAPPED';
};

const moduleQuality = (
  module: AuditModule,
  coverage: number,
  findings: readonly AuditFinding[],
): number => {
  const debt = findings.filter(findingCreatesDebt).reduce(
    (sum, finding) => sum + severityDebt[finding.severity],
    module.structuralDebt,
  );
  let quality = Math.min(Math.max(0, 100 - debt), 40 + (0.6 * coverage));
  if (findings.some(finding => findingIsOpen(finding) && finding.severity === 'P0')) quality = Math.min(quality, 20);
  else if (findings.some(finding => findingIsOpen(finding) && finding.severity === 'P1')) quality = Math.min(quality, 60);
  if (findings.some(finding => finding.state === 'CANDIDATE' && (finding.severity === 'P0' || finding.severity === 'P1'))) {
    quality = Math.min(quality, 75);
  }
  return roundMetric(quality);
};

export const computeAuditStatus = (
  registry: AuditRegistry,
  fingerprints: ReadonlyMap<string, string>,
  sourceSha: string,
  environmentFingerprint: string,
): AuditStatus => {
  const moduleDefinitions = new Map(registry.modules.map(module => [module.id, module]));
  const invariants = registry.invariants.map(invariant => invariantStatus(
    invariant,
    registry.evidence,
    fingerprints.get(invariant.moduleId) ?? '',
    environmentFingerprint,
    registry.policy.evidenceWeights,
  ));
  const modules: ModuleAuditStatus[] = registry.modules.map(module => {
    const owned = registry.invariants.filter(invariant => invariant.moduleId === module.id);
    const dependencyModuleIds = moduleDependencyClosure(module, moduleDefinitions);
    const dependencyInvariantIds = new Set(registry.invariants
      .filter(invariant => dependencyModuleIds.has(invariant.moduleId))
      .map(invariant => invariant.id));
    const statuses = invariants.filter(invariant => invariant.moduleId === module.id);
    const totalImportance = owned.reduce((sum, invariant) => sum + invariant.importance, 0);
    const coverage = totalImportance === 0 ? 0 : roundMetric(statuses.reduce((sum, status, index) => (
      sum + (status.coverage * owned[index]!.importance)
    ), 0) / totalImportance);
    const currentFingerprint = fingerprints.get(module.id) ?? '';
    const currentEvidence = owned.reduce((sum, invariant) => {
      const current = latestEvidenceByKind(registry.evidence.filter(item => (
        item.invariantId === invariant.id
        && item.moduleFingerprint === currentFingerprint
        && item.environmentFingerprint === environmentFingerprint
      )));
      return sum + invariant.requiredEvidence.filter(kind => current.has(kind)).length;
    }, 0);
    const staleEvidence = statuses.reduce((sum, status) => sum + status.staleEvidence.length, 0);
    const findings = registry.findings.filter(finding => findingIsOpen(finding) && (
      dependencyModuleIds.has(finding.moduleId)
      || finding.invariantIds.some(invariantId => dependencyInvariantIds.has(invariantId))
    ));
    const reviews = computeModuleReviewStatus(
      registry,
      module.id,
      currentFingerprint,
      environmentFingerprint,
    );
    return {
      id: module.id,
      title: module.title,
      criticality: module.criticality,
      state: moduleState(coverage, currentEvidence, staleEvidence, findings),
      coverage,
      quality: moduleQuality(module, coverage, findings),
      currentEvidence,
      staleEvidence,
      openFindings: findings.length,
      openHighFindings: findings.filter(finding => finding.severity === 'P0' || finding.severity === 'P1').length,
      reviewFloor: reviews.floor,
      reviewCount: reviews.count,
      reviewFamilyCount: reviews.familyCount,
      staleReviews: reviews.stale,
      reviewGoalMet: reviews.goalMet,
    };
  });
  const weighted = modules.reduce((sum, module) => sum + criticalityWeight[module.criticality], 0);
  const coverage = weighted === 0 ? 0 : roundMetric(modules.reduce(
    (sum, module) => sum + (module.coverage * criticalityWeight[module.criticality]),
    0,
  ) / weighted);
  const quality = weighted === 0 ? 0 : roundMetric(modules.reduce(
    (sum, module) => sum + (module.quality * criticalityWeight[module.criticality]),
    0,
  ) / weighted);
  return {
    sourceSha,
    environmentFingerprint,
    coverage,
    quality,
    modules,
    invariants,
    currentEvidence: modules.reduce((sum, module) => sum + module.currentEvidence, 0),
    staleEvidence: modules.reduce((sum, module) => sum + module.staleEvidence, 0),
  };
};

type AuditGateProfile = 'merge' | 'release' | 'ideal';

type AuditGateResult = Readonly<{
  ok: boolean;
  profile: AuditGateProfile;
  failures: readonly string[];
}>;

export const evaluateAuditGate = (
  registry: AuditRegistry,
  status: AuditStatus,
  profile: AuditGateProfile,
): AuditGateResult => {
  const failures: string[] = [];
  if (status.staleEvidence > 0) failures.push(`stale evidence: ${status.staleEvidence}`);
  for (const finding of registry.findings) {
    if (!findingIsOpen(finding) || (finding.severity !== 'P0' && finding.severity !== 'P1')) continue;
    if (finding.state === 'CANDIDATE') {
      if (finding.confidence >= registry.policy.independentConfidenceThreshold) {
        failures.push(`high-confidence candidate requires adjudication: ${finding.id}`);
      }
      continue;
    }
    failures.push(`open ${finding.severity}: ${finding.id}`);
  }
  if (profile === 'release' || profile === 'ideal') {
    for (const module of status.modules) {
      if (module.criticality === 'critical' && module.coverage < registry.policy.releaseCoverageMinimum) {
        failures.push(`critical coverage ${module.coverage}% < ${registry.policy.releaseCoverageMinimum}%: ${module.id}`);
      }
      const reviewRequired = profile === 'ideal' || module.criticality === 'critical';
      if (reviewRequired && !module.reviewGoalMet) {
        failures.push(
          `review goal unmet ${module.reviewFloor}/1000, ${module.reviewCount}/${registry.policy.idealReviewQuorum} reviewers, `
          + `${module.reviewFamilyCount}/${registry.policy.idealReviewFamilyQuorum} families: ${module.id}`,
        );
      }
      if (profile === 'ideal' && module.coverage < 100) failures.push(`ideal coverage below 100%: ${module.id}`);
      if (profile === 'ideal' && module.quality < 100) failures.push(`ideal quality below 100%: ${module.id}`);
    }
  }
  if (profile === 'ideal') {
    for (const finding of registry.findings) {
      if (findingIsOpen(finding)) failures.push(`open ${finding.severity} blocks ideal gate: ${finding.id}`);
    }
  }
  return { ok: failures.length === 0, profile, failures };
};
