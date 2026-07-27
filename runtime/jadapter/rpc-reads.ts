import type { Provider } from 'ethers';
import { ethers } from 'ethers';
import type { Depository, EntityProvider } from '../../jurisdictions/typechain-types/index.ts';
import { normalizeEntityId } from '../entity/id';
import { computeAccountKey } from './helpers';
import { readOptionalRpcBatchBigInt, readRequiredRpcBatchBigInt } from './rpc-public';
import { sendRpcBatch, type RpcBatchRequest } from './rpc-utils';
import type { JAdapter, JEvent, JTokenInfo, JWalletSnapshot, JWalletSnapshotRequest } from './types';

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
          throw new Error(`TOKEN_REGISTRY_LENGTH_INVALID:${String(length)}`);
        }
        const tokens: JTokenInfo[] = [];
        const erc20Interface = new ethers.Interface([
          'function symbol() view returns (string)',
          'function name() view returns (string)',
          'function decimals() view returns (uint8)',
        ]);

        for (let tokenId = 1; tokenId < length; tokenId++) {
          const [rawContractAddress, _externalTokenId, rawTokenType] = await deps.depository._tokens(tokenId);
          if (Number(rawTokenType) !== 0) continue;
          if (rawContractAddress === ethers.ZeroAddress) {
            throw new Error(`TOKEN_REGISTRY_ENTRY_ADDRESS_INVALID:${tokenId}`);
          }
          const contractAddress = ethers.getAddress(rawContractAddress);
          const erc20 = new ethers.Contract(contractAddress, erc20Interface, provider);
          const symbolFn = erc20.getFunction('symbol') as () => Promise<string>;
          const nameFn = erc20.getFunction('name') as () => Promise<string>;
          const decimalsFn = erc20.getFunction('decimals') as () => Promise<bigint>;
          const readMetadata = async <T>(field: string, read: () => Promise<T>): Promise<T> => {
            try {
              return await read();
            } catch (error) {
              const reason = error instanceof Error ? error.message : String(error);
              throw new Error(`TOKEN_METADATA_UNAVAILABLE:${tokenId}:${field}:${reason}`);
            }
          };
          const symbol = String(await readMetadata('symbol', symbolFn)).trim();
          const name = String(await readMetadata('name', nameFn)).trim();
          const decimals = Number(await readMetadata('decimals', decimalsFn));
          if (!symbol) throw new Error(`TOKEN_METADATA_INVALID:${tokenId}:symbol`);
          if (!name) throw new Error(`TOKEN_METADATA_INVALID:${tokenId}:name`);
          if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 255) {
            throw new Error(`TOKEN_METADATA_INVALID:${tokenId}:decimals:${String(decimals)}`);
          }
          tokens.push({ symbol, name, address: contractAddress, decimals, tokenId });
        }

        return tokens;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.startsWith('TOKEN_')) throw err;
        throw new Error(`TOKEN_REGISTRY_FETCH_FAILED:${message}`, { cause: err });
      }
    },

    async readWalletSnapshot(request: JWalletSnapshotRequest): Promise<JWalletSnapshot> {
      const owner = request.owner;
      const tokenAddresses = request.tokenAddresses;
      const allowances = request.allowances ?? [];
      const includeNativeBalance = request.includeNativeBalance !== false;
      const blockTag = request.blockTag ?? 'latest';
      const rpcBlockTag =
        typeof blockTag === 'number' ? `0x${Math.max(0, Math.floor(blockTag)).toString(16)}` : blockTag;
      const erc20Interface = new ethers.Interface([
        'function balanceOf(address owner) view returns (uint256)',
        'function allowance(address owner, address spender) view returns (uint256)',
      ]);

      if (rpcUrl && rpcUrl.startsWith('http')) {
        let nextId = 1;
        let nativeBalanceId: number | null = null;
        const tokenIds: number[] = [];
        const allowanceIds: number[] = [];
        const batch: RpcBatchRequest[] = [];

        if (includeNativeBalance) {
          nativeBalanceId = nextId;
          batch.push({
            id: nextId,
            jsonrpc: '2.0',
            method: 'eth_getBalance',
            params: [owner, rpcBlockTag],
          });
          nextId += 1;
        }

        for (const tokenAddress of tokenAddresses) {
          tokenIds.push(nextId);
          batch.push({
            id: nextId,
            jsonrpc: '2.0',
            method: 'eth_call',
            params: [
              {
                to: tokenAddress,
                data: erc20Interface.encodeFunctionData('balanceOf', [owner]),
              },
              rpcBlockTag,
            ],
          });
          nextId += 1;
        }

        for (const allowanceRead of allowances) {
          allowanceIds.push(nextId);
          batch.push({
            id: nextId,
            jsonrpc: '2.0',
            method: 'eth_call',
            params: [
              {
                to: allowanceRead.tokenAddress,
                data: erc20Interface.encodeFunctionData('allowance', [owner, allowanceRead.spender]),
              },
              rpcBlockTag,
            ],
          });
          nextId += 1;
        }

        const responses = await sendRpcBatch(rpcUrl, batch);
        const tokenErrors: NonNullable<JWalletSnapshot['tokenErrors']> = [];
        const allowanceErrors: NonNullable<JWalletSnapshot['allowanceErrors']> = [];
        const tokenBalances = tokenIds.map((id, index) => {
          const tokenAddress = tokenAddresses[index] ?? 'unknown';
          const result = readOptionalRpcBatchBigInt(responses, id, `balance:${tokenAddress}:${owner}`);
          if (result.ok) return result.value;
          tokenErrors.push({ tokenAddress, error: result.error });
          return 0n;
        });
        const allowanceValues = allowanceIds.map((id, index) => {
          const allowanceRead = allowances[index];
          const tokenAddress = allowanceRead?.tokenAddress ?? 'unknown';
          const spender = allowanceRead?.spender ?? 'unknown';
          const result = readOptionalRpcBatchBigInt(responses, id, `allowance:${tokenAddress}:${owner}:${spender}`);
          if (result.ok) return result.value;
          allowanceErrors.push({ tokenAddress, spender, error: result.error });
          return 0n;
        });

        return {
          nativeBalance:
            nativeBalanceId === null ? null : readRequiredRpcBatchBigInt(responses, nativeBalanceId, `native:${owner}`),
          tokenBalances,
          allowances: allowanceValues,
          ...(tokenErrors.length > 0 ? { tokenErrors } : {}),
          ...(allowanceErrors.length > 0 ? { allowanceErrors } : {}),
        };
      }

      const readViewUint = async (
        functionName: 'balanceOf' | 'allowance',
        to: string,
        data: string,
      ): Promise<{ ok: true; value: bigint } | { ok: false; error: string }> => {
        try {
          const result = await provider.call({ to, data, blockTag });
          const decoded = erc20Interface.decodeFunctionResult(functionName, result);
          return { ok: true, value: BigInt(decoded[0] ?? 0n) };
        } catch (error) {
          return {
            ok: false,
            error: `EXTERNAL_WALLET_SNAPSHOT_CALL_FAILED:${functionName}:${to}:${error instanceof Error ? error.message : String(error)}`,
          };
        }
      };

      const [nativeBalance, tokenBalanceResults, allowanceResults] = await Promise.all([
        includeNativeBalance ? provider.getBalance(owner, blockTag) : Promise.resolve<bigint | null>(null),
        Promise.all(
          tokenAddresses.map(tokenAddress =>
            readViewUint('balanceOf', tokenAddress, erc20Interface.encodeFunctionData('balanceOf', [owner])),
          ),
        ),
        Promise.all(
          allowances.map(allowanceRead =>
            readViewUint(
              'allowance',
              allowanceRead.tokenAddress,
              erc20Interface.encodeFunctionData('allowance', [owner, allowanceRead.spender]),
            ),
          ),
        ),
      ]);
      const tokenErrors: NonNullable<JWalletSnapshot['tokenErrors']> = [];
      const allowanceErrors: NonNullable<JWalletSnapshot['allowanceErrors']> = [];
      const tokenBalances = tokenBalanceResults.map((result, index) => {
        if (result.ok) return result.value;
        tokenErrors.push({ tokenAddress: tokenAddresses[index] ?? 'unknown', error: result.error });
        return 0n;
      });
      const allowanceValues = allowanceResults.map((result, index) => {
        const allowanceRead = allowances[index];
        if (result.ok) return result.value;
        allowanceErrors.push({
          tokenAddress: allowanceRead?.tokenAddress ?? 'unknown',
          spender: allowanceRead?.spender ?? 'unknown',
          error: result.error,
        });
        return 0n;
      });

      return {
        nativeBalance,
        tokenBalances,
        allowances: allowanceValues,
        ...(tokenErrors.length > 0 ? { tokenErrors } : {}),
        ...(allowanceErrors.length > 0 ? { allowanceErrors } : {}),
      };
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
