import { keccak256, toUtf8Bytes } from 'ethers';

const JURISDICTION_SIGNER_INDEX_BASE = 100_000;
const JURISDICTION_SIGNER_INDEX_BUCKETS = 1_000_000n;

export const normalizeJurisdictionSignerKey = (jurisdiction: string): string =>
  String(jurisdiction || '').trim().toLowerCase();

/**
 * Keeps every jurisdiction on a stable, non-overlapping HD account path.
 * The human-readable jurisdiction name is canonical because it is persisted in
 * Entity config and is the identity shown by every runtime adapter.
 */
export const deriveJurisdictionSignerIndex = (jurisdiction: string): number => {
  const key = normalizeJurisdictionSignerKey(jurisdiction);
  if (!key) throw new Error('Jurisdiction is required for jurisdiction signer derivation');
  const digest = keccak256(toUtf8Bytes(`xln:jurisdiction-signer:v1:${key}`));
  return JURISDICTION_SIGNER_INDEX_BASE + Number(BigInt(digest) % JURISDICTION_SIGNER_INDEX_BUCKETS);
};
