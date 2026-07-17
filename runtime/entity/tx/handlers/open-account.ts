import { isLeftEntity } from '../../id';
import type { Delta, EntityInput, EntityState, EntityTx, Env } from '../../../types';
import { scaleWholeTokenAmount } from '../../../types';
import { formatEntityId } from '../../../utils';
import { markStorageAccountDirty, markStorageEntityDirty } from '../../../machine/env-events';
import { upsertSortedStringMapEntry } from '../../../storage/sorted-index';
import { cloneEntityState, addMessage } from '../../../state-helpers';
import { findAccountKey, normalizeEntityRef } from '../account-key';
import { DEFAULT_ACCOUNT_TOKEN_IDS } from '../../../account/default-tokens';
import { normalizeAccountWatchSeed } from '../../../account/watch-seed';
import { createStructuredLogger, shortId } from '../../../infra/logger';
import {
  accountStateDomainFromJurisdiction,
  computeAccountStateRoot,
  EMPTY_ACCOUNT_STATE_ROOT,
  normalizeAccountStateDomain,
  sameAccountStateDomain,
} from '../../../account/state-root';
import { appendAccountMempoolTxs } from '../../../account/mempool';
import { assertEntityAccountInsertionCapacity } from '../../account-capacity';
import { createEmptyAccountJClaimAccumulator } from '../../../account/j-claim-accumulator';
import { getDefaultRebalancePolicyForToken } from '../../../account/rebalance-defaults';
import { getTokenInfo } from '../../../account/utils';
import { buildHubRebalancePolicyTx } from './account-admin';

type OpenAccountEntityTx = Extract<EntityTx, { type: 'openAccount' }>;

type OpenAccountResult = {
  newState: EntityState;
  outputs: EntityInput[];
};

const ENTITY_ID_HEX_32_RE = /^0x[0-9a-fA-F]{64}$/;
const isEntityId32 = (value: unknown): value is string => typeof value === 'string' && ENTITY_ID_HEX_32_RE.test(value);
const openAccountLog = createStructuredLogger('account.open');

const scaleWholePolicyAmount = (tokenId: number, value: number): bigint => {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`REBALANCE_POLICY_USD_INVALID:token=${tokenId}:value=${String(value)}`);
  }
  return scaleWholeTokenAmount(BigInt(Math.floor(value)), getTokenInfo(tokenId).decimals);
};

const resolveJurisdictionRebalanceDefaults = (
  entityState: EntityState,
  tokenId: number,
): { r2cRequestSoftLimit: bigint; hardLimit: bigint; maxAcceptableFee: bigint } => {
  const raw = entityState.config?.jurisdiction?.rebalancePolicyUsd;
  if (!raw) return getDefaultRebalancePolicyForToken(tokenId);
  const r2cRequestSoftLimit = scaleWholePolicyAmount(tokenId, raw.r2cRequestSoftLimit);
  const hardLimit = scaleWholePolicyAmount(tokenId, raw.hardLimit);
  const maxAcceptableFee = scaleWholePolicyAmount(tokenId, raw.maxFee);
  if (r2cRequestSoftLimit <= 0n || hardLimit < r2cRequestSoftLimit) {
    throw new Error(`REBALANCE_POLICY_USD_INVALID:token=${tokenId}`);
  }
  return { r2cRequestSoftLimit, hardLimit, maxAcceptableFee };
};

const assertRequestedRebalancePolicy = (
  tokenId: number,
  policy: NonNullable<OpenAccountEntityTx['data']['rebalancePolicy']>,
): void => {
  if (
    policy.r2cRequestSoftLimit <= 0n ||
    policy.hardLimit < policy.r2cRequestSoftLimit ||
    policy.maxAcceptableFee < 0n
  ) {
    throw new Error(`REBALANCE_POLICY_INVALID:token=${tokenId}`);
  }
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
  if (entityTx.data.watchSeed === undefined) throw new Error('OPEN_ACCOUNT_WATCH_SEED_REQUIRED');
  const watchSeed = normalizeAccountWatchSeed(entityTx.data.watchSeed, 'OPEN_ACCOUNT');
  if (entityTx.data.accountDomain === undefined) throw new Error('OPEN_ACCOUNT_DOMAIN_REQUIRED');
  const accountDomain = normalizeAccountStateDomain(entityTx.data.accountDomain, 'OPEN_ACCOUNT_DOMAIN');
  const jurisdiction = entityState.config?.jurisdiction;
  if (!jurisdiction) throw new Error(`ACCOUNT_STATE_DOMAIN_MISSING: entity=${formatEntityId(entityState.entityId)}`);
  if (!sameAccountStateDomain(accountDomain, accountStateDomainFromJurisdiction(jurisdiction))) {
    throw new Error('OPEN_ACCOUNT_DOMAIN_MISMATCH');
  }

  if (findAccountKey(entityState, counterpartyId)) {
    const error =
      `OPEN_ACCOUNT_ALREADY_EXISTS: entity=${formatEntityId(entityState.entityId)} ` +
      `counterparty=${formatEntityId(counterpartyId)}`;
    openAccountLog.error('already_exists', {
      entity: shortId(entityState.entityId),
      counterparty: shortId(counterpartyId),
    });
    throw new Error(error);
  }
  assertEntityAccountInsertionCapacity(
    entityState.accounts,
    counterpartyId,
    `openAccount:${entityState.entityId}`,
  );

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
      domain: accountDomain,
      watchSeed,
      status: 'active',
      mempool: [],
      currentFrame: {
        height: 0,
        timestamp: 0,
        jHeight: 0,
        accountTxs: [],
        prevFrameHash: '',
        accountStateRoot: EMPTY_ACCOUNT_STATE_ROOT,
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
        nextProofNonce: 1,
      },
      proofBody: { tokenIds: [], deltas: [] },
      disputeConfig: {
        leftDisputeDelay: 576,
        rightDisputeDelay: 576,
      },
      pendingWithdrawals: new Map(),
      requestedRebalance: new Map(),
      requestedRebalanceFeeState: new Map(),
      shadow: {
        rebalance: {
          policy: new Map(),
          submittedAtByToken: new Map(),
        },
      },
      locks: new Map(),
      swapOffers: new Map(),
      pulls: new Map(),
      swapOrderHistory: new Map(),
      swapClosedOrders: new Map(),
      leftPendingJClaims: createEmptyAccountJClaimAccumulator(),
      rightPendingJClaims: createEmptyAccountJClaimAccumulator(),
      lastFinalizedJHeight: 0,
      jNonce: 0,
    });
    markStorageAccountDirty(env, newState.entityId, counterpartyId);
    markStorageEntityDirty(env, newState.entityId);
  }

  const localAccount = newState.accounts.get(accountKey);
  if (!localAccount) {
    throw new Error(`CRITICAL: Account machine not found after creation`);
  }
  localAccount.currentFrame.accountStateRoot = computeAccountStateRoot(localAccount);
  localAccount.currentFrame.stateHash = localAccount.currentFrame.accountStateRoot;

  const tokenId = entityTx.data.tokenId ?? 1;
  const defaultTokenIds = Array.from(new Set([tokenId, ...DEFAULT_ACCOUNT_TOKEN_IDS]))
    .filter((id) => Number.isFinite(id) && id > 0);
  const creditAmount = entityTx.data.creditAmount;

  if (!createdLocalAccount) {
    throw new Error(
      `OPEN_ACCOUNT_ALREADY_EXISTS_AFTER_CLONE: entity=${formatEntityId(entityState.entityId)} ` +
      `counterparty=${formatEntityId(counterpartyId)}`,
    );
  }

  appendAccountMempoolTxs(localAccount, [
    ...defaultTokenIds.map((deltaTokenId) => ({
      type: 'add_delta' as const,
      data: { tokenId: deltaTokenId },
    })),
    ...(newState.hubRebalanceConfig
      ? defaultTokenIds.map((policyTokenId) =>
          buildHubRebalancePolicyTx(newState.hubRebalanceConfig!, policyTokenId))
      : []),
    ...(creditAmount && creditAmount > 0n
      ? [{ type: 'set_credit_limit' as const, data: { tokenId, amount: creditAmount } }]
      : []),
  ], `openAccount:init:${entityState.entityId}:${counterpartyId}`);

  const requestedPolicy = entityTx.data.rebalancePolicy;
  if (requestedPolicy) assertRequestedRebalancePolicy(tokenId, requestedPolicy);
  for (const policyTokenId of defaultTokenIds) {
    const policy = requestedPolicy && policyTokenId === tokenId
      ? requestedPolicy
      : resolveJurisdictionRebalanceDefaults(newState, policyTokenId);
    localAccount.shadow.rebalance.policy.set(policyTokenId, { ...policy });
  }

  addMessage(newState, `✅ Account opening request sent to Entity ${formatEntityId(counterpartyId)}`);

  return { newState, outputs };
};
