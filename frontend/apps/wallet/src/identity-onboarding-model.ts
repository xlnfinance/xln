import { BRAINVAULT_V1 } from '../../../../brainvault/primitives/spec.ts';
import type { DemoAccount } from '$lib/config/demo-accounts';
import type {
  WalletIdentityEntryState,
  WalletIdentityMode,
} from '../../../packages/browser/src/wallet-identity-entry';
import {
  countMnemonicWords,
  hasSupportedMnemonicWordCount,
  normalizeMnemonicPhrase,
} from '../../../src/lib/components/Views/runtime-creation-model';
import {
  evaluateWalletRecoveryRehearsal,
  resetWalletRecoveryRehearsal,
  type WalletRecoveryRehearsalState,
} from '../../../packages/browser/src/wallet-recovery-rehearsal';

export type WalletIdentityDraft = WalletIdentityEntryState & Readonly<{
  name: string;
  factor: number;
}>;

export type WalletIdentityDraftValidation = Readonly<{
  valid: boolean;
  errors: readonly string[];
  detail: string;
}>;

export const resolveWalletAppView = (search: string): 'overview' | 'identity' => {
  const params = new URLSearchParams(search);
  return params.get('setup') === '1' || params.has('demo') ? 'identity' : 'overview';
};

export const createWalletIdentityDraft = (
  search: string,
  demoAccounts: readonly DemoAccount[],
): WalletIdentityDraft => {
  const demoLabel = new URLSearchParams(search).get('demo');
  if (demoLabel === null) {
    return {
      mode: 'brainvault',
      name: '',
      passphrase: '',
      mnemonicInput: '',
      factor: 3,
      showPassphrase: false,
    };
  }
  const demo = demoAccounts.find(({ label }) => label === demoLabel);
  if (!demo) throw new Error(`TESTNET_DEMO_ACCOUNT_UNKNOWN:${demoLabel}`);
  return {
    mode: 'brainvault',
    name: demo.name,
    passphrase: demo.password,
    mnemonicInput: '',
    factor: demo.factor,
    showPassphrase: false,
  };
};

export const validateWalletIdentityDraft = (
  draft: WalletIdentityDraft,
): WalletIdentityDraftValidation => {
  const errors: string[] = [];
  if (draft.mode === 'brainvault') {
    if (draft.name.length < BRAINVAULT_V1.MIN_NAME_LENGTH) {
      errors.push(`Vault name must be at least ${BRAINVAULT_V1.MIN_NAME_LENGTH} characters.`);
    }
    if (draft.passphrase.length < BRAINVAULT_V1.MIN_PASSPHRASE_LENGTH) {
      errors.push(`Passphrase must be at least ${BRAINVAULT_V1.MIN_PASSPHRASE_LENGTH} characters.`);
    }
    if (!Number.isSafeInteger(draft.factor) || draft.factor < 1 || draft.factor > 5) {
      errors.push('Work factor must be a whole number from 1 to 5.');
    }
    return {
      valid: errors.length === 0,
      errors,
      detail: `Factor ${draft.factor} · exact name required for recovery`,
    };
  }

  const wordCount = countMnemonicWords(draft.mnemonicInput);
  if (!hasSupportedMnemonicWordCount(draft.mnemonicInput)) {
    errors.push('Enter exactly 12 or 24 BIP39 words.');
  }
  return {
    valid: errors.length === 0,
    errors,
    detail: wordCount === 0 ? '12 or 24 words' : `${wordCount} words`,
  };
};

export const walletIdentityModeLabel = (mode: WalletIdentityMode): string => mode === 'brainvault'
  ? 'Brain Vault'
  : 'Mnemonic';

export const normalizeWalletIdentityMnemonic = normalizeMnemonicPhrase;

export const deriveWalletIdentityMnemonicAddress = async (
  mnemonicInput: string,
): Promise<string> => {
  const { deriveEthereumAddress } = await import('../../../../brainvault/core.ts');
  try {
    return await deriveEthereumAddress(normalizeWalletIdentityMnemonic(mnemonicInput));
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`WALLET_MNEMONIC_INVALID:${detail}`);
  }
};

export const walletIdentityMnemonicErrorMessage = (error: unknown): string => {
  const detail = error instanceof Error ? error.message : String(error);
  return detail.startsWith('WALLET_MNEMONIC_INVALID:')
    ? 'Seed phrase checksum or words are invalid.'
    : `Mnemonic validation failed: ${detail}`;
};

export const beginWalletMnemonicRecoveryRehearsal = (
  address: string,
): WalletRecoveryRehearsalState => {
  const result = evaluateWalletRecoveryRehearsal({
    state: { ...resetWalletRecoveryRehearsal(), enabled: true },
    mode: 'mnemonic',
    address,
  });
  if (result.status !== 'begin') {
    throw new Error(`WALLET_MNEMONIC_RECOVERY_BEGIN_INVALID:${result.status}`);
  }
  return result.state;
};

export type WalletMnemonicRecoveryAttempt = Readonly<{
  matched: boolean;
  state: WalletRecoveryRehearsalState;
  error: string;
}>;

export const evaluateWalletMnemonicRecoveryAttempt = (
  state: WalletRecoveryRehearsalState,
  address: string,
): WalletMnemonicRecoveryAttempt => {
  const result = evaluateWalletRecoveryRehearsal({ state, mode: 'mnemonic', address });
  if (result.status === 'mismatch') {
    return { matched: false, state: result.state, error: result.message };
  }
  if (result.status !== 'matched') {
    throw new Error(`WALLET_MNEMONIC_RECOVERY_ATTEMPT_INVALID:${result.status}`);
  }
  return { matched: true, state: result.state, error: '' };
};
