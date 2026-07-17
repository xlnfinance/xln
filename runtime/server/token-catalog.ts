import { ethers } from 'ethers';
import type { JAdapter } from '../jadapter';
import { DEV_CHAIN_IDS } from '../jadapter';
import type { JTokenInfo } from '../jadapter/types';
import { TOKEN_REGISTRATION_AMOUNT, defaultTokensForJurisdiction, getDefaultTokenSupply } from '../jadapter/default-tokens';
import { createStructuredLogger, shortId } from '../infra/logger';
import { HUB_REQUIRED_TOKEN_COUNT } from './hub-health';
import { ERC20Mock__factory } from '../../jurisdictions/typechain-types/index.ts';

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

export const createTokenCatalogController = (input: {
  getAdapter: () => JAdapter | null;
}): {
  ensureTokenCatalog: () => Promise<JTokenInfo[]>;
} => {
  let tokenCatalogCache: JTokenInfo[] | null = null;
  let tokenCatalogPromise: Promise<JTokenInfo[]> | null = null;

  const deployDefaultTokensOnRpc = async (): Promise<void> => {
    const adapter = input.getAdapter();
    if (!adapter) throw new Error('TOKEN_CATALOG_ADAPTER_UNAVAILABLE');
    if (adapter.mode === 'browservm') return;
    if (!DEV_CHAIN_IDS.has(adapter.chainId)) {
      throw new Error(`TOKEN_DEFAULT_DEPLOY_FORBIDDEN:${adapter.chainId}`);
    }
    const existing = await adapter.getTokenRegistry();
    const existingSymbols = new Set(
      existing
        .map(token => String(token.symbol || '').trim().toUpperCase())
        .filter(symbol => symbol.length > 0),
    );

    const signer = adapter.signer;
    const depository = adapter.depository;
    const depositoryAddress = adapter.addresses?.depository;
    if (!depositoryAddress) {
      throw new Error('Depository address not available for token deployment');
    }

    const desiredTokens = defaultTokensForJurisdiction({ chainId: Number((adapter as { chainId?: number }).chainId) });
    serverLog.info('tokens.deploy_defaults.start', { symbols: desiredTokens.map(token => token.symbol) });
    const erc20Factory = new ethers.ContractFactory(
      ERC20Mock__factory.abi,
      ERC20Mock__factory.bytecode,
      signer as ethers.ContractRunner,
    );

    for (const token of desiredTokens) {
      if (existingSymbols.has(String(token.symbol || '').trim().toUpperCase())) continue;
      const tokenContract = await erc20Factory.deploy(
        token.name,
        token.symbol,
        token.decimals,
        getDefaultTokenSupply(token.decimals),
      ) as unknown as {
        waitForDeployment(): Promise<unknown>;
        getAddress(): Promise<string>;
        approve(spender: string, amount: bigint): Promise<{ wait(): Promise<unknown> }>;
      };
      await tokenContract.waitForDeployment();
      const tokenAddress = await tokenContract.getAddress();
      serverLog.info('tokens.deployed', { symbol: token.symbol, address: shortId(tokenAddress, 10) });

      const approveTx = await tokenContract.approve(depositoryAddress, TOKEN_REGISTRATION_AMOUNT);
      await approveTx.wait();

      const registerTx = await depository
        .connect(signer as unknown as Parameters<typeof depository.connect>[0])
        .adminRegisterExternalToken({
        entity: ethers.ZeroHash,
        contractAddress: tokenAddress,
        externalTokenId: 0,
        tokenType: 0,
        internalTokenId: 0,
        amount: TOKEN_REGISTRATION_AMOUNT,
      });
      await registerTx.wait();
      serverLog.info('tokens.registered', { symbol: token.symbol, address: shortId(tokenAddress, 10) });
    }
  };

  const ensureTokenCatalog = async (): Promise<JTokenInfo[]> => {
    const adapter = input.getAdapter();
    if (!adapter) throw new Error('TOKEN_CATALOG_ADAPTER_UNAVAILABLE');
    const desiredTokens = defaultTokensForJurisdiction({ chainId: Number((adapter as { chainId?: number }).chainId) });
    const desiredSymbols = desiredTokens.map(token => token.symbol.trim().toUpperCase()).filter(Boolean);
    const hasDesiredTokens = (tokens: JTokenInfo[]): boolean => {
      const symbols = new Set(tokens.map(token => String(token.symbol || '').trim().toUpperCase()).filter(Boolean));
      return desiredSymbols.every(symbol => symbols.has(symbol));
    };
    const safeGetCode = async (address: string): Promise<string> => {
      try {
        return await withTimeout(
          adapter.provider.getCode(address),
          TOKEN_CATALOG_TIMEOUT_MS,
          'provider.getCode',
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`TOKEN_CATALOG_GET_CODE_FAILED:${address}:${message}`, { cause: error });
      }
    };
    const safeGetRegistry = async (): Promise<JTokenInfo[]> => {
      try {
        return await withTimeout(
          adapter.getTokenRegistry(),
          TOKEN_CATALOG_TIMEOUT_MS,
          'getTokenRegistry',
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`TOKEN_CATALOG_READ_FAILED:${message}`, { cause: error });
      }
    };
    if (tokenCatalogCache && tokenCatalogCache.length > 0) {
      if (adapter.mode !== 'browservm') {
        const firstToken = tokenCatalogCache[0];
        if (firstToken?.address) {
          const code = await safeGetCode(firstToken.address);
          if (code !== '0x' && code.length > 10 && hasDesiredTokens(tokenCatalogCache)) return tokenCatalogCache;
          serverLog.warn('token_catalog.cache_stale');
          tokenCatalogCache = null;
        }
      } else {
        return tokenCatalogCache;
      }
    }
    if (tokenCatalogPromise) return tokenCatalogPromise;

    tokenCatalogPromise = (async () => {
      const current = await safeGetRegistry();
      const canDeployDefaults = adapter.mode !== 'browservm' && DEV_CHAIN_IDS.has(adapter.chainId);
      const needsMoreDefaultTokens = adapter.mode !== 'browservm' && (
        current.length < HUB_REQUIRED_TOKEN_COUNT || !hasDesiredTokens(current)
      );

      if (current.length > 0 && adapter.mode !== 'browservm') {
        const firstToken = current[0];
        if (firstToken?.address) {
          const code = await safeGetCode(firstToken.address);
          if (code === '0x' || code.length < 10) {
            throw new Error(`TOKEN_CATALOG_TOKEN_CODE_MISSING:${firstToken.tokenId}:${firstToken.address}`);
          }
        }
        if (needsMoreDefaultTokens) {
          if (!canDeployDefaults) {
            throw new Error(
              `TOKEN_CATALOG_INCOMPLETE:chainId=${adapter.chainId}:count=${current.length}`,
            );
          }
          await withTimeout(deployDefaultTokensOnRpc(), TOKEN_CATALOG_TIMEOUT_MS * 2, 'deployMissingDefaultTokensOnRpc');
          return await safeGetRegistry();
        }
        return current;
      }

      if (current.length > 0 || adapter.mode === 'browservm') return current;
      if (!canDeployDefaults) {
        throw new Error(`TOKEN_CATALOG_EMPTY:chainId=${adapter.chainId}`);
      }
      await withTimeout(deployDefaultTokensOnRpc(), TOKEN_CATALOG_TIMEOUT_MS * 2, 'deployDefaultTokensOnRpc');
      return await safeGetRegistry();
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
