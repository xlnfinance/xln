import type { WalletAvailability } from './wallet-boot-machine';

export type WalletRuntimeAvailabilityHandle = Readonly<{
  mode: 'embedded' | 'remote';
  runtimeId: string;
  pendingRuntimeId: string;
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
}>;

export const resolveRemoteWalletAvailability = (
  handle: WalletRuntimeAvailabilityHandle,
  remoteRequested: boolean,
): WalletAvailability | null => {
  if (handle.mode === 'remote') {
    const runtimeId = handle.runtimeId || handle.pendingRuntimeId || null;
    return Object.freeze({
      activeRuntimeId: runtimeId,
      runtimeCount: runtimeId ? 1 : 0,
      activeRuntimeUnlocked: Boolean(runtimeId),
      runtimeReady: Boolean(runtimeId) && handle.status === 'connected',
    });
  }
  if (!remoteRequested) return null;
  const pendingRuntimeId = handle.pendingRuntimeId || null;
  return Object.freeze({
    activeRuntimeId: pendingRuntimeId,
    runtimeCount: 1,
    activeRuntimeUnlocked: true,
    runtimeReady: false,
  });
};
