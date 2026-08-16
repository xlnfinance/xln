/** Exact Account, reserve, rebalance, and J-finality snapshots for netting evidence. */

import type { AccountReplica, Delta } from '../../../../../types/account';
import {
  requireBoundaryInteger,
  requireBoundaryRecord,
} from '../../../../../protocol/boundary-validation';
import { decodeHubCoreRecord } from '../worker-boundary';
import { readLoadAccount, type ConnectedRuntime } from '../worker-runtime';
import type {
  CrossNettingAccountPairSnapshot,
  CrossNettingAccountReplicaSnapshot,
  CrossNettingHubSnapshot,
  CrossNettingMarketMakerPairSnapshot,
  CrossNettingStage,
  CrossNettingStateSnapshot,
} from './cross-netting-report';

type SnapshotIdentity = Readonly<{ entityId: string }>;

export type CrossNettingSnapshotOptions = Readonly<{
  hubRuntime: ConnectedRuntime;
  loadRuntime: ConnectedRuntime;
  marketMakerRuntime: ConnectedRuntime;
  stage: CrossNettingStage;
  sequence: number;
  tokenId: number;
  userA: SnapshotIdentity;
  hubA: SnapshotIdentity;
  userB: SnapshotIdentity;
  hubB: SnapshotIdentity;
  marketMakerA: SnapshotIdentity;
  marketMakerB: SnapshotIdentity;
}>;

const normalize = (value: string): string => value.toLowerCase();

const accountContains = (account: AccountReplica, first: string, second: string): boolean => {
  const participants = new Set([
    normalize(account.state.leftEntity),
    normalize(account.state.rightEntity),
  ]);
  return participants.has(normalize(first)) && participants.has(normalize(second));
};

const requireDelta = (account: AccountReplica, tokenId: number, code: string): Delta => {
  const delta = account.state.deltas.get(tokenId);
  if (!delta) throw new Error(`${code}_DELTA_MISSING:${tokenId}`);
  return delta;
};

const snapshotAccountReplica = (
  account: AccountReplica,
  tokenId: number,
  code: string,
): CrossNettingAccountReplicaSnapshot => {
  const delta = requireDelta(account, tokenId, code);
  const request = account.state.requestedRebalance.get(tokenId) ?? 0n;
  const fee = account.state.requestedRebalanceFeeState?.get(tokenId);
  return {
    currentHeight: account.currentHeight,
    ondelta: delta.ondelta.toString(),
    offdelta: delta.offdelta.toString(),
    collateral: delta.collateral.toString(),
    leftHold: delta.leftHold.toString(),
    rightHold: delta.rightHold.toString(),
    requestedRebalance: request.toString(),
    requestId: fee?.requestId ?? '',
    requestPolicyVersion: fee?.policyVersion ?? 0,
    requestFeeTokenId: fee?.feeTokenId ?? 0,
    requestFeePaid: (fee?.feePaidUpfront ?? 0n).toString(),
    submittedAt: account.shadow.rebalance.submittedAtByToken.get(tokenId) ?? 0,
    pendingFrame: Boolean(account.pendingFrame),
    pendingFrameHeight: account.pendingFrame?.height ?? null,
    pendingFrameTxTypes: (account.pendingFrame?.accountTxs ?? []).map(tx => tx.type),
    pullCount: account.state.pulls?.size ?? 0,
  };
};

const snapshotAccountPair = (
  userAccount: AccountReplica,
  hubAccount: AccountReplica,
  userEntityId: string,
  hubEntityId: string,
  tokenId: number,
  code: string,
): CrossNettingAccountPairSnapshot => {
  if (!accountContains(userAccount, userEntityId, hubEntityId) ||
      !accountContains(hubAccount, userEntityId, hubEntityId)) {
    throw new Error(`${code}_PARTICIPANTS_MISMATCH`);
  }
  const userIsLeft = normalize(userAccount.state.leftEntity) === normalize(userEntityId);
  const policy = userAccount.shadow.rebalance.policy.get(tokenId);
  if (!policy) throw new Error(`${code}_USER_POLICY_MISSING:${tokenId}`);
  const bilateralPolicy = userAccount.state.rebalanceFeePolicies?.get(tokenId);
  const hubIsLeft = normalize(userAccount.state.leftEntity) === normalize(hubEntityId);
  const hubFeePolicy = hubIsLeft ? bilateralPolicy?.left : bilateralPolicy?.right;
  if (!hubFeePolicy) throw new Error(`${code}_HUB_FEE_POLICY_MISSING:${tokenId}`);
  return {
    userEntityId,
    hubEntityId,
    tokenId,
    userIsLeft,
    policySoftLimit: policy.r2cRequestSoftLimit.toString(),
    policyHardLimit: policy.hardLimit.toString(),
    policyMaxFee: policy.maxAcceptableFee.toString(),
    hubFeePolicyVersion: hubFeePolicy.policyVersion,
    hubBaseFee: hubFeePolicy.baseFee.toString(),
    hubLiquidityFeeBps: hubFeePolicy.liquidityFeeBps.toString(),
    hubGasFee: hubFeePolicy.gasFee.toString(),
    user: snapshotAccountReplica(userAccount, tokenId, `${code}_USER`),
    hub: snapshotAccountReplica(hubAccount, tokenId, `${code}_HUB`),
  };
};

const snapshotMarketMakerPair = (
  marketMakerAccount: AccountReplica,
  hubAccount: AccountReplica,
  marketMakerEntityId: string,
  hubEntityId: string,
  tokenId: number,
  code: string,
): CrossNettingMarketMakerPairSnapshot => {
  const pair = snapshotAccountPair(
    marketMakerAccount, hubAccount, marketMakerEntityId, hubEntityId, tokenId, code,
  );
  return {
    marketMakerEntityId: pair.userEntityId,
    hubEntityId: pair.hubEntityId,
    tokenId: pair.tokenId,
    marketMakerIsLeft: pair.userIsLeft,
    policySoftLimit: pair.policySoftLimit,
    policyHardLimit: pair.policyHardLimit,
    policyMaxFee: pair.policyMaxFee,
    hubFeePolicyVersion: pair.hubFeePolicyVersion,
    hubBaseFee: pair.hubBaseFee,
    hubLiquidityFeeBps: pair.hubLiquidityFeeBps,
    hubGasFee: pair.hubGasFee,
    marketMaker: pair.user,
    hub: pair.hub,
  };
};

const requireMap = (value: unknown, code: string): Map<unknown, unknown> => {
  if (!(value instanceof Map)) throw new Error(code);
  return value;
};

const matchingHubR2CPairs = (
  batchValue: unknown,
  hubEntityId: string,
  tokenId: number,
  code: string,
): number => {
  if (batchValue === undefined) return 0;
  const batch = requireBoundaryRecord(batchValue, code);
  const operations = batch['reserveToCollateral'];
  if (!Array.isArray(operations)) throw new Error(`${code}_R2C_INVALID`);
  let count = 0;
  for (const [index, operationValue] of operations.entries()) {
    const operation = requireBoundaryRecord(operationValue, `${code}_R2C_${index}`);
    if (requireBoundaryInteger(operation['tokenId'], `${code}_R2C_TOKEN_${index}`, 1) !== tokenId ||
        normalize(String(operation['receivingEntity'] ?? '')) !== normalize(hubEntityId)) continue;
    const pairs = operation['pairs'];
    if (!Array.isArray(pairs)) throw new Error(`${code}_R2C_PAIRS_${index}`);
    for (const [pairIndex, pairValue] of pairs.entries()) {
      requireBoundaryRecord(pairValue, `${code}_R2C_PAIR_${index}_${pairIndex}`);
      count += 1;
    }
  }
  return count;
};

const countAccountSettledEvents = (
  blocksValue: unknown,
  hubEntityId: string,
  tokenId: number,
  code: string,
): { count: number; oldestRetainedJHeight: number | null } => {
  if (!Array.isArray(blocksValue)) throw new Error(`${code}_J_BLOCKS_INVALID`);
  let count = 0;
  let oldestRetainedJHeight: number | null = null;
  for (const [blockIndex, blockValue] of blocksValue.entries()) {
    const block = requireBoundaryRecord(blockValue, `${code}_J_BLOCK_${blockIndex}`);
    const height = requireBoundaryInteger(block['jHeight'], `${code}_J_HEIGHT_${blockIndex}`);
    oldestRetainedJHeight = oldestRetainedJHeight === null || height < oldestRetainedJHeight
      ? height
      : oldestRetainedJHeight;
    if (!Array.isArray(block['events'])) throw new Error(`${code}_J_EVENTS_${blockIndex}`);
    for (const [eventIndex, eventValue] of block['events'].entries()) {
      const event = requireBoundaryRecord(eventValue, `${code}_J_EVENT_${blockIndex}_${eventIndex}`);
      if (event['type'] !== 'AccountSettled') continue;
      const data = requireBoundaryRecord(event['data'], `${code}_ACCOUNT_SETTLED_${blockIndex}_${eventIndex}`);
      if (
        [data['leftEntity'], data['rightEntity']]
          .some(entityId => normalize(String(entityId ?? '')) === normalize(hubEntityId)) &&
        requireBoundaryInteger(data['tokenId'], `${code}_ACCOUNT_SETTLED_TOKEN`, 1) === tokenId
      ) count += 1;
    }
  }
  return { count, oldestRetainedJHeight };
};

const snapshotHub = (
  coreValue: unknown,
  runtimeId: string,
  hubEntityId: string,
  tokenId: number,
  code: string,
): CrossNettingHubSnapshot => {
  const core = decodeHubCoreRecord(coreValue);
  if (normalize(String(core['entityId'])) !== normalize(hubEntityId)) {
    throw new Error(`${code}_ENTITY_MISMATCH`);
  }
  const reserve = requireMap(core['reserves'], `${code}_RESERVES_INVALID`).get(tokenId);
  if (typeof reserve !== 'bigint' || reserve < 0n) throw new Error(`${code}_RESERVE_INVALID:${tokenId}`);
  const lastFinalizedJHeight = requireBoundaryInteger(core['lastFinalizedJHeight'], `${code}_J_HEIGHT`);
  const settled = countAccountSettledEvents(
    core['jBlockChain'], hubEntityId, tokenId, code,
  );
  const batchState = core['jBatchState'] === undefined
    ? undefined
    : requireBoundaryRecord(core['jBatchState'], `${code}_BATCH_STATE`);
  const currentR2CCount = matchingHubR2CPairs(
    batchState?.['batch'], hubEntityId, tokenId, `${code}_CURRENT_BATCH`,
  );
  const sent = batchState?.['sentBatch'] === undefined
    ? undefined
    : requireBoundaryRecord(batchState['sentBatch'], `${code}_SENT_BATCH`);
  const sentR2CCount = matchingHubR2CPairs(
    sent?.['batch'], hubEntityId, tokenId, `${code}_SENT_BATCH_BODY`,
  );
  const recovery = batchState?.['recoveryBatches'];
  if (recovery !== undefined && !Array.isArray(recovery)) throw new Error(`${code}_RECOVERY_BATCHES`);
  const recoveryR2CCount = (recovery ?? []).reduce((total, batch, index) => total + matchingHubR2CPairs(
    batch, hubEntityId, tokenId, `${code}_RECOVERY_BATCH_${index}`,
  ), 0);
  return {
    entityId: hubEntityId,
    runtimeId,
    tokenId,
    reserve: reserve.toString(),
    lastFinalizedJHeight,
    oldestRetainedJHeight: settled.oldestRetainedJHeight ?? lastFinalizedJHeight + 1,
    accountSettledEventCount: settled.count,
    currentR2CCount,
    sentR2CCount,
    recoveryR2CCount,
  };
};

export const captureCrossNettingSnapshot = async (
  options: CrossNettingSnapshotOptions,
): Promise<CrossNettingStateSnapshot> => {
  const [
    userAAccount, hubUserAAccount, userBAccount, hubUserBAccount,
    marketMakerAAccount, hubMarketMakerAAccount, marketMakerBAccount, hubMarketMakerBAccount,
    hubACore, hubBCore,
  ] = await Promise.all([
    readLoadAccount(options.loadRuntime, options.userA.entityId, options.hubA.entityId),
    readLoadAccount(options.hubRuntime, options.hubA.entityId, options.userA.entityId),
    readLoadAccount(options.loadRuntime, options.userB.entityId, options.hubB.entityId),
    readLoadAccount(options.hubRuntime, options.hubB.entityId, options.userB.entityId),
    readLoadAccount(options.marketMakerRuntime, options.marketMakerA.entityId, options.hubA.entityId),
    readLoadAccount(options.hubRuntime, options.hubA.entityId, options.marketMakerA.entityId),
    readLoadAccount(options.marketMakerRuntime, options.marketMakerB.entityId, options.hubB.entityId),
    readLoadAccount(options.hubRuntime, options.hubB.entityId, options.marketMakerB.entityId),
    options.hubRuntime.adapter.read<unknown>(`entity/${options.hubA.entityId}`),
    options.hubRuntime.adapter.read<unknown>(`entity/${options.hubB.entityId}`),
  ]);
  if (!userAAccount || !hubUserAAccount || !userBAccount || !hubUserBAccount ||
      !marketMakerAAccount || !hubMarketMakerAAccount || !marketMakerBAccount || !hubMarketMakerBAccount) {
    throw new Error('CROSS_NETTING_SNAPSHOT_ACCOUNT_MISSING');
  }
  return {
    stage: options.stage,
    sequence: options.sequence,
    jurisdictionA: snapshotAccountPair(
      userAAccount, hubUserAAccount, options.userA.entityId, options.hubA.entityId,
      options.tokenId, 'CROSS_NETTING_ACCOUNT_A',
    ),
    jurisdictionB: snapshotAccountPair(
      userBAccount, hubUserBAccount, options.userB.entityId, options.hubB.entityId,
      options.tokenId, 'CROSS_NETTING_ACCOUNT_B',
    ),
    marketMakerA: snapshotMarketMakerPair(
      marketMakerAAccount, hubMarketMakerAAccount,
      options.marketMakerA.entityId, options.hubA.entityId,
      options.tokenId, 'CROSS_NETTING_MM_ACCOUNT_A',
    ),
    marketMakerB: snapshotMarketMakerPair(
      marketMakerBAccount, hubMarketMakerBAccount,
      options.marketMakerB.entityId, options.hubB.entityId,
      options.tokenId, 'CROSS_NETTING_MM_ACCOUNT_B',
    ),
    hubA: snapshotHub(
      hubACore, options.hubRuntime.adapter.runtimeId, options.hubA.entityId,
      options.tokenId, 'CROSS_NETTING_HUB_A',
    ),
    hubB: snapshotHub(
      hubBCore, options.hubRuntime.adapter.runtimeId, options.hubB.entityId,
      options.tokenId, 'CROSS_NETTING_HUB_B',
    ),
  };
};
