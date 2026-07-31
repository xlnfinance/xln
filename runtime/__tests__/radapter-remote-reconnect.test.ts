import { expect, test } from 'bun:test';

import { BRAINVAULT_V1_SPEC_ID } from '../../brainvault/spec';
import {
  decodeRuntimeAdapterBrowserMessage,
  decodeRuntimeAdapterMessage,
  encodeRuntimeAdapterMessage,
} from '../api/runtime-adapter/codec';
import { RemoteRuntimeAdapter } from '../api/runtime-adapter/remote';
import { signRuntimeAdapterServerIdentity } from '../api/runtime-adapter/server-identity-signer';
import type { RuntimeReplica } from '../runtime/types';
import type { CrossJurisdictionSwapRoute } from '../types/cross-jurisdiction';

const decodeTestRuntimeAdapterMessage = <T>(raw: unknown): T =>
  (typeof raw === 'string'
    ? decodeRuntimeAdapterBrowserMessage(raw)
    : decodeRuntimeAdapterMessage(raw)) as unknown as T;

const identityEnv = { runtimeSeed: 'seed' } as RuntimeReplica;

test('remote runtime adapter clears authority before reconnect authentication', async () => {
  const previousWebSocket = globalThis.WebSocket;
  let socket: {
    onmessage: ((event: { data: unknown }) => void) | null;
    onclose: (() => void) | null;
  } | null = null;
  let transportSendCount = 0;
  let deferCloseEvent = false;

  class DelayedAuthWebSocket {
    static readonly OPEN = 1;

    binaryType = 'arraybuffer';
    readyState = 0;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;

    constructor(_url: string) {
      socket = this;
      setTimeout(() => {
        this.readyState = DelayedAuthWebSocket.OPEN;
        this.onopen?.();
      }, 0);
    }

    send(raw: unknown): void {
      transportSendCount += 1;
      const request = decodeTestRuntimeAdapterMessage<{ id: string; op: string; challenge?: string }>(raw);
      if (request.op !== 'auth') return;
      const identity = signRuntimeAdapterServerIdentity(identityEnv, request.challenge || '');
      setTimeout(() => {
        this.onmessage?.({
          data: encodeRuntimeAdapterMessage({
            v: 1,
            inReplyTo: request.id,
            ok: true,
            payload: {
              authLevel: 'admin',
              commandLaneKind: 'capability',
              currentHeight: 10,
              nextCommandSequence: 1,
              commandReady: true,
              commandReadyReason: null,
              ...identity,
            },
          }),
        });
      }, 25);
    }

    close(): void {
      this.readyState = 3;
      if (!deferCloseEvent) this.onclose?.();
    }
  }

  (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket =
    DelayedAuthWebSocket as unknown as typeof WebSocket;
  try {
    const adapter = new RemoteRuntimeAdapter();
    const statuses: string[] = [];
    const heights: number[] = [];
    adapter.onStatus(status => statuses.push(status));
    adapter.onChange(height => heights.push(height));

    const connectPromise = adapter.connect({
      mode: 'remote',
      wsUrl: 'ws://localhost/rpc',
      authKey: 'token',
      reconnectMaxMs: 1_000,
      requestTimeoutMs: 1_000,
    });

    await new Promise(resolve => setTimeout(resolve, 5));
    expect(adapter.status).toBe('connecting');
    expect(statuses).not.toContain('connected');

    await connectPromise;
    expect(adapter.status).toBe('connected');
    expect(adapter.authLevel).toBe('admin');
    expect(adapter.currentHeight).toBe(10);
    expect(adapter.commandReady).toBe(true);
    expect(adapter.commandReadyReason).toBe(null);

    socket?.onmessage?.({
      data: encodeRuntimeAdapterMessage({
        v: 1,
        op: 'tick',
        height: 2,
        commandReady: false,
        commandReadyReason: 'phase=halted',
      }),
    });
    expect(adapter.currentHeight).toBe(2);
    expect(adapter.commandReady).toBe(false);
    expect(adapter.commandReadyReason).toBe('phase=halted');
    expect(heights).toContain(2);
    const sendsBeforeRejectedCommands = transportSendCount;
    expect(() =>
      adapter.send({ runtimeTxs: [], entityInputs: [] }, { commandId: 'command-halted-0001', commandSequence: 1 }),
    ).toThrow('RUNTIME_COMMAND_NOT_READY:phase=halted');
    expect(() => adapter.submitCrossJurisdictionIntent({} as CrossJurisdictionSwapRoute)).toThrow(
      'RUNTIME_COMMAND_NOT_READY:phase=halted',
    );
    expect(transportSendCount).toBe(sendsBeforeRejectedCommands);

    const firstSocket = socket;
    firstSocket?.onclose?.();
    expect(adapter.status).toBe('error');
    expect(adapter.authLevel).toBe(null);
    expect(adapter.commandReady).toBe(false);
    expect(adapter.commandReadyReason).toBe('adapter-error');
    const sendsBeforeSecretRequests = transportSendCount;
    await expect(adapter.deriveBrainVault({
      specId: BRAINVAULT_V1_SPEC_ID,
      name: 'alice',
      passphrase: 'secret123456',
      shardInput: 1,
      workers: 1,
    })).rejects.toThrow('fresh admin auth');
    await expect(adapter.revealBrainVaultMnemonic()).rejects.toThrow('fresh admin auth');
    expect(transportSendCount).toBe(sendsBeforeSecretRequests);

    const reconnectDeadline = Date.now() + 2_000;
    while (socket === firstSocket && Date.now() < reconnectDeadline) {
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    expect(socket).not.toBe(firstSocket);
    expect(adapter.status).toBe('connecting');
    expect(adapter.authLevel).toBe(null);
    const sendsWhileReauthPending = transportSendCount;
    await expect(adapter.revealBrainVaultMnemonic()).rejects.toThrow('fresh admin auth');
    expect(transportSendCount).toBe(sendsWhileReauthPending);

    const reauthDeadline = Date.now() + 1_000;
    while (adapter.status !== 'connected' && Date.now() < reauthDeadline) {
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    expect(adapter.status).toBe('connected');
    expect(adapter.authLevel).toBe('admin');
    firstSocket?.onmessage?.({
      data: encodeRuntimeAdapterMessage({
        v: 1,
        op: 'tick',
        height: 999,
        commandReady: true,
        commandReadyReason: null,
      }),
    });
    firstSocket?.onclose?.();
    expect(adapter.status).toBe('connected');
    expect(adapter.currentHeight).toBe(10);
    expect(adapter.authLevel).toBe('admin');

    deferCloseEvent = true;
    socket?.onmessage?.({ data: 'malformed-server-message' });
    expect(adapter.status).toBe('error');
    expect(adapter.authLevel).toBe(null);
    await expect(adapter.revealBrainVaultMnemonic()).rejects.toThrow('fresh admin auth');
    adapter.disconnect();
    expect(adapter.authLevel).toBe(null);
  } finally {
    (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = previousWebSocket;
  }
});
