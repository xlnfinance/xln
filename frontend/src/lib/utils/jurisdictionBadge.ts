export type JurisdictionBadgeInfo = {
  name: string;
  symbol: string;
  className: string;
  title: string;
};

const normalize = (value: unknown): string =>
  String(value || '').trim().toLowerCase();

export function getJurisdictionBadgeInfo(
  jurisdictionName?: string | null,
  chainId?: number | null,
): JurisdictionBadgeInfo | null {
  const name = String(jurisdictionName || '').trim();
  const normalized = normalize(name);
  if (!name && !chainId) return null;

  if (chainId === 8453 || normalized.includes('base')) {
    return { name: name || 'Base', symbol: 'B', className: 'base', title: name || 'Base' };
  }
  if (chainId === 1 || normalized === 'ethereum' || normalized.includes('mainnet')) {
    return { name: name || 'Ethereum', symbol: 'E', className: 'ethereum', title: name || 'Ethereum' };
  }
  if (chainId === 11155111 || normalized.includes('sepolia')) {
    return { name: name || 'Sepolia', symbol: 'S', className: 'sepolia', title: name || 'Sepolia' };
  }
  if (normalized.includes('tron') || normalized.includes('trc')) {
    return { name: name || 'Tron', symbol: 'T', className: 'tron', title: name || 'Tron' };
  }
  if (chainId === 31337 || normalized.includes('local') || normalized.includes('testnet') || normalized.includes('anvil')) {
    return { name: name || 'Local', symbol: 'L', className: 'local', title: name || 'Local' };
  }

  const first = name.replace(/[^a-zA-Z0-9]/g, '').slice(0, 1).toUpperCase() || '?';
  return { name: name || `Chain ${chainId}`, symbol: first, className: 'generic', title: name || `Chain ${chainId}` };
}
