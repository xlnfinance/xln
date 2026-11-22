import { setTimeout } from 'node:timers/promises';
import { HeaderReadCancelled, requireLiveHeaderClient } from './header-read-queue';

export const waitForReadDelay = async (delayMs: number, signal: AbortSignal): Promise<void> => {
  try {
    await setTimeout(Math.ceil(delayMs), undefined, { signal });
  } catch (error) {
    if (signal.aborted) throw new HeaderReadCancelled();
    throw error;
  }
};

export const createReadPacer = () => {
  const nextByEndpoint = new Map<string, number>();
  return async (endpoint: string, intervalMs: number, signal: AbortSignal): Promise<void> => {
    for (;;) {
      requireLiveHeaderClient(signal);
      const now = performance.now();
      const delay = (nextByEndpoint.get(endpoint) ?? 0) - now;
      if (delay <= 0) {
        nextByEndpoint.set(endpoint, now + intervalMs);
        return;
      }
      await waitForReadDelay(delay, signal);
    }
  };
};
