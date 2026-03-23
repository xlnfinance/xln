import type { JAdapter } from './types';

export const LOCAL_DEV_CHAIN_ID = 31337;
const readEnv = (name: string): string | undefined => {
  try {
    const proc = (globalThis as { process?: { env?: Record<string, unknown> } }).process;
    const value = proc?.env?.[name];
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
};

export const LOCAL_DEFAULT_DISPUTE_DELAY_BLOCKS = (() => {
  const parsed = Number(readEnv('XLN_LOCAL_DEFAULT_DISPUTE_DELAY_BLOCKS') ?? '5');
  if (!Number.isFinite(parsed) || parsed <= 0) return 5;
  return Math.floor(parsed);
})();

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
      `[Runtime] ${jurisdictionName}: unable to read Depository.defaultDisputeDelay (keeping chain value)`,
    );
    return null;
  }

  if (Number(jadapter.chainId) !== LOCAL_DEV_CHAIN_ID) {
    return currentDelay;
  }

  if (currentDelay === LOCAL_DEFAULT_DISPUTE_DELAY_BLOCKS) {
    console.log(
      `[Runtime] ${jurisdictionName}: defaultDisputeDelay=${currentDelay} (source: contract)`,
    );
    return currentDelay;
  }

  try {
    const tx = await jadapter.depository.setDefaultDisputeDelay(LOCAL_DEFAULT_DISPUTE_DELAY_BLOCKS);
    await tx.wait();
    const updatedDelay = await readDefaultDisputeDelay(jadapter);
    const effectiveDelay = updatedDelay ?? LOCAL_DEFAULT_DISPUTE_DELAY_BLOCKS;
    console.log(
      `[Runtime] ${jurisdictionName}: defaultDisputeDelay ${currentDelay} -> ${effectiveDelay}`,
    );
    return effectiveDelay;
  } catch (error) {
    console.warn(
      `[Runtime] ${jurisdictionName}: failed to set defaultDisputeDelay=${LOCAL_DEFAULT_DISPUTE_DELAY_BLOCKS} ` +
      `(current=${currentDelay}): ${error instanceof Error ? error.message : String(error)}`,
    );
    return currentDelay;
  }
}
