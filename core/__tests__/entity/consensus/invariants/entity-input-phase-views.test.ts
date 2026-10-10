import { describe, expect, test } from 'bun:test';

import {
  ENTITY_INPUT_FIELD_PHASE,
  getEntityInputPhaseCombinationError,
  hasEntityHashPrecommits,
  hasEntityTransactions,
  isEntityLeaderTimeoutInput,
} from '../../../../entity/consensus/input/phase-views';
import type { EntityInput } from '../../../../entity/types';
import type { JPrefixAttestation } from '../../../../types/jurisdiction-events';

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

  test('accepts only the per-lane shapes delivery emits', () => {
    // A peer controls both maps. An empty bundle merged into an honest
    // proposal stripped its frame reference; two attestations threw in the
    // input merge key after Runtime mutation started (halt).
    const frame = { height: 1, frameHash: 'frame' };
    expect(getEntityInputPhaseCombinationError({
      ...base(), hashPrecommitFrame: frame, hashPrecommits: new Map(),
    })).toBe('ENTITY_INPUT_PRECOMMIT_BUNDLE_EMPTY');
    const attestation = {} as JPrefixAttestation;
    expect(getEntityInputPhaseCombinationError({
      ...base(), jPrefixAttestations: new Map([['a', attestation], ['b', attestation]]),
    })).toBe('ENTITY_INPUT_J_PREFIX_MUST_BE_SPLIT');
    expect(getEntityInputPhaseCombinationError({
      ...base(), jPrefixAttestations: new Map(),
    })).toBe('ENTITY_INPUT_J_PREFIX_MUST_BE_SPLIT');
    expect(getEntityInputPhaseCombinationError({
      ...base(), jPrefixAttestations: new Map([['a', attestation]]),
    })).toBeNull();
  });

  test('catalog covers every current wire field deliberately', () => {
    expect(Object.keys(ENTITY_INPUT_FIELD_PHASE).sort()).toEqual([
      'entityId', 'entityTxs', 'from',
      'hashPrecommitFrame', 'hashPrecommits', 'jPrefixAttestations',
      'leaderTimeoutVote', 'proposedFrame',
      'runtimeId', 'signerId',
    ]);
  });
});
