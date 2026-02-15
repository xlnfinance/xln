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

import type { EntityState, EntityTx, EntityInput, AccountTx } from '../../types';
import { QUOTE_EXPIRY_MS } from '../../types';
import { cloneEntityState, addMessage, canonicalAccountKey } from '../../state-helpers';

type MempoolOp = { accountId: string; tx: AccountTx };

export async function handleDepositCollateral(
  entityState: EntityState,
  entityTx: Extract<EntityTx, { type: 'deposit_collateral' }>,
  currentTimestamp: number = 0
): Promise<{ newState: EntityState; outputs: EntityInput[]; jOutputs?: any[]; mempoolOps?: MempoolOp[] }> {
  const { counterpartyId, tokenId, amount, rebalanceQuoteId, rebalanceFeeTokenId, rebalanceFeeAmount } = entityTx.data;
  console.log(`🔍 deposit_collateral: counterpartyId=${counterpartyId}, tokenId=${tokenId}, amount=${amount}, quoteId=${rebalanceQuoteId}`);
  const newState = cloneEntityState(entityState);
  const outputs: EntityInput[] = [];
  const mempoolOps: MempoolOp[] = [];

  // Validate: Do we have enough reserve?
  const currentReserve = entityState.reserves.get(String(tokenId)) || 0n;
  if (currentReserve < amount) {
    console.log(`❌ deposit_collateral: Insufficient reserve ${currentReserve} < ${amount}`);
    addMessage(newState,
      `❌ Insufficient reserve for collateral deposit: have ${currentReserve}, need ${amount} token ${tokenId}`
    );
    return { newState, outputs };
  }

  // Validate: Does account exist?
  if (!entityState.accounts.has(counterpartyId)) {
    console.log(`❌ deposit_collateral: No account with ${counterpartyId}`);
    addMessage(newState,
      `❌ Cannot deposit collateral: no account with ${counterpartyId?.slice(-4)}`
    );
    return { newState, outputs };
  }

  // Validate rebalance fee if present
  if (rebalanceQuoteId !== undefined) {
    const account = newState.accounts.get(counterpartyId);
    const quote = account?.activeRebalanceQuote;
    console.log(`🔍 deposit_collateral: quote validation - hasAccount=${!!account}, quote=${JSON.stringify(quote ? { quoteId: quote.quoteId, accepted: quote.accepted, feeAmount: String(quote.feeAmount) } : null)}`);

    if (!quote) {
      console.log(`❌ deposit_collateral: no active quote`);
      addMessage(newState, `❌ Rebalance fee: no active quote for ${counterpartyId.slice(-4)}`);
      return { newState, outputs };
    }
    if (quote.quoteId !== rebalanceQuoteId) {
      console.log(`❌ deposit_collateral: quoteId mismatch ${quote.quoteId} !== ${rebalanceQuoteId}`);
      addMessage(newState, `❌ Rebalance fee: quoteId mismatch (expected ${quote.quoteId}, got ${rebalanceQuoteId})`);
      return { newState, outputs };
    }
    if (!quote.accepted) {
      addMessage(newState, `❌ Rebalance fee: quote not accepted`);
      return { newState, outputs };
    }
    if (currentTimestamp > quote.quoteId + QUOTE_EXPIRY_MS) {
      // Quote expired — clear it
      account!.activeRebalanceQuote = undefined;
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
    account!.activeRebalanceQuote = undefined;

    console.log(`💰 Rebalance fee collected: ${rebalanceFeeAmount} token ${rebalanceFeeTokenId} (quoteId: ${rebalanceQuoteId})`);
  }

  // CRITICAL: Do NOT update state here - wait for SettlementProcessed event from j-watcher
  // This is consensus-critical: both entities must update based on the on-chain event

  // Initialize jBatch on first use
  if (!newState.jBatchState) {
    const { initJBatch } = await import('../../j-batch');
    newState.jBatchState = initJBatch();
  }

  // Add to jBatch for on-chain submission
  const { batchAddReserveToCollateral } = await import('../../j-batch');
  batchAddReserveToCollateral(
    newState.jBatchState,
    entityState.entityId,
    counterpartyId,
    tokenId,
    amount
  );

  addMessage(newState,
    `📦 Queued R→C: ${amount} token ${tokenId} to account with ${counterpartyId.slice(-4)} (use j_broadcast to commit)`
  );

  console.log(`✅ deposit_collateral: Added to jBatch for ${entityState.entityId.slice(-4)}`);
  console.log(`   Counterparty: ${counterpartyId.slice(-4)}`);
  console.log(`   Token: ${tokenId}, Amount: ${amount}`);

  return { newState, outputs, mempoolOps };
}
