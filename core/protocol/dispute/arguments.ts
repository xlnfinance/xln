import { haltRuntimeFailure } from "../errors/failure-taxonomy";

import { ethers } from 'ethers';
import type { AccountReplica } from '../../types/account';
import type { ProofBodyStruct } from '../../../jurisdictions/typechain-types/Depository.sol/Depository';
import { asOfferId, type OfferId } from '../../orderbook/swap-keys';
import { sortTransformerEntries } from '../transform/transformer-ordering';
import {
  sanitizeOptionalDisputeArgument,
  type OptionalDisputeArgumentWarning,
} from '../../jurisdiction/machine/batch';
import {
  cloneDisputeArgumentSnapshot,
  type DisputeArgumentSide,
  type DisputeArgumentSnapshot,
} from './argument-snapshot';

export type {
  DisputeArgumentSide,
  DisputeArgumentSnapshot,
} from './argument-snapshot';

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
const encodeDeltaTransformerArgs = (
  fillRatios: number[],
  secrets: string[],
): string => {
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  return abiCoder.encode(
    ['tuple(uint16[] fillRatios, bytes32[] secrets)'],
    [{
      fillRatios: fillRatios.map((ratio) => BigInt(clampFillRatio(ratio))),
      secrets,
    }],
  );
};

const wrapTransformerArgs = (args: string, canonicalArgumentClauseCount: number): string => {
  if (canonicalArgumentClauseCount < 1 || canonicalArgumentClauseCount > 2) {
    throw new Error(`DISPUTE_ARGUMENT_CANONICAL_CLAUSE_COUNT_INVALID:${canonicalArgumentClauseCount}`);
  }
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  return abiCoder.encode(
    ['bytes[]'],
    [Array.from({ length: canonicalArgumentClauseCount }, () => args)],
  );
};

const buildPendingSwapFillRatios = (
  account: AccountReplica,
  snapshot: DisputeArgumentSnapshot,
): Map<OfferId, number> => {
  const ratios = new Map<OfferId, number>();
  const planned = new Set(
    [...snapshot.plan.leftSwapOfferIds, ...snapshot.plan.rightSwapOfferIds].map(asOfferId),
  );
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
  return fillRatios.some((ratio) => ratio > 0) || secrets.length > 0;
};

export function captureDisputeArgumentSnapshot(
  account: AccountReplica,
  proofbodyHash: string,
  nonce: number,
  proposerIsLeft: boolean,
  proofBodyStruct: ProofBodyStruct,
): DisputeArgumentSnapshot {
  // Capture the positional argument plan at the same moment the proof body is
  // signed. Later dispute code must follow this plan; current account maps may
  // have deleted or reordered swaps/pulls by then.
  //
  // We keep runtime IDs only in this off-chain snapshot. Solidity receives
  // compact positional arrays because pushing offerId/pullId strings into the
  // jurisdiction would burn gas and freeze runtime bookkeeping into the ABI.
  //
  // Cross-j offers are intentionally excluded here: their safety is represented
  // by pull hash-ladders and route-level receipts, not same-j swap fill ratios.
  const paymentHashlocks = sortTransformerEntries((account.state.locks ?? new Map()).entries())
    .map(([, lock]) => String(lock.hashlock));
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
  return {
    proofbodyHash,
    nonce,
    proposerIsLeft,
    side: account.state.leftEntity === account.proofHeader.fromEntity ? 'left' : 'right',
    proofBodyStruct,
    plan: { paymentHashlocks, leftSwapOfferIds, rightSwapOfferIds, leftPullIds, rightPullIds },
  };
}

export function storeDisputeArgumentSnapshot(
  account: AccountReplica,
  snapshot: DisputeArgumentSnapshot,
): void {
  account.disputeArgumentSnapshotsByHash = {
    ...(account.disputeArgumentSnapshotsByHash ?? {}),
    [snapshot.proofbodyHash]: cloneDisputeArgumentSnapshot(snapshot),
  };
}

export function requireDisputeArgumentSnapshot(
  account: AccountReplica,
  proofbodyHash: string,
  context: string,
): DisputeArgumentSnapshot {
  const snapshot = account.disputeArgumentSnapshotsByHash?.[proofbodyHash];
  if (!snapshot) throw haltRuntimeFailure("DISPUTE_ARGUMENT_SNAPSHOT_MISSING", `DISPUTE_ARGUMENT_SNAPSHOT_MISSING:${context}:${proofbodyHash}`);
  return snapshot;
}

export function buildDisputeArgumentsFromSnapshot(
  account: AccountReplica,
  proofbodyHash: string,
  options: { secretsSide: DisputeArgumentSide | 'none' },
  secrets: readonly string[],
): {
  leftArguments: string;
  rightArguments: string;
  warnings: readonly OptionalDisputeArgumentWarning[];
} {
  // Fail closed when the exact signed proof body has no argument snapshot. A
  // live rebuild would be a rehydration bug and can pair wrong positional
  // swap/pull arguments with an old proof body.
  //
  // This fail-fast rule is runtime-local. Once bytes reach Solidity, malformed
  // dynamic wrappers become empty evidence. The signed transformer still
  // decides whether empty evidence satisfies the parties' dispute program.
  const snapshot = requireDisputeArgumentSnapshot(account, proofbodyHash, 'build');
  const fillRatios = buildPendingSwapFillRatios(account, snapshot);
  const leftFillRatios = snapshot.plan.leftSwapOfferIds.map((offerId) => fillRatios.get(asOfferId(offerId)) ?? 0);
  const rightFillRatios = snapshot.plan.rightSwapOfferIds.map((offerId) => fillRatios.get(asOfferId(offerId)) ?? 0);
  const leftSecrets = options.secretsSide === 'left' ? [...secrets] : [];
  const rightSecrets = options.secretsSide === 'right' ? [...secrets] : [];
  const leftArgs = encodeDeltaTransformerArgs(leftFillRatios, leftSecrets);
  const rightArgs = encodeDeltaTransformerArgs(rightFillRatios, rightSecrets);
  // The signed builder emits a dense payment→swap prefix and then the pull
  // clause. Both non-pull clauses consume the same compact Arguments tuple but
  // ignore the irrelevant half (payments ignore ratios; swaps ignore secrets).
  // Derive arity from the signed snapshot plan, never mutable live Account
  // maps. Pulls and user subcontracts receive no trailing argument slots.
  const canonicalArgumentClauseCount =
    Number(snapshot.plan.paymentHashlocks.length > 0)
    + Number(snapshot.plan.leftSwapOfferIds.length + snapshot.plan.rightSwapOfferIds.length > 0);
  const left = sanitizeOptionalDisputeArgument(
    hasArgumentData(leftFillRatios, leftSecrets)
      ? wrapTransformerArgs(leftArgs, canonicalArgumentClauseCount)
      : '0x',
    'dispute.snapshot.left',
  );
  const right = sanitizeOptionalDisputeArgument(
    hasArgumentData(rightFillRatios, rightSecrets)
      ? wrapTransformerArgs(rightArgs, canonicalArgumentClauseCount)
      : '0x',
    'dispute.snapshot.right',
  );
  return {
    leftArguments: left.value,
    rightArguments: right.value,
    warnings: [...left.warnings, ...right.warnings],
  };
}
