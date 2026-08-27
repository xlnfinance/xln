import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  WALLET_IDENTITY_MODES,
  resolveWalletIdentityModeNavigation,
  selectWalletIdentityMode,
  type WalletIdentityEntryState,
  type WalletIdentityMode,
} from '../../../frontend/packages/browser/src/wallet-identity-entry';

const identityState = (
  mode: WalletIdentityMode,
  overrides: Partial<WalletIdentityEntryState> = {},
): WalletIdentityEntryState => ({
  mode,
  passphrase: 'brain-vault-secret',
  mnemonicInput: 'mnemonic seed words',
  showPassphrase: true,
  ...overrides,
});

describe('browser wallet identity entry', () => {
  test('exposes only the canonical Brain Vault and mnemonic modes', () => {
    expect(WALLET_IDENTITY_MODES).toEqual(['brainvault', 'mnemonic']);
    expect(Object.isFrozen(WALLET_IDENTITY_MODES)).toBe(true);
  });

  test('blocks mode changes after the input phase starts deriving', () => {
    const state = identityState('brainvault');

    expect(selectWalletIdentityMode({
      state,
      phase: 'deriving',
      rehearsalMode: null,
      nextMode: 'mnemonic',
    })).toBe(state);
  });

  test('blocks modes outside the active recovery rehearsal', () => {
    const state = identityState('mnemonic');

    expect(selectWalletIdentityMode({
      state,
      phase: 'input',
      rehearsalMode: 'mnemonic',
      nextMode: 'brainvault',
    })).toBe(state);
  });

  test('preserves sensitive fields when selecting the active mode again', () => {
    const state = identityState('brainvault');

    expect(selectWalletIdentityMode({
      state,
      phase: 'input',
      rehearsalMode: null,
      nextMode: 'brainvault',
    })).toBe(state);
  });

  test('clears the Brain Vault secret when moving to mnemonic entry', () => {
    const state = identityState('brainvault');

    expect(selectWalletIdentityMode({
      state,
      phase: 'input',
      rehearsalMode: null,
      nextMode: 'mnemonic',
    })).toEqual({
      mode: 'mnemonic',
      passphrase: '',
      mnemonicInput: state.mnemonicInput,
      showPassphrase: false,
    });
  });

  test('clears mnemonic input when moving to Brain Vault entry', () => {
    const state = identityState('mnemonic');

    expect(selectWalletIdentityMode({
      state,
      phase: 'input',
      rehearsalMode: null,
      nextMode: 'brainvault',
    })).toEqual({
      mode: 'brainvault',
      passphrase: state.passphrase,
      mnemonicInput: '',
      showPassphrase: false,
    });
  });

  test('resolves Home and End to the first and last canonical modes', () => {
    expect(resolveWalletIdentityModeNavigation({
      currentMode: 'mnemonic',
      key: 'Home',
      rehearsalMode: null,
    })).toBe('brainvault');
    expect(resolveWalletIdentityModeNavigation({
      currentMode: 'brainvault',
      key: 'End',
      rehearsalMode: null,
    })).toBe('mnemonic');
  });

  test('wraps arrow-key navigation in both directions', () => {
    expect(resolveWalletIdentityModeNavigation({
      currentMode: 'mnemonic',
      key: 'ArrowRight',
      rehearsalMode: null,
    })).toBe('brainvault');
    expect(resolveWalletIdentityModeNavigation({
      currentMode: 'brainvault',
      key: 'ArrowLeft',
      rehearsalMode: null,
    })).toBe('mnemonic');
  });

  test('keeps keyboard navigation inside the rehearsal mode', () => {
    for (const key of ['Home', 'End', 'ArrowRight', 'ArrowLeft']) {
      expect(resolveWalletIdentityModeNavigation({
        currentMode: 'mnemonic',
        key,
        rehearsalMode: 'mnemonic',
      })).toBe('mnemonic');
    }
  });

  test('ignores keys that do not navigate the tab list', () => {
    expect(resolveWalletIdentityModeNavigation({
      currentMode: 'brainvault',
      key: 'Enter',
      rehearsalMode: null,
    })).toBeNull();
  });

  test('keeps focus and field publication in the canonical Svelte view', () => {
    const boundary = readFileSync(
      'frontend/packages/browser/src/wallet-identity-entry.ts',
      'utf8',
    );
    const view = readFileSync(
      'frontend/src/lib/components/Views/RuntimeCreation.svelte',
      'utf8',
    );

    expect(boundary).not.toContain('svelte');
    expect(boundary).not.toContain('document.');
    expect(boundary).not.toContain('@xln/brainvault');
    expect(view).toContain('const nextState = selectWalletIdentityMode({');
    expect(view).toContain('const nextMode = resolveWalletIdentityModeNavigation({');
    expect(view).toContain('document.getElementById(`wallet-mode-${next}`)?.focus()');
    expect(view).toContain('event.preventDefault()');
    expect(view).not.toContain("(['brainvault', 'mnemonic'] as const).filter");
  });
});
