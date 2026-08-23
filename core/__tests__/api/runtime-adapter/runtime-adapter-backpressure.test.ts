import { XLN_PROTOCOL_VERSION } from '../../../protocol/version';
import { describe, expect, test } from 'bun:test';

import {
  forgetRuntimeAdapterClient,
  handleRuntimeAdapterMessage,
} from '../../../api/runtime-adapter/server';
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
      { v: XLN_PROTOCOL_VERSION, id: 'bp', op: 'read', path: 'head' },
      createEmptyEnv('adapter-backpressure'),
      { enqueueRuntimeInput: () => {} },
    );
    expect(sent).toEqual([]);
    expect(closes).toEqual([[1013, 'runtime adapter socket backpressure']]);
  });

  test('Bun -1 means queued, so a backpressured response stays connected', async () => {
    const closes: Array<[number | undefined, string | undefined]> = [];
    const sent: unknown[] = [];
    const ws = {
      send: (message: unknown) => {
        sent.push(message);
        return -1;
      },
      close: (code?: number, reason?: string) => {
        closes.push([code, reason]);
      },
      getBufferedAmount: () => 64 * 1024,
    };
    try {
      await handleRuntimeAdapterMessage(
        ws,
        { v: XLN_PROTOCOL_VERSION, id: 'queued', op: 'read', path: 'head' },
        createEmptyEnv('adapter-queued-backpressure'),
        { enqueueRuntimeInput: () => {} },
      );
      expect(sent).toHaveLength(1);
      expect(closes).toEqual([]);
    } finally {
      forgetRuntimeAdapterClient(ws);
    }
  });
});
