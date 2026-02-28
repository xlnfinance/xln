/**
 * Guardrail: validate core deriveDelta invariants, especially hold accounting.
 */

import { deriveDelta } from '../../runtime/account-utils';
import type { Delta } from '../../runtime/types';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function nonNegative(value: bigint): bigint {
  return value > 0n ? value : 0n;
}

function makeDelta(partial: Partial<Delta>): Delta {
  return {
    tokenId: partial.tokenId ?? 1,
    collateral: partial.collateral ?? 0n,
    ondelta: partial.ondelta ?? 0n,
    offdelta: partial.offdelta ?? 0n,
    leftCreditLimit: partial.leftCreditLimit ?? 0n,
    rightCreditLimit: partial.rightCreditLimit ?? 0n,
    leftAllowance: partial.leftAllowance ?? 0n,
    rightAllowance: partial.rightAllowance ?? 0n,
    leftHold: partial.leftHold ?? 0n,
    rightHold: partial.rightHold ?? 0n,
  };
}

function checkHoldConsistency(): void {
  const delta = makeDelta({
    collateral: 100n,
    ondelta: 80n,
    offdelta: 0n,
    leftHold: 60n,
    rightHold: 7n,
  });

  const left = deriveDelta(delta, true);
  const right = deriveDelta(delta, false);

  // Perspective flip symmetry for unified holds.
  assert(left.outTotalHold === right.inTotalHold, 'hold flip failed: left.outTotalHold != right.inTotalHold');
  assert(left.inTotalHold === right.outTotalHold, 'hold flip failed: left.inTotalHold != right.outTotalHold');
}

function checkCapacityAccounting(): void {
  const delta = makeDelta({
    collateral: 150n,
    ondelta: 90n,
    leftCreditLimit: 20n,
    rightCreditLimit: 40n,
    leftAllowance: 3n,
    rightAllowance: 5n,
    leftHold: 19n,
    rightHold: 4n,
  });
  const d = deriveDelta(delta, true);

  const outHold = d.outTotalHold;
  const inHold = d.inTotalHold;
  const expectedOut = nonNegative(
    d.outPeerCredit + d.outCollateral + d.outOwnCredit - d.outAllowance - outHold,
  );
  const expectedIn = nonNegative(
    d.inOwnCredit + d.inCollateral + d.inPeerCredit - d.inAllowance - inHold,
  );

  assert(d.outCapacity === expectedOut, `outCapacity mismatch: got=${d.outCapacity} expected=${expectedOut}`);
  assert(d.inCapacity === expectedIn, `inCapacity mismatch: got=${d.inCapacity} expected=${expectedIn}`);
}

function checkFreeCollateralSafety(): void {
  const delta = makeDelta({
    collateral: 100n,
    ondelta: 80n,
    leftHold: 85n,
  });
  const d = deriveDelta(delta, true);

  const outHold = d.outTotalHold;
  const freeOutCollateral = d.outCollateral > outHold ? d.outCollateral - outHold : 0n;
  assert(d.outCollateral === 80n, `expected outCollateral=80, got ${d.outCollateral}`);
  assert(outHold === 85n, `expected outHold=85, got ${outHold}`);
  assert(freeOutCollateral === 0n, `free collateral must clamp at 0, got ${freeOutCollateral}`);
}

function main(): void {
  checkHoldConsistency();
  checkCapacityAccounting();
  checkFreeCollateralSafety();
  console.log('✅ deriveDelta invariants check passed');
}

main();
