/**
 * Read one positive integer from an environment map.
 *
 * Absence selects the documented default. Presence is an operator decision,
 * so malformed, fractional, zero or negative values fail startup instead of
 * silently changing production limits.
 */
const readProcessEnvironment = (): Readonly<Record<string, string | undefined>> =>
  typeof process === 'undefined' ? {} : process.env;

export const readPositiveIntegerEnv = (
  name: string,
  defaultValue: number,
  environment: Readonly<Record<string, string | undefined>> = readProcessEnvironment(),
): number => {
  if (!Number.isSafeInteger(defaultValue) || defaultValue <= 0) {
    throw new Error(`ENV_POSITIVE_INTEGER_DEFAULT_INVALID:${name}:${defaultValue}`);
  }
  const raw = environment[name];
  if (raw === undefined) return defaultValue;
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`ENV_POSITIVE_INTEGER_INVALID:${name}:${raw}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`ENV_POSITIVE_INTEGER_UNSAFE:${name}:${raw}`);
  }
  return value;
};

/**
 * Decode an operator boolean exactly once.
 *
 * A typo must not silently disable a safety or diagnostics switch. Only an
 * absent variable may select the caller's documented default.
 */
export const readBooleanEnv = (
  name: string,
  defaultValue: boolean,
  environment: Readonly<Record<string, string | undefined>> = readProcessEnvironment(),
): boolean => {
  const raw = environment[name];
  if (raw === undefined) return defaultValue;
  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`ENV_BOOLEAN_INVALID:${name}:${raw}`);
};
