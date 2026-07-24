import { describe, expect, test } from 'bun:test';
import {
  assertQaCandidateIdentity,
  buildQaCandidateIdentity,
  computeQaGateConfigHash,
} from '../qa/candidate';

const gitHead = '1'.repeat(40);
const codeHash = '2'.repeat(64);
const config = {
  runner: 'e2e',
  args: { strict: true, shards: 8 },
  targets: ['a', 'b'],
};

describe('immutable QA candidate identity', () => {
  test('canonicalizes object keys without canonicalizing array order', () => {
    expect(computeQaGateConfigHash(config)).toBe(computeQaGateConfigHash({
      targets: ['a', 'b'],
      args: { shards: 8, strict: true },
      runner: 'e2e',
    }));
    expect(computeQaGateConfigHash(config)).not.toBe(computeQaGateConfigHash({
      ...config,
      targets: ['b', 'a'],
    }));
  });

  test('binds git head, exact source bytes and effective gate config', () => {
    const candidate = buildQaCandidateIdentity({ gitHead, codeHash, gateConfig: config });
    expect(candidate).toEqual({
      candidateId: expect.stringMatching(/^[0-9a-f]{64}$/),
      gitHead,
      codeHash,
      gateConfigHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(buildQaCandidateIdentity({
      gitHead: `3${gitHead.slice(1)}`,
      codeHash,
      gateConfig: config,
    }).candidateId).not.toBe(candidate.candidateId);
    expect(buildQaCandidateIdentity({
      gitHead,
      codeHash: `4${codeHash.slice(1)}`,
      gateConfig: config,
    }).candidateId).not.toBe(candidate.candidateId);
    expect(buildQaCandidateIdentity({
      gitHead,
      codeHash,
      gateConfig: { ...config, args: { strict: false, shards: 8 } },
    }).candidateId).not.toBe(candidate.candidateId);
  });

  test('rejects missing, malformed and mismatched identities', () => {
    expect(() => buildQaCandidateIdentity({
      gitHead: null,
      codeHash,
      gateConfig: config,
    })).toThrow('QA_CANDIDATE_GIT_HEAD_INVALID');
    const candidate = buildQaCandidateIdentity({ gitHead, codeHash, gateConfig: config });
    expect(assertQaCandidateIdentity(candidate, config)).toEqual(candidate);
    expect(() => assertQaCandidateIdentity(candidate, { ...config, runner: 'other' }))
      .toThrow('QA_CANDIDATE_IDENTITY_MISMATCH');
  });

  test('rejects ambiguous non-JSON gate values', () => {
    expect(() => computeQaGateConfigHash({ value: Number.NaN }))
      .toThrow('QA_GATE_CONFIG_NUMBER_INVALID');
    expect(() => computeQaGateConfigHash({ value: 1n }))
      .toThrow('QA_GATE_CONFIG_VALUE_INVALID:bigint');
  });
});
