export const MIN_CLI_PASSWORD_CHARACTERS = 8;
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;

export function cliPasswordError(passphrase: string, allowShort: boolean): string | undefined {
  if (passphrase.length === 0) return 'BRAINVAULT_PASSPHRASE_INVALID: Password cannot be empty.';
  if (!allowShort && Array.from(passphrase).length < MIN_CLI_PASSWORD_CHARACTERS) {
    return `BRAINVAULT_PASSPHRASE_TOO_SHORT: Password must contain at least ${MIN_CLI_PASSWORD_CHARACTERS} characters. `
      + 'This minimum is input hygiene, not a security recommendation; weak or reused passwords remain unsafe. '
      + 'Use --allow-short-password only to recover an existing legacy wallet.';
  }
  return undefined;
}

export function cliCreationCharacterError(
  name: string,
  passphrase: string,
  unicodeRecovery: boolean,
): string | undefined {
  if (unicodeRecovery || (PRINTABLE_ASCII.test(name) && PRINTABLE_ASCII.test(passphrase))) return undefined;
  return 'BRAINVAULT_ASCII_CREATION_REQUIRED: use printable ASCII for new wallets, '
    + 'or --unicode-recovery for exact recovery of an existing Unicode/control-character wallet.';
}
