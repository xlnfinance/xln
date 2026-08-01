/** Fail-loud validation for exact-snapshot module scorecards. */

import type { AuditRegistry } from './types';

const SHA_PATTERN = /^[0-9a-f]{7,40}$/;
const FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/;
const ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

const isBoundedInteger = (value: number, minimum: number, maximum: number): boolean =>
  Number.isInteger(value) && value >= minimum && value <= maximum;

export const validateModuleReviews = (registry: AuditRegistry): string[] => {
  const errors: string[] = [];
  const policy = registry.policy;
  if (!isBoundedInteger(policy.idealModuleScoreMinimum, 0, 1000)) {
    errors.push('idealModuleScoreMinimum must be an integer between 0 and 1000');
  }
  if (!isBoundedInteger(policy.idealReviewQuorum, 1, 10)) {
    errors.push('idealReviewQuorum must be an integer between 1 and 10');
  }
  if (!isBoundedInteger(policy.idealReviewFamilyQuorum, 1, 10)) {
    errors.push('idealReviewFamilyQuorum must be an integer between 1 and 10');
  }
  if (policy.idealReviewFamilyQuorum > policy.idealReviewQuorum) {
    errors.push('idealReviewFamilyQuorum cannot exceed idealReviewQuorum');
  }

  const moduleIds = new Set(registry.modules.map(module => module.id));
  const findingIds = new Set(registry.findings.map(finding => finding.id));
  const runs = new Map(registry.agentRuns.map(run => [run.id, run]));
  const seenIds = new Set<string>();
  for (const review of registry.moduleReviews) {
    if (seenIds.has(review.id)) errors.push(`module review id is duplicated: ${review.id}`);
    seenIds.add(review.id);
    if (!ID_PATTERN.test(review.id)) errors.push(`invalid module review id: ${review.id}`);
    if (!moduleIds.has(review.moduleId)) {
      errors.push(`module review ${review.id} has unknown module ${review.moduleId}`);
    }
    const run = runs.get(review.agentRunId);
    if (!run) errors.push(`module review ${review.id} has unknown agent run ${review.agentRunId}`);
    else {
      if (run.state !== 'COMPLETED') errors.push(`module review ${review.id} cites non-completed run ${run.id}`);
      if (!run.moduleIds.includes(review.moduleId)) {
        errors.push(`module review ${review.id} run ${run.id} is not scoped to ${review.moduleId}`);
      }
      if (run.sourceSha !== review.sourceSha) {
        errors.push(`module review ${review.id} source SHA differs from run ${run.id}`);
      }
    }
    if (!SHA_PATTERN.test(review.sourceSha)) errors.push(`module review ${review.id} has invalid source SHA`);
    if (!FINGERPRINT_PATTERN.test(review.moduleFingerprint)) {
      errors.push(`module review ${review.id} has invalid module fingerprint`);
    }
    if (!FINGERPRINT_PATTERN.test(review.environmentFingerprint)) {
      errors.push(`module review ${review.id} has invalid environment fingerprint`);
    }
    if (!isBoundedInteger(review.score, 0, 1000)) {
      errors.push(`module review ${review.id} score must be an integer between 0 and 1000`);
    }
    if (!isBoundedInteger(review.confidence, 0, 100)) {
      errors.push(`module review ${review.id} confidence must be an integer between 0 and 100`);
    }
    if (!review.summary) errors.push(`module review ${review.id} requires a summary`);
    if (!Number.isFinite(Date.parse(review.recordedAt))) {
      errors.push(`module review ${review.id} has invalid recordedAt`);
    }
    if (new Set(review.blockerFindingIds).size !== review.blockerFindingIds.length) {
      errors.push(`module review ${review.id} repeats blocker findings`);
    }
    for (const findingId of review.blockerFindingIds) {
      if (!findingIds.has(findingId)) errors.push(`module review ${review.id} has unknown blocker ${findingId}`);
    }
    if (review.score >= policy.idealModuleScoreMinimum && review.blockerFindingIds.length > 0) {
      errors.push(`module review ${review.id} cannot meet the ideal score while declaring blockers`);
    }
  }
  return errors;
};
