/** Compact Entity-layer commitment to one exact AccountInput. */

import { encodeCanonicalConsensusBytes } from '../../../protocol/serialization/binary-codec';
import { computeIntegrityDigest } from '../../../support/bytes/integrity-checksum';

const DOMAIN = 'xln:account-input-commitment:v1';
const DOMAIN_BYTES = new TextEncoder().encode(DOMAIN);

export const canonicalAccountInputCommitment = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('ACCOUNT_INPUT_COMMITMENT_OBJECT_REQUIRED');
  }
  const inputBytes = encodeCanonicalConsensusBytes(value);
  const preimage = new Uint8Array(DOMAIN_BYTES.byteLength + inputBytes.byteLength);
  preimage.set(DOMAIN_BYTES, 0);
  preimage.set(inputBytes, DOMAIN_BYTES.byteLength);
  return { domain: DOMAIN, inputDigest: computeIntegrityDigest(preimage) };
};
