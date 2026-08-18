import { expect, test } from 'bun:test';

import { attachHankoWitnessToOutputs } from '../../../entity/consensus/input/hanko-witness';
import type { EntityOutput } from '../../../entity/types';
import type { AccountInput } from '../../../types/account';

test('post-commit Hanko attachment isolates a readonly Account output payload', () => {
  const frameHash = `0x${'11'.repeat(32)}`;
  const hanko = 'test-hanko';
  const input: Extract<AccountInput, { kind: 'ack' }> = {
    kind: 'ack',
    fromEntityId: `0x${'22'.repeat(32)}`,
    toEntityId: `0x${'33'.repeat(32)}`,
    domain: {
      chainId: 31337,
      depositoryAddress: `0x${'44'.repeat(20)}`,
    },
    disputeConfig: { leftResponseSeconds: 3_600, rightResponseSeconds: 86_400 },
    ack: Object.freeze({ height: 1, frameHash }),
  };
  Object.freeze(input);
  const output: EntityOutput = {
    entityId: input.toEntityId,
    entityTxs: [{ type: 'accountInput', data: input }],
  };
  const readonlyAccount = Object.freeze({
    currentFrame: Object.freeze({ height: 1, stateHash: frameHash }),
  });

  expect(attachHankoWitnessToOutputs(
    [output],
    [],
    new Map([[frameHash, {
      hanko,
      type: 'accountFrame',
      entityHeight: 1,
      createdAt: 1,
    }]]),
    1,
    { accounts: new Map([[input.toEntityId, readonlyAccount]]) } as never,
  )).toBe(1);

  const sealed = output.entityTxs?.[0];
  if (sealed?.type !== 'accountInput' || sealed.data.kind !== 'ack') {
    throw new Error('TEST_SEALED_ACCOUNT_ACK_REQUIRED');
  }
  expect(sealed.data).not.toBe(input);
  expect(sealed.data.ack.frameHanko).toBe(hanko);
  expect(input.ack.frameHanko).toBeUndefined();
});
