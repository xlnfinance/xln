/** A positive plain decimal: `coefficient / 10^scale`. */
export type PositiveDecimal = { coefficient: bigint; scale: number };

/** A positive plain decimal (no sign, exponent or grouping), at most 80 characters. */
export const parsePositiveDecimal = (value: unknown): PositiveDecimal | null => {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  if (text.length > 80) return null;
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(text);
  if (!match) return null;
  const fraction = match[2] ?? '';
  const coefficient = BigInt(`${match[1]}${fraction}`);
  return coefficient > 0n ? { coefficient, scale: fraction.length } : null;
};

/** Base units of a positive plain decimal, or null when it has more than `decimals` fraction digits. */
export const parsePositiveDecimalUnits = (value: unknown, decimals: number): bigint | null => {
  const amount = parsePositiveDecimal(value);
  if (!amount || amount.scale > decimals) return null;
  return amount.coefficient * 10n ** BigInt(decimals - amount.scale);
};
