import { expect, test } from 'bun:test';

import { BRAINVAULT_V1_SPEC_ID } from '../../brainvault/spec';
import {
  createPaymentTerminalMonitor,
  PAYMENT_TERMINAL_EVENT_NAMES,
} from '../../frontend/src/lib/stores/paymentTerminalMonitor';
import {
  decodeRuntimeAdapterBrowserMessage,
  decodeRuntimeAdapterMessage,
  encodeRuntimeAdapterMessage,
} from '../api/runtime-adapter/codec';
import { RemoteRuntimeAdapter } from '../api/runtime-adapter/remote';
import { signRuntimeAdapterServerIdentity } from '../api/runtime-adapter/server-identity-signer';
import type { RuntimeAdapterFrameReceipt, RuntimeAdapterFrameReceiptResponse } from '../api/runtime-adapter/types';
import type { RuntimeReplica } from '../runtime/types';
import type { CrossJurisdictionSwapRoute } from '../types/cross-jurisdiction';

const decodeTestRuntimeAdapterMessage = <T>(raw: unknown): T =>
  (typeof raw === 'string'
    ? decodeRuntimeAdapterBrowserMessage(raw)
    : decodeRuntimeAdapterMessage(raw)) as unknown as T;

const identityEnv = { runtimeSeed: 'seed' } as RuntimeReplica;
const ENTITY_A = `0x${'aa'.repeat(32)}`;
const ENTITY_B = `0x${'bb'.repeat(32)}`;
type TestSocket = {
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
};

const terminalReceipt = (
  height: number,
  message: 'HtlcFinalized' | 'HtlcReceived' | 'HtlcFailed',
  entityIds = [ENTITY_A],
): RuntimeAdapterFrameReceipt => ({
  height,
  timestamp: height,
  logs: entityIds.map((entityId, id) => ({
    id, timestamp: height, level: 'info', category: 'payment', message, entityId,
    data: { entityId },
  })),
});

const pushTick = (
  socket: TestSocket | null,
  height: number,
  commandReady = true,
  commandReadyReason: string | null = null,
): void => socket?.onmessage?.({ data: encodeRuntimeAdapterMessage({
  v: 1, op: 'tick', height, commandReady, commandReadyReason,
}) });

const waitFor = async (predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error('TEST_ASYNC_CONDITION_TIMEOUT');
};

test('remote adapter refreshes authority and catches up durable payments across reconnect', async () => {
  const previousWebSocket = globalThis.WebSocket;
  let socket: TestSocket | null = null;
  let transportSendCount = 0;
  let deferCloseEvent = false;
  let serverHeight = 10;
  const serverReceipts = new Map<number, RuntimeAdapterFrameReceipt>();
  const receiptReadRanges: Array<[number, number]> = [];

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
      const request = decodeTestRuntimeAdapterMessage<{
        id: string;
        op: string;
        challenge?: string;
        query?: { fromHeight?: number; toHeight?: number };
      }>(raw);
      if (request.op === 'read') {
        const fromHeight = Number(request.query?.fromHeight);
        const toHeight = Number(request.query?.toHeight);
        const receipts = [...serverReceipts.values()]
          .filter(receipt => receipt.height >= fromHeight && receipt.height <= toHeight);
        receiptReadRanges.push([fromHeight, toHeight]);
        this.respond(request.id, { fromHeight, toHeight, returned: receipts.length, receipts });
        return;
      }
      if (request.op !== 'auth') return;
      const identity = signRuntimeAdapterServerIdentity(identityEnv, request.challenge || '');
      this.respond(request.id, {
        authLevel: 'admin',
        commandLaneKind: 'capability',
        currentHeight: serverHeight,
        nextCommandSequence: 1,
        commandReady: true,
        commandReadyReason: null,
        ...identity,
      }, 25);
    }

    private respond(inReplyTo: string, payload: unknown, delay = 0): void {
      setTimeout(() => this.onmessage?.({ data: encodeRuntimeAdapterMessage({
        v: 1, inReplyTo, ok: true, payload,
      }) }), delay);
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

    pushTick(socket, 2, false, 'phase=halted');
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

    await waitFor(() => socket !== firstSocket);
    expect(socket).not.toBe(firstSocket);
    expect(adapter.status).toBe('connecting');
    expect(adapter.authLevel).toBe(null);
    const sendsWhileReauthPending = transportSendCount;
    await expect(adapter.revealBrainVaultMnemonic()).rejects.toThrow('fresh admin auth');
    expect(transportSendCount).toBe(sendsWhileReauthPending);

    await waitFor(() => adapter.status === 'connected');
    expect(adapter.status).toBe('connected');
    expect(adapter.authLevel).toBe('admin');
    pushTick(firstSocket, 999);
    firstSocket?.onclose?.();
    expect(adapter.status).toBe('connected');
    expect(adapter.currentHeight).toBe(10);
    expect(adapter.authLevel).toBe('admin');

    const terminalEvents: Array<[number, string]> = [];
    const createMonitor = () => createPaymentTerminalMonitor({
      readPage: ({ fromHeight, toHeight, entityId }) =>
        adapter.read<RuntimeAdapterFrameReceiptResponse>('frame-receipts', {
          fromHeight,
          toHeight,
          limit: 500,
          entityId,
          eventNames: [...PAYMENT_TERMINAL_EVENT_NAMES],
        }).then(page => ({ scannedThroughHeight: page.toHeight, receipts: page.receipts })),
      onEvent: event => terminalEvents.push([event.height, event.name]),
      onError: error => { throw error; },
    });
    let monitor = createMonitor();
    const syncMonitor = () => monitor.observe({
      runtimeId: adapter.runtimeId,
      entityId: ENTITY_A,
      height: adapter.currentHeight,
      connected: adapter.status === 'connected',
    });
    const stopMonitorSync = [adapter.onStatus(syncMonitor), adapter.onChange(syncMonitor)];
    syncMonitor();
    expect(receiptReadRanges).toHaveLength(0);

    serverReceipts.set(11, terminalReceipt(11, 'HtlcFinalized', [ENTITY_A, ENTITY_B]));
    serverHeight = 11;
    pushTick(socket, serverHeight);
    await waitFor(() => terminalEvents.length === 1);
    expect(terminalEvents).toEqual([[11, 'HtlcFinalized']]);

    for (const [height, message] of [[12, 'HtlcReceived'], [13, 'HtlcFailed']] as const) {
      serverReceipts.set(height, terminalReceipt(height, message));
    }
    serverHeight = 13;
    const socketBeforePaymentGap = socket;
    socketBeforePaymentGap?.onclose?.();
    await waitFor(() => adapter.status === 'connected' && socket !== socketBeforePaymentGap);
    await waitFor(() => terminalEvents.length === 3);
    expect(receiptReadRanges).toEqual([[11, 11], [12, 13]]);
    expect(terminalEvents.map(([height]) => height)).toEqual([11, 12, 13]);

    monitor.stop();
    monitor = createMonitor();
    syncMonitor();
    expect(receiptReadRanges).toHaveLength(2);
    serverReceipts.set(14, terminalReceipt(14, 'HtlcFinalized'));
    serverHeight = 14;
    pushTick(socket, serverHeight);
    await waitFor(() => terminalEvents.length === 4);
    expect(receiptReadRanges).toEqual([[11, 11], [12, 13], [14, 14]]);
    expect(terminalEvents.at(-1)?.[0]).toBe(14);
    monitor.stop();
    stopMonitorSync.forEach(stop => stop());

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
