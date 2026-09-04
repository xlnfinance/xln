export const MIN_CLI_PASSWORD_CHARACTERS = 8;
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
  _name: string,
  _passphrase: string,
  _unicodeRecovery: boolean,
): undefined {
  // V1 owns Unicode normalization, so the CLI must not create a second,
  // ASCII-only input language. The legacy flag remains accepted because old
  // recovery instructions may contain it, but Unicode is valid without it.
  return undefined;
}
