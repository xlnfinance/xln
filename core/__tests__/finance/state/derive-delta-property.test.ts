import { describe, expect, test } from 'bun:test';

import { deriveDelta } from '../../../account/utils';
import { handleDirectPayment } from '../../../account/tx/handlers/balance/direct-payment';
import { handleSetCreditLimit } from '../../../account/tx/handlers/balance/set-credit-limit';
import { validateDelta } from '../../../account/validation/delta-validation';
import { UINT256_MAX } from '../../../protocol/boundary/integer-ranges';
import type { AccountReplica, Delta, DerivedDelta } from '../../../types/account';
import type { AccountDraftReplica } from '../../../account/state/account-state-draft';
import type { ApplyAccountTxResult } from '../../../account/tx/apply-types';
import {
  accountTransitionView,
  beginAccountTransition,
  discardAccountTransition,
  publishAccountTransition,
} from '../../../account/state/candidate-overlay';
import { makeAccount, putTestAccountDelta } from '../../helpers/cross-j';

const apply = (account: AccountReplica, run: (draft: AccountDraftReplica) => ApplyAccountTxResult) => {
  const transition = beginAccountTransition(account);
  const result = run(accountTransitionView(transition));
  if (result.ok) publishAccountTransition(account, transition, 'monetary-range');
  else discardAccountTransition(transition);
  return result;
};

const nonNegative = (value: bigint): bigint => (value > 0n ? value : 0n);

const makeDelta = (partial: Partial<Delta>): Delta => ({
  tokenId: partial.tokenId ?? 1,
  collateral: partial.collateral ?? 1n,
  ondelta: partial.ondelta ?? 0n,
  offdelta: partial.offdelta ?? 0n,
  leftCreditLimit: partial.leftCreditLimit ?? 1n,
  rightCreditLimit: partial.rightCreditLimit ?? 1n,
  leftAllowance: partial.leftAllowance ?? 0n,
  rightAllowance: partial.rightAllowance ?? 0n,
  leftHold: partial.leftHold ?? 0n,
  rightHold: partial.rightHold ?? 0n,
});

const propertyCases = (): Delta[] => {
  const cases: Delta[] = [
    makeDelta({ collateral: 100n, leftCreditLimit: 10n, rightCreditLimit: 20n, ondelta: 30n }),
    makeDelta({ collateral: 100n, leftCreditLimit: 10n, rightCreditLimit: 20n, ondelta: -30n }),
    makeDelta({
      collateral: 40n,
      leftCreditLimit: 80n,
      rightCreditLimit: 120n,
      ondelta: 90n,
      leftHold: 7n,
      rightHold: 11n,
    }),
  ];

  let seed = 0x51f15e;
  const next = (mod: number): number => {
    seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
    return seed % mod;
  };

  for (let index = 0; index < 400; index += 1) {
    cases.push(
      makeDelta({
        tokenId: 1 + next(5),
        collateral: BigInt(1 + next(240)),
        leftCreditLimit: BigInt(1 + next(180)),
        rightCreditLimit: BigInt(1 + next(180)),
        ondelta: BigInt(next(481) - 240),
        offdelta: BigInt(next(181) - 90),
        leftAllowance: BigInt(next(90)),
        rightAllowance: BigInt(next(90)),
        leftHold: BigInt(next(120)),
        rightHold: BigInt(next(120)),
      }),
    );
  }

  return cases;
};

const expectDecomposition = (derived: DerivedDelta): void => {
  const expectedOut = nonNegative(
    derived.outPeerCredit + derived.outCollateral + derived.outOwnCredit - derived.outAllowance - derived.outTotalHold,
  );
  const expectedIn = nonNegative(
    derived.inOwnCredit + derived.inCollateral + derived.inPeerCredit - derived.inAllowance - derived.inTotalHold,
  );

  expect(derived.outCapacity).toBe(expectedOut);
  expect(derived.inCapacity).toBe(expectedIn);
};

const expectNonNegative = (derived: DerivedDelta): void => {
  for (const key of [
    'collateral',
    'inCollateral',
    'outCollateral',
    'inOwnCredit',
    'outPeerCredit',
    'totalCapacity',
    'ownCreditLimit',
    'peerCreditLimit',
    'inCapacity',
    'outCapacity',
    'outOwnCredit',
    'inPeerCredit',
    'peerCreditUsed',
    'ownCreditUsed',
    'outTotalHold',
    'inTotalHold',
  ] as const) {
    expect(derived[key] >= 0n, `${key} must be non-negative`).toBe(true);
  }
};

describe('deriveDelta deterministic property invariants', () => {
  test('direct_payment accepts an exactly funded amount above the retired uint128 ceiling', () => {
    const leftEntity = `0x${'11'.repeat(32)}`;
    const rightEntity = `0x${'22'.repeat(32)}`;
    const amount = 1n << 128n;
    for (const byLeft of [true, false]) {
      const account = makeAccount(leftEntity, rightEntity);
      const granted = apply(account, draft =>
        handleSetCreditLimit(
          draft.state,
          {
            type: 'set_credit_limit',
            data: { tokenId: 1, amount },
          },
          !byLeft,
        ),
      );
      expect(granted.ok).toBe(true);
      const paid = apply(account, draft =>
        handleDirectPayment(
          draft,
          {
            type: 'direct_payment',
            data: {
              tokenId: 1,
              amount,
              route: [byLeft ? rightEntity : leftEntity],
              deliveryMode: 'direct',
            },
          },
          byLeft,
        ),
      );
      expect(paid.ok).toBe(true);
      expect(account.state.deltas.get(1)?.offdelta).toBe(byLeft ? -amount : amount);
    }
  });

  test('set_credit_limit accepts a permanent grant above the retired uint128-times-1000 ceiling', () => {
    const account = makeAccount(`0x${'11'.repeat(32)}`, `0x${'22'.repeat(32)}`);
    const amount = ((1n << 128n) - 1n) * 1000n + 1n;
    const granted = apply(account, draft =>
      handleSetCreditLimit(
        draft.state,
        {
          type: 'set_credit_limit',
          data: { tokenId: 1, amount },
        },
        true,
      ),
    );
    expect(granted.ok).toBe(true);
    expect(account.state.deltas.get(1)?.rightCreditLimit).toBe(amount);
    expect(() => validateDelta(makeDelta({ rightCreditLimit: amount }), 'retired-credit-limit')).not.toThrow();
  });

  test('uses one exact credit-limit bound at mutation and durable decode boundaries', () => {
    const account = makeAccount(`0x${'11'.repeat(32)}`, `0x${'22'.repeat(32)}`);
    const accepted = apply(account, draft =>
      handleSetCreditLimit(
        draft.state,
        {
          type: 'set_credit_limit',
          data: { tokenId: 1, amount: UINT256_MAX },
        },
        true,
      ),
    );
    expect(accepted.ok).toBe(true);
    expect(account.state.deltas.get(1)?.rightCreditLimit).toBe(UINT256_MAX);
    expect(() =>
      validateDelta(
        makeDelta({
          leftCreditLimit: UINT256_MAX,
          rightCreditLimit: UINT256_MAX,
        }),
        'credit-limit-boundary',
      ),
    ).not.toThrow();

    const rejected = apply(account, draft =>
      handleSetCreditLimit(
        draft.state,
        {
          type: 'set_credit_limit',
          data: { tokenId: 1, amount: UINT256_MAX + 1n },
        },
        false,
      ),
    );
    expect(rejected.ok).toBe(false);
    expect(() =>
      validateDelta(
        makeDelta({
          leftCreditLimit: UINT256_MAX + 1n,
        }),
        'credit-limit-boundary',
      ),
    ).toThrow('leftCreditLimit exceeds maximum');
  });

  test('left and right perspectives mirror capacity and accounting fields', () => {
    for (const delta of propertyCases()) {
      const left = deriveDelta(delta, true);
      const right = deriveDelta(delta, false);

      expect(left.delta).toBe(right.delta);
      expect(left.collateral).toBe(right.collateral);
      expect(left.totalCapacity).toBe(right.totalCapacity);
      expect(left.inCapacity).toBe(right.outCapacity);
      expect(left.outCapacity).toBe(right.inCapacity);
      expect(left.inCollateral).toBe(right.outCollateral);
      expect(left.outCollateral).toBe(right.inCollateral);
      expect(left.ownCreditLimit).toBe(right.peerCreditLimit);
      expect(left.peerCreditLimit).toBe(right.ownCreditLimit);
      expect(left.outTotalHold).toBe(right.inTotalHold);
      expect(left.inTotalHold).toBe(right.outTotalHold);
    }
  });

  test('capacity is always derived from returned credit, collateral, allowance, and hold slices', () => {
    for (const delta of propertyCases()) {
      for (const perspective of [true, false]) {
        const derived = deriveDelta(delta, perspective);
        expectDecomposition(derived);
        expectNonNegative(derived);
        expect(derived.inCapacity + derived.outCapacity <= derived.totalCapacity).toBe(true);
      }
    }
  });

  test('increasing a side hold never increases that side outbound capacity', () => {
    for (const delta of propertyCases()) {
      const baselineLeft = deriveDelta(delta, true);
      const baselineRight = deriveDelta(delta, false);
      const leftHeld = deriveDelta(makeDelta({ ...delta, leftHold: (delta.leftHold ?? 0n) + 17n }), true);
      const rightHeld = deriveDelta(makeDelta({ ...delta, rightHold: (delta.rightHold ?? 0n) + 17n }), false);

      expect(leftHeld.outCapacity <= baselineLeft.outCapacity).toBe(true);
      expect(rightHeld.outCapacity <= baselineRight.outCapacity).toBe(true);
    }
  });

  test('prospective credit revocation preserves drawn exposure and cure capacity', () => {
    const leftEntity = `0x${'11'.repeat(32)}`;
    const rightEntity = `0x${'22'.repeat(32)}`;

    for (const debtDirection of ['right-owes-left', 'left-owes-right'] as const) {
      for (const collateral of [0n, 40n, 100n]) {
        const account = makeAccount(leftEntity, rightEntity);
        const delta = makeDelta({
          collateral,
          ondelta: debtDirection === 'right-owes-left' ? 80n : -80n,
          offdelta: 0n,
        });
        putTestAccountDelta(account, delta);

        const grantorIsLeft = debtDirection === 'right-owes-left';
        const revoked = apply(account, draft =>
          handleSetCreditLimit(
            draft.state,
            {
              type: 'set_credit_limit',
              data: { tokenId: 1, amount: 0n },
            },
            grantorIsLeft,
          ),
        );
        expect(revoked.ok).toBe(true);

        const creditorIsLeft = debtDirection === 'right-owes-left';
        const afterRevoke = account.state.deltas.get(1);
        if (!afterRevoke) throw new Error('TEST_DELTA_MISSING');
        const creditorView = deriveDelta(afterRevoke, creditorIsLeft);
        const debtorView = deriveDelta(afterRevoke, !creditorIsLeft);
        const unsecuredExposure = debtDirection === 'right-owes-left' ? nonNegative(80n - collateral) : 80n;
        expect(creditorView.outPeerCredit).toBe(unsecuredExposure);
        expect(creditorView.outCapacity >= 80n).toBe(true);
        expect(debtorView.outOwnCredit).toBe(0n);

        const fromEntityId = creditorIsLeft ? leftEntity : rightEntity;
        const toEntityId = creditorIsLeft ? rightEntity : leftEntity;
        const cured = apply(account, draft =>
          handleDirectPayment(
            draft,
            {
              type: 'direct_payment',
              data: {
                tokenId: 1,
                amount: 80n,
                fromEntityId,
                toEntityId,
                route: [toEntityId],
                deliveryMode: 'direct',
              },
            },
            creditorIsLeft,
          ),
        );
        expect(cured.ok).toBe(true);
        const afterCure = account.state.deltas.get(1);
        if (!afterCure) throw new Error('TEST_DELTA_MISSING');
        expect(afterCure.ondelta + afterCure.offdelta).toBe(0n);
      }
    }
  });
});

test('a numeric string is not a Delta amount and the input is never rewritten', () => {
  const input = { ...makeDelta({}), offdelta: '5' } as unknown as Delta;
  expect(() => validateDelta(input, 'string-amount')).toThrow('offdelta must be BigInt, got: string (5)');
  // The validator used to convert the string in place, silently rewriting the
  // caller's Delta (deriveDelta validates live Account state).
  expect(input.offdelta as unknown).toBe('5');
});
