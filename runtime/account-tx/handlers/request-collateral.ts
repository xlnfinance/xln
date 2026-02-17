/**
 * Request Collateral Handler
 *
 * User requests hub to deposit collateral (R→C).
 * This is the V1 rebalance mechanism — no quotes, no custody, no bilateral negotiation.
 *
 * Flow:
 * 1. Post-frame hook detects: uncollateralized > softLimit
 * 2. Auto-queues request_collateral into account mempool
 * 3. Hub processes the frame → sees request + deferred fee budget
 * 4. Hub crontab picks up pendingRebalanceRequest → adds R→C to jBatch
 * 5. broadcastBatch → on-chain → collateral updated
 *
 * Fee is charged ONLY when collateral is actually fulfilled (AccountSettled finalize),
 * so users never pay fee for unfulfilled requests.
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

  // Clamp requested amount to CURRENT uncollateralized debt at commit time.
  // This prevents stale queued requests (computed earlier) from over-requesting
  // after hub already topped up collateral.
  const requesterIsLeft = !!byLeft;
  const totalDelta = delta.ondelta + delta.offdelta;
  const requesterClaim = requesterIsLeft
    ? (totalDelta > 0n ? totalDelta : 0n)
    : (totalDelta < 0n ? -totalDelta : 0n);
  const uncollateralizedNow = requesterClaim > delta.collateral
    ? requesterClaim - delta.collateral
    : 0n;
  const effectiveAmount = amount > uncollateralizedNow ? uncollateralizedNow : amount;

  if (effectiveAmount <= 0n) {
    // Stale request: already collateralized by the time this frame commits.
    // Keep state clean and don't charge fee.
    accountMachine.requestedRebalance.delete(tokenId);
    accountMachine.requestedRebalanceFeeState?.delete(tokenId);
    console.log(
      `ℹ️ request_collateral stale/no-op: token=${tokenId} requested=${amount} uncollateralizedNow=${uncollateralizedNow} byLeft=${byLeft}`,
    );
    return {
      success: true,
      events: [
        `ℹ️ Collateral request skipped (already collateralized): requested=${amount}, currentNeed=${uncollateralizedNow}`,
      ],
    };
  }

  // Fee is deferred and charged only on fulfilled collateral.
  // Keep fee proportional to effective request after clamping.
  const effectiveFee = amount > 0n ? (feeAmount * effectiveAmount) / amount : 0n;
  if (!accountMachine.requestedRebalanceFeeState) {
    accountMachine.requestedRebalanceFeeState = new Map();
  }

  // ── Store request for hub crontab ─────────────────────────────
  // Hub's hubRebalanceHandler will pick this up and add R→C to jBatch.
  accountMachine.requestedRebalance.set(tokenId, effectiveAmount);
  accountMachine.requestedRebalanceFeeState.set(tokenId, {
    feeTokenId: feeTokenId ?? tokenId,
    remainingFee: effectiveFee,
    requestedByLeft: !!byLeft,
  });

  const feeDisplay = effectiveFee > 0n ? `, deferredFee=${effectiveFee}` : '';
  const events = [
    `🔄 Collateral requested: ${effectiveAmount} token ${tokenId}${feeDisplay} (hub will deposit R→C; fee on fulfillment)`,
  ];

  console.log(
    `🔄 request_collateral: token=${tokenId} requested=${amount} effective=${effectiveAmount} ` +
    `deferredFee=${effectiveFee} byLeft=${byLeft} uncollateralizedNow=${uncollateralizedNow}`,
  );

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
    console.log(
      `⏭️ Auto-rebalance skipped: no rebalancePolicy (our=${ourEntityId.slice(-4)}, cp=${counterpartyId.slice(-4)})`,
    );
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

    // Check if we already have a pending request for this token.
    const existingRequest = accountMachine.requestedRebalance.get(tokenId);
    if (existingRequest && existingRequest > 0n) {
      console.log(
        `⏭️ Auto-rebalance skipped: existing request token=${tokenId} amount=${existingRequest}`,
      );
      continue; // Already requested, don't spam
    }

    // Check if there's already a pending frame (don't pile up)
    if (accountMachine.pendingFrame) {
      console.log(
        `⏭️ Auto-rebalance skipped: pendingFrame exists (token=${tokenId}, h=${accountMachine.pendingFrame.height})`,
      );
      continue;
    }

    if (uncollateralized > policy.softLimit) {
      // Calculate fee based on hub's advertised rates
      // V1: flat fee structure. Production: read from hub gossip profile.
      const BASE_FEE = 1n * 10n ** 18n; // $1 base
      const LIQUIDITY_FEE_BPS = 10n; // 0.1%
      const liquidityFee = (uncollateralized * LIQUIDITY_FEE_BPS) / 10000n;
      const feeAmount = BASE_FEE > liquidityFee ? BASE_FEE : liquidityFee;

      // Respect user policy ceiling for automated requests.
      if (feeAmount > policy.maxAcceptableFee) {
        console.log(
          `⏭️ Auto-rebalance skipped: token=${tokenId} fee=${feeAmount} > maxAcceptableFee=${policy.maxAcceptableFee}`,
        );
        continue;
      }

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
      });

      console.log(
        `🔄 Auto-rebalance triggered: token=${tokenId} uncollateralized=${uncollateralized} ` +
        `> softLimit=${policy.softLimit}, requesting ${uncollateralized} with fee ${feeAmount}`
      );
    }
  }

  return result;
}
