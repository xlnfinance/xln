export const normalizeSignatureMap = (value: unknown): Map<string, string[]> | undefined => {
  if (!value) return undefined;
  if (value instanceof Map) return value as Map<string, string[]>;

  const entries: Array<[string, string[]]> = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!Array.isArray(item) || item.length < 2) continue;
      const signerId = typeof item[0] === 'string' ? item[0] : String(item[0] ?? '');
      const sigs = Array.isArray(item[1]) ? item[1].map(sig => String(sig)) : [];
      if (signerId && sigs.length > 0) entries.push([signerId, sigs]);
    }
  } else if (typeof value === 'object') {
    for (const [signerId, sigValue] of Object.entries(value as Record<string, unknown>)) {
      const sigs = Array.isArray(sigValue) ? sigValue.map(sig => String(sig)) : [];
      if (signerId && sigs.length > 0) entries.push([signerId, sigs]);
    }
  }

  return entries.length > 0 ? new Map(entries) : undefined;
};

export const signatureMapSize = (value: unknown): number =>
  normalizeSignatureMap(value)?.size ?? 0;
