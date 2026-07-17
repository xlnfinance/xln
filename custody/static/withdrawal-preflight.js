const requireDecimals = (value) => {
  const decimals = Number(value);
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new Error('Invalid custody token decimals');
  }
  return decimals;
};

export const parseDisplayAmountMinor = (value, tokenDecimals) => {
  const amount = String(value || '').trim();
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/.exec(amount);
  if (!match) throw new Error('Enter a valid amount');

  const decimals = requireDecimals(tokenDecimals);
  const fraction = match[2] || '';
  if (fraction.length > decimals) {
    throw new Error(`Amount supports at most ${decimals} decimal places`);
  }

  const scale = 10n ** BigInt(decimals);
  const wholeMinor = BigInt(match[1]) * scale;
  const fractionalMinor = fraction ? BigInt(fraction.padEnd(decimals, '0')) : 0n;
  return wholeMinor + fractionalMinor;
};

export const assertWithdrawalWithinDisplayedBalance = (amount, token) => {
  const amountMinor = parseDisplayAmountMinor(amount, token.decimals);
  if (amountMinor <= 0n) throw new Error('amount must be positive');

  const available = String(token.amountMinor || '');
  if (!/^(0|[1-9][0-9]*)$/.test(available)) {
    throw new Error('Invalid custody balance');
  }
  if (amountMinor > BigInt(available)) {
    throw new Error('Insufficient custody balance');
  }
};
