import type { AccountMachine, AccountTx } from '../../../types';
import { normalizeInterestBps, normalizeLendingTerm } from '../../../lending';
import { handleDirectPayment } from './direct-payment';
import { handleSetCreditLimit } from './set-credit-limit';

type LendingAccountTx = Extract<AccountTx, {
  type:
    | 'lending_fund'
    | 'lending_borrow_request'
    | 'lending_repay'
    | 'lending_credit'
    | 'lending_close_request'
    | 'lending_close_payout';
}>;

type LendingResult = { success: boolean; events: string[]; error?: string };

const ENTITY_ID_RE = /^0x[0-9a-f]{64}$/;
const INTENT_ID_RE = /^(?:lend|borrow|loan)-[0-9a-f]{16}$/;

const normalized = (value: unknown): string => String(value || '').trim().toLowerCase();

const proposerId = (account: AccountMachine, byLeft: boolean): string =>
  normalized(byLeft ? account.leftEntity : account.rightEntity);

const requireRole = (
  account: AccountMachine,
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

const requireCounterparty = (account: AccountMachine, proposer: string, counterparty: string): void => {
  const left = normalized(account.leftEntity);
  const right = normalized(account.rightEntity);
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

const consumeIntent = (
  account: AccountMachine,
  key: string,
  kind: NonNullable<AccountMachine['lendingIntents']> extends Map<string, infer K> ? K : never,
): void => {
  account.lendingIntents ??= new Map();
  if (account.lendingIntents.has(key)) throw new Error(`LENDING_INTENT_REPLAY:${key}`);
  account.lendingIntents.set(key, kind);
};

const requireUnusedIntent = (account: AccountMachine, key: string): void => {
  if (account.lendingIntents?.has(key)) throw new Error(`LENDING_INTENT_REPLAY:${key}`);
};

const positiveAmount = (value: bigint, context: string): void => {
  if (value <= 0n) throw new Error(`${context}_AMOUNT_MUST_BE_POSITIVE`);
};

const applyPayment = (
  account: AccountMachine,
  tx: Extract<LendingAccountTx, { type: 'lending_fund' | 'lending_repay' | 'lending_close_payout' }>,
  byLeft: boolean,
): LendingResult => {
  const data = tx.data;
  let payer: string;
  let recipient: string;
  if (tx.type === 'lending_close_payout') {
    payer = tx.data.hubEntityId;
    recipient = tx.data.lenderEntityId;
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
      route: [payer, recipient],
      fromEntityId: payer,
      toEntityId: recipient,
      description: `xln:${tx.type}`,
    },
  }, byLeft);
  return result;
};

export const handleLendingAccountTx = (
  account: AccountMachine,
  tx: LendingAccountTx,
  byLeft: boolean,
): LendingResult => {
  if (tx.type === 'lending_fund') {
    requireIntentId(tx.data.positionId, 'lend');
    requireRole(account, byLeft, 'lender', tx.data.lenderEntityId);
    requireCounterparty(account, normalized(tx.data.lenderEntityId), tx.data.hubEntityId);
    positiveAmount(tx.data.amount, 'LENDING_FUND');
    normalizeLendingTerm(tx.data.termId);
    normalizeInterestBps(tx.data.interestBps);
    const intentKey = `fund:${normalized(tx.data.positionId)}`;
    requireUnusedIntent(account, intentKey);
    const result = applyPayment(account, tx, byLeft);
    if (result.success) consumeIntent(account, intentKey, 'fund');
    return result;
  }

  if (tx.type === 'lending_borrow_request') {
    requireIntentId(tx.data.requestId, 'borrow');
    requireRole(account, byLeft, 'borrower', tx.data.borrowerEntityId);
    requireCounterparty(account, normalized(tx.data.borrowerEntityId), tx.data.hubEntityId);
    positiveAmount(tx.data.amount, 'LENDING_BORROW');
    normalizeLendingTerm(tx.data.termId);
    normalizeInterestBps(tx.data.maxInterestBps);
    consumeIntent(account, `borrow:${normalized(tx.data.requestId)}`, 'borrow');
    return { success: true, events: [`Lending borrow request ${tx.data.requestId} committed`] };
  }

  if (tx.type === 'lending_repay') {
    requireIntentId(tx.data.loanId, 'loan');
    requireRole(account, byLeft, 'borrower', tx.data.borrowerEntityId);
    requireCounterparty(account, normalized(tx.data.borrowerEntityId), tx.data.hubEntityId);
    positiveAmount(tx.data.amount, 'LENDING_REPAY');
    const intentKey = `repay:${normalized(tx.data.loanId)}`;
    requireUnusedIntent(account, intentKey);
    const result = applyPayment(account, tx, byLeft);
    if (result.success) consumeIntent(account, intentKey, 'repay');
    return result;
  }

  if (tx.type === 'lending_credit') {
    requireIntentId(tx.data.loanId, 'loan');
    requireRole(account, byLeft, 'hub', tx.data.hubEntityId);
    requireCounterparty(account, normalized(tx.data.hubEntityId), tx.data.borrowerEntityId);
    if (tx.data.creditLimit < 0n) throw new Error(`LENDING_CREDIT_LIMIT_NEGATIVE:${tx.data.creditLimit}`);
    const result = handleSetCreditLimit(account, {
      type: 'set_credit_limit',
      data: { tokenId: tx.data.tokenId, amount: tx.data.creditLimit },
    }, byLeft);
    if (result.success) {
      consumeIntent(
        account,
        `${tx.data.action === 'grant' ? 'grant' : 'revoke'}:${normalized(tx.data.loanId)}`,
        tx.data.action === 'grant' ? 'credit-grant' : 'credit-revoke',
      );
    }
    return result;
  }

  if (tx.type === 'lending_close_request') {
    requireIntentId(tx.data.positionId, 'lend');
    requireRole(account, byLeft, 'lender', tx.data.lenderEntityId);
    requireCounterparty(account, normalized(tx.data.lenderEntityId), tx.data.hubEntityId);
    consumeIntent(account, `close:${normalized(tx.data.positionId)}`, 'close-request');
    return { success: true, events: [`Lending close request ${tx.data.positionId} committed`] };
  }

  requireIntentId(tx.data.positionId, 'lend');
  requireRole(account, byLeft, 'hub', tx.data.hubEntityId);
  requireCounterparty(account, normalized(tx.data.hubEntityId), tx.data.lenderEntityId);
  positiveAmount(tx.data.amount, 'LENDING_CLOSE_PAYOUT');
  const intentKey = `payout:${normalized(tx.data.positionId)}`;
  requireUnusedIntent(account, intentKey);
  const result = applyPayment(account, tx, byLeft);
  if (result.success) consumeIntent(account, intentKey, 'close-payout');
  return result;
};
