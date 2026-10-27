import { expect, test } from 'bun:test';
import { collectDerivedDeadlines, earliestDerivedDeadline } from '../../../entity/scheduler/derived-deadlines';
import { PersistentAccountStateMap } from '../../../account/state/persistent-state-map';
import { entity, addr, makeJurisdiction, makeState, getTestAccountForWrite } from '../../helpers/cross-j';
import { hashHtlcSecret } from '../../../protocol/htlc/utils';
import { createEmptyEnv } from '../../../runtime';
import { createAccountConsensusContext } from '../../../entity/account/account-consensus-context';
import { proposeAccountFrame } from '../../../account/consensus';
import { applyAccountTxToMutableReplica } from '../../../account/tx/apply';

const SELF = entity('11');
const PEER = entity('22');
const HASHLOCK = hashHtlcSecret(entity('77'));

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

test.each([false, true])('withheld ACK retains the 70s reserve with a pending proposal=%s', async proposed => {
  const { state, account } = fixture();
  account.state.locks = PersistentAccountStateMap.empty('locks');
  const locked = await applyAccountTxToMutableReplica(account, { type: 'htlc_lock',
    data: { lockId: HASHLOCK, hashlock: HASHLOCK, tokenId: 1, amount: 10n,
      timelock: 100_000n, revealBeforeHeight: 100 } }, false, 100, 90);
  expect(locked.ok).toBe(true);
  state.timestamp = 50_000;
  state.lastFinalizedJHeight = 101;
  const tx = { type: 'htlc_resolve' as const,
    data: { lockId: HASHLOCK, outcome: 'secret' as const, secret: entity('77') } };
  account.mempool.push(tx);
  if (proposed) {
    const env = createEmptyEnv('withheld-secret-ack');
    const depository = account.state.domain.depositoryAddress;
    env.state.jReplicas.set('deadline', { name: 'deadline', chainId: 31337,
      depositoryAddress: depository, contracts: { depository, entityProvider: addr('55'),
        account: addr('66'), deltaTransformer: addr('77') }, blockNumber: 90n, stateRoot: null,
      mempool: [], blockDelayMs: 0, lastBlockTimestamp: 100, position: { x: 0, y: 0, z: 0 } });
    const result = await proposeAccountFrame(createAccountConsensusContext(env), account, 100, 90);
    expect(result.outcome).toBe('proposed');
    expect(account.pendingAccountInput?.proposal?.frame.accountTxs).toEqual([tx]);
    expect(account.state.locks.has(HASHLOCK)).toBe(true);
  }
  state.paybook.entries.set(HASHLOCK, { hashlock: HASHLOCK, tokenId: 1, amount: 10n,
    inboundEntity: PEER, createdTimestamp: 100, secret: entity('77'), secretAckPending: true,
    secretAckStartedAt: 100, secretAckDeadlineAt: 170_000 });
  expect(collectDerivedDeadlines(state, 50_000)).toEqual([]);
  expect(earliestDerivedDeadline(state)).toBe(70_000);
  expect(collectDerivedDeadlines(state, 70_000)).toEqual([
    { id: `htlc-secret-ack:${HASHLOCK}`, triggerAt: 70_000, type: 'htlc_secret_ack_timeout',
      data: { hashlock: HASHLOCK, counterpartyEntityId: PEER } },
  ]);
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
