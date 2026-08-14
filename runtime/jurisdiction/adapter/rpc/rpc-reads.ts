import type { Provider } from 'ethers';
import { ethers } from 'ethers';
import type { Depository, EntityProvider } from '../../../../jurisdictions/typechain-types/index.ts';
import { normalizeEntityId } from '../../../entity/id';
import { computeAccountKey } from '../events/contract-codec';
import type { JAdapter, JEvent, JTokenInfo, JWalletSnapshot, JWalletSnapshotRequest } from '../types';
import { readRpcWalletSnapshot } from './wallet/rpc-wallet-snapshot';
import { buildNonFungibleTokenInfo } from '../token-metadata';

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
        const tokens: JTokenInfo[] = [];
        const erc20Interface = new ethers.Interface([
          'function symbol() view returns (string)',
          'function name() view returns (string)',
          'function decimals() view returns (uint8)',
        ]);

        for (let tokenId = 1; tokenId < length; tokenId++) {
          const [rawContractAddress, externalTokenId, rawTokenType] = await deps.depository._tokens(tokenId);
          if (rawContractAddress === ethers.ZeroAddress) {
            throw new TokenRegistryReadError(`TOKEN_REGISTRY_ENTRY_ADDRESS_INVALID:${tokenId}`);
          }
          const contractAddress = ethers.getAddress(rawContractAddress);
          const tokenType = Number(rawTokenType);
          if (tokenType !== 0) {
            tokens.push(buildNonFungibleTokenInfo({
              tokenId,
              tokenType: rawTokenType,
              contractAddress,
              externalTokenId,
              entityProviderAddress: await deps.entityProvider.getAddress(),
            }));
            continue;
          }
          const erc20 = new ethers.Contract(contractAddress, erc20Interface, provider);
          const symbolFn = erc20.getFunction('symbol') as () => Promise<string>;
          const nameFn = erc20.getFunction('name') as () => Promise<string>;
          const decimalsFn = erc20.getFunction('decimals') as () => Promise<bigint>;
          const readMetadata = async <T>(field: string, read: () => Promise<T>): Promise<T> => {
            try {
              return await read();
            } catch (error) {
              const reason = error instanceof Error ? error.message : String(error);
              throw new TokenRegistryReadError(`TOKEN_METADATA_UNAVAILABLE:${tokenId}:${field}:${reason}`, error);
            }
          };
          const symbol = String(await readMetadata('symbol', symbolFn)).trim();
          const name = String(await readMetadata('name', nameFn)).trim();
          const decimals = Number(await readMetadata('decimals', decimalsFn));
          if (!symbol) throw new TokenRegistryReadError(`TOKEN_METADATA_INVALID:${tokenId}:symbol`);
          if (!name) throw new TokenRegistryReadError(`TOKEN_METADATA_INVALID:${tokenId}:name`);
          if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 255) {
            throw new TokenRegistryReadError(`TOKEN_METADATA_INVALID:${tokenId}:decimals:${String(decimals)}`);
          }
          tokens.push({
            symbol,
            name,
            address: contractAddress,
            decimals,
            tokenId,
            tokenType: 0,
            externalTokenId,
          });
        }

        return tokens;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof TokenRegistryReadError) throw err;
        throw new TokenRegistryReadError(`TOKEN_REGISTRY_FETCH_FAILED:${message}`, err);
      }
    },

    async readWalletSnapshot(request: JWalletSnapshotRequest): Promise<JWalletSnapshot> {
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
