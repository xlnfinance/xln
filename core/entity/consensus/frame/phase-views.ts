import type { HankoString } from '../../../types/hanko';
import type { EntityFrame } from '../../types';

export type DraftEntityFrame = EntityFrame & {
  collectedSigs?: never;
  hankos?: never;
};

export type LockedEntityFrame = EntityFrame & {
  collectedSigs: Map<string, string[]>;
};

export type CertifiedEntityFrame = Omit<LockedEntityFrame, 'hankos'> & {
  /** Commit marker and proof for hashesToSign[0], the EntityFrame hash. */
  hankos: [HankoString];
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
  && frame.hankos.length === 1
  && typeof frame.hankos[0] === 'string'
  && frame.hankos[0].length > 0
  && frame.hashesToSign[0]?.type === 'entityFrame'
  && frame.hashesToSign[0].hash === frame.hash;

export const requireCertifiedEntityFrameAfterQuorum = (
  frame: EntityFrame,
): CertifiedEntityFrame => {
  if (!hasCertifiedEntityFrameProofShape(frame)) {
    throw new Error(`ENTITY_FRAME_CERTIFIED_PROOF_SHAPE_INVALID:${frame.hash}`);
  }
  return frame;
};
