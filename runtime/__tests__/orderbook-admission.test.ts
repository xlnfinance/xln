/**
 * Direct coverage for the Entity orderbook admission boundary.
 *
 * `admitOrderbookOfferForMatching` is the only place where an Entity-level
 * orderbook candidate is checked against the bilateral Account commitment that
 * backs it. The Entity book is a projection and can never create liquidity, so
 * every field the matcher will trade on must be proven equal to committed
 * Account state - and a committed offer that is missing those fields must be
 * rejected rather than reconstructed from the candidate, which would let the
 * projection choose the price it is validated against.
 */
import { describe, expect, test } from 'bun:test';

import { admitOrderbookOfferForMatching } from '../entity/consensus/orderbook-admission';
import { normalizeSwapOfferForOrderbook } from '../orderbook/swap-execution';
import { SWAP_LOT_SCALE } from '../orderbook/types';
import type { EntityRuntimeContext } from '../entity/runtime-context';
import type { EntityState } from '../entity/types';
import type { SwapOffer } from '../types/account';
import { addr, entity, makeAccount, makeJurisdiction, makeState } from './helpers/cross-j';

const MAKER = entity('a1');
const TAKER = entity('a2');
const LOT = SWAP_LOT_SCALE;
const PRICE_TICKS = 10_000n;

const jurisdiction = makeJurisdiction('Ethereum', 1, '11', '12');

/** Exactly what `commitSwapOffer` writes: price and quantized amounts together. */
const committedOffer = (overrides: Partial<SwapOffer> = {}): SwapOffer => ({
  offerId: 'admission-offer',
  giveTokenId: 2,
  giveAmount: LOT,
  wantTokenId: 1,
  wantAmount: LOT,
  priceTicks: PRICE_TICKS,
  timeInForce: 0,
  makerIsLeft: MAKER.toLowerCase() < TAKER.toLowerCase(),
  createdHeight: 1,
  quantizedGive: LOT,
  quantizedWant: LOT,
  ...overrides,
});

const makeAdmissionState = (offer: SwapOffer): EntityState => {
  const state = makeState(MAKER, addr('a1'), jurisdiction, TAKER);
  const account = makeAccount(MAKER, TAKER, jurisdiction);
  account.state.swapOffers.set(offer.offerId, offer);
  // The maker's hold must already be committed for a same-jurisdiction offer.
  const giveDelta = account.state.deltas.get(1)!;
  account.state.deltas.set(offer.giveTokenId, {
    ...giveDelta,
    tokenId: offer.giveTokenId,
    ...(offer.makerIsLeft
      ? { leftHold: offer.quantizedGive }
      : { rightHold: offer.quantizedGive }),
  });
  account.currentHeight = 1;
  state.accounts.set(TAKER, account);
  return state;
};

/** The book candidate the Entity derives from the committed offer event. */
const candidateFor = (offer: SwapOffer, overrides: Record<string, unknown> = {}) =>
  ({
    ...normalizeSwapOfferForOrderbook(
      {
        offerId: offer.offerId,
        makerIsLeft: offer.makerIsLeft,
        fromEntity: MAKER,
        toEntity: TAKER,
        createdHeight: offer.createdHeight,
        giveTokenId: offer.giveTokenId,
        giveAmount: offer.giveAmount,
        wantTokenId: offer.wantTokenId,
        wantAmount: offer.wantAmount,
        maxFee: offer.maxFee,
        minNetReceive: offer.minNetReceive,
        priceTicks: offer.priceTicks,
        timeInForce: offer.timeInForce ?? 0,
      },
      TAKER,
    ),
    ...overrides,
  });

const env = { state: { timestamp: 2_000 } } as unknown as EntityRuntimeContext;

describe('orderbook admission', () => {
  test('admits a candidate that matches its committed Account offer exactly', () => {
    const offer = committedOffer();
    const admitted = admitOrderbookOfferForMatching(
      env,
      makeAdmissionState(offer),
      candidateFor(offer),
    );
    expect(admitted).not.toBeNull();
    expect(admitted?.offerId).toBe(offer.offerId);
    expect(admitted?.priceTicks).toBe(PRICE_TICKS);
  });

  test('rejects a candidate with no committed Account offer behind it', () => {
    const offer = committedOffer();
    const state = makeState(MAKER, addr('a1'), jurisdiction, TAKER);
    state.accounts.set(TAKER, makeAccount(MAKER, TAKER, jurisdiction));
    expect(() => admitOrderbookOfferForMatching(env, state, candidateFor(offer)))
      .toThrow('ORDERBOOK_ORDER_NOT_COMMITTED');
  });

  test.each([
    ['priceTicks', { priceTicks: undefined }],
    ['quantizedGive', { quantizedGive: undefined }],
    ['quantizedWant', { quantizedWant: undefined }],
  ])(
    'rejects a committed offer missing %s instead of adopting the candidate value',
    (field, override) => {
      const offer = committedOffer(override as Partial<SwapOffer>);
      // The candidate still carries a well-formed price, which is exactly the
      // value a fallback reader would have silently accepted as "committed".
      expect(() => admitOrderbookOfferForMatching(
        env,
        makeAdmissionState(offer),
        candidateFor(committedOffer()),
      )).toThrow(`ORDERBOOK_ORDER_COMMITTED_INCOMPLETE: account=${TAKER} offer=${offer.offerId} field=${field}`);
    },
  );

  test('rejects a committed offer whose quantized amounts drifted from its live amounts', () => {
    const offer = committedOffer({ quantizedGive: LOT / 2n });
    expect(() => admitOrderbookOfferForMatching(
      env,
      makeAdmissionState(offer),
      candidateFor(committedOffer()),
    )).toThrow('ORDERBOOK_ORDER_COMMITTED_QUANTIZATION_DRIFT');
  });

  test.each([
    ['priceTicks', { priceTicks: PRICE_TICKS * 2n }],
    ['giveAmount', { giveAmount: LOT * 2n }],
    ['wantAmount', { wantAmount: LOT * 2n }],
    ['giveTokenId', { giveTokenId: 7 }],
    ['wantTokenId', { wantTokenId: 7 }],
    ['makerIsLeft', { makerIsLeft: !committedOffer().makerIsLeft }],
  ])('rejects a candidate whose %s differs from the committed offer', (_field, override) => {
    const offer = committedOffer();
    expect(() => admitOrderbookOfferForMatching(
      env,
      makeAdmissionState(offer),
      candidateFor(offer, override),
    )).toThrow('ORDERBOOK_ORDER_COMMITTED_MISMATCH');
  });

  test('rejects a candidate that restates quantized amounts inconsistently', () => {
    const offer = committedOffer();
    expect(() => admitOrderbookOfferForMatching(
      env,
      makeAdmissionState(offer),
      candidateFor(offer, { quantizedGive: LOT / 2n }),
    )).toThrow('ORDERBOOK_ORDER_CANDIDATE_QUANTIZATION_DRIFT');
  });

  test('rejects an offer whose maker hold is not committed on the Account', () => {
    const offer = committedOffer();
    const state = makeAdmissionState(offer);
    const account = state.accounts.get(TAKER)!;
    const delta = account.state.deltas.get(offer.giveTokenId)!;
    account.state.deltas.set(offer.giveTokenId, { ...delta, leftHold: 0n, rightHold: 0n });
    expect(() => admitOrderbookOfferForMatching(env, state, candidateFor(offer)))
      .toThrow('ORDERBOOK_ORDER_HOLD_NOT_COMMITTED');
  });

  test('defers admission while a lifecycle tx for the offer is still queued', () => {
    const offer = committedOffer();
    const state = makeAdmissionState(offer);
    state.accounts.get(TAKER)!.mempool.push({
      type: 'swap_cancel_request',
      data: { offerId: offer.offerId },
    });
    expect(() => admitOrderbookOfferForMatching(env, state, candidateFor(offer)))
      .toThrow('ORDERBOOK_ORDER_NOT_READY');
  });
});
