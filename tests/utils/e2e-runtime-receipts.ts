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

type XlnDbView = {
  getPersistedLatestHeight?: (env: unknown) => Promise<number>;
  readPersistedFrameJournal?: (
    env: unknown,
    height: number,
  ) => Promise<{ logs?: FrameLogEntryView[] } | null>;
};

type RuntimeWindow = typeof window & {
  XLN?: XlnDbView;
  isolatedEnv?: {
    runtimeId?: string;
    height?: number;
  };
};

async function readRuntimeDbMeta(page: Page): Promise<{ latestHeight: number; runtimeHeight: number }> {
  return page.evaluate(async () => {
    const view = window as RuntimeWindow;
    const env = view.isolatedEnv;
    const getPersistedLatestHeight = view.XLN?.getPersistedLatestHeight;
    if (!env || typeof getPersistedLatestHeight !== 'function') {
      return { latestHeight: 0, runtimeHeight: Number(view.isolatedEnv?.height || 0) };
    }

    try {
      return {
        latestHeight: Number(await getPersistedLatestHeight(env) || 0),
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
    const getPersistedLatestHeight = view.XLN?.getPersistedLatestHeight;
    const readPersistedFrameJournal = view.XLN?.readPersistedFrameJournal;
    const events: PersistedFrameEvent[] = [];
    if (
      !env ||
      typeof getPersistedLatestHeight !== 'function' ||
      typeof readPersistedFrameJournal !== 'function'
    ) {
      return {
        cursor: { nextHeight },
        events,
        runtimeHeight: Number(view.isolatedEnv?.height || 0),
      };
    }
    const latestHeight = Number(await getPersistedLatestHeight(env) || 0);

    for (let height = Math.max(1, nextHeight); height <= latestHeight; height += 1) {
      const frame = await readPersistedFrameJournal(env, height);
      const logs = Array.isArray(frame?.logs) ? frame.logs : [];
      for (const entry of logs) {
        const message = typeof entry?.message === 'string' ? entry.message : '';
        if (!message) continue;
        const entityId = typeof entry?.entityId === 'string'
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

    return {
      cursor: { nextHeight: latestHeight + 1 },
      events,
      runtimeHeight: Number(view.isolatedEnv?.height || 0),
    };
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
