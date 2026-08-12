import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  computeAuditStatus,
  computeEnvironmentFingerprint,
  listCurrentSourceFiles,
  parseAuditRegistry,
  sha256Text,
  validateAuditRegistry,
  validateEvidenceArtifactBinding,
  validateInvariantCoverage,
} from '../../tools/audit/core';
import {
  EVIDENCE_KINDS,
  type AuditEvidence,
  type AuditModuleReview,
  type AuditRegistry,
} from '../../tools/audit/types';

const ROOT = resolve(import.meta.dir, '../..');
const REGISTRY = parseAuditRegistry(readFileSync(resolve(ROOT, 'audits/registry.json'), 'utf8'));
const ENVIRONMENT = computeEnvironmentFingerprint(ROOT);
const OLD_SHA = '458082a0c26029204233dde3bcb8dde0915aa525';
const CURRENT_SHA = 'ffffffffffffffffffffffffffffffffffffffff';

const exactFaucetEvidence = (fingerprint: string): AuditRegistry => {
  const invariantId = 'public-wallet-api.faucet-policy';
  const primaryId = 'test-faucet-primary';
  const verifierId = 'test-faucet-verifier';
  const baseRun = REGISTRY.agentRuns[0]!;
  const scopedRun = (id: string, reviewerId: string) => ({
    ...baseRun,
    id,
    reviewerId,
    sourceSha: OLD_SHA,
    moduleIds: ['public-wallet-api'],
    invariantIds: [invariantId],
    moduleFingerprints: { 'public-wallet-api': fingerprint },
    scope: 'Exact faucet-policy claim only',
    state: 'COMPLETED' as const,
    confirmedFindingIds: [],
    candidateFindingIds: [],
  });
  const template = REGISTRY.evidence[0]!;
  const evidence: AuditEvidence[] = EVIDENCE_KINDS.map((kind, index) => {
    const command = `test-faucet-${kind}`;
    return {
      ...template,
      id: `test-faucet.${index}`,
      invariantId,
      kind,
      state: 'PASS',
      sourceSha: OLD_SHA,
      moduleFingerprint: fingerprint,
      command,
      commandFingerprint: sha256Text(command),
      environmentFingerprint: ENVIRONMENT,
      summary: `${kind} passed for faucet policy`,
      recordedAt: `2026-08-01T04:00:0${index}Z`,
      agentRunIds: [kind === 'independentVerification' ? verifierId : primaryId],
    };
  });
  return {
    ...REGISTRY,
    evidence,
    agentRuns: [
      ...REGISTRY.agentRuns,
      scopedRun(primaryId, 'claude-opus-faucet-policy'),
      scopedRun(verifierId, 'codex-faucet-policy-verifier'),
    ],
  };
};

test('atomic evidence cannot inflate sibling claims and remains reusable across SHAs', () => {
  const fingerprint = `sha256:${'a'.repeat(64)}`;
  const registry = exactFaucetEvidence(fingerprint);
  expect(validateAuditRegistry(registry)).toEqual([]);
  const fingerprints = new Map(REGISTRY.modules.map(module => [module.id, `sha256:${'b'.repeat(64)}`]));
  fingerprints.set('public-wallet-api', fingerprint);

  const status = computeAuditStatus(registry, fingerprints, CURRENT_SHA, ENVIRONMENT);
  expect(status.sourceSha).not.toBe(OLD_SHA);
  expect(status.invariants.find(invariant => invariant.id === 'public-wallet-api.faucet-policy')?.coverage).toBe(100);
  for (const invariant of status.invariants.filter(candidate => (
    candidate.moduleId === 'public-wallet-api'
    && candidate.id !== 'public-wallet-api.faucet-policy'
  ))) expect(invariant.coverage).toBe(0);
  expect(status.modules.find(module => module.id === 'public-wallet-api')).toMatchObject({
    coverage: 18,
    currentEvidence: 6,
  });
});

test('three narrow runs cannot form a whole-module review quorum', () => {
  const baseRun = REGISTRY.agentRuns.find(candidate => candidate.id === 'faucet-policy-final-verification-20260801')!;
  const fingerprint = baseRun.moduleFingerprints['public-wallet-api']!;
  const reviewerIds = [
    'codex-faucet-policy-verifier',
    'claude-opus-faucet-policy',
    'claude-fable-wallet-delta',
  ];
  const reviewerFamilies = new Map(REGISTRY.reviewers.map(reviewer => [reviewer.id, reviewer.family]));
  expect(new Set(reviewerIds.map(reviewerId => reviewerFamilies.get(reviewerId))).size).toBe(2);
  const runs = reviewerIds.map((reviewerId, index) => ({
    ...baseRun,
    id: `test-narrow-faucet-run-${index}`,
    reviewerId,
    invariantIds: ['public-wallet-api.faucet-policy'],
    moduleFingerprints: { 'public-wallet-api': fingerprint },
    confirmedFindingIds: [],
  }));
  const reviews: AuditModuleReview[] = runs.map((run, index) => ({
    id: `test-narrow-faucet-review-${index}`,
    moduleId: 'public-wallet-api',
    agentRunId: run.id,
    sourceSha: run.sourceSha,
    moduleFingerprint: fingerprint,
    environmentFingerprint: ENVIRONMENT,
    score: 1000,
    confidence: 100,
    blockerFindingIds: [],
    summary: 'Deliberately narrow Faucet review',
    recordedAt: `2026-08-01T04:10:0${index}Z`,
  }));
  const registry: AuditRegistry = {
    ...REGISTRY,
    agentRuns: [...REGISTRY.agentRuns, ...runs],
    moduleReviews: [...REGISTRY.moduleReviews, ...reviews],
  };
  const errors = validateAuditRegistry(registry);
  for (const [index, review] of reviews.entries()) {
    expect(errors).toContain(
      `module review ${review.id} run ${runs[index]!.id} lacks exact whole-module scope`,
    );
  }
  const fingerprints = new Map(REGISTRY.modules.map(module => [module.id, `sha256:${'c'.repeat(64)}`]));
  fingerprints.set('public-wallet-api', fingerprint);
  expect(computeAuditStatus(registry, fingerprints, CURRENT_SHA, ENVIRONMENT).modules
    .find(module => module.id === 'public-wallet-api')).toMatchObject({
    reviewCount: 0,
    staleReviews: 3,
    reviewGoalMet: false,
  });
});

test('every claim-binding artifact field rejects relabeling', () => {
  const evidence = REGISTRY.evidence[0]!;
  const original = JSON.parse(readFileSync(resolve(ROOT, evidence.artifactPath), 'utf8')) as {
    evidence: Array<Record<string, unknown>>;
  };
  expect(validateEvidenceArtifactBinding(evidence, original)).toEqual([]);
  const mutations: ReadonlyArray<readonly [string, unknown]> = [
    ['invariantId', 'public-wallet-api.faucet-policy'],
    ['kind', evidence.kind === 'codeTrace' ? 'l1Regression' : 'codeTrace'],
    ['moduleFingerprint', `sha256:${'d'.repeat(64)}`],
    ['agentRunIds', []],
    ['recordedAt', '2026-08-01T04:20:00Z'],
  ];
  for (const [field, value] of mutations) {
    const artifact = structuredClone(original);
    artifact.evidence.find(candidate => candidate['id'] === evidence.id)![field] = value;
    expect(validateEvidenceArtifactBinding(evidence, artifact)).toEqual([
      `evidence ${evidence.id} does not exactly match its artifact`,
    ]);
  }
});

test('migration never upgrades broad module labels into unrecorded invariant claims', () => {
  const broadRun = REGISTRY.agentRuns.find(candidate => (
    candidate.moduleIds.includes('public-wallet-api')
    && candidate.invariantIds.length === 0
    && Object.keys(candidate.moduleFingerprints).length === 0
  ))!;
  expect(broadRun.moduleIds).toContain('public-wallet-api');
  expect(broadRun.invariantIds).toEqual([]);
  expect(broadRun.moduleFingerprints).toEqual({});

  for (const run of REGISTRY.agentRuns) {
    const exactModules = new Set(run.invariantIds.map(invariantId => (
      REGISTRY.invariants.find(invariant => invariant.id === invariantId)!.moduleId
    )));
    expect([...exactModules].every(moduleId => Boolean(run.moduleFingerprints[moduleId]))).toBe(true);
  }
});

test('the exact-scope schema rejects missing fields before validation can crash', () => {
  const malformed = JSON.parse(JSON.stringify(REGISTRY)) as {
    invariants: Array<Record<string, unknown>>;
    agentRuns: Array<Record<string, unknown>>;
  };
  delete malformed.invariants[0]!['sourceGlobs'];
  delete malformed.agentRuns[0]!['moduleFingerprints'];
  expect(() => parseAuditRegistry(JSON.stringify(malformed))).toThrow('invariants[0].sourceGlobs must be an array');
  expect(() => parseAuditRegistry(JSON.stringify(malformed))).toThrow('agentRuns[0].moduleFingerprints must be an object');
});

test('every effective module file has atomic scope while exclusions stay excluded', () => {
  expect(validateInvariantCoverage(REGISTRY, listCurrentSourceFiles(ROOT))).toEqual([]);
  const module = {
    ...REGISTRY.modules[0]!,
    id: 'fixture',
    sourceGlobs: ['fixture/source/**/*.ts'],
    testGlobs: ['fixture/test/**/*.test.ts'],
    dependencies: [],
    exclusions: [],
  };
  const invariant = {
    ...REGISTRY.invariants[0]!,
    id: 'fixture.atomic',
    moduleId: module.id,
    sourceGlobs: ['fixture/source/covered.ts'],
    testGlobs: ['fixture/test/covered.test.ts'],
  };
  const fixture: AuditRegistry = {
    ...REGISTRY,
    scope: { ...REGISTRY.scope, exclusions: [] },
    modules: [module],
    invariants: [invariant],
  };
  const files = [
    'fixture/source/covered.ts',
    'fixture/source/orphan.ts',
    'fixture/test/covered.test.ts',
    'fixture/test/orphan.test.ts',
  ];
  expect(validateInvariantCoverage(fixture, files)).toEqual([
    'module fixture source file has no invariant scope: fixture/source/orphan.ts',
    'module fixture test file has no invariant scope: fixture/test/orphan.test.ts',
  ]);

  const excluded: AuditRegistry = {
    ...fixture,
    scope: {
      ...fixture.scope,
      exclusions: [{ glob: 'fixture/source/orphan.ts', reason: 'Positive global exclusion fixture.' }],
    },
    modules: [{
      ...module,
      exclusions: [{ glob: 'fixture/test/orphan.test.ts', reason: 'Positive module exclusion fixture.' }],
    }],
  };
  expect(validateInvariantCoverage(excluded, files)).toEqual([]);
});
