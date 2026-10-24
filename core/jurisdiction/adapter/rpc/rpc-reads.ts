import type { Provider } from 'ethers';
import { ethers } from 'ethers';
import type { Depository, EntityProvider } from '../../../../jurisdictions/typechain-types/index.ts';
import { normalizeEntityId } from '../../../entity/id';
import { computeAccountKey } from '../events/contract-codec';
import type { JAdapter, JAdapterConfig, JEvent, JTokenInfo, JWalletSnapshot, JWalletSnapshotRequest } from '../types';
import { readRpcWalletSnapshot } from './wallet/rpc-wallet-snapshot';
import { readNativeTronWalletSnapshot } from './wallet/tron-wallet-snapshot';
import { buildNonFungibleTokenInfo } from '../registry/token-metadata';

type ReadMethods = Omit<
  Pick<
    JAdapter,
    | 'getReserves'
    | 'getCollateral'
    | 'getAccountInfo'
    | 'getEntityNonce'
    | 'hasProcessedBatch'
    | 'getEntityProviderActionNonce'
    | 'getEntityProviderActionReceipt'
    | 'isEntityRegistered'
    | 'getTokenRegistry'
    | 'readWalletSnapshot'
    | 'getErc20Balance'
    | 'getErc20Balances'
  >,
  'hasProcessedBatch'
> & {
  hasProcessedBatch: NonNullable<JAdapter['hasProcessedBatch']>;
};

type RpcReadDeps = {
  config: JAdapterConfig;
  provider: Provider;
  rpcUrl?: string;
  depository: Depository;
  entityProvider: EntityProvider;
  hasProcessedBatch: ReadMethods['hasProcessedBatch'];
  readEntityProviderActionReceipt(entityId: string, actionNonce: bigint): Promise<JEvent | null>;
};

class TokenRegistryReadError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'TokenRegistryReadError';
  }
}

const ERC20_METADATA_INTERFACE = new ethers.Interface([
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function decimals() view returns (uint8)',
]);

// Registry entries are independent read-only calls: overlap only their round
// trips. A cold wallet otherwise paid four sequential RPCs per token per J.
const TOKEN_REGISTRY_READ_CONCURRENCY = 8;

/**
 * Runs bounded concurrent reads, then reports them in input order: the
 * returned values and the first thrown error are exactly those of the
 * equivalent sequential loop, whichever request completed first.
 */
const settleInOrder = async <T>(reads: ReadonlyArray<() => Promise<T>>): Promise<T[]> => {
  const settled: PromiseSettledResult<T>[] = [];
  for (let start = 0; start < reads.length; start += TOKEN_REGISTRY_READ_CONCURRENCY) {
    const chunk = reads.slice(start, start + TOKEN_REGISTRY_READ_CONCURRENCY);
    settled.push(...await Promise.allSettled(chunk.map(read => read())));
  }
  return settled.map(result => {
    if (result.status === 'rejected') throw result.reason;
    return result.value;
  });
};

const readTokenMetadata = async <T>(tokenId: number, field: string, read: () => Promise<T>): Promise<T> => {
  try {
    return await read();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new TokenRegistryReadError(`TOKEN_METADATA_UNAVAILABLE:${tokenId}:${field}:${reason}`, error);
  }
};

const readErc20TokenInfo = async (
  provider: Provider,
  tokenId: number,
  contractAddress: string,
  externalTokenId: bigint,
): Promise<JTokenInfo> => {
  const erc20 = new ethers.Contract(contractAddress, ERC20_METADATA_INTERFACE, provider);
  const [rawSymbol, rawName, rawDecimals] = await settleInOrder<string | bigint>([
    () => readTokenMetadata(tokenId, 'symbol', erc20.getFunction('symbol') as () => Promise<string>),
    () => readTokenMetadata(tokenId, 'name', erc20.getFunction('name') as () => Promise<string>),
    () => readTokenMetadata(tokenId, 'decimals', erc20.getFunction('decimals') as () => Promise<bigint>),
  ]);
  const symbol = String(rawSymbol).trim();
  const name = String(rawName).trim();
  const decimals = Number(rawDecimals);
  if (!symbol) throw new TokenRegistryReadError(`TOKEN_METADATA_INVALID:${tokenId}:symbol`);
  if (!name) throw new TokenRegistryReadError(`TOKEN_METADATA_INVALID:${tokenId}:name`);
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new TokenRegistryReadError(`TOKEN_METADATA_INVALID:${tokenId}:decimals:${String(decimals)}`);
  }
  return { symbol, name, address: contractAddress, decimals, tokenId, tokenType: 0, externalTokenId };
};

const readTokenRegistryEntry = async (deps: RpcReadDeps, tokenId: number): Promise<JTokenInfo> => {
  const [rawContractAddress, externalTokenId, rawTokenType] = await deps.depository._tokens(tokenId);
  if (rawContractAddress === ethers.ZeroAddress) {
    throw new TokenRegistryReadError(`TOKEN_REGISTRY_ENTRY_ADDRESS_INVALID:${tokenId}`);
  }
  const contractAddress = ethers.getAddress(rawContractAddress);
  if (Number(rawTokenType) === 0) {
    return readErc20TokenInfo(deps.provider, tokenId, contractAddress, externalTokenId);
  }
  return buildNonFungibleTokenInfo({
    tokenId,
    tokenType: rawTokenType,
    contractAddress,
    externalTokenId,
    entityProviderAddress: await deps.entityProvider.getAddress(),
  });
};

/** Canonical chain reads. These methods never mutate adapter lifecycle state. */
export const createRpcReadMethods = (deps: RpcReadDeps): ReadMethods => {
  const { provider, rpcUrl, hasProcessedBatch, readEntityProviderActionReceipt } = deps;
  const methods: ReadMethods = {
    async getReserves(entityId: string, tokenId: number): Promise<bigint> {
      return deps.depository._reserves(entityId, tokenId);
    },

    async getCollateral(entity1: string, entity2: string, tokenId: number): Promise<bigint> {
      const key = computeAccountKey(entity1, entity2);
      const result = await deps.depository._collaterals(key, tokenId);
      return result.collateral;
    },

    async getAccountInfo(
      entityId: string,
      counterpartyId: string,
    ): Promise<{ nonce: bigint; disputeHash: string; disputeTimeout: bigint }> {
      const key = computeAccountKey(entityId, counterpartyId);
      const result = await deps.depository._accounts(key);
      return {
        nonce: result.nonce,
        disputeHash: result.disputeHash,
        disputeTimeout: result.disputeTimeout,
      };
    },

    async getEntityNonce(entityId: string): Promise<bigint> {
      return deps.depository.entityNonces(normalizeEntityId(entityId));
    },

    hasProcessedBatch,

    async getEntityProviderActionNonce(entityId: string): Promise<bigint> {
      return deps.entityProvider.entityActionNonces(normalizeEntityId(entityId));
    },

    async getEntityProviderActionReceipt(entityId: string, actionNonce: bigint): Promise<JEvent | null> {
      return await readEntityProviderActionReceipt(entityId, actionNonce);
    },

    async isEntityRegistered(entityId: string): Promise<boolean> {
      const info = await deps.entityProvider.entities(entityId);
      // registrationBlock > 0 means entity was registered
      return info.registrationBlock !== 0n;
    },

    async getTokenRegistry(): Promise<JTokenInfo[]> {
      try {
        const length = Number(await deps.depository.getTokensLength());
        if (!Number.isSafeInteger(length) || length < 1) {
          throw new TokenRegistryReadError(`TOKEN_REGISTRY_LENGTH_INVALID:${String(length)}`);
        }
        const tokenIds = Array.from({ length: length - 1 }, (_, index) => index + 1);
        return await settleInOrder(tokenIds.map(tokenId => () => readTokenRegistryEntry(deps, tokenId)));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof TokenRegistryReadError) throw err;
        throw new TokenRegistryReadError(`TOKEN_REGISTRY_FETCH_FAILED:${message}`, err);
      }
    },

    async readWalletSnapshot(request: JWalletSnapshotRequest): Promise<JWalletSnapshot> {
      if (deps.config.mode === 'tron') return readNativeTronWalletSnapshot(deps.config, provider, request);
      return readRpcWalletSnapshot({ provider, ...(rpcUrl ? { rpcUrl } : {}) }, request);
    },

    async getErc20Balance(tokenAddress: string, owner: string): Promise<bigint> {
      const erc20 = new ethers.Contract(
        tokenAddress,
        ['function balanceOf(address owner) view returns (uint256)'],
        provider,
      );
      const balanceOf = erc20.getFunction('balanceOf') as (owner: string) => Promise<bigint>;
      return balanceOf(owner);
    },

    async getErc20Balances(tokenAddresses: string[], owner: string): Promise<bigint[]> {
      return (
        await methods.readWalletSnapshot({
          owner,
          tokenAddresses,
          includeNativeBalance: false,
        })
      ).tokenBalances;
    },
  };
  return methods;
};
