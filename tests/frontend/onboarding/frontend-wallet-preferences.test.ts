import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  persistWalletAuthScheme,
  persistWalletWorkerCap,
  readWalletPreferences,
  walletPreferenceStorageErrorMessage,
  type WalletPreferenceStorage,
} from '../../../frontend/apps/wallet/src/wallet-settings-model';

const createStorage = (
  entries: readonly (readonly [string, string])[] = [],
): WalletPreferenceStorage & Readonly<{ values: Map<string, string> }> => {
  const values = new Map(entries);
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
};

describe('React wallet browser preferences', () => {
  test('reads canonical scheme and worker-cap storage with safe defaults', () => {
    expect(readWalletPreferences(createStorage())).toEqual({
      authScheme: 'dark',
      brainVaultWorkerCap: null,
    });
    expect(readWalletPreferences(createStorage([
      ['xln-auth-scheme', 'light'],
      ['xln-brainvault-worker-cap-v1', '4'],
    ]))).toEqual({ authScheme: 'light', brainVaultWorkerCap: 4 });
    expect(readWalletPreferences(createStorage([
      ['xln-auth-scheme', 'unknown'],
      ['xln-brainvault-worker-cap-v1', '0'],
    ]))).toEqual({ authScheme: 'dark', brainVaultWorkerCap: null });
  });

  test('persists exact schemes and bounded worker caps through canonical keys', () => {
    const storage = createStorage();
    expect(persistWalletAuthScheme(storage, 'light').authScheme).toBe('light');
    expect(persistWalletWorkerCap(storage, 3).brainVaultWorkerCap).toBe(3);
    expect(storage.values.get('xln-auth-scheme')).toBe('light');
    expect(storage.values.get('xln-brainvault-worker-cap-v1')).toBe('3');
    expect(() => persistWalletWorkerCap(storage, 9))
      .toThrow('WALLET_BRAINVAULT_WORKER_CAP_INVALID:9');
  });

  test('restores automatic concurrency by removing only the worker-cap key', () => {
    const storage = createStorage([
      ['xln-auth-scheme', 'light'],
      ['xln-brainvault-worker-cap-v1', '2'],
    ]);
    expect(persistWalletWorkerCap(storage, 'automatic')).toEqual({
      authScheme: 'light',
      brainVaultWorkerCap: null,
    });
    expect(storage.values.has('xln-brainvault-worker-cap-v1')).toBe(false);
    expect(storage.values.get('xln-auth-scheme')).toBe('light');
  });

  test('reports storage failures without claiming success', () => {
    const storage: WalletPreferenceStorage = {
      getItem: () => null,
      setItem: () => { throw new Error('quota denied'); },
      removeItem: () => { throw new Error('storage blocked'); },
    };
    expect(() => persistWalletAuthScheme(storage, 'light')).toThrow('quota denied');
    expect(() => persistWalletWorkerCap(storage, 'automatic')).toThrow('storage blocked');
    expect(walletPreferenceStorageErrorMessage(new Error('quota denied')))
      .toBe('Browser preference update failed: quota denied');
  });

  test('keeps secrets and Runtime state outside the preference surface', () => {
    const model = readFileSync('frontend/apps/wallet/src/wallet-settings-model.ts', 'utf8');
    const view = readFileSync('frontend/apps/wallet/src/wallet-settings.tsx', 'utf8');
    const source = `${model}\n${view}`;
    expect(source).not.toContain('passphrase');
    expect(source).not.toContain('mnemonicInput');
    expect(source).not.toContain('privateKey');
    expect(source).not.toContain('xln-vaults');
    expect(view).toContain('onAuthSchemeChange(next.authScheme)');
  });
});
