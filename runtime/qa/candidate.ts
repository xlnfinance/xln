import { createHash } from 'node:crypto';

export type QaCandidateIdentity = {
  candidateId: string;
  gitHead: string;
  codeHash: string;
  gateConfigHash: string;
};

const SHA256_HEX = /^[0-9a-f]{64}$/;
const GIT_HEAD_HEX = /^[0-9a-f]{40,64}$/;

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('QA_GATE_CONFIG_NUMBER_INVALID');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const fields = Object.keys(record)
      .filter(key => record[key] !== undefined)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${fields.join(',')}}`;
  }
  throw new Error(`QA_GATE_CONFIG_VALUE_INVALID:${typeof value}`);
};

const sha256 = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

export const computeQaGateConfigHash = (config: unknown): string =>
  sha256(`xln:qa:gate-config:v1\0${canonicalJson(config)}`);

export const buildQaCandidateIdentity = (input: {
  gitHead: string | null;
  codeHash: string;
  gateConfig: unknown;
}): QaCandidateIdentity => {
  const gitHead = String(input.gitHead || '').toLowerCase();
  const codeHash = String(input.codeHash || '').toLowerCase();
  if (!GIT_HEAD_HEX.test(gitHead)) throw new Error('QA_CANDIDATE_GIT_HEAD_INVALID');
  if (!SHA256_HEX.test(codeHash)) throw new Error('QA_CANDIDATE_CODE_HASH_INVALID');
  const gateConfigHash = computeQaGateConfigHash(input.gateConfig);
  const candidateId = sha256(
    `xln:qa:candidate:v1\0${gitHead}\0${codeHash}\0${gateConfigHash}`,
  );
  return { candidateId, gitHead, codeHash, gateConfigHash };
};

export const assertQaCandidateIdentity = (
  identity: QaCandidateIdentity | null | undefined,
  gateConfig: unknown,
): QaCandidateIdentity => {
  if (!identity) throw new Error('QA_CANDIDATE_IDENTITY_MISSING');
  const expected = buildQaCandidateIdentity({
    gitHead: identity.gitHead,
    codeHash: identity.codeHash,
    gateConfig,
  });
  if (
    identity.candidateId !== expected.candidateId ||
    identity.gateConfigHash !== expected.gateConfigHash
  ) {
    throw new Error('QA_CANDIDATE_IDENTITY_MISMATCH');
  }
  return identity;
};
