import { ethers } from 'ethers';
import type { AccountReplica } from '../../types/account';
import type { ProofBodyStruct } from '../../../jurisdictions/typechain-types/contracts/Depository.sol/Depository';
import { asOfferId, type OfferId } from '../../orderbook/swap-keys';
import { sortTransformerEntries } from '../transformer-ordering';
import { decodeHashLadderBinary } from '../htlc/hash-ladder';
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
  DisputeArgumentPlan,
  DisputeArgumentSide,
  DisputeArgumentSnapshot,
} from './argument-snapshot';

const MAX_FILL_RATIO = 0xffff;

type PullArgumentBuckets = { binaries: string[] };

const emptyPullArgumentBuckets = (): PullArgumentBuckets => ({ binaries: [] });

const clampFillRatio = (value: number): number => {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (value >= MAX_FILL_RATIO) return MAX_FILL_RATIO;
  return Math.floor(value);
};

const encodeDeltaTransformerArgs = (
  fillRatios: number[],
  secrets: string[],
  pulls: PullArgumentBuckets = emptyPullArgumentBuckets(),
): string => {
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  return abiCoder.encode(
    ['tuple(uint16[] fillRatios, bytes32[] secrets, bytes[] pulls)'],
    [{
      fillRatios: fillRatios.map((ratio) => BigInt(clampFillRatio(ratio))),
      secrets,
      pulls: pulls.binaries,
    }],
  );
};

const wrapTransformerArgs = (args: string): string => {
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  return abiCoder.encode(['bytes[]'], [[args]]);
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

const collectPullCloseEvidence = (account: AccountReplica): Map<string, string> => {
  if (
    account.disputePrepare?.crossJurisdictionRecovery &&
    account.activeDispute?.crossJurisdictionRecovery
  ) {
    throw new Error('DISPUTE_PULL_EVIDENCE_PHASE_CONFLICT');
  }
  const certifiedResults =
    account.disputePrepare?.crossJurisdictionRecovery?.resultsByPullId ??
    account.activeDispute?.crossJurisdictionRecovery?.resultsByPullId ??
    {};
  const resolves = new Map<string, string>(Object.entries(certifiedResults));
  // Both terminal closes and non-terminal reveals carry the same ladder binary
  // shape; an uncommitted reveal is exactly the evidence a dispute needs for a
  // level the frame chain has not restated into claimedRatio yet.
  for (const tx of [...(account.pendingFrame?.accountTxs ?? []), ...(account.mempool ?? [])]) {
    if (tx.type !== 'cross_pull_close' && tx.type !== 'cross_pull_reveal') continue;
    // Source-final recovery is independently verified and Entity-root
    // committed. Older retained mempool evidence cannot erase it.
    if (Object.hasOwn(certifiedResults, tx.data.pullId)) continue;
    if (resolves.has(tx.data.pullId)) {
      if (resolves.get(tx.data.pullId)?.toLowerCase() !== String(tx.data.binary || '0x').toLowerCase()) {
        resolves.set(tx.data.pullId, '0x');
      }
      continue;
    }
    resolves.set(tx.data.pullId, typeof tx.data.binary === 'string' ? tx.data.binary : '0x');
  }
  return resolves;
};

const buildPullBuckets = (pullIds: string[], resolves: Map<string, string>): PullArgumentBuckets => {
  const binaries: string[] = [];
  for (const pullId of pullIds) {
    const binary = resolves.get(pullId) || '0x';
    try {
      binaries.push(decodeHashLadderBinary(binary).fillRatio > 0 ? binary : '0x');
    } catch {
      // Pull arguments are adversarial evidence. Bad reveal bytes are not an
      // account-state error; they simply prove nothing. This mirrors Solidity:
      // malformed args must not prevent the honest side from finalizing the rest
      // of the dispute.
      binaries.push('0x');
    }
  }
  return { binaries };
};

const hasArgumentData = (fillRatios: number[], secrets: string[], pulls: PullArgumentBuckets): boolean => {
  return (
    fillRatios.some((ratio) => ratio > 0) ||
    secrets.length > 0 ||
    pulls.binaries.some((binary) => binary !== '0x')
  );
};

export function captureDisputeArgumentSnapshot(
  account: AccountReplica,
  proofbodyHash: string,
  nonce: number,
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
    side: account.state.leftEntity === account.proofHeader.fromEntity ? 'left' : 'right',
    proofBodyStruct,
    plan: { paymentHashlocks, leftSwapOfferIds, rightSwapOfferIds, leftPullIds, rightPullIds },
  };
}

export function storeDisputeArgumentSnapshot(
  account: AccountReplica,
  snapshot: DisputeArgumentSnapshot,
): void {
  account.disputeArgumentSnapshotsByHash ??= {};
  account.disputeArgumentSnapshotsByHash[snapshot.proofbodyHash] =
    cloneDisputeArgumentSnapshot(snapshot);
}

export function requireDisputeArgumentSnapshot(
  account: AccountReplica,
  proofbodyHash: string,
  context: string,
): DisputeArgumentSnapshot {
  const snapshot = account.disputeArgumentSnapshotsByHash?.[proofbodyHash];
  if (!snapshot) throw new Error(`DISPUTE_ARGUMENT_SNAPSHOT_MISSING:${context}:${proofbodyHash}`);
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
  const resolves = collectPullCloseEvidence(account);
  const leftFillRatios = snapshot.plan.leftSwapOfferIds.map((offerId) => fillRatios.get(asOfferId(offerId)) ?? 0);
  const rightFillRatios = snapshot.plan.rightSwapOfferIds.map((offerId) => fillRatios.get(asOfferId(offerId)) ?? 0);
  const leftSecrets = options.secretsSide === 'left' ? [...secrets] : [];
  const rightSecrets = options.secretsSide === 'right' ? [...secrets] : [];
  const leftPulls = buildPullBuckets(snapshot.plan.leftPullIds, resolves);
  const rightPulls = buildPullBuckets(snapshot.plan.rightPullIds, resolves);
  const leftArgs = encodeDeltaTransformerArgs(leftFillRatios, leftSecrets, leftPulls);
  const rightArgs = encodeDeltaTransformerArgs(rightFillRatios, rightSecrets, rightPulls);
  const left = sanitizeOptionalDisputeArgument(
    hasArgumentData(leftFillRatios, leftSecrets, leftPulls) ? wrapTransformerArgs(leftArgs) : '0x',
    'dispute.snapshot.left',
  );
  const right = sanitizeOptionalDisputeArgument(
    hasArgumentData(rightFillRatios, rightSecrets, rightPulls) ? wrapTransformerArgs(rightArgs) : '0x',
    'dispute.snapshot.right',
  );
  return {
    leftArguments: left.value,
    rightArguments: right.value,
    warnings: [...left.warnings, ...right.warnings],
  };
}
