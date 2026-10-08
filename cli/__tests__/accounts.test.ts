import { expect, test } from 'bun:test';
import { createEmptyEnv, deriveDelta } from '../../core/runtime';
import { addReplica, entity, makeAccount, makeJurisdiction, makeState, openWritableEntityAccounts } from '../../core/__tests__/helpers/cross-j';
import { findAccount, listAccountViews } from '../lib/accounts';

test('CLI reads canonical persistent Account and delta maps after opening an Account', () => {
  const owner = entity('11');
  const hub = entity('22');
  const signer = `0x${'44'.repeat(20)}`;
  const jurisdiction = makeJurisdiction('cli-account-view', 31_337, '55', '66');
  const state = makeState(owner, signer, jurisdiction);
  const account = makeAccount(owner, hub, jurisdiction);
  openWritableEntityAccounts(state).set(hub, account);
  const env = createEmptyEnv('cli-account-view');
  addReplica(env, state, signer);
  expect(findAccount(env, owner, hub)).toBeDefined();
  const views = listAccountViews(env, owner, 'closed', false);
  expect(views).toHaveLength(1);
  expect(views[0]!.counterpartyId).toBe(hub);
  expect(views[0]!.tokens).toHaveLength(1);
  const delta = account.state.deltas.get(1)!;
  const expected = deriveDelta(delta, true);
  expect(views[0]!.tokens[0]).toMatchObject({
    tokenId: 1,
    outCapacity: expected.outCapacity,
    inCapacity: expected.inCapacity,
    collateral: expected.collateral,
    delta: expected.delta,
  });
  expect(findAccount(env, owner, entity('33'))).toBeNull();
});
