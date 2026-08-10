import { describe, expect, test } from 'bun:test';

import {
  assertSwapNetAuthorization,
  deriveSwapNetAuthorization,
  requantizeSwapNetAuthorization,
} from '../account/swap-net-authorization';
import { createDefaultDelta } from '../account/delta';
import { handleSwapResolve } from '../account/tx/handlers/swap-resolve';
import { handleSwapOffer } from '../account/tx/handlers/swap-offer';
import { decodeAccountTx } from '../account/tx-validation';
import { validateAccountReplica } from '../account/state-validation';
import { computeSwapPriceTicks, SWAP_LOT_SCALE } from '../orderbook/types';
import { exactFillRatioToUint16 } from '../orderbook/swap-execution';
import type { AccountReplica, SwapOffer } from '../types/account';
import { makeAccount } from './helpers/cross-j';

const authorizationOffer = (overrides: Partial<SwapOffer> = {}): SwapOffer => ({
  offerId: 'net-authorized-offer',
  giveTokenId: 2,
  giveAmount: 100n,
  wantTokenId: 1,
  wantAmount: 100n,
  maxFee: 10n,
  minNetReceive: 90n,
  priceTicks: 1n,
  makerIsLeft: true,
  createdHeight: 1,
  quantizedGive: 100n,
  quantizedWant: 100n,
  ...overrides,
});

const resolvableAccount = (): AccountReplica => {
  const amount = 2n * SWAP_LOT_SCALE;
  const offer = authorizationOffer({
    giveAmount: amount,
    wantAmount: amount,
    maxFee: 200n,
    minNetReceive: amount - 200n,
    priceTicks: computeSwapPriceTicks(2, 1, amount, amount),
    quantizedGive: amount,
    quantizedWant: amount,
  });
  const account = makeAccount('alice', 'hub');
  const giveDelta = createDefaultDelta(offer.giveTokenId);
  const wantDelta = createDefaultDelta(offer.wantTokenId);
  giveDelta.leftCreditLimit = giveDelta.rightCreditLimit = 10n ** 30n;
  wantDelta.leftCreditLimit = wantDelta.rightCreditLimit = 10n ** 30n;
  giveDelta.leftHold = amount;
  account.state.deltas = new Map([
    [offer.giveTokenId, giveDelta],
    [offer.wantTokenId, wantDelta],
  ]);
  account.state.swapOffers = new Map([[offer.offerId, offer]]);
  return account;
};

describe('swap net authorization', () => {
  test('derives deterministic 0/1/9999 bps limits and rejects 10000 bps', () => {
    expect(deriveSwapNetAuthorization(10_000n, 0)).toEqual({
      maxFee: 0n,
      minNetReceive: 10_000n,
    });
    expect(deriveSwapNetAuthorization(10_000n, 1)).toEqual({
      maxFee: 1n,
      minNetReceive: 9_999n,
    });
    expect(deriveSwapNetAuthorization(10_000n, 9_999)).toEqual({
      maxFee: 9_999n,
      minNetReceive: 1n,
    });
    expect(() => deriveSwapNetAuthorization(10_000n, 10_000))
      .toThrow('SWAP_NET_AUTH_MAX_FEE_INVALID');
  });

  test('bounds every partial fill without letting price improvement enlarge fee authority', () => {
    const offer = authorizationOffer();
    expect(() => assertSwapNetAuthorization(offer, 50n, 50n, 5n)).not.toThrow();
    expect(() => assertSwapNetAuthorization(offer, 50n, 50n, 6n))
      .toThrow('SWAP_NET_AUTH_MAX_FEE_EXCEEDED');
    expect(() => assertSwapNetAuthorization(offer, 50n, 49n, 5n))
      .toThrow('SWAP_NET_AUTH_MIN_RECEIVE_NOT_MET');
    expect(() => assertSwapNetAuthorization(offer, 100n, 200n, 11n))
      .toThrow('SWAP_NET_AUTH_MAX_FEE_EXCEEDED');
  });

  test('requantizes remaining authorization conservatively across repeated partial fills', () => {
    const first = requantizeSwapNetAuthorization(authorizationOffer(), 50n, 50n);
    expect(first).toEqual({ maxFee: 5n, minNetReceive: 45n });
    const second = requantizeSwapNetAuthorization({
      giveAmount: 50n,
      wantAmount: 50n,
      ...first,
    }, 25n, 25n);
    expect(second).toEqual({ maxFee: 3n, minNetReceive: 22n });
  });

  test('requires both authorization fields at the exact AccountTx boundary', () => {
    const data = {
      offerId: 'schema-offer',
      giveTokenId: 1,
      giveAmount: 100n,
      wantTokenId: 2,
      wantAmount: 100n,
      maxFee: 1n,
      minNetReceive: 99n,
    };
    expect(() => decodeAccountTx({ type: 'swap_offer', data }, 'TEST_SWAP'))
      .not.toThrow();
    const { minNetReceive: _removed, ...missing } = data;
    expect(() => decodeAccountTx({ type: 'swap_offer', data: missing }, 'TEST_SWAP'))
      .toThrow('TEST_SWAP_DATA_FIELDS');
  });

  test('validates and commits authorization into canonical Account offer state', async () => {
    const amount = 2n * SWAP_LOT_SCALE;
    const account = makeAccount('alice', 'hub');
    const accepted = await handleSwapOffer(account, {
      type: 'swap_offer',
      data: {
        offerId: 'committed-authorization',
        giveTokenId: 1,
        giveAmount: amount,
        wantTokenId: 2,
        wantAmount: amount,
        maxFee: 200n,
        minNetReceive: amount - 200n,
      },
    }, true, 1);
    expect(accepted.success).toBe(true);
    expect(account.state.swapOffers.get('committed-authorization')).toMatchObject({
      maxFee: 200n,
      minNetReceive: amount - 200n,
    });

    const invalid = await handleSwapOffer(account, {
      type: 'swap_offer',
      data: {
        offerId: 'invalid-authorization',
        giveTokenId: 1,
        giveAmount: amount,
        wantTokenId: 2,
        wantAmount: amount,
        maxFee: amount,
        minNetReceive: 1n,
      },
    }, true, 1);
    expect(invalid.success).toBe(false);
    expect(invalid.error).toBe('SWAP_NET_AUTH_INITIAL_TERMS_INVALID');
    expect(account.state.swapOffers.has('invalid-authorization')).toBe(false);
  });

  test('rejects persisted Account offer state that omits authorization', () => {
    const account = resolvableAccount();
    expect(() => validateAccountReplica(account)).not.toThrow();
    const offer = account.state.swapOffers.get('net-authorized-offer')!;
    delete (offer as Partial<SwapOffer>).maxFee;
    expect(() => validateAccountReplica(account))
      .toThrow('AccountReplica.state.swapOffers.net-authorized-offer authorization is invalid');
  });

  test('rejects an over-cap Account fill and scales authorization on the committed remainder', async () => {
    const overCap = resolvableAccount();
    const amount = SWAP_LOT_SCALE;
    const fillRatio = exactFillRatioToUint16({ numerator: 1n, denominator: 2n });
    const rejected = await handleSwapResolve(overCap, {
      type: 'swap_resolve',
      data: {
        offerId: 'net-authorized-offer',
        fillRatio,
        fillNumerator: 1n,
        fillDenominator: 2n,
        cancelRemainder: false,
        executionGiveAmount: amount,
        executionWantAmount: amount,
        feeTokenId: 1,
        feeAmount: 101n,
      },
    }, false, 2);
    expect(rejected.success).toBe(false);
    expect(rejected.error).toBe('SWAP_NET_AUTH_MAX_FEE_EXCEEDED');
    expect(overCap.state.swapOffers.get('net-authorized-offer')?.giveAmount)
      .toBe(2n * amount);

    const accepted = resolvableAccount();
    const result = await handleSwapResolve(accepted, {
      type: 'swap_resolve',
      data: {
        offerId: 'net-authorized-offer',
        fillRatio,
        fillNumerator: 1n,
        fillDenominator: 2n,
        cancelRemainder: false,
        executionGiveAmount: amount,
        executionWantAmount: amount,
        feeTokenId: 1,
        feeAmount: 100n,
      },
    }, false, 2);
    expect(result.success).toBe(true);
    expect(accepted.state.swapOffers.get('net-authorized-offer')).toMatchObject({
      giveAmount: amount,
      wantAmount: amount,
      maxFee: 100n,
      minNetReceive: amount - 100n,
    });
  });
});
