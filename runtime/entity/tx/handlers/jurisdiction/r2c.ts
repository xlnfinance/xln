/**
 * Deposit Collateral Handler
 *
 * Entity moves own reserve → account collateral (unilateral on-chain action)
 * Reference: 2019src.txt lines 233-239 (reserveToCollateral batchAdd)
 * Reference: Depository.sol reserveToCollateral() (line 1035)
 *
 * Enhanced: optional rebalance fee collection (atomic with deposit)
 * See docs/rebalance.md for fee flow spec
 *
 * Flow:
 * 1. Entity validates sufficient reserve
 * 2. Add R→C operation to jBatch
 * 3. If rebalanceQuoteId present: validate + collect fee via bilateral offdelta shift
 * 4. Wait for jBatch crontab to broadcast
 * 5. On-chain event triggers bilateral account state update
 */

import type { EntityState, EntityInput } from '../../../types';
import type { JInput } from '../../../../jurisdiction/machine/input';
import type { EntityTx } from '../../../../types/entity-tx';
import type { AccountTx } from '../../../../types/account';
import { QUOTE_EXPIRY_MS } from '../../../../types/finance/rebalance';
import { prepareEntityTxState } from '../../../state-clone';
import { addMessage } from '../../../frame-events';
import { getEntityAccountForWrite } from '../../../state/persistent-account-map';
import { batchAddReserveToCollateral, initJBatch } from '../../../../jurisdiction/machine/batch';
import { createStructuredLogger, formatAmount, shortId } from '../../../../infra/logger';
import { getReserveCandidateIssue } from './j-batch-reserve-admission';

type AccountTxTarget = { accountId: string; tx: AccountTx };

const r2cLog = createStructuredLogger('entity.r2c');

const collectRebalanceFee = (
  originalState: EntityState,
  state: EntityState,
  tx: Extract<EntityTx, { type: 'r2c' }>,
  localReceivingEntity: boolean,
  accountTxs: AccountTxTarget[],
): boolean => {
  const {
    counterpartyId,
    rebalanceQuoteId,
    rebalanceFeeAmount,
    rebalanceFeeTokenId,
  } = tx.data;
  if (rebalanceQuoteId === undefined) return true;
  if (!localReceivingEntity) {
    addMessage(state, '❌ Rebalance fee unsupported for remote reserve → account deposits');
    return false;
  }
  const visible = state.accounts.get(counterpartyId);
  const quote = visible?.shadow.rebalance.activeQuote;
  r2cLog.debug('quote.validate', {
    entity: shortId(originalState.entityId),
    counterparty: shortId(counterpartyId),
    hasAccount: Boolean(visible),
    quote: quote
      ? {
        quoteId: quote.quoteId,
        accepted: quote.accepted,
        feeTokenId: quote.feeTokenId,
        feeAmount: formatAmount(quote.feeAmount),
      }
      : null,
  });
  if (!quote) {
    addMessage(state, `❌ Rebalance fee: no active quote for ${counterpartyId.slice(-4)}`);
    return false;
  }
  if (quote.quoteId !== rebalanceQuoteId) {
    addMessage(state, `❌ Rebalance fee: quoteId mismatch (expected ${quote.quoteId}, got ${rebalanceQuoteId})`);
    return false;
  }
  if (!quote.accepted) {
    addMessage(state, '❌ Rebalance fee: quote not accepted');
    return false;
  }
  if (originalState.timestamp > quote.quoteId + QUOTE_EXPIRY_MS) {
    const account = getEntityAccountForWrite(state.accounts, counterpartyId);
    if (!account) throw new Error(`R2C_QUOTE_WRITE_ACCOUNT_MISSING:${counterpartyId}`);
    delete account.shadow.rebalance.activeQuote;
    addMessage(state, `❌ Rebalance fee: quote expired (age: ${originalState.timestamp - quote.quoteId}ms)`);
    return false;
  }
  if (rebalanceFeeAmount !== quote.feeAmount) {
    addMessage(state, `❌ Rebalance fee: amount mismatch (expected ${quote.feeAmount}, got ${rebalanceFeeAmount})`);
    return false;
  }
  if (rebalanceFeeTokenId !== quote.feeTokenId) {
    addMessage(state, `❌ Rebalance fee: tokenId mismatch (expected ${quote.feeTokenId}, got ${rebalanceFeeTokenId})`);
    return false;
  }
  if (rebalanceFeeAmount > 0n && rebalanceFeeTokenId !== undefined) {
    accountTxs.push({
      accountId: counterpartyId,
      tx: {
        type: 'direct_payment',
        data: {
          fromEntityId: counterpartyId,
          toEntityId: originalState.entityId,
          tokenId: rebalanceFeeTokenId,
          amount: rebalanceFeeAmount,
          route: [originalState.entityId],
          deliveryMode: 'direct',
          description: `rebalance fee (quoteId: ${rebalanceQuoteId})`,
        },
      },
    });
  }
  const account = getEntityAccountForWrite(state.accounts, counterpartyId);
  if (!account) throw new Error(`R2C_QUOTE_WRITE_ACCOUNT_MISSING:${counterpartyId}`);
  delete account.shadow.rebalance.activeQuote;
  r2cLog.debug('fee.collected', {
    entity: shortId(originalState.entityId),
    counterparty: shortId(counterpartyId),
    feeTokenId: rebalanceFeeTokenId,
    feeAmount: formatAmount(rebalanceFeeAmount),
    rebalanceQuoteId,
    accountTxs: accountTxs.length,
  });
  return true;
};

const getR2CAdmissionIssue = (
  receivingEntity: string,
  counterpartyId: string,
  tokenId: number,
  amount: bigint,
): string | null => {
  if (amount <= 0n || !Number.isSafeInteger(tokenId) || tokenId <= 0) {
    return '❌ Collateral deposit requires a positive amount and registered tokenId';
  }
  if (!receivingEntity || receivingEntity === counterpartyId.toLowerCase()) {
    return '❌ Collateral deposit requires two distinct non-empty entities';
  }
  return null;
};

export async function handleR2C(
  entityState: EntityState,
  entityTx: Extract<EntityTx, { type: 'r2c' }>,
  mutableFrameState = false,
): Promise<{ newState: EntityState; outputs: EntityInput[]; jOutputs?: JInput[]; accountTxs?: AccountTxTarget[] }> {
  const { counterpartyId, receivingEntityId, tokenId, amount, rebalanceQuoteId } = entityTx.data;
  const receivingEntity = String(receivingEntityId || entityState.entityId || '').trim().toLowerCase();
  const isLocalReceivingEntity = receivingEntity === String(entityState.entityId || '').trim().toLowerCase();
  r2cLog.debug('start', {
    entity: shortId(entityState.entityId),
    counterparty: shortId(counterpartyId),
    receivingEntity: shortId(receivingEntity),
    tokenId,
    amount: formatAmount(amount),
    rebalanceQuoteId,
  });
  const newState = prepareEntityTxState(entityState, mutableFrameState);
  const outputs: EntityInput[] = [];
  const accountTxs: AccountTxTarget[] = [];

  const admissionIssue = getR2CAdmissionIssue(receivingEntity, counterpartyId, tokenId, amount);
  if (admissionIssue) {
    addMessage(newState, admissionIssue);
    return { newState, outputs };
  }

  // Validate: Do we have enough reserve?
  const reserveIssue = getReserveCandidateIssue(entityState, {
    type: 'reserveToCollateral',
    receivingEntity,
    counterparty: counterpartyId,
    tokenId,
    amount,
  });
  if (reserveIssue) {
    r2cLog.debug('reserve.insufficient', {
      entity: shortId(entityState.entityId),
      tokenId,
      currentReserve: formatAmount(reserveIssue.availableAfterDebt),
      amount: formatAmount(amount),
    });
    addMessage(newState,
      `❌ Insufficient spendable reserve for collateral deposit: have ${reserveIssue.availableAfterDebt}, need ${amount} token ${tokenId}`
    );
    return { newState, outputs };
  }

  // Validate: Does account exist?
  if (isLocalReceivingEntity && !entityState.accounts.has(counterpartyId)) {
    r2cLog.debug('account.missing', {
      entity: shortId(entityState.entityId),
      counterparty: shortId(counterpartyId),
    });
    addMessage(newState,
      `❌ Cannot deposit collateral: no account with ${counterpartyId?.slice(-4)}`
    );
    return { newState, outputs };
  }

  if (!collectRebalanceFee(
    entityState,
    newState,
    entityTx,
    isLocalReceivingEntity,
    accountTxs,
  )) return { newState, outputs };

  // CRITICAL: Do NOT update state here - wait for SettlementProcessed event from j-watcher
  // This is consensus-critical: both entities must update based on the on-chain event

  // Initialize jBatch on first use
  if (!newState.jBatchState) {
    newState.jBatchState = initJBatch();
  }

  // Add to jBatch for on-chain submission
  batchAddReserveToCollateral(
    newState.jBatchState,
    receivingEntity,
    counterpartyId,
    tokenId,
    amount
  );

  addMessage(newState,
    `📦 Queued R→C: ${amount} token ${tokenId} to ${receivingEntity.slice(-4)}↔${counterpartyId.slice(-4)} (use j_broadcast to commit)`
  );

  r2cLog.debug('jbatch.queued', {
    entity: shortId(entityState.entityId),
    receivingEntity: shortId(receivingEntity),
    counterparty: shortId(counterpartyId),
    tokenId,
    amount: formatAmount(amount),
  });

  return { newState, outputs, accountTxs };
}
