import { expect, test } from 'bun:test';
import { makeAccount, makeState, makeJurisdiction, entity, openWritableEntityAccounts } from '../../../helpers/cross-j';
import { applyAccountTxToMutableReplica } from '../../../../account/tx/apply';
import { applyDirectPaymentForwardFollowups } from '../../../../entity/tx/handlers/account/committed-htlc-followups';
import { PersistentAccountStateMap } from '../../../../account/state/persistent-state-map';
import { createDefaultDelta } from '../../../../account/state/delta';
import { createEmptyEnv } from '../../../../runtime';
import { createAccountConsensusContext } from '../../../../entity/account/account-consensus-context';
import { proposeAccountFrame } from '../../../../account/consensus';
import type { AccountTx } from '../../../../types/account';

const alice = entity('11');
const hub = entity('22');
const bob = entity('33');
const j = makeJurisdiction('test', 31337, '44', '55');

test('fixpay-9 proposal-time capacity loss retains the failed direct payment and reason for its Entity event', async () => {
  const account = makeAccount(alice, hub, j);
  account.mempool.push({
    type: 'direct_payment',
    data: {
      tokenId: 1,
      amount: 10n ** 31n,
      route: [hub],
      fromEntityId: alice,
      toEntityId: hub,
      deliveryMode: 'direct',
    },
  });
  const result = await proposeAccountFrame(createAccountConsensusContext(createEmptyEnv('fixpay-9')), account, 1000, 0);
  expect(account.mempool).toHaveLength(0);
  expect(result.failedDirectPayments?.map(failure => failure.data)).toEqual([
    { tokenId: 1, amount: 10n ** 31n, route: [hub], fromEntityId: alice,
      toEntityId: hub, deliveryMode: 'direct' },
  ]);
  expect(result).toMatchObject({
    outcome: 'idle',
    failedDirectPayments: [
      {
        data: { amount: 10n ** 31n },
        reason: expect.stringContaining('Insufficient capacity'),
      },
    ],
  });
});

test('fixpay-9 a trusted hub retains the committed upstream payment when its direct forward lacks capacity', async () => {
  const upstream = makeAccount(hub, alice, j);
  const downstream = makeAccount(hub, bob, j);
  downstream.state.deltas = PersistentAccountStateMap.fromEntries('deltas', [[1, createDefaultDelta(1)]]);
  const paid = await applyAccountTxToMutableReplica(
    upstream,
    {
      type: 'direct_payment',
      data: {
        tokenId: 1,
        amount: 100n,
        route: [hub, bob],
        fromEntityId: alice,
        toEntityId: hub,
        deliveryMode: 'trusted',
        trustedGatewayEntityId: hub,
      },
    },
    true,
    1000,
    0,
  );
  expect(paid.ok).toBe(true);
  if (!paid.ok) throw new Error('upstream payment failed');
  const forwards = (paid.candidateEffects ?? []).filter(output => output.kind === 'directPaymentForward');
  expect(forwards).toHaveLength(1);
  const state = makeState(hub, entity('66'), j, alice);
  openWritableEntityAccounts(state).set(bob, downstream);
  const accountTxs: Array<{ accountId: string; tx: AccountTx }> = [];
  applyDirectPaymentForwardFollowups({ newState: state, state, accountTxs } as never, forwards);
  const forwarded = accountTxs[0];
  if (!forwarded) throw new Error('forward missing');
  const rejected = await applyAccountTxToMutableReplica(downstream, forwarded.tx, true, 1000, 0);
  expect(rejected.ok).toBe(false);
  // Trusted delivery commits each bilateral leg separately: there is no signed
  // atomic refund authority after the hub has received the upstream payment.
  expect(upstream.state.deltas.get(1)?.offdelta).toBe(-100n);
  expect(downstream.state.deltas.get(1)?.offdelta).toBe(0n);
});

// The public reducer always owns an effect collector, even without caller options.
test('fixpay-9 public Entity reducer preserves the full ordered capacity failure without options', async () => {
  const { applyEntityTx } = await import('../../../../entity/tx/apply');
  const state = makeState(alice, entity('66'), j, hub);
  const result = await applyEntityTx(createEmptyEnv('fixpay-no-options'), state, {
    type: 'directPayment', data: { tokenId: 1, amount: 10n ** 31n,
      targetEntityId: hub, route: [alice, hub], deliveryMode: 'direct' },
  });
  expect(result.accountTxs).toEqual([]);
  expect(result.candidateEffects).toEqual([{ kind: 'runtimeEvent', eventName: 'PaymentFailed',
    data: { entityId: alice, targetEntityId: hub, tokenId: 1, amount: 10n ** 31n,
      reason: 'insufficient_capacity' } }]);
});
