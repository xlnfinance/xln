import { afterEach, describe, expect, test } from 'bun:test';
import { deriveSignerAddressSync } from '../account/crypto';
import { decodeRuntimeAdapterRequest, encodeRuntimeAdapterMessageForBrowser } from '../radapter/codec';
import { signRuntimeAdapterServerIdentity } from '../radapter/server-identity-signer';
import type { RuntimeAdapterRequest } from '../radapter/types';
import type { Env } from '../types';
import { DaemonRpcClient } from '../../custody/daemon-client';

const originalWebSocket = globalThis.WebSocket;

afterEach(() => {
  globalThis.WebSocket = originalWebSocket;
});

describe('custody daemon rAdapter transport', () => {
  test('authenticates and reads frame receipts over the canonical binary request codec', async () => {
    const runtimeSeed = 'custody-daemon-wire-test';
    const identityEnv = {
      runtimeSeed,
      runtimeId: deriveSignerAddressSync(runtimeSeed, '1').toLowerCase(),
    } as Env;
    const seenOps: RuntimeAdapterRequest['op'][] = [];

    class CanonicalRuntimeSocket {
      static readonly OPEN = 1;

      binaryType = 'arraybuffer';
      readyState = 0;
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: unknown }) => void) | null = null;
      onerror: ((event: { type: string }) => void) | null = null;
      onclose: (() => void) | null = null;

      constructor(_url: string) {
        queueMicrotask(() => {
          this.readyState = CanonicalRuntimeSocket.OPEN;
          this.onopen?.();
        });
      }

      send(raw: unknown): void {
        let request: RuntimeAdapterRequest;
        try {
          request = decodeRuntimeAdapterRequest(raw);
        } catch {
          this.readyState = 3;
          this.onclose?.();
          return;
        }
        seenOps.push(request.op);
        if (request.op === 'auth') {
          const identity = signRuntimeAdapterServerIdentity(identityEnv, request.challenge);
          queueMicrotask(() => this.onmessage?.({
            data: encodeRuntimeAdapterMessageForBrowser({
              v: 1,
              inReplyTo: request.id,
              ok: true,
              payload: {
                authLevel: 'admin',
                commandLaneKind: 'capability',
                currentHeight: 7,
                nextCommandSequence: 1,
                ...identity,
              },
            }),
          }));
          return;
        }
        if (request.op !== 'read') throw new Error(`unexpected op: ${request.op}`);
        expect(request.path).toBe('frame-receipts');
        queueMicrotask(() => this.onmessage?.({
          data: encodeRuntimeAdapterMessageForBrowser({
            v: 1,
            inReplyTo: request.id,
            ok: true,
            payload: {
              fromHeight: 7,
              toHeight: 7,
              returned: 1,
              receipts: [{ height: 7, timestamp: 700, logs: [] }],
            },
          }),
        }));
      }

      close(): void {
        this.readyState = 3;
        this.onclose?.();
      }
    }

    globalThis.WebSocket = CanonicalRuntimeSocket as unknown as typeof WebSocket;
    const client = new DaemonRpcClient('ws://runtime.invalid/rpc', 'capability');
    const response = await client.getFrameReceipts({ fromHeight: 7, limit: 1 });
    expect(response).toEqual({
      fromHeight: 7,
      toHeight: 7,
      returned: 1,
      receipts: [{ height: 7, timestamp: 700, logs: [] }],
    });
    expect(seenOps).toEqual(['auth', 'read']);
    await client.close();
  });

  test('sends raw HTLC intent on the owner lane and returns hashlock only from its committed event', async () => {
    const runtimeSeed = 'custody-owner-wire-test';
    const runtimeId = deriveSignerAddressSync(runtimeSeed, '1').toLowerCase();
    const sourceEntityId = `0x${'11'.repeat(32)}`;
    const targetEntityId = `0x${'22'.repeat(32)}`;
    const signerId = `0x${'33'.repeat(20)}`;
    const hashlock = `0x${'44'.repeat(32)}`;
    const identityEnv = { runtimeSeed, runtimeId } as Env;
    const seenOps: RuntimeAdapterRequest['op'][] = [];
    let sentInput: RuntimeAdapterRequest | null = null;
    let sendCount = 0;

    class OwnerRuntimeSocket {
      static readonly OPEN = 1;
      binaryType = 'arraybuffer';
      readyState = 0;
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: unknown }) => void) | null = null;
      onerror: ((event: { type: string }) => void) | null = null;
      onclose: (() => void) | null = null;

      constructor(_url: string) {
        queueMicrotask(() => {
          this.readyState = OwnerRuntimeSocket.OPEN;
          this.onopen?.();
        });
      }

      send(raw: unknown): void {
        const request = decodeRuntimeAdapterRequest(raw);
        seenOps.push(request.op);
        let payload: unknown;
        if (request.op === 'auth') {
          expect(request.ownerSignature).toMatch(/^0x[0-9a-f]+$/);
          payload = {
            authLevel: 'admin',
            commandLaneKind: 'owner',
            currentHeight: 7,
            nextCommandSequence: 9,
            ...signRuntimeAdapterServerIdentity(identityEnv, request.challenge),
          };
        } else if (request.op === 'send') {
          sendCount += 1;
          sentInput = request;
          payload = sendCount === 1
            ? {
                height: 7,
                status: 'pending',
                commandSequence: request.commandSequence,
                receipt: {
                  id: 'receipt-1',
                  kind: 'radapter-runtime-input',
                  status: 'pending',
                  counts: { runtimeTxs: 1, entityInputs: 1, jInputs: 0 },
                  enqueuedAt: 1,
                  enqueuedHeight: 7,
                  expiresAt: 10_000,
                },
              }
            : { height: 8, status: 'observed', commandSequence: request.commandSequence };
        } else if (request.path === 'receipt/receipt-1') {
          payload = { status: 'observed' };
        } else {
          expect(request.path).toBe('frame-receipts');
          expect(request.query?.fromHeight).toBe(8);
          payload = {
            fromHeight: 8,
            toHeight: 8,
            returned: 1,
            receipts: [{
              height: 8,
              timestamp: 800,
              logs: [{
                id: 1,
                timestamp: 800,
                level: 'info',
                category: 'system',
                message: 'HtlcInitiated',
                data: {
                  entityId: sourceEntityId,
                  fromEntity: sourceEntityId,
                  toEntity: targetEntityId,
                  tokenId: 1,
                  amount: '25',
                  description: 'custody-withdrawal:wd_owner_test',
                  route: [sourceEntityId, targetEntityId],
                  hashlock,
                  startedAtMs: 700,
                },
              }],
            }],
          };
        }
        queueMicrotask(() => this.onmessage?.({
          data: encodeRuntimeAdapterMessageForBrowser({
            v: 1,
            inReplyTo: request.id,
            ok: true,
            payload,
          }),
        }));
      }

      close(): void {
        this.readyState = 3;
        this.onclose?.();
      }
    }

    globalThis.WebSocket = OwnerRuntimeSocket as unknown as typeof WebSocket;
    const persistedSequences: number[] = [];
    const client = new DaemonRpcClient('ws://runtime.invalid/rpc', 'capability', runtimeSeed);
    const result = await client.queuePayment({
      sourceEntityId,
      signerId,
      targetEntityId,
      tokenId: 1,
      amount: '25',
      description: 'custody-withdrawal:wd_owner_test',
      route: [sourceEntityId, targetEntityId],
      mode: 'htlc',
      commandId: 'custody:wd_owner_test',
      onCommandPrepared: sequence => { persistedSequences.push(sequence); },
    });

    expect(seenOps).toEqual(['auth', 'send', 'read', 'read']);
    expect(persistedSequences).toEqual([9]);
    expect(sentInput?.op).toBe('send');
    if (!sentInput || sentInput.op !== 'send') throw new Error('TEST_SEND_REQUEST_MISSING');
    const payment = sentInput.input.entityInputs[0]?.entityTxs?.[0];
    expect(payment?.type).toBe('htlcPayment');
    if (!payment || payment.type !== 'htlcPayment') throw new Error('TEST_HTLC_PAYMENT_MISSING');
    expect(payment.data.secret).toBeUndefined();
    expect(payment.data.hashlock).toBeUndefined();
    expect(payment.data.startedAtMs).toBeUndefined();
    expect(result).toMatchObject({ hashlock, startedAtMs: 700, commandSequence: 9 });

    const retried = await client.queuePayment({
      sourceEntityId,
      signerId,
      targetEntityId,
      tokenId: 1,
      amount: '25',
      description: 'custody-withdrawal:wd_owner_test',
      route: [sourceEntityId, targetEntityId],
      mode: 'htlc',
      commandId: 'custody:wd_owner_test',
      commandSequence: 9,
    });
    expect(retried).toMatchObject({ hashlock, startedAtMs: 700, commandSequence: 9 });
    expect(sendCount).toBe(2);
    await client.close();
  });
});
