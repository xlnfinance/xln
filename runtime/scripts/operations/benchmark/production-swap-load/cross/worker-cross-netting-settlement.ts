/** Explicit fee-backed settlement of the one user leg with live peer-credit exposure. */

import { deriveDelta, isLeftEntity } from '../../../../../account/utils';
import type {
  CrossNettingAccountPairSnapshot,
  CrossNettingStateSnapshot,
} from './cross-netting-report';
import { captureCrossNettingSnapshot } from './worker-cross-snapshot';
import { readLoadAccount, sendObserved, type ConnectedRuntime } from '../worker-runtime';

type SettlementIdentity = Readonly<{ entityId: string; signerId: string }>;

export type CrossNettingSettlementOptions = Readonly<{
  hubRuntime: ConnectedRuntime;
  loadRuntime: ConnectedRuntime;
  marketMakerRuntime: ConnectedRuntime;
  hubA: SettlementIdentity;
  hubB: SettlementIdentity;
  userA: SettlementIdentity;
  userB: SettlementIdentity;
  marketMakerA: SettlementIdentity;
  marketMakerB: SettlementIdentity;
  tokenId: number;
  feeTokenId: number;
  accumulated: CrossNettingStateSnapshot;
  commandId: string;
  onProgress?: (
    stage: string,
    details: Readonly<Record<string, unknown>>,
  ) => void;
}>;

export type CrossNettingSettlementResult = Readonly<{
  requestedJurisdiction: 'A' | 'B';
  requestedAmount: string;
  prepaidFee: string;
  rebalanceRequested: CrossNettingStateSnapshot;
  finalized: CrossNettingStateSnapshot;
}>;

type SettlementLeg = Readonly<{
  jurisdiction: 'A' | 'B';
  pair: CrossNettingAccountPairSnapshot;
  user: SettlementIdentity;
  hub: SettlementIdentity;
  exposure: bigint;
}>;

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const positive = (value: bigint): bigint => value > 0n ? value : 0n;

const userOutPeerCredit = (pair: CrossNettingAccountPairSnapshot): bigint => {
  const totalDelta = BigInt(pair.user.ondelta) + BigInt(pair.user.offdelta);
  const collateral = BigInt(pair.user.collateral);
  return pair.userIsLeft ? positive(totalDelta - collateral) : positive(-totalDelta);
};

const selectSettlementLeg = (options: CrossNettingSettlementOptions): SettlementLeg => {
  const legs: SettlementLeg[] = [
    {
      jurisdiction: 'A', pair: options.accumulated.jurisdictionA,
      user: options.userA, hub: options.hubA,
      exposure: userOutPeerCredit(options.accumulated.jurisdictionA),
    },
    {
      jurisdiction: 'B', pair: options.accumulated.jurisdictionB,
      user: options.userB, hub: options.hubB,
      exposure: userOutPeerCredit(options.accumulated.jurisdictionB),
    },
  ];
  const exposed = legs.filter(leg => leg.exposure > 0n);
  if (exposed.length !== 1) {
    throw new Error(`CROSS_NETTING_SETTLEMENT_EXPOSURE_NOT_UNIQUE:${exposed.length}`);
  }
  return exposed[0]!;
};

const requiredFee = (leg: SettlementLeg): bigint =>
  BigInt(leg.pair.hubBaseFee) + BigInt(leg.pair.hubGasFee) +
  (leg.exposure * BigInt(leg.pair.hubLiquidityFeeBps)) / 10_000n;

const capture = (
  options: CrossNettingSettlementOptions,
  stage: 'rebalance_requested' | 'finalized',
): Promise<CrossNettingStateSnapshot> => captureCrossNettingSnapshot({
  hubRuntime: options.hubRuntime,
  loadRuntime: options.loadRuntime,
  marketMakerRuntime: options.marketMakerRuntime,
  stage,
  sequence: options.accumulated.sequence,
  tokenId: options.tokenId,
  userA: options.userA,
  hubA: options.hubA,
  userB: options.userB,
  hubB: options.hubB,
  marketMakerA: options.marketMakerA,
  marketMakerB: options.marketMakerB,
});

const requestForLeg = (snapshot: CrossNettingStateSnapshot, leg: SettlementLeg) =>
  leg.jurisdiction === 'A' ? snapshot.jurisdictionA.user : snapshot.jurisdictionB.user;

const hubForLeg = (snapshot: CrossNettingStateSnapshot, leg: SettlementLeg) =>
  leg.jurisdiction === 'A' ? snapshot.hubA : snapshot.hubB;

const waitForCommittedRequest = async (
  options: CrossNettingSettlementOptions,
  leg: SettlementLeg,
  fee: bigint,
): Promise<CrossNettingStateSnapshot> => {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const snapshot = await capture(options, 'rebalance_requested');
    const request = requestForLeg(snapshot, leg);
    if (
      request.requestedRebalance === leg.exposure.toString() &&
      request.requestPolicyVersion === leg.pair.hubFeePolicyVersion &&
      request.requestFeeTokenId === options.feeTokenId &&
      request.requestFeePaid === fee.toString() && request.requestId.length > 0
    ) return snapshot;
    if (hubForLeg(snapshot, leg).accountSettledEventCount >
        hubForLeg(options.accumulated, leg).accountSettledEventCount) {
      throw new Error('CROSS_NETTING_REQUEST_FINALIZED_BEFORE_EVIDENCE_CAPTURE');
    }
    await sleep(100);
  }
  throw new Error('CROSS_NETTING_REQUEST_NOT_COMMITTED');
};

const r2cCount = (snapshot: CrossNettingStateSnapshot): number =>
  snapshot.hubA.currentR2CCount + snapshot.hubA.sentR2CCount + snapshot.hubA.recoveryR2CCount +
  snapshot.hubB.currentR2CCount + snapshot.hubB.sentR2CCount + snapshot.hubB.recoveryR2CCount;

const waitForFinality = async (
  options: CrossNettingSettlementOptions,
  leg: SettlementLeg,
): Promise<CrossNettingStateSnapshot> => {
  const deadline = Date.now() + 180_000;
  const beforePair = leg.jurisdiction === 'A'
    ? options.accumulated.jurisdictionA
    : options.accumulated.jurisdictionB;
  const beforeHub = hubForLeg(options.accumulated, leg);
  while (Date.now() < deadline) {
    const snapshot = await capture(options, 'finalized');
    const pair = leg.jurisdiction === 'A' ? snapshot.jurisdictionA : snapshot.jurisdictionB;
    const hub = hubForLeg(snapshot, leg);
    const collateralIncrease = BigInt(pair.user.collateral) - BigInt(beforePair.user.collateral);
    const reserveDecrease = BigInt(beforeHub.reserve) - BigInt(hub.reserve);
    if (
      pair.user.requestedRebalance === '0' && collateralIncrease === leg.exposure &&
      reserveDecrease === leg.exposure &&
      hub.accountSettledEventCount === beforeHub.accountSettledEventCount + 1 &&
      r2cCount(snapshot) === 0
    ) return snapshot;
    await sleep(250);
  }
  throw new Error('CROSS_NETTING_SETTLEMENT_FINALITY_NOT_OBSERVED');
};

export const settleCrossNettingExposure = async (
  options: CrossNettingSettlementOptions,
): Promise<CrossNettingSettlementResult> => {
  if (options.accumulated.stage !== 'accumulated') {
    throw new Error(`CROSS_NETTING_SETTLEMENT_STAGE_INVALID:${options.accumulated.stage}`);
  }
  if (options.feeTokenId === options.tokenId) {
    throw new Error('CROSS_NETTING_SETTLEMENT_REQUIRES_SEPARATE_FEE_TOKEN');
  }
  if (!options.commandId.trim()) throw new Error('CROSS_NETTING_SETTLEMENT_COMMAND_ID_INVALID');
  const leg = selectSettlementLeg(options);
  options.onProgress?.('settlement-leg-selected', {
    jurisdiction: leg.jurisdiction,
    userEntityId: leg.user.entityId,
    hubEntityId: leg.hub.entityId,
    exposure: leg.exposure.toString(),
  });
  if (BigInt(hubForLeg(options.accumulated, leg).reserve) < leg.exposure) {
    throw new Error('CROSS_NETTING_SETTLEMENT_HUB_RESERVE_INSUFFICIENT');
  }
  const fee = requiredFee(leg);
  if (fee <= 0n || fee > BigInt(leg.pair.policyMaxFee)) {
    throw new Error(`CROSS_NETTING_SETTLEMENT_FEE_INVALID:${fee}:${leg.pair.policyMaxFee}`);
  }
  const account = await readLoadAccount(options.loadRuntime, leg.user.entityId, leg.hub.entityId);
  const feeDelta = account?.state.deltas.get(options.feeTokenId);
  if (!account || !feeDelta) throw new Error('CROSS_NETTING_SETTLEMENT_FEE_DELTA_MISSING');
  const feeCapacity = deriveDelta(
    feeDelta, isLeftEntity(leg.user.entityId, leg.hub.entityId),
  ).outCapacity;
  if (feeCapacity < fee) {
    throw new Error(`CROSS_NETTING_SETTLEMENT_FEE_CAPACITY_INSUFFICIENT:${feeCapacity}:${fee}`);
  }

  await sendObserved(options.loadRuntime, options.commandId, {
    runtimeTxs: [],
    entityInputs: [{
      entityId: leg.user.entityId,
      signerId: leg.user.signerId,
      entityTxs: [{
        type: 'requestCollateral',
        data: {
          counterpartyEntityId: leg.hub.entityId,
          tokenId: options.tokenId,
          amount: leg.exposure,
          feeTokenId: options.feeTokenId,
          feeAmount: fee,
          policyVersion: leg.pair.hubFeePolicyVersion,
        },
      }],
    }],
  });
  options.onProgress?.('settlement-request-submitted', {
    jurisdiction: leg.jurisdiction,
    exposure: leg.exposure.toString(),
    fee: fee.toString(),
  });
  const rebalanceRequested = await waitForCommittedRequest(options, leg, fee);
  options.onProgress?.('settlement-request-committed', {
    jurisdiction: leg.jurisdiction,
    requestId: requestForLeg(rebalanceRequested, leg).requestId,
  });
  const finalized = await waitForFinality(options, leg);
  options.onProgress?.('settlement-finalized', {
    jurisdiction: leg.jurisdiction,
    exposure: leg.exposure.toString(),
  });
  return {
    requestedJurisdiction: leg.jurisdiction,
    requestedAmount: leg.exposure.toString(),
    prepaidFee: fee.toString(),
    rebalanceRequested,
    finalized,
  };
};
