import { expect, test } from 'bun:test';

import { requireExactBoundaryKeys } from '../../protocol/boundary-validation';

test('boundary key errors bound attacker-sized key names', () => {
  // A ~70 KB extra key name went verbatim into the error text; logging or
  // recording it in a relay catch handler threw DEBUG_EVENT_TOO_LARGE and
  // exited the process.
  const value = Object.fromEntries([
    ['k'.repeat(70_000), 1],
    ...Array.from({ length: 20 }, (_, index) => [`extra${index}`, index]),
  ]);
  let message = '';
  try {
    requireExactBoundaryKeys(value, ['id'], [], 'GOSSIP_FIELDS');
  } catch (error) {
    message = (error as Error).message;
  }
  expect(message.length).toBeLessThan(1_000);
  expect(message).toStartWith(`GOSSIP_FIELDS:missing=id:extra=${'k'.repeat(64)}...,extra0,`);
  expect(message).toEndWith(',+13');
  expect(() => requireExactBoundaryKeys({ a: 1, b: 2 }, ['a'], [], 'SMALL'))
    .toThrow('SMALL:missing=none:extra=b');
});
