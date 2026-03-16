/**
 * Request Collateral Handler
 *
 * User requests hub to deposit collateral (R→C).
 * This is the V1 rebalance mechanism — no quotes, no custody, no bilateral negotiation.
 *
 * Flow:
 * 1. Post-frame hook detects: outPeerCredit > r2cRequestSoftLimit
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
import { deriveDelta } from '../../account-utils';

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

  const existingRequest = accountMachine.requestedRebalance.get(tokenId) ?? 0n;
  const existingFeeState = accountMachine.requestedRebalanceFeeState?.get(tokenId);

  // Deterministic request amount comes from frame payload.
  // Do not recompute from live outPeerCredit at commit time, otherwise the same tx
  // can produce different request sizes between propose/commit during races.
  const requesterIsLeft = !!byLeft;
  const effectiveAmount = amount;

  // One pending request per token until finalized/cleared.
  // Do not upsize in-frame; let hub fulfill current request first, then re-evaluate.
  if (existingRequest > 0n) {
    return {
      success: true,
      events: [
        `ℹ️ request_collateral skipped: pending request exists token=${tokenId} amount=${existingRequest}`,
      ],
    };
  }

  // Fee is prepaid in this same account frame.
  // Keep fee proportional to effective request after clamping.
  const effectiveFeeTarget = amount > 0n ? (feeAmount * effectiveAmount) / amount : 0n;
  if (effectiveFeeTarget <= 0n) {
    return { success: false, events: [], error: 'request_collateral: feeAmount must produce effectiveFee > 0' };
  }

  const feeToken = feeTokenId ?? tokenId;
  const feeDelta = accountMachine.deltas.get(feeToken);
  if (!feeDelta) {
    return { success: false, events: [], error: `request_collateral: no delta for fee token ${feeToken}` };
  }

  const requesterFeeCapacity = deriveDelta(feeDelta, requesterIsLeft).outCapacity;
  // No in-place upsize path: each request starts with fresh upfront fee debit.
  const existingFeePaid = existingRequest > 0n ? (existingFeeState?.feePaidUpfront ?? 0n) : 0n;
  const feeTopup = effectiveFeeTarget > existingFeePaid ? effectiveFeeTarget - existingFeePaid : 0n;
  if (feeTopup > requesterFeeCapacity) {
    return {
      success: false,
      events: [],
      error: `request_collateral: insufficient fee capacity in token ${feeToken} (${requesterFeeCapacity} < ${feeTopup})`,
    };
  }

  // Convention: positive offdelta means LEFT has more.
  // requester pays hub upfront here.
  if (feeTopup > 0n) {
    if (requesterIsLeft) {
      feeDelta.offdelta -= feeTopup;
    } else {
      feeDelta.offdelta += feeTopup;
    }
  }

  // Request size is deterministic from payload; when fee is paid in the SAME token,
  // request collateral for net amount after prepaid fee to avoid tiny pending tails.
  let effectiveRequest = effectiveAmount;
  if (feeToken === tokenId) {
    effectiveRequest = effectiveAmount > effectiveFeeTarget ? effectiveAmount - effectiveFeeTarget : 0n;
  }
  if (effectiveRequest <= 0n) {
    // Roll back prepaid debit because no request remains after recompute.
    if (feeTopup > 0n) {
      if (requesterIsLeft) {
        feeDelta.offdelta += feeTopup;
      } else {
        feeDelta.offdelta -= feeTopup;
      }
    }
    accountMachine.requestedRebalance.delete(tokenId);
    accountMachine.requestedRebalanceFeeState?.delete(tokenId);
      return {
        success: true,
        events: [
          `ℹ️ Collateral request became zero after prepaid fee charge (fee=${effectiveFeeTarget}, token=${feeToken})`,
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
    feePaidUpfront: effectiveFeeTarget,
    requestedAmount: effectiveRequest,
    policyVersion,
    requestedAt: currentTimestamp,
    requestedByLeft: !!byLeft,
    // Any refreshed amount must be treated as a fresh request for hub crontab routing.
    jBatchSubmittedAt: 0,
  });

  const feeDisplay = effectiveFeeTarget > 0n ? `, prepaidFee=${effectiveFeeTarget}` : '';
  const events = [
    `🔄 Collateral requested: ${effectiveRequest} token ${tokenId}${feeDisplay}, feeTopup=${feeTopup} (hub will deposit R→C)`,
  ];

  console.log(
    `🔄 request_collateral: token=${tokenId} requested=${amount} effective=${effectiveRequest} ` +
    `prepaidFee=${effectiveFeeTarget} feeTopup=${feeTopup} byLeft=${byLeft}`,
  );
  console.log(
    `[REB][1][REQUEST_COLLATERAL_COMMITTED] token=${tokenId} requested=${effectiveRequest} fee=${effectiveFeeTarget} feeTopup=${feeTopup} byLeft=${byLeft} requestedAt=${currentTimestamp}`,
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

  // Settlement negotiations/execution and auto-rebalance should not run concurrently
  // on the same bilateral account state, otherwise one side may evaluate against a
  // different pre-settlement surface and propose divergent frames.
  if (accountMachine.settlementWorkspace) {
    return result;
  }

  // Bootstrap legacy accounts that were created before rebalancePolicy existed.
  // This keeps faucet/offchain auto-collateralization working without manual setup.
  if (accountMachine.rebalancePolicy.size === 0) {
    for (const [tokenId] of accountMachine.deltas.entries()) {
      const defaultPolicy: RebalancePolicy = {
        r2cRequestSoftLimit: DEFAULT_SOFT_LIMIT,
        hardLimit: DEFAULT_HARD_LIMIT,
        maxAcceptableFee: DEFAULT_MAX_FEE,
      };
      accountMachine.rebalancePolicy.set(tokenId, defaultPolicy);
      result.push({
        type: 'set_rebalance_policy',
        data: {
          tokenId,
          r2cRequestSoftLimit: defaultPolicy.r2cRequestSoftLimit,
          hardLimit: defaultPolicy.hardLimit,
          maxAcceptableFee: defaultPolicy.maxAcceptableFee,
        },
      });
      console.log(
        `🔄 Auto-rebalance policy bootstrapped: token=${tokenId} soft=${defaultPolicy.r2cRequestSoftLimit} hard=${defaultPolicy.hardLimit} maxFee=${defaultPolicy.maxAcceptableFee}`,
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
    // Skip manual mode (r2cRequestSoftLimit === hardLimit convention)
    if (policy.r2cRequestSoftLimit === policy.hardLimit) continue;

    const delta = accountMachine.deltas.get(tokenId);
    if (!delta) continue;

    const derived = deriveDelta(delta, isLeft);
    const outPeerCredit = derived.outPeerCredit;
    // Rebalance trigger must be based ONLY on uncollateralized peer credit usage.
    //
    // deriveDelta semantics:
    // - outPeerCredit: how much of peer credit we currently use (risk surface)
    // - outCollateral: how much collateral currently secures our side
    //
    // Using (outCollateral + outPeerCredit) here would over-trigger after a successful
    // top-up because outCollateral remains high even when risk is already covered.
    const rebalanceTrigger = outPeerCredit;
    // Global safety floor: tiny balances should not trigger auto-rebalance noise.
    const effectiveSoftLimit =
      policy.r2cRequestSoftLimit < DEFAULT_SOFT_LIMIT ? DEFAULT_SOFT_LIMIT : policy.r2cRequestSoftLimit;

    // Also dedupe pre-commit queue: if request_collateral is already in account mempool
    // for this token, do not enqueue another copy in the same consensus window.
    const hasQueuedRequest = accountMachine.mempool.some(
      (tx) => tx.type === 'request_collateral' && Number(tx.data?.tokenId) === Number(tokenId),
    );
    if (hasQueuedRequest) {
      console.log(`⏭️ Auto-rebalance skipped: request already queued in mempool token=${tokenId}`);
      continue;
    }

    // Check if there's already a pending frame (don't pile up)
    if (accountMachine.pendingFrame) {
      console.log(
        `⏭️ Auto-rebalance skipped: pendingFrame exists (token=${tokenId}, h=${accountMachine.pendingFrame.height})`,
      );
      continue;
    }

    if (rebalanceTrigger > effectiveSoftLimit) {
      const liquidityFee = (outPeerCredit * feePolicy.liquidityFeeBps) / 10000n;
      const feeAmount = feePolicy.baseFee + feePolicy.gasFee + liquidityFee;

      // Respect user policy ceiling for automated requests.
      if (feeAmount > policy.maxAcceptableFee) {
        console.log(
          `⏭️ Auto-rebalance skipped: token=${tokenId} fee=${feeAmount} > maxAcceptableFee=${policy.maxAcceptableFee}`,
        );
        continue;
      }

      // Keep dedupe semantics aligned with committed request state:
      // handleRequestCollateral stores requestedRebalance as net amount
      // when fee token equals request token.
      const netRequestedTarget = outPeerCredit > feeAmount ? outPeerCredit - feeAmount : 0n;
      if (netRequestedTarget <= 0n) {
        console.log(
          `⏭️ Auto-rebalance skipped: token=${tokenId} netRequestedTarget<=0 (outPeerCredit=${outPeerCredit}, fee=${feeAmount})`,
        );
        continue;
      }
      const existingRequest = accountMachine.requestedRebalance.get(tokenId);
      if (existingRequest && existingRequest > 0n) {
        console.log(
          `⏭️ Auto-rebalance skipped: existing pending request token=${tokenId} amount=${existingRequest} (netTarget=${netRequestedTarget})`,
        );
        continue; // Already requested, don't spam
      }

      result.push({
        type: 'request_collateral',
        data: {
          tokenId,
          amount: outPeerCredit,
          feeTokenId: tokenId, // Pay fee in same token
          feeAmount,
          policyVersion: feePolicy.policyVersion,
        },
      });

      console.log(
        `🔄 Auto-rebalance triggered: token=${tokenId} outPeerCredit=${rebalanceTrigger} ` +
        `> r2cRequestSoftLimit=${effectiveSoftLimit}, requesting outPeerCredit=${outPeerCredit} with fee ${feeAmount} ` +
        `(base=${feePolicy.baseFee}, gas=${feePolicy.gasFee}, liqBps=${feePolicy.liquidityFeeBps})`
      );
    }
  }

  return result;
}
