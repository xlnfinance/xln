import type { AccountLendingCovenant } from '../../types/account';
import { requireBoundaryRecord, requireBoundaryInteger, requireExactBoundaryKeys } from '../boundary-validation';
import { UINT256_MAX } from '../boundary/integer-ranges';
import { keccakTextHash } from '../crypto/keccak-text';
import { safeStringify } from '../serialization';

export const LENDING_COVENANT_FIELDS = [
  'kind', 'tokenId', 'creditorIsLeft', 'principal', 'interestBps', 'openedAt',
  'accruedAt', 'accruedInterest', 'interestRemainder', 'termMs', 'lateMs',
] as const satisfies readonly (keyof AccountLendingCovenant)[];

export type LendingClock = Pick<AccountLendingCovenant,
  'principal' | 'interestBps' | 'openedAt' | 'accruedAt' | 'accruedInterest' | 'interestRemainder' | 'termMs' | 'lateMs'>;

export function assertLendingClock(row: { [K in keyof LendingClock]: unknown }): void {
  const openedAt = requireBoundaryInteger(row.openedAt, 'LENDING_COVENANT_OPENED_AT');
  const termMs = requireBoundaryInteger(row.termMs, 'LENDING_COVENANT_TERM', 1);
  const lateMs = requireBoundaryInteger(row.lateMs, 'LENDING_COVENANT_LATE');
  const end = requireBoundaryInteger(openedAt + termMs + lateMs, 'LENDING_COVENANT_MATURITY');
  const accruedAt = requireBoundaryInteger(row.accruedAt, 'LENDING_COVENANT_ACCRUED_AT', openedAt);
  const interestBps = requireBoundaryInteger(row.interestBps, 'LENDING_COVENANT_RATE');
  if (accruedAt > end || interestBps > 10_000) throw new Error('LENDING_COVENANT_CLOCK');
  const { principal, accruedInterest, interestRemainder } = row;
  const denominator = 10_000n * BigInt(termMs);
  if (typeof principal !== 'bigint' || principal < 0n || typeof accruedInterest !== 'bigint' || accruedInterest < 0n ||
    typeof interestRemainder !== 'bigint' || interestRemainder < 0n || interestRemainder >= denominator ||
    principal + accruedInterest + (principal * BigInt(interestBps) * BigInt(end - accruedAt) + interestRemainder) / denominator > UINT256_MAX) {
    throw new Error('LENDING_COVENANT_AMOUNT');
  }
}

export function assertLendingCovenant(value: unknown): asserts value is AccountLendingCovenant {
  const row = requireBoundaryRecord(value, 'LENDING_COVENANT');
  requireExactBoundaryKeys(row, LENDING_COVENANT_FIELDS, [], 'LENDING_COVENANT_FIELDS');
  if ((row['kind'] !== 'savings' && row['kind'] !== 'loan') || typeof row['creditorIsLeft'] !== 'boolean') throw new Error('LENDING_COVENANT_ROLE');
  requireBoundaryInteger(row['tokenId'], 'LENDING_COVENANT_TOKEN', 1);
  assertLendingClock({ principal: row['principal'], interestBps: row['interestBps'], openedAt: row['openedAt'],
    accruedAt: row['accruedAt'], accruedInterest: row['accruedInterest'], interestRemainder: row['interestRemainder'],
    termMs: row['termMs'], lateMs: row['lateMs'] });
  if (row['principal'] === 0n) throw new Error('LENDING_COVENANT_EMPTY');
  if (row['kind'] === 'savings' && row['lateMs'] !== 0) throw new Error('LENDING_SAVINGS_LATE_INTEREST');
}

/** Exit accelerates principal and earned simple interest. Freeze the quote at
 * dispute start so delaying finalization cannot increase the claim. An early
 * cooperative cancellation may bilaterally waive earned interest. */
const accrueLendingInterest = (claim: LendingClock, timestampMs: number) => {
  const accruedAt = Math.max(claim.accruedAt, Math.min(timestampMs, claim.openedAt + claim.termMs + claim.lateMs));
  const denominator = 10_000n * BigInt(claim.termMs);
  const numerator = claim.principal * BigInt(claim.interestBps) * BigInt(accruedAt - claim.accruedAt) + claim.interestRemainder;
  return { accruedAt, accruedInterest: claim.accruedInterest + numerator / denominator, interestRemainder: numerator % denominator };
};

export const lendingExitAmount = (claim: LendingClock, timestampMs: number): bigint =>
  claim.principal + accrueLendingInterest(claim, timestampMs).accruedInterest;

export const lendingMaximumAmount = (claim: LendingClock): bigint =>
  lendingExitAmount(claim, claim.openedAt + claim.termMs + claim.lateMs);

/** One settlement rule: earned interest first, then principal. Preserve the
 * fractional numerator so repeated small payments cannot erase accrued debt.
 * The original maturity and rate never reset; unpaid interest never compounds. */
export const settleLendingPayment = (claim: LendingClock, maximum: bigint, timestampMs: number) => {
  if (maximum <= 0n) throw new Error('LENDING_PAYMENT_AMOUNT');
  const accrued = accrueLendingInterest(claim, timestampMs);
  const owed = claim.principal + accrued.accruedInterest;
  const amount = maximum < owed ? maximum : owed;
  const interestPaid = amount < accrued.accruedInterest ? amount : accrued.accruedInterest;
  const principal = claim.principal - (amount - interestPaid);
  return { amount, clock: { ...claim, ...accrued, principal,
    accruedInterest: accrued.accruedInterest - interestPaid,
    interestRemainder: principal === 0n ? 0n : accrued.interestRemainder } };
};

export const lendingCovenantHash = (claim: AccountLendingCovenant): string =>
  keccakTextHash(safeStringify(LENDING_COVENANT_FIELDS.map(field => claim[field])));

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
