import { writable } from 'svelte/store';

const deriveRequest = writable(0);
const showVault = writable(false);

export const vaultUi = {
  deriveRequest,
  showVault,
};

export const deriveRequestSignal = deriveRequest;
export const showVaultPanel = showVault;

export const vaultUiOperations = {
  requestDeriveNewVault() {
    console.log('[vaultUiOperations] requestDeriveNewVault CALLED - opening BrainVault');
    showVault.set(true);
    deriveRequest.update((n) => n + 1);
  },
  showVault() {
    showVault.set(true);
  },
  hideVault() {
    showVault.set(false);
  },
};
