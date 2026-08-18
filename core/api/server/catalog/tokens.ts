import type { JAdapter } from '../../../jurisdiction/adapter';
import { DEV_CHAIN_IDS } from '../../../jurisdiction/adapter';
import type { JTokenInfo } from '../../../jurisdiction/adapter/types';
import { defaultTokensForJurisdiction } from '../../../jurisdiction/machine/config/default-tokens';
import { deployMissingDefaultTokens } from '../../../jurisdiction/adapter/operations/dev-token-deployment';
import { createStructuredLogger } from '../../../support/logger';
import { HUB_REQUIRED_TOKEN_COUNT } from '../health/hub';

const serverLog = createStructuredLogger('server');
const TOKEN_CATALOG_TIMEOUT_MS = Math.max(1000, Number(process.env['TOKEN_CATALOG_TIMEOUT_MS'] || '6000'));
const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race<T>([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timeout after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const desiredTokenSymbols = (adapter: JAdapter): string[] =>
  defaultTokensForJurisdiction({ chainId: Number(adapter.chainId) })
    .map(token => token.symbol.trim().toUpperCase())
    .filter(Boolean);

const hasDesiredTokens = (tokens: JTokenInfo[], desiredSymbols: string[]): boolean => {
  const symbols = new Set(
    tokens
      .map(token =>
        String(token.symbol || '')
          .trim()
          .toUpperCase(),
      )
      .filter(Boolean),
  );
  return desiredSymbols.every(symbol => symbols.has(symbol));
};

const readTokenCode = async (adapter: JAdapter, address: string): Promise<string> => {
  try {
    return await withTimeout(adapter.provider.getCode(address), TOKEN_CATALOG_TIMEOUT_MS, 'provider.getCode');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`TOKEN_CATALOG_GET_CODE_FAILED:${address}:${message}`, { cause: error });
  }
};

const readTokenRegistry = async (adapter: JAdapter): Promise<JTokenInfo[]> => {
  try {
    return await withTimeout(adapter.getTokenRegistry(), TOKEN_CATALOG_TIMEOUT_MS, 'getTokenRegistry');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`TOKEN_CATALOG_READ_FAILED:${message}`, { cause: error });
  }
};

export const createTokenCatalogController = (input: {
  getAdapter: () => JAdapter | null;
}): {
  ensureTokenCatalog: () => Promise<JTokenInfo[]>;
} => {
  let tokenCatalogCache: JTokenInfo[] | null = null;
  let tokenCatalogPromise: Promise<JTokenInfo[]> | null = null;

  const ensureTokenCatalog = async (): Promise<JTokenInfo[]> => {
    const adapter = input.getAdapter();
    if (!adapter) throw new Error('TOKEN_CATALOG_ADAPTER_UNAVAILABLE');
    const desiredSymbols = desiredTokenSymbols(adapter);
    if (tokenCatalogCache && tokenCatalogCache.length > 0) {
      if (adapter.mode !== 'browservm') {
        const firstToken = tokenCatalogCache[0];
        if (firstToken?.address) {
          const code = await readTokenCode(adapter, firstToken.address);
          if (code !== '0x' && code.length > 10 && hasDesiredTokens(tokenCatalogCache, desiredSymbols)) {
            return tokenCatalogCache;
          }
          serverLog.warn('token_catalog.cache_stale');
          tokenCatalogCache = null;
        }
      } else {
        return tokenCatalogCache;
      }
    }
    if (tokenCatalogPromise) return tokenCatalogPromise;

    tokenCatalogPromise = (async () => {
      const current = await readTokenRegistry(adapter);
      const canDeployDefaults = adapter.mode !== 'browservm' && DEV_CHAIN_IDS.has(adapter.chainId);
      const needsMoreDefaultTokens =
        adapter.mode !== 'browservm' &&
        (current.length < HUB_REQUIRED_TOKEN_COUNT || !hasDesiredTokens(current, desiredSymbols));

      if (current.length > 0 && adapter.mode !== 'browservm') {
        const firstToken = current[0];
        if (firstToken?.address) {
          const code = await readTokenCode(adapter, firstToken.address);
          if (code === '0x' || code.length < 10) {
            throw new Error(`TOKEN_CATALOG_TOKEN_CODE_MISSING:${firstToken.tokenId}:${firstToken.address}`);
          }
        }
        if (needsMoreDefaultTokens) {
          if (!canDeployDefaults) {
            throw new Error(`TOKEN_CATALOG_INCOMPLETE:chainId=${adapter.chainId}:count=${current.length}`);
          }
          await withTimeout(
            deployMissingDefaultTokens(adapter),
            TOKEN_CATALOG_TIMEOUT_MS * 2,
            'deployMissingDefaultTokensOnRpc',
          );
          return await readTokenRegistry(adapter);
        }
        return current;
      }

      if (current.length > 0 || adapter.mode === 'browservm') return current;
      if (!canDeployDefaults) {
        throw new Error(`TOKEN_CATALOG_EMPTY:chainId=${adapter.chainId}`);
      }
      await withTimeout(
        deployMissingDefaultTokens(adapter),
        TOKEN_CATALOG_TIMEOUT_MS * 2,
        'deployMissingDefaultTokens',
      );
      return await readTokenRegistry(adapter);
    })();

    try {
      const tokens = await tokenCatalogPromise;
      if (tokens.length > 0) tokenCatalogCache = tokens;
      return tokens;
    } finally {
      tokenCatalogPromise = null;
    }
  };

  return { ensureTokenCatalog };
};
