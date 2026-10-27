import type { EntityFrame } from '../types';

/**
 * Honest multi-validator commit notifications attach at least the Entity-frame
 * quorum Hanko. This classifies transport envelopes only; consensus still
 * verifies the collected signatures and voting power before applying a frame.
 */
export const hasEntityCommitCertificate = (frame: EntityFrame | undefined): boolean =>
  Array.isArray(frame?.hankos) && frame.hankos.length === 1;
