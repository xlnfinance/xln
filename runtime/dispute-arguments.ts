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
  proofbodyHash: string;
  nonce: number;
  side: DisputeArgumentSide;
  proofBodyStruct: ProofBodyStruct;
  plan: DisputeArgumentPlan;
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
  // present locally; matching by the economic payload prevents that fill from
  // being applied twice to the proof's remaining swap slot.
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
  plan: DisputeArgumentPlan,
  appliedSwapFillFingerprints: readonly string[] | undefined,
): Map<OfferId, number> => {
  const ratios = new Map<OfferId, number>();
  const planned = new Set([...plan.leftSwapOfferIds, ...plan.rightSwapOfferIds]);
  if (planned.size === 0) return ratios;
  const alreadyApplied = new Set(appliedSwapFillFingerprints ?? []);
  for (const tx of [...(account.pendingFrame?.accountTxs ?? []), ...(account.mempool ?? [])]) {
    if (tx.type !== 'swap_resolve') continue;
    if (!planned.has(tx.data.offerId)) continue;
    if (alreadyApplied.has(swapFillFingerprint(tx))) continue;
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
  options: { appliedAccountTxs?: readonly AccountTx[] } = {},
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
  const snapshot = requireDisputeArgumentSnapshot(account, proofbodyHash, 'build');
  const fillRatios = buildPendingSwapFillRatios(
    account,
    snapshot.plan,
    snapshot.appliedSwapFillFingerprints,
  );
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
