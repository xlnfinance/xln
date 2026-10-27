import { watcherErrorDetails } from './rpc/rpc-boundary';
import type { Interface } from 'ethers';
import { MAX_RPC_BATCH_CALLS, type RpcBatchSend } from './rpc-utils';
import { ethers } from 'ethers';
import { compareStableText } from '../../protocol/serialization';
import type { RuntimeReplica } from '../../runtime/types';
import type { ExternalWalletTrackedOwnerCursor } from './rpc-public';
export type WatchedErc20Token = {
  tokenId: number;
  address: string;
};

type WatchedTokenRegistry = {
  getTokensLength(): Promise<bigint>;
  getAddress(): Promise<string>;
  interface: Interface;
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
