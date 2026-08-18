const REDACTED = '[REDACTED]';

const SENSITIVE_KEYS = new Set([
  'accounttxs',
  'authkey',
  'authorization',
  'bearertoken',
  'ciphertext',
  'encryptedpayload',
  'entitytxs',
  'finalarguments',
  'hanko',
  'hankodata',
  'initialarguments',
  'input',
  'mnemonic',
  'privatekey',
  'privkey',
  'rawinput',
  'rawpayload',
  'runtimeseed',
  'seed',
  'secret',
  'signature',
  'signatures',
  'token',
  'watchseed',
]);

const normalizedKey = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, '');

const redactText = (value: string): string => value
  .replace(/\bxlnra1\.[A-Za-z0-9._-]+/g, REDACTED)
  .replace(/\b(Bearer\s+)[^\s"',;]+/gi, `$1${REDACTED}`)
  .replace(
    /\b(mnemonic|private[ _-]?key|priv[ _-]?key|runtime[ _-]?seed|watch[ _-]?seed|seed|auth[ _-]?key|authorization|bearer[ _-]?token|token|hanko(?:[ _-]?data)?|ciphertext|secret|signature)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
    `$1=${REDACTED}`,
  );

export const redactTelemetryValue = (value: unknown, key = '', depth = 0): unknown => {
  if (SENSITIVE_KEYS.has(normalizedKey(key))) return REDACTED;
  if (typeof value === 'string') return redactText(value);
  if (
    value === null ||
    value === undefined ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) return value;
  if (depth >= 12) return '[DEPTH_LIMIT]';
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactText(value.message),
      ...(value.stack ? { stack: redactText(value.stack) } : {}),
    };
  }
  if (value instanceof Uint8Array) return `[BINARY_REDACTED:${value.byteLength}]`;
  if (Array.isArray(value)) {
    return value.slice(0, 200).map((entry) => redactTelemetryValue(entry, '', depth + 1));
  }
  if (value instanceof Map) {
    return Array.from(value.entries()).slice(0, 200).map(([entryKey, entryValue]) => [
      redactTelemetryValue(entryKey, '', depth + 1),
      redactTelemetryValue(entryValue, String(entryKey), depth + 1),
    ]);
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redactTelemetryValue(entryValue, entryKey, depth + 1),
      ]),
    );
  }
  return redactText(String(value));
};
