import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { computeAuditStatus } from '../audit/status';
import { parseAuditRegistry } from '../audit/validation';
import type { AuditEvidence, AuditRegistry } from '../audit/types';

const base = parseAuditRegistry(readFileSync(resolve(import.meta.dir, '../../audits/registry.json'), 'utf8'));

test('failed and quota-blocked chunks never count as completed evidence', () => {
  const invariant = {
    ...base.invariants[0]!,
    requiredEvidence: ['codeTrace', 'l1Regression', 'l2TargetedFlow'] as const,
  };
  const evidence: AuditEvidence[] = invariant.requiredEvidence.map((kind, index) => ({
    ...base.evidence[0]!,
    id: `chunk.${index}`,
    invariantId: invariant.id,
    kind,
    state: index === 1 ? 'FAIL' : 'PASS',
    moduleFingerprint: index === 2 ? 'old-source' : 'current-source',
    environmentFingerprint: 'current-environment',
    agentRunIds: [`run.${index}`],
  }));
  const registry: AuditRegistry = {
    ...base,
    modules: [base.modules.find(module => module.id === invariant.moduleId)!],
    invariants: [invariant],
    evidence,
    findings: [],
    moduleReviews: [],
    agentRuns: [
      ...evidence.map(item => ({
        ...base.agentRuns[0]!,
        id: item.agentRunIds[0]!,
        state: 'COMPLETED' as const,
        sourceSha: item.sourceSha,
        moduleIds: [invariant.moduleId],
        invariantIds: [invariant.id],
        moduleFingerprints: { [invariant.moduleId]: item.moduleFingerprint },
      })),
      { ...base.agentRuns[0]!, id: 'quota-blocked', state: 'BLOCKED', summary: 'Provider quota exhausted' },
    ],
  };
  const status = computeAuditStatus(
    registry,
    new Map([[invariant.moduleId, 'current-source']]),
    'head',
    'current-environment',
  );
  expect(status).toMatchObject({
    currentEvidence: 1,
    failedEvidence: 1,
    staleEvidence: 1,
    blockedRunIds: ['quota-blocked'],
  });
  expect(status.modules[0]).toMatchObject({ currentEvidence: 1, failedEvidence: 1, staleEvidence: 1 });
  expect(status.invariants[0]).toMatchObject({
    failedEvidence: ['l1Regression'],
    staleEvidence: ['l2TargetedFlow'],
    missingEvidence: ['l1Regression', 'l2TargetedFlow'],
  });
  const failedOnly = computeAuditStatus(
    { ...registry, evidence: evidence.filter(item => item.state === 'FAIL') },
    new Map([[invariant.moduleId, 'current-source']]),
    'head',
    'current-environment',
  );
  expect(failedOnly).toMatchObject({
    currentEvidence: 0,
    coverage: 0,
    failedEvidence: 1,
    blockedRunIds: ['quota-blocked'],
  });
  expect(failedOnly.modules[0]?.state).toBe('IN_REVIEW');
  const weights = registry.policy.evidenceWeights;
  expect(status.coverage).toBe(
    Math.round((1000 * weights.codeTrace) / (weights.codeTrace + weights.l1Regression + weights.l2TargetedFlow)) / 10,
  );
});
