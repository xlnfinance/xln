import { ethers } from 'ethers';
import type { JAdapter } from '../jadapter';
import { DEV_CHAIN_IDS } from '../jadapter';
import type { JTokenInfo } from '../jadapter/types';
import {
  TOKEN_REGISTRATION_AMOUNT,
  defaultTokensForJurisdiction,
  getDefaultTokenSupply,
} from '../jurisdiction/default-tokens';
import { createStructuredLogger, shortId } from '../infra/logger';
import { HUB_REQUIRED_TOKEN_COUNT } from './hub-health';
import { ERC20Mock__factory } from '../../jurisdictions/typechain-types/index.ts';

const serverLog = createStructuredLogger('server');
const TOKEN_CATALOG_TIMEOUT_MS = Math.max(1000, Number(process.env['TOKEN_CATALOG_TIMEOUT_MS'] || '6000'));
type DepositoryRunner = Parameters<JAdapter['depository']['connect']>[0];
type DeployedTokenContract = {
  waitForDeployment(): Promise<unknown>;
  getAddress(): Promise<string>;
  approve(spender: string, amount: bigint): Promise<{ wait(): Promise<unknown> }>;
};

const requireDepositoryRunner = (value: unknown): DepositoryRunner => {
  if (!value || typeof value !== 'object') {
    throw new Error('TOKEN_CATALOG_DEPOSITORY_RUNNER_INVALID');
  }
  return value as DepositoryRunner;
};

const requireDeployedTokenContract = (value: unknown): DeployedTokenContract => {
  if (!value || typeof value !== 'object') throw new Error('TOKEN_CATALOG_DEPLOY_RESULT_INVALID');
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate['waitForDeployment'] !== 'function' ||
    typeof candidate['getAddress'] !== 'function' ||
    typeof candidate['approve'] !== 'function'
  ) {
    throw new Error('TOKEN_CATALOG_DEPLOY_RESULT_INVALID');
  }
  return value as DeployedTokenContract;
};

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

const deployDefaultTokensOnRpc = async (adapter: JAdapter): Promise<void> => {
  if (adapter.mode === 'browservm') return;
  if (!DEV_CHAIN_IDS.has(adapter.chainId)) {
    throw new Error(`TOKEN_DEFAULT_DEPLOY_FORBIDDEN:${adapter.chainId}`);
  }
  const existing = await adapter.getTokenRegistry();
  const existingSymbols = new Set(
    existing
      .map(token =>
        String(token.symbol || '')
          .trim()
          .toUpperCase(),
      )
      .filter(Boolean),
  );
  const depositoryAddress = adapter.addresses?.depository;
  if (!depositoryAddress) throw new Error('Depository address not available for token deployment');
  const tokens = defaultTokensForJurisdiction({ chainId: adapter.chainId });
  serverLog.info('tokens.deploy_defaults.start', { symbols: tokens.map(token => token.symbol) });
  const factory = new ethers.ContractFactory(
    ERC20Mock__factory.abi,
    ERC20Mock__factory.bytecode,
    adapter.signer as ethers.ContractRunner,
  );

  for (const token of tokens) {
    if (existingSymbols.has(token.symbol.trim().toUpperCase())) continue;
    const contract = requireDeployedTokenContract(
      await factory.deploy(token.name, token.symbol, token.decimals, getDefaultTokenSupply(token.decimals)),
    );
    await contract.waitForDeployment();
    const tokenAddress = await contract.getAddress();
    serverLog.info('tokens.deployed', { symbol: token.symbol, address: shortId(tokenAddress, 10) });
    await (await contract.approve(depositoryAddress, TOKEN_REGISTRATION_AMOUNT)).wait();
    const depository = adapter.depository.connect(requireDepositoryRunner(adapter.signer));
    await (
      await depository.adminRegisterExternalToken({
        entity: ethers.ZeroHash,
        contractAddress: tokenAddress,
        externalTokenId: 0,
        tokenType: 0,
        internalTokenId: 0,
        amount: TOKEN_REGISTRATION_AMOUNT,
      })
    ).wait();
    serverLog.info('tokens.registered', { symbol: token.symbol, address: shortId(tokenAddress, 10) });
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
            deployDefaultTokensOnRpc(adapter),
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
      await withTimeout(deployDefaultTokensOnRpc(adapter), TOKEN_CATALOG_TIMEOUT_MS * 2, 'deployDefaultTokensOnRpc');
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
