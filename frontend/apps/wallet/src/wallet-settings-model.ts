import {
  BRAINVAULT_WORKER_CAP_STORAGE_KEY,
} from '../../../packages/browser/src/wallet-brainvault-worker-resilience';
import {
  WALLET_AUTH_SCHEME_STORAGE_KEY,
  parseWalletBrainVaultWorkerCap,
  resolveWalletAuthScheme,
  serializeWalletBrainVaultWorkerCap,
  type WalletAuthScheme,
} from '../../../packages/browser/src/wallet-runtime-preferences';

export type WalletPreferenceStorage = Readonly<{
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}>;

export type WalletPreferencesSnapshot = Readonly<{
  authScheme: WalletAuthScheme;
  brainVaultWorkerCap: number | null;
}>;

export type WalletWorkerCapChoice = 'automatic' | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export const readWalletPreferences = (
  storage: WalletPreferenceStorage,
): WalletPreferencesSnapshot => ({
  authScheme: resolveWalletAuthScheme(storage.getItem(WALLET_AUTH_SCHEME_STORAGE_KEY)),
  brainVaultWorkerCap: parseWalletBrainVaultWorkerCap(
    storage.getItem(BRAINVAULT_WORKER_CAP_STORAGE_KEY),
  ),
});

export const persistWalletAuthScheme = (
  storage: WalletPreferenceStorage,
  authScheme: WalletAuthScheme,
): WalletPreferencesSnapshot => {
  storage.setItem(WALLET_AUTH_SCHEME_STORAGE_KEY, authScheme);
  return readWalletPreferences(storage);
};

export const persistWalletWorkerCap = (
  storage: WalletPreferenceStorage,
  choice: 'automatic' | number,
): WalletPreferencesSnapshot => {
  if (choice === 'automatic') storage.removeItem(BRAINVAULT_WORKER_CAP_STORAGE_KEY);
  else {
    if (!Number.isSafeInteger(choice) || choice < 1 || choice > 8) {
      throw new Error(`WALLET_BRAINVAULT_WORKER_CAP_INVALID:${choice}`);
    }
    storage.setItem(BRAINVAULT_WORKER_CAP_STORAGE_KEY, serializeWalletBrainVaultWorkerCap(choice));
  }
  return readWalletPreferences(storage);
};

export const walletPreferenceStorageErrorMessage = (error: unknown): string =>
  `Browser preference update failed: ${error instanceof Error ? error.message : String(error)}`;
