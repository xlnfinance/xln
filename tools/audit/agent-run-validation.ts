/** Exact invariant and fingerprint validation for audit-agent claims. */

import { AGENT_RUN_STATES, type AuditRegistry } from './types';

const SHA_PATTERN = /^[0-9a-f]{7,40}$/;
const FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/;
const ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

export const validateAgentRuns = (registry: AuditRegistry): string[] => {
  const errors: string[] = [];
  const moduleIds = new Set(registry.modules.map(module => module.id));
  const reviewerIds = new Set(registry.reviewers.map(reviewer => reviewer.id));
  const findingsById = new Map(registry.findings.map(finding => [finding.id, finding]));
  const invariantsById = new Map(registry.invariants.map(invariant => [invariant.id, invariant]));
  const states = new Set<string>(AGENT_RUN_STATES);
  for (const run of registry.agentRuns) {
    if (!ID_PATTERN.test(run.id)) errors.push(`invalid agent run id: ${run.id}`);
    if (!reviewerIds.has(run.reviewerId)) errors.push(`agent run ${run.id} has unknown reviewer ${run.reviewerId}`);
    if (!SHA_PATTERN.test(run.sourceSha)) errors.push(`agent run ${run.id} has invalid source SHA`);
    if (!states.has(run.state)) errors.push(`agent run ${run.id} has invalid state ${String(run.state)}`);
    if (run.usefulnessScore < 0 || run.usefulnessScore > 1000) errors.push(`agent run ${run.id} usefulness must be 0..1000`);
    if (new Set(run.moduleIds).size !== run.moduleIds.length) errors.push(`agent run ${run.id} repeats modules`);
    if (new Set(run.invariantIds).size !== run.invariantIds.length) errors.push(`agent run ${run.id} repeats invariants`);
    for (const moduleId of run.moduleIds) {
      if (!moduleIds.has(moduleId)) errors.push(`agent run ${run.id} has unknown module ${moduleId}`);
    }
    const exactModuleIds = new Set<string>();
    for (const invariantId of run.invariantIds) {
      const invariant = invariantsById.get(invariantId);
      if (!invariant) errors.push(`agent run ${run.id} has unknown invariant ${invariantId}`);
      else {
        exactModuleIds.add(invariant.moduleId);
        if (!run.moduleIds.includes(invariant.moduleId)) {
          errors.push(`agent run ${run.id} invariant ${invariantId} is outside module scope`);
        }
        if (!run.moduleFingerprints[invariant.moduleId]) {
          errors.push(`agent run ${run.id} has no fingerprint for invariant module ${invariant.moduleId}`);
        }
      }
    }
    for (const [moduleId, fingerprint] of Object.entries(run.moduleFingerprints)) {
      if (!run.moduleIds.includes(moduleId)) errors.push(`agent run ${run.id} fingerprint is outside module scope: ${moduleId}`);
      if (!FINGERPRINT_PATTERN.test(fingerprint)) errors.push(`agent run ${run.id} has invalid module fingerprint for ${moduleId}`);
      if (!exactModuleIds.has(moduleId)) errors.push(`agent run ${run.id} fingerprint has no invariant scope: ${moduleId}`);
    }
    for (const findingId of [...run.confirmedFindingIds, ...run.candidateFindingIds]) {
      const finding = findingsById.get(findingId);
      if (!finding) errors.push(`agent run ${run.id} has unknown finding ${findingId}`);
      else if (!run.moduleIds.includes(finding.moduleId)) {
        errors.push(`agent run ${run.id} is not scoped to finding module ${finding.moduleId}`);
      }
    }
  }
  return errors;
};
