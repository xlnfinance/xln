export type WalletShellPhase =
  | 'remote-runtime-consent'
  | 'inactive-tab'
  | 'scenario-preview'
  | 'lock-test-ready'
  | 'error'
  | 'loading'
  | 'ready';

export type WalletShellSnapshot = Readonly<{
  activeTabLockReady: boolean;
  hasActiveTabLock: boolean;
  hasError: boolean;
  hasPendingRemoteRuntime: boolean;
  lockTestMode: boolean;
  scenarioPreviewMode: boolean;
  runtimeLoading: boolean;
  runtimeReady: boolean;
}>;

export const resolveWalletShellPhase = (
  snapshot: WalletShellSnapshot,
): WalletShellPhase => {
  if (snapshot.activeTabLockReady && !snapshot.hasActiveTabLock && !snapshot.hasError) {
    return snapshot.hasPendingRemoteRuntime ? 'remote-runtime-consent' : 'inactive-tab';
  }
  if (snapshot.lockTestMode && snapshot.scenarioPreviewMode) return 'scenario-preview';
  if (snapshot.lockTestMode) return 'lock-test-ready';
  if (snapshot.hasError) return 'error';
  if (!snapshot.activeTabLockReady || snapshot.runtimeLoading || !snapshot.runtimeReady) {
    return 'loading';
  }
  return 'ready';
};
