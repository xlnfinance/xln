const MAX_UINT256 = (1n << 256n) - 1n;

const requireTokenDecimals = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 0 || value > 255) {
    throw new Error(`TOKEN_AMOUNT_DECIMALS_INVALID:${String(value)}`);
  }
  return value;
};

export const parseTokenAmountInput = (input: string, rawDecimals: number): bigint => {
  const decimals = requireTokenDecimals(rawDecimals);
  const normalized = String(input || '').trim();
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(normalized)) {
    throw new Error('TOKEN_AMOUNT_FORMAT_INVALID');
  }
  const [wholeRaw = '0', fractionRaw = ''] = normalized.split('.');
  if (fractionRaw.length > decimals) {
    throw new Error(`TOKEN_AMOUNT_PRECISION_EXCEEDED:${fractionRaw.length}:${decimals}`);
  }
  const base = 10n ** BigInt(decimals);
  const fraction = fractionRaw.padEnd(decimals, '0');
  const amount = BigInt(wholeRaw) * base + (fraction ? BigInt(fraction) : 0n);
  if (amount <= 0n) throw new Error('TOKEN_AMOUNT_NOT_POSITIVE');
  if (amount > MAX_UINT256) throw new Error('TOKEN_AMOUNT_UINT256_OVERFLOW');
  return amount;
};

export const tokenAmountInputErrorMessage = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error || '');
  const precision = /^TOKEN_AMOUNT_PRECISION_EXCEEDED:\d+:(\d+)$/.exec(message);
  if (precision?.[1]) return `Amount supports at most ${precision[1]} decimal places`;
  if (message === 'TOKEN_AMOUNT_FORMAT_INVALID') return 'Enter a positive decimal amount';
  if (message === 'TOKEN_AMOUNT_NOT_POSITIVE') return 'Amount must be greater than zero';
  if (message === 'TOKEN_AMOUNT_UINT256_OVERFLOW') return 'Amount is too large';
  if (message.startsWith('TOKEN_AMOUNT_DECIMALS_INVALID:')) return 'Token precision is unavailable';
  return message || 'Unknown payment error';
};
