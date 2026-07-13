import { describe, expect, test } from 'bun:test';

import { deriveDelta } from '../account/utils';
import { handleDirectPayment } from '../account/tx/handlers/direct-payment';
import { handleSetCreditLimit } from '../account/tx/handlers/set-credit-limit';
import type { Delta, DerivedDelta } from '../types';
import { makeAccount } from './helpers/cross-j';

const nonNegative = (value: bigint): bigint => value > 0n ? value : 0n;

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
    makeDelta({ collateral: 40n, leftCreditLimit: 80n, rightCreditLimit: 120n, ondelta: 90n, leftHold: 7n, rightHold: 11n }),
  ];

  let seed = 0x51f15e;
  const next = (mod: number): number => {
    seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
    return seed % mod;
  };

  for (let index = 0; index < 400; index += 1) {
    cases.push(makeDelta({
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
    }));
  }

  return cases;
};

const expectDecomposition = (derived: DerivedDelta): void => {
  const expectedOut = nonNegative(
    derived.outPeerCredit + derived.outCollateral + derived.outOwnCredit
    - derived.outAllowance - derived.outTotalHold,
  );
  const expectedIn = nonNegative(
    derived.inOwnCredit + derived.inCollateral + derived.inPeerCredit
    - derived.inAllowance - derived.inTotalHold,
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
        const delta = account.deltas.get(1)!;
        delta.collateral = collateral;
        delta.ondelta = debtDirection === 'right-owes-left' ? 80n : -80n;
        delta.offdelta = 0n;

        const grantorIsLeft = debtDirection === 'right-owes-left';
        const revoked = handleSetCreditLimit(account, {
          type: 'set_credit_limit',
          data: { tokenId: 1, amount: 0n },
        }, grantorIsLeft);
        expect(revoked.success).toBe(true);

        const creditorIsLeft = debtDirection === 'right-owes-left';
        const creditorView = deriveDelta(delta, creditorIsLeft);
        const debtorView = deriveDelta(delta, !creditorIsLeft);
        const unsecuredExposure = debtDirection === 'right-owes-left'
          ? nonNegative(80n - collateral)
          : 80n;
        expect(creditorView.outPeerCredit).toBe(unsecuredExposure);
        expect(creditorView.outCapacity >= 80n).toBe(true);
        expect(debtorView.outOwnCredit).toBe(0n);

        const cured = handleDirectPayment(account, {
          type: 'direct_payment',
          data: {
            tokenId: 1,
            amount: 80n,
            fromEntityId: creditorIsLeft ? leftEntity : rightEntity,
            toEntityId: creditorIsLeft ? rightEntity : leftEntity,
          },
        }, creditorIsLeft);
        expect(cured.success).toBe(true);
        expect(delta.ondelta + delta.offdelta).toBe(0n);
      }
    }
  });
});
