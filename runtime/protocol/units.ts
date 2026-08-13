/**
 * Protocol coordinate units.
 *
 * These brands are minted only after an exact integer/range check. They are
 * intentionally boundary-focused: committed schemas keep their primitive
 * representation and reducers can continue to perform ordinary arithmetic.
 */
declare const UnixMsBrand: unique symbol;
declare const UnixSBrand: unique symbol;
declare const JHeightBrand: unique symbol;
declare const RuntimeHeightBrand: unique symbol;
declare const EntityHeightBrand: unique symbol;
declare const AccountHeightBrand: unique symbol;

export type UnixMs = number & { readonly [UnixMsBrand]: typeof UnixMsBrand };
export type UnixS = number & { readonly [UnixSBrand]: typeof UnixSBrand };
export type JHeight = number & { readonly [JHeightBrand]: typeof JHeightBrand };
export type RuntimeHeight = number & { readonly [RuntimeHeightBrand]: typeof RuntimeHeightBrand };
export type EntityHeight = number & { readonly [EntityHeightBrand]: typeof EntityHeightBrand };
export type AccountHeight = number & { readonly [AccountHeightBrand]: typeof AccountHeightBrand };

const requireCoordinate = (value: number, code: string): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${code}:${String(value)}`);
  }
  return value;
};

export const toUnixMs = (value: number): UnixMs =>
  requireCoordinate(value, 'PROTOCOL_UNIX_MS_INVALID') as UnixMs;

export const toUnixS = (value: number): UnixS =>
  requireCoordinate(value, 'PROTOCOL_UNIX_S_INVALID') as UnixS;

export const toJHeight = (value: number): JHeight =>
  requireCoordinate(value, 'PROTOCOL_J_HEIGHT_INVALID') as JHeight;

export const toRuntimeHeight = (value: number): RuntimeHeight =>
  requireCoordinate(value, 'PROTOCOL_RUNTIME_HEIGHT_INVALID') as RuntimeHeight;

export const toEntityHeight = (value: number): EntityHeight =>
  requireCoordinate(value, 'PROTOCOL_ENTITY_HEIGHT_INVALID') as EntityHeight;

export const toAccountHeight = (value: number): AccountHeight =>
  requireCoordinate(value, 'PROTOCOL_ACCOUNT_HEIGHT_INVALID') as AccountHeight;

/** Exact, named conversion at the off-chain/on-chain time-unit boundary. */
export const unixMsToUnixSFloor = (value: UnixMs): UnixS =>
  toUnixS(Math.floor(value / 1_000));

export const unixSToUnixMs = (value: UnixS): UnixMs =>
  toUnixMs(value * 1_000);

/**
 * Convert an exclusive bigint unix-ms deadline to the greatest representable
 * inclusive unix-second deadline. Account state intentionally keeps bigint
 * arithmetic; only the ABI boundary receives the branded second value.
 */
export const exclusiveUnixMsBigIntToUnixS = (
  value: bigint,
  invalidCode: string,
): UnixS => {
  const seconds = (value - 1n) / 1_000n;
  if (seconds <= 0n || seconds > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(invalidCode);
  }
  return toUnixS(Number(seconds));
};
