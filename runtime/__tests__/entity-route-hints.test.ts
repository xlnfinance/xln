import { expect, test } from 'bun:test';

import { collectAppliedAccountSenderHints } from '../machine/entity-inputs';
import type { RoutedEntityInput } from '../types';

const entityId = (byte: string): string => `0x${byte.repeat(32)}`;
const signerId = (byte: string): string => `0x${byte.repeat(20)}`;

test('certified nested account input restores its authenticated sender route', () => {
  const localEntityId = entityId('11');
  const remoteEntityId = entityId('22');
  const input = {
    entityId: localEntityId,
    signerId: signerId('33'),
    from: signerId('44'),
    entityTxs: [{
      type: 'consensusOutput',
      data: {
        targetEntityId: localEntityId,
        entityTxs: [{
          type: 'accountInput',
          data: { fromEntityId: remoteEntityId, toEntityId: localEntityId },
        }],
      },
    }],
  } as RoutedEntityInput;

  expect(collectAppliedAccountSenderHints(input)).toEqual([remoteEntityId]);
});
