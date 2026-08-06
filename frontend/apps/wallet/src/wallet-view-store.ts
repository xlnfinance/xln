import { createExternalStore } from '../../../packages/client-core/external-store';
import { runtimesExternalStore } from '$lib/stores/runtimeStore';
import { runtimeControllerHandleExternalStore } from '$lib/stores/runtimeControllerStore';
import { runtimesStateExternalStore } from '$lib/stores/vaultStore';

export type WalletRuntimeSummary = Readonly<{
  id: string;
  type: 'local' | 'remote';
  label: string;
  createdAt: number;
  signerCount: number;
  unlocked: boolean;
  entityId: string | null;
  signerId: string | null;
}>;

export type WalletViewSnapshot = Readonly<{
  activeRuntimeId: string | null;
  runtimes: readonly WalletRuntimeSummary[];
}>;

const projectWalletView = (): WalletViewSnapshot => {
  const vault = runtimesStateExternalStore.getSnapshot();
  const controller = runtimeControllerHandleExternalStore.getSnapshot();
  const runtimeMap = runtimesExternalStore.getSnapshot();
  const runtimes = [...runtimeMap.values()]
    .map((runtime, index) => {
      const local = runtime.type === 'local' ? vault.runtimes[runtime.id] ?? null : null;
      const activeSigner = local?.signers[local.activeSignerIndex] ?? null;
      const primaryHub = runtime.hubEntities?.[0] ?? null;
      return Object.freeze({
        id: runtime.id,
        type: runtime.type,
        label: runtime.label,
        createdAt: local?.createdAt ?? runtime.lastSynced ?? index,
        signerCount: local?.signers.length ?? 0,
        unlocked: runtime.type === 'remote' || Boolean(local?.seed),
        entityId: String(activeSigner?.entityId || runtime.hubEntityId || primaryHub?.entityId || '').trim().toLowerCase() || null,
        signerId: String(activeSigner?.address || '').trim().toLowerCase() || null,
      });
    })
    .toSorted((left, right) => left.createdAt - right.createdAt);
  return Object.freeze({
    activeRuntimeId:
      (runtimeMap.has(controller.pendingRuntimeId) ? controller.pendingRuntimeId : null)
      ?? (runtimeMap.has(controller.runtimeId) ? controller.runtimeId : null)
      ?? (vault.activeRuntimeId && runtimeMap.has(vault.activeRuntimeId) ? vault.activeRuntimeId : null),
    runtimes: Object.freeze(runtimes),
  });
};

const walletViewBinding = createExternalStore(projectWalletView());
export const walletViewExternalStore = walletViewBinding.store;

const publishWalletView = (): void => walletViewBinding.controller.set(projectWalletView());

runtimesStateExternalStore.subscribe(publishWalletView);
runtimesExternalStore.subscribe(publishWalletView);
runtimeControllerHandleExternalStore.subscribe(publishWalletView);
