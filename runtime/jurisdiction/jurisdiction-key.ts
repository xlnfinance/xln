import { normalizeLoopbackUrl } from '../loopback-url';

export type WritableJurisdictionEntry = Record<string, unknown> & {
  primary?: unknown;
  rpc?: unknown;
  status?: unknown;
  contracts?: Record<string, unknown> | undefined;
};

const normalizeKeySegment = (value: unknown): string =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');

const hasRequiredContracts = (entry: WritableJurisdictionEntry): boolean =>
  Boolean(entry.contracts?.['depository'] && entry.contracts['entityProvider']);

const isActiveJurisdiction = (entry: WritableJurisdictionEntry): boolean =>
  String(entry.status || 'active').trim().toLowerCase() === 'active';

const sameRpc = (left: unknown, right: unknown): boolean => {
  const leftRaw = String(left || '').trim();
  const rightRaw = String(right || '').trim();
  if (!leftRaw || !rightRaw) return false;
  if (leftRaw === rightRaw) return true;
  return normalizeLoopbackUrl(leftRaw) === normalizeLoopbackUrl(rightRaw);
};

export const normalizeJurisdictionKey = (value: unknown, fallback = 'primary'): string =>
  normalizeKeySegment(value) || normalizeKeySegment(fallback) || 'primary';

export const selectWritableJurisdictionKey = (
  jurisdictions: Record<string, WritableJurisdictionEntry>,
  fallback?: unknown,
  rpcCandidates: unknown[] = [],
): string => {
  const entries = Object.entries(jurisdictions).filter(([key]) => normalizeKeySegment(key));
  return (
    entries.find(([, entry]) => rpcCandidates.some((rpc) => sameRpc(entry.rpc, rpc)))?.[0] ??
    entries.find(([, entry]) => entry.primary === true)?.[0] ??
    entries.find(([, entry]) => isActiveJurisdiction(entry) && hasRequiredContracts(entry))?.[0] ??
    entries[0]?.[0] ??
    normalizeJurisdictionKey(fallback)
  );
};
