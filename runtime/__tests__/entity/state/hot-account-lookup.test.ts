import { describe, expect, test } from 'bun:test';

import type { AccountReplica } from '../../../types/account';
import { PersistentEntityAccountMap } from '../../../entity/state/persistent-account-map';
import { isReliableAccountAckAwaitingCommit } from '../../../runtime/reliable/reliable-authority';
import type { EntityReplica } from '../../../entity/types';
import type { ReliableDeliveryIdentity, RuntimeReplica } from '../../../runtime/types';
import { makeAccount } from '../../helpers/cross-j';

const id = (suffix: string): string => `0x${suffix.padStart(64, '0')}`;
const hash = (value: AccountReplica): string =>
  `0x${String((value as unknown as { marker: number }).marker).padStart(64, '0')}`;
const account = (marker: number): AccountReplica => {
  const value = makeAccount(id('11'), id('22'));
  Reflect.set(value, 'marker', marker);
  value.currentHeight = 1;
  value.pendingFrame = { ...value.currentFrame, height: 2, stateHash: `0x${'ab'.repeat(32)}` };
  return value;
};

describe('hot keyed Account/replica lookups', () => {
  test('Account get does not iterate sibling leaves', () => {
    const target = id('22');
    const decoys = Array.from({ length: 1_000 }, (_, index) => [id(`d${index.toString(16)}`), account(index)] as const);
    const accounts = PersistentEntityAccountMap.fromMap(
      new Map([[target, account(99)], ...decoys]),
      id('11'),
      hash,
    );
    expect(accounts.get(target.toUpperCase())?.state.rightEntity).toBe(id('22'));
    expect((accounts.get(target) as unknown as { marker: number }).marker).toBe(99);
  });

  test('reliable replica+account lane lookup uses raw ids, not values().find', () => {
    const entityId = id('11');
    const signerId = `0x${'aa'.repeat(20)}`;
    const counterparty = id('22');
    const replica = {
      entityId,
      signerId,
      state: {
        entityId,
        accounts: PersistentEntityAccountMap.fromMap(
          new Map([[counterparty, account(1)]]),
          entityId,
          hash,
        ),
      },
    } as unknown as EntityReplica;
    const eReplicas = new class extends Map<string, EntityReplica> {
      override values(): MapIterator<EntityReplica> {
        throw new Error('EREPLICAS_SCANNED');
      }
      override entries(): MapIterator<[string, EntityReplica]> {
        throw new Error('EREPLICAS_SCANNED');
      }
    }([[`${entityId}:${signerId}`, replica]]);
    const env = { state: { eReplicas } } as unknown as RuntimeReplica;
    const identity = {
      kind: 'account-ack',
      entityId,
      signerId,
      height: 2,
      frameHash: `0x${'ab'.repeat(32)}`,
      laneKey: JSON.stringify({
        kind: 'account-ack',
        entityId,
        signerId,
        scope: [entityId, counterparty],
      }),
    } as unknown as ReliableDeliveryIdentity;
    expect(isReliableAccountAckAwaitingCommit(env, identity)).toBe(true);
  });
});
