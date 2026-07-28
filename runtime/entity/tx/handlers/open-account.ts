import { isLeftEntity } from '../../id';
import type {
  Delta,
  EntityCandidateEffect,
  EntityInput,
  EntityState,
  EntityTx,
  RuntimeState,
} from '../../../types';
import { formatEntityId } from '../../../utils';
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
import { applyAccountInput } from '../../../account/consensus';
import { createLocalAccountInput } from '../../../account/input';
import { assertEntityAccountInsertionCapacity } from '../../account-capacity';
import { createEmptyAccountJClaimAccumulator } from '../../../account/j-claim-accumulator';
import { resolveJurisdictionRebalanceDefaults } from '../../../account/rebalance-policy-defaults';
import { buildHubRebalancePolicyTx } from './account-admin';

type OpenAccountEntityTx = Extract<EntityTx, { type: 'openAccount' }>;

type OpenAccountResult = {
  newState: EntityState;
  outputs: EntityInput[];
  accountChanges: string[];
};

const ENTITY_ID_HEX_32_RE = /^0x[0-9a-fA-F]{64}$/;
const isEntityId32 = (value: unknown): value is string => typeof value === 'string' && ENTITY_ID_HEX_32_RE.test(value);
const openAccountLog = createStructuredLogger('account.open');

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

const insertLocalAccount = (
  state: EntityState,
  originalEntityId: string,
  counterpartyId: string,
  isLeft: boolean,
  accountDomain: ReturnType<typeof normalizeAccountStateDomain>,
  watchSeed: ReturnType<typeof normalizeAccountWatchSeed>,
  candidateEffects: EntityCandidateEffect[],
): void => {
  candidateEffects.push({
    kind: 'runtimeEvent',
    eventName: 'AccountOpening',
    data: { entityId: originalEntityId, counterpartyId },
  });
  const leftEntity = isLeft ? originalEntityId : counterpartyId;
  const rightEntity = isLeft ? counterpartyId : originalEntityId;
  upsertSortedStringMapEntry(state.accounts, counterpartyId, {
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
    deltas: new Map<number, Delta>(),
    globalCreditLimits: { ownLimit: 0n, peerLimit: 0n },
    currentHeight: 0,
    pendingSignatures: [],
    rollbackCount: 0,
    proofHeader: { fromEntity: originalEntityId, toEntity: counterpartyId, nextProofNonce: 1 },
    proofBody: { tokenIds: [], deltas: [] },
    disputeConfig: { leftDisputeDelay: 576, rightDisputeDelay: 576 },
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
};

const seedOpenAccountPolicies = async (
  env: RuntimeState,
  state: EntityState,
  tx: OpenAccountEntityTx,
  counterpartyId: string,
): Promise<void> => {
  const account = state.accounts.get(counterpartyId);
  if (!account) throw new Error('OPEN_ACCOUNT_CREATED_MACHINE_MISSING');
  account.currentFrame.accountStateRoot = computeAccountStateRoot(account);
  account.currentFrame.stateHash = account.currentFrame.accountStateRoot;
  const tokenId = tx.data.tokenId ?? 1;
  const tokenIds = Array.from(new Set([tokenId, ...DEFAULT_ACCOUNT_TOKEN_IDS]))
    .filter(id => Number.isFinite(id) && id > 0);
  const initialAccountTxs = [
    ...tokenIds.map(deltaTokenId => ({
      type: 'add_delta' as const,
      data: { tokenId: deltaTokenId },
    })),
    ...(state.hubRebalanceConfig
      ? tokenIds.map(policyTokenId => buildHubRebalancePolicyTx(state.hubRebalanceConfig!, policyTokenId))
      : []),
    ...(tx.data.creditAmount && tx.data.creditAmount > 0n
      ? [{ type: 'set_credit_limit' as const, data: { tokenId, amount: tx.data.creditAmount } }]
      : []),
  ];
  const admission = await applyAccountInput(
    env,
    account,
    createLocalAccountInput(account, state.entityId, initialAccountTxs),
  );
  if (admission.admittedAccountTxCount !== initialAccountTxs.length) {
    throw new Error(`OPEN_ACCOUNT_INITIAL_TXS_NOT_ADMITTED:${counterpartyId}`);
  }
  if (tx.data.rebalancePolicy) assertRequestedRebalancePolicy(tokenId, tx.data.rebalancePolicy);
  for (const policyTokenId of tokenIds) {
    const policy = tx.data.rebalancePolicy && policyTokenId === tokenId
      ? tx.data.rebalancePolicy
      : resolveJurisdictionRebalanceDefaults(state, policyTokenId);
    account.shadow.rebalance.policy.set(policyTokenId, { ...policy });
  }
};

export const handleOpenAccountEntityTx = async (
  env: RuntimeState,
  entityState: EntityState,
  entityTx: OpenAccountEntityTx,
  candidateEffects: EntityCandidateEffect[] = [],
): Promise<OpenAccountResult> => {
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

  if (findAccountKey(newState, counterpartyId)) {
    throw new Error(
      `OPEN_ACCOUNT_ALREADY_EXISTS_AFTER_CLONE: entity=${formatEntityId(entityState.entityId)} ` +
      `counterparty=${formatEntityId(counterpartyId)}`,
    );
  }
  insertLocalAccount(
    newState,
    entityState.entityId,
    counterpartyId,
    isLeft,
    accountDomain,
    watchSeed,
    candidateEffects,
  );
  await seedOpenAccountPolicies(env, newState, entityTx, counterpartyId);

  addMessage(newState, `✅ Account opening request sent to Entity ${formatEntityId(counterpartyId)}`);

  return { newState, outputs, accountChanges: [counterpartyId] };
};
