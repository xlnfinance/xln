import type { AccountMachine, Delta, DerivedDelta } from '$lib/types/ui';

type TokenInfoLike = {
  symbol?: string;
  color?: string;
  name?: string;
  decimals?: number;
};

type XlnFunctionsLike = {
  deriveDelta?: (delta: Delta, isLeft: boolean) => DerivedDelta;
  getTokenInfo?: (tokenId: number) => TokenInfoLike | null | undefined;
};

export type AccountTokenDetailRow = {
  tokenId: number;
  tokenInfo: {
    symbol: string;
    color: string;
    name: string;
    decimals: number;
  };
  delta: Delta;
  derived: DerivedDelta;
};

export function isAccountLeftPerspective(ownerEntityId: string, account: AccountMachine): boolean {
  const owner = String(ownerEntityId || '').trim().toLowerCase();
  const left = String(account.leftEntity || '').trim().toLowerCase();
  const right = String(account.rightEntity || '').trim().toLowerCase();
  if (owner === left) return true;
  if (owner === right) return false;
  throw new Error(`Account perspective mismatch: owner=${ownerEntityId} left=${account.leftEntity} right=${account.rightEntity}`);
}

export function buildAccountTokenDetails(
  account: AccountMachine,
  ownerEntityId: string,
  xlnFunctions: XlnFunctionsLike | null | undefined,
): AccountTokenDetailRow[] {
  if (!xlnFunctions?.deriveDelta) return [];
  const isLeft = isAccountLeftPerspective(ownerEntityId, account);
  return Array.from(account.deltas?.entries() || []).map(([tokenId, delta]) => {
    const derived = xlnFunctions.deriveDelta!(delta, isLeft);
    const tokenInfo = xlnFunctions.getTokenInfo?.(tokenId) || {
      symbol: `TKN${tokenId}`,
      color: '#999',
      name: `Token ${tokenId}`,
      decimals: 18,
    };
    return {
      tokenId,
      tokenInfo: {
        symbol: String(tokenInfo.symbol || `TKN${tokenId}`),
        color: String(tokenInfo.color || '#999'),
        name: String(tokenInfo.name || `Token ${tokenId}`),
        decimals: Number(tokenInfo.decimals ?? 18),
      },
      delta,
      derived,
    };
  });
}
