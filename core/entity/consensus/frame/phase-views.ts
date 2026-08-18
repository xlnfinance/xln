import type { HankoString } from '../../../types/hanko';
import type { EntityFrame } from '../../types';

export type DraftEntityFrame = EntityFrame & {
  collectedSigs?: never;
  hankos?: never;
};

export type LockedEntityFrame = EntityFrame & {
  collectedSigs: Map<string, string[]>;
};

export type CertifiedEntityFrame = LockedEntityFrame & {
  hankos: HankoString[];
};

const hasExactSignatureManifest = (
  signatures: Map<string, string[]>,
  hashCount: number,
): boolean => signatures.size > 0 && [...signatures].every(
  ([signerId, values]) => signerId.length > 0
    && values.length === hashCount
    && values.every(value => value.length > 0),
);

export const isDraftEntityFrame = (frame: EntityFrame): frame is DraftEntityFrame =>
  frame.collectedSigs === undefined && frame.hankos === undefined;

export const isLockedEntityFrame = (frame: EntityFrame): frame is LockedEntityFrame =>
  frame.collectedSigs instanceof Map
    && hasExactSignatureManifest(frame.collectedSigs, frame.hashesToSign.length);

/**
 * A proof-shape predicate, not an authority verifier. Callers may use the
 * narrowed view only after their owning consensus path has verified the
 * signatures and rebuilt the quorum Hankos for this exact manifest.
 */
export const hasCertifiedEntityFrameProofShape = (
  frame: EntityFrame,
): frame is CertifiedEntityFrame => isLockedEntityFrame(frame)
  && Array.isArray(frame.hankos)
  && frame.hankos.length === frame.hashesToSign.length
  && frame.hankos.every(hanko => typeof hanko === 'string' && hanko.length > 0);

export const requireCertifiedEntityFrameAfterQuorum = (
  frame: EntityFrame,
): CertifiedEntityFrame => {
  if (!hasCertifiedEntityFrameProofShape(frame)) {
    throw new Error(`ENTITY_FRAME_CERTIFIED_PROOF_SHAPE_INVALID:${frame.hash}`);
  }
  return frame;
};
