/**
 * Price Improvement Tests
 *
 * Demonstrates and tests that takers get execution at maker prices,
 * not at their own (worse) limit price.
 *
 * The orderbook core (core.ts) correctly matches at maker prices,
 * but swap_resolve must settle at those prices too — not at the
 * taker's original offer ratio.
 *
 * Two cases:
 * 1. BUY taker: limit 120, book has asks at 100, 110, 120
 *    → should pay 330 (100+110+120), not 360 (3×120)
 * 2. SELL taker: limit 2900, book has bids at 3100, 3000, 2900
 *    → should receive 9000 (3100+3000+2900), not 8700 (3×2900)
 */

import { describe, expect, test } from 'bun:test';
import { createBook, applyCommand, type BookState, type BookEvent } from '../orderbook/core';
import { ORDERBOOK_PRICE_SCALE, SWAP_LOT_SCALE, computeSwapPriceTicks, deriveSide } from '../orderbook/types';
import { handleSwapResolve } from '../account-tx/handlers/swap-resolve';
import type { AccountMachine, AccountTx, SwapOffer } from '../types';
import { createDefaultDelta } from '../validation-utils';

// Helpers
const LOT_SCALE = SWAP_LOT_SCALE; // 10^12
const PRICE_SCALE = ORDERBOOK_PRICE_SCALE; // 10_000n

function makeBook(tick: number, pmin: number, pmax: number): BookState {
  return createBook({ tick, pmin, pmax, maxOrders: 100, stpPolicy: 0 });
}

/** Extract TRADE events from command result */
function getTrades(events: BookEvent[]): Extract<BookEvent, { type: 'TRADE' }>[] {
  return events.filter((e): e is Extract<BookEvent, { type: 'TRADE' }> => e.type === 'TRADE');
}

/** Compute weighted average execution cost from TRADE events (in priceTicks × lots) */
function executionCost(trades: Extract<BookEvent, { type: 'TRADE' }>[]) {
  let totalCost = 0n;
  let totalQty = 0n;
  for (const t of trades) {
    totalCost += BigInt(t.price) * BigInt(t.qty);
    totalQty += BigInt(t.qty);
  }
  return { totalCost, totalQty };
}

/** Convert priceTicks × lots → wei quote amount */
function ticksLotsToWei(cost: bigint): bigint {
  return (cost * LOT_SCALE) / PRICE_SCALE;
}

/** Current swap_resolve math: settles at offer's price ratio */
function currentSettlement(giveAmount: bigint, wantAmount: bigint, fillRatio: number) {
  const MAX = 65535;
  const filledGive = (giveAmount * BigInt(fillRatio)) / BigInt(MAX);
  const filledWant = giveAmount > 0n
    ? (filledGive * wantAmount + giveAmount - 1n) / giveAmount
    : 0n;
  return { filledGive, filledWant };
}

function makeAccountMachine(offer: SwapOffer): AccountMachine {
  const heldGiveAmount = offer.quantizedGive ?? offer.giveAmount;
  const giveDelta = createDefaultDelta(offer.giveTokenId);
  giveDelta.leftCreditLimit = 10n ** 30n;
  giveDelta.rightCreditLimit = 10n ** 30n;
  if (offer.makerIsLeft) {
    giveDelta.leftHold = heldGiveAmount;
  } else {
    giveDelta.rightHold = heldGiveAmount;
  }

  const wantDelta = createDefaultDelta(offer.wantTokenId);
  wantDelta.leftCreditLimit = 10n ** 30n;
  wantDelta.rightCreditLimit = 10n ** 30n;

  return {
    leftEntity: 'maker',
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
    deltas: new Map([
      [offer.giveTokenId, giveDelta],
      [offer.wantTokenId, wantDelta],
    ]),
    locks: new Map(),
    swapOffers: new Map([[offer.offerId, offer]]),
    globalCreditLimits: { ownLimit: 0n, peerLimit: 0n },
    currentHeight: 0,
    pendingSignatures: [],
    rollbackCount: 0,
    proofHeader: { fromEntity: 'maker', toEntity: 'hub', nonce: 0 },
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
  };
}

describe('price improvement', () => {
  describe('BUY taker (gives quote, wants base)', () => {
    // Setup: 3 makers selling 1 lot each at prices 100, 110, 120
    // Taker wants to buy 3 lots with limit price 120
    test('orderbook matches at maker prices, not taker limit', () => {
      let book = makeBook(10, 0, 200);

      // Makers place asks
      const r1 = applyCommand(book, { kind: 0, ownerId: 'mm1', orderId: 'ask1', side: 1, tif: 0, postOnly: false, priceTicks: 100, qtyLots: 1 });
      book = r1.state;
      const r2 = applyCommand(book, { kind: 0, ownerId: 'mm2', orderId: 'ask2', side: 1, tif: 0, postOnly: false, priceTicks: 110, qtyLots: 1 });
      book = r2.state;
      const r3 = applyCommand(book, { kind: 0, ownerId: 'mm3', orderId: 'ask3', side: 1, tif: 0, postOnly: false, priceTicks: 120, qtyLots: 1 });
      book = r3.state;

      // Taker places buy at 120 (willing to pay up to 120 per lot)
      const result = applyCommand(book, { kind: 0, ownerId: 'taker', orderId: 'buy1', side: 0, tif: 0, postOnly: false, priceTicks: 120, qtyLots: 3 });

      const trades = getTrades(result.events);
      expect(trades).toHaveLength(3);

      // Verify trades execute at MAKER prices
      expect(trades[0]!.price).toBe(100);
      expect(trades[1]!.price).toBe(110);
      expect(trades[2]!.price).toBe(120);

      // Actual execution cost
      const { totalCost, totalQty } = executionCost(trades);
      expect(totalCost).toBe(330n); // 100+110+120
      expect(totalQty).toBe(3n);

      // What taker WOULD pay at their limit price
      const limitCost = 120n * 3n; // 360
      expect(limitCost).toBe(360n);

      // Price improvement = 30 (8.3%)
      const improvement = limitCost - totalCost;
      expect(improvement).toBe(30n);
    });

    test('execution amounts differ from current swap_resolve settlement', () => {
      let book = makeBook(10, 0, 200);

      // Makers: asks at 100, 110, 120
      let r;
      r = applyCommand(book, { kind: 0, ownerId: 'mm1', orderId: 'a1', side: 1, tif: 0, postOnly: false, priceTicks: 100, qtyLots: 1 });
      book = r.state;
      r = applyCommand(book, { kind: 0, ownerId: 'mm2', orderId: 'a2', side: 1, tif: 0, postOnly: false, priceTicks: 110, qtyLots: 1 });
      book = r.state;
      r = applyCommand(book, { kind: 0, ownerId: 'mm3', orderId: 'a3', side: 1, tif: 0, postOnly: false, priceTicks: 120, qtyLots: 1 });
      book = r.state;

      // Taker buy 3 lots @ limit 120
      const result = applyCommand(book, { kind: 0, ownerId: 'taker', orderId: 'b1', side: 0, tif: 0, postOnly: false, priceTicks: 120, qtyLots: 3 });
      const trades = getTrades(result.events);
      const { totalCost } = executionCost(trades);

      // Convert to wei: real execution cost
      const realQuoteCostWei = ticksLotsToWei(totalCost); // 330 * LOT_SCALE / PRICE_SCALE
      const limitQuoteCostWei = ticksLotsToWei(360n);     // 360 * LOT_SCALE / PRICE_SCALE

      // Simulate current swap_resolve: settles at offer ratio (limit price)
      // Taker's offer: giveAmount=limitQuoteCostWei, wantAmount=3*LOT_SCALE
      const takerGive = limitQuoteCostWei;
      const takerWant = 3n * LOT_SCALE;
      const MAX_FILL = 65535;
      const { filledGive: currentGive } = currentSettlement(takerGive, takerWant, MAX_FILL);

      // Current settlement charges limit price, not real execution price
      expect(currentGive).toBe(takerGive); // Pays full 360-equivalent
      // Real cost should be 330-equivalent
      expect(realQuoteCostWei).toBeLessThan(currentGive);

      // Price improvement lost
      const lostImprovement = currentGive - realQuoteCostWei;
      expect(lostImprovement).toBeGreaterThan(0n);
      console.log(`BUY taker: lost price improvement = ${lostImprovement} wei (${Number(lostImprovement * 10000n / currentGive) / 100}%)`);
    });
  });

  describe('SELL taker (gives base, wants quote)', () => {
    // Setup: 3 makers bidding 1 lot each at prices 3100, 3000, 2900
    // Taker wants to sell 3 lots with limit price 2900
    test('orderbook matches at maker prices, not taker limit', () => {
      let book = makeBook(100, 2000, 4000);

      // Makers place bids
      const r1 = applyCommand(book, { kind: 0, ownerId: 'mm1', orderId: 'bid1', side: 0, tif: 0, postOnly: false, priceTicks: 3100, qtyLots: 1 });
      book = r1.state;
      const r2 = applyCommand(book, { kind: 0, ownerId: 'mm2', orderId: 'bid2', side: 0, tif: 0, postOnly: false, priceTicks: 3000, qtyLots: 1 });
      book = r2.state;
      const r3 = applyCommand(book, { kind: 0, ownerId: 'mm3', orderId: 'bid3', side: 0, tif: 0, postOnly: false, priceTicks: 2900, qtyLots: 1 });
      book = r3.state;

      // Taker places sell at 2900 (willing to sell as low as 2900 per lot)
      const result = applyCommand(book, { kind: 0, ownerId: 'taker', orderId: 'sell1', side: 1, tif: 0, postOnly: false, priceTicks: 2900, qtyLots: 3 });

      const trades = getTrades(result.events);
      expect(trades).toHaveLength(3);

      // Trades at MAKER prices (best bid first)
      expect(trades[0]!.price).toBe(3100);
      expect(trades[1]!.price).toBe(3000);
      expect(trades[2]!.price).toBe(2900);

      // Actual quote proceeds
      const { totalCost } = executionCost(trades);
      expect(totalCost).toBe(9000n); // 3100+3000+2900

      // What taker would receive at their limit price
      const limitProceeds = 2900n * 3n; // 8700
      expect(limitProceeds).toBe(8700n);

      // Price improvement for seller = 300 (3.4%)
      const improvement = totalCost - limitProceeds;
      expect(improvement).toBe(300n);
    });

    test('execution amounts differ from current swap_resolve settlement', () => {
      let book = makeBook(100, 2000, 4000);

      // Makers: bids at 3100, 3000, 2900
      let r;
      r = applyCommand(book, { kind: 0, ownerId: 'mm1', orderId: 'b1', side: 0, tif: 0, postOnly: false, priceTicks: 3100, qtyLots: 1 });
      book = r.state;
      r = applyCommand(book, { kind: 0, ownerId: 'mm2', orderId: 'b2', side: 0, tif: 0, postOnly: false, priceTicks: 3000, qtyLots: 1 });
      book = r.state;
      r = applyCommand(book, { kind: 0, ownerId: 'mm3', orderId: 'b3', side: 0, tif: 0, postOnly: false, priceTicks: 2900, qtyLots: 1 });
      book = r.state;

      // Taker sell 3 lots @ limit 2900
      const result = applyCommand(book, { kind: 0, ownerId: 'taker', orderId: 's1', side: 1, tif: 0, postOnly: false, priceTicks: 2900, qtyLots: 3 });
      const trades = getTrades(result.events);
      const { totalCost } = executionCost(trades);

      // Real execution proceeds (quote amount taker receives)
      const realQuoteProceedsWei = ticksLotsToWei(totalCost); // 9000 * LOT_SCALE / PRICE_SCALE
      const limitQuoteProceedsWei = ticksLotsToWei(8700n);     // 8700 * LOT_SCALE / PRICE_SCALE

      // Current swap_resolve: taker's offer is "give 3*LOT base, want 8700*LOT/PRICE quote"
      // Settlement derives wantAmount from offer ratio → taker gets limit price proceeds
      const takerGive = 3n * LOT_SCALE; // base (ETH)
      const takerWant = limitQuoteProceedsWei; // quote (USDC at limit)
      const MAX_FILL = 65535;
      const { filledWant: currentWant } = currentSettlement(takerGive, takerWant, MAX_FILL);

      // Current: taker receives limit-price proceeds (8700 equivalent)
      expect(currentWant).toBe(takerWant);
      // Real: taker should receive 9000 equivalent (more!)
      expect(realQuoteProceedsWei).toBeGreaterThan(currentWant);

      // Price improvement lost on sell side
      const lostImprovement = realQuoteProceedsWei - currentWant;
      expect(lostImprovement).toBeGreaterThan(0n);
      console.log(`SELL taker: lost price improvement = ${lostImprovement} wei (${Number(lostImprovement * 10000n / realQuoteProceedsWei) / 100}%)`);
    });
  });

  describe('exact execution settlement (proposed fix)', () => {
    /**
     * Proposed swap_resolve settlement with exact execution amounts:
     *
     * swap_resolve.data = {
     *   offerId, fillRatio, cancelRemainder,
     *   executionBaseAmount?: bigint,  // exact base lots filled (in wei)
     *   executionQuoteAmount?: bigint, // exact quote cost/proceeds (in wei)
     * }
     *
     * When present, settlement uses these instead of deriving from offer ratio.
     * fillRatio still used for: minFillRatio check, partial fill bookkeeping, hold release.
     */
    function proposedSettlement(
      executionBaseWei: bigint,
      executionQuoteWei: bigint,
      side: 0 | 1, // 0=BUY base, 1=SELL base
    ) {
      // BUY: taker gives quote, receives base
      // SELL: taker gives base, receives quote
      return side === 0
        ? { filledGive: executionQuoteWei, filledWant: executionBaseWei }
        : { filledGive: executionBaseWei, filledWant: executionQuoteWei };
    }

    test('BUY taker gets price improvement with exact settlement', () => {
      let book = makeBook(10, 0, 200);
      let r;
      r = applyCommand(book, { kind: 0, ownerId: 'mm1', orderId: 'a1', side: 1, tif: 0, postOnly: false, priceTicks: 100, qtyLots: 1 }); book = r.state;
      r = applyCommand(book, { kind: 0, ownerId: 'mm2', orderId: 'a2', side: 1, tif: 0, postOnly: false, priceTicks: 110, qtyLots: 1 }); book = r.state;
      r = applyCommand(book, { kind: 0, ownerId: 'mm3', orderId: 'a3', side: 1, tif: 0, postOnly: false, priceTicks: 120, qtyLots: 1 }); book = r.state;

      const result = applyCommand(book, { kind: 0, ownerId: 'taker', orderId: 'b1', side: 0, tif: 0, postOnly: false, priceTicks: 120, qtyLots: 3 });
      const trades = getTrades(result.events);
      const { totalCost, totalQty } = executionCost(trades);

      const executionBaseWei = totalQty * LOT_SCALE;
      const executionQuoteWei = ticksLotsToWei(totalCost);
      const limitQuoteWei = ticksLotsToWei(360n);

      const proposed = proposedSettlement(executionBaseWei, executionQuoteWei, 0);
      const current = currentSettlement(limitQuoteWei, executionBaseWei, 65535);

      // Proposed: taker pays 330-equivalent (real cost)
      expect(proposed.filledGive).toBe(executionQuoteWei);
      // Current: taker pays 360-equivalent (limit price)
      expect(current.filledGive).toBe(limitQuoteWei);
      // Proposed is better for taker
      expect(proposed.filledGive).toBeLessThan(current.filledGive);

      // Both get same amount of base
      expect(proposed.filledWant).toBe(executionBaseWei);

      const saved = current.filledGive - proposed.filledGive;
      console.log(`BUY taker saves: ${saved} wei (${Number(saved * 10000n / current.filledGive) / 100}%)`);
    });

    test('handleSwapResolve settles BUY offer with exact execution amounts', async () => {
      let book = makeBook(10, 0, 200);
      let r;
      r = applyCommand(book, { kind: 0, ownerId: 'mm1', orderId: 'a1', side: 1, tif: 0, postOnly: false, priceTicks: 100, qtyLots: 1 }); book = r.state;
      r = applyCommand(book, { kind: 0, ownerId: 'mm2', orderId: 'a2', side: 1, tif: 0, postOnly: false, priceTicks: 110, qtyLots: 1 }); book = r.state;
      r = applyCommand(book, { kind: 0, ownerId: 'mm3', orderId: 'a3', side: 1, tif: 0, postOnly: false, priceTicks: 120, qtyLots: 1 }); book = r.state;

      const result = applyCommand(book, { kind: 0, ownerId: 'taker', orderId: 'b1', side: 0, tif: 0, postOnly: false, priceTicks: 120, qtyLots: 3 });
      const trades = getTrades(result.events);
      const { totalCost, totalQty } = executionCost(trades);

      const executionBaseAmount = totalQty * LOT_SCALE;
      const executionQuoteAmount = ticksLotsToWei(totalCost);
      const limitQuoteAmount = ticksLotsToWei(360n);
      const offerId = 'buy-offer';

      const offer: SwapOffer = {
        offerId,
        giveTokenId: 1,
        giveAmount: limitQuoteAmount,
        wantTokenId: 2,
        wantAmount: executionBaseAmount,
        makerIsLeft: true,
        minFillRatio: 0,
        createdHeight: 0,
        quantizedGive: limitQuoteAmount,
        quantizedWant: executionBaseAmount,
      };
      const accountMachine = makeAccountMachine(offer);
      const accountTx: Extract<AccountTx, { type: 'swap_resolve' }> = {
        type: 'swap_resolve',
        data: {
          offerId,
          fillRatio: 65535,
          cancelRemainder: true,
          executionBaseAmount,
          executionQuoteAmount,
        },
      };

      const resolveResult = await handleSwapResolve(accountMachine, accountTx, false, 1);
      expect(resolveResult.success).toBe(true);
      expect(accountMachine.swapOffers.has(offerId)).toBe(false);
      expect(accountMachine.deltas.get(1)?.offdelta).toBe(-executionQuoteAmount);
      expect(accountMachine.deltas.get(2)?.offdelta).toBe(executionBaseAmount);
      expect(executionQuoteAmount).toBeLessThan(limitQuoteAmount);
    });

    test('SELL taker gets price improvement with exact settlement', () => {
      let book = makeBook(100, 2000, 4000);
      let r;
      r = applyCommand(book, { kind: 0, ownerId: 'mm1', orderId: 'b1', side: 0, tif: 0, postOnly: false, priceTicks: 3100, qtyLots: 1 }); book = r.state;
      r = applyCommand(book, { kind: 0, ownerId: 'mm2', orderId: 'b2', side: 0, tif: 0, postOnly: false, priceTicks: 3000, qtyLots: 1 }); book = r.state;
      r = applyCommand(book, { kind: 0, ownerId: 'mm3', orderId: 'b3', side: 0, tif: 0, postOnly: false, priceTicks: 2900, qtyLots: 1 }); book = r.state;

      const result = applyCommand(book, { kind: 0, ownerId: 'taker', orderId: 's1', side: 1, tif: 0, postOnly: false, priceTicks: 2900, qtyLots: 3 });
      const trades = getTrades(result.events);
      const { totalCost, totalQty } = executionCost(trades);

      const executionBaseWei = totalQty * LOT_SCALE;
      const executionQuoteWei = ticksLotsToWei(totalCost);
      const limitQuoteWei = ticksLotsToWei(8700n);

      const proposed = proposedSettlement(executionBaseWei, executionQuoteWei, 1);
      const current = currentSettlement(executionBaseWei, limitQuoteWei, 65535);

      // Proposed: taker receives 9000-equivalent (real proceeds)
      expect(proposed.filledWant).toBe(executionQuoteWei);
      // Current: taker receives 8700-equivalent (limit price)
      expect(current.filledWant).toBe(limitQuoteWei);
      // Proposed is better for taker
      expect(proposed.filledWant).toBeGreaterThan(current.filledWant);

      // Both give same amount of base
      expect(proposed.filledGive).toBe(executionBaseWei);

      const gained = proposed.filledWant - current.filledWant;
      console.log(`SELL taker gains: ${gained} wei (${Number(gained * 10000n / proposed.filledWant) / 100}%)`);
    });

    test('handleSwapResolve settles SELL offer with exact execution amounts', async () => {
      let book = makeBook(100, 2000, 4000);
      let r;
      r = applyCommand(book, { kind: 0, ownerId: 'mm1', orderId: 'b1', side: 0, tif: 0, postOnly: false, priceTicks: 3100, qtyLots: 1 }); book = r.state;
      r = applyCommand(book, { kind: 0, ownerId: 'mm2', orderId: 'b2', side: 0, tif: 0, postOnly: false, priceTicks: 3000, qtyLots: 1 }); book = r.state;
      r = applyCommand(book, { kind: 0, ownerId: 'mm3', orderId: 'b3', side: 0, tif: 0, postOnly: false, priceTicks: 2900, qtyLots: 1 }); book = r.state;

      const result = applyCommand(book, { kind: 0, ownerId: 'taker', orderId: 's1', side: 1, tif: 0, postOnly: false, priceTicks: 2900, qtyLots: 3 });
      const trades = getTrades(result.events);
      const { totalCost, totalQty } = executionCost(trades);

      const executionBaseAmount = totalQty * LOT_SCALE;
      const executionQuoteAmount = ticksLotsToWei(totalCost);
      const limitQuoteAmount = ticksLotsToWei(8700n);
      const offerId = 'sell-offer';

      const offer: SwapOffer = {
        offerId,
        giveTokenId: 2,
        giveAmount: executionBaseAmount,
        wantTokenId: 1,
        wantAmount: limitQuoteAmount,
        makerIsLeft: true,
        minFillRatio: 0,
        createdHeight: 0,
        quantizedGive: executionBaseAmount,
        quantizedWant: limitQuoteAmount,
      };
      const accountMachine = makeAccountMachine(offer);
      const accountTx: Extract<AccountTx, { type: 'swap_resolve' }> = {
        type: 'swap_resolve',
        data: {
          offerId,
          fillRatio: 65535,
          cancelRemainder: true,
          executionBaseAmount,
          executionQuoteAmount,
        },
      };

      const resolveResult = await handleSwapResolve(accountMachine, accountTx, false, 1);
      expect(resolveResult.success).toBe(true);
      expect(accountMachine.swapOffers.has(offerId)).toBe(false);
      expect(accountMachine.deltas.get(2)?.offdelta).toBe(-executionBaseAmount);
      expect(accountMachine.deltas.get(1)?.offdelta).toBe(executionQuoteAmount);
      expect(executionQuoteAmount).toBeGreaterThan(limitQuoteAmount);
    });
  });
});
