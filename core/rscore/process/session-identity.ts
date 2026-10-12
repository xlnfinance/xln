import { createHash } from 'node:crypto';
import { hexToWireBytes } from '../shadow-wire';

const authorityBindingDigest = (domain: string, ...parts: readonly Uint8Array[]): Buffer => {
  const hasher = createHash('sha256')
    .update(domain, 'utf8')
    .update(Buffer.from([0]));
  for (const part of parts) hasher.update(part);
  return hasher.digest();
};

/**
 * Bind every process transcript to the sovereign Runtime and Account owner it
 * serves. Constant identities let a reply from one packed Runtime satisfy the
 * header checks of another; random identities make deterministic recovery
 * needlessly depend on host entropy. The real Runtime and owner identifiers
 * are fixed-width, so their concatenation is unambiguous under separate
 * domains.
 */
export const authoritySessionIdentityFor = (
  runtimeIdValue: string,
  ownerEntityId: string,
): Readonly<{
  engineGeneration: Buffer;
  runtimeId: Buffer;
  sessionId: Buffer;
}> => {
  const runtimeId = Buffer.from(hexToWireBytes(runtimeIdValue, 20, 'RSCORE_AUTHORITY_RUNTIME_ID_BYTES'));
  const ownerId = Buffer.from(hexToWireBytes(ownerEntityId, 32, 'RSCORE_AUTHORITY_OWNER_ID_BYTES'));
  return {
    engineGeneration: authorityBindingDigest('xln.rscore.engine-generation.v1', runtimeId).subarray(0, 8),
    runtimeId,
    sessionId: authorityBindingDigest('xln.rscore.authority-session.v1', runtimeId, ownerId).subarray(0, 16),
  };
};
