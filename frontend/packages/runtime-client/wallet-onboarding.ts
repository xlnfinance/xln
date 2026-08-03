export type WalletOnboardingMode = 'create' | 'import';

export type WalletOnboardingInput = Readonly<{
  mode: WalletOnboardingMode;
  label: string;
  mnemonic: string;
  recoveryConfirmed: boolean;
}>;

export type WalletOnboardingValidation = Readonly<{
  normalizedLabel: string;
  normalizedMnemonic: string;
  errors: readonly string[];
}>;

export const normalizeMnemonicPhrase = (value: string): string =>
  String(value || '').trim().split(/\s+/).filter(Boolean).join(' ');

export const countMnemonicWords = (value: string): number => {
  const normalized = normalizeMnemonicPhrase(value);
  return normalized ? normalized.split(' ').length : 0;
};

export const hasSupportedMnemonicWordCount = (value: string): boolean => {
  const wordCount = countMnemonicWords(value);
  return wordCount === 12 || wordCount === 24;
};

export const validateWalletOnboarding = (
  input: WalletOnboardingInput,
): WalletOnboardingValidation => {
  const normalizedLabel = input.label.trim();
  const normalizedMnemonic = normalizeMnemonicPhrase(input.mnemonic);
  const errors: string[] = [];
  if (!normalizedLabel) errors.push('Name your wallet.');
  if (!hasSupportedMnemonicWordCount(normalizedMnemonic)) {
    errors.push('Enter a complete 12-word or 24-word recovery phrase.');
  }
  if (input.mode === 'create' && !input.recoveryConfirmed) {
    errors.push('Confirm that the recovery phrase is stored safely.');
  }
  return Object.freeze({
    normalizedLabel,
    normalizedMnemonic,
    errors: Object.freeze(errors),
  });
};
