import { describe, expect, test } from 'bun:test';

import { handleRuntimeAdapterMessage } from '../../../api/runtime-adapter/server';
import { createEmptyEnv } from '../../../runtime';

describe('runtime adapter socket backpressure', () => {
  test('sendResponse and sendPush share the bufferedAmount close guard', async () => {
    const closes: Array<[number | undefined, string | undefined]> = [];
    const sent: unknown[] = [];
    const ws = {
      send: (message: unknown) => {
        sent.push(message);
      },
      close: (code?: number, reason?: string) => {
        closes.push([code, reason]);
      },
      getBufferedAmount: () => 2 * 1024 * 1024 + 1,
    };
    await handleRuntimeAdapterMessage(
      ws,
      { v: 1, id: 'bp', op: 'read', path: 'head' },
      createEmptyEnv('adapter-backpressure'),
      { enqueueRuntimeInput: () => {} },
    );
    expect(sent).toEqual([]);
    expect(closes).toEqual([[1013, 'runtime adapter socket backpressure']]);
  });
});
