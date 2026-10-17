import { describe, expect, test } from 'bun:test';

import { applyAccountTxToMutableReplica } from '../../../../account/tx/apply';
import { hashHtlcSecret } from '../../../../protocol/htlc/utils';
import type { AccountReplica, AccountTx } from '../../../../types/account';
import { entity, makeAccount } from '../../../helpers/cross-j';

const LEFT = entity('11');
const RIGHT = entity('22');
const SECRET = `0x${'44'.repeat(32)}`;
const LOCK_ID = hashHtlcSecret(SECRET);
const TIMELOCK = 10_000n;

/** Both replicas hold the same committed lock; only the proof header owner differs. */
const lockedReplica = (self: string, counterparty: string): AccountReplica => {
  const account = makeAccount(self, counterparty);
  account.state.deltas = account.state.deltas.updated(1, { ...account.state.deltas.get(1)!, leftHold: 7n });
  account.state.locks = account.state.locks.updated(LOCK_ID, {
    lockId: LOCK_ID,
    hashlock: LOCK_ID,
    timelock: TIMELOCK,
    revealBeforeHeight: 100,
    amount: 7n,
    tokenId: 1,
    senderIsLeft: true,
    createdHeight: 1,
    createdTimestamp: 1_000,
  });
  return account;
};

const resolve: AccountTx = { type: 'htlc_resolve', data: { lockId: LOCK_ID, outcome: 'secret', secret: SECRET } };

const resolveWithClock = (account: AccountReplica, enforcementTimestamp: number) =>
  applyAccountTxToMutableReplica(
    account,
    resolve,
    false,
    Number(TIMELOCK) - 1,
    0,
    false,
    undefined,
    undefined,
    undefined,
    { timestamp: enforcementTimestamp, jHeight: 0 },
  );

describe('htlc_resolve enforcement clock', () => {
  test('htlc_resolve.rejects_deterministically_when_enforcement_clock_passes_timelock', async () => {
    const proposer = lockedReplica(RIGHT, LEFT);
    const receiver = lockedReplica(LEFT, RIGHT);

    // Proposed one millisecond before the timelock: valid on either replica.
    const proposed = await resolveWithClock(proposer, Number(TIMELOCK) - 1);
    expect(proposed.ok).toBe(true);
    expect(proposer.state.locks.has(LOCK_ID)).toBe(false);

    // Received at the timelock: a structured rejection, never a throw, with
    // the same reason on both replicas fed that clock.
    const receiverView = await resolveWithClock(receiver, Number(TIMELOCK));
    const proposerView = await resolveWithClock(lockedReplica(RIGHT, LEFT), Number(TIMELOCK));
    expect(receiverView.ok).toBe(false);
    expect(proposerView).toEqual(receiverView);
    if (receiverView.ok) throw new Error('expected rejection');
    expect(receiverView.rejection.kind).toBe('validation');
    expect(receiverView.rejection.message).toBe(`Lock expired: timestamp=10000/${TIMELOCK} jHeight=0/100`);
    expect(receiver.state.locks.has(LOCK_ID)).toBe(true);
    expect(receiver.state.deltas.get(1)?.leftHold).toBe(7n);
  });
});
