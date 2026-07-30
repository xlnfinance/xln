/**
 * Read one positive integer from an environment map.
 *
 * Absence selects the documented default. Presence is an operator decision,
 * so malformed, fractional, zero or negative values fail startup instead of
 * silently changing production limits.
 */
export const readPositiveIntegerEnv = (
  name: string,
  fallback: number,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): number => {
  if (!Number.isSafeInteger(fallback) || fallback <= 0) {
    throw new Error(`ENV_POSITIVE_INTEGER_FALLBACK_INVALID:${name}:${fallback}`);
  }
  const raw = environment[name];
  if (raw === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`ENV_POSITIVE_INTEGER_INVALID:${name}:${raw}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`ENV_POSITIVE_INTEGER_UNSAFE:${name}:${raw}`);
  }
  return value;
};
