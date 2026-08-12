import { describe, expect, test } from 'bun:test';

import type { EntityOutput } from '../entity/types';
import { filterEntityFrameBroadcastContinuations } from '../entity/consensus/jurisdiction/broadcast-continuation';
import { assertEntityJBroadcastOrder } from '../entity/consensus/frame/application';
import {
  shouldAutoBroadcastDraft,
  takeBroadcastBatch,
} from '../entity/tx/handlers/j-broadcast';
import { initJBatch } from '../jurisdiction/machine/batch';
import {
  entity,
  secret,
} from './helpers/cross-j';

const self = `0x${'11'.repeat(32)}`;
const signer = `0x${'22'.repeat(20)}`;
const broadcast = (): EntityOutput => ({
  entityId: self,
  signerId: signer,
  entityTxs: [{ type: 'j_broadcast', data: {} }],
});

describe('Entity-frame j_broadcast continuation ownership', () => {
  test('manual broadcast is unique and last so it owns all prior draft work', () => {
    const draft = { type: 'chat', data: { message: 'draft work' } } as never;
    const manual = { type: 'j_broadcast', data: {} } as never;
    expect(assertEntityJBroadcastOrder([draft, manual])).toBe(true);
    expect(() => assertEntityJBroadcastOrder([manual, draft]))
      .toThrow('ENTITY_J_BROADCAST_MUST_BE_LAST');
    expect(() => assertEntityJBroadcastOrder([manual, manual]))
      .toThrow('ENTITY_J_BROADCAST_DUPLICATE');
  });

  test('dedupes handler requests and preserves unrelated outputs', () => {
    const unrelated: EntityOutput = {
      entityId: `0x${'33'.repeat(32)}`,
      entityTxs: [{ type: 'chat', data: { message: 'preserve me' } }],
    };
    expect(filterEntityFrameBroadcastContinuations(
      [],
      [broadcast(), unrelated, broadcast()],
      self,
      false,
      false,
    )).toEqual([broadcast(), unrelated]);
  });

  test('manual enclosing broadcast and sentBatch each suppress handler continuation', () => {
    expect(filterEntityFrameBroadcastContinuations([], [broadcast()], self, true, false)).toEqual([]);
    expect(filterEntityFrameBroadcastContinuations([], [broadcast()], self, false, true)).toEqual([]);
  });

  test('an earlier handler owns the only continuation for the frame', () => {
    expect(filterEntityFrameBroadcastContinuations(
      [broadcast()],
      [broadcast()],
      self,
      false,
      false,
    )).toEqual([]);
  });

  test('registration-priority split keeps an unrelated remainder auto-broadcastable', () => {
    const batchState = initJBatch();
    const proofbody = {
      watchSeed: secret('44'),
      leftResponseSeconds: 10n,
      rightResponseSeconds: 10n,
      offdeltas: [],
      tokenIds: [],
      transformers: [],
    };
    batchState.batch.disputeStarts.push({
      counterentity: entity('55'),
      nonce: 1,
      proofbodyHash: secret('66'),
      initialProofbody: proofbody,
      watchSeed: proofbody.watchSeed,
      sig: '0x1234',
      starterInitialArguments: '0x',
      starterCounterArguments: '0x',
        starterCounterProofCommitment: '0x0000000000000000000000000000000000000000000000000000000000000000',
    });
    batchState.batch.hashLadderRegistrations.push({
      counterpartyEntity: entity('55'),
      targetRole: true,
      fullHash: secret('67'),
      partialRoot: secret('68'),
      witness: {
        fillRatio: 1,
        fullSecret: secret('00'),
        reveals: [secret('01'), secret('02'), secret('03'), secret('04')],
      },
    });
    batchState.batch.reserveToReserve.push({
      receivingEntity: entity('77'),
      tokenId: 1,
      amount: 5n,
    });

    const { selected, remainder } = takeBroadcastBatch(batchState.batch);
    expect(selected.hashLadderRegistrations).toHaveLength(1);
    expect(selected.reserveToReserve).toEqual([]);
    expect(remainder.reserveToReserve).toHaveLength(1);
    expect(shouldAutoBroadcastDraft(remainder)).toBe(true);
  });
});
