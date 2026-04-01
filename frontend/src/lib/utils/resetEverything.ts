let activeResetPromise: Promise<void> | null = null;

const RESET_TAB_SETTLE_MS = 300;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function stopCurrentRuntimeActivity(): Promise<void> {
  try {
    const vaultStore = await import('../stores/vaultStore');
    await vaultStore.vaultOperations.suspendAllRuntimeActivity?.();
    vaultStore.shutdownRuntimeResumeListener?.();
  } catch {
    // best effort
  }
}

async function requestOtherTabsShutdown(): Promise<void> {
  try {
    const activeTabLock = await import('./activeTabLock');
    activeTabLock.broadcastHardResetRequest?.();
  } catch {
    // best effort
  }
}

function buildResetDbUrl(): string {
  const returnTo =
    window.location.pathname.startsWith('/app') || window.location.pathname === '/loading-screen'
      ? '/app'
      : '/app';
  return `/resetdb?returnTo=${encodeURIComponent(returnTo)}`;
}

export async function resetEverything(_trigger?: unknown): Promise<void> {
  if (activeResetPromise) return activeResetPromise;

  activeResetPromise = (async () => {
    await stopCurrentRuntimeActivity();
    await requestOtherTabsShutdown();
    await sleep(RESET_TAB_SETTLE_MS);
    window.location.replace(buildResetDbUrl());
  })();

  return activeResetPromise;
}
