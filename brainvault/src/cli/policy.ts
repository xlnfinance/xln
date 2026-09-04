export const MIN_CLI_PASSWORD_CHARACTERS = 8;
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;
const TERMINAL_CONTROL = /\p{Cc}/u;

export function publicErrorCode(error: unknown, unknownCode: string): string {
  const message = error instanceof Error ? error.message : '';
  return message.match(/^BRAINVAULT_[A-Z0-9_]{1,64}(?=:|$)/)?.[0] ?? unknownCode;
}

const PUBLIC_ERROR_HINTS = Object.freeze({
  BRAINVAULT_PASSWORD_MODE_TERMINAL_REQUIRED: 'site passwords require alternate-screen support',
});

export function publicErrorMessage(error: unknown, unknownCode: string): string {
  const code = publicErrorCode(error, unknownCode);
  const hint = PUBLIC_ERROR_HINTS[code as keyof typeof PUBLIC_ERROR_HINTS];
  return hint === undefined ? code : `${code}: ${hint}`;
}

export function fitTerminal(text: string, width: number): string {
  if (text.length <= width) return text;
  return width <= 1 ? text.slice(0, width) : `${text.slice(0, width - 1)}…`;
}

export function cliProgressStatusLine(
  completed: number,
  shards: number,
  rate: number,
  etaText: string,
  workers: number,
  columns: number,
): string {
  const line = `     ${completed.toLocaleString('en-US')} / ${shards.toLocaleString('en-US')} shards  ·  `
    + `${rate.toFixed(rate >= 100 ? 0 : 1)} shards/s  ·  ${etaText}  ·  ${workers} workers`;
  return fitTerminal(line, columns);
}

export function cliPasswordError(passphrase: string, allowShort: boolean): string | undefined {
  if (passphrase.length === 0) return 'BRAINVAULT_PASSPHRASE_INVALID: Password cannot be empty.';
  if (!allowShort && Array.from(passphrase).length < MIN_CLI_PASSWORD_CHARACTERS) {
    return `BRAINVAULT_PASSPHRASE_TOO_SHORT: Password must contain at least ${MIN_CLI_PASSWORD_CHARACTERS} characters. `
      + 'This minimum is input hygiene, not a security recommendation; weak or reused passwords remain unsafe. '
      + 'Use --allow-short-password only to recover an existing legacy wallet.';
  }
  return undefined;
}

export function cliDomainError(domain: string): string | undefined {
  return TERMINAL_CONTROL.test(domain)
    ? 'Domain cannot contain terminal control characters.'
    : undefined;
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
