/** Current-fingerprint module-review quorum and score-floor derivation. */

import type { AuditModuleReview, AuditRegistry } from './types';

export type ModuleReviewStatus = Readonly<{
  floor: number;
  count: number;
  familyCount: number;
  stale: number;
  goalMet: boolean;
}>;

const latestReviewsByReviewer = (
  registry: AuditRegistry,
  reviews: readonly AuditModuleReview[],
): readonly AuditModuleReview[] => {
  const runs = new Map(registry.agentRuns.map(run => [run.id, run]));
  const latest = new Map<string, AuditModuleReview>();
  for (const review of [...reviews].sort((left, right) => (
    Date.parse(left.recordedAt) - Date.parse(right.recordedAt)
    || left.id.localeCompare(right.id)
  ))) {
    const reviewerId = runs.get(review.agentRunId)?.reviewerId;
    if (reviewerId) latest.set(reviewerId, review);
  }
  return [...latest.values()];
};

export const computeModuleReviewStatus = (
  registry: AuditRegistry,
  moduleId: string,
  moduleFingerprint: string,
  environmentFingerprint: string,
): ModuleReviewStatus => {
  const moduleReviews = registry.moduleReviews.filter(review => review.moduleId === moduleId);
  const current = latestReviewsByReviewer(registry, moduleReviews.filter(review => (
    review.moduleFingerprint === moduleFingerprint
    && review.environmentFingerprint === environmentFingerprint
  )));
  const runs = new Map(registry.agentRuns.map(run => [run.id, run]));
  const reviewers = new Map(registry.reviewers.map(reviewer => [reviewer.id, reviewer]));
  const families = new Set(current.flatMap(review => {
    const reviewerId = runs.get(review.agentRunId)?.reviewerId;
    const family = reviewerId ? reviewers.get(reviewerId)?.family : undefined;
    return family ? [family] : [];
  }));
  const floor = current.length === 0 ? 0 : Math.min(...current.map(review => review.score));
  return {
    floor,
    count: current.length,
    familyCount: families.size,
    stale: moduleReviews.length - current.length,
    goalMet: current.length >= registry.policy.idealReviewQuorum
      && families.size >= registry.policy.idealReviewFamilyQuorum
      && floor >= registry.policy.idealModuleScoreMinimum,
  };
};
