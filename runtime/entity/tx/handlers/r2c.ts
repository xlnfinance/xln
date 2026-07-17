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

import type { EntityState, EntityTx, EntityInput, AccountTx, JInput } from '../../../types';
import { QUOTE_EXPIRY_MS } from '../../../types';
import { cloneEntityState, addMessage } from '../../../state-helpers';
import { batchAddReserveToCollateral, getEffectiveDraftReserveBalance, initJBatch } from '../../../jurisdiction/batch';
import { createStructuredLogger, formatAmount, shortId } from '../../../infra/logger';

type MempoolOp = { accountId: string; tx: AccountTx };

const r2cLog = createStructuredLogger('entity.r2c');

export async function handleR2C(
  entityState: EntityState,
  entityTx: Extract<EntityTx, { type: 'r2c' }>,
): Promise<{ newState: EntityState; outputs: EntityInput[]; jOutputs?: JInput[]; mempoolOps?: MempoolOp[] }> {
  const currentTimestamp = entityState.timestamp;
  const { counterpartyId, receivingEntityId, tokenId, amount, rebalanceQuoteId, rebalanceFeeTokenId, rebalanceFeeAmount } = entityTx.data;
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
  const newState = cloneEntityState(entityState);
  const outputs: EntityInput[] = [];
  const mempoolOps: MempoolOp[] = [];

  // Validate: Do we have enough reserve?
  const currentReserve = getEffectiveDraftReserveBalance(
    entityState.entityId,
    entityState.reserves.get(tokenId) || 0n,
    entityState.jBatchState?.batch,
    tokenId,
  );
  if (currentReserve < amount) {
    r2cLog.debug('reserve.insufficient', {
      entity: shortId(entityState.entityId),
      tokenId,
      currentReserve: formatAmount(currentReserve),
      amount: formatAmount(amount),
    });
    addMessage(newState,
      `❌ Insufficient reserve for collateral deposit: have ${currentReserve}, need ${amount} token ${tokenId}`
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

  // Validate rebalance fee if present
  if (rebalanceQuoteId !== undefined) {
    if (!isLocalReceivingEntity) {
      addMessage(newState, '❌ Rebalance fee unsupported for remote reserve → account deposits');
      return { newState, outputs };
    }
    const account = newState.accounts.get(counterpartyId);
    const quote = account?.shadow.rebalance.activeQuote;
    r2cLog.debug('quote.validate', {
      entity: shortId(entityState.entityId),
      counterparty: shortId(counterpartyId),
      hasAccount: Boolean(account),
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
      r2cLog.debug('quote.missing', { entity: shortId(entityState.entityId), counterparty: shortId(counterpartyId) });
      addMessage(newState, `❌ Rebalance fee: no active quote for ${counterpartyId.slice(-4)}`);
      return { newState, outputs };
    }
    if (quote.quoteId !== rebalanceQuoteId) {
      r2cLog.debug('quote.id_mismatch', {
        entity: shortId(entityState.entityId),
        counterparty: shortId(counterpartyId),
        expected: quote.quoteId,
        actual: rebalanceQuoteId,
      });
      addMessage(newState, `❌ Rebalance fee: quoteId mismatch (expected ${quote.quoteId}, got ${rebalanceQuoteId})`);
      return { newState, outputs };
    }
    if (!quote.accepted) {
      addMessage(newState, `❌ Rebalance fee: quote not accepted`);
      return { newState, outputs };
    }
    if (currentTimestamp > quote.quoteId + QUOTE_EXPIRY_MS) {
      // Quote expired — clear it
      delete account!.shadow.rebalance.activeQuote;
      addMessage(newState, `❌ Rebalance fee: quote expired (age: ${currentTimestamp - quote.quoteId}ms)`);
      return { newState, outputs };
    }
    if (rebalanceFeeAmount !== quote.feeAmount) {
      addMessage(newState, `❌ Rebalance fee: amount mismatch (expected ${quote.feeAmount}, got ${rebalanceFeeAmount})`);
      return { newState, outputs };
    }
    if (rebalanceFeeTokenId !== quote.feeTokenId) {
      addMessage(newState, `❌ Rebalance fee: tokenId mismatch (expected ${quote.feeTokenId}, got ${rebalanceFeeTokenId})`);
      return { newState, outputs };
    }

    // Fee collection: inject a direct_payment accountTx to shift offdelta (user→hub)
    // This goes into the bilateral account mempool for the next frame
    if (rebalanceFeeAmount && rebalanceFeeAmount > 0n && rebalanceFeeTokenId !== undefined) {
      mempoolOps.push({
        accountId: counterpartyId,
        tx: {
          type: 'direct_payment',
          data: {
            fromEntityId: counterpartyId,        // user pays fee
            toEntityId: entityState.entityId,     // hub receives fee
            tokenId: rebalanceFeeTokenId,
            amount: rebalanceFeeAmount,
            description: `rebalance fee (quoteId: ${rebalanceQuoteId})`,
          },
        },
      });
    }

    // Clear the quote (consumed)
    delete account!.shadow.rebalance.activeQuote;

    r2cLog.debug('fee.collected', {
      entity: shortId(entityState.entityId),
      counterparty: shortId(counterpartyId),
      feeTokenId: rebalanceFeeTokenId,
      feeAmount: formatAmount(rebalanceFeeAmount),
      rebalanceQuoteId,
      mempoolOps: mempoolOps.length,
    });
  }

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

  return { newState, outputs, mempoolOps };
}
