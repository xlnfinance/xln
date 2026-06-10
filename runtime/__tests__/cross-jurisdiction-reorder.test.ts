import { describe, expect, test } from 'bun:test';

import { buildPreparedCrossJurisdictionRoute } from '../cross-jurisdiction';
import { applyEntityTx } from '../entity-tx/apply';
import { createEmptyEnv } from '../runtime';
import type { CrossJurisdictionSwapRoute } from '../types';
import {
  addr,
  entity,
  installJurisdictions,
  jref,
  makeJurisdiction,
  makeState,
  targetReceiptFor,
} from './helpers/cross-j';

const buildRoute = (
  orderId: string,
  eth = makeJurisdiction('Ethereum', 1, '11', '12'),
  tron = makeJurisdiction('Tron', 2, '21', '22'),
): CrossJurisdictionSwapRoute => buildPreparedCrossJurisdictionRoute({
  orderId,
  makerEntityId: entity('01'),
  hubEntityId: entity('02'),
  bookOwnerEntityId: entity('02'),
  venueId: 'cross:testnet:1/tron:1',
  source: {
    jurisdiction: jref(eth),
    entityId: entity('01'),
    counterpartyEntityId: entity('02'),
    tokenId: 1,
    amount: 1_000_000_000_000_000_000n,
  },
  target: {
    jurisdiction: jref(tron),
    entityId: entity('03'),
    counterpartyEntityId: entity('04'),
    tokenId: 1,
    amount: 900_000_000_000_000_000n,
  },
  priceImprovementMode: 'source_savings',
  status: 'intent',
  createdAt: 1_000,
  updatedAt: 1_000,
  expiresAt: 61_000,
}, { runtimeSeed: orderId, sourceDisputeDelayMs: 5_000, now: 1_000 });

describe('cross-jurisdiction reorder invariants', () => {
  test('source lock is emitted only after a valid committed target receipt', async () => {
    const env = createEmptyEnv('cross-reorder-target-gates-source');
    env.timestamp = 1_000;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const tron = makeJurisdiction('Tron', 2, '21', '22');
    installJurisdictions(env, eth, tron);
    const route = buildRoute('cross-reorder-target-gates-source', eth, tron);
    const state = makeState(route.source.entityId, addr('31'), eth, route.source.counterpartyEntityId);
    state.crossJurisdictionSwaps?.set(route.orderId, { ...route, status: 'target_prepared' });

    const early = await applyEntityTx(env, state, {
      type: 'commitCrossJurisdictionSwap',
      data: { route: { ...route, status: 'target_locked' } },
    });
    expect(early.outputs).toHaveLength(0);
    expect(early.newState.accounts.get(route.source.counterpartyEntityId)?.pulls?.has(route.sourcePull!.pullId))
      .not.toBe(true);
    expect(early.newState.messages.at(-1)).toContain('target receipt missing');

    const forgedReceipt = { ...targetReceiptFor(route), signedAmount: route.targetPull!.signedAmount + 1n };
    const forged = await applyEntityTx(env, state, {
      type: 'commitCrossJurisdictionSwap',
      data: {
        route: { ...route, status: 'target_locked', targetReceipt: forgedReceipt },
        targetReceipt: forgedReceipt,
      },
    });
    expect(forged.outputs).toHaveLength(0);
    expect(forged.newState.accounts.get(route.source.counterpartyEntityId)?.pulls?.has(route.sourcePull!.pullId))
      .not.toBe(true);
    expect(forged.newState.messages.at(-1)).toContain('CROSS_J_BOOK_ADMISSION_RECEIPT_MISMATCH');

    const targetReceipt = targetReceiptFor(route);
    const committed = await applyEntityTx(env, state, {
      type: 'commitCrossJurisdictionSwap',
      data: {
        route: { ...route, status: 'target_locked', targetReceipt },
        targetReceipt,
      },
    });
    const emittedTxTypes = committed.outputs.flatMap(output => output.entityTxs?.map(tx => tx.type) ?? []);
    expect(emittedTxTypes).toEqual(['pullLock', 'placeSwapOffer']);
    expect(committed.newState.crossJurisdictionSwaps?.get(route.orderId)?.status).toBe('resting');
  });
});
