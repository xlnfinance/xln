import { broadcastHardResetRequest } from './activeTabLock';
import { clearBrowserRuntimeData, clearRetiredTestnetState, RESET_CONFIRMATION, RESET_WARNING } from './resetBrowserData';
let activeResetPromise: Promise<void> | null = null;

const RESET_TAB_SETTLE_MS = 300;

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export type ResetEverythingRequest = { reason: string };

async function stopCurrentRuntimeActivity(): Promise<void> {
  const { shutdownRuntimeResumeListener, vaultOperations } = await import('../../stores/vault/vaultStore');
  await vaultOperations.suspendAllRuntimeActivity();
  shutdownRuntimeResumeListener();
}

function requestOtherTabsShutdown(): void {
  broadcastHardResetRequest();
}

export async function resetEverything(request: ResetEverythingRequest): Promise<void> {
  if (!request.reason.trim()) throw new Error('RESET_REASON_REQUIRED');
  if (activeResetPromise) return activeResetPromise;
  const confirmation = window.prompt(RESET_WARNING);
  if (confirmation !== RESET_CONFIRMATION) return;

  const resetPromise = (async () => {
    await stopCurrentRuntimeActivity();
    requestOtherTabsShutdown();
    await sleep(RESET_TAB_SETTLE_MS);
    await clearBrowserRuntimeData(confirmation);
    window.location.replace('/app');
  })();
  activeResetPromise = resetPromise;

  try {
    await resetPromise;
  } finally {
    if (activeResetPromise === resetPromise) activeResetPromise = null;
  }
}

let retiredTestnetReset: Promise<void> | null = null;

/**
 * A redeployed or re-schemed testnet cannot read the old stores. Only a
 * deployment that declares itself an ephemeral testnet reaches this path;
 * real-funds deployments keep the fail-closed recovery screen.
 */
export function resetRetiredTestnetState(): Promise<void> {
  retiredTestnetReset ??= (async () => {
    await stopCurrentRuntimeActivity();
    requestOtherTabsShutdown();
    await sleep(RESET_TAB_SETTLE_MS);
    await clearRetiredTestnetState();
    window.location.replace('/app');
  })();
  return retiredTestnetReset;
}
