import { HTLC_ENFORCEMENT_RESERVE_MS } from '../../../../config/constants';
import { PersistentAccountStateMap } from '../../../../account/state/persistent-state-map';
import { expect, test } from 'bun:test';
import { makeAccount, makeState, makeJurisdiction, entity, openWritableEntityAccounts } from '../../../helpers/cross-j';
import { persistVerifiedPaymentSecret } from '../../../../paybook/lifecycle';
import { applyBookIntentProgram, createBookIntentProgram } from '../../../../entity/books/book-intents';
import { hashHtlcSecret, calculateHopTimelock, calculateHopRevealHeight } from '../../../../protocol/htlc/utils';
import { applyAccountTxToMutableReplica } from '../../../../account/tx/apply';
import { resolvePaymentDeadlineWindow } from '../../../../protocol/payments/delivery';

import { toJHeight, toUnixMs } from '../../../../protocol/units';
import { collectDerivedDeadlines } from '../../../../entity/scheduler/derived-deadlines';
import { handleDirectPaymentEntityTx } from '../../../../entity/tx/handlers/payments/direct-payment';
import type { EntityCandidateEffect } from '../../../../entity/types';

const self = entity('11');
const peer = entity('22');
const secret = entity('ab');
const hashlock = hashHtlcSecret(secret);
const j = makeJurisdiction('tron', 728126428, '33', '44');
const lock = {
  lockId: hashlock,
  hashlock,
  tokenId: 1,
  amount: 99n,
  timelock: 100_000n,
  revealBeforeHeight: 100,
  senderIsLeft: true,
  createdHeight: 1,
  createdTimestamp: 1,
};

test('fixpay-4 TS accepts sent lock with fee-bearing 100/99 amount and same secret bytes in uppercase', () => {
  const state = makeState(self, entity('55'), j, peer);
  state.paybook.entries.set(hashlock, {
    hashlock,
    amount: 100n,
    tokenId: 1,
    secret,
    inboundEntity: entity('66'),
    outboundEntity: peer,
    createdTimestamp: 1,
  });
  const program = createBookIntentProgram();
  const entry = persistVerifiedPaymentSecret(state, peer, lock, `0x${'AB'.repeat(32)}`, program.openSlot());
  expect(entry.secret?.toLowerCase()).toBe(secret);
  applyBookIntentProgram(state, program);
  expect(state.paybook.entries.get(hashlock)?.amount).toBe(100n);
});

test('fixpay-5 async on 3-second TRON lasts at least 24h in blocks', () => {
  const deadline = resolvePaymentDeadlineWindow({
    mode: 'async',
    runtimeJHeight: toJHeight(0),
    timestamp: toUnixMs(0),
    totalHops: 3,
    blockTimeMs: 3000,
  });
  expect(deadline.baseHeight * 3000).toBeGreaterThanOrEqual(86_400_000);
  expect(calculateHopRevealHeight(0, 0, 3, 3000) - calculateHopRevealHeight(0, 1, 3, 3000)).toBe(10);
});

test('fixpay-5 scheduler wakes immediately once finalized height has expired a lock', () => {
  const state = makeState(self, entity('55'), j, peer);
  state.timestamp = 50_000;
  state.lastFinalizedJHeight = 101;
  const account = makeAccount(self, peer, j);
  account.state.locks = PersistentAccountStateMap.fromEntries('locks', [[hashlock, lock]]);
  openWritableEntityAccounts(state).set(peer, account);
  expect(collectDerivedDeadlines(state, state.timestamp).some(d => d.type === 'htlc_timeout')).toBe(true);
});

test('fixpay-6 ten-year HTLC horizon is a typed rejection without holding capacity', async () => {
  const account = makeAccount(self, peer, j);
  const result = await applyAccountTxToMutableReplica(
    account,
    {
      type: 'htlc_lock',
      data: {
        ...lock,
        timelock: 315_360_000_000n,
        amount: 10n,
      },
    },
    true,
    1000,
    1,
  );
  expect(result.ok).toBe(false);
  expect(account.state.locks.size).toBe(0);
});

test.each([10, 11, 100])('fixpay-7 %s-hop instant last lock retains enforcement reserve plus transit', hops => {
  const deadline = resolvePaymentDeadlineWindow({
    blockTimeMs: 3000,
    mode: 'instant',
    runtimeJHeight: toJHeight(0),
    timestamp: toUnixMs(0),
    totalHops: hops,
  });
  expect(calculateHopTimelock(deadline.baseTimelock, hops - 1)).toBeGreaterThan(BigInt(HTLC_ENFORCEMENT_RESERVE_MS));
});

test('fixpay-9 direct payment without capacity emits PaymentFailed before queuing', async () => {
  const state = makeState(self, entity('55'), j, peer);
  const effects: EntityCandidateEffect[] = [];
  const result = await handleDirectPaymentEntityTx(
    { quietRuntimeLogs: true } as never,
    state,
    {
      type: 'directPayment',
      data: { tokenId: 1, amount: 10n ** 31n, targetEntityId: peer, route: [self, peer], deliveryMode: 'direct' },
    },
    effects,
  );
  expect(result.accountTxs ?? []).toHaveLength(0);
  expect(effects).toContainEqual(expect.objectContaining({ kind: 'runtimeEvent', eventName: 'PaymentFailed' }));
});

test('fixpay-5 height-expired lock retains the timelock-based 70s ACK enforcement deadline', () => {
  const state = makeState(self, entity('55'), j, peer);
  state.timestamp = 50_000;
  state.lastFinalizedJHeight = 101;
  const account = makeAccount(self, peer, j);
  account.state.locks = PersistentAccountStateMap.fromEntries('locks', [[hashlock, lock]]);
  openWritableEntityAccounts(state).set(peer, account);
  state.paybook.entries.set(hashlock, { hashlock, tokenId: 1, amount: 99n, inboundEntity: peer,
    createdTimestamp: 100, secret, secretAckPending: true, secretAckStartedAt: 100,
    secretAckDeadlineAt: 170_000 });
  expect(collectDerivedDeadlines(state).filter(d => d.type === 'htlc_secret_ack_timeout')).toEqual([
    { id: `htlc-secret-ack:${hashlock}`, triggerAt: 70_000, type: 'htlc_secret_ack_timeout',
      data: { hashlock, counterpartyEntityId: peer } },
  ]);
  expect(collectDerivedDeadlines(state, 50_000).filter(d => d.type === 'htlc_secret_ack_timeout')).toEqual([]);
});
