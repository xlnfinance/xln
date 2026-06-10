import { ethers } from 'ethers';
import type { AccountMachine, EntityState } from './types';
import type { ProofBodyStruct } from '../jurisdictions/typechain-types/contracts/Depository.sol/Depository';
import { asOfferId, swapKey, type OfferId } from './swap-keys';
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
  proofbodyHash: string;
  nonce: number;
  side: DisputeArgumentSide;
  proofBodyStruct: ProofBodyStruct;
  plan: DisputeArgumentPlan;
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

const buildPendingSwapFillRatios = (
  entityState: EntityState,
  counterpartyEntityId: string,
  plan: DisputeArgumentPlan,
): Map<OfferId, number> => {
  const ratios = new Map<OfferId, number>();
  for (const offerId of [...plan.leftSwapOfferIds, ...plan.rightSwapOfferIds]) {
    const key = swapKey(counterpartyEntityId, offerId);
    ratios.set(asOfferId(offerId), entityState.pendingSwapFillRatios?.get(key) ?? 0);
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
): DisputeArgumentSnapshot {
  // Capture the positional argument plan at the same moment the proof body is
  // signed. Later dispute code must follow this plan; current account maps may
  // have deleted or reordered swaps/pulls by then.
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
  const snapshot = requireDisputeArgumentSnapshot(account, proofbodyHash, 'build');
  const fillRatios = buildPendingSwapFillRatios(entityState, counterpartyEntityId, snapshot.plan);
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
