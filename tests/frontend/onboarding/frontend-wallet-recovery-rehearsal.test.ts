import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  beginWalletMnemonicRecoveryRehearsal,
  deriveWalletIdentityMnemonicAddress,
  evaluateWalletMnemonicRecoveryAttempt,
} from '../../../frontend/apps/wallet/src/identity-onboarding-model';

const FIRST_MNEMONIC = 'test test test test test test test test test test test junk';
const SECOND_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('React wallet mnemonic recovery rehearsal', () => {
  test('keeps only the first public address and rejects a different valid wallet', async () => {
    const firstAddress = await deriveWalletIdentityMnemonicAddress(FIRST_MNEMONIC);
    const secondAddress = await deriveWalletIdentityMnemonicAddress(SECOND_MNEMONIC);
    const rehearsal = beginWalletMnemonicRecoveryRehearsal(firstAddress);

    expect(rehearsal).toEqual({
      enabled: true,
      mode: 'mnemonic',
      expectedAddress: firstAddress.toLowerCase(),
    });
    expect(evaluateWalletMnemonicRecoveryAttempt(rehearsal, secondAddress)).toEqual({
      matched: false,
      state: rehearsal,
      error: 'Recovery rehearsal did not reproduce the same wallet. Check every input and try again.',
    });
  });

  test('accepts the same wallet case-insensitively and clears rehearsal state', async () => {
    const address = await deriveWalletIdentityMnemonicAddress(FIRST_MNEMONIC);
    const rehearsal = beginWalletMnemonicRecoveryRehearsal(address);

    expect(evaluateWalletMnemonicRecoveryAttempt(rehearsal, address.toUpperCase())).toEqual({
      matched: true,
      state: { enabled: false, mode: null, expectedAddress: '' },
      error: '',
    });
  });

  test('clears both seed entries and keeps verified output secret-free', () => {
    const onboarding = readFileSync('frontend/apps/wallet/src/identity-onboarding.tsx', 'utf8');
    const recovery = readFileSync('frontend/apps/wallet/src/identity-recovery.tsx', 'utf8');

    expect(onboarding).toContain("setDraft((current) => ({ ...current, mnemonicInput: '' }))");
    expect(onboarding).toContain('setRecoveryVerified(true)');
    expect(recovery).toContain('Both seed entries were cleared.');
    expect(recovery).not.toContain('mnemonicInput');
    expect(recovery).not.toContain('localStorage');
    expect(recovery).not.toContain('sessionStorage');
  });
});
