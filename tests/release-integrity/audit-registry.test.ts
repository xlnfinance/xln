import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  computeAuditStatus,
  computeEnvironmentFingerprint,
  computeModuleFingerprints,
  evaluateAuditGate,
  parseAuditRegistry,
  sha256Text,
  validateAuditRegistry,
} from '../../tools/audit/core';
import {
  EVIDENCE_KINDS,
  type AuditEvidence,
  type AuditRegistry,
} from '../../tools/audit/types';

const ROOT = resolve(import.meta.dir, '../..');
const REGISTRY_PATH = resolve(ROOT, 'audits/registry.json');
const REGISTRY = parseAuditRegistry(readFileSync(REGISTRY_PATH, 'utf8'));
const CURRENT_SHA = '458082a0c26029204233dde3bcb8dde0915aa525';
const CURRENT_ENVIRONMENT = computeEnvironmentFingerprint(ROOT);

describe('canonical audit registry', () => {
  test('maps the complete module hierarchy with valid references and source ownership', () => {
    expect(validateAuditRegistry(REGISTRY, ROOT)).toEqual([]);
    expect(REGISTRY.modules).toHaveLength(17);
    expect(REGISTRY.modules.every(module => REGISTRY.invariants.some(invariant => invariant.moduleId === module.id))).toBe(true);
    expect(REGISTRY.agentRuns.length).toBeGreaterThanOrEqual(12);
    expect(REGISTRY.agentRuns.every(run => run.provisional)).toBe(true);
  });

  test('fingerprints are deterministic and dependency-aware', () => {
    const first = computeModuleFingerprints(ROOT, REGISTRY);
    const second = computeModuleFingerprints(ROOT, REGISTRY);
    expect(first).toEqual(second);
    expect(first.size).toBe(REGISTRY.modules.length);
    for (const fingerprint of first.values()) {
      expect(fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
    expect(first.get('release-supply-chain')).not.toBe(first.get('wallet-frontend'));

    const changedProtocol: AuditRegistry = {
      ...REGISTRY,
      invariants: REGISTRY.invariants.map(invariant => invariant.id === 'protocol-primitives.canonical-determinism'
        ? { ...invariant, title: `${invariant.title} changed` }
        : invariant),
    };
    const changed = computeModuleFingerprints(ROOT, changedProtocol);
    expect(changed.get('account-consensus')).not.toBe(first.get('account-consensus'));
  });

  test('coverage requires every current evidence class and becomes stale on fingerprint drift', () => {
    const target = REGISTRY.invariants.find(invariant => invariant.id === 'api-auth-custody.secret-confinement')!;
    const currentFingerprint = `sha256:${'a'.repeat(64)}`;
    const evidence: AuditEvidence[] = EVIDENCE_KINDS.map((kind, index) => ({
      id: `test-evidence.${index}`,
      invariantId: target.id,
      kind,
      state: 'PASS',
      sourceSha: CURRENT_SHA,
      moduleFingerprint: currentFingerprint,
      command: `test-${kind}`,
      commandFingerprint: sha256Text(`test-${kind}`),
      environmentFingerprint: CURRENT_ENVIRONMENT,
      artifactPath: 'audits/evidence/baseline-458082a0c.json',
      artifactFingerprint: REGISTRY.evidence[0]!.artifactFingerprint,
      summary: `${kind} passed`,
      recordedAt: `2026-08-01T00:00:0${index}Z`,
      agentRunIds: [],
    }));
    const registry: AuditRegistry = { ...REGISTRY, evidence };
    const fingerprints = new Map(REGISTRY.modules.map(module => [module.id, `sha256:${'b'.repeat(64)}`]));
    fingerprints.set(target.moduleId, currentFingerprint);
    const current = computeAuditStatus(registry, fingerprints, CURRENT_SHA, CURRENT_ENVIRONMENT);
    expect(current.invariants.find(invariant => invariant.id === target.id)?.coverage).toBe(100);
    expect(current.modules.find(module => module.id === target.moduleId)).toMatchObject({
      coverage: 50,
      quality: 70,
      state: 'IN_REVIEW',
      currentEvidence: 6,
      staleEvidence: 0,
    });

    fingerprints.set(target.moduleId, `sha256:${'c'.repeat(64)}`);
    const stale = computeAuditStatus(registry, fingerprints, CURRENT_SHA, CURRENT_ENVIRONMENT);
    expect(stale.invariants.find(invariant => invariant.id === target.id)).toMatchObject({
      coverage: 0,
      staleEvidence: EVIDENCE_KINDS,
    });
    expect(stale.modules.find(module => module.id === target.moduleId)).toMatchObject({
      state: 'STALE',
      currentEvidence: 0,
      staleEvidence: 6,
    });

    const refreshed: AuditRegistry = {
      ...registry,
      evidence: [
        ...evidence,
        ...evidence.map((item, index) => ({
          ...item,
          id: `test-refreshed.${index}`,
          moduleFingerprint: fingerprints.get(target.moduleId)!,
          recordedAt: `2026-08-01T01:00:0${index}Z`,
        })),
      ],
    };
    const reAudited = computeAuditStatus(refreshed, fingerprints, CURRENT_SHA, CURRENT_ENVIRONMENT);
    expect(reAudited.staleEvidence).toBe(0);
    expect(reAudited.modules.find(module => module.id === target.moduleId)).toMatchObject({
      state: 'IN_REVIEW',
      currentEvidence: 6,
      staleEvidence: 0,
    });
  });

  test('one cross-module P1 blocks every invariant owner it affects', () => {
    const fingerprints = new Map(REGISTRY.modules.map(module => [module.id, `sha256:${'d'.repeat(64)}`]));
    const status = computeAuditStatus(REGISTRY, fingerprints, CURRENT_SHA, CURRENT_ENVIRONMENT);
    expect(status.modules.find(module => module.id === 'contracts-governance')?.state).toBe('BLOCKED');
    expect(status.modules.find(module => module.id === 'release-supply-chain')?.state).toBe('BLOCKED');

    const accountFinding: AuditRegistry = {
      ...REGISTRY,
      evidence: [],
      findings: [{
        ...REGISTRY.findings[0]!,
        id: 'AUD-ACCOUNT-DEPENDENCY-BLOCK',
        rootCauseKey: 'account-dependency-block',
        moduleId: 'account-consensus',
        invariantIds: ['account-consensus.bilateral-convergence'],
        title: 'Synthetic dependency blocker',
        sourceSha: CURRENT_SHA,
      }],
    };
    const propagated = computeAuditStatus(accountFinding, fingerprints, CURRENT_SHA, CURRENT_ENVIRONMENT);
    for (const moduleId of [
      'account-consensus',
      'entity-consensus',
      'runtime-pipeline',
      'registration-payment',
      'markets',
      'public-wallet-api',
      'wallet-frontend',
      'release-supply-chain',
    ]) {
      expect(propagated.modules.find(module => module.id === moduleId)?.state).toBe('BLOCKED');
    }
  });

  test('parsed timestamps choose the actual newest result, not lexical timezone order', () => {
    const target = REGISTRY.invariants.find(invariant => invariant.id === 'api-auth-custody.secret-confinement')!;
    const fingerprint = `sha256:${'e'.repeat(64)}`;
    const template = REGISTRY.evidence[0]!;
    const evidence: AuditEvidence[] = [
      {
        ...template,
        id: 'timestamp.older-pass',
        invariantId: target.id,
        kind: 'codeTrace',
        state: 'PASS',
        moduleFingerprint: fingerprint,
        environmentFingerprint: CURRENT_ENVIRONMENT,
        recordedAt: '2026-08-01T12:00:00+12:00',
      },
      {
        ...template,
        id: 'timestamp.newer-fail',
        invariantId: target.id,
        kind: 'codeTrace',
        state: 'FAIL',
        moduleFingerprint: fingerprint,
        environmentFingerprint: CURRENT_ENVIRONMENT,
        recordedAt: '2026-08-01T01:00:00Z',
      },
    ];
    const registry: AuditRegistry = { ...REGISTRY, evidence, findings: [] };
    const fingerprints = new Map(REGISTRY.modules.map(module => [module.id, `sha256:${'f'.repeat(64)}`]));
    fingerprints.set(target.moduleId, fingerprint);
    const status = computeAuditStatus(registry, fingerprints, CURRENT_SHA, CURRENT_ENVIRONMENT);
    expect(status.invariants.find(invariant => invariant.id === target.id)?.coverage).toBe(0);
  });

  test('fabricated evidence and malformed enums fail validation', () => {
    const target = REGISTRY.invariants[0]!;
    const fabricated: AuditRegistry = {
      ...REGISTRY,
      evidence: target.requiredEvidence.map((kind, index) => ({
        ...REGISTRY.evidence[0]!,
        id: `fabricated.${index}`,
        invariantId: target.id,
        kind,
        command: 'true',
        commandFingerprint: sha256Text('true'),
        agentRunIds: [],
      })),
      findings: [{
        ...REGISTRY.findings[0]!,
        severity: 'P9',
      } as never],
    };
    const errors = validateAuditRegistry(fabricated);
    expect(errors.some(error => error.includes('has no attesting agent run'))).toBe(true);
    expect(errors).toContain(`finding ${REGISTRY.findings[0]!.id} has invalid severity P9`);

    const splitTarget = REGISTRY.invariants.find(
      invariant => invariant.id === 'api-auth-custody.secret-confinement',
    )!;
    const splitSourceSha = REGISTRY.agentRuns.find(
      run => run.id === 'transport-topology-primary-20260801',
    )!.sourceSha;
    const splitAttestation: AuditRegistry = {
      ...REGISTRY,
      evidence: [{
        ...REGISTRY.evidence[0]!,
        id: 'split-attestation',
        invariantId: splitTarget.id,
        sourceSha: splitSourceSha,
        agentRunIds: ['wallet-hardening-xhigh-20260801', 'transport-topology-primary-20260801'],
      }],
    };
    expect(validateAuditRegistry(splitAttestation)).toContain(
      `evidence split-attestation has no same-run attester scoped to ${splitTarget.moduleId} on source SHA ${splitSourceSha}`,
    );
  });

  test('merge and release gates consume blockers, confidence, staleness, and coverage policy', () => {
    const fingerprints = computeModuleFingerprints(ROOT, REGISTRY);
    const status = computeAuditStatus(REGISTRY, fingerprints, CURRENT_SHA, CURRENT_ENVIRONMENT);
    expect(evaluateAuditGate(REGISTRY, status, 'merge').ok).toBe(false);
    const release = evaluateAuditGate(REGISTRY, status, 'release');
    expect(release.ok).toBe(false);
    expect(release.failures.some(failure => failure.includes('critical coverage'))).toBe(true);
    expect(release.failures.some(failure => failure.includes('review goal unmet'))).toBe(true);
    expect(evaluateAuditGate(REGISTRY, status, 'ideal').ok).toBe(false);
  });

  test('duplicate and dangling references fail loudly', () => {
    const duplicate: AuditRegistry = {
      ...REGISTRY,
      modules: [...REGISTRY.modules, REGISTRY.modules[0]!],
      findings: [
        ...REGISTRY.findings,
        {
          ...REGISTRY.findings[0]!,
          id: 'AUD-DANGLING-INVARIANT',
          invariantIds: ['missing.invariant'],
        },
      ],
    };
    const errors = validateAuditRegistry(duplicate);
    expect(errors).toContain(`module id is duplicated: ${REGISTRY.modules[0]!.id}`);
    expect(errors).toContain('finding AUD-DANGLING-INVARIANT has unknown invariant missing.invariant');
  });
});
