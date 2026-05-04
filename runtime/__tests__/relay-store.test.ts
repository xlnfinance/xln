import { expect, test } from 'bun:test';
import { createRelayStore, enqueueMessage, flushPendingMessages } from '../relay-store';

test('relay pending queue enforces total bytes and target caps', () => {
  const store = createRelayStore('relay-test', {
    pendingLimits: {
      maxPerTarget: 2,
      maxTargets: 2,
      maxTotalBytes: 90,
    },
  });

  expect(enqueueMessage(store, 'runtime-a', { n: 1, payload: 'aaaaa' })).toBe(1);
  expect(enqueueMessage(store, 'runtime-a', { n: 2, payload: 'bbbbb' })).toBe(2);
  expect(enqueueMessage(store, 'runtime-a', { n: 3, payload: 'ccccc' })).toBe(2);
  expect(flushPendingMessages(store, 'runtime-a').map(msg => msg.n)).toEqual([2, 3]);
  expect(store.pendingMessageBytes).toBe(0);

  enqueueMessage(store, 'runtime-a', { payload: 'x'.repeat(20) });
  enqueueMessage(store, 'runtime-b', { payload: 'y'.repeat(20) });
  enqueueMessage(store, 'runtime-c', { payload: 'z'.repeat(20) });
  expect(store.pendingMessages.has('runtime-a')).toBe(false);
  expect(store.pendingMessages.has('runtime-b')).toBe(true);
  expect(store.pendingMessages.has('runtime-c')).toBe(true);

  enqueueMessage(store, 'runtime-d', { payload: 'too-large-for-cap'.repeat(10) });
  expect(store.pendingMessages.has('runtime-d')).toBe(false);
  expect(store.debugEvents.some(event => event.reason === 'PENDING_MESSAGE_TOO_LARGE')).toBe(true);
});
