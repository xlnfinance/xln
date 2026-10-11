import { ethers } from 'ethers';
import type { AccountReplica } from '../../types/account';
import { asOfferId, type OfferId } from '../../swapbook/swap-keys';
import { sortTransformerEntries } from '../transform/transformer-ordering';
import { buildCanonicalProofBatches } from './proof-builder';
import {
  sanitizeOptionalDisputeArgument,
  J_BATCH_CONTRACT_LIMITS,
  type OptionalDisputeArgumentWarning,
} from '../../jurisdiction/machine/batch';
export type DisputeArgumentSide = 'left' | 'right';

export type DisputeArgumentPlan = Readonly<{
  paymentHashlocks: readonly string[];
  leftSwapOfferIds: readonly string[];
  rightSwapOfferIds: readonly string[];
  leftPullIds: readonly string[];
  rightPullIds: readonly string[];
}>;

const MAX_FILL_RATIO = 0xffff;

const clampFillRatio = (value: number): number => {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (value >= MAX_FILL_RATIO) return MAX_FILL_RATIO;
  return Math.floor(value);
};

// Dispute arguments carry only same-jurisdiction evidence (swap fill ratios,
// payment secrets). Cross-j pulls are absent by design: their settlement reads
// the Depository hash-ladder reveal registry, so no dispute calldata may assert
// a cross-j fill ratio. Keep this tuple in byte parity with
// DeltaTransformer.Arguments — the dispute ABI gate rejects drift.
const encodeDeltaTransformerArgs = (fillRatios: number[], secrets: string[]): string => {
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  return abiCoder.encode(
    ['tuple(uint16[] fillRatios, bytes32[] secrets)'],
    [
      {
        fillRatios: fillRatios.map(ratio => BigInt(clampFillRatio(ratio))),
        secrets,
      },
    ],
  );
};

const wrapTransformerArgs = (args: string[]): string => {
  if (args.length < 1 || args.length > J_BATCH_CONTRACT_LIMITS.maxDisputeTransformers) {
    throw new Error(`DISPUTE_ARGUMENT_CANONICAL_CLAUSE_COUNT_INVALID:${args.length}`);
  }
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  return abiCoder.encode(['bytes[]'], [args]);
};

const buildPendingSwapFillRatios = (account: AccountReplica, plan: DisputeArgumentPlan): Map<OfferId, number> => {
  const ratios = new Map<OfferId, number>();
  const planned = new Set([...plan.leftSwapOfferIds, ...plan.rightSwapOfferIds].map(asOfferId));
  // A resolve can arrive after this side has already built an optimistic frame.
  // Therefore the Account machine itself is the durable evidence source: first
  // the in-flight candidate, then later arrivals retained in its mempool. The
  // first resolve for an offer is authoritative for this signed ProofBody;
  // another fill cannot causally apply until that candidate is committed.
  for (const tx of [...(account.pendingFrame?.accountTxs ?? []), ...(account.mempool ?? [])]) {
    if (tx.type !== 'swap_resolve') continue;
    const offerId = asOfferId(tx.data.offerId);
    if (!planned.has(offerId) || ratios.has(offerId)) continue;
    const ratio = tx.data.fillRatio;
    if (!Number.isSafeInteger(ratio) || ratio <= 0 || ratio > MAX_FILL_RATIO) continue;
    ratios.set(offerId, ratio);
  }
  return ratios;
};

const hasArgumentData = (fillRatios: number[], secrets: string[]): boolean => {
  return fillRatios.some(ratio => ratio > 0) || secrets.length > 0;
};

export function buildCurrentDisputeArgumentPlan(account: AccountReplica): DisputeArgumentPlan {
  // Dispute preparation freezes the Account before submission. Therefore the
  // one live AccountState is the positional authority until finality. Retaining
  // a historical plan here would create a second, potentially divergent state.
  //
  // We keep runtime IDs only in this derived off-chain plan. Solidity receives
  // compact positional arrays because pushing offerId/pullId strings into the
  // jurisdiction would burn gas and freeze runtime bookkeeping into the ABI.
  //
  // Cross-j offers are intentionally excluded here: their safety is represented
  // by pull hash-ladders, not same-j swap fill ratios.
  const paymentHashlocks = sortTransformerEntries((account.state.locks ?? new Map()).entries()).map(([, lock]) =>
    String(lock.hashlock),
  );
  const leftSwapOfferIds: string[] = [];
  const rightSwapOfferIds: string[] = [];
  for (const [offerId, offer] of sortTransformerEntries((account.state.swapOffers ?? new Map()).entries())) {
    if (offer.crossJurisdiction) continue;
    if (offer.makerIsLeft) rightSwapOfferIds.push(offerId);
    else leftSwapOfferIds.push(offerId);
  }
  const leftPullIds: string[] = [];
  const rightPullIds: string[] = [];
  for (const [pullId, pull] of sortTransformerEntries((account.state.pulls ?? new Map()).entries())) {
    if (pull.amount >= 0n) leftPullIds.push(pullId);
    else rightPullIds.push(pullId);
  }
  return { paymentHashlocks, leftSwapOfferIds, rightSwapOfferIds, leftPullIds, rightPullIds };
}

export function buildDisputeArgumentsFromState(
  account: AccountReplica,
  options: { secretsSide: DisputeArgumentSide | 'none' },
  secrets: readonly string[],
): {
  leftArguments: string;
  rightArguments: string;
  warnings: readonly OptionalDisputeArgumentWarning[];
} {
  const plan = buildCurrentDisputeArgumentPlan(account);
  const fillRatios = buildPendingSwapFillRatios(account, plan);
  const leftFillRatios = plan.leftSwapOfferIds.map(offerId => fillRatios.get(asOfferId(offerId)) ?? 0);
  const rightFillRatios = plan.rightSwapOfferIds.map(offerId => fillRatios.get(asOfferId(offerId)) ?? 0);
  const leftSecrets = options.secretsSide === 'left' ? [...secrets] : [];
  const rightSecrets = options.secretsSide === 'right' ? [...secrets] : [];
  let leftSwapIndex = 0;
  let rightSwapIndex = 0;
  // Solidity restarts its counterparty-owned swap indexes in every clause.
  // Slice those ratios by the exact signed chunk plan; repeating the complete
  // ratio array would let a later swap consume another order's authorization.
  const argumentsByClause = buildCanonicalProofBatches(account)
    .filter(batch => batch.payments.length > 0 || batch.swaps.length > 0)
    .map(batch => {
      const leftCount = batch.swaps.filter(swap => !swap.ownerIsLeft).length;
      const rightCount = batch.swaps.length - leftCount;
      const leftRatios =
        batch.payments.length > 0 ? leftFillRatios : leftFillRatios.slice(leftSwapIndex, leftSwapIndex + leftCount);
      const rightRatios =
        batch.payments.length > 0
          ? rightFillRatios
          : rightFillRatios.slice(rightSwapIndex, rightSwapIndex + rightCount);
      leftSwapIndex += leftCount;
      rightSwapIndex += rightCount;
      return {
        left: encodeDeltaTransformerArgs(leftRatios, leftSecrets),
        right: encodeDeltaTransformerArgs(rightRatios, rightSecrets),
      };
    });
  const left = sanitizeOptionalDisputeArgument(
    hasArgumentData(leftFillRatios, leftSecrets) ? wrapTransformerArgs(argumentsByClause.map(args => args.left)) : '0x',
    'dispute.state.left',
  );
  const right = sanitizeOptionalDisputeArgument(
    hasArgumentData(rightFillRatios, rightSecrets)
      ? wrapTransformerArgs(argumentsByClause.map(args => args.right))
      : '0x',
    'dispute.state.right',
  );
  return {
    leftArguments: left.value,
    rightArguments: right.value,
    warnings: [...left.warnings, ...right.warnings],
  };
}
