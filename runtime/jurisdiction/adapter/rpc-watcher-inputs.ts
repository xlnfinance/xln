import type { Provider } from 'ethers';
import { ethers } from 'ethers';
import { compareStableText } from '../../protocol/serialization';
import type { RuntimeReplica } from '../../runtime/types';
import {
  decodeDisputeFinalizationEvidenceCalldata,
  decodeDisputeProofBodyEvidenceCalldata,
  resolveDisputeProofBodyEvidence,
  type ExternalWalletTrackedOwnerCursor,
  type TxDisputeProofBodyEvidence,
  type TxFinalizationEvidence,
} from './rpc-public';
import { watcherErrorDetails } from './rpc/rpc-boundary';

export type WatchedErc20Token = {
  tokenId: number;
  address: string;
};

type WatchedTokenRegistry = {
  getTokensLength(): Promise<bigint>;
  _tokens(tokenId: number): Promise<
    readonly [contractAddress: string, externalTokenId: bigint, tokenType: bigint]
  >;
};

export type AuthenticatedTxLocation = Readonly<{
  blockHash: string;
  blockNumber: number;
}>;

const readAuthenticatedTransactionCalldata = async (
  provider: Provider,
  txHash: string,
  location: AuthenticatedTxLocation,
): Promise<string> => {
  const normalizedHash = txHash.toLowerCase();
  const tx = await provider.getTransaction(txHash);
  if (!tx) throw new Error(`J_DISPUTE_TX_MISSING:${normalizedHash}`);
  const claimedHash = String(tx.hash || '').toLowerCase();
  if (claimedHash !== normalizedHash) {
    throw new Error(`J_DISPUTE_TX_HASH_CLAIM_MISMATCH:${normalizedHash}:${claimedHash || 'missing'}`);
  }
  let computedHash: string | undefined;
  try {
    computedHash = ethers.Transaction.from(tx).hash?.toLowerCase();
  } catch (error) {
    throw new Error(`J_DISPUTE_TX_HASH_INVALID:${normalizedHash}`, { cause: error });
  }
  if (computedHash !== normalizedHash) {
    throw new Error(`J_DISPUTE_TX_HASH_INVALID:${normalizedHash}:${computedHash || 'missing'}`);
  }
  if (!ethers.isHexString(location.blockHash, 32) || !Number.isSafeInteger(location.blockNumber)) {
    throw new Error(`J_DISPUTE_TX_LOCATION_INVALID:${normalizedHash}`);
  }
  // Receipt-trie membership already proves that this exact transaction hash
  // occupied the authenticated block. Recomputing the signed transaction hash
  // binds calldata cryptographically; comparing the RPC's mutable location
  // metadata is redundant and breaks across honest local reorg/replay where an
  // identical signed tx is re-mined under the same hash in a different block.
  const data = typeof tx.data === 'string' ? tx.data : '';
  if (!data || data === '0x') throw new Error(`J_DISPUTE_TX_CALLDATA_MISSING:${normalizedHash}`);
  return data;
};

export const normalizeEvmAddress = (value: unknown): string => {
  const candidate = String(value || '')
    .trim()
    .toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(candidate) ? candidate : '';
};

export const buildTrackedExternalOwners = (
  env: RuntimeReplica,
): Map<string, ExternalWalletTrackedOwnerCursor[]> => {
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

export const createTxFinalizationEvidenceReader = (
  provider: Provider,
): ((txHash: string, location: AuthenticatedTxLocation) => Promise<TxFinalizationEvidence[]>) => {
  const cache = new Map<string, Promise<TxFinalizationEvidence[]>>();
  return async (txHash: string, location: AuthenticatedTxLocation): Promise<TxFinalizationEvidence[]> => {
    const normalizedHash = String(txHash || '').toLowerCase();
    if (!normalizedHash || normalizedHash === '0x') throw new Error('J_DISPUTE_FINALIZATION_TX_HASH_MISSING');
    const cached = cache.get(normalizedHash);
    if (cached) return cached;
    if (typeof provider.getTransaction !== 'function') {
      throw new Error('J_DISPUTE_FINALIZATION_TX_LOOKUP_UNAVAILABLE');
    }
    const pending = (async (): Promise<TxFinalizationEvidence[]> => {
      const data = await readAuthenticatedTransactionCalldata(provider, txHash, location);
      return decodeDisputeFinalizationEvidenceCalldata(data);
    })();
    cache.set(normalizedHash, pending);
    if (cache.size > 2_000) {
      const oldest = cache.keys().next().value;
      if (oldest) cache.delete(oldest);
    }
    try {
      return await pending;
    } catch (error) {
      // Rejected promises are never cached: a transient RPC failure must be
      // retryable on the next poll for the same transaction.
      if (cache.get(normalizedHash) === pending) cache.delete(normalizedHash);
      throw error;
    }
  };
};

export const createTxDisputeProofBodyReader = (
  provider: Provider,
): ((
  txHash: string,
  eventName: TxDisputeProofBodyEvidence['eventName'],
  args: Record<string, unknown>,
  location: AuthenticatedTxLocation,
) => Promise<TxDisputeProofBodyEvidence['proofbody']>) => {
  const cache = new Map<string, Promise<TxDisputeProofBodyEvidence[]>>();
  return async (txHash, eventName, args, location) => {
    const normalizedHash = String(txHash || '').toLowerCase();
    if (!normalizedHash || normalizedHash === '0x') throw new Error('J_DISPUTE_PROOFBODY_TX_HASH_MISSING');
    let pending = cache.get(normalizedHash);
    if (!pending) {
      if (typeof provider.getTransaction !== 'function') {
        throw new Error('J_DISPUTE_PROOFBODY_TX_LOOKUP_UNAVAILABLE');
      }
      pending = (async () => {
        const data = await readAuthenticatedTransactionCalldata(provider, txHash, location);
        return decodeDisputeProofBodyEvidenceCalldata(data);
      })();
      cache.set(normalizedHash, pending);
      if (cache.size > 2_000) {
        const oldest = cache.keys().next().value;
        if (oldest) cache.delete(oldest);
      }
    }
    try {
      return resolveDisputeProofBodyEvidence(await pending, eventName, args);
    } catch (error) {
      // Never memoize rejection: provider timeouts/429s and evidence lookup
      // failures must both be retryable on the next canonical poll.
      if (cache.get(normalizedHash) === pending) cache.delete(normalizedHash);
      throw error;
    }
  };
};

export const createWatchedErc20TokenReader = (
  depository: WatchedTokenRegistry,
  emitDebug: (payload: Record<string, unknown>) => void,
): (() => Promise<WatchedErc20Token[]>) => {
  return async (): Promise<WatchedErc20Token[]> => {
    const tokens: WatchedErc20Token[] = [];
    try {
      const length = Number(await depository.getTokensLength());
      for (let tokenId = 1; tokenId < length; tokenId += 1) {
        const [contractAddress, , tokenType] = await depository._tokens(tokenId);
        if (tokenType !== 0n) continue;
        const address = normalizeEvmAddress(contractAddress);
        if (address && address !== ethers.ZeroAddress) tokens.push({ tokenId, address });
      }
    } catch (error) {
      emitDebug({
        event: 'j_watch_erc20_registry_read_failed',
        error: watcherErrorDetails(error),
      });
      // The registry defines the complete set of log addresses for this poll.
      // Advancing the cursor with a stale or empty set could permanently omit
      // a newly registered token, so the same block range must be retried.
      throw new Error(
        `J_WATCH_ERC20_REGISTRY_READ_FAILED:${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return tokens;
  };
};
