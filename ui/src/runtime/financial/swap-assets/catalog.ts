import { useEffect, useState } from 'react';
import { fetchExternalTokenCatalog } from '@xln/frontend/lib/components/Entity/external-wallet-reader';
import { requireAdapter } from '../../adapter';
import { resolveApiBase } from '../../http';
import { useApp } from '../../store';
import type { TokenCatalogEntry } from '../../token-meta';
import { hostedJAdapter } from '../move';

const EMPTY_CATALOG: readonly TokenCatalogEntry[] = [];

async function readCatalog(entityId: string, signerId: string): Promise<TokenCatalogEntry[]> {
  if (requireAdapter().mode === 'remote') {
    const registry = await fetchExternalTokenCatalog(resolveApiBase(), entityId);
    return registry.map(token => ({
      tokenId: Number(token.tokenId),
      symbol: token.symbol,
      name: token.symbol,
      decimals: token.decimals,
    }));
  }
  const registry = await (await hostedJAdapter(entityId, signerId)).getTokenRegistry();
  return registry.map(token => ({
    tokenId: Number(token.tokenId),
    symbol: token.symbol,
    name: token.name,
    decimals: token.decimals,
  }));
}

/** A token id is local to its Depository. Never reuse the active wallet's catalog for another leg. */
export function useSwapTokenCatalog(entityId: string, signerId: string, stack: string) {
  const vaultId = useApp(s => s.activeVaultId);
  const status = useApp(s => s.adapterStatus);
  const key = [vaultId, status, entityId, signerId, stack].join('|');
  const enabled = Boolean(entityId && signerId && stack) && status === 'connected';
  const [result, setResult] = useState<{ key: string; catalog: readonly TokenCatalogEntry[]; error: string } | null>(
    null,
  );
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    readCatalog(entityId, signerId).then(
      catalog => {
        if (!cancelled) setResult({ key, catalog, error: '' });
      },
      (error: unknown) => {
        if (!cancelled)
          setResult({ key, catalog: EMPTY_CATALOG, error: error instanceof Error ? error.message : String(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [key, enabled, entityId, signerId]);
  const current = enabled && result?.key === key ? result : null;
  return {
    catalog: current?.catalog ?? EMPTY_CATALOG,
    error: current?.error ?? '',
    ready: Boolean(current) && !current?.error,
  };
}
