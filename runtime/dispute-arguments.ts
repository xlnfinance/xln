import { ethers } from 'ethers';
import type { AccountMachine, AccountTx, EntityState } from './types';
import type { ProofBodyStruct } from '../jurisdictions/typechain-types/contracts/Depository.sol/Depository';
import { asOfferId, type OfferId } from './swap-keys';
import { sortTransformerEntries } from './transformer-ordering';
import { decodeHashLadderBinary } from './hashladder';

const MAX_FILL_RATIO = 0xffff;

export type DisputeArgumentSide = 'left' | 'right';

export type DisputeArgumentPlan = {
  paymentHashlocks: string[];
  leftSwapOfferIds: string[];
  rightSwapOfferIds: string[];
  leftPullIds: string[];
  rightPullIds: string[];
};

export type DisputeArgumentSnapshot = {
  // Arguments are positional calldata for the transformer inside one exact
  // proof body. The runtime may delete terminal swaps/pulls later; never rebuild
  // this plan from live Maps for an older proofbodyHash.
  proofbodyHash: string;
  nonce: number;
  side: DisputeArgumentSide;
  proofBodyStruct: ProofBodyStruct;
  plan: DisputeArgumentPlan;
  appliedFrameHeight?: number;
  appliedSwapFillFingerprints?: string[];
};

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

const hashHtlcSecret = (secret: string): string => {
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['bytes32'], [secret])).toLowerCase();
};

const swapFillFingerprint = (tx: Extract<AccountTx, { type: 'swap_resolve' }>): string => {
  const data = tx.data;
  // A proof snapshot records fills already applied to that proof body. While
  // building dispute calldata later, the same pending frame may still be
  // present locally. We use this economic fingerprint only together with the
  // applied frame height; value alone is not identity because two later fills can
  // legitimately have identical amounts.
  //
  // Counterexample: hub sends 50%, then later signs a state where total progress
  // is 75%, while the user is offline. If the 50% tx remains in pendingFrame and
  // we blindly rebuild args, the 75% proof would receive the 50% residual again.
  // The contract would see valid calldata, but it would settle the wrong amount.
  return [
    data.offerId,
    data.fillRatio,
    data.fillNumerator?.toString() ?? '',
    data.fillDenominator?.toString() ?? '',
    data.executionGiveAmount?.toString() ?? '',
    data.executionWantAmount?.toString() ?? '',
    data.cancelRemainder ? '1' : '0',
  ].join('|');
};

const collectAppliedSwapFillFingerprints = (accountTxs: readonly AccountTx[] | undefined): string[] => {
  if (!accountTxs?.length) return [];
  const fingerprints: string[] = [];
  for (const tx of accountTxs) {
    if (tx.type !== 'swap_resolve') continue;
    fingerprints.push(swapFillFingerprint(tx));
  }
  return fingerprints;
};

const buildPendingSwapFillRatios = (
  account: AccountMachine,
  snapshot: DisputeArgumentSnapshot,
): Map<OfferId, number> => {
  const ratios = new Map<OfferId, number>();
  const { plan } = snapshot;
  const planned = new Set([...plan.leftSwapOfferIds, ...plan.rightSwapOfferIds]);
  if (planned.size === 0) return ratios;
  const alreadyApplied = new Set(snapshot.appliedSwapFillFingerprints ?? []);
  const pendingFrameHeight = account.pendingFrame?.height;
  const pendingFrameTxs = account.pendingFrame?.accountTxs ?? [];
  const shouldSkipAppliedPendingFrame =
    snapshot.appliedFrameHeight !== undefined &&
    pendingFrameHeight === snapshot.appliedFrameHeight;
  for (const tx of pendingFrameTxs) {
    if (tx.type !== 'swap_resolve') continue;
    if (!planned.has(tx.data.offerId)) continue;
    if (
      snapshot.appliedFrameHeight === undefined &&
      alreadyApplied.has(swapFillFingerprint(tx))
    ) {
      throw new Error(`DISPUTE_ARGUMENT_APPLIED_FRAME_HEIGHT_MISSING:${snapshot.proofbodyHash}`);
    }
    if (shouldSkipAppliedPendingFrame && alreadyApplied.has(swapFillFingerprint(tx))) continue;
    const offerId = asOfferId(tx.data.offerId);
    if (ratios.has(offerId)) {
      // Two unresolved fills for the same positional offer are ambiguous. Do
      // not guess "last wins": a dispute argument must correspond to one exact
      // signed proof body, or we fail before producing unsafe calldata.
      throw new Error(`DISPUTE_ARGUMENT_SWAP_FILL_AMBIGUOUS:${tx.data.offerId}`);
    }
    ratios.set(offerId, tx.data.fillRatio);
  }
  for (const tx of account.mempool ?? []) {
    if (tx.type !== 'swap_resolve') continue;
    if (!planned.has(tx.data.offerId)) continue;
    const offerId = asOfferId(tx.data.offerId);
    if (ratios.has(offerId)) {
      throw new Error(`DISPUTE_ARGUMENT_SWAP_FILL_AMBIGUOUS:${tx.data.offerId}`);
    }
    ratios.set(offerId, tx.data.fillRatio);
  }
  return ratios;
};

const collectKnownSecrets = (
  entityState: EntityState,
  counterpartyEntityId: string,
  hashlocks: string[],
): string[] => {
  if (!entityState.htlcRoutes?.size || hashlocks.length === 0) return [];
  const required = new Set(hashlocks.map((hashlock) => hashlock.toLowerCase()));
  const seen = new Set<string>();
  const secrets: string[] = [];
  for (const route of entityState.htlcRoutes.values()) {
    if (!route.secret) continue;
    const involvesCounterparty =
      route.inboundEntity === counterpartyEntityId ||
      route.outboundEntity === counterpartyEntityId;
    if (!involvesCounterparty) continue;
    if (!required.has(hashHtlcSecret(route.secret))) continue;
    if (seen.has(route.secret)) continue;
    seen.add(route.secret);
    secrets.push(route.secret);
  }
  return secrets;
};

const collectPullResolves = (account: AccountMachine): Map<string, string> => {
  const resolves = new Map<string, string>();
  for (const tx of [...(account.pendingFrame?.accountTxs ?? []), ...(account.mempool ?? [])]) {
    if (tx.type === 'pull_resolve') resolves.set(tx.data.pullId, tx.data.binary || '0x');
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
  account: AccountMachine,
  proofbodyHash: string,
  nonce: number,
  proofBodyStruct: ProofBodyStruct,
  options: { appliedAccountTxs?: readonly AccountTx[]; appliedFrameHeight?: number } = {},
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
  const paymentHashlocks = sortTransformerEntries((account.locks ?? new Map()).entries())
    .map(([, lock]) => String(lock.hashlock));
  const leftSwapOfferIds: string[] = [];
  const rightSwapOfferIds: string[] = [];
  for (const [offerId, offer] of sortTransformerEntries((account.swapOffers ?? new Map()).entries())) {
    if (offer.crossJurisdiction) continue;
    if (offer.makerIsLeft) rightSwapOfferIds.push(offerId);
    else leftSwapOfferIds.push(offerId);
  }
  const leftPullIds: string[] = [];
  const rightPullIds: string[] = [];
  for (const [pullId, pull] of sortTransformerEntries((account.pulls ?? new Map()).entries())) {
    if (pull.amount >= 0n) leftPullIds.push(pullId);
    else rightPullIds.push(pullId);
  }
  return {
    proofbodyHash,
    nonce,
    side: account.leftEntity === account.proofHeader.fromEntity ? 'left' : 'right',
    proofBodyStruct,
    plan: { paymentHashlocks, leftSwapOfferIds, rightSwapOfferIds, leftPullIds, rightPullIds },
    ...(options.appliedFrameHeight !== undefined ? { appliedFrameHeight: options.appliedFrameHeight } : {}),
    appliedSwapFillFingerprints: collectAppliedSwapFillFingerprints(options.appliedAccountTxs),
  };
}

export function storeDisputeArgumentSnapshot(
  account: AccountMachine,
  snapshot: DisputeArgumentSnapshot,
): void {
  account.disputeArgumentSnapshotsByHash ??= {};
  account.disputeArgumentSnapshotsByHash[snapshot.proofbodyHash] = snapshot;
}

export function requireDisputeArgumentSnapshot(
  account: AccountMachine,
  proofbodyHash: string,
  context: string,
): DisputeArgumentSnapshot {
  const snapshot = account.disputeArgumentSnapshotsByHash?.[proofbodyHash];
  if (!snapshot) throw new Error(`DISPUTE_ARGUMENT_SNAPSHOT_MISSING:${context}:${proofbodyHash}`);
  return snapshot;
}

export function buildDisputeArgumentsForSnapshot(
  account: AccountMachine,
  entityState: EntityState,
  counterpartyEntityId: string,
  proofbodyHash: string,
  options: { secretsSide: DisputeArgumentSide | 'none' },
): { leftArguments: string; rightArguments: string } {
  // Fail closed when the exact signed proof body has no argument snapshot. A
  // live rebuild would be a rehydration bug and can pair wrong positional
  // swap/pull arguments with an old proof body.
  //
  // This fail-fast rule is runtime-local. Once bytes reach Solidity they are
  // treated as adversarial optional evidence: malformed argument blobs become
  // empty/no-op so the sender cannot block finalization of unrelated claims.
  const snapshot = requireDisputeArgumentSnapshot(account, proofbodyHash, 'build');
  const fillRatios = buildPendingSwapFillRatios(account, snapshot);
  const resolves = collectPullResolves(account);
  const leftFillRatios = snapshot.plan.leftSwapOfferIds.map((offerId) => fillRatios.get(asOfferId(offerId)) ?? 0);
  const rightFillRatios = snapshot.plan.rightSwapOfferIds.map((offerId) => fillRatios.get(asOfferId(offerId)) ?? 0);
  const secrets = collectKnownSecrets(entityState, counterpartyEntityId, snapshot.plan.paymentHashlocks);
  const leftSecrets = options.secretsSide === 'left' ? secrets : [];
  const rightSecrets = options.secretsSide === 'right' ? secrets : [];
  const leftPulls = buildPullBuckets(snapshot.plan.leftPullIds, resolves);
  const rightPulls = buildPullBuckets(snapshot.plan.rightPullIds, resolves);
  const leftArgs = encodeDeltaTransformerArgs(leftFillRatios, leftSecrets, leftPulls);
  const rightArgs = encodeDeltaTransformerArgs(rightFillRatios, rightSecrets, rightPulls);
  return {
    leftArguments: hasArgumentData(leftFillRatios, leftSecrets, leftPulls) ? wrapTransformerArgs(leftArgs) : '0x',
    rightArguments: hasArgumentData(rightFillRatios, rightSecrets, rightPulls) ? wrapTransformerArgs(rightArgs) : '0x',
  };
}
