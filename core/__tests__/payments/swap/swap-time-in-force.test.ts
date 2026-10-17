import { describe, expect, test } from 'bun:test';

import { createDefaultDelta } from '../../../account/state/delta';
import { applyAccountTxToMutableReplica } from '../../../account/tx/apply';
import { exactFillRatioToUint16, MAX_SWAP_FILL_RATIO } from '../../../swapbook/swap-execution';
import { getStaticSwapTokenDimensions, SWAP_LOT_SCALE } from '../../../swapbook/types';
import type { AccountReplica, AccountTx } from '../../../types/account';
import { makeAccount } from '../../helpers/cross-j';

const CLOCK = { timestamp: 1_000, jHeight: 7 };
const AMOUNT = 2n * SWAP_LOT_SCALE;
const HALF = SWAP_LOT_SCALE;

const accountWithOffer = async (timeInForce: 0 | 1 | 2): Promise<AccountReplica> => {
  const account = makeAccount('alice', 'hub');
  const wantDelta = createDefaultDelta(2);
  wantDelta.leftCreditLimit = wantDelta.rightCreditLimit = 10n ** 30n;
  account.state.deltas = account.state.deltas.updated(2, wantDelta);
  const created = await applyAccountTxToMutableReplica(
    account,
    {
      type: 'swap_offer',
      data: {
        offerId: `tif-${timeInForce}`,
        giveTokenId: 1,
        ...getStaticSwapTokenDimensions(1, 2),
        giveAmount: AMOUNT,
        wantTokenId: 2,
        wantAmount: AMOUNT,
        maxFee: 0n,
        minNetReceive: AMOUNT,
        timeInForce,
      },
    },
    true,
    1_000,
    7,
    false,
    undefined,
    undefined,
    undefined,
    CLOCK,
  );
  expect(created.ok).toBe(true);
  return account;
};

const resolve = (
  account: AccountReplica,
  offerId: string,
  data: Partial<Extract<AccountTx, { type: 'swap_resolve' }>['data']>,
) =>
  applyAccountTxToMutableReplica(
    account,
    {
      type: 'swap_resolve',
      data: { offerId, fillRatio: 0, cancelRemainder: false, ...data },
    },
    false,
    2_000,
    8,
    false,
    undefined,
    undefined,
    undefined,
    CLOCK,
  );

const halfFill = {
  fillRatio: exactFillRatioToUint16({ numerator: 1n, denominator: 2n }),
  fillNumerator: 1n,
  fillDenominator: 2n,
  executionGiveAmount: HALF,
  executionWantAmount: HALF,
};

describe('swap_resolve time-in-force', () => {
  test('swap_resolve.rejects_partial_fill_that_keeps_an_ioc_offer_resting', async () => {
    const account = await accountWithOffer(1);
    const kept = await resolve(account, 'tif-1', { ...halfFill, cancelRemainder: false });
    expect(kept.ok).toBe(false);
    if (kept.ok) throw new Error('expected IOC rejection');
    expect(kept.rejection.message).toContain('IOC');
    expect(account.state.swapOffers.get('tif-1')?.giveAmount).toBe(AMOUNT);

    const closed = await resolve(account, 'tif-1', { ...halfFill, cancelRemainder: true });
    expect(closed.ok).toBe(true);
    expect(account.state.swapOffers.has('tif-1')).toBe(false);
    expect(account.state.deltas.get(1)?.leftHold).toBe(0n);
  });

  test('swap_resolve.rejects_any_partial_fill_of_a_fok_offer', async () => {
    const account = await accountWithOffer(2);
    const partial = await resolve(account, 'tif-2', { ...halfFill, cancelRemainder: true });
    expect(partial.ok).toBe(false);
    if (partial.ok) throw new Error('expected FOK rejection');
    expect(partial.rejection.message).toContain('FOK');

    const full = await resolve(account, 'tif-2', {
      fillRatio: MAX_SWAP_FILL_RATIO,
      fillNumerator: 1n,
      fillDenominator: 1n,
      executionGiveAmount: AMOUNT,
      executionWantAmount: AMOUNT,
    });
    expect(full.ok).toBe(true);
    expect(account.state.swapOffers.has('tif-2')).toBe(false);
  });

  test('swap_resolve.pure_cancel_closes_ioc_and_fok_offers', async () => {
    for (const tif of [1, 2] as const) {
      const account = await accountWithOffer(tif);
      const cancelled = await resolve(account, `tif-${tif}`, { fillRatio: 0, cancelRemainder: true });
      expect(cancelled.ok).toBe(true);
      expect(account.state.swapOffers.has(`tif-${tif}`)).toBe(false);
    }
  });

  test('swap_resolve.rejects_a_fok_partial_fill_that_rounds_to_the_maximum_wire_ratio', async () => {
    const account = await accountWithOffer(2);
    const partial = await resolve(account, 'tif-2', {
      fillRatio: exactFillRatioToUint16({ numerator: AMOUNT - 1n, denominator: AMOUNT }),
      executionGiveAmount: AMOUNT - 1n,
      executionWantAmount: AMOUNT - 1n,
      fillNumerator: AMOUNT - 1n,
      fillDenominator: AMOUNT,
      cancelRemainder: true,
    });
    expect(partial.ok).toBe(false);
    if (partial.ok) throw new Error('expected exact FOK rejection');
    expect(partial.rejection.message).toContain('FOK');
    expect(account.state.swapOffers.get('tif-2')?.giveAmount).toBe(AMOUNT);
  });

  test('swap_resolve.gtc_offer_may_rest_after_a_partial_fill', async () => {
    const account = await accountWithOffer(0);
    const partial = await resolve(account, 'tif-0', { ...halfFill, cancelRemainder: false });
    expect(partial.ok).toBe(true);
    expect(account.state.swapOffers.get('tif-0')?.giveAmount).toBe(HALF);
  });

  test('swap_resolve.rejects_resting_token_ids_that_mismatch_the_live_offer', async () => {
    const account = await accountWithOffer(0);
    const mismatch = await resolve(account, 'tif-0', { ...halfFill, restingGiveTokenId: 2, restingWantTokenId: 1 });
    expect(mismatch.ok).toBe(false);
    if (mismatch.ok) throw new Error('expected resting mismatch');
    expect(mismatch.rejection.message).toBe('Resting swap terms mismatch live offer');
  });
});
