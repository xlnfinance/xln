import { ethers } from 'ethers';

import type {
  EntityInput,
  EntityState,
  EntityTx,
  Env,
  HashType,
  JInput,
  JTx,
} from '../../../types';
import type {
  EntityProviderActionIntent,
  EntityProviderActionPayload,
  EntityProviderActionState,
} from '../../../types/entity-provider-actions';
import {
  assertEntityProviderActionIntent,
  entityProviderActionKindCode,
  recomputeEntityProviderActionHash,
} from '../../entity-provider-action';
import { requireUsableContractAddress } from '../../../jurisdiction/contract-address';
import {
  getJurisdictionConfigName,
  requireRuntimeJurisdictionConfigByName,
} from '../../../jurisdiction/jurisdiction-runtime';
import { cloneEntityState, addMessage } from '../../../state-helpers';
import { getEntityLeaderState } from '../../consensus/leader';
import {
  getCertifiedBoardNodeStore,
  resolveObserverCertifiedBoardRecord,
} from '../../../jurisdiction/board-registry';
import type { EntityTxReducerResult } from '../apply';

type TransferTx = Extract<EntityTx, { type: 'entityProviderTransfer' }>;
type ReleaseTx = Extract<EntityTx, { type: 'entityProviderReleaseControlShares' }>;
type CancelTx = Extract<EntityTx, { type: 'entityProviderCancelAction' }>;

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const MAX_PURPOSE_BYTES = 1_024;

const requireUint = (value: bigint, label: string, allowZero = true): bigint => {
  if (typeof value !== 'bigint' || value < 0n || (!allowZero && value === 0n)) {
    throw new Error(`ENTITY_PROVIDER_ACTION_${label}_INVALID:${String(value)}`);
  }
  return value;
};

const requireAddress = (value: unknown, label: string): string => {
  const raw = String(value ?? '').trim();
  if (!ethers.isAddress(raw) || raw.toLowerCase() === ZERO_ADDRESS) {
    throw new Error(`ENTITY_PROVIDER_ACTION_${label}_INVALID:${raw || 'missing'}`);
  }
  return ethers.getAddress(raw).toLowerCase();
};

const requireNumberedEntity = (entityId: string): bigint => {
  let value: bigint;
  try {
    value = BigInt(entityId);
  } catch {
    throw new Error(`ENTITY_PROVIDER_ACTION_ENTITY_ID_INVALID:${entityId}`);
  }
  if (value <= 0n || value > ethers.MaxUint256) {
    throw new Error(`ENTITY_PROVIDER_ACTION_ENTITY_NUMBER_INVALID:${entityId}`);
  }
  return value;
};

const requireCertifiedBoardEpoch = (state: EntityState, env: Env): bigint => {
  const record = resolveObserverCertifiedBoardRecord(
    state,
    getCertifiedBoardNodeStore(env),
    state.entityId,
  );
  if (!record) throw new Error(`ENTITY_PROVIDER_ACTION_BOARD_AUTHORITY_MISSING:${state.entityId}`);
  return BigInt(record.boardEpoch);
};

const currentActionState = (state: EntityState): EntityProviderActionState => {
  const current = state.entityProviderActionState;
  if (!current) return { version: 1, confirmedNonce: 0n, generation: 0 };
  if (
    current.version !== 1 ||
    typeof current.confirmedNonce !== 'bigint' ||
    current.confirmedNonce < 0n ||
    current.confirmedNonce > ethers.MaxUint256 ||
    !Number.isSafeInteger(current.generation) ||
    current.generation < 0
  ) {
    throw new Error('ENTITY_PROVIDER_ACTION_STATE_INVALID');
  }
  return current;
};

const transferPayload = (tx: TransferTx): EntityProviderActionPayload => ({
  kind: 'entityTransferTokens',
  transfer: {
    to: requireAddress(tx.data.to, 'RECIPIENT'),
    tokenId: requireUint(tx.data.tokenId, 'TOKEN_ID'),
    amount: requireUint(tx.data.amount, 'AMOUNT', false),
  },
});

const releasePayload = (
  tx: ReleaseTx,
  depositoryAddress: string,
): EntityProviderActionPayload => {
  const controlAmount = requireUint(tx.data.controlAmount, 'CONTROL_AMOUNT');
  const dividendAmount = requireUint(tx.data.dividendAmount, 'DIVIDEND_AMOUNT');
  if (controlAmount === 0n && dividendAmount === 0n) {
    throw new Error('ENTITY_PROVIDER_ACTION_RELEASE_AMOUNT_EMPTY');
  }
  if (typeof tx.data.purpose !== 'string') {
    throw new Error('ENTITY_PROVIDER_ACTION_PURPOSE_INVALID:not-string');
  }
  const purposeBytes = new TextEncoder().encode(tx.data.purpose).byteLength;
  if (purposeBytes > MAX_PURPOSE_BYTES) {
    throw new Error(`ENTITY_PROVIDER_ACTION_PURPOSE_OVERSIZED:${purposeBytes}:${MAX_PURPOSE_BYTES}`);
  }
  return {
    kind: 'releaseControlShares',
    release: {
      depositoryAddress,
      controlAmount,
      dividendAmount,
      purpose: tx.data.purpose,
    },
  };
};

const handleAction = (
  entityState: EntityState,
  entityTx: TransferTx | ReleaseTx,
  env: Env,
): EntityTxReducerResult => {
  const configuredName = getJurisdictionConfigName(entityState.config.jurisdiction);
  if (!configuredName) throw new Error('ENTITY_PROVIDER_ACTION_JURISDICTION_MISSING');
  const jurisdiction = requireRuntimeJurisdictionConfigByName(
    env,
    configuredName,
    entityState.config.jurisdiction,
  );
  const chainId = BigInt(jurisdiction.chainId ?? 0);
  if (chainId <= 0n) throw new Error(`ENTITY_PROVIDER_ACTION_CHAIN_ID_INVALID:${chainId}`);
  const entityProviderAddress = requireUsableContractAddress(
    'entity_provider',
    jurisdiction.entityProviderAddress,
  ).toLowerCase();
  const depositoryAddress = requireUsableContractAddress(
    'depository',
    jurisdiction.depositoryAddress,
  ).toLowerCase();
  const current = currentActionState(entityState);
  if (current.pending) {
    throw new Error(
      `ENTITY_PROVIDER_ACTION_PENDING:${current.pending.actionNonce.toString()}:${current.pending.actionHash}`,
    );
  }
  if (current.confirmedNonce === ethers.MaxUint256) {
    throw new Error('ENTITY_PROVIDER_ACTION_NONCE_EXHAUSTED');
  }
  if (current.generation >= Number.MAX_SAFE_INTEGER) {
    throw new Error('ENTITY_PROVIDER_ACTION_GENERATION_EXHAUSTED');
  }
  const signerId = getEntityLeaderState(entityState).activeValidatorId;
  if (!signerId) throw new Error('ENTITY_PROVIDER_ACTION_SUBMITTER_MISSING');
  const entityNumber = requireNumberedEntity(entityState.entityId);
  const boardEpoch = requireCertifiedBoardEpoch(entityState, env);
  const generation = current.generation + 1;
  const payload = entityTx.type === 'entityProviderTransfer'
    ? transferPayload(entityTx)
    : releasePayload(entityTx, depositoryAddress);
  const unsignedIntent = {
    version: 1 as const,
    entityId: entityState.entityId.toLowerCase(),
    entityNumber,
    chainId,
    entityProviderAddress,
    boardEpoch,
    actionNonce: current.confirmedNonce + 1n,
    generation,
    createdAt: entityState.timestamp,
    payload,
  };
  const intent: EntityProviderActionIntent = {
    ...unsignedIntent,
    actionHash: recomputeEntityProviderActionHash(unsignedIntent),
  };
  const newState = cloneEntityState(entityState);
  newState.config = { ...newState.config, jurisdiction };
  newState.entityProviderActionState = {
    version: 1,
    confirmedNonce: current.confirmedNonce,
    generation,
    pending: intent,
  };
  addMessage(
    newState,
    `📤 EntityProvider ${intent.payload.kind} → hashesToSign [nonce=${intent.actionNonce.toString()}]`,
  );

  const actionTx: JTx = {
    type: intent.payload.kind === 'entityTransferTokens'
      ? 'entityProviderTransfer'
      : 'entityProviderReleaseControlShares',
    entityId: entityState.entityId,
    data: { intent, signerId },
    timestamp: newState.timestamp,
  };
  const jOutputs: JInput[] = [{ jurisdictionName: jurisdiction.name, jTxs: [actionTx] }];
  const hashesToSign: Array<{ hash: string; type: HashType; context: string }> = [{
    hash: intent.actionHash,
    type: 'entityProviderAction',
    context: `entityProviderAction:${entityState.entityId.slice(-4)}:${intent.payload.kind}:nonce:${intent.actionNonce.toString()}`,
  }];
  const outputs: EntityInput[] = [];
  return { newState, outputs, jOutputs, hashesToSign };
};

export const handleEntityProviderTransfer = (
  entityState: EntityState,
  entityTx: TransferTx,
  env: Env,
): EntityTxReducerResult => handleAction(entityState, entityTx, env);

export const handleEntityProviderReleaseControlShares = (
  entityState: EntityState,
  entityTx: ReleaseTx,
  env: Env,
): EntityTxReducerResult => handleAction(entityState, entityTx, env);

export const handleEntityProviderCancelAction = (
  entityState: EntityState,
  entityTx: CancelTx,
  env: Env,
): EntityTxReducerResult => {
  const configuredName = getJurisdictionConfigName(entityState.config.jurisdiction);
  if (!configuredName) throw new Error('ENTITY_PROVIDER_ACTION_JURISDICTION_MISSING');
  const jurisdiction = requireRuntimeJurisdictionConfigByName(
    env,
    configuredName,
    entityState.config.jurisdiction,
  );
  const chainId = BigInt(jurisdiction.chainId ?? 0);
  const entityProviderAddress = requireUsableContractAddress(
    'entity_provider',
    jurisdiction.entityProviderAddress,
  ).toLowerCase();
  const depositoryAddress = requireUsableContractAddress(
    'depository',
    jurisdiction.depositoryAddress,
  ).toLowerCase();
  const current = currentActionState(entityState);
  const boardEpoch = requireCertifiedBoardEpoch(entityState, env);
  const pending = current.pending;
  if (!pending) throw new Error('ENTITY_PROVIDER_ACTION_CANCEL_PENDING_MISSING');
  assertEntityProviderActionIntent(pending, {
    chainId,
    entityProviderAddress,
    depositoryAddress,
    entityId: entityState.entityId,
    boardEpoch,
  });
  if (pending.payload.kind === 'cancelPendingAction') {
    throw new Error(`ENTITY_PROVIDER_ACTION_CANCEL_ALREADY_PENDING:${pending.actionHash}`);
  }
  const requestedHash = String(entityTx.data.actionHash ?? '').trim().toLowerCase();
  if (requestedHash !== pending.actionHash.toLowerCase()) {
    throw new Error(
      `ENTITY_PROVIDER_ACTION_CANCEL_TARGET_MISMATCH:${requestedHash || 'missing'}:${pending.actionHash}`,
    );
  }
  if (pending.actionNonce !== current.confirmedNonce + 1n) {
    throw new Error(
      `ENTITY_PROVIDER_ACTION_PENDING_NONCE_CORRUPT:` +
      `${pending.actionNonce.toString()}:${(current.confirmedNonce + 1n).toString()}`,
    );
  }
  if (current.generation >= Number.MAX_SAFE_INTEGER) {
    throw new Error('ENTITY_PROVIDER_ACTION_GENERATION_EXHAUSTED');
  }
  const signerId = getEntityLeaderState(entityState).activeValidatorId;
  if (!signerId) throw new Error('ENTITY_PROVIDER_ACTION_SUBMITTER_MISSING');
  const generation = current.generation + 1;
  const unsignedIntent = {
    version: 1 as const,
    entityId: entityState.entityId.toLowerCase(),
    entityNumber: requireNumberedEntity(entityState.entityId),
    chainId,
    entityProviderAddress,
    boardEpoch,
    actionNonce: pending.actionNonce,
    generation,
    createdAt: entityState.timestamp,
    payload: {
      kind: 'cancelPendingAction' as const,
      cancel: {
        cancelledActionHash: pending.actionHash.toLowerCase(),
        cancelledActionKind: entityProviderActionKindCode(pending.payload.kind),
      },
    },
  };
  const intent: EntityProviderActionIntent = {
    ...unsignedIntent,
    actionHash: recomputeEntityProviderActionHash(unsignedIntent),
  };
  const newState = cloneEntityState(entityState);
  newState.config = { ...newState.config, jurisdiction };
  newState.entityProviderActionState = {
    version: 1,
    confirmedNonce: current.confirmedNonce,
    generation,
    pending: intent,
  };
  addMessage(
    newState,
    `🛑 EntityProvider cancel → hashesToSign [nonce=${intent.actionNonce.toString()}]`,
  );
  const actionTx: JTx = {
    type: 'entityProviderCancelAction',
    entityId: entityState.entityId,
    data: { intent, signerId },
    timestamp: newState.timestamp,
  };
  return {
    newState,
    outputs: [],
    jOutputs: [{ jurisdictionName: jurisdiction.name, jTxs: [actionTx] }],
    hashesToSign: [{
      hash: intent.actionHash,
      type: 'entityProviderAction',
      context: `entityProviderAction:${entityState.entityId.slice(-4)}:cancel:nonce:${intent.actionNonce.toString()}`,
    }],
  };
};
