import { describe, expect, test } from 'bun:test';
import { handleHtlcLock } from '../../../account/tx/handlers/htlc/lock';
import { handleSwapOffer } from '../../../account/tx/handlers/swap/offer';
import { handleSettleTransition } from '../../../account/tx/handlers/settlement/transition';
import {
  accountTransitionView,
  beginAccountTransition,
  discardAccountTransition,
} from '../../../account/state/candidate-overlay';
import { createDefaultDelta } from '../../../account/state/delta';
import { validateDelta } from '../../../account/validation/delta-validation';
import { hashHtlcSecret } from '../../../protocol/htlc/utils';
import { UINT256_MAX } from '../../../protocol/boundary/integer-ranges';
import type { ApplyAccountTxResult } from '../../../account/tx/apply-types';
import { entity, makeAccount, putTestAccountDelta } from '../../helpers/cross-j';

const swapTx = (offerId: string, amount: bigint) => ({
  type: 'swap_offer' as const,
  data: {
    offerId,
    giveTokenId: 1,
    giveTokenDecimals: 0,
    giveAmount: amount,
    wantTokenId: 2,
    wantTokenDecimals: 0,
    wantAmount: amount,
    maxFee: 0n,
    minNetReceive: amount,
  },
});

const atHoldMaximum = async (senderIsLeft: boolean) => {
  const account = makeAccount(entity('11'), entity('22'));
  putTestAccountDelta(account, {
    ...createDefaultDelta(1),
    collateral: 1n,
    ondelta: senderIsLeft ? 1n : 0n,
    leftCreditLimit: senderIsLeft ? UINT256_MAX : 0n,
    rightCreditLimit: senderIsLeft ? 0n : UINT256_MAX,
  });
  const owner = beginAccountTransition(account);
  const draft = accountTransitionView(owner);
  expect((await handleSwapOffer(draft, swapTx('full-hold', UINT256_MAX), senderIsLeft, 1)).ok).toBe(true);
  const before = draft.state.deltas.get(1);
  if (!before) throw new Error('TEST_DELTA_MISSING');
  validateDelta(before, 'after-full-hold-offer');
  expect(senderIsLeft ? before.leftHold : before.rightHold).toBe(UINT256_MAX);
  return { owner, draft, before };
};

const expectHoldOverflow = (result: ApplyAccountTxResult, senderIsLeft: boolean): void => {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('TEST_EXPECTED_HOLD_OVERFLOW');
  expect(result.rejection).toEqual({
    kind: 'validation',
    code: 'ACCOUNT_TX_VALIDATION',
    message: `HOLD_ADD_OVERFLOW:${senderIsLeft ? 'left' : 'right'} hold=${UINT256_MAX} amount=1`,
  });
};

describe('aggregate holds remain exactly representable', () => {
  test('swap_offer then htlc_lock rejects uint256 hold overflow before publishing the lock or delta', async () => {
    for (const senderIsLeft of [true, false]) {
      const { owner, draft, before } = await atHoldMaximum(senderIsLeft);
      const hashlock = hashHtlcSecret(entity('44'));
      const result = await handleHtlcLock(
        draft,
        {
          type: 'htlc_lock',
          data: { lockId: hashlock, hashlock, timelock: 60_000n, revealBeforeHeight: 10, amount: 1n, tokenId: 1 },
        },
        senderIsLeft,
        { committedTimestamp: 1_000, enforcementTimestamp: 1_000, enforcementJHeight: 0 },
      );
      expectHoldOverflow(result, senderIsLeft);
      expect(draft.state.deltas.get(1)).toEqual(before);
      expect(draft.state.locks.size).toBe(0);
      expect(draft.state.swapOffers.size).toBe(1);
      expect(result.events).toEqual([]);
      expect(result.candidateEffects ?? []).toEqual([]);
      discardAccountTransition(owner);
    }
  });

  test('a second swap_offer cannot overflow the aggregate hold or append an offer', async () => {
    for (const senderIsLeft of [true, false]) {
      const { owner, draft, before } = await atHoldMaximum(senderIsLeft);
      const result = await handleSwapOffer(draft, swapTx('overflow-hold', 1n), senderIsLeft, 2);
      expectHoldOverflow(result, senderIsLeft);
      expect(draft.state.deltas.get(1)).toEqual(before);
      expect(draft.state.swapOffers.size).toBe(1);
      expect(draft.state.swapOffers.has('overflow-hold')).toBe(false);
      expect(result.events).toEqual([]);
      discardAccountTransition(owner);
    }
  });

  test('settle_transition rejects either hold overflow without publishing earlier planned changes', async () => {
    for (const senderIsLeft of [true, false]) {
      const { owner, draft, before } = await atHoldMaximum(senderIsLeft);
      const result = await handleSettleTransition(
        draft,
        {
          type: 'settle_transition',
          data: {
            kind: 'upsert',
            revision: 1,
            executorIsLeft: senderIsLeft,
            ops: [
              {
                type: 'rawDiff',
                tokenId: 1,
                leftDiff: senderIsLeft ? 1n : 0n,
                rightDiff: senderIsLeft ? 0n : 1n,
                collateralDiff: -1n,
                ondeltaDiff: senderIsLeft ? -1n : 0n,
              },
            ],
          },
        },
        senderIsLeft,
        1_000,
      );
      expectHoldOverflow(result, senderIsLeft);
      expect(draft.state.deltas.get(1)).toEqual(before);
      expect(draft.state.settlementWorkspace).toBeUndefined();
      expect(result.events).toEqual([]);
      discardAccountTransition(owner);
    }
  });
});
