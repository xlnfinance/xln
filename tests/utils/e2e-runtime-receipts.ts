import { expect, type Page } from '@playwright/test';

export type PersistedReceiptCursor = {
  nextHeight: number;
};

type FrameLogEntryView = {
  message?: string;
  entityId?: string;
  data?: Record<string, unknown>;
};

type PersistedFrameEvent = {
  frameHeight: number;
  message: string;
  entityId?: string;
};

type XlnDbView = {
  getRuntimeDb?: (env: unknown) => {
    get: (key: string | Uint8Array) => Promise<{ toString?: () => string } | Uint8Array | string>;
  };
};

type RuntimeWindow = typeof window & {
  Buffer?: { from: (value: string) => Uint8Array | string };
  XLN?: XlnDbView;
  isolatedEnv?: {
    runtimeId?: string;
    height?: number;
    dbNamespace?: string;
  };
};

async function readRuntimeDbMeta(page: Page): Promise<{ latestHeight: number; runtimeHeight: number }> {
  return page.evaluate(async () => {
    const view = window as RuntimeWindow;
    const env = view.isolatedEnv;
    const getRuntimeDb = view.XLN?.getRuntimeDb;
    if (!env || !getRuntimeDb) {
      return { latestHeight: 0, runtimeHeight: Number(view.isolatedEnv?.height || 0) };
    }

    const db = getRuntimeDb(env);
    const namespace = String(env.dbNamespace || env.runtimeId || '').toLowerCase();
    const keyOf = (name: string) => `${namespace}:${name}`;

    try {
      const bufferKey = typeof view.Buffer?.from === 'function'
        ? view.Buffer.from(keyOf('latest_height'))
        : keyOf('latest_height');
      const raw = await db.get(bufferKey);
      const decoded = typeof raw === 'string'
        ? raw
        : raw instanceof Uint8Array
          ? new TextDecoder().decode(raw)
          : typeof raw?.toString === 'function'
            ? raw.toString()
            : '0';
      return {
        latestHeight: Number(decoded || 0),
        runtimeHeight: Number(view.isolatedEnv?.height || 0),
      };
    } catch {
      return { latestHeight: 0, runtimeHeight: Number(view.isolatedEnv?.height || 0) };
    }
  });
}

export async function getPersistedReceiptCursor(page: Page): Promise<PersistedReceiptCursor> {
  const meta = await readRuntimeDbMeta(page);
  return { nextHeight: meta.latestHeight + 1 };
}

async function readPersistedFrameEvents(
  page: Page,
  cursor: PersistedReceiptCursor,
): Promise<{
  cursor: PersistedReceiptCursor;
  events: PersistedFrameEvent[];
  runtimeHeight: number;
}> {
  return page.evaluate(async ({ nextHeight }) => {
    const view = window as RuntimeWindow;
    const env = view.isolatedEnv;
    const getRuntimeDb = view.XLN?.getRuntimeDb;
    const events: PersistedFrameEvent[] = [];
    if (!env || !getRuntimeDb) {
      return {
        cursor: { nextHeight },
        events,
        runtimeHeight: Number(view.isolatedEnv?.height || 0),
      };
    }

    const db = getRuntimeDb(env);
    const namespace = String(env.dbNamespace || env.runtimeId || '').toLowerCase();
    const keyOf = (name: string) => `${namespace}:${name}`;
    const read = async (name: string): Promise<string | null> => {
      try {
        const bufferKey = typeof view.Buffer?.from === 'function' ? view.Buffer.from(keyOf(name)) : keyOf(name);
        const raw = await db.get(bufferKey);
        if (typeof raw === 'string') return raw;
        if (raw instanceof Uint8Array) return new TextDecoder().decode(raw);
        if (typeof raw?.toString === 'function') return raw.toString();
        return null;
      } catch {
        return null;
      }
    };

    const latestHeightRaw = await read('latest_height');
    const latestHeight = Number(latestHeightRaw || 0);

    for (let height = Math.max(1, nextHeight); height <= latestHeight; height += 1) {
      const frameRaw = await read(`frame_input:${height}`);
      if (!frameRaw) continue;

      let frame: { logs?: FrameLogEntryView[] } | null = null;
      try {
        frame = JSON.parse(frameRaw) as { logs?: FrameLogEntryView[] };
      } catch {
        frame = null;
      }
      const logs = Array.isArray(frame?.logs) ? frame.logs : [];
      for (const entry of logs) {
        const message = typeof entry?.message === 'string' ? entry.message : '';
        if (!message) continue;
        const entityId = typeof entry?.entityId === 'string'
          ? entry.entityId
          : typeof entry?.data?.entityId === 'string'
            ? entry.data.entityId
            : undefined;
        events.push({ frameHeight: height, message, ...(entityId ? { entityId } : {}) });
      }
    }

    return {
      cursor: { nextHeight: latestHeight + 1 },
      events,
      runtimeHeight: Number(view.isolatedEnv?.height || 0),
    };
  }, cursor);
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
