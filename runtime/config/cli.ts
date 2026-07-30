const optionWithEquals = (argument: string, name: string): string | null =>
  argument.startsWith(`${name}=`) ? argument.slice(name.length + 1) : null;

export function readCliOption(
  args: readonly string[],
  name: string,
): string | undefined;
export function readCliOption(
  args: readonly string[],
  name: string,
  fallback: string,
): string;
/**
 * Decode one CLI option. A present option is operator intent, therefore a
 * missing value is an error rather than permission to use the default.
 */
export function readCliOption(
  args: readonly string[],
  name: string,
  fallback?: string,
): string | undefined {
  const equalsValues = args
    .map(argument => optionWithEquals(argument, name))
    .filter((value): value is string => value !== null);
  const indexes = args.flatMap((argument, index) =>
    argument === name ? [index] : [],
  );
  if (equalsValues.length + indexes.length > 1) {
    throw new Error(`CLI_OPTION_DUPLICATE:${name}`);
  }
  if (equalsValues.length === 1) {
    const value = equalsValues[0]!;
    if (value.length === 0) throw new Error(`CLI_OPTION_VALUE_MISSING:${name}`);
    return value;
  }
  if (indexes.length === 0) return fallback;
  const value = args[indexes[0]! + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`CLI_OPTION_VALUE_MISSING:${name}`);
  }
  return value;
}

export const hasCliFlag = (args: readonly string[], name: string): boolean => {
  if (args.some(argument => argument.startsWith(`${name}=`))) {
    throw new Error(`CLI_FLAG_VALUE_FORBIDDEN:${name}`);
  }
  return args.includes(name);
};
