import { isLeftEntity } from '../../../../id';
import { isValidEntityId } from '../../../../../protocol/identity';
import type { Delta, HtlcLock, PullCommitment, SwapOffer } from '../../../../../types/account';
import type { RebalanceRequestFeeState } from '../../../../../types/finance/rebalance';
import {
  PersistentAccountStateMap,
  requirePersistentAccountStateMap,
} from '../../../../../account/state/persistent-state-map';
import type { EntityCandidateEffect, EntityInput, EntityState } from '../../../../types';
import type { AccountConsensusContext } from '../../../../../account/consensus/context';
import type { EntityTx } from '../../../../../types/entity-tx';
import { getEntityAccountForWrite, putEntityAccountCandidate } from '../../../../state/persistent-account-map';
import { prepareEntityTxState } from '../../../../state-clone';
import { addMessage } from '../../../../frame-events';
import { findAccountKey, normalizeEntityRef } from '../../../account-key';
import { DEFAULT_ACCOUNT_TOKEN_IDS } from '../../../../../account/config/defaults';
import { normalizeAccountWatchSeed } from '../../../../../protocol/identity/account-watch-seed';
import { createStructuredLogger, shortId } from '../../../../../support/logger';
import {
  accountStateDomainFromJurisdiction,
  computeAccountStateRoot,
  EMPTY_ACCOUNT_STATE_ROOT,
  normalizeAccountStateDomain,
  sameAccountStateDomain,
} from '../../../../../account/commitment/state-root';
import { applyAccountInput } from '../../../../../account/consensus';
import { createLocalAccountInput } from '../../../../../account/input';
import { createEmptyAccountJClaimAccumulator } from '../../../../../account/j-claims/j-claim-accumulator';
import { MAX_PROFILE_ADVERTISED_ACCOUNTS } from '../../../../profile/profile-descriptor';
import { resolveJurisdictionRebalanceDefaults } from '../../../../../account/config/defaults';
import { buildHubRebalancePolicyTx } from './admin';
import { canonicalAccountDisputeConfig } from '../../../../../account/config/dispute-config';

type OpenAccountEntityTx = Extract<EntityTx, { type: 'openAccount' }>;

type OpenAccountResult = {
  newState: EntityState;
  outputs: EntityInput[];
  accountChanges: string[];
};

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
  disputeConfig: ReturnType<typeof canonicalAccountDisputeConfig>,
  candidateEffects: EntityCandidateEffect[],
  publicPinned: boolean,
): void => {
  candidateEffects.push({
    kind: 'runtimeEvent',
    eventName: 'AccountOpening',
    data: { entityId: originalEntityId, counterpartyId },
  });
  const leftEntity = isLeft ? originalEntityId : counterpartyId;
  const rightEntity = isLeft ? counterpartyId : originalEntityId;
  putEntityAccountCandidate(state.accounts, counterpartyId, {
    state: {
      leftEntity,
      rightEntity,
      domain: accountDomain,
      watchSeed,
      deltas: PersistentAccountStateMap.empty<number, Delta>('deltas'),
      locks: PersistentAccountStateMap.empty<string, HtlcLock>('locks'),
      swapOffers: PersistentAccountStateMap.empty<string, SwapOffer>('swapOffers'),
      pulls: PersistentAccountStateMap.empty<string, PullCommitment>('pulls'),
      leftPendingJClaims: createEmptyAccountJClaimAccumulator(),
      rightPendingJClaims: createEmptyAccountJClaimAccumulator(),
      lastFinalizedJHeight: 0,
      disputeConfig,
      jNonce: 0,
      requestedRebalance: PersistentAccountStateMap.empty<number, bigint>('requestedRebalance'),
      requestedRebalanceFeeState: PersistentAccountStateMap.empty<number, RebalanceRequestFeeState>('requestedRebalanceFeeState'),
    },
    status: 'active',
    ...(publicPinned ? { publicPinned: true } : {}),
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
    currentHeight: 0,
    rollbackCount: 0,
    proofHeader: { fromEntity: originalEntityId, toEntity: counterpartyId, nextProofNonce: 1 },
    pendingWithdrawals: PersistentAccountStateMap.empty('pendingWithdrawals'),
    shadow: {
      rebalance: {
        policy: PersistentAccountStateMap.empty('rebalanceShadowPolicy'),
        submittedAtByToken: PersistentAccountStateMap.empty('rebalanceShadowSubmitted'),
      },
    },
  });
};

/**
 * An Account is advertised only by the side that opened it, and only while the
 * Entity is under the Profile's advertised-account ceiling. Reaching the
 * ceiling must not fail the open: an Entity may hold far more Accounts than it
 * can route through, so the surplus is simply opened unadvertised.
 */
const resolveOpenAccountPublicPin = (
  state: EntityState,
  tx: OpenAccountEntityTx,
): boolean => {
  if (tx.data.pinPublic === false) return false;
  let pinned = 0;
  for (const account of state.accounts.values()) {
    if (account.publicPinned === true) pinned += 1;
    if (pinned >= MAX_PROFILE_ADVERTISED_ACCOUNTS) return false;
  }
  return true;
};

const seedOpenAccountPolicies = async (
  accountConsensusContext: AccountConsensusContext,
  state: EntityState,
  tx: OpenAccountEntityTx,
  counterpartyId: string,
): Promise<void> => {
  const account = getEntityAccountForWrite(state.accounts, counterpartyId);
  if (!account) throw new Error('OPEN_ACCOUNT_CREATED_MACHINE_MISSING');
  // H=0 is local genesis state, not a signed bilateral Account frame.
  // Keep its stateHash empty: only an accepted frame H>=1 has a frame hash.
  // accountStateRoot still commits the complete live Account state and becomes
  // the starting root for the first proposal. Treating that root as a frame
  // hash invents evidence neither peer signed and breaks strict WAL replay.
  account.currentFrame.accountStateRoot = computeAccountStateRoot(account.state);
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
    accountConsensusContext,
    account,
    createLocalAccountInput(account.state, state.entityId, initialAccountTxs),
  );
  if (!admission.ok || admission.admittedAccountTxCount !== initialAccountTxs.length) {
    throw new Error(`OPEN_ACCOUNT_INITIAL_TXS_NOT_ADMITTED:${counterpartyId}`);
  }
  if (tx.data.rebalancePolicy) assertRequestedRebalancePolicy(tokenId, tx.data.rebalancePolicy);
  for (const policyTokenId of tokenIds) {
    const policy = tx.data.rebalancePolicy && policyTokenId === tokenId
      ? tx.data.rebalancePolicy
      : resolveJurisdictionRebalanceDefaults(state.config.jurisdiction, policyTokenId);
    account.shadow.rebalance.policy = requirePersistentAccountStateMap(
      account.shadow.rebalance.policy,
      'rebalanceShadowPolicy',
    ).updated(policyTokenId, { ...policy });
  }
};

export const handleOpenAccountEntityTx = async (
  entityState: EntityState,
  entityTx: OpenAccountEntityTx,
  accountConsensusContext: AccountConsensusContext,
  candidateEffects: EntityCandidateEffect[] = [],
  mutableFrameState = false,
): Promise<OpenAccountResult> => {
  const targetEntityId = entityTx.data.targetEntityId;
  if (!isValidEntityId(targetEntityId)) {
    throw new Error(
      `INVALID_ENTITY_ID: openAccount targetEntityId must be bytes32 hex, got "${String(targetEntityId)}"`,
    );
  }

  const counterpartyId = normalizeEntityRef(targetEntityId);
  const isLeft = isLeftEntity(entityState.entityId, targetEntityId);
  if (entityTx.data.watchSeed === undefined) throw new Error('OPEN_ACCOUNT_WATCH_SEED_REQUIRED');
  const watchSeed = normalizeAccountWatchSeed(entityTx.data.watchSeed, 'OPEN_ACCOUNT');
  const disputeConfig = canonicalAccountDisputeConfig(entityTx.data.disputeConfig);
  if (entityTx.data.accountDomain === undefined) throw new Error('OPEN_ACCOUNT_DOMAIN_REQUIRED');
  const accountDomain = normalizeAccountStateDomain(entityTx.data.accountDomain, 'OPEN_ACCOUNT_DOMAIN');
  const jurisdiction = entityState.config?.jurisdiction;
  if (!jurisdiction) throw new Error(`ACCOUNT_STATE_DOMAIN_MISSING: entity=${entityState.entityId}`);
  if (!sameAccountStateDomain(accountDomain, accountStateDomainFromJurisdiction(jurisdiction))) {
    throw new Error('OPEN_ACCOUNT_DOMAIN_MISMATCH');
  }

  if (findAccountKey(entityState, counterpartyId)) {
    const error =
      `OPEN_ACCOUNT_ALREADY_EXISTS: entity=${entityState.entityId} ` +
      `counterparty=${counterpartyId}`;
    openAccountLog.error('already_exists', {
      entity: shortId(entityState.entityId),
      counterparty: shortId(counterpartyId),
    });
    throw new Error(error);
  }
  const newState = prepareEntityTxState(entityState, mutableFrameState);
  const outputs: EntityInput[] = [];

  addMessage(newState, `💳 Opening account with Entity ${entityTx.data.targetEntityId}...`);

  if (findAccountKey(newState, counterpartyId)) {
    throw new Error(
      `OPEN_ACCOUNT_ALREADY_EXISTS_AFTER_CLONE: entity=${entityState.entityId} ` +
      `counterparty=${counterpartyId}`,
    );
  }
  insertLocalAccount(
    newState,
    entityState.entityId,
    counterpartyId,
    isLeft,
    accountDomain,
    watchSeed,
    disputeConfig,
    candidateEffects,
    resolveOpenAccountPublicPin(newState, entityTx),
  );
  await seedOpenAccountPolicies(accountConsensusContext, newState, entityTx, counterpartyId);

  addMessage(newState, `✅ Account opening request sent to Entity ${counterpartyId}`);

  return { newState, outputs, accountChanges: [counterpartyId] };
};
