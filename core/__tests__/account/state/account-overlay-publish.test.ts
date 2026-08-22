import { describe, expect, test } from 'bun:test';

import {
  accountTransitionView,
  beginAccountTransition,
  publishAccountTransition,
} from '../../../account/state/candidate-overlay';
import { entity, makeAccount } from '../../helpers/cross-j';

describe('account overlay publish', () => {
  test('folds dirty Patricia trees into live and leaves the frame envelope on live', () => {
    const live = makeAccount(entity('11'), entity('22'));
    live.currentHeight = 5;
    live.pendingFrame = { ...live.currentFrame, height: 6, stateHash: '0xpending' };
    live.currentFrameHanko = '0xlive-frame-hanko';
    live.currentDisputeProofHanko = '0xhanko';
    live.currentDisputeProofBodyHash = `0x${'bb'.repeat(32)}`;
    live.currentDisputeProofNonce = 2;
    live.publicPinned = true;
    const pendingFrame = live.pendingFrame;
    const liveHanko = live.currentFrameHanko;

    const overlay = beginAccountTransition(live);
    const draft = accountTransitionView(overlay);
    draft.currentHeight = 99;
    draft.currentFrameHanko = '0xdraft-frame-hanko';
    draft.state.requestedRebalance.put(1, 42n);
    const committed = publishAccountTransition(live, overlay);

    expect(live.state.requestedRebalance.get(1)).toBe(42n);
    expect(live.currentHeight).toBe(5);
    expect(live.pendingFrame).toBe(pendingFrame);
    expect(live.currentFrameHanko).toBe(liveHanko);
    expect(live.currentDisputeProofHanko).toBe('0xhanko');
    expect(live.currentDisputeProofBodyHash).toBe(`0x${'bb'.repeat(32)}`);
    expect(live.currentDisputeProofNonce).toBe(2);
    expect(live.publicPinned).toBe(true);
    expect(committed.account).toBe(live);
  });

  test('does not un-pin a live Account when the draft omits publicPinned', () => {
    const live = makeAccount(entity('11'), entity('22'));
    live.publicPinned = true;
    const overlay = beginAccountTransition(live);
    const draft = accountTransitionView(overlay);
    delete (draft as { publicPinned?: boolean }).publicPinned;
    publishAccountTransition(live, overlay);
    expect(live.publicPinned).toBe(true);
  });
});
