import { describe, expect, test } from 'bun:test';

import type { EntityState } from '../../../entity/types';
import {
  CROSS_J_BOOK_MAX_USD_MICROS,
  crossJurisdictionLegUsdMicros,
  getCrossJurisdictionLegUsdCapError,
  getCrossJurisdictionLocalUsdCapError,
  isCrossJurisdictionBookRiskRejection,
} from '../../../extensions/cross-j/orderbook';
import { applyCommand, createBook, recordAcceptedUsdAskPrice } from '../../../orderbook';
import type { CrossJurisdictionSwapRoute } from '../../../types/cross-jurisdiction';
import { isAuthorizedUsdReferenceAsk } from '../../../entity/tx/handlers/account/orderbook/same/results';
import { decodeValidatedBuffer, encodeBuffer } from '../../../storage/codec/codec';
import {
  decodeStorageBookHeader,
  projectStorageBookHeader,
} from '../../../storage/schema/book-graph-codec';
import { jref, makeJurisdiction , addr, entity, installJurisdictions, makeState } from '../../helpers/cross-j';
import { createEmptyEnv } from '../../../runtime';
import {
  buildPreparedCrossJurisdictionRoute,
  withCanonicalCrossJurisdictionRouteHash,
} from '../../../extensions/cross-j';
import { handleMaterializeCrossJurisdictionSwapEntityTx } from '../../../entity/tx/handlers/cross-j/setup';

const internalWethUsdBook = () => {
  let book = createBook({ bucketWidthTicks: 10_000n, maxOrders: 16, stpPolicy: 0 });
  book = applyCommand(book, {
    kind: 0,
    ownerId: 'maker',
    orderId: 'ask',
    side: 1,
    tif: 0,
    postOnly: false,
    priceTicks: 25_000_000n,
    qtyLots: 1_000_000n,
  }).state;
  return recordAcceptedUsdAskPrice(book, 25_000_000n);
};

const riskState = (withPrice = true): EntityState => ({
  orderbookExt: {
    books: new Map(withPrice ? [['1/2', internalWethUsdBook()]] : []),
    orderPairs: new Map(),
    referrals: new Map(),
    hubProfile: {
      referenceTokenId: 1,
      usdQuoteAuthorityEntityId: 'market-maker',
    },
  },
} as EntityState);

const route = (wethAmount: bigint, usdcAmount: bigint): CrossJurisdictionSwapRoute => ({
  orderId: 'risk-order',
  source: { tokenId: 2, amount: wethAmount },
  target: { tokenId: 1, amount: usdcAmount },
} as CrossJurisdictionSwapRoute);

describe('cross-j hub USD admission cap', () => {
  test('only the signed authority same-j volatile sell is a USD reference ask', () => {
    const profile = { referenceTokenId: 1, usdQuoteAuthorityEntityId: 'market-maker' };
    const canonical = {
      side: 1 as const,
      makerId: 'market-maker',
      offer: { giveTokenId: 2, wantTokenId: 1 },
    };
    expect(isAuthorizedUsdReferenceAsk(profile, canonical)).toBe(true);
    expect(isAuthorizedUsdReferenceAsk(profile, { ...canonical, makerId: 'user' })).toBe(false);
    expect(isAuthorizedUsdReferenceAsk(profile, { ...canonical, side: 0 })).toBe(false);
    expect(isAuthorizedUsdReferenceAsk(profile, {
      ...canonical,
      offer: { giveTokenId: 1, wantTokenId: 2 },
    })).toBe(false);
  });

  test('stores the latest trusted same-j ask and accepts both legs exactly at $6.5m', () => {
    const state = riskState();
    const book = state.orderbookExt!.books.get('1/2')!;
    expect(book.lastTradePriceTicks).toBe(0n);
    expect(book.lastAcceptedUsdAskPriceTicks).toBe(25_000_000n);
    expect(crossJurisdictionLegUsdMicros(state, 2, 2_600n * 10n ** 18n)).toBe(CROSS_J_BOOK_MAX_USD_MICROS);
    expect(crossJurisdictionLegUsdMicros(state, 1, 6_500_000n * 10n ** 6n)).toBe(CROSS_J_BOOK_MAX_USD_MICROS);
    expect(getCrossJurisdictionLegUsdCapError(
      state,
      route(2_600n * 10n ** 18n, 6_500_000n * 10n ** 6n),
      'source',
    )).toBeNull();
    expect(getCrossJurisdictionLegUsdCapError(
      state,
      route(2_600n * 10n ** 18n, 6_500_000n * 10n ** 6n),
      'target',
    )).toBeNull();
  });

  test('authority price survives the exact authoritative book codec', () => {
    const restored = decodeValidatedBuffer(
      encodeBuffer(projectStorageBookHeader(internalWethUsdBook())),
      decodeStorageBookHeader,
    );
    expect(restored.lastAcceptedUsdAskPriceTicks).toBe(25_000_000n);
  });

  test('rounds risk upward and rejects either leg above the cap', () => {
    const state = riskState();
    expect(getCrossJurisdictionLegUsdCapError(
      state,
      route(2_600n * 10n ** 18n + 1n, 6_500_000n * 10n ** 6n),
      'source',
    )).toContain('leg=source');
    expect(getCrossJurisdictionLegUsdCapError(
      state,
      route(2_600n * 10n ** 18n, 6_500_000n * 10n ** 6n + 1n),
      'target',
    )).toContain('leg=target');
  });

  test('same Hub Entity on both stacks enforces the stack-local leg', () => {
    const hub = `0x${'45'.repeat(32)}`;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sharedHubRoute = {
      ...route(2_600n * 10n ** 18n + 1n, 6_500_000n * 10n ** 6n),
      source: {
        jurisdiction: jref(eth),
        entityId: `0x${'41'.repeat(32)}`,
        counterpartyEntityId: hub,
        tokenId: 2,
        amount: 2_600n * 10n ** 18n + 1n,
      },
      target: {
        jurisdiction: jref(base),
        entityId: hub,
        counterpartyEntityId: `0x${'42'.repeat(32)}`,
        tokenId: 1,
        amount: 6_500_000n * 10n ** 6n,
      },
    } as CrossJurisdictionSwapRoute;
    const sourceState = riskState() as EntityState;
    sourceState.entityId = hub;
    sourceState.config = { jurisdiction: eth } as EntityState['config'];
    const targetState = riskState() as EntityState;
    targetState.entityId = hub;
    targetState.config = { jurisdiction: base } as EntityState['config'];

    expect(getCrossJurisdictionLocalUsdCapError(sourceState, sharedHubRoute))
      .toContain('leg=source');
    expect(getCrossJurisdictionLocalUsdCapError(targetState, sharedHubRoute)).toBeNull();
    const invalidState = riskState() as EntityState;
    invalidState.entityId = hub;
    invalidState.config = {
      jurisdiction: makeJurisdiction('Wrong', 999, '31', '32'),
    } as EntityState['config'];
    const invalid = getCrossJurisdictionLocalUsdCapError(invalidState, sharedHubRoute);
    expect(invalid).toContain('VALIDATOR_LEG_INVALID');
    expect(isCrossJurisdictionBookRiskRejection(invalid)).toBe(false);
    expect(isCrossJurisdictionBookRiskRejection(
      'CROSS_J_BOOK_USD_CAP_EXCEEDED:order=risk-order',
    )).toBe(true);
  });

  test('allows admission before the authority has published an internal dollar ask', () => {
    expect(getCrossJurisdictionLegUsdCapError(
      riskState(false),
      route(1n * 10n ** 18n, 2_500n * 10n ** 6n),
      'source',
    )).toBeNull();
  });

  test('user quotes and trades cannot mutate the persisted authority price', () => {
    const book = internalWethUsdBook();
    applyCommand(book, {
      kind: 0,
      ownerId: 'untrusted-user',
      orderId: 'crossing-buy',
      side: 0,
      tif: 1,
      postOnly: false,
      priceTicks: 30_000_000n,
      qtyLots: 1n,
    });
    expect(book.lastTradePriceTicks).toBe(25_000_000n);
    expect(book.lastAcceptedUsdAskPriceTicks).toBe(25_000_000n);
  });

  test('book Hub rejects over-cap before emitting either Account registration', () => {
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('61');
    const sourceHub = entity('62');
    const targetHub = entity('63');
    const targetUser = entity('64');
    const sourceHubSigner = addr('65');
    const raw = withCanonicalCrossJurisdictionRouteHash({
      orderId: 'materialize-usd-cap',
      makerEntityId: sourceUser,
      hubEntityId: sourceHub,
      sourceSignerId: addr('66'),
      sourceHubSignerId: sourceHubSigner,
      targetHubSignerId: addr('67'),
      targetSignerId: addr('68'),
      source: {
        jurisdiction: jref(eth),
        entityId: sourceUser,
        counterpartyEntityId: sourceHub,
        tokenId: 2,
        amount: 2_600n * 10n ** 18n + 1n,
      },
      target: {
        jurisdiction: jref(base),
        entityId: targetHub,
        counterpartyEntityId: targetUser,
        tokenId: 1,
        amount: 6_500_000n * 10n ** 6n,
      },
      sourceDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
      targetDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
      status: 'intent',
      createdAt: 1_000,
      updatedAt: 1_000,
      expiresAt: 61_000,
    } as CrossJurisdictionSwapRoute);
    const prepared = buildPreparedCrossJurisdictionRoute(raw, {
      runtimeSeed: 'usd-cap-materialize-seed',
      now: 1_000,
    });
    const state = makeState(sourceHub, sourceHubSigner, eth, sourceUser);
    state.profile.isHub = true;
    state.crossJurisdictionSwaps!.set(raw.orderId, raw);
    state.orderbookExt = riskState().orderbookExt;
    const env = createEmptyEnv('usd-cap-before-register');
    env.runtimeSeed = 'usd-cap-materialize-seed';
    installJurisdictions(env, eth, base);

    const rejected = handleMaterializeCrossJurisdictionSwapEntityTx(env, state, {
      type: 'materializeCrossJurisdictionSwap',
      data: { route: prepared, proposerSignerId: sourceHubSigner },
    });
    expect(rejected.outputs).toEqual([]);
    expect(rejected.accountTxs).toBeUndefined();
    expect(rejected.newState.crossJurisdictionSwaps?.get(raw.orderId)?.status).toBe('intent');

    const priceFree = makeState(sourceHub, sourceHubSigner, eth, sourceUser);
    priceFree.profile.isHub = true;
    priceFree.crossJurisdictionSwaps!.set(raw.orderId, raw);
    priceFree.orderbookExt = riskState(false).orderbookExt;
    const admitted = handleMaterializeCrossJurisdictionSwapEntityTx(env, priceFree, {
      type: 'materializeCrossJurisdictionSwap',
      data: { route: prepared, proposerSignerId: sourceHubSigner },
    });
    expect(admitted.outputs).toHaveLength(2);
  });
});
