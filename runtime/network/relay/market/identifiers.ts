export const normalizeMarketEntityId = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return /^0x[0-9a-f]{64}$/.test(normalized) ? normalized : null;
};

export const normalizeMarketPairId = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const match = trimmed.match(/^(\d+)\/(\d+)$/);
  if (match) {
    const a = Number(match[1]);
    const b = Number(match[2]);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0 || a === b) return null;
    return `${Math.min(a, b)}/${Math.max(a, b)}`;
  }

  const crossMatch = trimmed.toLowerCase().match(/^cross:([a-z0-9:._-]+:\d+)\/([a-z0-9:._-]+:\d+)$/);
  if (!crossMatch || trimmed.length > 256) return null;
  const left = crossMatch[1] || '';
  const right = crossMatch[2] || '';
  if (!left || !right || left === right) return null;
  return `cross:${left}/${right}`;
};
