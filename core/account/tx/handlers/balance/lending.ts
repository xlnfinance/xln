import type { AccountLendingIntentKind, AccountReplica, AccountTx } from '../../../../types/account';
import type { AccountDraftReplica } from '../../../state/account-state-draft';
import { LENDING_TERM_MS, normalizeInterestBps, normalizeLendingTerm } from '../../../../lendbook/state';
import { UINT256_MAX } from '../../../../protocol/boundary/integer-ranges';
import { handleDirectPayment } from './direct-payment';
import type { ApplyAccountTxResult } from '../../apply-types';
import { accountTxApplied, accountTxValidationRejected } from '../../apply-result';
import { deriveDelta } from '../../../utils';
import { keccakTextHash } from '../../../../protocol/crypto/keccak-text';
import { safeStringify } from '../../../../protocol/serialization';
import { assertLendingCovenant, lendingCovenantHash, lendingMaximumAmount, settleLendingPayment, renewDemandSavings, lendingExitAmount } from '../../../../protocol/dispute/lending-covenant';
import { requireBoundaryInteger } from '../../../../protocol/boundary-validation';

type LendingAccountTx = Extract<AccountTx, {
  type:
    | 'lending_rate'
    | 'lending_fund'
    | 'lending_borrow_request'
    | 'lending_repay'
    | 'lending_disburse'
    | 'lending_close_request'
    | 'lending_close_payout';
}>;

type LendingResult = ApplyAccountTxResult;

const ENTITY_ID_RE = /^0x[0-9a-f]{64}$/;
const INTENT_ID_RE = /^(?:lend|borrow|loan)-[0-9a-f]{16}$/;

const normalized = (value: unknown): string => String(value || '').trim().toLowerCase();

const proposerId = (account: AccountReplica, byLeft: boolean): string =>
  normalized(byLeft ? account.state.leftEntity : account.state.rightEntity);

const requireRole = (
  account: AccountReplica,
  byLeft: boolean,
  role: 'lender' | 'borrower' | 'hub',
  claimedEntityId: string,
): void => {
  const claimed = normalized(claimedEntityId);
  if (!ENTITY_ID_RE.test(claimed)) throw new Error(`LENDING_${role.toUpperCase()}_INVALID:${claimedEntityId}`);
  const proposer = proposerId(account, byLeft);
  if (claimed !== proposer) {
    throw new Error(`LENDING_${role.toUpperCase()}_NOT_PROPOSER: claimed=${claimed} proposer=${proposer}`);
  }
};

const requireCounterparty = (account: AccountReplica, proposer: string, counterparty: string): void => {
  const left = normalized(account.state.leftEntity);
  const right = normalized(account.state.rightEntity);
  const expected = proposer === left ? right : left;
  if (normalized(counterparty) !== expected) {
    throw new Error(`LENDING_COUNTERPARTY_INVALID: expected=${expected} got=${normalized(counterparty)}`);
  }
};

const requireIntentId = (value: string, prefix: 'lend' | 'borrow' | 'loan'): void => {
  const id = normalized(value);
  if (!INTENT_ID_RE.test(id) || !id.startsWith(`${prefix}-`)) {
    throw new Error(`LENDING_INTENT_ID_INVALID:${value}`);
  }
};

/** The one Account intent ledger: lending and credit requests share it. */
const consumeIntent = (
  account: AccountDraftReplica,
  key: string,
  kind: AccountLendingIntentKind,
): void => {
  if (account.state.lendingIntents.has(key)) throw new Error(`LENDING_INTENT_REPLAY:${key}`);
  account.state.lendingIntents.put(key, kind);
};

const requireUnusedIntent = (account: AccountReplica, key: string): void => {
  if (account.state.lendingIntents?.has(key)) throw new Error(`LENDING_INTENT_REPLAY:${key}`);
};

const positiveAmount = (value: bigint, context: string): void => {
  if (value <= 0n) throw new Error(`${context}_AMOUNT_MUST_BE_POSITIVE`);
};

const borrowAuthorizationKey = (
  account: AccountReplica,
  data: Extract<AccountTx, { type: 'lending_borrow_request' }>['data'],
): string => `authorize:${keccakTextHash(safeStringify([
  'xln:borrow', account.state.domain.chainId, account.state.domain.depositoryAddress, account.state.jNonce,
  data.requestId, data.hubEntityId, data.borrowerEntityId, data.tokenId,
  data.amount, data.termId, data.maxInterestBps, data.maxLateMs, data.expiresAt,
]))}`;

const applyPayment = (
  account: AccountDraftReplica,
  tx: Extract<LendingAccountTx, { type: 'lending_fund' | 'lending_repay' | 'lending_close_payout' | 'lending_disburse' }>,
  byLeft: boolean,
): LendingResult => {
  const data = tx.data;
  let payer: string;
  let recipient: string;
  if (tx.type === 'lending_close_payout') {
    payer = tx.data.hubEntityId;
    recipient = tx.data.lenderEntityId;
  } else if (tx.type === 'lending_disburse') {
    payer = tx.data.hubEntityId;
    recipient = tx.data.borrowerEntityId;
  } else if (tx.type === 'lending_fund') {
    payer = tx.data.lenderEntityId;
    recipient = tx.data.hubEntityId;
  } else {
    payer = tx.data.borrowerEntityId;
    recipient = tx.data.hubEntityId;
  }
  const result = handleDirectPayment(account, {
    type: 'direct_payment',
    data: {
      tokenId: data.tokenId,
      amount: data.amount,
      route: [recipient],
      fromEntityId: payer,
      toEntityId: recipient,
      deliveryMode: 'direct',
      description: `xln:${tx.type}`,
    },
  }, byLeft);
  return result;
};

const applyTermLoanFunding = (
  account: AccountDraftReplica,
  tx: Extract<LendingAccountTx, { type: 'lending_fund' | 'lending_disburse' }>,
  byLeft: boolean,
  timestamp: number,
): LendingResult => {
  const isSavings = tx.type === 'lending_fund';
  const id = isSavings ? tx.data.positionId : tx.data.loanId;
  if (id !== normalized(id)) {
    return accountTxValidationRejected('LENDING_POSITION_ID_NON_CANONICAL', []);
  }
  requireIntentId(id, isSavings ? 'lend' : 'loan');
  const payer = isSavings ? tx.data.lenderEntityId : tx.data.hubEntityId;
  const recipient = isSavings ? tx.data.hubEntityId : tx.data.borrowerEntityId;
  requireRole(account, byLeft, isSavings ? 'lender' : 'hub', payer);
  requireCounterparty(account, normalized(payer), recipient);
  positiveAmount(tx.data.amount, 'LENDING_FUND');
  normalizeLendingTerm(tx.data.termId);
  normalizeInterestBps(tx.data.interestBps);
  const intentKind = isSavings ? 'fund' : 'disburse';
  const intentKey = `${intentKind}:${id}`;
  requireUnusedIntent(account, intentKey);
  if (!isSavings) {
    requireBoundaryInteger(tx.data.lateMs, 'LENDING_LATE_WINDOW_INVALID');
    requireBoundaryInteger(tx.data.maxLateMs, 'LENDING_MAX_LATE_WINDOW_INVALID');
  }
  if (!isSavings && (timestamp >= tx.data.expiresAt || tx.data.interestBps > tx.data.maxInterestBps || tx.data.lateMs > tx.data.maxLateMs ||
    account.state.lendingIntents.get(borrowAuthorizationKey(account, tx.data)) !== 'borrow')) {
    return accountTxValidationRejected('LENDING_BORROW_AUTHORIZATION_MISMATCH', []);
  }
  const delta = account.state.deltas.get(tx.data.tokenId);
  // Only the certified lender's existing assets may fund the pool. Subtract
  // unused borrowing permission; outCapacity already excludes allowances/holds.
  // Otherwise own=0, credit=100 would create a 100 deposit backed by new debt.
  const funds = delta ? deriveDelta(delta, byLeft) : undefined;
  if (isSavings && (!funds || tx.data.amount + funds.outOwnCredit > funds.outCapacity)) {
    return accountTxValidationRejected('LENDING_FUND_OWNED_BALANCE_INSUFFICIENT', []);
  }
  if (!isSavings && tx.data.termId === 'demand') return accountTxValidationRejected('LENDING_LOAN_TERM_REQUIRED', []);
  const covenant = {
    kind: isSavings ? tx.data.termId === 'demand' ? 'demand' as const : 'savings' as const : 'loan' as const, tokenId: tx.data.tokenId, creditorIsLeft: byLeft,
    principal: tx.data.amount, interestBps: tx.data.interestBps,
    accruedAt: timestamp, accruedInterest: 0n, interestRemainder: 0n,
    openedAt: timestamp, termMs: LENDING_TERM_MS[tx.data.termId], lateMs: isSavings ? 0 : tx.data.lateMs,
  };
  if (!Number.isSafeInteger(covenant.openedAt + covenant.termMs)) {
    return accountTxValidationRejected('LENDING_SAVINGS_MATURITY_OVERFLOW', []);
  }
  if (lendingMaximumAmount(covenant) > UINT256_MAX) return accountTxValidationRejected('LENDING_SAVINGS_AMOUNT_OVERFLOW', []);
  assertLendingCovenant(covenant);
  const result = applyPayment(account, tx, byLeft);
  if (result.ok) {
    consumeIntent(account, intentKey, intentKind);
    // Only the borrower's earlier signed request authorizes debt. Bind its exact
    // terms and J epoch; consume atomically so another loan id cannot draw twice.
    if (!isSavings) account.state.lendingIntents.del(borrowAuthorizationKey(account, tx.data));
    account.state.subcontracts.put(id, covenant);
  }
  return result;
};

const applySavingsRate = (
  account: AccountDraftReplica, tx: Extract<LendingAccountTx, { type: 'lending_rate' }>, byLeft: boolean, timestamp: number,
): LendingResult => {
  requireIntentId(tx.data.positionId, 'lend');
  requireRole(account, byLeft, 'hub', tx.data.hubEntityId);
  requireCounterparty(account, normalized(tx.data.hubEntityId), tx.data.lenderEntityId);
  const claim = account.state.subcontracts.get(tx.data.positionId);
  // Only the bank may propose a new prospective rate. The exact preceding
  // signed claim prevents replay/repricing; pending withdrawal has priority.
  if (!claim || !('kind' in claim) || claim.kind !== 'demand' || claim.creditorIsLeft === byLeft ||
    claim.tokenId !== tx.data.tokenId || account.state.lendingIntents.has('close:' + tx.data.positionId)) {
    return accountTxValidationRejected('LENDING_RATE_COVENANT_MISMATCH', []);
  }
  if (tx.data.claimHash !== lendingCovenantHash(claim)) return accountTxValidationRejected('LENDING_RATE_COVENANT_CHANGED', []);
  const renewed = renewDemandSavings(claim, tx.data.interestBps, timestamp);
  if (!renewed.ok) return accountTxValidationRejected(renewed.reason, []);
  account.state.subcontracts.put(tx.data.positionId, renewed.claim);
  return accountTxApplied(['Demand savings rate renewed']);
};

const applySavingsCloseRequest = (
  account: AccountDraftReplica, tx: Extract<LendingAccountTx, { type: 'lending_close_request' }>,
  byLeft: boolean, timestamp: number,
): LendingResult => {
  requireIntentId(tx.data.positionId, 'lend');
  requireRole(account, byLeft, 'lender', tx.data.lenderEntityId);
  requireCounterparty(account, normalized(tx.data.lenderEntityId), tx.data.hubEntityId);
  const covenant = account.state.subcontracts.get(tx.data.positionId);
  if (!covenant || !('kind' in covenant) || (covenant.kind !== 'savings' && covenant.kind !== 'demand') || covenant.creditorIsLeft !== byLeft) {
    return accountTxValidationRejected('LENDING_CLOSE_COVENANT_MISMATCH', []);
  }
  // The lender's first signed Account clock fixes cancellation versus full
  // coupon. Commit that choice in the existing intent root: later retries,
  // ACK delivery or restored payment clocks cannot reprice the authorization.
  // The separate payout nonce still permits exactly one atomic extinguishment.
  const intentKey = `close:${normalized(tx.data.positionId)}`;
  const prior = account.state.lendingIntents.get(intentKey);
  const validPrior =
    covenant.kind === 'demand' ? prior === 'close-request' : prior === 'close-early' || prior === 'close-mature';
  if (prior !== undefined && !validPrior) throw new Error(`LENDING_CLOSE_INTENT_INVALID:${intentKey}`);
  if (prior === undefined)
    consumeIntent(
      account,
      intentKey,
      covenant.kind === 'demand'
        ? 'close-request'
        : timestamp < covenant.openedAt + covenant.termMs
          ? 'close-early'
          : 'close-mature',
    );
  return accountTxApplied([`Lending close request ${tx.data.positionId} committed`]);
};

export const handleLendingAccountTx = (
  account: AccountDraftReplica, tx: LendingAccountTx, byLeft: boolean, timestamp: number,
): LendingResult => {
  if (tx.type === 'lending_fund' || tx.type === 'lending_disburse') return applyTermLoanFunding(account, tx, byLeft, timestamp);
  if (tx.type === 'lending_rate') return applySavingsRate(account, tx, byLeft, timestamp);

  if (tx.type === 'lending_borrow_request') {
    if (tx.data.termId === 'demand') return accountTxValidationRejected('LENDING_LOAN_TERM_REQUIRED', []);
    requireIntentId(tx.data.requestId, 'borrow');
    requireRole(account, byLeft, 'borrower', tx.data.borrowerEntityId);
    requireCounterparty(account, normalized(tx.data.borrowerEntityId), tx.data.hubEntityId);
    positiveAmount(tx.data.amount, 'LENDING_BORROW');
    normalizeLendingTerm(tx.data.termId);
    normalizeInterestBps(tx.data.maxInterestBps);
    requireBoundaryInteger(tx.data.maxLateMs, 'LENDING_MAX_LATE_WINDOW_INVALID');
    requireBoundaryInteger(tx.data.expiresAt + LENDING_TERM_MS[tx.data.termId] + tx.data.maxLateMs, 'LENDING_BORROW_CLOCK_OVERFLOW');
    if (tx.data.requestId !== normalized(tx.data.requestId) || !Number.isSafeInteger(tx.data.expiresAt) || timestamp >= tx.data.expiresAt) {
      return accountTxValidationRejected('LENDING_BORROW_AUTHORIZATION_EXPIRED_OR_INVALID', []);
    }
    const intentKey = `borrow:${normalized(tx.data.requestId)}`;
    // A separately signed reuse of a consumed request is sender-caused. Reject
    // exactly this transaction before recording another authorization or draw.
    if (account.state.lendingIntents.has(intentKey))
      return accountTxValidationRejected(`LENDING_INTENT_REPLAY:${intentKey}`, []);
    consumeIntent(account, intentKey, 'borrow');
    consumeIntent(account, borrowAuthorizationKey(account, tx.data), 'borrow');
    return accountTxApplied([`Lending borrow request ${tx.data.requestId} committed`]);
  }

  if (tx.type === 'lending_repay') {
    requireIntentId(tx.data.loanId, 'loan');
    requireRole(account, byLeft, 'borrower', tx.data.borrowerEntityId);
    requireCounterparty(account, normalized(tx.data.borrowerEntityId), tx.data.hubEntityId);
    positiveAmount(tx.data.amount, 'LENDING_REPAY');
    const intentKey = `repay:${normalized(tx.data.loanId)}`;
    requireUnusedIntent(account, intentKey);
    const covenant = account.state.subcontracts.get(tx.data.loanId);
    // The debtor's frame authorizes a debit of this exact claim revision. A
    // replayed partial payment cannot debit a second time or reset its clock.
    if (!covenant || !('kind' in covenant) || covenant.kind !== 'loan' || covenant.creditorIsLeft === byLeft || covenant.tokenId !== tx.data.tokenId) {
      return accountTxValidationRejected('LENDING_REPAY_COVENANT_MISMATCH', []);
    }
    if (tx.data.claimHash !== lendingCovenantHash(covenant)) return accountTxValidationRejected('LENDING_REPAY_COVENANT_CHANGED', []);
    const paid = settleLendingPayment(covenant, tx.data.amount, timestamp);
    const result = applyPayment(account, { ...tx, data: { ...tx.data, amount: paid.amount } }, byLeft);
    if (result.ok) {
      if (paid.clock.principal === 0n) {
        consumeIntent(account, intentKey, 'repay');
        account.state.subcontracts.del(tx.data.loanId);
      } else {
        account.state.subcontracts.put(tx.data.loanId, { ...covenant, ...paid.clock });
      }
    }
    return result;
  }

  if (tx.type === 'lending_close_request') return applySavingsCloseRequest(account, tx, byLeft, timestamp);

  requireIntentId(tx.data.positionId, 'lend');
  requireRole(account, byLeft, 'hub', tx.data.hubEntityId);
  requireCounterparty(account, normalized(tx.data.hubEntityId), tx.data.lenderEntityId);
  positiveAmount(tx.data.amount, 'LENDING_CLOSE_PAYOUT');
  const intentKey = `payout:${normalized(tx.data.positionId)}`;
  requireUnusedIntent(account, intentKey);
  const covenant = account.state.subcontracts.get(tx.data.positionId);
  // Both parties certify the payout and extinguishment together. A token swap,
  // another saver, or a one-unit payout must never erase the funded principal.
  if (!covenant || !('kind' in covenant) || (covenant.kind !== 'savings' && covenant.kind !== 'demand') || covenant.creditorIsLeft === byLeft || covenant.tokenId !== tx.data.tokenId || tx.data.amount < covenant.principal || tx.data.amount > lendingMaximumAmount(covenant)) {
    return accountTxValidationRejected('LENDING_PAYOUT_COVENANT_MISMATCH', []);
  }
  const closeIntent = account.state.lendingIntents.get('close:' + tx.data.positionId);
  if (covenant.kind === 'savings' && closeIntent !== 'close-early' && closeIntent !== 'close-mature') {
    return accountTxValidationRejected('LENDING_SAVINGS_CLOSE_AUTHORIZATION_REQUIRED', []);
  }
  const amount =
    covenant.kind === 'demand'
      ? lendingExitAmount(covenant, timestamp)
      : closeIntent === 'close-early'
        ? covenant.principal
        : lendingMaximumAmount(covenant);
  if (covenant.kind === 'savings' && tx.data.amount !== amount) {
    return accountTxValidationRejected('LENDING_SAVINGS_PAYOUT_AMOUNT_MISMATCH', []);
  }
  if (covenant.kind === 'demand' && (tx.data.amount < amount || account.state.lendingIntents.get('close:' + tx.data.positionId) !== 'close-request')) {
    return accountTxValidationRejected('LENDING_DEMAND_PAYOUT_INCOMPLETE', []);
  }
  const result = applyPayment(account, { ...tx, data: { ...tx.data, amount } }, byLeft);
  if (result.ok) {
    consumeIntent(account, intentKey, 'close-payout');
    account.state.subcontracts.del(tx.data.positionId);
  }
  return result;
};
