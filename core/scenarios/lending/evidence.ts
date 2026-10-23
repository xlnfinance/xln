import assert from 'node:assert/strict';
import { computeAccountStateRootCold } from '../../account/commitment/state-root';
import { deriveDelta, isLeftEntity } from '../../account/utils';
import { verifyHankoForHash } from '../../hanko/signing';
import type { RuntimeReplica } from '../../runtime/types';
import type { RegisteredEntity } from '../harness/boot';
import { findReplica } from '../harness/helpers';

export const lendingAccount = (env: RuntimeReplica, owner: RegisteredEntity, peer: RegisteredEntity) => {
  const account = findReplica(env, owner.id)[1].state.accounts.get(peer.id);
  assert(account, `LENDING_SCENARIO_ACCOUNT_MISSING:${owner.name}:${peer.name}`);
  return account;
};

export const lendingBalance = (env: RuntimeReplica, owner: RegisteredEntity, peer: RegisteredEntity) => {
  const account = lendingAccount(env, owner, peer);
  const delta = account.state.deltas.get(1);
  assert(delta);
  assert.equal(delta.collateral, 0n, 'this scenario uses explicitly signed bank IOUs');
  const view = deriveDelta(delta, isLeftEntity(owner.id, peer.id));
  return view.outPeerCredit - view.inOwnCredit;
};

/** Neither a matching balance nor a test title proves bilateral authorization. */
export const assertLendingEvidence = async (
  env: RuntimeReplica,
  bank: RegisteredEntity,
  users: RegisteredEntity[],
): Promise<void> => {
  for (const user of users) {
    const bankAccount = lendingAccount(env, bank, user);
    const userAccount = lendingAccount(env, user, bank);
    assert.equal(computeAccountStateRootCold(bankAccount.state), computeAccountStateRootCold(userAccount.state));
    for (const [owner, peer] of [
      [bank, user],
      [user, bank],
    ]) {
      assert(owner && peer);
      const account = lendingAccount(env, owner, peer);
      assert(!account.pendingFrame && account.mempool.length === 0);
      assert(account.currentFrameHanko && account.counterpartyFrameHanko);
      for (const [hanko, entityId] of [
        [account.currentFrameHanko, owner.id],
        [account.counterpartyFrameHanko, peer.id],
      ] as const) {
        const verified = await verifyHankoForHash(hanko, account.currentFrame.stateHash, entityId, env, {
          observerState: findReplica(env, owner.id)[1].state,
        });
        assert(verified.valid, `LENDING_SCENARIO_INVALID_HANKO:${owner.name}:${entityId}`);
      }
    }
  }
};
