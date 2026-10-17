import { expect, test } from 'bun:test';
import { collectDerivedDeadlines, earliestDerivedDeadline } from '../../../entity/scheduler/derived-deadlines';
import { PersistentAccountStateMap } from '../../../account/state/persistent-state-map';
import { entity, addr, makeJurisdiction, makeState, getTestAccountForWrite } from '../../helpers/cross-j';

const SELF = entity('11');
const PEER = entity('22');
const HASHLOCK = entity('44');

const fixture = () => {
  const state = makeState(SELF, addr('33'), makeJurisdiction('deadline', 31337, '55', '66'), PEER);
  const account = getTestAccountForWrite(state, PEER);
  account.state.locks = PersistentAccountStateMap.fromEntries('locks', [
    [
      HASHLOCK,
      {
        lockId: HASHLOCK,
        hashlock: HASHLOCK,
        tokenId: 1,
        amount: 10n,
        timelock: 100n,
        revealBeforeHeight: 10,
        senderIsLeft: true,
        createdHeight: 1,
        createdTimestamp: 1,
      },
    ],
  ]);
  return { state, account };
};

test('htlc timeout is not due while its resolve is queued or proposed', () => {
  for (const proposed of [false, true]) {
    const { state, account } = fixture();
    const tx = {
      type: 'htlc_resolve' as const,
      data: { lockId: HASHLOCK, outcome: 'error' as const, reason: 'timeout' },
    };
    if (proposed) account.pendingFrame = { ...account.currentFrame, height: 1, accountTxs: [tx] };
    else account.mempool.push(tx);
    expect(collectDerivedDeadlines(state, 1_000)).toEqual([]);
    expect(earliestDerivedDeadline(state)).toBeNull();
  }
});

test('secret ACK on a frozen account cannot rearm a past wake', () => {
  const { state, account } = fixture();
  account.status = 'disputed';
  state.paybook.entries.set(HASHLOCK, {
    hashlock: HASHLOCK,
    tokenId: 1,
    amount: 10n,
    inboundEntity: PEER,
    createdTimestamp: 1,
    secret: entity('77'),
    secretAckPending: true,
    secretAckStartedAt: 1,
    secretAckDeadlineAt: 200,
  });
  expect(collectDerivedDeadlines(state, 1_000)).toEqual([]);
  expect(earliestDerivedDeadline(state)).toBeNull();
});
