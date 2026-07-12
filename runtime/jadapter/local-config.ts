import type { JAdapter } from './types';
import { createStructuredLogger } from '../infra/logger';

const DEFAULT_DISPUTE_DELAY_READ_TIMEOUT_MS = 5_000;
const localConfigLog = createStructuredLogger('jadapter.localConfig');

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> => {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error(`${label}_TIMEOUT:${timeoutMs}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle !== null) clearTimeout(timeoutHandle);
  }
};

export async function readDefaultDisputeDelay(jadapter: JAdapter): Promise<number | null> {
  try {
    const delay = await withTimeout(
      jadapter.depository.defaultDisputeDelay(),
      DEFAULT_DISPUTE_DELAY_READ_TIMEOUT_MS,
      'DEFAULT_DISPUTE_DELAY_READ',
    );
    const asNumber = Number(delay);
    return Number.isFinite(asNumber) ? asNumber : null;
  } catch {
    return null;
  }
}

export async function ensureLocalDisputeDelayConfigured(
  jadapter: JAdapter,
  jurisdictionName: string,
): Promise<number | null> {
  const currentDelay = await readDefaultDisputeDelay(jadapter);
  if (!Number.isFinite(currentDelay) || currentDelay === null) {
    console.warn(
      `[Runtime] ${jurisdictionName}: unable to read immutable Depository.defaultDisputeDelay`,
    );
    return null;
  }

  localConfigLog.debug('default_dispute_delay.ready', {
    jurisdiction: jurisdictionName,
    defaultDisputeDelay: currentDelay,
    source: 'immutable_contract_policy',
  });
  return currentDelay;
}
