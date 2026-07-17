import { describe, expect, test } from 'bun:test';
import type { RuntimeInput } from '../types';
import {
  createRuntimeIngressReceiptStore,
  fingerprintRuntimeIngressInput,
} from '../server/ingress-receipts';

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

  test('observes a raw HTLC command through its immutable server marker after proposer sealing', () => {
    const store = createRuntimeIngressReceiptStore({ ttlMs: 10_000, now: () => 1_000 });
    const marker = {
      type: 'recordRuntimeAdapterCommand' as const,
      data: {
        laneId: `0x${'11'.repeat(32)}`,
        sequence: 1,
        commandId: 'custody-withdrawal-0001',
        inputHash: `0x${'22'.repeat(32)}`,
        expiresAtMs: null,
      },
    };
    const rawPayment = {
      type: 'htlcPayment' as const,
      data: {
        targetEntityId: `0x${'33'.repeat(32)}`,
        tokenId: 1,
        amount: 7n,
        route: [`0x${'44'.repeat(32)}`, `0x${'33'.repeat(32)}`],
      },
    };
    const sealedPayment = {
      type: 'htlcPayment' as const,
      data: {
        ...rawPayment.data,
        hashlock: `0x${'55'.repeat(32)}`,
        preparedEnvelope: { nextHop: `0x${'33'.repeat(32)}`, innerEnvelope: { ciphertext: 'sealed' } },
      },
    };

    store.register({
      id: 'custody-marker-receipt',
      kind: 'radapter-runtime-input',
      counts: { runtimeTxs: 1, entityInputs: 1, jInputs: 0 },
      enqueuedHeight: 10,
      inputFingerprints: fingerprintRuntimeIngressInput({ runtimeTxs: [marker], entityInputs: [] }),
    });
    store.observeRuntimeInput(11, {
      runtimeTxs: [marker],
      entityInputs: [{
        entityId: `0x${'44'.repeat(32)}`,
        signerId: `0x${'66'.repeat(32)}`,
        entityTxs: [sealedPayment],
      }],
    });

    expect(fingerprintRuntimeIngressInput({
      runtimeTxs: [],
      entityInputs: [{
        entityId: `0x${'44'.repeat(32)}`,
        signerId: `0x${'66'.repeat(32)}`,
        entityTxs: [rawPayment],
      }],
    })).not.toEqual(fingerprintRuntimeIngressInput({
      runtimeTxs: [],
      entityInputs: [{
        entityId: `0x${'44'.repeat(32)}`,
        signerId: `0x${'66'.repeat(32)}`,
        entityTxs: [sealedPayment],
      }],
    }));
    expect(store.get('custody-marker-receipt')).toMatchObject({ status: 'observed', observedHeight: 11 });
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
