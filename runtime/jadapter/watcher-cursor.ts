import type { RuntimeState, RuntimeTx } from '../runtime/types';
import { enqueueRuntimeInput } from '../runtime/input-queue';
import {
  getEntityCertifiedJAnchor,
  getValidatorJContiguousThroughHeight,
  getValidatorJExpectedBlockHash,
  assertValidatorJHistoryMatchesCertifiedAnchor,
} from '../jurisdiction/local-history';
import { markLocalJAuthorityRuntimeTx } from '../jurisdiction/registration-evidence';
import {
  findWatcherJurisdictionReplica,
  getMinimumCommittedSignerJHeight,
  requireWatcherJurisdictionReplica,
  watcherChainIdOf,
} from './watcher-replica';

export type PendingWatcherJBlockMap = Map<number, Set<string>>;

export type PendingWatcherJHistoryRange = {
  fromBlock: number;
  toBlock: number;
  tipBlockHash: string;
  replicaKeys: Set<string>;
};

export const getWatcherStartBlock = (
  env: RuntimeState,
  depositoryAddress?: string,
  chainId?: number,
): number => {
  const replica = depositoryAddress || chainId !== undefined
    ? requireWatcherJurisdictionReplica(env, depositoryAddress, chainId, 'start-block')
    : findWatcherJurisdictionReplica(env, depositoryAddress, chainId);
  const replicaHeight = Number(replica?.blockNumber ?? 0n);
  const signerHeight = getMinimumCommittedSignerJHeight(env, replica ?? undefined);
  const height = signerHeight === null
    ? replicaHeight
    : Math.min(replicaHeight, signerHeight);
  return Number.isFinite(height) && height >= 0
    ? Math.max(1, Math.floor(height) + 1)
    : 1;
};

export const updateWatcherJurisdictionCursor = (
  env: RuntimeState,
  blockNumber: number,
  depositoryAddress?: string,
  chainId?: number,
): void => {
  const replica = depositoryAddress || chainId !== undefined
    ? requireWatcherJurisdictionReplica(env, depositoryAddress, chainId, 'cursor-update')
    : findWatcherJurisdictionReplica(env, depositoryAddress, chainId);
  if (!replica) throw new Error('J_WATCHER_JURISDICTION_NOT_FOUND:cursor-update');
  if (!Number.isSafeInteger(blockNumber) || blockNumber < 0) {
    throw new Error(`J_WATCHER_CURSOR_INVALID:${String(blockNumber)}`);
  }
  const current = replica.blockNumber ?? 0n;
  if (typeof current !== 'bigint' || current < 0n) {
    throw new Error(`J_WATCHER_COMMITTED_CURSOR_INVALID:${String(current)}`);
  }
  if (current >= BigInt(blockNumber)) return;

  const depository = String(
    replica.depositoryAddress || replica.contracts?.depository || '',
  ).trim().toLowerCase();
  if (!depository) throw new Error('J_WATCHER_DEPOSITORY_MISSING:cursor-update');
  const replicaChainId = watcherChainIdOf(replica);
  const cursorTx: Extract<RuntimeTx, { type: 'advanceJWatcherCursor' }> = {
    type: 'advanceJWatcherCursor',
    data: {
      depositoryAddress: depository,
      ...(replicaChainId === null ? {} : { chainId: replicaChainId }),
      blockNumber,
    },
  };
  enqueueRuntimeInput(env, {
    timestamp: blockNumber,
    runtimeTxs: [markLocalJAuthorityRuntimeTx(cursorTx)],
    entityInputs: [],
  });
};

/** Apply the durable cursor transaction while constructing an R-frame. */
export const applyWatcherJurisdictionCursor = (
  env: RuntimeState,
  data: Extract<RuntimeTx, { type: 'advanceJWatcherCursor' }>['data'],
): void => {
  if (!Number.isSafeInteger(data.blockNumber) || data.blockNumber < 0) {
    throw new Error(`J_WATCHER_CURSOR_INVALID:${String(data.blockNumber)}`);
  }
  const replica = requireWatcherJurisdictionReplica(
    env,
    data.depositoryAddress,
    data.chainId,
    'cursor-apply',
  );
  const current = replica.blockNumber ?? 0n;
  if (typeof current !== 'bigint' || current < 0n) {
    throw new Error(`J_WATCHER_COMMITTED_CURSOR_INVALID:${String(current)}`);
  }
  replica.blockNumber = current > BigInt(data.blockNumber)
    ? current
    : BigInt(data.blockNumber);
};

export const rememberPendingWatcherJBlock = (
  pending: PendingWatcherJBlockMap,
  blockNumber: number,
  replicaKeys: Iterable<string>,
): void => {
  const block = Math.floor(Number(blockNumber));
  if (!Number.isFinite(block) || block < 0) return;
  for (const replicaKey of replicaKeys) {
    if (!replicaKey) continue;
    const entry = pending.get(block) ?? new Set<string>();
    entry.add(replicaKey);
    pending.set(block, entry);
  }
};

export const areJEventReplicaKeysFinalizedThrough = (
  env: RuntimeState,
  replicaKeys: Iterable<string>,
  blockNumber: number,
): boolean => {
  const target = Math.floor(Number(blockNumber));
  if (!Number.isFinite(target) || target < 0) return false;
  for (const replicaKey of replicaKeys) {
    const replica = env.eReplicas?.get(replicaKey);
    if (!replica) return false;
    const finalized = Number(replica.state?.lastFinalizedJHeight ?? 0);
    if (!Number.isFinite(finalized) || finalized < target) return false;
  }
  return true;
};

export const isWatcherJHistoryRangeDurable = (
  env: RuntimeState,
  range: PendingWatcherJHistoryRange,
): boolean => {
  if (
    !Number.isSafeInteger(range.fromBlock) ||
    !Number.isSafeInteger(range.toBlock) ||
    range.fromBlock <= 0 ||
    range.toBlock < range.fromBlock
  ) {
    throw new Error(`J_WATCHER_PENDING_SCAN_RANGE_INVALID:${range.fromBlock}:${range.toBlock}`);
  }
  const tipHash = String(range.tipBlockHash || '').toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(tipHash)) {
    throw new Error(`J_WATCHER_PENDING_SCAN_TIP_INVALID:${range.toBlock}`);
  }
  for (const replicaKey of range.replicaKeys) {
    const replica = env.eReplicas?.get(replicaKey);
    if (!replica) return false;
    const anchor = getEntityCertifiedJAnchor(replica.state);
    if (anchor && anchor.height > range.toBlock) {
      assertValidatorJHistoryMatchesCertifiedAnchor(replica.state, replica.jHistory);
      continue;
    }
    if (!replica.jHistory) return false;
    if (
      getValidatorJContiguousThroughHeight(replica.state, replica.jHistory) <
      range.toBlock
    ) return false;
    const observed = getValidatorJExpectedBlockHash(
      replica.state,
      replica.jHistory,
      range.toBlock,
    );
    if (String(observed || '').toLowerCase() !== tipHash) {
      throw new Error(
        `J_WATCHER_PENDING_SCAN_TIP_CONFLICT:${range.toBlock}:` +
        `expected=${tipHash}:observed=${String(observed || 'missing').toLowerCase()}`,
      );
    }
  }
  return true;
};

export const resolveCommittedWatcherCursor = (
  env: RuntimeState,
  pending: PendingWatcherJBlockMap,
  candidateCursor: number,
  currentCursor: number,
): number => {
  const candidate = Math.max(0, Math.floor(Number(candidateCursor)));
  let resolved = Math.max(0, Math.floor(Number(currentCursor)));
  if (!Number.isFinite(candidate) || !Number.isFinite(resolved)) return 0;
  if (candidate <= resolved) return resolved;

  for (const block of [...pending.keys()].sort((left, right) => left - right)) {
    if (block <= resolved) {
      pending.delete(block);
      continue;
    }
    if (block > candidate) break;
    const replicaKeys = pending.get(block);
    if (!replicaKeys || replicaKeys.size === 0) {
      pending.delete(block);
      continue;
    }
    if (!areJEventReplicaKeysFinalizedThrough(env, replicaKeys, block)) {
      return Math.max(resolved, block - 1);
    }
    pending.delete(block);
    resolved = block;
  }
  return Math.max(resolved, candidate);
};
