export const PAYMENT_TERMINAL_EVENT_NAMES = [
  'HtlcFinalized',
  'HtlcReceived',
  'HtlcFailed',
] as const;

export type PaymentTerminalEventName = typeof PAYMENT_TERMINAL_EVENT_NAMES[number];

export type PaymentTerminalLog = {
  id: number;
  message: string;
  entityId?: string;
  data?: Record<string, unknown>;
};

export type PaymentTerminalReceipt = {
  height: number;
  logs: PaymentTerminalLog[];
};

export type PaymentTerminalReceiptPage = {
  scannedThroughHeight: number;
  receipts: PaymentTerminalReceipt[];
};

export type PaymentTerminalEvent = {
  runtimeId: string;
  height: number;
  name: PaymentTerminalEventName;
  data: Record<string, unknown>;
};

export type PaymentTerminalObservation = {
  runtimeId: string;
  entityId: string;
  height: number;
  connected: boolean;
};

export type PaymentTerminalReadRequest = {
  runtimeId: string;
  entityId: string;
  fromHeight: number;
  toHeight: number;
};

type PaymentTerminalMonitorDeps = {
  readPage: (request: PaymentTerminalReadRequest) => Promise<PaymentTerminalReceiptPage>;
  onEvent: (event: PaymentTerminalEvent) => void;
  onError: (error: unknown) => void;
  cursorStore?: Map<string, number>;
  waitBeforeRetry?: () => Promise<void>;
  isRetryableGapError?: (error: unknown) => boolean;
  maxGapRetries?: number;
};

// A View can be recreated while a durable frame read is in flight. Its
// successor must resume the last unconsumed frame instead of baselining past it.
export const sharedPaymentTerminalCursorStore = new Map<string, number>();

const PAGE_SIZE = 500;
const DEFAULT_MAX_GAP_RETRIES = 20;
const DEFAULT_RETRY_MS = 100;
const ENTITY_ID_RE = /^0x[0-9a-f]{64}$/;

const normalizeId = (value: unknown): string => String(value || '').trim().toLowerCase();

const isTerminalEventName = (value: unknown): value is PaymentTerminalEventName =>
  PAYMENT_TERMINAL_EVENT_NAMES.includes(value as PaymentTerminalEventName);

const logMatchesEntity = (log: PaymentTerminalLog, entityId: string): boolean => {
  const hintedEntityId = normalizeId(log.entityId ?? log.data?.['entityId']);
  return hintedEntityId === entityId;
};

const terminalEventKey = (
  runtimeId: string,
  receipt: PaymentTerminalReceipt,
  log: PaymentTerminalLog,
): string => `${runtimeId}:${receipt.height}:${log.id}:${log.message}`;

const defaultWaitBeforeRetry = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, DEFAULT_RETRY_MS));

const defaultIsRetryableGapError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error || '');
  return /E_NOT_FOUND|frame receipt history is unavailable|PAYMENT_TERMINAL_RECEIPT_GAP/i.test(message);
};

const terminalEventFromLog = (
  runtimeId: string,
  entityId: string,
  receipt: PaymentTerminalReceipt,
  log: PaymentTerminalLog,
): PaymentTerminalEvent | null => {
  if (!isTerminalEventName(log.message) || !logMatchesEntity(log, entityId)) return null;
  return {
    runtimeId,
    height: receipt.height,
    name: log.message,
    data: log.data && typeof log.data === 'object' ? log.data : {},
  };
};

class PaymentTerminalMonitor {
  private readonly waitBeforeRetry: () => Promise<void>;
  private readonly isRetryableGapError: (error: unknown) => boolean;
  private readonly maxGapRetries: number;
  private readonly cursorStore: Map<string, number>;
  private readonly seenEventKeys = new Set<string>();
  private generation = 0;
  private activeKey = '';
  private activeRuntimeId = '';
  private activeEntityId = '';
  private nextHeight = 1;
  private targetHeight = 0;
  private draining = false;
  private paused = true;

  constructor(private readonly deps: PaymentTerminalMonitorDeps) {
    this.waitBeforeRetry = deps.waitBeforeRetry ?? defaultWaitBeforeRetry;
    this.isRetryableGapError = deps.isRetryableGapError ?? defaultIsRetryableGapError;
    this.maxGapRetries = deps.maxGapRetries ?? DEFAULT_MAX_GAP_RETRIES;
    this.cursorStore = deps.cursorStore ?? new Map<string, number>();
  }

  observe(observation: PaymentTerminalObservation): void {
    const runtimeId = normalizeId(observation.runtimeId);
    const entityId = normalizeId(observation.entityId);
    const height = Math.max(0, Math.floor(Number(observation.height || 0)));
    const valid = observation.connected && Boolean(runtimeId) && ENTITY_ID_RE.test(entityId);
    if (!valid) {
      this.pause();
      return;
    }
    this.paused = false;
    const key = `${runtimeId}:${entityId}`;
    if (key !== this.activeKey || height < this.nextHeight - 1) {
      this.reset({ ...observation, runtimeId, entityId, height });
      this.startDrain();
      return;
    }
    this.targetHeight = Math.max(this.targetHeight, height);
    this.startDrain();
  }

  stop(): void {
    this.reset();
  }

  private reset(observation?: PaymentTerminalObservation): void {
    this.generation += 1;
    this.seenEventKeys.clear();
    this.activeRuntimeId = normalizeId(observation?.runtimeId);
    this.activeEntityId = normalizeId(observation?.entityId);
    this.activeKey = observation ? `${this.activeRuntimeId}:${this.activeEntityId}` : '';
    const height = Math.max(0, Math.floor(Number(observation?.height || 0)));
    const storedNextHeight = this.activeKey ? this.cursorStore.get(this.activeKey) : undefined;
    this.nextHeight = Math.max(1, Math.min(storedNextHeight ?? height + 1, height + 1));
    this.targetHeight = height;
    this.paused = !observation;
    if (this.activeKey) this.rememberCursor(this.nextHeight);
  }

  private pause(): void {
    if (!this.paused) this.generation += 1;
    this.paused = true;
  }

  private startDrain(): void {
    if (this.paused || this.draining || this.nextHeight > this.targetHeight) return;
    void this.drain(this.generation);
  }

  private async drain(expectedGeneration: number): Promise<void> {
    this.draining = true;
    let failed = false;
    try {
      while (this.generation === expectedGeneration && this.nextHeight <= this.targetHeight) {
        if (!await this.readCurrentPage(expectedGeneration)) return;
      }
    } catch (error) {
      failed = true;
      if (this.generation === expectedGeneration) this.deps.onError(error);
    } finally {
      this.draining = false;
      if (!failed || this.generation !== expectedGeneration) this.startDrain();
    }
  }

  private async readCurrentPage(expectedGeneration: number): Promise<boolean> {
    const pageEnd = Math.min(this.targetHeight, this.nextHeight + PAGE_SIZE - 1);
    for (let attempt = 0; this.generation === expectedGeneration; attempt += 1) {
      const page = await this.tryReadPage(pageEnd, attempt);
      if (!page || this.generation !== expectedGeneration) return false;
      if (page.scannedThroughHeight >= pageEnd) {
        this.emitPageEvents(page, expectedGeneration);
        this.nextHeight = pageEnd + 1;
        this.rememberCursor(this.nextHeight);
        return true;
      }
      if (attempt >= this.maxGapRetries) {
        throw new Error(`PAYMENT_TERMINAL_RECEIPT_GAP:${this.nextHeight}-${pageEnd}`);
      }
      await this.waitBeforeRetry();
    }
    return false;
  }

  private async tryReadPage(pageEnd: number, attempt: number): Promise<PaymentTerminalReceiptPage | null> {
    try {
      return await this.deps.readPage({
        runtimeId: this.activeRuntimeId,
        entityId: this.activeEntityId,
        fromHeight: this.nextHeight,
        toHeight: pageEnd,
      });
    } catch (error) {
      if (!this.isRetryableGapError(error) || attempt >= this.maxGapRetries) throw error;
      return { scannedThroughHeight: this.nextHeight - 1, receipts: [] };
    }
  }

  private emitPageEvents(page: PaymentTerminalReceiptPage, expectedGeneration: number): void {
    if (this.generation !== expectedGeneration) return;
    for (const receipt of page.receipts) {
      for (const log of receipt.logs) {
        const event = terminalEventFromLog(this.activeRuntimeId, this.activeEntityId, receipt, log);
        if (!event) continue;
        const key = terminalEventKey(this.activeRuntimeId, receipt, log);
        if (this.seenEventKeys.has(key)) continue;
        this.deps.onEvent(event);
        this.rememberEvent(key);
      }
    }
  }

  private rememberEvent(key: string): void {
    this.seenEventKeys.add(key);
    if (this.seenEventKeys.size <= 1000) return;
    const oldest = this.seenEventKeys.values().next().value;
    if (oldest) this.seenEventKeys.delete(oldest);
  }

  private rememberCursor(nextHeight: number): void {
    this.cursorStore.set(this.activeKey, nextHeight);
    if (this.cursorStore.size <= 200) return;
    const oldest = this.cursorStore.keys().next().value;
    if (oldest) this.cursorStore.delete(oldest);
  }
}

export const createPaymentTerminalMonitor = (deps: PaymentTerminalMonitorDeps) =>
  new PaymentTerminalMonitor(deps);
