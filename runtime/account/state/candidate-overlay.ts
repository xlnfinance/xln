/** Evictable Account transition draft keyed by committed root and ordered input bytes. */

import type { AccountReplica } from '../../types/account';
import { computeIntegrityDigest } from '../../infra/integrity-checksum';
import { encodeCanonicalConsensusValue } from '../../protocol/serialization/canonical-consensus-value';
import {
  createAccountPairKey,
  toEntityId,
  type AccountPairKey,
  type EntityId,
} from '../../protocol/identity';
import {
  toEvidenceHash,
  toStateHash,
  type EvidenceHash,
  type StateHash,
} from '../../protocol/hashes';
import { computeAccountStateRoot } from '../commitment/state-root';
import {
  beginAccountStateDraft,
  discardAccountStateDraft,
  prepareAccountStateDraft,
  type AccountStateDraftNodeChanges,
  type AccountDraftReplica,
  type AccountStateDraftOwner,
} from './account-state-draft';

export type AccountTransitionKey = Readonly<{
  entityId: EntityId;
  accountId: AccountPairKey;
  baseRoot: StateHash;
  orderedInputPrefixHash: EvidenceHash;
}>;

export type AccountTransitionCommit = Readonly<{
  account: AccountReplica;
  accountStateRoot: StateHash;
  cacheKey: EvidenceHash;
  nodeChanges: AccountStateDraftNodeChanges;
}>;

export const countAccountTransitionNodeChanges = (
  changes: AccountStateDraftNodeChanges,
): number =>
  changes.deltas.puts.length + changes.deltas.dels.length
  + changes.locks.puts.length + changes.locks.dels.length
  + changes.swapOffers.puts.length + changes.swapOffers.dels.length
  + changes.pulls.puts.length + changes.pulls.dels.length
  + changes.subcontracts.puts.length + changes.subcontracts.dels.length
  + changes.lendingIntents.puts.length + changes.lendingIntents.dels.length
  + changes.requestedRebalance.puts.length + changes.requestedRebalance.dels.length
  + changes.requestedRebalanceFeeState.puts.length + changes.requestedRebalanceFeeState.dels.length
  + changes.rebalanceFeePolicies.puts.length + changes.rebalanceFeePolicies.dels.length
  + changes.pendingWithdrawals.puts.length + changes.pendingWithdrawals.dels.length
  + changes.rebalanceShadowPolicy.puts.length + changes.rebalanceShadowPolicy.dels.length
  + changes.rebalanceShadowSubmitted.puts.length + changes.rebalanceShadowSubmitted.dels.length;

type OverlayStatus = 'active' | 'committed' | 'discarded';
export class AccountTransitionOverlay {
  readonly cacheKey: EvidenceHash;
  readonly lifecycle: { status: OverlayStatus };
  readonly stateDraft: AccountStateDraftOwner;

  constructor(
    readonly base: AccountReplica,
    readonly key: AccountTransitionKey,
  ) {
    this.lifecycle = { status: 'active' };
    this.stateDraft = beginAccountStateDraft(base);
    this.cacheKey = transitionCacheKey(key);
  }
}
const UTF8 = new TextEncoder();
const orderedInputHash = (orderedInputPrefix: unknown): EvidenceHash =>
  toEvidenceHash(computeIntegrityDigest(UTF8.encode(encodeCanonicalConsensusValue({
    domain: 'xln.account.transition-input.v1',
    orderedInputPrefix,
  }))));

const transitionCacheKey = (key: AccountTransitionKey): EvidenceHash =>
  toEvidenceHash(computeIntegrityDigest(UTF8.encode(encodeCanonicalConsensusValue({
    domain: 'xln.account.transition-cache.v1',
    entityId: key.entityId,
    accountId: key.accountId,
    baseRoot: key.baseRoot,
    orderedInputPrefixHash: key.orderedInputPrefixHash,
  }))));

const counterpartyForOwner = (account: AccountReplica, owner: EntityId): EntityId => {
  const left = toEntityId(account.state.leftEntity.toLowerCase());
  const right = toEntityId(account.state.rightEntity.toLowerCase());
  if (owner === left) return right;
  if (owner === right) return left;
  throw new Error(`ACCOUNT_TRANSITION_OWNER_MISMATCH:${owner}:${left}:${right}`);
};

export const createAccountTransitionKey = (
  account: AccountReplica,
  orderedInputPrefix: unknown,
): AccountTransitionKey => {
  const entityId = toEntityId(account.proofHeader.fromEntity.toLowerCase());
  const counterparty = counterpartyForOwner(account, entityId);
  return {
    entityId,
    accountId: createAccountPairKey(entityId, counterparty),
    baseRoot: toStateHash(computeAccountStateRoot(account.state)),
    orderedInputPrefixHash: orderedInputHash(orderedInputPrefix),
  };
};

const requireActive = (overlay: AccountTransitionOverlay): void => {
  if (overlay.lifecycle.status !== 'active') {
    throw new Error(`ACCOUNT_TRANSITION_OVERLAY_NOT_ACTIVE:${overlay.lifecycle.status}`);
  }
};

const requireExactBase = (base: AccountReplica, key: AccountTransitionKey): void => {
  const owner = toEntityId(base.proofHeader.fromEntity.toLowerCase());
  const counterparty = counterpartyForOwner(base, owner);
  const accountId = createAccountPairKey(owner, counterparty);
  if (owner !== key.entityId || accountId !== key.accountId) {
    throw new Error(`ACCOUNT_TRANSITION_IDENTITY_MISMATCH:${key.entityId}:${key.accountId}`);
  }
  const actualRoot = toStateHash(computeAccountStateRoot(base.state));
  if (actualRoot !== key.baseRoot) {
    throw new Error(`ACCOUNT_TRANSITION_BASE_ROOT_MISMATCH:${key.baseRoot}:${actualRoot}`);
  }
};

export const beginAccountTransition = (
  base: AccountReplica,
  key: AccountTransitionKey,
): AccountTransitionOverlay => {
  requireExactBase(base, key);
  return new AccountTransitionOverlay(base, key);
};

export const accountTransitionView = (overlay: AccountTransitionOverlay): AccountDraftReplica => {
  requireActive(overlay);
  return overlay.stateDraft.draft;
};

export const commitAccountTransition = (
  overlay: AccountTransitionOverlay,
): AccountTransitionCommit => {
  requireActive(overlay);
  const prepared = prepareAccountStateDraft(overlay.stateDraft, overlay.stateDraft.draft);
  const account = prepared.account;
  const accountStateRoot = toStateHash(computeAccountStateRoot(account.state));
  overlay.lifecycle.status = 'committed';
  return {
    account,
    accountStateRoot,
    cacheKey: overlay.cacheKey,
    nodeChanges: prepared.nodeChanges,
  };
};

export const discardAccountTransition = (overlay: AccountTransitionOverlay): void => {
  if (overlay.lifecycle.status === 'discarded') return;
  if (overlay.lifecycle.status === 'committed') throw new Error('ACCOUNT_TRANSITION_ALREADY_COMMITTED');
  discardAccountStateDraft(overlay.stateDraft);
  overlay.lifecycle.status = 'discarded';
};
