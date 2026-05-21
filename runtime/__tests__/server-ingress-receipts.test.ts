import { describe, expect, test } from 'bun:test';
import { createRuntimeIngressReceiptStore } from '../server/ingress-receipts';

describe('runtime ingress receipts', () => {
  test('tracks pending enqueue until the runtime height advances', () => {
    let now = 1_000;
    const store = createRuntimeIngressReceiptStore({ ttlMs: 10_000, now: () => now });
    const receipt = store.register({
      id: 'req-1',
      kind: 'control',
      counts: { runtimeTxs: 0, entityInputs: 1, jInputs: 0 },
      enqueuedHeight: 7,
    });

    expect(receipt.status).toBe('pending');
    store.observeHeight(7);
    expect(store.get('req-1')?.status).toBe('pending');
    store.observeHeight(8);
    expect(store.get('req-1')).toMatchObject({
      status: 'observed',
      observedHeight: 8,
    });

    now += 20_001;
    expect(store.get('req-1')).toBeNull();
  });

  test('expires requests that never reach a later frame', () => {
    let now = 1_000;
    const store = createRuntimeIngressReceiptStore({ ttlMs: 5_000, now: () => now });
    store.register({
      id: 'req-2',
      kind: 'faucet-offchain',
      counts: { runtimeTxs: 0, entityInputs: 1, jInputs: 0 },
      enqueuedHeight: 4,
    });

    now += 5_000;
    expect(store.get('req-2')?.status).toBe('expired');
  });
});
