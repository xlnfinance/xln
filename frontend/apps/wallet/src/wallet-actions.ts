import { entropyToMnemonic } from '@xln/brainvault/core';

import {
  validateWalletOnboarding,
  type WalletOnboardingInput,
} from '../../../packages/runtime-client/wallet-onboarding';
import { settingsOperations } from '$lib/stores/settingsStore';
import { runtimeOperations, runtimesExternalStore } from '$lib/stores/runtimeStore';
import { vaultOperations } from '$lib/stores/vaultStore';
import type { ThemeName } from '$lib/types/ui';
import { walletBootController } from './wallet-controller';
import { walletAccountStoreController } from './features/accounts/wallet-account-store';

export const generateWalletMnemonic = async (): Promise<string> => {
  const entropy = new Uint8Array(32);
  crypto.getRandomValues(entropy);
  try {
    return await entropyToMnemonic(entropy);
  } finally {
    entropy.fill(0);
  }
};

export const createOrImportWallet = async (input: WalletOnboardingInput): Promise<void> => {
  const validation = validateWalletOnboarding(input);
  if (validation.errors.length > 0) throw new Error(validation.errors[0]);
  await vaultOperations.createRuntime(validation.normalizedLabel, validation.normalizedMnemonic, {
    loginType: 'manual',
    requiresOnboarding: true,
  });
  await walletBootController.activateRuntime();
};

export const unlockWalletRuntime = async (runtimeId: string, mnemonic: string): Promise<void> => {
  await vaultOperations.unlockRuntime(runtimeId, mnemonic);
  await walletBootController.activateRuntime();
};

export const lockWalletRuntime = async (runtimeId: string): Promise<void> => {
  await vaultOperations.lockRuntime(runtimeId);
  walletBootController.reconcile();
};

export const selectWalletRuntime = async (runtimeId: string): Promise<void> => {
  const runtime = runtimesExternalStore.getSnapshot().get(runtimeId);
  if (runtime?.type === 'remote') {
    const selected = await runtimeOperations.selectRuntime(runtimeId);
    if (!selected) throw new Error('RUNTIME_SELECTION_REJECTED');
    walletBootController.reconcile();
    await walletAccountStoreController.showActiveEntity();
    return;
  }
  const selected = await vaultOperations.selectRuntime(runtimeId);
  if (!selected) throw new Error('RUNTIME_SELECTION_REJECTED');
  await walletBootController.activateRuntime();
  await walletAccountStoreController.showActiveEntity();
};

export const recoverWalletFromConfiguredBackups = async (): Promise<void> => {
  await vaultOperations.recoverSchemaMismatchedRuntimesFromConfiguredBackups();
  await walletBootController.retry();
};

export const walletSettingsActions = Object.freeze({
  setTheme: (theme: ThemeName): void => settingsOperations.setTheme(theme),
  setLiteMode: (enabled: boolean): void => settingsOperations.setLiteMode(enabled),
  setShowTimeMachine: (enabled: boolean): void => settingsOperations.setShowTimeMachine(enabled),
  setShowXlnMascot: (enabled: boolean): void => settingsOperations.setShowXlnMascot(enabled),
});
