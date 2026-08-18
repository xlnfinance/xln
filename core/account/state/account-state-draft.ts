/**
 * Account aggregate draft: one owner per growing Patricia collection.
 * The replica shell is bounded; collection values remain structural shares.
 * Human-audit importance: 100/100 — Account handlers mutate only this view.
 */
import type {
  AccountLendingIntentKind,
  AccountReplica,
  AccountState,
  AccountSubcontract,
  Delta,
  HtlcLock,
  PullCommitment,
  SwapOffer,
} from '../../types/account';
import type {
  BilateralRebalanceFeePolicy,
  RebalancePolicy,
  RebalanceRequestFeeState,
} from '../../types/finance/rebalance';
import {
  beginAccountCollectionOverlay,
  discardAccountCollectionOverlay,
  prepareAccountCollectionOverlay,
  type AccountCollectionDraft,
  type AccountCollectionOverlayOwner,
  type PreparedAccountCollection,
} from './account-overlay-map';
import { isAccountCollectionDraft } from './account-overlay-map';
import { forkAccountReplicaShell } from './account-replica-shell';
import {
  PersistentAccountStateMap,
  type AccountStateCollection,
} from './persistent-state-map';

type DraftCollectionNames =
  | 'deltas'
  | 'locks'
  | 'swapOffers'
  | 'pulls'
  | 'subcontracts'
  | 'lendingIntents'
  | 'requestedRebalance'
  | 'requestedRebalanceFeeState'
  | 'rebalanceFeePolicies'
  | 'pendingWithdrawals'
  | 'rebalanceShadowPolicy'
  | 'rebalanceShadowSubmitted';

export type AccountDraftState = Omit<AccountState, DraftCollectionNames> & {
  deltas: AccountCollectionDraft<number, Delta>;
  locks: AccountCollectionDraft<string, HtlcLock>;
  swapOffers: AccountCollectionDraft<string, SwapOffer>;
  pulls: AccountCollectionDraft<string, PullCommitment>;
  subcontracts: AccountCollectionDraft<string, AccountSubcontract>;
  lendingIntents: AccountCollectionDraft<string, AccountLendingIntentKind>;
  requestedRebalance: AccountCollectionDraft<number, bigint>;
  requestedRebalanceFeeState: AccountCollectionDraft<number, RebalanceRequestFeeState>;
  rebalanceFeePolicies: AccountCollectionDraft<number, BilateralRebalanceFeePolicy>;
};

export type AccountDraftReplica = Omit<AccountReplica, 'state' | 'pendingWithdrawals' | 'shadow'> & {
  state: AccountDraftState;
  pendingWithdrawals: AccountCollectionDraft<
    string,
    AccountReplica['pendingWithdrawals'] extends ReadonlyMap<string, infer Value> ? Value : never
  >;
  shadow: Omit<AccountReplica['shadow'], 'rebalance'> & {
    rebalance: Omit<AccountReplica['shadow']['rebalance'], 'policy' | 'submittedAtByToken'> & {
      policy: AccountCollectionDraft<number, RebalancePolicy>;
      submittedAtByToken: AccountCollectionDraft<number, number>;
    };
  };
};

type DraftOwners = Readonly<{
  deltas: AccountCollectionOverlayOwner<number, Delta>;
  locks: AccountCollectionOverlayOwner<string, HtlcLock>;
  swapOffers: AccountCollectionOverlayOwner<string, SwapOffer>;
  pulls: AccountCollectionOverlayOwner<string, PullCommitment>;
  subcontracts: AccountCollectionOverlayOwner<string, AccountSubcontract>;
  lendingIntents: AccountCollectionOverlayOwner<string, AccountLendingIntentKind>;
  requestedRebalance: AccountCollectionOverlayOwner<number, bigint>;
  requestedRebalanceFeeState: AccountCollectionOverlayOwner<number, RebalanceRequestFeeState>;
  rebalanceFeePolicies: AccountCollectionOverlayOwner<number, BilateralRebalanceFeePolicy>;
  pendingWithdrawals: AccountCollectionOverlayOwner<
    string,
    AccountReplica['pendingWithdrawals'] extends ReadonlyMap<string, infer Value> ? Value : never
  >;
  rebalanceShadowPolicy: AccountCollectionOverlayOwner<number, RebalancePolicy>;
  rebalanceShadowSubmitted: AccountCollectionOverlayOwner<number, number>;
}>;

export type AccountStateDraftOwner = Readonly<{
  draft: AccountDraftReplica;
  owners: DraftOwners;
  optionalPresence: Readonly<{
    pulls: boolean;
    subcontracts: boolean;
    lendingIntents: boolean;
    rebalanceFeePolicies: boolean;
  }>;
}>;

export type AccountStateDraftNodeChanges = Readonly<{
  deltas: PreparedAccountCollection<number, Delta>['nodeChanges'];
  locks: PreparedAccountCollection<string, HtlcLock>['nodeChanges'];
  swapOffers: PreparedAccountCollection<string, SwapOffer>['nodeChanges'];
  pulls: PreparedAccountCollection<string, PullCommitment>['nodeChanges'];
  subcontracts: PreparedAccountCollection<string, AccountSubcontract>['nodeChanges'];
  lendingIntents: PreparedAccountCollection<string, AccountLendingIntentKind>['nodeChanges'];
  requestedRebalance: PreparedAccountCollection<number, bigint>['nodeChanges'];
  requestedRebalanceFeeState: PreparedAccountCollection<number, RebalanceRequestFeeState>['nodeChanges'];
  rebalanceFeePolicies: PreparedAccountCollection<number, BilateralRebalanceFeePolicy>['nodeChanges'];
  pendingWithdrawals: PreparedAccountCollection<string, unknown>['nodeChanges'];
  rebalanceShadowPolicy: PreparedAccountCollection<number, RebalancePolicy>['nodeChanges'];
  rebalanceShadowSubmitted: PreparedAccountCollection<number, number>['nodeChanges'];
}>;

export type PreparedAccountStateDraft = Readonly<{
  account: AccountReplica;
  nodeChanges: AccountStateDraftNodeChanges;
}>;

const persistent = <K extends number | string, V>(
  source: AccountStateCollection<K, V> | undefined,
  namespace: DraftCollectionNames,
): PersistentAccountStateMap<K, V> => {
  if (source instanceof PersistentAccountStateMap) return source;
  if (source === undefined) return PersistentAccountStateMap.empty<K, V>(namespace);
  throw new Error(`ACCOUNT_STATE_COLLECTION_NOT_PERSISTENT:${namespace}`);
};

export const beginAccountStateDraft = (base: AccountReplica): AccountStateDraftOwner => {
  const owners: DraftOwners = {
    deltas: beginAccountCollectionOverlay(persistent<number, Delta>(base.state.deltas, 'deltas')),
    locks: beginAccountCollectionOverlay(persistent<string, HtlcLock>(base.state.locks, 'locks')),
    swapOffers: beginAccountCollectionOverlay(persistent<string, SwapOffer>(base.state.swapOffers, 'swapOffers')),
    pulls: beginAccountCollectionOverlay(persistent<string, PullCommitment>(base.state.pulls, 'pulls')),
    subcontracts: beginAccountCollectionOverlay(persistent<string, AccountSubcontract>(base.state.subcontracts, 'subcontracts')),
    lendingIntents: beginAccountCollectionOverlay(persistent<string, AccountLendingIntentKind>(base.state.lendingIntents, 'lendingIntents')),
    requestedRebalance: beginAccountCollectionOverlay(persistent<number, bigint>(base.state.requestedRebalance, 'requestedRebalance')),
    requestedRebalanceFeeState: beginAccountCollectionOverlay(persistent<number, RebalanceRequestFeeState>(base.state.requestedRebalanceFeeState, 'requestedRebalanceFeeState')),
    rebalanceFeePolicies: beginAccountCollectionOverlay(persistent<number, BilateralRebalanceFeePolicy>(base.state.rebalanceFeePolicies, 'rebalanceFeePolicies')),
    pendingWithdrawals: beginAccountCollectionOverlay(persistent(base.pendingWithdrawals, 'pendingWithdrawals')),
    rebalanceShadowPolicy: beginAccountCollectionOverlay(persistent(base.shadow.rebalance.policy, 'rebalanceShadowPolicy')),
    rebalanceShadowSubmitted: beginAccountCollectionOverlay(persistent(base.shadow.rebalance.submittedAtByToken, 'rebalanceShadowSubmitted')),
  };
  const shell = forkAccountReplicaShell(base);
  const draft: AccountDraftReplica = {
    ...shell,
    state: {
      ...shell.state,
      deltas: owners.deltas.view,
      locks: owners.locks.view,
      swapOffers: owners.swapOffers.view,
      pulls: owners.pulls.view,
      subcontracts: owners.subcontracts.view,
      lendingIntents: owners.lendingIntents.view,
      requestedRebalance: owners.requestedRebalance.view,
      requestedRebalanceFeeState: owners.requestedRebalanceFeeState.view,
      rebalanceFeePolicies: owners.rebalanceFeePolicies.view,
    },
    pendingWithdrawals: owners.pendingWithdrawals.view,
    shadow: {
      ...shell.shadow,
      rebalance: {
        ...shell.shadow.rebalance,
        policy: owners.rebalanceShadowPolicy.view,
        submittedAtByToken: owners.rebalanceShadowSubmitted.view,
      },
    },
  };
  return {
    draft,
    owners,
    optionalPresence: {
      pulls: base.state.pulls !== undefined,
      subcontracts: base.state.subcontracts !== undefined,
      lendingIntents: base.state.lendingIntents !== undefined,
      rebalanceFeePolicies: base.state.rebalanceFeePolicies !== undefined,
    },
  };
};

const optionalPrepared = <K extends number | string, V>(
  owner: AccountCollectionOverlayOwner<K, V>,
): PreparedAccountCollection<K, V> => prepareAccountCollectionOverlay(owner);

export const prepareAccountStateDraft = (
  owner: AccountStateDraftOwner,
  materialized: AccountDraftReplica,
): PreparedAccountStateDraft => {
  const pulls = optionalPrepared(owner.owners.pulls);
  const subcontracts = optionalPrepared(owner.owners.subcontracts);
  const lendingIntents = optionalPrepared(owner.owners.lendingIntents);
  const rebalanceFeePolicies = optionalPrepared(owner.owners.rebalanceFeePolicies);
  const deltas = prepareAccountCollectionOverlay(owner.owners.deltas);
  const locks = prepareAccountCollectionOverlay(owner.owners.locks);
  const swapOffers = prepareAccountCollectionOverlay(owner.owners.swapOffers);
  const requestedRebalance = prepareAccountCollectionOverlay(owner.owners.requestedRebalance);
  const requestedRebalanceFeeState = prepareAccountCollectionOverlay(owner.owners.requestedRebalanceFeeState);
  const pendingWithdrawals = prepareAccountCollectionOverlay(owner.owners.pendingWithdrawals);
  const rebalanceShadowPolicy = prepareAccountCollectionOverlay(owner.owners.rebalanceShadowPolicy);
  const rebalanceShadowSubmitted = prepareAccountCollectionOverlay(owner.owners.rebalanceShadowSubmitted);
  const {
    pulls: _draftPulls,
    subcontracts: _draftSubcontracts,
    lendingIntents: _draftLendingIntents,
    rebalanceFeePolicies: _draftRebalanceFeePolicies,
    ...boundedState
  } = materialized.state;
  const state: AccountState = {
    ...boundedState,
    deltas: deltas.values,
    locks: locks.values,
    swapOffers: swapOffers.values,
    requestedRebalance: requestedRebalance.values,
    requestedRebalanceFeeState: requestedRebalanceFeeState.values,
    ...(owner.optionalPresence.pulls || pulls.values.size > 0 ? { pulls: pulls.values } : {}),
    ...(owner.optionalPresence.subcontracts || subcontracts.values.size > 0 ? { subcontracts: subcontracts.values } : {}),
    ...(owner.optionalPresence.lendingIntents || lendingIntents.values.size > 0 ? { lendingIntents: lendingIntents.values } : {}),
    ...(owner.optionalPresence.rebalanceFeePolicies || rebalanceFeePolicies.values.size > 0 ? { rebalanceFeePolicies: rebalanceFeePolicies.values } : {}),
  };
  return Object.freeze({
    account: {
      ...materialized,
      state,
      pendingWithdrawals: pendingWithdrawals.values,
      shadow: {
        ...materialized.shadow,
        rebalance: {
          ...materialized.shadow.rebalance,
          policy: rebalanceShadowPolicy.values,
          submittedAtByToken: rebalanceShadowSubmitted.values,
        },
      },
    },
    nodeChanges: {
      deltas: deltas.nodeChanges,
      locks: locks.nodeChanges,
      swapOffers: swapOffers.nodeChanges,
      pulls: pulls.nodeChanges,
      subcontracts: subcontracts.nodeChanges,
      lendingIntents: lendingIntents.nodeChanges,
      requestedRebalance: requestedRebalance.nodeChanges,
      requestedRebalanceFeeState: requestedRebalanceFeeState.nodeChanges,
      rebalanceFeePolicies: rebalanceFeePolicies.nodeChanges,
      pendingWithdrawals: pendingWithdrawals.nodeChanges,
      rebalanceShadowPolicy: rebalanceShadowPolicy.nodeChanges,
      rebalanceShadowSubmitted: rebalanceShadowSubmitted.nodeChanges,
    },
  });
};

export const discardAccountStateDraft = (owner: AccountStateDraftOwner): void => {
  discardAccountCollectionOverlay(owner.owners.deltas);
  discardAccountCollectionOverlay(owner.owners.locks);
  discardAccountCollectionOverlay(owner.owners.swapOffers);
  discardAccountCollectionOverlay(owner.owners.pulls);
  discardAccountCollectionOverlay(owner.owners.subcontracts);
  discardAccountCollectionOverlay(owner.owners.lendingIntents);
  discardAccountCollectionOverlay(owner.owners.requestedRebalance);
  discardAccountCollectionOverlay(owner.owners.requestedRebalanceFeeState);
  discardAccountCollectionOverlay(owner.owners.rebalanceFeePolicies);
  discardAccountCollectionOverlay(owner.owners.pendingWithdrawals);
  discardAccountCollectionOverlay(owner.owners.rebalanceShadowPolicy);
  discardAccountCollectionOverlay(owner.owners.rebalanceShadowSubmitted);
};

export const isAccountDraftReplica = (account: AccountReplica): account is AccountDraftReplica =>
  isAccountCollectionDraft(account.state.deltas);
