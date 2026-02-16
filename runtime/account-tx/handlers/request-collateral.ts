/**
 * Request Collateral Handler
 *
 * User requests hub to deposit collateral (R→C) and pays fee inline.
 * This is the V1 rebalance mechanism — no quotes, no custody, no bilateral negotiation.
 *
 * Flow:
 * 1. Post-frame hook detects: uncollateralized > softLimit
 * 2. Auto-queues request_collateral into account mempool
 * 3. Hub processes the frame → sees request + fee payment
 * 4. Hub crontab picks up pendingRebalanceRequest → adds R→C to jBatch
 * 5. broadcastBatch → on-chain → collateral updated
 *
 * The fee is paid as an offdelta shift (user→hub) bundled in the same accountTx.
 * Both sides process deterministically — no unilateral hub action needed.
 *
 * Reference: 2019src.txt line 2976 (they_requested_deposit)
 */

import type { AccountMachine, AccountTx } from '../../types';
import { isLeftEntity } from '../../entity-id-utils';

export function handleRequestCollateral(
  accountMachine: AccountMachine,
  accountTx: Extract<AccountTx, { type: 'request_collateral' }>,
  byLeft?: boolean,
): { success: boolean; events: string[]; error?: string } {
  const { tokenId, amount, feeTokenId, feeAmount } = accountTx.data;

  // ── Validation ────────────────────────────────────────────────
  if (amount <= 0n) {
    return { success: false, events: [], error: 'request_collateral: amount must be > 0' };
  }
  if (feeAmount < 0n) {
    return { success: false, events: [], error: 'request_collateral: feeAmount must be >= 0' };
  }

  const delta = accountMachine.deltas.get(tokenId);
  if (!delta) {
    return { success: false, events: [], error: `request_collateral: no delta for token ${tokenId}` };
  }

  // ── Fee payment via offdelta shift ────────────────────────────
  // Fee is paid by the REQUESTER (user) to the COUNTERPARTY (hub).
  // byLeft=true means left entity is paying. byLeft=false means right is paying.
  // Shift offdelta so that payer loses and receiver gains.
  //
  // Convention: positive offdelta = LEFT has more.
  //   If left pays: offdelta decreases (left loses)
  //   If right pays: offdelta increases (right loses, left gains)
  if (feeAmount > 0n) {
    const feeDelta = accountMachine.deltas.get(feeTokenId ?? tokenId);
    if (!feeDelta) {
      return { success: false, events: [], error: `request_collateral: no delta for fee token ${feeTokenId ?? tokenId}` };
    }

    // Apply fee: requester pays hub
    if (byLeft) {
      // Left (requester) pays → offdelta decreases
      feeDelta.offdelta -= feeAmount;
    } else {
      // Right (requester) pays → offdelta increases (left = hub gains)
      feeDelta.offdelta += feeAmount;
    }

    console.log(`💰 Rebalance fee: ${feeAmount} token ${feeTokenId ?? tokenId} (paid by ${byLeft ? 'left' : 'right'})`);
  }

  // ── Store request for hub crontab ─────────────────────────────
  // Hub's hubRebalanceHandler will pick this up and add R→C to jBatch.
  accountMachine.requestedRebalance.set(tokenId, amount);

  const feeDisplay = feeAmount > 0n ? `, fee=${feeAmount}` : '';
  const events = [
    `🔄 Collateral requested: ${amount} token ${tokenId}${feeDisplay} (hub will deposit R→C)`,
  ];

  console.log(`🔄 request_collateral: token=${tokenId} amount=${amount} fee=${feeAmount} byLeft=${byLeft}`);

  return { success: true, events };
}

/**
 * Check if an account needs auto-rebalance after frame commit.
 * Called from account-consensus.ts after RECEIVER-COMMIT.
 *
 * Returns mempool operations to queue if rebalance is needed.
 *
 * @param accountMachine - The account after frame commit
 * @param ourEntityId - Our entity ID
 * @param counterpartyId - Counterparty entity ID
 * @returns Array of accountTxs to queue in mempool (empty = no rebalance needed)
 */
export function checkAutoRebalance(
  accountMachine: AccountMachine,
  ourEntityId: string,
  counterpartyId: string,
): AccountTx[] {
  const result: AccountTx[] = [];

  // Load policy from account (set during openAccount or by user in settings)
  // If no explicit policy, don't auto-rebalance (user hasn't opted in)
  if (accountMachine.rebalancePolicy.size === 0) {
    return result;
  }

  const isLeft = isLeftEntity(ourEntityId, counterpartyId);

  for (const [tokenId, policy] of accountMachine.rebalancePolicy.entries()) {
    // Skip manual mode (softLimit === hardLimit convention)
    if (policy.softLimit === policy.hardLimit) continue;

    const delta = accountMachine.deltas.get(tokenId);
    if (!delta) continue;

    const totalDelta = delta.ondelta + delta.offdelta;

    // "Their debt to us" = counterparty owes us
    // We are LEFT:  total > 0 → counterparty (RIGHT/hub) owes us
    // We are RIGHT: total < 0 → counterparty (LEFT/hub) owes us
    const theirDebt = isLeft
      ? (totalDelta > 0n ? totalDelta : 0n)
      : (totalDelta < 0n ? -totalDelta : 0n);

    const uncollateralized = theirDebt > delta.collateral
      ? theirDebt - delta.collateral
      : 0n;

    // Check if we already have a pending request for this token
    const existingRequest = accountMachine.requestedRebalance.get(tokenId);
    if (existingRequest && existingRequest > 0n) {
      continue; // Already requested, don't spam
    }

    // Check if there's already a pending frame (don't pile up)
    if (accountMachine.pendingFrame) {
      continue;
    }

    if (uncollateralized > policy.softLimit) {
      // Calculate fee based on hub's advertised rates
      // V1: flat fee structure. Production: read from hub gossip profile.
      const BASE_FEE = 1n * 10n ** 18n; // $1 base
      const LIQUIDITY_FEE_BPS = 10n; // 0.1%
      const liquidityFee = (uncollateralized * LIQUIDITY_FEE_BPS) / 10000n;
      const feeAmount = BASE_FEE > liquidityFee ? BASE_FEE : liquidityFee;

      // Check we can afford the fee (don't overdraft)
      // Our available balance: depends on our side
      // For simplicity in V1: just check fee < uncollateralized (we're owed more than fee)
      if (feeAmount >= uncollateralized) {
        continue; // Fee too expensive relative to amount
      }

      result.push({
        type: 'request_collateral',
        data: {
          tokenId,
          amount: uncollateralized,
          feeTokenId: tokenId, // Pay fee in same token
          feeAmount,
        },
      } as AccountTx);

      console.log(
        `🔄 Auto-rebalance triggered: token=${tokenId} uncollateralized=${uncollateralized} ` +
        `> softLimit=${policy.softLimit}, requesting ${uncollateralized} with fee ${feeAmount}`
      );
    }
  }

  return result;
}
