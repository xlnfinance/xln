import { describe, expect, test } from 'bun:test';

import { applyCommand, createBook, type BookState } from '../orderbook/core';
import { createOrderbookExtState, ORDERBOOK_PRICE_SCALE, SWAP_LOT_SCALE } from '../orderbook/types';
import { validateBookAgainstOffers, validateBookStructure, validateEntityOrderbooks } from '../orderbook/validity';
import type { AccountMachine, EntityState, SwapOffer } from '../types';

const makeOffer = (overrides: Partial<SwapOffer> = {}): SwapOffer => ({
  offerId: 'offer-1',
  giveTokenId: 4,
  giveAmount: SWAP_LOT_SCALE,
  wantTokenId: 6,
  wantAmount: (SWAP_LOT_SCALE * 1000n) / ORDERBOOK_PRICE_SCALE,
  priceTicks: 1000n,
  timeInForce: 0,
  minFillRatio: 0,
  makerIsLeft: false,
  createdHeight: 1,
  ...overrides,
});

const makeAccount = (offerId: string, offer: SwapOffer): AccountMachine =>
  ({
    leftEntity: 'alice',
    rightEntity: 'hub',
    status: 'active',
    mempool: [],
    currentFrame: {
      height: 0,
      timestamp: 0,
      jHeight: 0,
      accountTxs: [],
      prevFrameHash: '',
      tokenIds: [],
      deltas: [],
      stateHash: '',
      byLeft: true,
    },
    deltas: new Map(),
    locks: new Map(),
    swapOffers: new Map([[offerId, offer]]),
    globalCreditLimits: { ownLimit: 0n, peerLimit: 0n },
    currentHeight: 0,
    pendingSignatures: [],
    rollbackCount: 0,
    proofHeader: { fromEntity: 'alice', toEntity: 'hub', nonce: 1 },
    proofBody: { tokenIds: [], deltas: [] },
    frameHistory: [],
    pendingWithdrawals: new Map(),
    requestedRebalance: new Map(),
    requestedRebalanceFeeState: new Map(),
    rebalancePolicy: new Map(),
    leftJObservations: [],
    rightJObservations: [],
    jEventChain: [],
    lastFinalizedJHeight: 0,
    disputeConfig: { leftDisputeDelay: 10, rightDisputeDelay: 10 },
    onChainSettlementNonce: 0,
  }) as AccountMachine;

const makeState = (book: BookState, offerId = 'offer-1', offer = makeOffer()): EntityState =>
  ({
    entityId: 'hub',
    height: 1,
    timestamp: 0,
    nonces: new Map(),
    messages: [],
    proposals: new Map(),
    config: {} as EntityState['config'],
    reserves: new Map(),
    accounts: new Map([['alice', makeAccount(offerId, offer)]]),
    lastFinalizedJHeight: 0,
    jBlockObservations: [],
    jBlockChain: [],
    entityEncPubKey: '',
    entityEncPrivKey: '',
    profile: { name: 'Hub', isHub: true, avatar: '', bio: '', website: '' },
    htlcRoutes: new Map(),
    htlcFeesEarned: 0n,
    orderbookExt: {
      ...createOrderbookExtState({
        entityId: 'hub',
        name: 'Hub',
        spreadDistribution: {
          makerBps: 0,
          takerBps: 10_000,
          hubBps: 0,
          makerReferrerBps: 0,
          takerReferrerBps: 0,
        },
        referenceTokenId: 2,
        minTradeSize: 0n,
        supportedPairs: ['4/6'],
      }),
      books: new Map([['4/6', book]]),
    },
    lockBook: new Map(),
  }) as EntityState;

describe('orderbook validity', () => {
  test('accepts structurally valid book and matching open offers', () => {
    const book = applyCommand(
      createBook({ bucketWidthTicks: 100n, maxOrders: 32, stpPolicy: 1 }),
      {
        kind: 0,
        ownerId: 'hub',
        orderId: 'alice:offer-1',
        side: 1,
        tif: 0,
        postOnly: false,
        priceTicks: 1000n,
        qtyLots: 1,
      },
    ).state;

    const state = makeState(book);

    expect(validateBookStructure(book).ok).toBe(true);
    expect(validateBookAgainstOffers(state).ok).toBe(true);
    expect(validateEntityOrderbooks(state).ok).toBe(true);
  });

  test('reports missing, orphaned, and mismatched orders', () => {
    let book = createBook({ bucketWidthTicks: 100n, maxOrders: 32, stpPolicy: 1 });
    book = applyCommand(book, {
      kind: 0,
      ownerId: 'wrong-owner',
      orderId: 'alice:offer-1',
      side: 1,
      tif: 0,
      postOnly: false,
      priceTicks: 1001n,
      qtyLots: 1,
    }).state;
    book = applyCommand(book, {
      kind: 0,
      ownerId: 'ghost',
      orderId: 'ghost:offer-x',
      side: 1,
      tif: 0,
      postOnly: false,
      priceTicks: 1005n,
      qtyLots: 1,
    }).state;

    const report = validateBookAgainstOffers(makeState(book));
    expect(report.ok).toBe(false);
    expect(report.orphanedInBook).toContain('ghost:offer-x');
    expect(report.mismatched.some((item) => item.swapKey === 'alice:offer-1' && item.field === 'priceTicks')).toBe(true);
    expect(report.mismatched.some((item) => item.swapKey === 'alice:offer-1' && item.field === 'ownerId')).toBe(true);
  });

  test('reports invalid open offers that cannot be represented in the book', () => {
    const book = createBook({ bucketWidthTicks: 100n, maxOrders: 32, stpPolicy: 1 });
    const invalidOffer = makeOffer({ giveAmount: SWAP_LOT_SCALE - 1n });
    const report = validateBookAgainstOffers(makeState(book, 'offer-1', invalidOffer));
    expect(report.ok).toBe(false);
    expect(report.invalidOffers).toEqual([{ swapKey: 'alice:offer-1', reason: 'lot-misaligned' }]);
  });

  test('accepts offers with priceTicks above qty-lot limits', () => {
    const hugePriceTicks = 5_000_000_000n;
    const book = applyCommand(
      createBook({ bucketWidthTicks: 100n, maxOrders: 32, stpPolicy: 1 }),
      {
        kind: 0,
        ownerId: 'hub',
        orderId: 'alice:offer-1',
        side: 1,
        tif: 0,
        postOnly: false,
        priceTicks: hugePriceTicks,
        qtyLots: 1,
      },
    ).state;

    const report = validateBookAgainstOffers(makeState(book, 'offer-1', makeOffer({ priceTicks: hugePriceTicks })));
    expect(report.invalidOffers).toEqual([]);
    expect(report.ok).toBe(true);
  });
});
