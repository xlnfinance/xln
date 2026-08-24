import { nodeProcess } from '../../support/process/runtime-process';
import { countOp } from '../../support/performance/op-counters';
import { getPerfMs } from '../../support/time';

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
  const startedAt = getPerfMs();
  const setImmediateFn = (globalThis as typeof globalThis & {
    setImmediate?: (callback: () => void) => unknown;
  }).setImmediate;
  // Bun's MessageChannel is fast in isolation but becomes a shared scheduling
  // bottleneck when one OS process hosts hundreds of RuntimeReplicas. The
  // server host already provides the exact primitive we need: one event-loop
  // turn, with no timer and no channel allocation per Runtime frame.
  if (nodeProcess && typeof setImmediateFn === 'function') {
    await new Promise<void>(resolve => setImmediateFn(resolve));
    countOp('runtime.ioYield.immediate', 0, Math.round((getPerfMs() - startedAt) * 1_000));
    return;
  }
  const scheduler = (globalThis as typeof globalThis & {
    scheduler?: { yield?: () => Promise<void> };
  }).scheduler;
  if (typeof scheduler?.yield === 'function') {
    await scheduler.yield();
    countOp('runtime.ioYield.scheduler', 0, Math.round((getPerfMs() - startedAt) * 1_000));
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
    countOp('runtime.ioYield.messageChannel', 0, Math.round((getPerfMs() - startedAt) * 1_000));
    return;
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  countOp('runtime.ioYield.timeout', 0, Math.round((getPerfMs() - startedAt) * 1_000));
};

const defaultDbPath = nodeProcess ? 'db-tmp/runtime' : 'db';
export const dbRootPath = nodeProcess?.env?.['XLN_DB_PATH'] || defaultDbPath;

