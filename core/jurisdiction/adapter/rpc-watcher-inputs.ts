import type { Interface, Provider } from 'ethers';
import { MAX_RPC_BATCH_CALLS, type RpcBatchSend } from './rpc-utils';
import { ethers } from 'ethers';
import { compareStableText } from '../../protocol/serialization';
import type { RuntimeReplica } from '../../runtime/types';
import {
  recoverDisputeFinalizationEvidence,
  recoverDisputeProofBody,
  type ExternalWalletTrackedOwnerCursor,
  type TxDisputeProofBodyEvidence,
  type TxFinalizationEvidence,
} from './rpc-public';
import { watcherErrorDetails } from './rpc/rpc-boundary';
import {
  DisputeCalldata,
  readIncludedTronCalldata,
  type SolidifiedTronTransactionReader,
} from './rpc/watcher/rpc-watcher-calldata';

export type WatchedErc20Token = {
  tokenId: number;
  address: string;
};

type WatchedTokenRegistry = {
  getTokensLength(): Promise<bigint>;
  getAddress(): Promise<string>;
  interface: Interface;
};

export type AuthenticatedTxLocation = Readonly<{
  blockHash: string;
  blockNumber: number;
}>;

const readSignedEvmCalldata = async (provider: Provider, txHash: string, normalizedHash: string): Promise<string> => {
  const tx = await provider.getTransaction(txHash);
  if (!tx) throw new Error(`J_DISPUTE_TX_MISSING:${normalizedHash}`);
  const claimedHash = String(tx.hash || '').toLowerCase();
  if (claimedHash !== normalizedHash) {
    throw new Error(`J_DISPUTE_TX_HASH_CLAIM_MISMATCH:${normalizedHash}:${claimedHash || 'missing'}`);
  }
  let computedHash: string | undefined;
  try {
    // Copy signed fields only. Transaction.from(tx) also reads tx.hash/from repeatedly;
    // those getters reserialize/hash large calldata and recover an irrelevant sender.
    // The complete signed envelope below is still recomputed and compared to the receipt txID.
    computedHash = ethers.Transaction.from({
      type: tx.type,
      chainId: tx.chainId,
      nonce: tx.nonce,
      to: tx.to,
      gasLimit: tx.gasLimit,
      gasPrice: tx.gasPrice,
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
      maxFeePerGas: tx.maxFeePerGas,
      maxFeePerBlobGas: tx.maxFeePerBlobGas,
      data: tx.data,
      value: tx.value,
      signature: tx.signature,
      accessList: tx.accessList,
      blobVersionedHashes: tx.blobVersionedHashes,
      authorizationList: tx.authorizationList,
    }).hash?.toLowerCase();
  } catch (error) {
    throw new Error(`J_DISPUTE_TX_HASH_INVALID:${normalizedHash}`, { cause: error });
  }
  if (computedHash !== normalizedHash) {
    throw new Error(`J_DISPUTE_TX_HASH_INVALID:${normalizedHash}:${computedHash || 'missing'}`);
  }
  return typeof tx.data === 'string' ? tx.data : '';
};

/**
 * Calldata bound to the receipt-attested transaction hash: an EVM signed
 * envelope recomputes to its keccak hash, a native TRON raw_data to its
 * sha256 txID. The committed jurisdiction mode selects the native reader.
 */
const readAuthenticatedTransactionCalldata = async (
  provider: Provider,
  txHash: string,
  location: AuthenticatedTxLocation,
  readNativeTronTransaction?: SolidifiedTronTransactionReader,
): Promise<string> => {
  const normalizedHash = txHash.toLowerCase();
  const data = readNativeTronTransaction
    ? await readIncludedTronCalldata(readNativeTronTransaction, normalizedHash)
    : await readSignedEvmCalldata(provider, txHash, normalizedHash);
  if (!ethers.isHexString(location.blockHash, 32) || !Number.isSafeInteger(location.blockNumber)) {
    throw new Error(`J_DISPUTE_TX_LOCATION_INVALID:${normalizedHash}`);
  }
  // Receipt membership already proves that this exact transaction hash
  // occupied the authenticated block. Recomputing the transaction hash binds
  // calldata cryptographically; comparing the RPC's mutable location
  // metadata is redundant and breaks across honest local reorg/replay where an
  // identical signed tx is re-mined under the same hash in a different block.
  if (!data || data === '0x') throw new Error(`J_DISPUTE_TX_CALLDATA_MISSING:${normalizedHash}`);
  return data;
};

export const normalizeEvmAddress = (value: unknown): string => {
  const candidate = String(value || '')
    .trim()
    .toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(candidate) ? candidate : '';
};

export const buildTrackedExternalOwners = (env: RuntimeReplica): Map<string, ExternalWalletTrackedOwnerCursor[]> => {
  const owners = new Map<string, Map<string, ExternalWalletTrackedOwnerCursor>>();
  const readBlock = (value: unknown): number => {
    const numeric = Number(value || 0);
    return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : 0;
  };
  const getTracked = (owner: string, entityId: string): ExternalWalletTrackedOwnerCursor | null => {
    const normalizedOwner = normalizeEvmAddress(owner);
    const normalizedEntity = String(entityId || '')
      .trim()
      .toLowerCase();
    if (!normalizedOwner || !normalizedEntity) return null;
    const byEntity = owners.get(normalizedOwner) ?? new Map<string, ExternalWalletTrackedOwnerCursor>();
    owners.set(normalizedOwner, byEntity);
    const tracked = byEntity.get(normalizedEntity) ?? {
      entityId: normalizedEntity,
      watchAfterBlock: 0,
      balanceAfterBlockByToken: new Map(),
      allowanceAfterBlockByKey: new Map(),
    };
    byEntity.set(normalizedEntity, tracked);
    return tracked;
  };

  for (const replica of env.state.eReplicas?.values?.() || []) {
    const entityId = String(replica.state?.entityId || replica.entityId || '')
      .trim()
      .toLowerCase();
    const externalWallet = replica.state?.externalWallet;
    if (!entityId || !externalWallet) continue;
    for (const [owner, balances] of externalWallet.balances?.entries?.() || []) {
      const tracked = getTracked(owner, entityId);
      if (!tracked) continue;
      for (const [tokenAddress, record] of balances.entries()) {
        const token = normalizeEvmAddress(tokenAddress);
        if (!token) continue;
        tracked.balanceAfterBlockByToken.set(
          token,
          Math.max(tracked.balanceAfterBlockByToken.get(token) ?? 0, readBlock(record.jHeight)),
        );
      }
    }
    for (const [owner, allowances] of externalWallet.allowances?.entries?.() || []) {
      const tracked = getTracked(owner, entityId);
      if (!tracked) continue;
      for (const [allowanceKey, record] of allowances.entries()) {
        const [tokenAddress, spender] = String(allowanceKey || '').split(':');
        const token = normalizeEvmAddress(tokenAddress);
        const normalizedSpender = normalizeEvmAddress(spender);
        if (!token || !normalizedSpender) continue;
        const key = `${token}:${normalizedSpender}`;
        tracked.allowanceAfterBlockByKey.set(
          key,
          Math.max(tracked.allowanceAfterBlockByKey.get(key) ?? 0, readBlock(record.jHeight)),
        );
      }
    }
  }
  for (const [entityId, entityOwners] of env.infrastructure?.externalWalletWatchOwners?.entries?.() || []) {
    for (const [owner, afterBlock] of entityOwners) {
      const tracked = getTracked(owner, entityId);
      if (tracked) tracked.watchAfterBlock = Math.max(tracked.watchAfterBlock, readBlock(afterBlock));
    }
  }
  return new Map(
    [...owners.entries()].map(([owner, byEntity]) => [
      owner,
      [...byEntity.values()].sort((left, right) => compareStableText(left.entityId, right.entityId)),
    ]),
  );
};

/** Cache authenticated bytes and complete structural memoization, never partial decoded results. */
const createCalldataReader = (provider: Provider, native?: SolidifiedTronTransactionReader) => {
  const cache = new Map<string, Promise<DisputeCalldata>>();
  return async <T>(
    txHash: string,
    location: AuthenticatedTxLocation,
    kind: string,
    read: (raw: DisputeCalldata) => T,
  ): Promise<T> => {
    const hash = String(txHash || '').toLowerCase();
    if (!hash || hash === '0x') throw new Error(`J_DISPUTE_${kind}_TX_HASH_MISSING`);
    let pending = cache.get(hash);
    if (!pending) {
      if (typeof provider.getTransaction !== 'function') throw new Error(`J_DISPUTE_${kind}_TX_LOOKUP_UNAVAILABLE`);
      pending = readAuthenticatedTransactionCalldata(provider, txHash, location, native).then(
        data => new DisputeCalldata(data),
      );
      cache.set(hash, pending);
      if (cache.size > 2_000) {
        const oldest = cache.keys().next().value;
        if (oldest) cache.delete(oldest);
      }
    }
    try {
      return read(await pending);
    } catch (error) {
      if (cache.get(hash) === pending) cache.delete(hash);
      // Resource failures are operator-visible, retain tx identity/limit, and retry from fresh bytes.
      if (error instanceof Error && /BUDGET|LIMIT|RESOURCE|out of memory|allocation|stack size/i.test(error.message)) {
        const signal = new Error(`J_DISPUTE_CALLDATA_RESOURCE_LIMIT:${hash}:${error.message}`, { cause: error });
        signal.name = 'DisputeCalldataResourceError';
        throw signal;
      }
      throw error;
    }
  };
};

export const createTxFinalizationEvidenceReader = (
  provider: Provider,
  readNativeTronTransaction?: SolidifiedTronTransactionReader,
): ((txHash: string, location: AuthenticatedTxLocation) => Promise<TxFinalizationEvidence[]>) => {
  const read = createCalldataReader(provider, readNativeTronTransaction);
  return (txHash, location) => read(txHash, location, 'FINALIZATION', recoverDisputeFinalizationEvidence);
};

export const createTxDisputeProofBodyReader = (
  provider: Provider,
  readNativeTronTransaction?: SolidifiedTronTransactionReader,
): ((
  txHash: string,
  eventName: TxDisputeProofBodyEvidence['eventName'],
  args: Record<string, unknown>,
  location: AuthenticatedTxLocation,
) => Promise<TxDisputeProofBodyEvidence['proofbody']>) => {
  const read = createCalldataReader(provider, readNativeTronTransaction);
  return (txHash, eventName, args, location) =>
    read(txHash, location, 'PROOFBODY', raw => recoverDisputeProofBody(raw, eventName, args));
};

export const createWatchedErc20TokenReader = (
  depository: WatchedTokenRegistry,
  sendBatch: RpcBatchSend,
  emitDebug: (payload: Record<string, unknown>) => void,
): (() => Promise<WatchedErc20Token[]>) => {
  // Registry length confirmed by the previous refresh. While it fits one
  // batch, the next refresh reads the length inside the entry batch.
  let knownLength: number | null = null;
  const decodeLength = (raw: unknown): number | null => {
    if (typeof raw !== 'string') return null;
    try {
      return Number(depository.interface.decodeFunctionResult('getTokensLength', raw)[0]);
    } catch {
      return null;
    }
  };
  return async (): Promise<WatchedErc20Token[]> => {
    const tokens: WatchedErc20Token[] = [];
    try {
      const address = await depository.getAddress();
      const call = (data: string) => ({ method: 'eth_call', params: [{ to: address, data }, 'latest'] });
      const entryCall = (tokenId: number) => call(depository.interface.encodeFunctionData('_tokens', [tokenId]));
      const collect = (start: number, entries: readonly unknown[]): void => {
        for (let index = 0; index < entries.length; index += 1) {
          const tokenId = start + index;
          const raw = entries[index];
          if (typeof raw !== 'string') throw new Error(`J_TOKEN_REGISTRY_ENTRY_INVALID:${tokenId}`);
          const [contractAddress, , tokenType] = depository.interface.decodeFunctionResult('_tokens', raw);
          if (tokenType !== 0n) continue;
          const address = normalizeEvmAddress(contractAddress);
          if (address && address !== ethers.ZeroAddress) tokens.push({ tokenId, address });
        }
      };
      // Refresh the complete registry on every poll. Batch transport only:
      // a failed entry must reject this range before its cursor can advance.
      const cached = knownLength;
      knownLength = null;
      if (cached !== null && cached <= MAX_RPC_BATCH_CALLS) {
        const calls = [
          call(depository.interface.encodeFunctionData('getTokensLength')),
          ...Array.from({ length: cached - 1 }, (_, index) => entryCall(index + 1)),
        ];
        // Any failure here (a reorged-out entry reverts, a transport outage)
        // falls through to the exact read below, which owns every error.
        const entries = await sendBatch(calls).catch(() => null);
        // Only an unchanged length proves these entries are the complete set.
        if (entries?.length === calls.length && decodeLength(entries[0]) === cached) {
          collect(1, entries.slice(1));
          knownLength = cached;
          return tokens;
        }
      }
      const length = Number(await depository.getTokensLength());
      if (!Number.isSafeInteger(length) || length < 1) throw new Error('J_TOKEN_REGISTRY_LENGTH_INVALID');
      for (let start = 1; start < length; start += MAX_RPC_BATCH_CALLS) {
        const calls = Array.from({ length: Math.min(MAX_RPC_BATCH_CALLS, length - start) }, (_, index) =>
          entryCall(start + index),
        );
        const entries = await sendBatch(calls);
        if (entries.length !== calls.length) throw new Error('J_TOKEN_REGISTRY_BATCH_LENGTH_MISMATCH');
        collect(start, entries);
      }
      knownLength = length;
    } catch (error) {
      emitDebug({
        event: 'j_watch_erc20_registry_read_failed',
        error: watcherErrorDetails(error),
      });
      // The registry defines the complete set of log addresses for this poll.
      // Advancing the cursor with a stale or empty set could permanently omit
      // a newly registered token, so the same block range must be retried.
      throw new Error(`J_WATCH_ERC20_REGISTRY_READ_FAILED:${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }
    return tokens;
  };
};
