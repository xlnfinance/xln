export const formatUsdTicks = (value: string | null): string => {
  if (value === null) return '—';
  const dollars = BigInt(value) / 10_000n;
  const units = [
    { threshold: 1_000_000_000_000n, divisor: 1_000_000_000_000n, suffix: 'T' },
    { threshold: 1_000_000_000n, divisor: 1_000_000_000n, suffix: 'B' },
    { threshold: 1_000_000n, divisor: 1_000_000n, suffix: 'M' },
    { threshold: 1_000n, divisor: 1_000n, suffix: 'K' },
  ];
  const unit = units.find(candidate => dollars >= candidate.threshold);
  if (!unit) return `$${dollars.toString()}`;
  const tenths = (dollars * 10n) / unit.divisor;
  return `$${(tenths / 10n).toString()}.${(tenths % 10n).toString()}${unit.suffix}`;
};
