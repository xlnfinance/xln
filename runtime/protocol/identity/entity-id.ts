/**
 * Canonical Entity identifier ordering shared by every RJEA layer.
 *
 * Bilateral Account consensus relies on this exact lexicographic order:
 * the lower normalized Entity ID is LEFT. Never replace it with local signer,
 * connection direction, or proposal arrival order; those differ across peers.
 */
export const normalizeEntityId = (id: string): string => {
  const raw = String(id).toLowerCase();
  if (!raw.startsWith('0x')) return raw;
  const hex = raw.slice(2);
  if (!/^[0-9a-f]*$/.test(hex)) return raw;
  if (hex.length === 64) return raw;
  return hex.length < 64 ? `0x${hex.padStart(64, '0')}` : raw;
};

export const compareEntityIds = (first: string, second: string): number => {
  const left = normalizeEntityId(first);
  const right = normalizeEntityId(second);
  if (left === right) return 0;
  return left < right ? -1 : 1;
};

export const isLeftEntity = (entityId: string, counterpartyId: string): boolean =>
  compareEntityIds(entityId, counterpartyId) < 0;
