import type { EntityCandidate, EntityFrame } from '../types';

export type EntityCandidateForFrame = Readonly<{
  candidate: EntityCandidate;
  frame: EntityFrame;
}>;

/**
 * Bind validator-private speculative state to the one frame it can commit.
 * This ephemeral view adds no field to either durable candidate or signed
 * frame, so it cannot change consensus bytes.
 */
export const bindEntityCandidateToFrame = (
  candidate: EntityCandidate,
  frame: EntityFrame,
): EntityCandidateForFrame => {
  if (
    candidate.frameHash !== frame.hash
    || candidate.height !== frame.height
    || candidate.state.height !== frame.height
  ) {
    throw new Error(
      `ENTITY_VALIDATOR_EXECUTION_FRAME_MISMATCH:execution=${candidate.height}:${candidate.frameHash}:`
      + `frame=${frame.height}:${frame.hash}`,
    );
  }
  return { candidate, frame };
};
