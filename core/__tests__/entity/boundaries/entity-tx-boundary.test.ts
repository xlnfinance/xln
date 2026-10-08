import { expect, test } from 'bun:test';

import { applyEntityTx } from '../../../entity/tx/apply';
import type { EntityState } from '../../../entity/types';
import type { RuntimeReplica } from '../../../runtime/types';
import type { EntityTx } from '../../../types/entity-tx';

test('Entity reducer rejects a missing transaction as a programming fault', async () => {
  await expect(applyEntityTx(
    {} as RuntimeReplica,
    {} as EntityState,
    undefined as unknown as EntityTx,
  )).rejects.toThrow('ENTITY_TX_UNDEFINED');
});


test('negative settle_propose rejects its atomic signed command while separate healthy commands preserve financial state', async () => {
  const { createEntityProposalFixture } = await import('../../helpers/entity-proposal-fixture');
  const { makeState, makeJurisdiction, entity } = await import('../../helpers/cross-j');
  const { safeStringify } = await import('../../../protocol/serialization');
  const { applyEntityInput } = await import('../../../entity/consensus');
  const fixture = createEntityProposalFixture('negative-settlement-per-tx-reject', 1n, ['1']);
  const target = fixture.createValidator('1');
  const self = fixture.entityId;
  const peer = entity('22');
  target.replica.state = makeState(self, target.signerId, makeJurisdiction('reject', 31337, 'a1', 'b2'), peer);
  target.replica.state.reserves.set(1, 100n);
  target.env.state.eReplicas.set(`${self}:${target.signerId}`, target.replica);
  const financial = (value: EntityState) => safeStringify({
    reserves: [...value.reserves], nonces: [...value.nonces], jBatchState: value.jBatchState,
    account: value.accounts.get(peer)?.state, continuations: value.settlementContinuations,
  });
  const before = financial(target.replica.state);
  const invalid: EntityTx = { type: 'settle_propose', data: {
    counterpartyEntityId: peer, ops: [{ type: 'r2r', tokenId: 1, amount: -1n }],
  } };
  const profileBefore: EntityTx = { type: 'profile-update', data: {
    profile: { entityId: self, name: 'before invalid settlement' },
  } };
  const profileAfter: EntityTx = { type: 'profile-update', data: {
    profile: { entityId: self, bio: 'after invalid settlement' },
  } };
  const input = (entityTxs: EntityTx[]) => ({ entityId: self, signerId: target.signerId, entityTxs });
  const original = safeStringify(target.replica.state);
  // One signed command is atomic: rejecting its action must not retain inner profile writes.
  await expect(applyEntityInput(target.env, target.replica, input([profileBefore, invalid, profileAfter])))
    .rejects.toMatchObject({ disposition: 'reject', rejection: 'SETTLEMENT_WORKSPACE_AMOUNT_INVALID:index=0' });
  expect(safeStringify(target.replica.state)).toBe(original);
  const first = await applyEntityInput(target.env, target.replica, input([profileBefore]));
  expect(first.workingReplica.state.profile.name).toBe('before invalid settlement');
  const afterFirst = safeStringify(first.workingReplica.state);
  await expect(applyEntityInput(target.env, first.workingReplica, input([invalid])))
    .rejects.toMatchObject({ disposition: 'reject', rejection: 'SETTLEMENT_WORKSPACE_AMOUNT_INVALID:index=0' });
  expect(safeStringify(first.workingReplica.state)).toBe(afterFirst);
  const last = await applyEntityInput(target.env, first.workingReplica, input([profileAfter]));
  const state = last.workingReplica.state;
  expect(state.profile.name).toBe('before invalid settlement');
  expect(state.profile.bio).toBe('after invalid settlement');
  expect(financial(state)).toBe(before);
  expect(state.accounts.get(peer)?.state.settlementWorkspace).toBeUndefined();
});
