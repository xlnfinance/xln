import { describe, expect, test } from 'bun:test';

import { bindEntityCandidateToFrame } from '../../../../entity/consensus/candidate-views';
import type { EntityCandidate, EntityFrame } from '../../../../entity/types';

const candidate = {
  frameHash: 'frame',
  height: 2,
  state: { height: 2 },
} as EntityCandidate;
const frame = { hash: 'frame', height: 2 } as EntityFrame;

describe('FinTS Entity candidate view', () => {
  test('binds one candidate to its exact frame without cloning', () => {
    const bound = bindEntityCandidateToFrame(candidate, frame);
    expect(bound.candidate).toBe(candidate);
    expect(bound.frame).toBe(frame);
  });

  test('rejects candidate/frame mixing', () => {
    expect(() => bindEntityCandidateToFrame(candidate, { ...frame, hash: 'other' })).toThrow(
      'ENTITY_VALIDATOR_EXECUTION_FRAME_MISMATCH',
    );
  });
});
