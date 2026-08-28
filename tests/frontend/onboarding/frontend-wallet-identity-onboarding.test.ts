import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  createWalletIdentityDraft,
  deriveWalletIdentityMnemonicAddress,
  validateWalletIdentityDraft,
  walletIdentityMnemonicErrorMessage,
} from '../../../frontend/apps/wallet/src/identity-onboarding-model';
import { resolveWalletAppView } from '../../../frontend/apps/wallet/src/app-shell-model';

const DEMOS = [{ label: 'A', name: 'A', password: 'session-secret', factor: 1, role: 'user' }] as const;

describe('React wallet identity onboarding', () => {
  test('opens identity for explicit setup and disposable demo links', () => {
    expect(resolveWalletAppView('')).toBe('overview');
    expect(resolveWalletAppView('?setup=1')).toBe('identity');
    expect(resolveWalletAppView('?demo=A')).toBe('identity');
    expect(resolveWalletAppView('?settings=1')).toBe('settings');
  });

  test('creates a canonical default Brain Vault draft', () => {
    expect(createWalletIdentityDraft('', DEMOS)).toEqual({
      mode: 'brainvault',
      name: '',
      passphrase: '',
      mnemonicInput: '',
      factor: 3,
      showPassphrase: false,
    });
  });

  test('uses the session-randomized demo identity and rejects unknown labels', () => {
    expect(createWalletIdentityDraft('?demo=A', DEMOS)).toMatchObject({
      name: 'A', passphrase: 'session-secret', factor: 1,
    });
    expect(() => createWalletIdentityDraft('?demo=missing', DEMOS))
      .toThrow('TESTNET_DEMO_ACCOUNT_UNKNOWN:missing');
  });

  test('validates exact Brain Vault minimums and work factor', () => {
    const invalid = validateWalletIdentityDraft({
      mode: 'brainvault', name: '', passphrase: '', mnemonicInput: '', factor: 0, showPassphrase: false,
    });
    expect(invalid.valid).toBe(false);
    expect(invalid.errors).toHaveLength(3);
    expect(validateWalletIdentityDraft({
      mode: 'brainvault', name: 'Alice', passphrase: 'correct horse battery staple',
      mnemonicInput: '', factor: 3, showPassphrase: false,
    })).toMatchObject({ valid: true, errors: [], detail: 'Factor 3 · exact name required for recovery' });
  });

  test('accepts only canonical 12- or 24-word mnemonic lengths', () => {
    const mnemonic = Array.from({ length: 12 }, () => 'test').join(' ');
    expect(validateWalletIdentityDraft({
      mode: 'mnemonic', name: '', passphrase: '', mnemonicInput: mnemonic,
      factor: 3, showPassphrase: false,
    })).toMatchObject({ valid: true, errors: [], detail: '12 words' });
    expect(validateWalletIdentityDraft({
      mode: 'mnemonic', name: '', passphrase: '', mnemonicInput: 'too short',
      factor: 3, showPassphrase: false,
    }).valid).toBe(false);
  });

  test('cryptographically validates mnemonic input before review', async () => {
    expect(await deriveWalletIdentityMnemonicAddress(
      'test test test test test test test test test test test junk',
    )).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
    await expect(deriveWalletIdentityMnemonicAddress(
      'test test test test test test test test test test test test',
    )).rejects.toThrow('WALLET_MNEMONIC_INVALID:');
    expect(walletIdentityMnemonicErrorMessage(
      new Error('WALLET_MNEMONIC_INVALID:invalid mnemonic checksum'),
    )).toBe('Seed phrase checksum or words are invalid.');

    const source = readFileSync('frontend/apps/wallet/src/identity-onboarding.tsx', 'utf8');
    expect(source).toContain('await deriveWalletIdentityMnemonicAddress(draft.mnemonicInput)');
    expect(source).toContain('setSubmissionError(walletIdentityMnemonicErrorMessage(error))');
    expect(source.indexOf('await deriveWalletIdentityMnemonicAddress('))
      .toBeLessThan(source.indexOf('setReviewing(true)'));
  });
});
