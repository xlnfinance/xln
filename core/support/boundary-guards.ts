/** Shared boundary guards for storage and wire decoders. */

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Map);

export const record = (value: unknown, code: string): Record<string, unknown> => {
  if (!isRecord(value)) throw new Error(code);
  return value;
};

export const exactKeys = (value: Record<string, unknown>, expected: readonly string[], code: string): void => {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) {
    throw new Error(`${code}_FIELDS:${actual.join(',')}`);
  }
};

export const normalizeEntityRef = (value: unknown): string =>
  String(value || '')
    .trim()
    .toLowerCase();

export const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
