import { expect, test } from 'bun:test';

import {
  createPaymentTerminalMonitor,
  type PaymentTerminalEvent,
  type PaymentTerminalReadRequest,
  type PaymentTerminalReceiptPage,
} from '../../frontend/src/lib/stores/paymentTerminalMonitor';

const RUNTIME_A = `0x${'11'.repeat(32)}`;
const RUNTIME_B = `0x${'22'.repeat(32)}`;
const ENTITY_A = `0x${'aa'.repeat(32)}`;
const ENTITY_B = `0x${'bb'.repeat(32)}`;

const waitFor = async (predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('TEST_ASYNC_CONDITION_TIMEOUT');
};

const terminalPage = (
  request: PaymentTerminalReadRequest,
  message = 'HtlcFinalized',
  entityId = ENTITY_A,
): PaymentTerminalReceiptPage => ({
  scannedThroughHeight: request.toHeight,
  receipts: [{
    height: request.toHeight,
    logs: [{
      id: request.toHeight,
      message,
      entityId,
      data: { entityId, tokenId: 1, amount: '25000000', hashlock: `0x${'33'.repeat(32)}` },
    }],
  }],
});

test('baselines current height and emits only new exact-entity terminal events', async () => {
  const reads: PaymentTerminalReadRequest[] = [];
  const events: PaymentTerminalEvent[] = [];
  const monitor = createPaymentTerminalMonitor({
    readPage: async (request) => {
      reads.push(request);
      const page = terminalPage(request);
      page.receipts[0]!.logs.push(
        { id: 90, message: 'HtlcReceived', entityId: ENTITY_B, data: { entityId: ENTITY_B } },
        { id: 91, message: 'directPayment', entityId: ENTITY_A, data: { entityId: ENTITY_A } },
        { ...page.receipts[0]!.logs[0] },
      );
      return page;
    },
    onEvent: (event) => events.push(event),
    onError: (error) => { throw error; },
  });

  monitor.observe({ runtimeId: RUNTIME_A, entityId: ENTITY_A, height: 5, connected: true });
  expect(reads).toHaveLength(0);
  monitor.observe({ runtimeId: RUNTIME_A, entityId: ENTITY_A, height: 6, connected: true });
  await waitFor(() => events.length === 1);

  expect(reads).toEqual([{ runtimeId: RUNTIME_A, entityId: ENTITY_A, fromHeight: 6, toHeight: 6 }]);
  expect(events[0]).toMatchObject({ runtimeId: RUNTIME_A, height: 6, name: 'HtlcFinalized' });
  monitor.stop();
});

test('recovers a terminal event from the current frame after observer restart', async () => {
  const events: PaymentTerminalEvent[] = [];
  const cursorStore = new Map<string, number>();
  const createMonitor = () => createPaymentTerminalMonitor({
    readPage: async (request) => terminalPage(request),
    onEvent: (event) => events.push(event),
    onError: (error) => { throw error; },
    cursorStore,
  });

  const oldMonitor = createMonitor();
  oldMonitor.observe({ runtimeId: RUNTIME_A, entityId: ENTITY_A, height: 4, connected: true });
  oldMonitor.stop();

  const restartedMonitor = createMonitor();
  restartedMonitor.observe({ runtimeId: RUNTIME_A, entityId: ENTITY_A, height: 5, connected: true });
  await waitFor(() => events.length === 1);

  expect(events[0]).toMatchObject({ runtimeId: RUNTIME_A, height: 5, name: 'HtlcFinalized' });
  restartedMonitor.stop();
});

test('serializes height bursts and drains them in bounded 500-frame pages', async () => {
  const reads: PaymentTerminalReadRequest[] = [];
  const monitor = createPaymentTerminalMonitor({
    readPage: async (request) => {
      reads.push(request);
      return { scannedThroughHeight: request.toHeight, receipts: [] };
    },
    onEvent: () => undefined,
    onError: (error) => { throw error; },
  });

  monitor.observe({ runtimeId: RUNTIME_A, entityId: ENTITY_A, height: 0, connected: true });
  monitor.observe({ runtimeId: RUNTIME_A, entityId: ENTITY_A, height: 501, connected: true });
  await waitFor(() => reads.length === 2);

  expect(reads.map(({ fromHeight, toHeight }) => [fromHeight, toHeight])).toEqual([[1, 500], [501, 501]]);
  monitor.stop();
});

test('retries a materialization gap without advancing or duplicating the cursor', async () => {
  let reads = 0;
  const events: PaymentTerminalEvent[] = [];
  const monitor = createPaymentTerminalMonitor({
    readPage: async (request) => {
      reads += 1;
      return reads === 1
        ? { scannedThroughHeight: request.fromHeight - 1, receipts: [] }
        : terminalPage(request, 'HtlcReceived');
    },
    onEvent: (event) => events.push(event),
    onError: (error) => { throw error; },
    waitBeforeRetry: async () => undefined,
  });

  monitor.observe({ runtimeId: RUNTIME_A, entityId: ENTITY_A, height: 7, connected: true });
  monitor.observe({ runtimeId: RUNTIME_A, entityId: ENTITY_A, height: 8, connected: true });
  await waitFor(() => events.length === 1);

  expect(reads).toBe(2);
  expect(events[0]?.name).toBe('HtlcReceived');
  monitor.stop();
});

test('retries the remote contiguous-history E_NOT_FOUND race', async () => {
  let reads = 0;
  const events: PaymentTerminalEvent[] = [];
  const monitor = createPaymentTerminalMonitor({
    readPage: async (request) => {
      reads += 1;
      if (reads === 1) throw new Error('E_NOT_FOUND: frame receipt history is unavailable');
      return terminalPage(request);
    },
    onEvent: (event) => events.push(event),
    onError: (error) => { throw error; },
    waitBeforeRetry: async () => undefined,
  });

  monitor.observe({ runtimeId: RUNTIME_A, entityId: ENTITY_A, height: 8, connected: true });
  monitor.observe({ runtimeId: RUNTIME_A, entityId: ENTITY_A, height: 9, connected: true });
  await waitFor(() => events.length === 1);

  expect(reads).toBe(2);
  expect(events[0]?.height).toBe(9);
  monitor.stop();
});

test('discards an in-flight read after the selected runtime changes', async () => {
  let resolveOldRead: ((page: PaymentTerminalReceiptPage) => void) | null = null;
  const events: PaymentTerminalEvent[] = [];
  const monitor = createPaymentTerminalMonitor({
    readPage: (request) => {
      if (request.runtimeId === RUNTIME_A) {
        return new Promise((resolve) => { resolveOldRead = resolve; });
      }
      return Promise.resolve(terminalPage(request, 'HtlcFailed'));
    },
    onEvent: (event) => events.push(event),
    onError: (error) => { throw error; },
  });

  monitor.observe({ runtimeId: RUNTIME_A, entityId: ENTITY_A, height: 1, connected: true });
  monitor.observe({ runtimeId: RUNTIME_A, entityId: ENTITY_A, height: 2, connected: true });
  await waitFor(() => resolveOldRead !== null);
  monitor.observe({ runtimeId: RUNTIME_B, entityId: ENTITY_A, height: 9, connected: true });
  resolveOldRead?.(terminalPage({ runtimeId: RUNTIME_A, entityId: ENTITY_A, fromHeight: 2, toHeight: 2 }));
  await waitFor(() => true);
  expect(events).toHaveLength(0);

  monitor.observe({ runtimeId: RUNTIME_B, entityId: ENTITY_A, height: 10, connected: true });
  await waitFor(() => events.length === 1);
  expect(events[0]).toMatchObject({ runtimeId: RUNTIME_B, name: 'HtlcFailed' });
  monitor.stop();
});

test('preserves the cursor and catches up after a transient disconnect', async () => {
  const reads: PaymentTerminalReadRequest[] = [];
  const events: PaymentTerminalEvent[] = [];
  const monitor = createPaymentTerminalMonitor({
    readPage: async (request) => {
      reads.push(request);
      return terminalPage(request);
    },
    onEvent: (event) => events.push(event),
    onError: (error) => { throw error; },
  });

  monitor.observe({ runtimeId: RUNTIME_A, entityId: ENTITY_A, height: 5, connected: true });
  monitor.observe({ runtimeId: RUNTIME_A, entityId: ENTITY_A, height: 5, connected: false });
  monitor.observe({ runtimeId: RUNTIME_A, entityId: ENTITY_A, height: 6, connected: true });
  await waitFor(() => events.length === 1);

  expect(reads).toEqual([{ runtimeId: RUNTIME_A, entityId: ENTITY_A, fromHeight: 6, toHeight: 6 }]);
  expect(events[0]?.height).toBe(6);
  monitor.stop();
});

test('retries an event that failed while being surfaced', async () => {
  const reads: PaymentTerminalReadRequest[] = [];
  const events: PaymentTerminalEvent[] = [];
  const errors: unknown[] = [];
  let surfaceAttempts = 0;
  const monitor = createPaymentTerminalMonitor({
    readPage: async (request) => {
      reads.push(request);
      return {
        scannedThroughHeight: request.toHeight,
        receipts: [terminalPage({ ...request, toHeight: request.fromHeight }).receipts[0]!],
      };
    },
    onEvent: (event) => {
      surfaceAttempts += 1;
      if (surfaceAttempts === 1) throw new Error('TOKEN_METADATA_READER_UNAVAILABLE');
      events.push(event);
    },
    onError: (error) => errors.push(error),
  });

  monitor.observe({ runtimeId: RUNTIME_A, entityId: ENTITY_A, height: 5, connected: true });
  monitor.observe({ runtimeId: RUNTIME_A, entityId: ENTITY_A, height: 6, connected: true });
  await waitFor(() => errors.length === 1);
  monitor.observe({ runtimeId: RUNTIME_A, entityId: ENTITY_A, height: 7, connected: true });
  await waitFor(() => events.length === 1);

  expect(reads.map(({ fromHeight, toHeight }) => [fromHeight, toHeight])).toEqual([[6, 6], [6, 7]]);
  expect(events[0]?.height).toBe(6);
  monitor.stop();
});

test('fails loudly once after a bounded persistent journal gap', async () => {
  let reads = 0;
  const errors: unknown[] = [];
  const monitor = createPaymentTerminalMonitor({
    readPage: async (request) => {
      reads += 1;
      return { scannedThroughHeight: request.fromHeight - 1, receipts: [] };
    },
    onEvent: () => undefined,
    onError: (error) => errors.push(error),
    waitBeforeRetry: async () => undefined,
    maxGapRetries: 1,
  });

  monitor.observe({ runtimeId: RUNTIME_A, entityId: ENTITY_A, height: 3, connected: true });
  monitor.observe({ runtimeId: RUNTIME_A, entityId: ENTITY_A, height: 4, connected: true });
  await waitFor(() => errors.length === 1);

  expect(reads).toBe(2);
  expect(String(errors[0])).toContain('PAYMENT_TERMINAL_RECEIPT_GAP:4-4');
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(errors).toHaveLength(1);
  monitor.stop();
});
