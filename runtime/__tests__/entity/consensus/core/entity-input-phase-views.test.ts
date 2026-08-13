import { describe, expect, test } from 'bun:test';

import {
  ENTITY_INPUT_FIELD_PHASE,
  getEntityInputPhaseCombinationError,
  hasEntityHashPrecommits,
  hasEntityTransactions,
  isEntityLeaderTimeoutInput,
} from '../../../../entity/consensus/input/phase-views';
import type { EntityInput } from '../../../../entity/types';

const base = (): EntityInput => ({ entityId: 'entity', signerId: 'signer' });

describe('FinTS EntityInput phase views', () => {
  test('keeps ordinary phases multiplexed and extracts exact present lanes', () => {
    const input: EntityInput = {
      ...base(),
      entityTxs: [{ type: 'text', data: { message: 'hello' } }],
      hashPrecommitFrame: { height: 1, frameHash: 'frame' },
      hashPrecommits: new Map([['signer', ['signature']]]),
    };
    expect(hasEntityTransactions(input)).toBe(true);
    expect(hasEntityHashPrecommits(input)).toBe(true);
    expect(getEntityInputPhaseCombinationError(input)).toBeNull();
  });

  test('keeps leader timeout on its dedicated lane', () => {
    const vote = {
      entityId: 'entity', voterId: 'signer', targetHeight: 1,
      fromView: 0, toView: 1, signature: 'signature',
    };
    const dedicated: EntityInput = { ...base(), leaderTimeoutVote: vote };
    expect(isEntityLeaderTimeoutInput(dedicated)).toBe(true);
    expect(getEntityInputPhaseCombinationError({ ...dedicated, entityTxs: [] })).toBe(
      'ENTITY_INPUT_LEADER_TIMEOUT_LANE_MIXED',
    );
  });

  test('catalog covers every current wire field deliberately', () => {
    expect(Object.keys(ENTITY_INPUT_FIELD_PHASE).sort()).toEqual([
      'certifiedOutputIdentity', 'entityId', 'entityTxs', 'from',
      'hashPrecommitFrame', 'hashPrecommits', 'jPrefixAttestations',
      'leaderTimeoutVote', 'localRuntimeProtocol', 'proposedFrame',
      'runtimeId', 'signerId',
    ]);
  });
});
