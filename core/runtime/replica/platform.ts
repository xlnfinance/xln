import {
  nodeProcess,
  readRuntimeEnv,
} from '../../support/process/runtime-process';

/**
 * Yield one host task without adding an artificial Runtime delay.
 *
 * Promise-only Runtime loops can monopolize the browser microtask queue while
 * draining consecutive R-frames. WebSocket/IndexedDB callbacks are host tasks,
 * so starving them makes an already-delivered Account ACK appear seconds late.
 * This boundary changes no RJEA input, timestamp, or ordering; it only lets the
 * host deliver I/O before the next independently committed R-frame begins.
 */
export const yieldRuntimeIoTurn = async (): Promise<void> => {
  const scheduler = (globalThis as typeof globalThis & {
    scheduler?: { yield?: () => Promise<void> };
  }).scheduler;
  if (typeof scheduler?.yield === 'function') {
    await scheduler.yield();
    return;
  }
  if (typeof MessageChannel !== 'undefined') {
    await new Promise<void>((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        channel.port2.close();
        resolve();
      };
      channel.port2.postMessage(undefined);
    });
    return;
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

const defaultDbPath = nodeProcess ? 'db-tmp/runtime' : 'db';
export const dbRootPath = nodeProcess?.env?.['XLN_DB_PATH'] || defaultDbPath;

export const DEFAULT_SNAPSHOT_INTERVAL_FRAMES = (() => {
  const parsed = Number(readRuntimeEnv('XLN_SNAPSHOT_INTERVAL_FRAMES') ?? '100');
  if (!Number.isFinite(parsed) || parsed < 1) return 100;
  return Math.floor(parsed);
})();
