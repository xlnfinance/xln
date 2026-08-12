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

import type { AccountReplica, AccountTx } from '../../../../types/account';
import { isLeftEntity } from '../../../../protocol/identity/entity-id';
import { deriveDelta } from '../../../utils';
import { deriveTransferOffdeltaChange } from '../../../../protocol/transform/delta-movement';
import { getDefaultRebalanceBaseFeeForToken } from '../../../config/defaults';
import type { ApplyAccountTxResult } from '../../apply-types';
import { accountTxApplied, accountTxValidationRejected } from '../../apply-result';

type RequestCollateralTx = Extract<AccountTx, { type: 'request_collateral' }>;

const validateCollateralRequest = (account: AccountReplica, data: RequestCollateralTx['data']): string | undefined => {
  if (data.amount <= 0n) return 'request_collateral: amount must be > 0';
  if (data.feeAmount < 0n) return 'request_collateral: feeAmount must be >= 0';
  if (!Number.isFinite(data.policyVersion) || data.policyVersion < 1) {
    return `request_collateral: invalid policyVersion ${data.policyVersion}`;
  }
  if (!account.state.deltas.has(data.tokenId)) {
    return `request_collateral: no delta for token ${data.tokenId}`;
  }
  return undefined;
};

const storeCollateralRequest = (
  account: AccountReplica,
  tx: RequestCollateralTx,
  requestedByLeft: boolean,
  requestedAmount: bigint,
  feeTokenId: number,
  feePaidUpfront: bigint,
  currentTimestamp: number,
): void => {
  account.state.requestedRebalanceFeeState ||= new Map();
  account.state.requestedRebalance.set(tx.data.tokenId, requestedAmount);
  account.state.requestedRebalanceFeeState.set(tx.data.tokenId, {
    requestId: `rebalance:${requestedByLeft ? 'left' : 'right'}:${tx.data.tokenId}:${account.currentHeight + 1}`,
    feeTokenId,
    feePaidUpfront,
    requestedAmount,
    policyVersion: tx.data.policyVersion,
    requestedAt: currentTimestamp,
    requestedByLeft,
  });
};

export function handleRequestCollateral(
  account: AccountReplica,
  accountTx: RequestCollateralTx,
  byLeft?: boolean,
  currentTimestamp = 0,
): ApplyAccountTxResult {
  const { tokenId, amount, feeTokenId, feeAmount } = accountTx.data;

  const validationError = validateCollateralRequest(account, accountTx.data);
  if (validationError) return accountTxValidationRejected(validationError, []);

  const existingRequest = account.state.requestedRebalance.get(tokenId) ?? 0n;
  if (existingRequest > 0n) {
    return accountTxApplied([
      `ℹ️ request_collateral skipped: pending request is immutable token=${tokenId} amount=${existingRequest}`,
    ]);
  }

  // Deterministic request amount comes from frame payload.
  // Do not recompute from live outPeerCredit at commit time, otherwise the same tx
  // can produce different request sizes between propose/commit during races.
  const requesterIsLeft = !!byLeft;
  // Validation established amount > 0, and this handler never clamps the
  // signed payload. Therefore the exact prepaid fee is already feeAmount.
  const effectiveFeeTarget = feeAmount;
  if (effectiveFeeTarget <= 0n) {
    return accountTxValidationRejected(
      'request_collateral: feeAmount must produce effectiveFee > 0',
      [],
    );
  }

  const feeToken = feeTokenId ?? tokenId;
  const feeDelta = account.state.deltas.get(feeToken);
  if (!feeDelta) {
    return accountTxValidationRejected(
      `request_collateral: no delta for fee token ${feeToken}`,
      [],
    );
  }

  // Request size is deterministic from payload; when fee is paid in the SAME token,
  // request collateral for net amount after prepaid fee to avoid tiny pending tails.
  let effectiveRequest = amount;
  if (feeToken === tokenId) {
    effectiveRequest = amount > effectiveFeeTarget ? amount - effectiveFeeTarget : 0n;
  }
  if (effectiveRequest <= 0n) {
    return accountTxApplied([
      `ℹ️ Collateral request skipped: prepaid fee consumes the full request (fee=${effectiveFeeTarget}, token=${feeToken})`,
    ]);
  }

  const requesterFeeCapacity = deriveDelta(feeDelta, requesterIsLeft).outCapacity;
  if (effectiveFeeTarget > requesterFeeCapacity) {
    return accountTxValidationRejected(
      `request_collateral: insufficient fee capacity in token ${feeToken} (${requesterFeeCapacity} < ${effectiveFeeTarget})`,
      [],
    );
  }

  // Convention: positive offdelta means LEFT has more.
  // requester pays hub upfront here. All no-op exits are above this mutation.
  if (effectiveFeeTarget > 0n) {
    feeDelta.offdelta += deriveTransferOffdeltaChange(requesterIsLeft, effectiveFeeTarget);
  }

  // Hub crontab consumes this immutable request. A later request must not top
  // it up: the finalized J event clears the cycle before new exposure starts.
  storeCollateralRequest(
    account,
    accountTx,
    requesterIsLeft,
    effectiveRequest,
    feeToken,
    effectiveFeeTarget,
    currentTimestamp,
  );

  const feeDisplay = effectiveFeeTarget > 0n ? `, prepaidFee=${effectiveFeeTarget}` : '';
  const events = [`🔄 Collateral requested: ${effectiveRequest} token ${tokenId}${feeDisplay} (hub will deposit R→C)`];

  return accountTxApplied(events);
}

/**
 * Check if an account needs auto-rebalance after frame commit.
 * Called from account-consensus.ts after RECEIVER-COMMIT.
 *
 * Returns mempool operations to queue if rebalance is needed.
 *
 * @param account - The account after frame commit
 * @param ourEntityId - Our entity ID
 * @param counterpartyId - Counterparty entity ID
 * @param feePolicy - Exact bilateral fee policy already committed in Account state
 * @returns Array of accountTxs to queue in mempool (empty = no rebalance needed)
 */
export interface RebalanceFeePolicy {
  policyVersion: number;
  baseFee?: bigint;
  liquidityFeeBps: bigint;
  gasFee: bigint;
}

export function resolveAutoRebalanceFeePolicy(
  account: AccountReplica,
  ourEntityId: string,
  tokenId: number,
): RebalanceFeePolicy | undefined {
  const ours = ourEntityId.toLowerCase();
  const counterpartySide =
    ours === account.state.leftEntity.toLowerCase()
      ? 'right'
      : ours === account.state.rightEntity.toLowerCase()
        ? 'left'
        : undefined;
  if (!counterpartySide) {
    throw new Error(`REBALANCE_POLICY_ENTITY_NOT_IN_ACCOUNT:${ourEntityId}`);
  }
  const policy = account.state.rebalanceFeePolicies?.get(tokenId)?.[counterpartySide];
  if (!policy) return undefined;
  return {
    policyVersion: policy.policyVersion,
    baseFee: policy.baseFee,
    liquidityFeeBps: policy.liquidityFeeBps,
    gasFee: policy.gasFee,
  };
}

export function checkAutoRebalance(account: AccountReplica, ourEntityId: string, counterpartyId: string): AccountTx[] {
  const result: AccountTx[] = [];

  // New rebalance cycles must not start during settlement. A committed request
  // is immutable until its finalized event clears it. New exposure accumulates
  // independently and is considered by the next cycle after finalization.
  const settlementInFlight = !!account.state.settlementWorkspace;

  if (account.shadow.rebalance.policy.size === 0) {
    return result;
  }

  const isLeft = isLeftEntity(ourEntityId, counterpartyId);
  const orderedPolicies = [...account.shadow.rebalance.policy.entries()].sort(
    ([leftTokenId], [rightTokenId]) => leftTokenId - rightTokenId,
  );
  for (const [tokenId, policy] of orderedPolicies) {
    const feePolicy = resolveAutoRebalanceFeePolicy(account, ourEntityId, tokenId);
    if (!feePolicy) continue;
    // Skip manual mode (r2cRequestSoftLimit === hardLimit convention)
    if (policy.r2cRequestSoftLimit === policy.hardLimit) continue;

    const delta = account.state.deltas.get(tokenId);
    if (!delta) continue;

    const derived = deriveDelta(delta, isLeft);
    const outPeerCredit = derived.outPeerCredit;
    const existingRequest = account.state.requestedRebalance.get(tokenId) ?? 0n;
    if (existingRequest > 0n) continue;
    // Rebalance trigger must be based ONLY on uncollateralized peer credit usage.
    //
    // deriveDelta semantics:
    // - outPeerCredit: how much of peer credit we currently use (risk surface)
    // - outCollateral: how much collateral currently secures our side
    //
    // Using (outCollateral + outPeerCredit) here would over-trigger after a successful
    // top-up because outCollateral remains high even when risk is already covered.
    const rebalanceTrigger = outPeerCredit;
    // Also dedupe pre-commit queue: if request_collateral is already in account mempool
    // for this token, do not enqueue another copy in the same consensus window.
    const hasQueuedRequest = account.mempool.some(
      tx => tx.type === 'request_collateral' && Number(tx.data?.tokenId) === Number(tokenId),
    );
    if (hasQueuedRequest) {
      continue;
    }

    // Check if there's already a pending frame (don't pile up)
    if (account.pendingFrame) {
      continue;
    }

    if (rebalanceTrigger > policy.r2cRequestSoftLimit) {
      const liquidityFee = (outPeerCredit * feePolicy.liquidityFeeBps) / 10000n;
      const baseFee = feePolicy.baseFee ?? getDefaultRebalanceBaseFeeForToken(tokenId);
      const feeAmount = baseFee + feePolicy.gasFee + liquidityFee;

      // Respect user policy ceiling for automated requests.
      if (feeAmount > policy.maxAcceptableFee) {
        continue;
      }

      // Keep dedupe semantics aligned with committed request state:
      // handleRequestCollateral stores requestedRebalance as net amount
      // when fee token equals request token.
      if (outPeerCredit <= feeAmount) continue;
      if (settlementInFlight && (!existingRequest || existingRequest <= 0n)) {
        continue;
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
    }
  }

  return result;
}
