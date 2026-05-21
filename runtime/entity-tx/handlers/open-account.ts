import { isLeftEntity } from '../../entity-id-utils';
import { announceLocalEntityProfile } from '../../networking/gossip-helper';
import { DEFAULT_HARD_LIMIT, DEFAULT_MAX_FEE, DEFAULT_SOFT_LIMIT } from '../../types';
import type { Delta, EntityInput, EntityState, EntityTx, Env } from '../../types';
import { formatEntityId } from '../../utils';
import { markStorageAccountDirty, markStorageEntityDirty } from '../../env-events';
import { upsertSortedStringMapEntry } from '../../sorted-index';
import { cloneEntityState, addMessage } from '../../state-helpers';
import { assertSameJurisdictionAccount } from '../../jurisdiction-runtime';
import { findAccountKey, normalizeEntityRef } from '../account-key';

type OpenAccountEntityTx = Extract<EntityTx, { type: 'openAccount' }>;

type OpenAccountResult = {
  newState: EntityState;
  outputs: EntityInput[];
};

const ENTITY_ID_HEX_32_RE = /^0x[0-9a-fA-F]{64}$/;
const isEntityId32 = (value: unknown): value is string => typeof value === 'string' && ENTITY_ID_HEX_32_RE.test(value);

const USD_SCALE = 10n ** 18n;
const toUsdWei = (value: number): bigint => BigInt(Math.max(0, Math.floor(value))) * USD_SCALE;

const resolveJurisdictionRebalanceDefaults = (
  entityState: EntityState,
): { r2cRequestSoftLimit: bigint; hardLimit: bigint; maxAcceptableFee: bigint } => {
  const raw = entityState.config?.jurisdiction?.rebalancePolicyUsd;
  if (!raw) {
    return {
      r2cRequestSoftLimit: DEFAULT_SOFT_LIMIT,
      hardLimit: DEFAULT_HARD_LIMIT,
      maxAcceptableFee: DEFAULT_MAX_FEE,
    };
  }
  const r2cRequestSoftLimit = toUsdWei(raw.r2cRequestSoftLimit);
  const hardLimit = toUsdWei(raw.hardLimit);
  const maxAcceptableFee = toUsdWei(raw.maxFee);
  if (r2cRequestSoftLimit <= 0n || hardLimit < r2cRequestSoftLimit) {
    return {
      r2cRequestSoftLimit: DEFAULT_SOFT_LIMIT,
      hardLimit: DEFAULT_HARD_LIMIT,
      maxAcceptableFee: DEFAULT_MAX_FEE,
    };
  }
  return { r2cRequestSoftLimit, hardLimit, maxAcceptableFee };
};

export const handleOpenAccountEntityTx = (
  env: Env,
  entityState: EntityState,
  entityTx: OpenAccountEntityTx,
): OpenAccountResult => {
  const targetEntityId = entityTx.data.targetEntityId;
  if (!isEntityId32(targetEntityId)) {
    throw new Error(
      `INVALID_ENTITY_ID: openAccount targetEntityId must be bytes32 hex, got "${String(targetEntityId)}"`,
    );
  }

  const counterpartyId = normalizeEntityRef(targetEntityId);
  const isLeft = isLeftEntity(entityState.entityId, targetEntityId);
  assertSameJurisdictionAccount(env, entityState.entityId, entityState.config?.jurisdiction, targetEntityId);

  if (findAccountKey(entityState, counterpartyId)) {
    const error =
      `OPEN_ACCOUNT_ALREADY_EXISTS: entity=${formatEntityId(entityState.entityId)} ` +
      `counterparty=${formatEntityId(counterpartyId)}`;
    console.error(`❌ ${error}`);
    throw new Error(error);
  }

  const newState = cloneEntityState(entityState);
  const outputs: EntityInput[] = [];

  addMessage(newState, `💳 Opening account with Entity ${formatEntityId(entityTx.data.targetEntityId)}...`);

  const existingAccountKey = findAccountKey(newState, counterpartyId);
  const createdLocalAccount = !existingAccountKey;
  const accountKey = existingAccountKey ?? counterpartyId;
  if (createdLocalAccount) {
    env.emit('AccountOpening', {
      entityId: entityState.entityId,
      counterpartyId: targetEntityId,
    });

    const initialDeltas = new Map<number, Delta>();
    const leftEntity = isLeft ? entityState.entityId : counterpartyId;
    const rightEntity = isLeft ? counterpartyId : entityState.entityId;

    upsertSortedStringMapEntry(newState.accounts, accountKey, {
      leftEntity,
      rightEntity,
      status: 'active',
      mempool: [],
      currentFrame: {
        height: 0,
        timestamp: 0,
        jHeight: 0,
        accountTxs: [],
        prevFrameHash: '',
        deltas: [],
        stateHash: '',
        byLeft: isLeft,
      },
      deltas: initialDeltas,
      globalCreditLimits: {
        ownLimit: 0n,
        peerLimit: 0n,
      },
      currentHeight: 0,
      pendingSignatures: [],
      rollbackCount: 0,
      proofHeader: {
        fromEntity: entityState.entityId,
        toEntity: counterpartyId,
        nonce: 1,
      },
      proofBody: { tokenIds: [], deltas: [] },
      disputeConfig: {
        leftDisputeDelay: 576,
        rightDisputeDelay: 576,
      },
      pendingWithdrawals: new Map(),
      requestedRebalance: new Map(),
      requestedRebalanceFeeState: new Map(),
      rebalancePolicy: new Map(),
      locks: new Map(),
      swapOffers: new Map(),
      pulls: new Map(),
      swapOrderHistory: new Map(),
      swapClosedOrders: new Map(),
      leftJObservations: [],
      rightJObservations: [],
      jEventChain: [],
      lastFinalizedJHeight: 0,
      onChainSettlementNonce: 0,
    });
    markStorageAccountDirty(env, newState.entityId, counterpartyId);
    markStorageEntityDirty(env, newState.entityId);
  }

  const localAccount = newState.accounts.get(accountKey);
  if (!localAccount) {
    throw new Error(`CRITICAL: Account machine not found after creation`);
  }

  const tokenId = entityTx.data.tokenId ?? 1;
  const creditAmount = entityTx.data.creditAmount;

  if (!createdLocalAccount) {
    throw new Error(
      `OPEN_ACCOUNT_ALREADY_EXISTS_AFTER_CLONE: entity=${formatEntityId(entityState.entityId)} ` +
      `counterparty=${formatEntityId(counterpartyId)}`,
    );
  }

  localAccount.mempool.push({ type: 'add_delta', data: { tokenId } });
  if (creditAmount && creditAmount > 0n) {
    localAccount.mempool.push({ type: 'set_credit_limit', data: { tokenId, amount: creditAmount } });
  }

  const requestedPolicy = entityTx.data.rebalancePolicy;
  const jurisdictionPolicyDefaults = resolveJurisdictionRebalanceDefaults(newState);
  let autopilotSoftLimit = requestedPolicy?.r2cRequestSoftLimit ?? jurisdictionPolicyDefaults.r2cRequestSoftLimit;
  let autopilotHardLimit = requestedPolicy?.hardLimit ?? jurisdictionPolicyDefaults.hardLimit;
  let autopilotMaxFee = requestedPolicy?.maxAcceptableFee ?? jurisdictionPolicyDefaults.maxAcceptableFee;
  if (autopilotSoftLimit <= 0n) autopilotSoftLimit = jurisdictionPolicyDefaults.r2cRequestSoftLimit;
  if (autopilotHardLimit < autopilotSoftLimit) autopilotHardLimit = autopilotSoftLimit;
  if (autopilotMaxFee < 0n) autopilotMaxFee = jurisdictionPolicyDefaults.maxAcceptableFee;
  localAccount.rebalancePolicy.set(tokenId, {
    r2cRequestSoftLimit: autopilotSoftLimit,
    hardLimit: autopilotHardLimit,
    maxAcceptableFee: autopilotMaxFee,
  });
  localAccount.mempool.push({
    type: 'set_rebalance_policy',
    data: {
      tokenId,
      r2cRequestSoftLimit: autopilotSoftLimit,
      hardLimit: autopilotHardLimit,
      maxAcceptableFee: autopilotMaxFee,
    },
  });

  addMessage(newState, `✅ Account opening request sent to Entity ${formatEntityId(counterpartyId)}`);

  if (env.gossip) {
    announceLocalEntityProfile(env, newState, env.timestamp);
  }

  return { newState, outputs };
};
