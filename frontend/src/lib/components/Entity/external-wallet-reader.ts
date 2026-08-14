import { isAddress, ZeroAddress } from 'ethers';
import type { JAdapter } from '@xln/runtime/api/public/runtime-module';
import { safeParse } from '@xln/runtime/protocol/serialization';
import type { EntityReplica } from '$lib/types/ui';
import { readJsonResponse } from './account/account-faucet';
import type { ExternalToken } from './assets/entity-asset-catalog';
import {
  assertExternalSnapshotCount,
  normalizeOptionalTokenId,
  readExternalWalletSnapshotSource,
  requireExternalSnapshotBigInt,
  type ExternalAllowanceRead,
  type ExternalWalletReadResult,
  type ExternalWalletSnapshotResponse,
} from './assets/external-wallet-snapshot';

const REQUEST_TIMEOUT_MS = 5_000;
type JTokenRegistryItem = Awaited<ReturnType<JAdapter['getTokenRegistry']>>[number];
type ExternalWalletState = EntityReplica['state']['externalWallet'];

const normalizeOptionalTokenType = (value: unknown): 0 | 1 | 2 | undefined => {
  if (value === undefined) return undefined;
  if (value === 0 || value === 1 || value === 2) return value;
  throw new Error(`TOKEN_CATALOG_TYPE_INVALID:${String(value)}`);
};

const normalizeOptionalExternalTokenId = (value: unknown): string | undefined => {
  if (value === undefined) return undefined;
  let tokenId: bigint;
  try {
    tokenId = typeof value === 'bigint' ? value : BigInt(String(value));
  } catch {
    throw new Error(`TOKEN_CATALOG_EXTERNAL_ID_INVALID:${String(value)}`);
  }
  if (tokenId < 0n) throw new Error(`TOKEN_CATALOG_EXTERNAL_ID_INVALID:${String(value)}`);
  return tokenId.toString();
};

function cloneTokenCatalog(tokens: ExternalToken[]): ExternalToken[] {
  return tokens.map(token => ({ ...token, balance: 0n }));
}

/** Keeps immutable token metadata cached while returning fresh balance holders to callers. */
export function createExternalTokenCatalogLoader(fetchCatalog: () => Promise<ExternalToken[]>) {
  let cacheKey = '';
  let cache: ExternalToken[] | null = null;

  return async function getTokenList(
    jadapter: JAdapter | null | undefined,
    runtimeId: string,
    jurisdiction: string,
  ): Promise<ExternalToken[]> {
    const nextKey = `${runtimeId}|${jurisdiction}`;
    if (nextKey === cacheKey && cache) return cloneTokenCatalog(cache);

    let tokens: ExternalToken[] = [];
    let apiError: unknown = null;
    try {
      tokens = await fetchCatalog();
    } catch (error) {
      apiError = error;
    }
    if (tokens.length === 0 && jadapter?.getTokenRegistry) {
      const registry = await jadapter.getTokenRegistry();
      if (registry?.length) {
        tokens = registry.map((token: JTokenRegistryItem) => {
          const decimals = Number(token.decimals);
          const tokenType = normalizeOptionalTokenType(token.tokenType);
          const externalTokenId = normalizeOptionalExternalTokenId(token.externalTokenId);
          if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 255) {
            throw new Error(`TOKEN_CATALOG_DECIMALS_INVALID:${String(token.tokenId)}:${String(token.decimals)}`);
          }
          if (tokenType === undefined || externalTokenId === undefined) {
            throw new Error(`TOKEN_CATALOG_ASSET_CLASS_MISSING:${String(token.tokenId)}`);
          }
          return {
            symbol: token.symbol,
            address: token.address,
            balance: 0n,
            decimals,
            tokenId: normalizeOptionalTokenId(token.tokenId),
            tokenType,
            externalTokenId,
          };
        });
      }
    }
    if (tokens.length === 0) {
      const reason = apiError instanceof Error ? apiError.message : String(apiError || 'empty catalog');
      throw new Error(`TOKEN_CATALOG_UNAVAILABLE:${reason}`, { cause: apiError ?? undefined });
    }
    cacheKey = nextKey;
    cache = cloneTokenCatalog(tokens);
    return cloneTokenCatalog(cache);
  };
}

export function resolveExternalWalletSpender(
  jadapter: JAdapter | null | undefined,
  jurisdictionName: string,
  jurisdictions: unknown[],
): string {
  const adapterDepository = String(jadapter?.addresses?.depository || '').trim();
  if (isAddress(adapterDepository) && adapterDepository !== ZeroAddress) return adapterDepository;
  const normalizedName = String(jurisdictionName || '')
    .trim()
    .toLowerCase();
  for (const jurisdiction of jurisdictions) {
    const record = jurisdiction as { name?: unknown; depositoryAddress?: unknown };
    const name = String(record.name || '')
      .trim()
      .toLowerCase();
    if (normalizedName && name && name !== normalizedName) continue;
    const depository = String(record.depositoryAddress || '').trim();
    if (isAddress(depository) && depository !== ZeroAddress) return depository;
  }
  return '';
}

export function buildOnchainReserves(
  reserves: Map<number | string, bigint> | undefined,
  tokens: ExternalToken[],
): Map<number, bigint> {
  const next = new Map<number, bigint>();
  const catalogTokenIds = tokens
    .map(token => token.tokenId)
    .filter((id): id is number => typeof id === 'number' && id > 0);
  for (const tokenId of catalogTokenIds.length > 0 ? catalogTokenIds : [1, 2, 3]) next.set(tokenId, 0n);
  if (!reserves || typeof reserves.entries !== 'function') return next;
  for (const [tokenId, amount] of reserves.entries()) {
    const numericId = Number(tokenId);
    if (!Number.isNaN(numericId)) next.set(numericId, amount);
  }
  return next;
}

export async function fetchExternalTokenCatalog(apiBase: string): Promise<ExternalToken[]> {
  const response = await fetch(`${apiBase}/api/tokens`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const raw = await response.text();
  const decoded = safeParse<unknown>(raw);
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new Error('TOKEN_CATALOG_RESPONSE_INVALID:expected-object');
  }
  const data = decoded as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(typeof data['error'] === 'string' ? data['error'] : `Token catalog failed (${response.status})`);
  }
  if (!Array.isArray(data['tokens'])) throw new Error('TOKEN_CATALOG_RESPONSE_INVALID:tokens');
  return data['tokens'].map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`TOKEN_CATALOG_ENTRY_INVALID:${index}:expected-object`);
    }
    const token = value as Record<string, unknown>;
    const symbol = typeof token['symbol'] === 'string' ? token['symbol'].trim() : '';
    const address = typeof token['address'] === 'string' ? token['address'].trim() : '';
    const decimals = Number(token['decimals']);
    const tokenId = normalizeOptionalTokenId(token['tokenId']);
    const tokenType = normalizeOptionalTokenType(token['tokenType']);
    const externalTokenId = normalizeOptionalExternalTokenId(token['externalTokenId']);
    if (!symbol) throw new Error(`TOKEN_CATALOG_SYMBOL_INVALID:${index}`);
    if (!isAddress(address) || address === ZeroAddress) throw new Error(`TOKEN_CATALOG_ADDRESS_INVALID:${index}`);
    if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 255) {
      throw new Error(`TOKEN_CATALOG_DECIMALS_INVALID:${String(tokenId)}:${String(token['decimals'])}`);
    }
    if (tokenId === undefined || tokenId < 1) throw new Error(`TOKEN_CATALOG_TOKEN_ID_INVALID:${index}`);
    if (tokenType === undefined || externalTokenId === undefined) {
      throw new Error(`TOKEN_CATALOG_ASSET_CLASS_MISSING:${tokenId}`);
    }
    return {
      symbol,
      address,
      balance: 0n,
      decimals,
      tokenId,
      tokenType,
      externalTokenId,
    };
  });
}

export function readExternalWalletState(
  externalWallet: ExternalWalletState,
  tokenList: ExternalToken[],
  owner: string,
  allowanceReads: ExternalAllowanceRead[],
): ExternalWalletReadResult | null {
  if (!externalWallet) return null;
  const ownerKey = String(owner || '')
    .trim()
    .toLowerCase();
  const balancesByToken = externalWallet.balances?.get?.(ownerKey);
  if (!balancesByToken) return null;
  const nativeRecord = balancesByToken.get(ZeroAddress.toLowerCase());
  if (!nativeRecord) return null;
  const balances = tokenList.map(
    token =>
      balancesByToken.get(
        String(token.address || '')
          .trim()
          .toLowerCase(),
      )?.balance ?? null,
  );
  if (balances.some(balance => balance === null)) return null;
  const allowancesBySpender = externalWallet.allowances?.get?.(ownerKey);
  const allowanceValues = allowanceReads.map(read => {
    const key = `${String(read.tokenAddress || '')
      .trim()
      .toLowerCase()}:${String(read.spender || '')
      .trim()
      .toLowerCase()}`;
    return allowancesBySpender?.get(key)?.allowance ?? null;
  });
  if (allowanceValues.some(allowance => allowance === null)) return null;
  const sourceHeights = [
    Number(nativeRecord.jHeight ?? 0),
    ...[...balancesByToken.values()].map(record => Number(record?.jHeight ?? 0)),
    ...[...(allowancesBySpender?.values?.() ?? [])].map(record => Number(record?.jHeight ?? 0)),
  ].filter(height => Number.isFinite(height) && height > 0);
  const sourceHeight = sourceHeights.length > 0 ? Math.max(...sourceHeights) : undefined;
  return {
    nativeBalance: nativeRecord.balance ?? 0n,
    balances: balances as bigint[],
    allowanceValues: allowanceValues as bigint[],
    ...(sourceHeight !== undefined ? { sourceHeight } : {}),
  };
}

export function readObservedExternalAllowance(
  externalWallet: ExternalWalletState,
  owner: string,
  tokenAddress: string,
  spender: string,
): bigint | null {
  const ownerKey = String(owner || '')
    .trim()
    .toLowerCase();
  const tokenKey = String(tokenAddress || '')
    .trim()
    .toLowerCase();
  const spenderKey = String(spender || '')
    .trim()
    .toLowerCase();
  if (!externalWallet || !ownerKey || !tokenKey || !spenderKey) return null;
  return externalWallet.allowances?.get?.(ownerKey)?.get?.(`${tokenKey}:${spenderKey}`)?.allowance ?? null;
}

export function isExternalWalletSnapshotTransportFailure(message: string): boolean {
  const normalized = message.toLowerCase();
  return ['failed to fetch', 'load failed', 'networkerror', 'network error', 'timeout'].some(fragment =>
    normalized.includes(fragment),
  );
}

export async function requestExternalWalletSnapshot(
  apiBase: string,
  entityId: string,
  owner: string,
  tokenList: ExternalToken[],
  allowanceReads: ExternalAllowanceRead[],
  jadapter?: JAdapter | null,
): Promise<ExternalWalletReadResult | null> {
  const tokenAddresses = tokenList.map(token => token.address).filter(address => isAddress(address));
  if (jadapter?.readWalletSnapshot && jadapter.provider) {
    const source = await readExternalWalletSnapshotSource(jadapter);
    const snapshot = await jadapter.readWalletSnapshot({
      owner,
      tokenAddresses,
      allowances: allowanceReads,
      includeNativeBalance: true,
      blockTag: source.sourceHeight,
    });
    assertExternalSnapshotCount(snapshot.tokenBalances, tokenAddresses.length, 'tokenBalances');
    assertExternalSnapshotCount(snapshot.allowances, allowanceReads.length, 'allowances');
    const nativeBalance = requireExternalSnapshotBigInt(snapshot.nativeBalance, 'nativeBalance');
    const tokenErrors = new Map(
      (snapshot.tokenErrors ?? []).map(entry => [
        String(entry.tokenAddress || '')
          .trim()
          .toLowerCase(),
        String(entry.error || 'EXTERNAL_WALLET_SNAPSHOT_TOKEN_READ_FAILED'),
      ]),
    );
    const allowanceErrors = new Map(
      (snapshot.allowanceErrors ?? []).map(entry => [
        `${String(entry.tokenAddress || '')
          .trim()
          .toLowerCase()}:${String(entry.spender || '')
          .trim()
          .toLowerCase()}`,
        String(entry.error || 'EXTERNAL_WALLET_SNAPSHOT_ALLOWANCE_READ_FAILED'),
      ]),
    );
    const tokenBalances = tokenAddresses.map((tokenAddress, index) => {
      const normalizedAddress = tokenAddress.trim().toLowerCase();
      const token = tokenList.find(candidate => candidate.address.trim().toLowerCase() === normalizedAddress);
      const error = tokenErrors.get(normalizedAddress);
      return {
        tokenAddress: normalizedAddress,
        ...(typeof token?.tokenId === 'number' ? { tokenId: token.tokenId } : {}),
        balance: requireExternalSnapshotBigInt(
          snapshot.tokenBalances[index],
          `tokenBalance:${tokenAddress}`,
        ).toString(),
        ...(error ? { error } : {}),
      };
    });
    const allowances = allowanceReads.map((entry, index) => {
      const tokenAddress = entry.tokenAddress.trim().toLowerCase();
      const spender = entry.spender.trim().toLowerCase();
      const error = allowanceErrors.get(`${tokenAddress}:${spender}`);
      return {
        tokenAddress,
        spender,
        allowance: requireExternalSnapshotBigInt(
          snapshot.allowances[index],
          `allowance:${entry.tokenAddress}:${entry.spender}`,
        ).toString(),
        ...(error ? { error } : {}),
      };
    });
    const balanceByToken = new Map(tokenBalances.map(entry => [entry.tokenAddress, BigInt(entry.balance)]));
    const allowanceByKey = new Map(
      allowances.map(entry => [`${entry.tokenAddress}:${entry.spender}`, BigInt(entry.allowance)]),
    );
    return {
      nativeBalance,
      balances: tokenList.map(token => balanceByToken.get(token.address.trim().toLowerCase()) ?? 0n),
      allowanceValues: allowanceReads.map(
        read =>
          allowanceByKey.get(`${read.tokenAddress.trim().toLowerCase()}:${read.spender.trim().toLowerCase()}`) ?? 0n,
      ),
      ...source,
      ...(snapshot.tokenErrors?.length ? { tokenErrors: snapshot.tokenErrors } : {}),
      ...(snapshot.allowanceErrors?.length ? { allowanceErrors: snapshot.allowanceErrors } : {}),
    };
  }

  const response = await fetch(`${apiBase}/api/external-wallet/snapshot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    body: JSON.stringify({ entityId, owner, tokenAddresses, allowances: allowanceReads }),
  });
  const data = await readJsonResponse<ExternalWalletSnapshotResponse>(response);
  if (!response.ok || !data?.success) {
    throw new Error(data?.error || `External wallet snapshot failed (${response.status})`);
  }
  // A point-in-time RPC read is display data, not proof that an event prefix is complete.
  const balanceByToken = new Map(
    (data.tokenBalances ?? [])
      .filter(entry => !entry.error)
      .map(entry => [
        String(entry.tokenAddress || '')
          .trim()
          .toLowerCase(),
        BigInt(String(entry.balance ?? '0')),
      ]),
  );
  const allowanceByKey = new Map(
    (data.allowances ?? [])
      .filter(entry => !entry.error)
      .map(entry => [
        `${String(entry.tokenAddress || '')
          .trim()
          .toLowerCase()}:${String(entry.spender || '')
          .trim()
          .toLowerCase()}`,
        BigInt(String(entry.allowance ?? '0')),
      ]),
  );
  return {
    nativeBalance: BigInt(String(data.nativeBalance ?? '0')),
    balances: tokenList.map(token => balanceByToken.get(token.address.trim().toLowerCase()) ?? 0n),
    allowanceValues: allowanceReads.map(
      read =>
        allowanceByKey.get(`${read.tokenAddress.trim().toLowerCase()}:${read.spender.trim().toLowerCase()}`) ?? 0n,
    ),
    ...(data.sourceHeight !== undefined || data.blockNumber !== undefined
      ? { sourceHeight: Number(data.sourceHeight ?? data.blockNumber) }
      : {}),
    ...((data.sourceHash ?? data.blockHash) ? { sourceHash: String(data.sourceHash ?? data.blockHash) } : {}),
    ...(data.finalityDepth !== undefined ? { finalityDepth: Number(data.finalityDepth) } : {}),
    ...(data.headBlockNumber !== undefined ? { headBlockNumber: Number(data.headBlockNumber) } : {}),
    ...(data.tokenErrors?.length
      ? {
          tokenErrors: data.tokenErrors.map(entry => ({
            tokenAddress: String(entry.tokenAddress || '')
              .trim()
              .toLowerCase(),
            error: String(entry.error || 'EXTERNAL_WALLET_SNAPSHOT_TOKEN_READ_FAILED'),
          })),
        }
      : {}),
    ...(data.allowanceErrors?.length
      ? {
          allowanceErrors: data.allowanceErrors.map(entry => ({
            tokenAddress: String(entry.tokenAddress || '')
              .trim()
              .toLowerCase(),
            spender: String(entry.spender || '')
              .trim()
              .toLowerCase(),
            error: String(entry.error || 'EXTERNAL_WALLET_SNAPSHOT_ALLOWANCE_READ_FAILED'),
          })),
        }
      : {}),
  };
}

export function buildExternalWalletStateSyncSignature(externalWallet: ExternalWalletState, owner: string): string {
  const ownerKey = owner.trim().toLowerCase();
  if (!ownerKey || !externalWallet) return '';
  const balancesByToken = externalWallet.balances?.get?.(ownerKey);
  const allowancesBySpender = externalWallet.allowances?.get?.(ownerKey);
  if (!balancesByToken && !allowancesBySpender) return '';
  const balances = balancesByToken
    ? [...balancesByToken.entries()]
        .map(([token, record]) => `${token}:${record.balance.toString()}:${record.jHeight}:${record.transactionHash}`)
        .sort()
        .join(',')
    : '';
  const allowances = allowancesBySpender
    ? [...allowancesBySpender.entries()]
        .map(([key, record]) => `${key}:${record.allowance.toString()}:${record.jHeight}:${record.transactionHash}`)
        .sort()
        .join(',')
    : '';
  return `${ownerKey}|${balances}|${allowances}`;
}
