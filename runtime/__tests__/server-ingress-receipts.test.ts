import { describe, expect, test } from 'bun:test';
import type { RuntimeInput } from '../types';
import { createRuntimeIngressReceiptStore } from '../server/ingress-receipts';

describe('runtime ingress receipts', () => {
  test('tracks pending enqueue until the exact runtime input commits', () => {
    let now = 1_000;
    const store = createRuntimeIngressReceiptStore({ ttlMs: 10_000, now: () => now });
    const acceptedInput: RuntimeInput = {
      runtimeTxs: [],
      entityInputs: [{ entityId: 'entity-a', signerId: 'signer-a', entityTxs: [] }],
    };
    const otherInput: RuntimeInput = {
      runtimeTxs: [],
      entityInputs: [{ entityId: 'entity-b', signerId: 'signer-b', entityTxs: [] }],
    };
    const receipt = store.register({
      id: 'req-1',
      kind: 'control',
      counts: { runtimeTxs: 0, entityInputs: 1, jInputs: 0 },
      enqueuedHeight: 7,
      runtimeInput: acceptedInput,
    });

    expect(receipt.status).toBe('pending');
    store.observeRuntimeInput(8, otherInput);
    expect(store.get('req-1')?.status).toBe('pending');
    store.observeRuntimeInput(8, acceptedInput);
    expect(store.get('req-1')).toMatchObject({
      status: 'observed',
      observedHeight: 8,
    });

    now += 20_001;
    expect(store.get('req-1')).toBeNull();
  });

  test('matches committed command fingerprints without delivery metadata', () => {
    const store = createRuntimeIngressReceiptStore({ ttlMs: 10_000, now: () => 1_000 });
    const acceptedInput = {
      runtimeTxs: [],
      entityInputs: [{
        entityId: '0xabc',
        signerId: '0xdef',
        timestamp: 123,
        entityTxs: [{ type: 'profile-update', data: { name: 'H1 Admin E2E' } }],
      }],
    } as unknown as RuntimeInput;
    const committedInput: RuntimeInput = {
      runtimeTxs: [],
      entityInputs: [{
        entityId: '0xABC',
        signerId: '0xDEF',
        entityTxs: [{ type: 'profile-update', data: { name: 'H1 Admin E2E' } }],
      }],
    };

    store.register({
      id: 'req-metadata',
      kind: 'radapter-runtime-input',
      counts: { runtimeTxs: 0, entityInputs: 1, jInputs: 0 },
      enqueuedHeight: 10,
      runtimeInput: acceptedInput,
    });

    store.observeRuntimeInput(11, {
      runtimeTxs: [],
      entityInputs: [{
        entityId: '0xabc',
        signerId: '0xdef',
        entityTxs: [{ type: 'profile-update', data: { name: 'Other' } }],
      }],
    });
    expect(store.get('req-metadata')?.status).toBe('pending');

    store.observeRuntimeInput(12, committedInput);
    expect(store.get('req-metadata')).toMatchObject({
      status: 'observed',
      observedHeight: 12,
    });
  });

  test('expires requests that never reach a later frame', () => {
    let now = 1_000;
    const store = createRuntimeIngressReceiptStore({ ttlMs: 5_000, now: () => now });
    store.register({
      id: 'req-2',
      kind: 'faucet-offchain',
      counts: { runtimeTxs: 0, entityInputs: 1, jInputs: 0 },
      enqueuedHeight: 4,
      runtimeInput: { runtimeTxs: [], entityInputs: [] },
    });

    now += 5_000;
    expect(store.get('req-2')?.status).toBe('expired');
  });
});
