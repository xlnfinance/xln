import type { AccountReplica, AccountState, Delta } from '../../types/account';
import { deriveTransferOffdeltaChange } from '../../protocol/transform/delta-movement';
import { compileOps } from '../../protocol/settlement/operations';
import { projectSettlementDeltaOverrides } from '../settlement/settlement-projection';
import { deriveDelta } from '../utils';
import { lendingMaximumAmount } from '../../protocol/dispute/lending-covenant';

type TokenRisk = Readonly<{
  left: bigint; right: bigint; leftLimit: bigint; rightLimit: bigint;
  leftCouponCapacity: bigint; rightCouponCapacity: bigint;
}>;
export type LendingRisk = ReadonlyMap<number, TokenRisk>;

const projectedRisk = (state: AccountState, delta: Delta, isLeft: boolean) => {
  const view = deriveDelta(delta, isLeft);
  let movement = deriveTransferOffdeltaChange(isLeft, view.outAllowance + view.outTotalHold);
  for (const claim of state.subcontracts?.values() ?? []) {
    if (!('kind' in claim) || claim.tokenId !== delta.tokenId) continue;
    // Principal settles on every exit. For this debtor's risk reserve its whole
    // promised coupon, but never count an opposite unearned coupon as security.
    const amount = claim.creditorIsLeft === isLeft ? claim.principal : lendingMaximumAmount(claim);
    movement += deriveTransferOffdeltaChange(!claim.creditorIsLeft, amount);
  }
  const projected = deriveDelta(delta, isLeft, movement);
  const limit = isLeft ? delta.leftCreditLimit : delta.rightCreditLimit;
  // Funding and its principal claim cancel. Only the new promised coupon adds
  // liability; existing collateral absorbs it before accepted unsecured risk.
  return { debt: projected.inOwnCredit, couponCapacity: limit + projected.outCollateral - projected.inOwnCredit };
};

/** One ephemeral reservation for ordinary debt, outstanding signed claims and
 * pending financial work. A C2R must reserve its loss of collateral before
 * signatures authorize it; the eventual chain observation cannot be rejected.
 * R2C holds offset pending incoming collateral until the chain confirms it. */
export const accountLendingRisk = (account: AccountReplica): LendingRisk => {
  const deltas = new Map(account.state.deltas);
  const workspace = account.state.settlementWorkspace;
  if (workspace) {
    const { diffs, forgiveTokenIds } = compileOps(workspace.ops, workspace.lastModifiedByLeft);
    for (const [id, delta] of projectSettlementDeltaOverrides(account, diffs, forgiveTokenIds)) deltas.set(id, delta);
  }
  return new Map([...deltas].map(([id, delta]) => {
    const left = projectedRisk(account.state, delta, true);
    const right = projectedRisk(account.state, delta, false);
    return [id, {
      left: left.debt, right: right.debt, leftLimit: delta.leftCreditLimit, rightLimit: delta.rightCreditLimit,
      leftCouponCapacity: left.couponCapacity, rightCouponCapacity: right.couponCapacity,
    }];
  }));
};

export const lendingRiskAdmissionError = (before: LendingRisk, after: LendingRisk): string | undefined => {
  for (const [tokenId, risk] of after) for (const side of ['left', 'right'] as const) {
    const previous = before.get(tokenId)?.[side] ?? 0n;
    const limit = side === 'left' ? risk.leftLimit : risk.rightLimit;
    // Lowering a limit is prospective. Repayment, netting and completing
    // already-reserved work must stay possible even above the reduced limit.
    if (risk[side] > limit && risk[side] > previous) {
      return `LENDING_CREDIT_EXPOSURE_EXCEEDED:token=${tokenId}:side=${side}:risk=${risk[side]}:limit=${limit}`;
    }
  }
  return undefined;
};
