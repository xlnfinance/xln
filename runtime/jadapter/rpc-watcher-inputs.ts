import type { Provider } from 'ethers';
import { ethers } from 'ethers';
import type { Depository } from '../../jurisdictions/typechain-types';
import { compareStableText } from '../protocol/serialization';
import type { RuntimeReplica } from '../runtime/types';
import {
  decodeDisputeFinalizationEvidenceCalldata,
  type ExternalWalletTrackedOwnerCursor,
  type TxFinalizationEvidence,
} from './rpc-public';
import { watcherErrorDetails } from './rpc-boundary';

export type WatchedErc20Token = {
  tokenId: number;
  address: string;
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

  for (const replica of env.eReplicas?.values?.() || []) {
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
  for (const [entityId, entityOwners] of env.runtimeState?.externalWalletWatchOwners?.entries?.() || []) {
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
): ((txHash: string) => Promise<TxFinalizationEvidence[]>) => {
  const cache = new Map<string, Promise<TxFinalizationEvidence[]>>();
  return async (txHash: string): Promise<TxFinalizationEvidence[]> => {
    const normalizedHash = String(txHash || '').toLowerCase();
    if (!normalizedHash || normalizedHash === '0x') throw new Error('J_DISPUTE_FINALIZATION_TX_HASH_MISSING');
    const cached = cache.get(normalizedHash);
    if (cached) return cached;
    if (typeof provider.getTransaction !== 'function') {
      throw new Error('J_DISPUTE_FINALIZATION_TX_LOOKUP_UNAVAILABLE');
    }
    const pending = (async (): Promise<TxFinalizationEvidence[]> => {
      const tx = await provider.getTransaction(txHash);
      const data = typeof tx?.data === 'string' ? tx.data : '';
      if (!data || data === '0x') {
        throw new Error(`J_DISPUTE_FINALIZATION_TX_CALLDATA_MISSING:${normalizedHash}`);
      }
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

export const createWatchedErc20TokenReader = (
  depository: Depository,
  emitDebug: (payload: Record<string, unknown>) => void,
): (() => Promise<WatchedErc20Token[]>) => {
  let cache: WatchedErc20Token[] = [];
  let loadedAt = 0;
  return async (): Promise<WatchedErc20Token[]> => {
    const now = Date.now();
    if (cache.length > 0 && now - loadedAt < 10_000) return cache;
    const tokens: WatchedErc20Token[] = [];
    try {
      const length = Number(await depository.getTokensLength());
      for (let tokenId = 1; tokenId < length; tokenId += 1) {
        const [contractAddress] = await depository._tokens(tokenId);
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
    cache = tokens;
    loadedAt = now;
    return cache;
  };
};
