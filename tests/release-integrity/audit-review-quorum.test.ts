import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  computeAuditStatus,
  computeEnvironmentFingerprint,
  parseAuditRegistry,
  validateAuditRegistry,
} from '../../tools/audit/core';
import type { AuditModuleReview, AuditRegistry } from '../../tools/audit/types';

const ROOT = resolve(import.meta.dir, '../..');
const REGISTRY = parseAuditRegistry(readFileSync(resolve(ROOT, 'audits/registry.json'), 'utf8'));
const CURRENT_SHA = '458082a0c26029204233dde3bcb8dde0915aa525';
const CURRENT_ENVIRONMENT = computeEnvironmentFingerprint(ROOT);

test('module scores require a current three-reviewer two-family 990 floor', () => {
  const moduleId = 'api-auth-custody';
  const fingerprint = `sha256:${'7'.repeat(64)}`;
  const reviewers = ['a', 'b', 'c'].map((suffix, index) => ({
    id: `test-reviewer-${suffix}`,
    label: `Test reviewer ${suffix}`,
    family: index === 1 ? 'claude' : 'codex',
    state: 'PROVISIONAL' as const,
  }));
  const runs = reviewers.map(reviewer => ({
    ...REGISTRY.agentRuns[0]!,
    id: `test-run-${reviewer.id}`,
    reviewerId: reviewer.id,
    sourceSha: CURRENT_SHA,
    moduleIds: [moduleId],
    invariantIds: REGISTRY.invariants
      .filter(invariant => invariant.moduleId === moduleId)
      .map(invariant => invariant.id),
    moduleFingerprints: { [moduleId]: fingerprint },
    confirmedFindingIds: [],
    candidateFindingIds: [],
  }));
  const moduleReviews: AuditModuleReview[] = runs.map((run, index) => ({
    id: `test-module-review-${index}`,
    moduleId,
    agentRunId: run.id,
    sourceSha: CURRENT_SHA,
    moduleFingerprint: fingerprint,
    environmentFingerprint: CURRENT_ENVIRONMENT,
    score: index === 0 ? 990 : 997,
    confidence: 99,
    blockerFindingIds: [],
    summary: 'Synthetic current review',
    recordedAt: `2026-08-01T02:00:0${index}Z`,
  }));
  const registry: AuditRegistry = {
    ...REGISTRY,
    reviewers: [...REGISTRY.reviewers, ...reviewers],
    agentRuns: [...REGISTRY.agentRuns, ...runs],
    moduleReviews,
  };
  expect(validateAuditRegistry(registry)).toEqual([]);
  const fingerprints = new Map(REGISTRY.modules.map(module => [module.id, `sha256:${'8'.repeat(64)}`]));
  fingerprints.set(moduleId, fingerprint);
  const current = computeAuditStatus(registry, fingerprints, CURRENT_SHA, CURRENT_ENVIRONMENT);
  expect(current.modules.find(module => module.id === moduleId)).toMatchObject({
    reviewFloor: 990,
    reviewCount: 3,
    reviewFamilyCount: 2,
    staleReviews: 0,
    reviewGoalMet: true,
  });

  fingerprints.set(moduleId, `sha256:${'9'.repeat(64)}`);
  const stale = computeAuditStatus(registry, fingerprints, CURRENT_SHA, CURRENT_ENVIRONMENT);
  expect(stale.modules.find(module => module.id === moduleId)).toMatchObject({
    reviewFloor: 0,
    reviewCount: 0,
    staleReviews: 3,
    reviewGoalMet: false,
  });

  const invalid: AuditRegistry = {
    ...registry,
    moduleReviews: [{
      ...moduleReviews[0]!,
      score: 1000,
      blockerFindingIds: [REGISTRY.findings[0]!.id],
    }],
  };
  expect(validateAuditRegistry(invalid)).toContain(
    `module review ${moduleReviews[0]!.id} cannot meet the ideal score while declaring blockers`,
  );
});
