export const requireBoundaryRecord = (
  value: unknown,
  code: string,
): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value instanceof Map) {
    throw new Error(code);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(code);
  return value as Record<string, unknown>;
};

const MAX_LISTED_KEYS = 8;
const MAX_LISTED_KEY_CHARS = 64;

// Extra key names are attacker-sized; an unbounded list made the error text
// itself oversized wherever it was logged or recorded.
const listKeys = (keys: readonly string[]): string => {
  if (keys.length === 0) return 'none';
  const shown = keys.slice(0, MAX_LISTED_KEYS).map(key =>
    key.length > MAX_LISTED_KEY_CHARS ? `${key.slice(0, MAX_LISTED_KEY_CHARS)}...` : key);
  const hidden = keys.length - shown.length;
  return hidden > 0 ? `${shown.join(',')},+${hidden}` : shown.join(',');
};

export const requireExactBoundaryKeys = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  code: string,
): void => {
  const allowed = new Set([...required, ...optional]);
  const missing = required.filter(key => !Object.hasOwn(value, key));
  const extra = Object.keys(value).filter(key => !allowed.has(key));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(`${code}:missing=${listKeys(missing)}:extra=${listKeys(extra)}`);
  }
};

export const requireBoundaryInteger = (
  value: unknown,
  code: string,
  minimum = 0,
): number => {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new Error(`${code}:${String(value)}`);
  }
  return Number(value);
};

/**
 * Decode an external uint into the JavaScript integer representation used by
 * replica state. Converting uint256 with Number(value) first is forbidden:
 * values above 2^53 would round and could alias a different financial nonce.
 */
export const requireBoundaryUint = (
  value: unknown,
  code: string,
): number => {
  let integer: bigint;
  try {
    if (typeof value === 'bigint') {
      integer = value;
    } else if (typeof value === 'number' && Number.isSafeInteger(value)) {
      integer = BigInt(value);
    } else if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) {
      integer = BigInt(value);
    } else {
      throw new Error(code);
    }
  } catch {
    throw new Error(`${code}:${String(value)}`);
  }
  if (integer < 0n || integer > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${code}:${String(value)}`);
  }
  return Number(integer);
};
