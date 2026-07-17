export function requireTokenDecimals(value: unknown, identity: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 255) {
    throw new Error(`TOKEN_DECIMALS_REQUIRED:${identity}:${String(value)}`);
  }
  return value;
}
