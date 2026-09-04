import {
  applyAccountDisputeFinality,
  applyAccountDisputeStarted,
  type AccountDisputeFinalityResult,
} from '../settlement/j-finality';
import { freezeAccountForDispute } from '../consensus/dispute/policy';
import { requirePersistentAccountStateMap } from '../state/persistent-state-map';
import type {
  AccountBoardHankoRefreshMigration,
  AccountFinality,
  AccountReplica,
} from '../../types/account';
import type { RebalancePolicy } from '../../types/finance/rebalance';

type DisputeStartedFinality = Extract<
  AccountFinality['finality'],
  { kind: 'dispute_started' }
>;

type DisputeFinality = Extract<
  AccountFinality['finality'],
  { kind: 'dispute_finalized' }
>;

/** Exact TS mirror of Rust `AccountEnvelopeUpdate`. */
export type AccountEnvelopeUpdate =
  | Readonly<{ type: 'clearRebalanceActiveQuote' }>
  | Readonly<{
      type: 'setRebalancePolicy';
      tokenId: number;
      policy: RebalancePolicy;
    }>
  | Readonly<{
      type: 'setRebalanceSubmittedAt';
      tokenId: number;
      /** Omitted releases the marker for that token. */
      submittedAt?: number;
    }>
  | Readonly<{
      type: 'replaceBoardHankoRefreshMigration';
      /** Omitted clears the marker. */
      migration?: AccountBoardHankoRefreshMigration;
    }>
  | Readonly<{
      type: 'replaceDisputeLifecycle';
      status: AccountReplica['status'];
      disputePrepare?: AccountReplica['disputePrepare'];
      activeDispute?: AccountReplica['activeDispute'];
    }>
  | Readonly<{ type: 'applyDisputeStarted'; finality: DisputeStartedFinality }>
  | Readonly<{ type: 'applyDisputeFinality'; finality: DisputeFinality }>
  | Readonly<{ type: 'confirmDisputeBookRemoval'; orderId: string }>;

const cloneRecovery = <T extends { requiredPullIds: string[]; resultsByPullId: Record<string, string> }>(
  value: T,
): T => ({
  ...value,
  requiredPullIds: [...value.requiredPullIds],
  resultsByPullId: { ...value.resultsByPullId },
});

const cloneDisputePrepare = (
  value: NonNullable<AccountReplica['disputePrepare']>,
): NonNullable<AccountReplica['disputePrepare']> => ({
  ...value,
  ...(value.pendingOrderbookRemovalIds === undefined
    ? {}
    : { pendingOrderbookRemovalIds: [...value.pendingOrderbookRemovalIds] }),
  ...(value.startIntent === undefined ? {} : { startIntent: { ...value.startIntent } }),
  ...(value.crossJurisdictionRecovery === undefined
    ? {}
    : { crossJurisdictionRecovery: cloneRecovery(value.crossJurisdictionRecovery) }),
});

const cloneActiveDispute = (
  value: NonNullable<AccountReplica['activeDispute']>,
): NonNullable<AccountReplica['activeDispute']> => ({
  ...value,
  ...(value.crossJurisdictionRecovery === undefined
    ? {}
    : { crossJurisdictionRecovery: cloneRecovery(value.crossJurisdictionRecovery) }),
});

/** Apply one Entity-owned Account envelope transition on the Account's owning stage. */
export const applyAccountEnvelopeUpdate = (
  account: AccountReplica,
  update: AccountEnvelopeUpdate,
): AccountDisputeFinalityResult | undefined => {
  if (update.type === 'clearRebalanceActiveQuote') {
    delete account.shadow.rebalance.activeQuote;
    return undefined;
  }
  if (update.type === 'setRebalancePolicy') {
    account.shadow.rebalance.policy = requirePersistentAccountStateMap(
      account.shadow.rebalance.policy,
      'rebalanceShadowPolicy',
    ).updated(update.tokenId, { ...update.policy });
    return undefined;
  }
  if (update.type === 'setRebalanceSubmittedAt') {
    const submitted = requirePersistentAccountStateMap(
      account.shadow.rebalance.submittedAtByToken,
      'rebalanceShadowSubmitted',
    );
    account.shadow.rebalance.submittedAtByToken = update.submittedAt === undefined
      ? submitted.removed(update.tokenId)
      : submitted.updated(update.tokenId, update.submittedAt);
    return undefined;
  }
  if (update.type === 'replaceBoardHankoRefreshMigration') {
    if (update.migration === undefined) delete account.boardHankoRefreshMigration;
    else account.boardHankoRefreshMigration = { ...update.migration };
    return undefined;
  }
  if (update.type === 'replaceDisputeLifecycle') {
    const previousStatus = account.status;
    account.status = update.status;
    if (update.disputePrepare === undefined) delete account.disputePrepare;
    else account.disputePrepare = cloneDisputePrepare(update.disputePrepare);
    if (update.activeDispute === undefined) delete account.activeDispute;
    else account.activeDispute = cloneActiveDispute(update.activeDispute);
    if (previousStatus !== update.status) {
      if (update.status === 'dispute_preparing') freezeAccountForDispute(account, true);
      else if (update.status === 'disputed') freezeAccountForDispute(account, false);
    }
    return undefined;
  }
  if (update.type === 'applyDisputeStarted') {
    applyAccountDisputeStarted(account, { ...update.finality });
    return undefined;
  }
  if (update.type === 'applyDisputeFinality') {
    return applyAccountDisputeFinality(
      account,
      update.finality.finalizedJNonce,
      [...update.finality.finalizedTokenIds],
    );
  }
  const pending = account.disputePrepare?.pendingOrderbookRemovalIds;
  if (!pending?.includes(update.orderId)) {
    throw new Error(`DISPUTE_BOOK_REMOVAL_NOT_PENDING:${update.orderId}`);
  }
  account.disputePrepare!.pendingOrderbookRemovalIds = pending.filter(
    orderId => orderId !== update.orderId,
  );
  if (account.disputePrepare!.pendingOrderbookRemovalIds.length === 0) {
    delete account.disputePrepare!.pendingOrderbookRemovalIds;
  }
  return undefined;
};
