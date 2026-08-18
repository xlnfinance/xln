import type { EntityFrame } from '../../types';

/**
 * In-process frames whose txs were already bound by `createEntityFrameHashFromStateRoot`.
 * Storage and `validateProposedEntityFrame` must not re-encode those bodies.
 * Restored or peer-supplied frames are new objects and stay unverified.
 */
const verifiedEntityFrameBodies = new WeakSet<EntityFrame>();

export const markEntityFrameBodyVerified = (frame: EntityFrame): void => {
  verifiedEntityFrameBodies.add(frame);
};

export const entityFrameBodyIsVerified = (frame: EntityFrame): boolean =>
  verifiedEntityFrameBodies.has(frame);
