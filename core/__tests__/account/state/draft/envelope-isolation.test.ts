import { describe, expect, test } from 'bun:test';

import { makeAccount } from '../../../helpers/cross-j';
import {
  beginAccountStateDraft,
  discardAccountStateDraft,
  prepareAccountStateDraft,
} from '../../../../account/state/account-state-draft';
import { publishAccountOverlay } from '../../../../account/state/candidate-overlay';
import { PersistentAccountStateMap } from '../../../../account/state/persistent-state-map';
import { computeAccountStateRootCold } from '../../../../account/commitment/state-root';
import type { AccountReplica, AccountTx } from '../../../../types/account';

const LEFT = `0x${'11'.repeat(32)}`;
const RIGHT = `0x${'22'.repeat(32)}`;

const makePersistentAccount = (): AccountReplica => {
  const account = makeAccount(LEFT, RIGHT);
  delete (account as { swapOrderHistory?: unknown }).swapOrderHistory;
  delete (account as { swapClosedOrders?: unknown }).swapClosedOrders;
  account.state.deltas = PersistentAccountStateMap.fromEntries('deltas', account.state.deltas);
  account.state.locks = PersistentAccountStateMap.fromEntries('locks', account.state.locks);
  account.state.swapOffers = PersistentAccountStateMap.fromEntries('swapOffers', account.state.swapOffers);
  account.state.requestedRebalance = PersistentAccountStateMap.fromEntries(
    'requestedRebalance',
    account.state.requestedRebalance,
  );
  account.state.requestedRebalanceFeeState = PersistentAccountStateMap.fromEntries(
    'requestedRebalanceFeeState',
    account.state.requestedRebalanceFeeState,
  );
  account.pendingWithdrawals = PersistentAccountStateMap.fromEntries('pendingWithdrawals', account.pendingWithdrawals);
  account.shadow.rebalance.policy = PersistentAccountStateMap.fromEntries(
    'rebalanceShadowPolicy',
    account.shadow.rebalance.policy,
  );
  account.shadow.rebalance.submittedAtByToken = PersistentAccountStateMap.fromEntries(
    'rebalanceShadowSubmitted',
    account.shadow.rebalance.submittedAtByToken,
  );
  return account;
};

/**
 * Regression test for lever S (forkAccountDraftShell, commit 963a1dc0a):
 * Account draft overlays share envelope fields (mempool, currentFrame,
 * pendingFrame, …) by reference with the committed replica. The guard scan
 * (check-no-readonly-account-mutation.ts) rejects in-place mutations on
 * these fields. This test proves the invariant from the runtime side:
 *
 * 1. The draft's envelope fields ARE shared references (not clones).
 * 2. Discarding a draft leaves the base replica's envelope fields untouched.
 * 3. Publishing a draft (collection mutations only) does not overwrite the
 *    live replica's envelope fields — publishAccountOverlay skips them.
 *
 * If a future change breaks the sharing or the publish filter, this test
 * fails before a silent consensus divergence can ship.
 */
describe('Draft envelope field isolation (lever S)', () => {
  test('draft shares mempool and currentFrame by reference with the base', () => {
    const base = makePersistentAccount();
    const owner = beginAccountStateDraft(base);
    expect(owner.draft.mempool).toBe(base.mempool);
    expect(owner.draft.currentFrame).toBe(base.currentFrame);
    discardAccountStateDraft(owner);
  });

  test('discard preserves base mempool identity and length', () => {
    const base = makePersistentAccount();
    const baseMempool = base.mempool;
    const baseMempoolLength = base.mempool.length;
    const baseFrame = base.currentFrame;

    const owner = beginAccountStateDraft(base);
    // Legitimate collection mutation through the overlay
    owner.draft.state.deltas.edit(1, prev => ({ ...prev, offdelta: prev.offdelta + 100n }));
    discardAccountStateDraft(owner);

    expect(base.mempool).toBe(baseMempool);
    expect(base.mempool.length).toBe(baseMempoolLength);
    expect(base.currentFrame).toBe(baseFrame);
  });

  test('publish does not overwrite live envelope fields', () => {
    const base = makePersistentAccount();
    const baseMempool = base.mempool;
    const baseFrame = base.currentFrame;
    const baseRootBefore = computeAccountStateRootCold(base.state);

    const owner = beginAccountStateDraft(base);
    owner.draft.state.deltas.edit(1, prev => ({ ...prev, offdelta: prev.offdelta + 200n }));
    const prepared = prepareAccountStateDraft(owner, owner.draft);
    publishAccountOverlay(base, prepared.account);

    // Envelope fields are never published from the draft to the live replica.
    expect(base.mempool).toBe(baseMempool);
    expect(base.currentFrame).toBe(baseFrame);
    // Collection mutations did publish.
    expect(computeAccountStateRootCold(base.state)).not.toBe(baseRootBefore);
  });

  test('base mempool content is provably untouched after draft discard', () => {
    const base = makePersistentAccount();
    const tx: AccountTx = {
      type: 'direct_payment',
      data: {
        tokenId: 1,
        amount: 100n,
        route: [],
        deliveryMode: 'trusted',
        trustedGatewayEntityId: RIGHT,
      },
    } as never;
    base.mempool.push(tx);
    const snapshot = [...base.mempool];

    const owner = beginAccountStateDraft(base);
    // The draft's mempool is the same array reference — if a handler
    // mutated it in place, the base would be corrupted. The guard scan
    // prevents this; this test proves the runtime invariant holds.
    expect(owner.draft.mempool).toBe(base.mempool);
    discardAccountStateDraft(owner);

    expect(base.mempool).toEqual(snapshot);
    expect(base.mempool.length).toBe(1);
  });
});
