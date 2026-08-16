import { expect, test } from 'bun:test';

import { listLocalControlEntities } from '../../../api/server/control/entities';
import { PersistentEntityAccountMap } from '../../../entity/state/persistent-account-map';
import { createEmptyEnv } from '../../../runtime';
import type { EntityReplica } from '../../../entity/types';
import { makeAccount } from '../../helpers/cross-j';

const entityId = (byte: string): string => `0x${byte.repeat(32)}`;
const signerId = (byte: string): string => `0x${byte.repeat(20)}`;

test('control entity summary reads committed Patricia Accounts without native Map assumptions', () => {
  const env = createEmptyEnv('control-entities-patricia');
  const owner = entityId('11');
  const counterparty = entityId('22');
  const signer = signerId('33');
  const accounts = PersistentEntityAccountMap.fromEntries(
    [[counterparty, makeAccount(owner, counterparty)]],
    owner,
    () => `0x${'44'.repeat(32)}`,
  );
  env.state.eReplicas.set(`${owner}:${signer}`, {
    entityId: owner,
    signerId: signer,
    entityEncPubKey: '',
    isProposer: true,
    mempool: [],
    state: {
      entityId: owner,
      accounts,
      profile: { name: 'Custody' },
      config: {
        mode: 'proposer-based',
        threshold: 1n,
        validators: [signer],
        shares: { [signer]: 1n },
      },
    },
  } as EntityReplica);

  expect(listLocalControlEntities(env, () => undefined)).toEqual([expect.objectContaining({
    entityId: owner,
    accountCount: 1,
    accountEntityIds: [counterparty],
  })]);
});
