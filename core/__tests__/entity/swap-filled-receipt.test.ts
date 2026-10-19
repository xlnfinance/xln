import { expect, test } from 'bun:test';
import { makeState } from '../helpers/cross-j';
import { applyCommittedAccountFrameFollowups } from '../../entity/tx/handlers/account/committed-frame-followups';
import type { EntityCandidateEffect } from '../../entity/types';
import type { AccountFrame, AccountTx } from '../../types/account';

const maker = `0x${'11'.repeat(32)}`;
const hub = `0x${'22'.repeat(32)}`;
const state = () =>
  makeState(maker, `0x${'33'.repeat(20)}`, {
    name: 'test',
    chainId: 31337,
    depositoryAddress: `0x${'44'.repeat(20)}`,
  });
const frame = (data: Extract<AccountTx, { type: 'swap_resolve' }>['data']): AccountFrame => ({
  height: 8,
  timestamp: 1000,
  jHeight: 1,
  prevFrameHash: `0x${'55'.repeat(32)}`,
  stateHash: `0x${'66'.repeat(32)}`,
  accountStateRoot: `0x${'77'.repeat(32)}`,
  accountTxs: [{ type: 'swap_resolve', data }],
});

test('committed exact fills emit scoped receipt even when their uint16 ratio rounds to zero', () => {
  const filled = frame({
    offerId: 'filled',
    fillRatio: 0,
    cancelRemainder: false,
    executionGiveAmount: 1n,
    executionWantAmount: 2n,
  });
  const effects: EntityCandidateEffect[] = [];
  applyCommittedAccountFrameFollowups(state(), hub, filled, false, [], undefined, effects);
  expect(effects).toEqual([
    {
      kind: 'runtimeEvent',
      eventName: 'SwapFilled',
      data: {
        entityId: maker,
        counterpartyId: hub,
        offerId: 'filled',
        accountHeight: 8,
        accountFrameHash: filled.stateHash,
        executionGiveAmount: 1n,
        executionWantAmount: 2n,
      },
    },
  ]);
});

test('committed cancellation without execution never emits a fill receipt', () => {
  for (const data of [
    { offerId: 'cancel', fillRatio: 0, cancelRemainder: true },
    { offerId: 'cancel', fillRatio: 0, cancelRemainder: true, executionGiveAmount: 0n, executionWantAmount: 0n },
  ]) {
    const effects: EntityCandidateEffect[] = [];
    applyCommittedAccountFrameFollowups(state(), hub, frame(data), false, [], undefined, effects);
    expect(effects).toEqual([]);
  }
});
