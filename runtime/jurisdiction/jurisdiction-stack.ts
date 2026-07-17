export type JurisdictionStackConfig = {
  chainId?: unknown;
  depositoryAddress?: unknown;
};

export const normalizeStackAddress = (value: unknown): string =>
  typeof value === 'string' ? value.trim().toLowerCase() : '';

export const normalizeStackChainId = (value: unknown): number | null => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.floor(numeric);
};

export const isJurisdictionStackRef = (value: unknown): boolean =>
  typeof value === 'string' && /^stack:(?:\d+:)?0x[0-9a-fA-F]{40}$/.test(value.trim());

export type JurisdictionStackIdentity = {
  chainId: number;
  depositoryAddress: string;
};

/** Parse the canonical chain-qualified identity used for cross-j ordering. */
export const parseJurisdictionStackIdentity = (value: unknown): JurisdictionStackIdentity | null => {
  if (typeof value !== 'string') return null;
  const match = /^stack:(\d+):(0x[0-9a-fA-F]{40})$/.exec(value.trim());
  if (!match) return null;
  const chainId = normalizeStackChainId(match[1]);
  const depositoryAddress = normalizeStackAddress(match[2]);
  return chainId === null || !depositoryAddress ? null : { chainId, depositoryAddress };
};

export function getJurisdictionStackId(jurisdiction?: JurisdictionStackConfig | null): string {
  const depository = normalizeStackAddress(jurisdiction?.depositoryAddress);
  if (!depository) return '';
  const chainId = normalizeStackChainId(jurisdiction?.chainId);
  return chainId !== null ? `stack:${chainId}:${depository}` : `stack:${depository}`;
}
