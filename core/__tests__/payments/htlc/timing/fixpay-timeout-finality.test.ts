import { collectDerivedDeadlines } from '../../../../entity/scheduler/derived-deadlines';
import { handleProcessHtlcTimeoutsEntityTx } from '../../../../entity/tx/handlers/htlc/direct';
import { expect, test } from 'bun:test';
import { makeAccount, makeState, makeJurisdiction, entity, openWritableEntityAccounts } from '../../../helpers/cross-j';
import { createEmptyEnv } from '../../../../runtime';
import { prepareAccountConsensusRun } from '../../../../entity/tx/handlers/account/input-phases';
import { PersistentAccountStateMap } from '../../../../account/state/persistent-state-map';
import { hashHtlcSecret } from '../../../../protocol/htlc/utils';

const alice = entity('11');
const hub = entity('22');
const bob = entity('33');
const secret = entity('ab');
const hashlock = hashHtlcSecret(secret);
function fixture(finalizedHeight: number, revealed = false, outboundLive = true) {
  const j = makeJurisdiction('test', 31337, '44', '55');
  const state = makeState(hub, entity('66'), j, alice);
  state.timestamp = 120_000;
  state.lastFinalizedJHeight = finalizedHeight;
  const inbound = makeAccount(hub, alice, j);
  const outbound = makeAccount(hub, bob, j);
  const lock = {
    lockId: hashlock,
    hashlock,
    tokenId: 1,
    amount: 100n,
    timelock: 120_000n,
    revealBeforeHeight: 120,
    senderIsLeft: true,
    createdTimestamp: 0,
    createdHeight: 1,
  };
  inbound.state.locks = PersistentAccountStateMap.fromEntries('locks', [[hashlock, lock]]);
  outbound.state.locks = PersistentAccountStateMap.fromEntries('locks', [
    [hashlock, { ...lock, timelock: 110_000n, revealBeforeHeight: 110 }],
  ]);
  if (!outboundLive) outbound.state.locks = PersistentAccountStateMap.fromEntries('locks', []);
  openWritableEntityAccounts(state).set(alice, inbound);
  openWritableEntityAccounts(state).set(bob, outbound);
  state.paybook.entries.set(hashlock, {
    hashlock,
    tokenId: 1,
    amount: 100n,
    inboundEntity: alice,
    outboundEntity: bob,
    createdTimestamp: 0,
    ...(revealed ? { secret } : {}),
  });
  const context = {
    env: createEmptyEnv('fixpay-2'),
    state,
    account: inbound,
    input: {
      kind: 'ack_frame',
      fromEntityId: alice,
      toEntityId: hub,
      domain: inbound.state.domain,
      disputeConfig: inbound.state.disputeConfig,
      proposal: {
        frame: {
          height: 2,
          timestamp: 120_000,
          jHeight: finalizedHeight,
          accountTxs: [{ type: 'htlc_resolve', data: { lockId: hashlock, outcome: 'error', reason: 'timeout' } }],
        },
        frameHanko: '',
      },
    },
  };
  return { state, run: () => prepareAccountConsensusRun(context as never) };
}

test.each([100, 110])('fixpay-2 T+120 refund waits while T+109 reveal may be unfinalized at height %s', height => {
  expect(fixture(height).run).toThrow('HTLC_INBOUND_TIMEOUT_AWAITING_DOWNSTREAM_RESOLUTION');
});
test('fixpay-2 height coverage alone cannot close the timestamp-based registry; downstream must resolve first', () => {
  expect(fixture(111).run).toThrow('HTLC_INBOUND_TIMEOUT_AWAITING_DOWNSTREAM_RESOLUTION');
  expect(fixture(111, false, false).run).not.toThrow();
  expect(fixture(111, true, false).run).toThrow('HTLC_INBOUND_TIMEOUT_SECRET_KNOWN');
});

test('fixpay-2 the local scheduler cannot refund the same unsafe inbound lock', () => {
  const { state } = fixture(100);
  expect(
    collectDerivedDeadlines(state, state.timestamp).filter(
      d => d.type === 'htlc_timeout' && d.data.accountId === alice,
    ),
  ).toHaveLength(0);
  const unsafe = handleProcessHtlcTimeoutsEntityTx(state, {
    type: 'processHtlcTimeouts',
    data: { expiredLocks: [{ accountId: alice, lockId: hashlock }] },
  });
  expect(unsafe.accountTxs).toHaveLength(0);
  const { state: covered } = fixture(111, false, false);
  expect(
    handleProcessHtlcTimeoutsEntityTx(covered, {
      type: 'processHtlcTimeouts',
      data: { expiredLocks: [{ accountId: alice, lockId: hashlock }] },
    }).accountTxs,
  ).toHaveLength(1);
});
