export type StorageSchemaMismatchInfo = {
  storedVersion: number;
  currentVersion: number;
};

export const parseStorageSchemaMismatch = (
  value: unknown,
): StorageSchemaMismatchInfo | null => {
  const message = value instanceof Error ? value.message : String(value ?? '');
  const match = message.match(
    /(?:^|[\s:])STORAGE_SCHEMA_MISMATCH:stored=(\d+):current=(\d+)(?=:|$)/,
  );
  if (!match) return null;
  const storedVersion = Number(match[1]);
  const currentVersion = Number(match[2]);
  if (!Number.isSafeInteger(storedVersion) || !Number.isSafeInteger(currentVersion)) return null;
  return { storedVersion, currentVersion };
};
