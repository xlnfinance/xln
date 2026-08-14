import { ethers } from 'ethers';

import type { EntityRuntimeContext } from '../../runtime-context';
import type { EntityState, HashType } from '../../types';
import type { EntityTx } from '../../../types/entity-tx';
import type { JTx } from '../../../types/jurisdiction-runtime';
import type { JInput } from '../../../jurisdiction/machine/input';
import { hashBoardProposalHankoPayload } from '../../../hanko/onchain-domain';
import { verifyHankoForHash } from '../../../hanko/signing';
import {
  getCertifiedBoardNodeStore,
  resolveObserverCertifiedBoardRecord,
} from '../../../jurisdiction/machine/board-registry';
import {
  getJurisdictionConfigName,
  requireRuntimeJurisdictionConfigByName,
} from '../../../jurisdiction/machine/jurisdiction-runtime';
import { requireUsableContractAddress } from '../../../jurisdiction/machine/contract-address';
import { toEntityId } from '../../../protocol/identity';
import { toBoardHash } from '../../../protocol/hashes';
import { prepareEntityTxState } from '../../state-clone';
import { addMessage } from '../../frame-events';
import { getEntityLeaderState } from '../../consensus/leader';
import type { EntityTxReducerResult } from '../apply';

type ControlProposalTx = Extract<EntityTx, { type: 'entityProviderProposeControlBoard' }>;
type ActivateBoardTx = Extract<EntityTx, { type: 'entityProviderActivateBoard' }>;
const CONTROL_AUTHORITY = 1;
const MAX_SUPPORTER_VOTES = 256;

const canonicalEntityId = (value: string): string => toEntityId(value).toLowerCase();

const requireActionNonce = (value: bigint): bigint => {
  if (typeof value !== 'bigint' || value <= 0n || value > ethers.MaxUint256) {
    throw new Error(`CONTROL_BOARD_PROPOSAL_NONCE_INVALID:${String(value)}`);
  }
  return value;
};

// Delaware's written-consent model permits holders of the required voting
// power to act without a meeting or outgoing-board approval (8 Del. C. § 228).
// Here each Entity signs the exact proposal hash under its current board; the
// contract reads its settled CONTROL reserve at execution and counts it once.
// https://delcode.delaware.gov/title8/c001/sc07/
const verifyControlSupporterVotes = async (
  entityState: EntityState,
  env: EntityRuntimeContext,
  proposalHash: string,
  shareholderEntityId: string,
  suppliedVotes: NonNullable<ControlProposalTx['data']['supporterVotes']>,
): Promise<Array<{ entityId: string; hankoSignature?: string }>> => {
  if (suppliedVotes.length >= MAX_SUPPORTER_VOTES) {
    throw new Error(`CONTROL_BOARD_PROPOSAL_SUPPORTERS_OVERSIZED:${suppliedVotes.length}`);
  }
  const nodeStore = getCertifiedBoardNodeStore(env);
  const supporterVotes: Array<{ entityId: string; hankoSignature?: string }> = [];
  for (const vote of suppliedVotes) {
    const entityId = canonicalEntityId(vote.entityId);
    if (entityId === shareholderEntityId || supporterVotes.some((entry) => entry.entityId === entityId)) {
      throw new Error(`CONTROL_BOARD_PROPOSAL_SUPPORTER_DUPLICATE:${entityId}`);
    }
    const record = resolveObserverCertifiedBoardRecord(entityState, nodeStore, entityId);
    if (!record) throw new Error(`CONTROL_BOARD_PROPOSAL_SUPPORTER_AUTHORITY_MISSING:${entityId}`);
    const verified = await verifyHankoForHash(vote.hankoSignature, proposalHash, entityId, env, {
      registeredBoardHash: record.boardHash,
      allowPreviousBoard: false,
      observerState: entityState,
    });
    if (!verified.valid) throw new Error(`CONTROL_BOARD_PROPOSAL_SUPPORTER_HANKO_INVALID:${entityId}`);
    supporterVotes.push({ entityId, hankoSignature: vote.hankoSignature });
  }
  supporterVotes.push({ entityId: shareholderEntityId });
  return supporterVotes.sort((left, right) => left.entityId.localeCompare(right.entityId));
};

export const handleEntityProviderProposeControlBoard = async (
  entityState: EntityState,
  entityTx: ControlProposalTx,
  env: EntityRuntimeContext,
  mutableFrameState = false,
): Promise<EntityTxReducerResult> => {
  const jurisdictionName = getJurisdictionConfigName(entityState.config.jurisdiction);
  if (!jurisdictionName) throw new Error('CONTROL_BOARD_PROPOSAL_JURISDICTION_MISSING');
  const jurisdiction = requireRuntimeJurisdictionConfigByName(
    env,
    jurisdictionName,
    entityState.config.jurisdiction,
  );
  const chainId = BigInt(jurisdiction.chainId ?? 0);
  if (chainId <= 0n) throw new Error(`CONTROL_BOARD_PROPOSAL_CHAIN_ID_INVALID:${chainId}`);
  const entityProviderAddress = requireUsableContractAddress(
    'entity_provider',
    jurisdiction.entityProviderAddress,
  ).toLowerCase();
  const targetEntityId = canonicalEntityId(entityTx.data.targetEntityId);
  const shareholderEntityId = canonicalEntityId(entityState.entityId);
  const newBoardHash = toBoardHash(entityTx.data.newBoardHash);
  const actionNonce = requireActionNonce(entityTx.data.actionNonce);
  const nodeStore = getCertifiedBoardNodeStore(env);
  const targetBoard = resolveObserverCertifiedBoardRecord(entityState, nodeStore, targetEntityId);
  if (!targetBoard) {
    throw new Error(`CONTROL_BOARD_PROPOSAL_TARGET_AUTHORITY_MISSING:${targetEntityId}`);
  }
  const shareholderBoard = resolveObserverCertifiedBoardRecord(
    entityState,
    nodeStore,
    shareholderEntityId,
  );
  if (!shareholderBoard) {
    throw new Error(`CONTROL_BOARD_PROPOSAL_SHAREHOLDER_AUTHORITY_MISSING:${shareholderEntityId}`);
  }
  const proposalHash = hashBoardProposalHankoPayload(
    {
      chainId,
      entityProviderAddress,
      boardEpoch: targetBoard.boardEpoch,
    },
    {
      entityId: targetEntityId,
      newBoardHash,
      authority: CONTROL_AUTHORITY,
      actionNonce,
    },
  ).toLowerCase();

  const supporterVotes = await verifyControlSupporterVotes(
    entityState,
    env,
    proposalHash,
    shareholderEntityId,
    entityTx.data.supporterVotes ?? [],
  );

  const signerId = getEntityLeaderState(entityState).activeValidatorId;
  if (!signerId) throw new Error('CONTROL_BOARD_PROPOSAL_SUBMITTER_MISSING');
  const newState = prepareEntityTxState(entityState, mutableFrameState);
  addMessage(newState, `🗳️ CONTROL vote ${shareholderEntityId.slice(-4)} → ${targetEntityId.slice(-4)}`);
  const jTx: JTx = {
    type: 'entityProviderProposeControlBoard',
    entityId: shareholderEntityId,
    data: {
      targetEntityId,
      newBoardHash,
      boardEpoch: BigInt(targetBoard.boardEpoch),
      actionNonce,
      proposalHash,
      supporterVotes,
      signerId,
    },
    timestamp: newState.timestamp,
  };
  const jOutputs: JInput[] = [{ jurisdictionName: jurisdiction.name, jTxs: [jTx] }];
  const hashesToSign: Array<{ hash: string; type: HashType; context: string }> = [{
    hash: proposalHash,
    type: 'entityProviderAction',
    context: `controlBoard:${targetEntityId.slice(-4)}:nonce:${actionNonce.toString()}`,
  }];
  return { newState, outputs: [], jOutputs, hashesToSign };
};

export const handleEntityProviderActivateBoard = (
  entityState: EntityState,
  entityTx: ActivateBoardTx,
  env: EntityRuntimeContext,
  mutableFrameState = false,
): EntityTxReducerResult => {
  const jurisdictionName = getJurisdictionConfigName(entityState.config.jurisdiction);
  if (!jurisdictionName) throw new Error('CONTROL_BOARD_ACTIVATION_JURISDICTION_MISSING');
  const jurisdiction = requireRuntimeJurisdictionConfigByName(
    env,
    jurisdictionName,
    entityState.config.jurisdiction,
  );
  const targetEntityId = canonicalEntityId(entityTx.data.targetEntityId);
  const targetBoard = resolveObserverCertifiedBoardRecord(
    entityState,
    getCertifiedBoardNodeStore(env),
    targetEntityId,
  );
  if (!targetBoard) throw new Error(`CONTROL_BOARD_ACTIVATION_TARGET_MISSING:${targetEntityId}`);
  const signerId = getEntityLeaderState(entityState).activeValidatorId;
  if (!signerId) throw new Error('CONTROL_BOARD_ACTIVATION_SUBMITTER_MISSING');
  const newState = prepareEntityTxState(entityState, mutableFrameState);
  addMessage(newState, `🔐 Activate board ${targetEntityId.slice(-4)}`);
  return {
    newState,
    outputs: [],
    jOutputs: [{
      jurisdictionName: jurisdiction.name,
      jTxs: [{
        type: 'entityProviderActivateBoard',
        entityId: entityState.entityId,
        data: { targetEntityId, signerId },
        timestamp: newState.timestamp,
      }],
    }],
  };
};
