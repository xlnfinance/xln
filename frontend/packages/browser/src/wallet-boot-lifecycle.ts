export type WalletBootResult = 'completed' | 'cancelled';

export type WalletBootDependencies = Readonly<{
  isCurrent: () => boolean;
  initializeSettings: () => void;
  loadTabs: () => void;
  initializeDefaultTabs: () => void;
  isRemoteRuntimePreferred: () => boolean;
  initializeVault: () => Promise<unknown>;
  initializeRuntime: () => Promise<unknown>;
  readRuntimeMode: () => 'embedded' | 'remote';
  afterRuntimeReady: () => Promise<unknown>;
  initializeTime: () => void;
}>;

export const runWalletBootLifecycle = async (
  dependencies: WalletBootDependencies,
): Promise<WalletBootResult> => {
  if (!dependencies.isCurrent()) return 'cancelled';
  dependencies.initializeSettings();
  dependencies.loadTabs();
  dependencies.initializeDefaultTabs();
  const bootingRemoteRuntime = dependencies.isRemoteRuntimePreferred();
  if (!bootingRemoteRuntime) await dependencies.initializeVault();
  if (!dependencies.isCurrent()) return 'cancelled';
  await dependencies.initializeRuntime();
  if (!dependencies.isCurrent()) return 'cancelled';
  if (!bootingRemoteRuntime && dependencies.readRuntimeMode() !== 'remote') {
    await dependencies.initializeVault();
  }
  if (!dependencies.isCurrent()) return 'cancelled';
  await dependencies.afterRuntimeReady();
  if (!dependencies.isCurrent()) return 'cancelled';
  dependencies.initializeTime();
  return dependencies.isCurrent() ? 'completed' : 'cancelled';
};
