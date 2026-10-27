import { collectDerivedDeadlines } from '../../../../entity/scheduler/derived-deadlines';
import { handleProcessHtlcTimeoutsEntityTx } from '../../../../entity/tx/handlers/htlc/direct';
import { expect, test } from 'bun:test';
import { makeAccount, makeState, makeJurisdiction, entity, openWritableEntityAccounts } from '../../../helpers/cross-j';
import { createEmptyEnv } from '../../../../runtime';
import { prepareAccountConsensusRun } from '../../../../entity/tx/handlers/account/input-phases';
import { PersistentAccountStateMap } from '../../../../account/state/persistent-state-map';
import { createAccountConsensusContext } from '../../../../entity/account/account-consensus-context';
import { proposeAccountFrame } from '../../../../account/consensus';
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

// Bob can commit our signed proposal even if his ACK never reaches us.
test.each([true, false])('fixpay-2 lost outbound ACK guards only the matching lock (match=%s)', async matches => {
  const { state, run } = fixture(111, false, false);
  const outbound = state.accounts.get(bob)!;
  const pendingHash = matches ? hashlock : entity('cd');
  outbound.mempool.push({ type: 'htlc_lock', data: { lockId: pendingHash, hashlock: pendingHash,
    tokenId: 1, amount: 99n, timelock: 110_000n, revealBeforeHeight: 110 } });
  expect(run).not.toThrow(); // An unsigned mempool intent is not a downstream obligation.
  const env = createEmptyEnv('fixpay-lost-ack');
  env.state.jReplicas.set('test', { name: 'test', chainId: 31337,
    depositoryAddress: outbound.state.domain.depositoryAddress,
    contracts: { depository: outbound.state.domain.depositoryAddress,
      entityProvider: entity('55').slice(0, 42), account: entity('66').slice(0, 42),
      deltaTransformer: entity('77').slice(0, 42) },
    blockNumber: 90n, stateRoot: null, mempool: [], blockDelayMs: 0,
    lastBlockTimestamp: 1000, position: { x: 0, y: 0, z: 0 } });
  const proposed = await proposeAccountFrame(createAccountConsensusContext(env), outbound, 1000, 90);
  expect(proposed.outcome).toBe('proposed');
  expect(outbound.state.locks.size).toBe(0);
  expect(outbound.pendingAccountInput?.proposal?.frame.accountTxs[0]?.type).toBe('htlc_lock');
  if (!matches) { expect(run).not.toThrow(); return; }
  expect(run).toThrow('HTLC_INBOUND_TIMEOUT_AWAITING_DOWNSTREAM_RESOLUTION');
  expect(collectDerivedDeadlines(state).filter(d => d.type === 'htlc_timeout')).toEqual([]);
  expect(handleProcessHtlcTimeoutsEntityTx(state, { type: 'processHtlcTimeouts',
    data: { expiredLocks: [{ accountId: alice, lockId: hashlock }] } }).accountTxs).toEqual([]);
});
