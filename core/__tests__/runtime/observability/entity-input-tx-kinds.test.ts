import { expect, test } from 'bun:test';

import { countEntityInputTxKinds } from '../../../runtime/frame/process-profile';
import type { EntityInput } from '../../../entity/types';
import type { EntityTx } from '../../../types/entity-tx';

const entityId = `0x${'11'.repeat(32)}`;
const signerId = `0x${'22'.repeat(20)}`;
const fromA = `0x${'aa'.repeat(20)}`;
const fromB = `0x${'bb'.repeat(20)}`;
const frameHash = `0x${'33'.repeat(32)}`;

const input = (from: string, entityTxs: EntityTx[]): EntityInput => ({
  entityId,
  signerId,
  from,
  entityTxs,
});

test('FRAME_LOG histogram splits raw AccountInput kinds from Entity transactions', () => {
  const ack = {
    type: 'accountInput',
    data: { kind: 'ack', fromEntityId: entityId, toEntityId: entityId, ack: { height: 1, frameHash } },
  } as EntityTx;
  const proposal = {
    type: 'accountInput',
    data: { kind: 'frame', fromEntityId: entityId, toEntityId: entityId, proposal: { frame: { height: 2 } } },
  } as EntityTx;
  const counted = countEntityInputTxKinds([
    input(fromA, [ack, proposal]),
    input(fromB, [{ type: 'chat', data: { from: signerId, message: 'hi' } }]),
  ]);
  expect(counted.senders).toBe(2);
  expect(counted.txKinds).toEqual({
    'accountInput:ack': 1,
    'accountInput:frame': 1,
    chat: 1,
  });
});
