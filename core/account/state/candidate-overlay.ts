/** One isolated Account transition draft over the current live replica. */

import type { AccountReplica } from '../../types/account';
import { toStateHash, type StateHash } from '../../protocol/hashes';
import { computeAccountStateRoot } from '../commitment/state-root';
import { createStructuredLogger } from '../../support/logger';
import {
  beginAccountStateDraft,
  discardAccountStateDraft,
  prepareAccountStateDraft,
  type AccountStateDraftNodeChanges,
  type AccountDraftReplica,
  type AccountStateDraftOwner,
} from './account-state-draft';

export type AccountTransitionCommit = Readonly<{
  account: AccountReplica;
  accountStateRoot: StateHash;
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
  readonly lifecycle: { status: OverlayStatus };
  readonly stateDraft: AccountStateDraftOwner;

  constructor(readonly base: AccountReplica) {
    this.lifecycle = { status: 'active' };
    this.stateDraft = beginAccountStateDraft(base);
  }
}

const requireActive = (overlay: AccountTransitionOverlay): void => {
  if (overlay.lifecycle.status !== 'active') {
    throw new Error(`ACCOUNT_TRANSITION_OVERLAY_NOT_ACTIVE:${overlay.lifecycle.status}`);
  }
};

const overlayLog = createStructuredLogger('account.overlay');

// The former content-derived transition key was never read by a cache. It
// hashed the complete Account root plus caller metadata for every draft and
// duplicated the only root that matters: the prepared post-transition root.
// Static Patricia paths already identify persisted Account nodes; overlays are
// ephemeral isolation boundaries and must not invent a second identity layer.
export const beginAccountTransition = (base: AccountReplica): AccountTransitionOverlay =>
  new AccountTransitionOverlay(base);

export const accountTransitionView = (overlay: AccountTransitionOverlay): AccountDraftReplica => {
  requireActive(overlay);
  return overlay.stateDraft.draft;
};

export const commitAccountTransition = (
  overlay: AccountTransitionOverlay,
  source = 'unspecified',
): AccountTransitionCommit => {
  requireActive(overlay);
  const prepared = prepareAccountStateDraft(overlay.stateDraft, overlay.stateDraft.draft);
  const account = prepared.account;
  // Compute the signed financial root exactly once at the transition boundary.
  // Callers propagate this value through validation/publish instead of walking
  // the same Patricia branches again after a field-for-field overlay fold.
  const accountStateRoot = toStateHash(computeAccountStateRoot(
    account.state,
    undefined,
    `transitionCommit.${source}`,
  ));
  overlay.lifecycle.status = 'committed';
  overlayLog.debug('overlay.prepared', {
    from: account.proofHeader.fromEntity.slice(-8),
    to: account.proofHeader.toEntity.slice(-8),
  });
  return {
    account,
    accountStateRoot,
    // Lazy: twelve Patricia diff walks per transition whose only consumer is
    // a diagnostic node counter in the J-event finality log.
    get nodeChanges() { return prepared.nodeChanges; },
  };
};

/**
 * Bilateral money, proofs, and dispute lifecycle fold into `live`.
 * Frame coordination stays on the live replica until ACK/accept installs it.
 */
export const ACCOUNT_LIVE_ENVELOPE: ReadonlySet<keyof AccountReplica> = new Set<keyof AccountReplica>([
  'mempool',
  'currentFrame',
  'currentHeight',
  'pendingFrame',
  'pendingAccountInput',
  'lastOutboundFrameAck',
  'currentFrameHanko',
  'counterpartyFrameHanko',
  'rollbackCount',
  'lastRollbackFrameHash',
  'boardResealMigration',
  'counterpartyBoardReseal',
  'publicPinned',
  'pendingProposalSentAt',
]);

export const publishAccountOverlay = (
  live: AccountReplica,
  prepared: AccountReplica,
): AccountReplica => {
  const keys = new Set<keyof AccountReplica>([
    ...(Object.keys(live) as (keyof AccountReplica)[]),
    ...(Object.keys(prepared) as (keyof AccountReplica)[]),
  ]);
  for (const key of keys) {
    if (ACCOUNT_LIVE_ENVELOPE.has(key)) continue;
    const value = prepared[key];
    const applied = value === undefined
      ? Reflect.deleteProperty(live, key)
      : Reflect.set(live, key, value);
    if (!applied) throw new Error(`ACCOUNT_OVERLAY_PUBLISH_FAILED:${String(key)}`);
  }
  overlayLog.debug('overlay.folded', {
    from: live.proofHeader.fromEntity.slice(-8),
    to: live.proofHeader.toEntity.slice(-8),
    height: live.currentHeight,
    pending: Boolean(live.pendingFrame),
  });
  return live;
};

/** Consume the overlay and fold it into `live`. Proposal hashing must not call this. */
export const publishAccountTransition = (
  live: AccountReplica,
  overlay: AccountTransitionOverlay,
  source = 'unspecified',
): AccountTransitionCommit => {
  const committed = commitAccountTransition(overlay, source);
  publishAccountOverlay(live, committed.account);
  return {
    account: live,
    accountStateRoot: committed.accountStateRoot,
    nodeChanges: committed.nodeChanges,
  };
};

export const discardAccountTransition = (overlay: AccountTransitionOverlay): void => {
  if (overlay.lifecycle.status === 'discarded') return;
  if (overlay.lifecycle.status === 'committed') throw new Error('ACCOUNT_TRANSITION_ALREADY_COMMITTED');
  discardAccountStateDraft(overlay.stateDraft);
  overlay.lifecycle.status = 'discarded';
};
