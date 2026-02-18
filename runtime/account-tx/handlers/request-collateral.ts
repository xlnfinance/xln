/**
 * Request Collateral Handler
 *
 * User requests hub to deposit collateral (R→C).
 * This is the V1 rebalance mechanism — no quotes, no custody, no bilateral negotiation.
 *
 * Flow:
 * 1. Post-frame hook detects: uncollateralized > softLimit
 * 2. Auto-queues request_collateral into account mempool
 * 3. Request frame debits prepaid fee immediately (user pays hub upfront)
 * 4. Hub crontab picks up pendingRebalanceRequest → adds R→C to jBatch
 * 5. broadcastBatch → on-chain → collateral updated
 *
 * Fee is prepaid by requester in the same bilateral frame, so hub never
 * fronts rebalance costs.
 *
 * Reference: 2019src.txt line 2976 (they_requested_deposit)
 */

import type { AccountMachine, AccountTx, RebalancePolicy } from '../../types';
import { DEFAULT_SOFT_LIMIT, DEFAULT_HARD_LIMIT, DEFAULT_MAX_FEE } from '../../types';
import { isLeftEntity } from '../../entity-id-utils';

export function handleRequestCollateral(
  accountMachine: AccountMachine,
  accountTx: Extract<AccountTx, { type: 'request_collateral' }>,
  byLeft?: boolean,
  currentTimestamp = 0,
): { success: boolean; events: string[]; error?: string } {
  const { tokenId, amount, feeTokenId, feeAmount, policyVersion } = accountTx.data;

  // ── Validation ────────────────────────────────────────────────
  if (amount <= 0n) {
    return { success: false, events: [], error: 'request_collateral: amount must be > 0' };
  }
  if (feeAmount < 0n) {
    return { success: false, events: [], error: 'request_collateral: feeAmount must be >= 0' };
  }
  if (!Number.isFinite(policyVersion) || policyVersion < 1) {
    return { success: false, events: [], error: `request_collateral: invalid policyVersion ${policyVersion}` };
  }

  const delta = accountMachine.deltas.get(tokenId);
  if (!delta) {
    return { success: false, events: [], error: `request_collateral: no delta for token ${tokenId}` };
  }

  // Prevent accidental overwrite of an in-flight prepaid request on the same token.
  // Replacing state here can lose auditability of the original fee/request tuple.
  const existingRequest = accountMachine.requestedRebalance.get(tokenId) ?? 0n;
  if (existingRequest > 0n) {
    return {
      success: false,
      events: [],
      error: `request_collateral: existing pending request for token ${tokenId} (${existingRequest})`,
    };
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

  // Fee is prepaid in this same account frame.
  // Keep fee proportional to effective request after clamping.
  const effectiveFee = amount > 0n ? (feeAmount * effectiveAmount) / amount : 0n;
  if (effectiveFee <= 0n) {
    return { success: false, events: [], error: 'request_collateral: feeAmount must produce effectiveFee > 0' };
  }

  const feeToken = feeTokenId ?? tokenId;
  const feeDelta = accountMachine.deltas.get(feeToken);
  if (!feeDelta) {
    return { success: false, events: [], error: `request_collateral: no delta for fee token ${feeToken}` };
  }

  const feeTotal = feeDelta.ondelta + feeDelta.offdelta;
  const requesterFeeClaim = requesterIsLeft
    ? (feeTotal > 0n ? feeTotal : 0n)
    : (feeTotal < 0n ? -feeTotal : 0n);
  if (effectiveFee > requesterFeeClaim) {
    return {
      success: false,
      events: [],
      error: `request_collateral: insufficient fee balance in token ${feeToken} (${requesterFeeClaim} < ${effectiveFee})`,
    };
  }

  // Convention: positive offdelta means LEFT has more.
  // requester pays hub upfront here.
  if (requesterIsLeft) {
    feeDelta.offdelta -= effectiveFee;
  } else {
    feeDelta.offdelta += effectiveFee;
  }

  // Fee can reduce the same-token claim; request only what remains uncollateralized.
  const postFeeDelta = accountMachine.deltas.get(tokenId)!;
  const postFeeTotal = postFeeDelta.ondelta + postFeeDelta.offdelta;
  const requesterClaimAfterFee = requesterIsLeft
    ? (postFeeTotal > 0n ? postFeeTotal : 0n)
    : (postFeeTotal < 0n ? -postFeeTotal : 0n);
  const uncollateralizedAfterFee = requesterClaimAfterFee > postFeeDelta.collateral
    ? requesterClaimAfterFee - postFeeDelta.collateral
    : 0n;
  const effectiveRequest = effectiveAmount > uncollateralizedAfterFee ? uncollateralizedAfterFee : effectiveAmount;
  if (effectiveRequest <= 0n) {
    // Roll back prepaid debit because no request remains after recompute.
    if (requesterIsLeft) {
      feeDelta.offdelta += effectiveFee;
    } else {
      feeDelta.offdelta -= effectiveFee;
    }
    accountMachine.requestedRebalance.delete(tokenId);
    accountMachine.requestedRebalanceFeeState?.delete(tokenId);
    return {
      success: true,
      events: [
        `ℹ️ Collateral request became zero after prepaid fee charge (fee=${effectiveFee}, token=${feeToken})`,
      ],
    };
  }

  if (!accountMachine.requestedRebalanceFeeState) {
    accountMachine.requestedRebalanceFeeState = new Map();
  }

  // ── Store request for hub crontab ─────────────────────────────
  // Hub's hubRebalanceHandler will pick this up and add R→C to jBatch.
  accountMachine.requestedRebalance.set(tokenId, effectiveRequest);
  accountMachine.requestedRebalanceFeeState.set(tokenId, {
    feeTokenId: feeToken,
    feePaidUpfront: effectiveFee,
    requestedAmount: effectiveRequest,
    policyVersion,
    requestedAt: currentTimestamp,
    requestedByLeft: !!byLeft,
    jBatchSubmittedAt: 0,
  });

  const feeDisplay = effectiveFee > 0n ? `, prepaidFee=${effectiveFee}` : '';
  const events = [
    `🔄 Collateral requested: ${effectiveRequest} token ${tokenId}${feeDisplay} (hub will deposit R→C)`,
  ];

  console.log(
    `🔄 request_collateral: token=${tokenId} requested=${amount} effective=${effectiveRequest} ` +
    `prepaidFee=${effectiveFee} byLeft=${byLeft} uncollateralizedNow=${uncollateralizedNow}`,
  );
  console.log(
    `[REB][1][REQUEST_COLLATERAL_COMMITTED] token=${tokenId} requested=${effectiveRequest} fee=${effectiveFee} byLeft=${byLeft} requestedAt=${currentTimestamp}`,
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
 * @param feePolicy - Hub fee policy (base + liquidity + gas), sourced from hub config/profile
 * @returns Array of accountTxs to queue in mempool (empty = no rebalance needed)
 */
export interface RebalanceFeePolicy {
  policyVersion: number;
  baseFee: bigint;
  liquidityFeeBps: bigint;
  gasFee: bigint;
}

export function checkAutoRebalance(
  accountMachine: AccountMachine,
  ourEntityId: string,
  counterpartyId: string,
  feePolicy?: RebalanceFeePolicy,
): AccountTx[] {
  const result: AccountTx[] = [];

  // Bootstrap legacy accounts that were created before rebalancePolicy existed.
  // This keeps faucet/offchain auto-collateralization working without manual setup.
  if (accountMachine.rebalancePolicy.size === 0) {
    for (const [tokenId] of accountMachine.deltas.entries()) {
      const defaultPolicy: RebalancePolicy = {
        softLimit: DEFAULT_SOFT_LIMIT,
        hardLimit: DEFAULT_HARD_LIMIT,
        maxAcceptableFee: DEFAULT_MAX_FEE,
      };
      accountMachine.rebalancePolicy.set(tokenId, defaultPolicy);
      result.push({
        type: 'set_rebalance_policy',
        data: {
          tokenId,
          softLimit: defaultPolicy.softLimit,
          hardLimit: defaultPolicy.hardLimit,
          maxAcceptableFee: defaultPolicy.maxAcceptableFee,
        },
      });
      console.log(
        `🔄 Auto-rebalance policy bootstrapped: token=${tokenId} soft=${defaultPolicy.softLimit} hard=${defaultPolicy.hardLimit} maxFee=${defaultPolicy.maxAcceptableFee}`,
      );
    }
    if (accountMachine.rebalancePolicy.size === 0) {
      console.log(
        `⏭️ Auto-rebalance skipped: no rebalancePolicy and no deltas (our=${ourEntityId.slice(-4)}, cp=${counterpartyId.slice(-4)})`,
      );
      return result;
    }
  }

  const isLeft = isLeftEntity(ourEntityId, counterpartyId);
  if (!feePolicy) {
    console.log(
      `⏭️ Auto-rebalance skipped: missing hub fee policy (our=${ourEntityId.slice(-4)}, cp=${counterpartyId.slice(-4)})`,
    );
    return result;
  }

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
      const liquidityFee = (uncollateralized * feePolicy.liquidityFeeBps) / 10000n;
      const feeAmount = feePolicy.baseFee + feePolicy.gasFee + liquidityFee;

      // Respect user policy ceiling for automated requests.
      if (feeAmount > policy.maxAcceptableFee) {
        console.log(
          `⏭️ Auto-rebalance skipped: token=${tokenId} fee=${feeAmount} > maxAcceptableFee=${policy.maxAcceptableFee}`,
        );
        continue;
      }

      result.push({
        type: 'request_collateral',
        data: {
          tokenId,
          amount: uncollateralized,
          feeTokenId: tokenId, // Pay fee in same token
          feeAmount,
          policyVersion: feePolicy.policyVersion,
        },
      });

      console.log(
        `🔄 Auto-rebalance triggered: token=${tokenId} uncollateralized=${uncollateralized} ` +
        `> softLimit=${policy.softLimit}, requesting ${uncollateralized} with fee ${feeAmount} ` +
        `(base=${feePolicy.baseFee}, gas=${feePolicy.gasFee}, liqBps=${feePolicy.liquidityFeeBps})`
      );
    }
  }

  return result;
}
