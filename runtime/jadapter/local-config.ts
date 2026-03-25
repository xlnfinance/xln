import type { JAdapter } from './types';

export async function readDefaultDisputeDelay(jadapter: JAdapter): Promise<number | null> {
  try {
    const delay = await jadapter.depository.defaultDisputeDelay();
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

  console.log(
    `[Runtime] ${jurisdictionName}: defaultDisputeDelay=${currentDelay} (source: immutable contract policy)`,
  );
  return currentDelay;
}
