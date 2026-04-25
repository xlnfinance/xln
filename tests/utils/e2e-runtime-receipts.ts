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
    const env = view.isolatedEnv;
    const XLN = (window as any).XLN
      || await import(/* @vite-ignore */ new URL(`/runtime.js?v=${Date.now()}`, window.location.origin).href);
    if (!env || !XLN?.getPersistedLatestHeight) {
      return {
        latestHeight: 0,
        runtimeHeight,
        checkpointHeight: 0,
        hasLatestFrame: false,
        hasLatestSnapshot: false,
        hasCheckpointSnapshot: false,
      };
    }

    try {
      const latestHeight = Number(await XLN.getPersistedLatestHeight(env) || 0);
      const checkpointList = await XLN.listPersistedCheckpointHeights(env);
      const checkpointHeights = Array.isArray(checkpointList) ? checkpointList : [];
      const checkpointHeight = Number(checkpointHeights.at(-1) || 0);
      const latestFrame = latestHeight > 0 ? await XLN.readPersistedFrameJournal(env, latestHeight) : null;
      const latestSnapshot = latestHeight > 0 ? await XLN.readPersistedCheckpointSnapshot(env, latestHeight) : null;
      const checkpointSnapshot = checkpointHeight > 0 ? await XLN.readPersistedCheckpointSnapshot(env, checkpointHeight) : null;
      return {
        latestHeight,
        runtimeHeight,
        checkpointHeight,
        hasLatestFrame: latestFrame !== null,
        hasLatestSnapshot: latestSnapshot !== null,
        hasCheckpointSnapshot: checkpointSnapshot !== null,
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
    const env = view.isolatedEnv;
    const events: PersistedFrameEvent[] = [];

    const XLN = (window as any).XLN
      || await import(/* @vite-ignore */ new URL(`/runtime.js?v=${Date.now()}`, window.location.origin).href);
    if (!env || !XLN?.getPersistedLatestHeight) {
      return { cursor: { nextHeight }, events, runtimeHeight };
    }

    try {
      const latestHeight = Number(await XLN.getPersistedLatestHeight(env) || 0);

      for (let height = Math.max(1, nextHeight); height <= latestHeight; height += 1) {
        const frame = await XLN.readPersistedFrameJournal(env, height) as PersistedFrameJournalView;
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
