import { createExternalStore } from '../../../packages/client-core/external-store';
import { runtimesStateExternalStore } from '$lib/stores/vaultStore';

export type WalletRuntimeSummary = Readonly<{
  id: string;
  label: string;
  createdAt: number;
  signerCount: number;
  unlocked: boolean;
}>;

export type WalletViewSnapshot = Readonly<{
  activeRuntimeId: string | null;
  runtimes: readonly WalletRuntimeSummary[];
}>;

const projectWalletView = (): WalletViewSnapshot => {
  const vault = runtimesStateExternalStore.getSnapshot();
  const runtimes = Object.values(vault.runtimes)
    .map(runtime => Object.freeze({
      id: runtime.id,
      label: runtime.label,
      createdAt: runtime.createdAt,
      signerCount: runtime.signers.length,
      unlocked: Boolean(runtime.seed),
    }))
    .toSorted((left, right) => left.createdAt - right.createdAt);
  return Object.freeze({
    activeRuntimeId: vault.activeRuntimeId,
    runtimes: Object.freeze(runtimes),
  });
};

const walletViewBinding = createExternalStore(projectWalletView());
export const walletViewExternalStore = walletViewBinding.store;

runtimesStateExternalStore.subscribe(() => {
  walletViewBinding.controller.set(projectWalletView());
});
