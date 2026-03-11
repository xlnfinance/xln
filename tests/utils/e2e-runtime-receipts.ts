import { expect, type Page } from '@playwright/test';

export type PersistedReceiptCursor = {
  nextHeight: number;
};

type FrameLogEntryView = {
  message?: string;
  entityId?: string;
  data?: Record<string, unknown>;
};

export type PersistedFrameEvent = {
  frameHeight: number;
  message: string;
  entityId?: string;
  data?: Record<string, unknown>;
};

type RuntimeWindow = typeof window & {
  isolatedEnv?: {
    runtimeId?: string;
    dbNamespace?: string;
    height?: number;
  };
};

type PersistedFrameJournalView = {
  logs?: FrameLogEntryView[];
} | null;

export type PersistedDbMeta = {
  latestHeight: number;
  runtimeHeight: number;
  checkpointHeight: number;
  hasLatestFrame: boolean;
  hasLatestSnapshot: boolean;
  hasCheckpointSnapshot: boolean;
};

type PersistedFrameReadResult = {
  cursor: PersistedReceiptCursor;
  events: PersistedFrameEvent[];
  runtimeHeight: number;
};

async function readRuntimeDbMeta(page: Page): Promise<PersistedDbMeta> {
  return page.evaluate(async () => {
    const view = window as RuntimeWindow;
    const runtimeHeight = Number(view.isolatedEnv?.height || 0);
    const namespace = String(view.isolatedEnv?.dbNamespace || view.isolatedEnv?.runtimeId || '').trim().toLowerCase();
    if (!namespace) {
      return {
        latestHeight: 0,
        runtimeHeight,
        checkpointHeight: 0,
        hasLatestFrame: false,
        hasLatestSnapshot: false,
        hasCheckpointSnapshot: false,
      };
    }

    const location = `db-${namespace}`;
    const dbName = `level-js-${location}`;

    const requestToPromise = <T>(request: IDBRequest<T>): Promise<T> =>
      new Promise((resolve, reject) => {
        request.addEventListener('success', () => resolve(request.result));
        request.addEventListener('error', () => reject(request.error));
      });

    const decodeBufferLike = (value: unknown): string | null => {
      if (value instanceof Uint8Array) return new TextDecoder().decode(value);
      if (value instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(value));
      if (ArrayBuffer.isView(value)) {
        const view = value as ArrayBufferView;
        return new TextDecoder().decode(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
      }
      if (typeof value === 'string') return value;
      return null;
    };

    try {
      const database = await requestToPromise(indexedDB.open(dbName));
      if (!database.objectStoreNames.contains(location)) {
        database.close();
        return {
          latestHeight: 0,
          runtimeHeight,
          checkpointHeight: 0,
          hasLatestFrame: false,
          hasLatestSnapshot: false,
          hasCheckpointSnapshot: false,
        };
      }
      const tx = database.transaction(location, 'readonly');
      const store = tx.objectStore(location);
      const encodeKey = (name: string): Uint8Array => new TextEncoder().encode(`${namespace}:${name}`);
      const raw = await requestToPromise(store.get(encodeKey('latest_height')));
      const checkpointRaw = await requestToPromise(store.get(encodeKey('latest_checkpoint_height')));
      const decoded = decodeBufferLike(raw);
      const checkpointDecoded = decodeBufferLike(checkpointRaw);
      const latestHeight = Number(decoded || 0);
      const checkpointHeight = Number(checkpointDecoded || 0);
      const normalizedLatestHeight = Number.isFinite(latestHeight) ? latestHeight : 0;
      const normalizedCheckpointHeight = Number.isFinite(checkpointHeight) ? checkpointHeight : 0;
      const latestFrameRaw =
        normalizedLatestHeight > 0 ? await requestToPromise(store.get(encodeKey(`frame_input:${normalizedLatestHeight}`))) : null;
      const latestSnapshotRaw =
        normalizedLatestHeight > 0 ? await requestToPromise(store.get(encodeKey(`snapshot:${normalizedLatestHeight}`))) : null;
      const checkpointSnapshotRaw =
        normalizedCheckpointHeight > 0 ? await requestToPromise(store.get(encodeKey(`snapshot:${normalizedCheckpointHeight}`))) : null;
      database.close();
      return {
        latestHeight: normalizedLatestHeight,
        runtimeHeight,
        checkpointHeight: normalizedCheckpointHeight,
        hasLatestFrame: decodeBufferLike(latestFrameRaw) !== null,
        hasLatestSnapshot: decodeBufferLike(latestSnapshotRaw) !== null,
        hasCheckpointSnapshot: decodeBufferLike(checkpointSnapshotRaw) !== null,
      };
    } catch {
      return {
        latestHeight: 0,
        runtimeHeight,
        checkpointHeight: 0,
        hasLatestFrame: false,
        hasLatestSnapshot: false,
        hasCheckpointSnapshot: false,
      };
    }
  });
}

export async function getPersistedRuntimeDbMeta(page: Page): Promise<PersistedDbMeta> {
  return readRuntimeDbMeta(page);
}

export async function getPersistedReceiptCursor(page: Page): Promise<PersistedReceiptCursor> {
  const meta = await readRuntimeDbMeta(page);
  return { nextHeight: meta.latestHeight + 1 };
}

async function readPersistedFrameEvents(
  page: Page,
  cursor: PersistedReceiptCursor,
): Promise<PersistedFrameReadResult> {
  return page.evaluate(async ({ nextHeight }) => {
    const view = window as RuntimeWindow;
    const runtimeHeight = Number(view.isolatedEnv?.height || 0);
    const namespace = String(view.isolatedEnv?.dbNamespace || view.isolatedEnv?.runtimeId || '').trim().toLowerCase();
    const events: PersistedFrameEvent[] = [];

    if (!namespace) {
      return { cursor: { nextHeight }, events, runtimeHeight };
    }

    const location = `db-${namespace}`;
    const dbName = `level-js-${location}`;

    const requestToPromise = <T>(request: IDBRequest<T>): Promise<T> =>
      new Promise((resolve, reject) => {
        request.addEventListener('success', () => resolve(request.result));
        request.addEventListener('error', () => reject(request.error));
      });

    const decodeBufferLike = (value: unknown): string | null => {
      if (value instanceof Uint8Array) return new TextDecoder().decode(value);
      if (value instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(value));
      if (ArrayBuffer.isView(value)) {
        const typed = value as ArrayBufferView;
        return new TextDecoder().decode(new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength));
      }
      if (typeof value === 'string') return value;
      return null;
    };

    const readFrame = async (store: IDBObjectStore, height: number): Promise<PersistedFrameJournalView> => {
      const key = new TextEncoder().encode(`${namespace}:frame_input:${height}`);
      const raw = await requestToPromise(store.get(key));
      const decoded = decodeBufferLike(raw);
      if (!decoded) return null;
      try {
        return JSON.parse(decoded) as PersistedFrameJournalView;
      } catch {
        return null;
      }
    };

    try {
      const database = await requestToPromise(indexedDB.open(dbName));
      if (!database.objectStoreNames.contains(location)) {
        database.close();
        return { cursor: { nextHeight }, events, runtimeHeight };
      }

      const tx = database.transaction(location, 'readonly');
      const store = tx.objectStore(location);
      const latestRaw = await requestToPromise(store.get(new TextEncoder().encode(`${namespace}:latest_height`)));
      const latestDecoded = decodeBufferLike(latestRaw);
      const latestHeight = Number(latestDecoded || 0);

      for (let height = Math.max(1, nextHeight); height <= latestHeight; height += 1) {
        const frame = await readFrame(store, height);
        const logs = Array.isArray(frame?.logs) ? frame.logs : [];
        for (const entry of logs) {
          const message = typeof entry?.message === 'string' ? entry.message : '';
          if (!message) continue;
          const entityId =
            typeof entry?.entityId === 'string'
              ? entry.entityId
              : typeof entry?.data?.entityId === 'string'
                ? entry.data.entityId
                : undefined;
          const data = entry?.data && typeof entry.data === 'object' ? entry.data : undefined;
          events.push({
            frameHeight: height,
            message,
            ...(entityId ? { entityId } : {}),
            ...(data ? { data } : {}),
          });
        }
      }

      database.close();
      return {
        cursor: { nextHeight: latestHeight + 1 },
        events,
        runtimeHeight,
      };
    } catch {
      return { cursor: { nextHeight }, events, runtimeHeight };
    }
  }, cursor);
}

export async function readPersistedFrameEventsSinceCursor(
  page: Page,
  options: {
    cursor: PersistedReceiptCursor;
    eventNames?: string[];
    entityId?: string;
  },
): Promise<{
  cursor: PersistedReceiptCursor;
  events: PersistedFrameEvent[];
  runtimeHeight: number;
}> {
  const result = await readPersistedFrameEvents(page, options.cursor);
  const eventNameSet = options.eventNames ? new Set(options.eventNames) : null;
  const targetEntityId = String(options.entityId || '').toLowerCase();

  const events = result.events.filter((event) => {
    if (eventNameSet && !eventNameSet.has(event.message)) return false;
    if (targetEntityId && String(event.entityId || '').toLowerCase() !== targetEntityId) return false;
    return true;
  });

  return {
    cursor: result.cursor,
    events,
    runtimeHeight: result.runtimeHeight,
  };
}

export async function waitForPersistedFrameEvent(
  page: Page,
  options: {
    cursor: PersistedReceiptCursor;
    eventName: string;
    entityId?: string;
    timeoutMs?: number;
  },
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const targetEntityId = String(options.entityId || '').toLowerCase();
  const startedAt = Date.now();
  let cursor = options.cursor;
  const recentEvents: PersistedFrameEvent[] = [];
  let runtimeHeight = 0;

  while (Date.now() - startedAt < timeoutMs) {
    const result = await readPersistedFrameEvents(page, cursor);
    cursor = result.cursor;
    runtimeHeight = result.runtimeHeight;

    for (const event of result.events) {
      recentEvents.push(event);
      if (recentEvents.length > 24) recentEvents.shift();
      if (event.message !== options.eventName) continue;
      if (targetEntityId && String(event.entityId || '').toLowerCase() !== targetEntityId) continue;
      return;
    }

    await page.waitForTimeout(250);
  }

  throw new Error(
    `Timed out waiting for persisted event ${options.eventName} on ${options.entityId?.slice(0, 12) || 'runtime'} ` +
      `(height=${runtimeHeight} frames=${recentEvents.map((event) => event.frameHeight).join(',') || 'none'} ` +
      `recent=${recentEvents.map((event) => event.message).join(',') || 'none'})`,
  );
}

export async function waitForPersistedFrameEventMatch(
  page: Page,
  options: {
    cursor: PersistedReceiptCursor;
    eventName: string;
    entityId?: string;
    timeoutMs?: number;
    predicate?: (event: PersistedFrameEvent) => boolean;
  },
): Promise<PersistedFrameEvent> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const targetEntityId = String(options.entityId || '').toLowerCase();
  const startedAt = Date.now();
  let cursor = options.cursor;
  const recentEvents: PersistedFrameEvent[] = [];
  let runtimeHeight = 0;

  while (Date.now() - startedAt < timeoutMs) {
    const result = await readPersistedFrameEvents(page, cursor);
    cursor = result.cursor;
    runtimeHeight = result.runtimeHeight;

    for (const event of result.events) {
      recentEvents.push(event);
      if (recentEvents.length > 24) recentEvents.shift();
      if (event.message !== options.eventName) continue;
      if (targetEntityId && String(event.entityId || '').toLowerCase() !== targetEntityId) continue;
      if (options.predicate && !options.predicate(event)) continue;
      return event;
    }

    await page.waitForTimeout(250);
  }

  throw new Error(
    `Timed out waiting for persisted event ${options.eventName} on ${options.entityId?.slice(0, 12) || 'runtime'} ` +
      `(height=${runtimeHeight} frames=${recentEvents.map((event) => event.frameHeight).join(',') || 'none'} ` +
      `recent=${recentEvents.map((event) => event.message).join(',') || 'none'})`,
  );
}

export async function waitForPersistedFrameMessageMatch(
  page: Page,
  options: {
    cursor: PersistedReceiptCursor;
    entityId?: string;
    timeoutMs?: number;
    predicate: (event: PersistedFrameEvent) => boolean;
  },
): Promise<PersistedFrameEvent> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const targetEntityId = String(options.entityId || '').toLowerCase();
  const startedAt = Date.now();
  let cursor = options.cursor;
  const recentEvents: PersistedFrameEvent[] = [];
  let runtimeHeight = 0;

  while (Date.now() - startedAt < timeoutMs) {
    const result = await readPersistedFrameEvents(page, cursor);
    cursor = result.cursor;
    runtimeHeight = result.runtimeHeight;

    for (const event of result.events) {
      recentEvents.push(event);
      if (recentEvents.length > 24) recentEvents.shift();
      if (targetEntityId && String(event.entityId || '').toLowerCase() !== targetEntityId) continue;
      if (!options.predicate(event)) continue;
      return event;
    }

    await page.waitForTimeout(250);
  }

  throw new Error(
    `Timed out waiting for persisted frame message on ${options.entityId?.slice(0, 12) || 'runtime'} ` +
      `(height=${runtimeHeight} frames=${recentEvents.map((event) => event.frameHeight).join(',') || 'none'} ` +
      `recent=${recentEvents.map((event) => event.message).join(',') || 'none'})`,
  );
}

export async function expectPersistedFrameEvent(
  page: Page,
  options: {
    cursor: PersistedReceiptCursor;
    eventName: string;
    entityId?: string;
    timeoutMs?: number;
  },
): Promise<void> {
  await expect(waitForPersistedFrameEvent(page, options)).resolves.toBeUndefined();
}
