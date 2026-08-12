import { describe, expect, test } from 'bun:test';

import {
  batchAddHashLadderRegistration,
  createEmptyBatch,
  initJBatch,
} from '../jurisdiction/machine/batch';
import { takeBroadcastBatch } from '../entity/tx/handlers/jurisdiction/j-broadcast';
import {
  scrubDisputeFinalizationsForCounterparty,
  scrubDisputeStartsForCounterparty,
  scrubCounterDisputesSupersededByObserved,
  scrubSourceHashLadderRegistrationsForCounterparty,
} from '../entity/tx/dispute-finalize-guards';
import { hashProofBodyStruct } from '../protocol/dispute/proof-builder';
import {
  sentBatchOwnsDisputeFinalityAck,
  terminalizeCrossJurisdictionRoutesOnFinality,
} from '../entity/tx/j-events';
import { flushDeferredHashLadderReveals } from '../entity/tx/j-events-htlc';
import type { CrossJurisdictionSwapRoute } from '../types/cross-jurisdiction';
import { addr, entity, makeJurisdiction, makeState } from './helpers/cross-j';

const hash = (byte: string): string => `0x${byte.repeat(64)}`;

const registration = (counterparty: string) => ({
  counterpartyEntity: counterparty,
  targetRole: true,
  fullHash: hash('1'),
  partialRoot: hash('2'),
  witness: {
    fillRatio: 0x1000,
    fullSecret: hash('0'),
    reveals: [hash('3'), hash('4'), hash('5'), hash('6')] as [string, string, string, string],
  },
});

describe('hash-ladder / dispute batch ordering', () => {
  test('self-sender finality keeps a sent batch only with its exact Hanko batch nonce', () => {
    const self = entity('41');
    const counterparty = entity('42');
    const initialProofbodyHash = hash('7');
    const state = makeState(self, addr('71'), makeJurisdiction('Ethereum', 1, '11', '12'), counterparty);
    const sent = createEmptyBatch();
    sent.disputeFinalizations.push({ counterentity: counterparty, initialProofbodyHash } as never);
    state.jBatchState = initJBatch();
    state.jBatchState.sentBatch = {
      batch: sent,
      batchHash: hash('8'),
      encodedBatch: '0x',
      entityNonce: 7,
      firstSubmittedAt: 1,
      lastSubmittedAt: 1,
      submitAttempts: 1,
    };

    expect(sentBatchOwnsDisputeFinalityAck(state, counterparty, initialProofbodyHash, undefined)).toBe(false);
    expect(sentBatchOwnsDisputeFinalityAck(state, counterparty, initialProofbodyHash, 6)).toBe(false);
    expect(sentBatchOwnsDisputeFinalityAck(state, counterparty, initialProofbodyHash, 7)).toBe(true);
  });

  test('competing start removes only unmineable starts and preserves independent reveals', () => {
    const counterparty = entity('52');
    const batch = createEmptyBatch();
    batch.disputeStarts.push({ counterentity: counterparty } as never);
    batch.disputeStarts.push({ counterentity: entity('53') } as never);
    batch.hashLadderRegistrations.push(registration(counterparty));

    expect(scrubDisputeStartsForCounterparty(batch, counterparty)).toBe(1);
    expect(batch.disputeStarts).toHaveLength(1);
    expect(batch.hashLadderRegistrations).toHaveLength(1);
  });

  test('external finality removes only stale finalization and preserves independent reveals', () => {
    const counterparty = entity('62');
    const batch = createEmptyBatch();
    batch.disputeFinalizations.push({ counterentity: counterparty } as never);
    batch.hashLadderRegistrations.push(registration(counterparty));
    batch.hashLadderRegistrations.push({ ...registration(counterparty), targetRole: false });
    batch.hashLadderRegistrations.push({ ...registration(entity('63')), targetRole: false });

    expect(scrubDisputeFinalizationsForCounterparty(batch, counterparty)).toBe(1);
    expect(scrubSourceHashLadderRegistrationsForCounterparty(batch, counterparty)).toBe(1);
    expect(batch.disputeFinalizations).toHaveLength(0);
    expect(batch.hashLadderRegistrations).toEqual([
      expect.objectContaining({ counterpartyEntity: counterparty, targetRole: true }),
      expect.objectContaining({ counterpartyEntity: entity('63'), targetRole: false }),
    ]);
  });

  test('observed counter-proof preserves a strictly better queued branch', () => {
    const counterparty = entity('69');
    const body = {
      watchSeed: hash('9'),
      leftResponseSeconds: 10,
      rightResponseSeconds: 10,
      offdeltas: [],
      tokenIds: [],
      transformers: [],
    };
    const observedHash = hashProofBodyStruct(body);
    const batch = createEmptyBatch();
    batch.counterDisputes.push(
      { counterentity: counterparty, counterNonce: 9, proposerIsLeft: false, counterProofbody: body } as never,
      { counterentity: counterparty, counterNonce: 10, proposerIsLeft: false, counterProofbody: body } as never,
      { counterentity: counterparty, counterNonce: 11, proposerIsLeft: false, counterProofbody: body } as never,
    );

    expect(scrubCounterDisputesSupersededByObserved(
      batch, counterparty, 10, false, observedHash, false,
    )).toBe(2);
    expect(batch.counterDisputes.map(item => item.counterNonce)).toEqual([11]);

    batch.counterDisputes.push(
      { counterentity: counterparty, counterNonce: 10, proposerIsLeft: false, counterProofbody: body } as never,
    );
    expect(scrubCounterDisputesSupersededByObserved(
      batch, counterparty, 10, false, observedHash, true,
    )).toBe(0);
    expect(batch.counterDisputes.map(item => item.counterNonce)).toEqual([11, 10]);
  });

  test('broadcast publishes accepted reveal evidence before a queued finalization', () => {
    const counterparty = entity('72');
    const state = initJBatch();
    batchAddHashLadderRegistration(state, registration(counterparty));
    state.batch.disputeFinalizations.push({ counterentity: counterparty } as never);

    const { selected, remainder } = takeBroadcastBatch(state.batch);
    expect(selected.hashLadderRegistrations).toHaveLength(1);
    expect(selected.disputeFinalizations).toHaveLength(0);
    expect(remainder.hashLadderRegistrations).toHaveLength(0);
    expect(remainder.disputeFinalizations).toHaveLength(1);
  });

  test('route finality clears deferred gas work without deleting public registry state', () => {
    const user = entity('81');
    const hub = entity('82');
    const state = makeState(user, addr('83'), makeJurisdiction('Base', 8453, '21', '22'), hub);
    const route = {
      orderId: 'terminal-reveal',
      makerEntityId: user,
      hubEntityId: hub,
      source: { jurisdiction: 'eth', entityId: user, counterpartyEntityId: hub, tokenId: 1, amount: 100n },
      sourceDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
      target: { jurisdiction: 'base', entityId: hub, counterpartyEntityId: user, tokenId: 1, amount: 90n },
      targetDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
      status: 'resting',
      createdAt: 1,
      updatedAt: 1,
      pendingSourceRegistryReveal: registration(hub).witness,
      pendingTargetRegistryReveal: registration(hub).witness,
    } as CrossJurisdictionSwapRoute;
    state.crossJurisdictionSwaps = new Map([[route.orderId, route]]);
    state.jBatchState = initJBatch();

    terminalizeCrossJurisdictionRoutesOnFinality(state, [{ route, settledRatio: 0 }]);
    expect(route.pendingSourceRegistryReveal).toBeUndefined();
    expect(route.pendingTargetRegistryReveal).toBeUndefined();
    expect(route.status).toBe('cancelled');
    expect(flushDeferredHashLadderReveals(state)).toBe(0);
  });

  test('Account finality cancels a raw cross-j intent before any Pull exposure exists', () => {
    const user = entity('91');
    const hub = entity('92');
    const state = makeState(hub, addr('93'), makeJurisdiction('Ethereum', 1, '11', '12'), user);
    const route = {
      orderId: 'raw-intent-finality',
      makerEntityId: user,
      hubEntityId: hub,
      source: { jurisdiction: 'eth', entityId: user, counterpartyEntityId: hub, tokenId: 1, amount: 100n },
      sourceDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
      target: { jurisdiction: 'base', entityId: entity('94'), counterpartyEntityId: entity('95'), tokenId: 1, amount: 90n },
      targetDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
      status: 'intent',
      createdAt: 1,
      updatedAt: 1,
    } as CrossJurisdictionSwapRoute;
    state.crossJurisdictionSwaps = new Map([[route.orderId, route]]);

    terminalizeCrossJurisdictionRoutesOnFinality(state, [{ route, settledRatio: 0 }]);

    expect(route.status).toBe('cancelled');
    expect(route.sourcePull).toBeUndefined();
    expect(route.targetPull).toBeUndefined();
  });
});
