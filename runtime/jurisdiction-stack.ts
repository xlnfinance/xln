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

export function getJurisdictionStackId(jurisdiction?: JurisdictionStackConfig | null): string {
  const depository = normalizeStackAddress(jurisdiction?.depositoryAddress);
  if (!depository) return '';
  const chainId = normalizeStackChainId(jurisdiction?.chainId);
  return chainId !== null ? `stack:${chainId}:${depository}` : `stack:${depository}`;
}
