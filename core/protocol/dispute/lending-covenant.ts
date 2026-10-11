import type { AccountLendingCovenant } from '../../types/account';
import { requireBoundaryRecord, requireBoundaryInteger, requireExactBoundaryKeys } from '../boundary-validation';
import { UINT256_MAX } from '../boundary/integer-ranges';

export const LENDING_COVENANT_FIELDS = [
  'kind', 'tokenId', 'creditorIsLeft', 'principal', 'interest', 'openedAt', 'termMs', 'lateMs',
] as const satisfies readonly (keyof AccountLendingCovenant)[];

type LendingClock = Pick<AccountLendingCovenant, 'principal' | 'interest' | 'openedAt' | 'termMs' | 'lateMs'>;

export function assertLendingClock(row: { [K in keyof LendingClock]: unknown }): void {
  const openedAt = requireBoundaryInteger(row.openedAt, 'LENDING_COVENANT_OPENED_AT');
  const termMs = requireBoundaryInteger(row.termMs, 'LENDING_COVENANT_TERM', 1);
  const lateMs = requireBoundaryInteger(row.lateMs, 'LENDING_COVENANT_LATE');
  requireBoundaryInteger(openedAt + termMs + lateMs, 'LENDING_COVENANT_MATURITY');
  const { principal, interest } = row;
  if (typeof principal !== 'bigint' || principal <= 0n || typeof interest !== 'bigint' || interest < 0n ||
    principal + interest * BigInt(termMs + lateMs) / BigInt(termMs) > UINT256_MAX) throw new Error('LENDING_COVENANT_AMOUNT');
}

export function assertLendingCovenant(value: unknown): asserts value is AccountLendingCovenant {
  const row = requireBoundaryRecord(value, 'LENDING_COVENANT');
  requireExactBoundaryKeys(row, LENDING_COVENANT_FIELDS, [], 'LENDING_COVENANT_FIELDS');
  if ((row['kind'] !== 'savings' && row['kind'] !== 'loan') || typeof row['creditorIsLeft'] !== 'boolean') throw new Error('LENDING_COVENANT_ROLE');
  requireBoundaryInteger(row['tokenId'], 'LENDING_COVENANT_TOKEN', 1);
  assertLendingClock({ principal: row['principal'], interest: row['interest'], openedAt: row['openedAt'], termMs: row['termMs'], lateMs: row['lateMs'] });
  if (row['kind'] === 'savings' && row['lateMs'] !== 0) throw new Error('LENDING_SAVINGS_LATE_INTEREST');
}

/** Exit accelerates principal and earned simple interest. Freeze the quote at
 * dispute start so delaying finalization cannot increase the claim. An early
 * cooperative cancellation may bilaterally waive earned interest. */
export const lendingExitAmount = (claim: LendingClock, timestampMs: number): bigint => {
  const elapsed = BigInt(Math.max(0, Math.min(claim.termMs + claim.lateMs, timestampMs - claim.openedAt)));
  return claim.principal + claim.interest * elapsed / BigInt(claim.termMs);
};

/** Cooperative repayment pays the agreed term coupon even when early. A signed
 * maximum debit tolerates a stale UI quote without granting any extra interest. */
export const lendingRepaymentAmount = (claim: LendingClock, timestampMs: number): bigint =>
  lendingExitAmount(claim, Math.max(claim.openedAt + claim.termMs, timestampMs));

export const lendingMaximumAmount = (claim: LendingClock): bigint =>
  lendingExitAmount(claim, claim.openedAt + claim.termMs + claim.lateMs);

type LendingStateView = {
  subcontracts?: ReadonlyMap<unknown, unknown>;
  lendingIntents?: ReadonlyMap<unknown, unknown>;
  deltas: ReadonlyMap<unknown, unknown>;
};

const receiptKeys = (id: string) => id.startsWith('lend-')
  ? { open: 'fund', close: 'payout', kind: 'savings' }
  : { open: 'disburse', close: 'repay', kind: 'loan' };

/** Cold restore validation only; the hot proof path visits active claims. */
export const assertAccountLendingCovenants = (state: LendingStateView): void => {
  const intents = state.lendingIntents;
  for (const [id, value] of state.subcontracts ?? []) {
    const claim = requireBoundaryRecord(value, 'ACCOUNT_SUBCONTRACT');
    if (!('kind' in claim)) continue;
    assertLendingCovenant(claim);
    if (typeof id !== 'string' || !/^(lend|loan)-[0-9a-f]{16}$/.test(id)) throw new Error('LENDING_COVENANT_ID');
    const keys = receiptKeys(id);
    if (claim.kind !== keys.kind || !state.deltas.has(claim.tokenId) || intents?.get(keys.open + ':' + id) !== keys.open || intents.has(keys.close + ':' + id) || intents.has('dispute:' + id)) {
      throw new Error('LENDING_COVENANT_BINDING:' + id);
    }
  }
  for (const [id, kind] of intents ?? []) {
    if (kind === 'dispute-close') {
      if (typeof id !== 'string' || !/^dispute:(lend|loan)-[0-9a-f]{16}$/.test(id)) throw new Error('LENDING_DISPUTE_RECEIPT_ID:' + id);
      const claimId = id.slice('dispute:'.length);
      const keys = receiptKeys(claimId);
      if (intents?.get(keys.open + ':' + claimId) !== keys.open || intents.has(keys.close + ':' + claimId) || state.subcontracts?.has(claimId)) {
        throw new Error('LENDING_DISPUTE_RECEIPT_BINDING:' + claimId);
      }
    }
    if ((kind !== 'fund' && kind !== 'disburse') || typeof id !== 'string') continue;
    const claimId = id.slice(kind.length + 1);
    const keys = receiptKeys(claimId);
    const claim = state.subcontracts?.get(claimId);
    if (!intents?.has(keys.close + ':' + claimId) && intents?.get('dispute:' + claimId) !== 'dispute-close' && (!claim || typeof claim !== 'object' || !('kind' in claim) || claim.kind !== keys.kind)) {
      throw new Error('LENDING_UNSIGNED_' + keys.kind.toUpperCase() + '_MIGRATION_REQUIRED:' + claimId);
    }
  }
};
