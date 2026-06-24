import { formatEntityId } from '$lib/utils/format';

export type TokenKeyedMap<V> = Map<number, V> | Map<string, V>;
export type TokenSymbolFormatter = (tokenIdValue: number) => string;
export type HubCandidatePredicate = (entityIdValue: string) => boolean;

export function normalizeEntityId(value: string): string {
  return String(value || '').trim().toLowerCase();
}

export function resolveHubIdCandidate(
  candidate: string,
  knownHubIds: string[],
  isHubCandidate: HubCandidatePredicate,
): string {
  const normalized = normalizeEntityId(candidate);
  if (!normalized) return '';

  const matchedAccount = knownHubIds.find((id) => normalizeEntityId(id) === normalized);
  if (matchedAccount) return matchedAccount;

  return isHubCandidate(normalized) ? normalized : '';
}

export function firstAvailableHubId(
  knownHubIds: string[],
  candidates: string[],
  isHubCandidate: HubCandidatePredicate,
): string {
  for (const candidate of candidates) {
    const resolved = resolveHubIdCandidate(candidate, knownHubIds, isHubCandidate);
    if (resolved) return resolved;
  }
  return knownHubIds[0] || '';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function normalizeJurisdictionDisplayName(value: unknown): string {
  const name = String(value || '').trim();
  const normalized = name.toLowerCase();
  if (
    normalized === 'arrakis'
    || normalized === 'arrakis (shared anvil)'
    || normalized === 'shared anvil'
    || normalized === 'wakanda'
  ) {
    return 'Testnet';
  }
  return name;
}

export function stripJurisdictionSuffix(name: string, jurisdiction: string): string {
  const cleanName = String(name || '').trim();
  const cleanJurisdiction = normalizeJurisdictionDisplayName(jurisdiction);
  if (!cleanName || !cleanJurisdiction) return cleanName;

  return cleanName
    .replace(new RegExp(`\\s*\\(${escapeRegExp(cleanJurisdiction)}\\)\\s*$`, 'i'), '')
    .replace(new RegExp(`\\s+${escapeRegExp(cleanJurisdiction)}\\s*$`, 'i'), '')
    .trim() || cleanName;
}

export function formatEntityNetworkLabel(name: string, jurisdiction: string): string {
  const cleanName = stripJurisdictionSuffix(String(name || '').trim() || 'Unknown', jurisdiction);
  const cleanJurisdiction = normalizeJurisdictionDisplayName(jurisdiction);
  return cleanJurisdiction ? `${cleanName} (${cleanJurisdiction})` : cleanName;
}

export function parseCrossAssetKey(value: string): { jurisdictionRef: string; tokenId: number } | null {
  const match = String(value || '').trim().match(/^(.+):(\d+)$/);
  if (!match) return null;

  const tokenIdValue = Number(match[2]);
  if (!Number.isFinite(tokenIdValue) || tokenIdValue <= 0) return null;

  return {
    jurisdictionRef: String(match[1] || '').trim(),
    tokenId: Math.floor(tokenIdValue),
  };
}

export function tokenNetworkLabel(
  tokenIdValue: number,
  jurisdiction: string,
  tokenSymbol: TokenSymbolFormatter,
): string {
  const cleanJurisdiction = normalizeJurisdictionDisplayName(jurisdiction);
  return cleanJurisdiction ? `${tokenSymbol(tokenIdValue)} (${cleanJurisdiction})` : tokenSymbol(tokenIdValue);
}

export function sameOrderbookPairLabel(
  baseTokenIdValue: number,
  quoteTokenIdValue: number,
  jurisdiction: string,
  tokenSymbol: TokenSymbolFormatter,
): string {
  const cleanJurisdiction = normalizeJurisdictionDisplayName(jurisdiction);
  const pair = `${tokenSymbol(baseTokenIdValue)}-${tokenSymbol(quoteTokenIdValue)}`;
  return cleanJurisdiction ? `${pair} (${cleanJurisdiction})` : pair;
}

export function crossOrderbookPairLabel(
  baseTokenIdValue: number,
  baseJurisdiction: string,
  quoteTokenIdValue: number,
  quoteJurisdiction: string,
  tokenSymbol: TokenSymbolFormatter,
): string {
  return `${tokenNetworkLabel(baseTokenIdValue, baseJurisdiction, tokenSymbol)} - ${tokenNetworkLabel(quoteTokenIdValue, quoteJurisdiction, tokenSymbol)}`;
}

export function entityInitials(entityIdValue: string, fallbackLabel = ''): string {
  const label = String(fallbackLabel || '').trim();
  if (label) return label.slice(0, 2).toUpperCase();
  return formatEntityId(entityIdValue).slice(0, 2).toUpperCase();
}

export function jurisdictionBadgeText(jurisdiction: string): string {
  const clean = normalizeJurisdictionDisplayName(jurisdiction).replace(/[^a-zA-Z0-9\s._-]/g, ' ');
  if (!clean) return 'J';

  const words = clean
    .split(/[\s._-]+/)
    .map((word) => word.replace(/[^a-zA-Z0-9]/g, ''))
    .filter(Boolean);
  if (words.length >= 2) return `${words[0]?.[0] || ''}${words[1]?.[0] || ''}`.toUpperCase();
  return (words[0] || clean).slice(0, 2).toUpperCase();
}

export function getTokenMapValue<V>(map: TokenKeyedMap<V> | undefined, tokenIdValue: number): V | undefined {
  if (!(map instanceof Map) || !Number.isFinite(tokenIdValue)) return undefined;
  const byNumber = (map as Map<number, V>).get(tokenIdValue);
  if (byNumber !== undefined) return byNumber;
  return (map as Map<string, V>).get(String(tokenIdValue));
}

export function nonNegative(value: bigint): bigint {
  return value < 0n ? 0n : value;
}
