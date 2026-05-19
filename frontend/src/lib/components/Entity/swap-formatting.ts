export function decimalPlacesFromScale(scale: bigint): number {
  const raw = scale.toString();
  return /^10*$/.test(raw) ? Math.max(0, raw.length - 1) : 0;
}

export function parseDecimalAmountToBigInt(raw: string, decimals: number): bigint {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return 0n;
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return 0n;
  const [wholeRaw, fracRaw = ''] = trimmed.split('.');
  const whole = BigInt(wholeRaw || '0');
  const normalizedDecimals = Math.max(0, Math.floor(decimals || 0));
  const scale = 10n ** BigInt(normalizedDecimals);
  const fracPadded = (fracRaw + '0'.repeat(normalizedDecimals)).slice(0, normalizedDecimals);
  const frac = fracPadded ? BigInt(fracPadded) : 0n;
  return whole * scale + frac;
}

export function normalizeDecimalInput(raw: string, maxDecimals: number): string {
  const prepared = String(raw || '').replace(',', '.').replace(/[^\d.]/g, '');
  if (!prepared) return '';
  const dotIndex = prepared.indexOf('.');
  const hasDot = dotIndex >= 0;
  const wholeRaw = hasDot ? prepared.slice(0, dotIndex) : prepared;
  const fracRaw = hasDot ? prepared.slice(dotIndex + 1).replace(/\./g, '') : '';
  const whole = wholeRaw === '' ? '0' : wholeRaw.replace(/^0+(?=\d)/, '');
  const frac = fracRaw.slice(0, Math.max(0, maxDecimals));
  if (hasDot) return `${whole}.${frac}`;
  return whole;
}

export function normalizeDisplayPriceForInput(value: string): string {
  return String(value || '').replace(/,/g, '').trim();
}

export function compareStableText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function toBigIntSafe(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return BigInt(value.trim());
  return null;
}
