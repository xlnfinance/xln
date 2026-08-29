import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  WALLET_AUTH_SCHEME_STORAGE_KEY,
  parseWalletBrainVaultWorkerCap,
  resolveWalletAuthScheme,
  resolveWalletUnlockDurationMs,
  serializeWalletBrainVaultWorkerCap,
} from '../../../frontend/packages/browser/src/wallet-runtime-preferences';

describe('browser wallet Runtime preferences', () => {
  test('preserves the existing auth-scheme storage key', () => {
    expect(WALLET_AUTH_SCHEME_STORAGE_KEY).toBe('xln-auth-scheme');
  });

  test('accepts only the explicit light scheme and otherwise defaults dark', () => {
    expect(resolveWalletAuthScheme('light')).toBe('light');
    expect(resolveWalletAuthScheme('dark')).toBe('dark');
    expect(resolveWalletAuthScheme('LIGHT')).toBe('dark');
    expect(resolveWalletAuthScheme('invalid')).toBe('dark');
    expect(resolveWalletAuthScheme(null)).toBe('dark');
  });

  test('resolves every unlock-duration choice without browser state', () => {
    expect(resolveWalletUnlockDurationMs('10m', 600_000)).toBe(600_000);
    expect(resolveWalletUnlockDurationMs('10m', 123_456)).toBe(123_456);
    expect(resolveWalletUnlockDurationMs('1d', 600_000)).toBe(86_400_000);
    expect(resolveWalletUnlockDurationMs('forever', 600_000)).toBeNull();
  });

  test('parses only positive finite worker-cap integers', () => {
    expect(parseWalletBrainVaultWorkerCap('8')).toBe(8);
    expect(parseWalletBrainVaultWorkerCap('3.9')).toBe(3);
    expect(parseWalletBrainVaultWorkerCap('0.9')).toBeNull();
    expect(parseWalletBrainVaultWorkerCap('0')).toBeNull();
    expect(parseWalletBrainVaultWorkerCap('-2')).toBeNull();
    expect(parseWalletBrainVaultWorkerCap('Infinity')).toBeNull();
    expect(parseWalletBrainVaultWorkerCap('not-a-number')).toBeNull();
    expect(parseWalletBrainVaultWorkerCap(null)).toBeNull();
  });

  test('serializes worker caps with the existing floor and minimum policy', () => {
    expect(serializeWalletBrainVaultWorkerCap(8)).toBe('8');
    expect(serializeWalletBrainVaultWorkerCap(3.9)).toBe('3');
    expect(serializeWalletBrainVaultWorkerCap(0)).toBe('1');
    expect(serializeWalletBrainVaultWorkerCap(-4)).toBe('1');
  });

  test('keeps concrete localStorage effects in the Svelte event flow', () => {
    const boundary = readFileSync(
      'frontend/packages/browser/src/wallet-runtime-preferences.ts',
      'utf8',
    );
    const view = readFileSync(
      'frontend/src/lib/components/Views/RuntimeCreation.svelte',
      'utf8',
    );

    expect(boundary).not.toContain('localStorage');
    expect(boundary).not.toContain('svelte');
    expect(view).toContain('resolveWalletUnlockDurationMs(');
    expect(view).toContain('parseWalletBrainVaultWorkerCap(');
    expect(view).toContain('serializeWalletBrainVaultWorkerCap(cap)');
    expect(view).toContain('localStorage.getItem(WALLET_AUTH_SCHEME_STORAGE_KEY)');
    expect(view).toContain('localStorage.setItem(WALLET_AUTH_SCHEME_STORAGE_KEY, next)');
    expect(view).not.toContain('const AUTH_SCHEME_STORAGE_KEY');
    expect(view).not.toContain("unlockDurationChoice === 'forever'");
  });
});
