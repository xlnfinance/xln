/**
 * Watchtower dispute-watch sweep.
 *
 * Polls each registered (chain, depository) target for DisputeStarted logs since
 * a persisted cursor, matches the victim (counterentity) against registered
 * devices, and sends a wake notification. Idempotent: wakes are deduped per
 * (collapseKey, tokenHash) so cursor overlap or a crash mid-sweep cannot double
 * wake. This is detection + notify only — it never touches keys, proofs, or the
 * chain beyond read-only getLogs.
 */

import { Interface } from 'ethers';
import { createXlnJsonRpcProvider } from '../jurisdiction/adapter';
import { assertWatchtowerRpcUrlAllowed } from './action';
import { buildDisputeWakeNotification, disputeWakeCollapseKey, selectWakeTargets } from './push/dispute-wake';
import { createStructuredLogger } from '../infra/logger';
import type { DisputeWakeEvent, PushSender, StoredPushRegistration } from './push/types';

const DISPUTE_STARTED_ABI = [
  'event DisputeStarted(bytes32 indexed sender, bytes32 indexed counterentity, uint256 indexed nonce, bytes32 proofbodyHash, bytes32 watchSeed, bytes starterInitialArguments, bytes starterIncrementedArguments, uint256 disputeTimeout, uint256 disputeStartTimestamp)',
] as const;
const DISPUTE_INTERFACE = new Interface(DISPUTE_STARTED_ABI);
const DISPUTE_STARTED_TOPIC = DISPUTE_INTERFACE.getEvent('DisputeStarted')!.topicHash;

const DEFAULT_MAX_BLOCK_RANGE = 5_000;
const DEFAULT_MAX_BACKFILL_BLOCKS = 50_000;
const DEFAULT_CONFIRMATIONS = 12;
const DEFAULT_RPC_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_LOGS_PER_CHUNK = 10_000;
const disputeWatchLog = createStructuredLogger('watchtower.dispute_watch');

const uint256ToSafeNumber = (value: unknown, label: string): number => {
  if (typeof value !== 'bigint' || value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`WATCHTOWER_DISPUTE_${label}_INVALID`);
  }
  return Number(value);
};

const formatError = (error: unknown): string => error instanceof Error ? error.message : String(error);

type WatchLog = { topics: readonly string[]; data: string; blockNumber?: number; transactionHash?: string };

type WatchProvider = {
  getBlockNumber: () => Promise<number>;
  getLogs: (filter: {
    address: string;
    topics: string[];
    fromBlock: number;
    toBlock: number;
  }) => Promise<readonly WatchLog[]>;
};

export interface DisputeWatchStore {
  listWatchTargets(): Promise<Array<{ chainId: number; depositoryAddress: string; rpcUrl: string }>>;
  listRegistrationsForTarget(chainId: number, depositoryAddress: string): Promise<StoredPushRegistration[]>;
  getCursor(chainId: number, depositoryAddress: string): Promise<number | null>;
  setCursor(chainId: number, depositoryAddress: string, blockNumber: number): Promise<void>;
  wasRecentlyWoken(key: string): Promise<boolean>;
  markWoken(key: string, at: number): Promise<void>;
}

export type DisputeWatchOptions = {
  allowedRpcUrls?: string[];
  maxBlockRange?: number;
  maxBackfillBlocks?: number;
  confirmations?: number;
  rpcTimeoutMs?: number;
  maxLogsPerChunk?: number;
  providerFactory?: (rpcUrl: string, chainId: number) => WatchProvider;
  now?: () => number;
};

export type DisputeWatchResult = {
  targetsScanned: number;
  eventsObserved: number;
  notificationsSent: number;
  notificationsSkipped: number;
  errors: number;
};

const parseDisputeStarted = (
  log: WatchLog,
  chainId: number,
  depositoryAddress: string,
): DisputeWakeEvent | null => {
  const topic0 = String(log.topics?.[0] || '').toLowerCase();
  if (topic0 !== DISPUTE_STARTED_TOPIC.toLowerCase()) return null;
  try {
    const parsed = DISPUTE_INTERFACE.parseLog({ topics: [...(log.topics || [])], data: String(log.data || '0x') });
    if (!parsed || parsed.name !== 'DisputeStarted') return null;
    return {
      chainId,
      depositoryAddress: depositoryAddress.toLowerCase(),
      sender: String(parsed.args[0]).toLowerCase(),
      counterentity: String(parsed.args[1]).toLowerCase(),
      nonce: uint256ToSafeNumber(parsed.args[2], 'NONCE'),
      blockNumber: Number(log.blockNumber || 0),
      ...(log.transactionHash ? { txHash: String(log.transactionHash) } : {}),
    };
  } catch (error) {
    const location = `${chainId}:${depositoryAddress.toLowerCase()}:${Number(log.blockNumber || 0)}`;
    throw new Error(`WATCHTOWER_DISPUTE_MATCHING_LOG_INVALID:${location}:${formatError(error)}`, { cause: error });
  }
};

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}_TIMEOUT:${timeoutMs}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

export const runDisputeWatchSweep = async (
  store: DisputeWatchStore,
  sender: PushSender,
  options?: DisputeWatchOptions,
): Promise<DisputeWatchResult> => {
  const now = options?.now || (() => Date.now());
  const maxBlockRange = Math.max(100, Math.floor(Number(options?.maxBlockRange ?? DEFAULT_MAX_BLOCK_RANGE)));
  const maxBackfill = Math.max(maxBlockRange, Math.floor(Number(options?.maxBackfillBlocks ?? DEFAULT_MAX_BACKFILL_BLOCKS)));
  const confirmations = Math.max(0, Math.floor(Number(options?.confirmations ?? DEFAULT_CONFIRMATIONS)));
  const rpcTimeoutMs = Math.max(1, Math.floor(Number(options?.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS)));
  const maxLogsPerChunk = Math.max(1, Math.floor(Number(options?.maxLogsPerChunk ?? DEFAULT_MAX_LOGS_PER_CHUNK)));
  const customProviderFactory = options?.providerFactory;
  const providerFactory = customProviderFactory
    || ((rpcUrl: string) => createXlnJsonRpcProvider(rpcUrl));

  const watchTargets = await store.listWatchTargets();
  let eventsObserved = 0;
  let notificationsSent = 0;
  let notificationsSkipped = 0;
  let errors = 0;

  for (const target of watchTargets) {
    try {
      const rpcUrl = customProviderFactory
        ? target.rpcUrl
        : assertWatchtowerRpcUrlAllowed(target.rpcUrl, options?.allowedRpcUrls);
      const provider = providerFactory(rpcUrl, target.chainId);
      const registrations = await store.listRegistrationsForTarget(target.chainId, target.depositoryAddress);
      if (registrations.length === 0) continue;

      const head = Math.max(0, Math.floor(Number(await withTimeout(
        provider.getBlockNumber(),
        rpcTimeoutMs,
        'WATCHTOWER_DISPUTE_HEAD',
      ))));
      const safeHead = Math.max(0, head - confirmations);
      const storedCursor = await store.getCursor(target.chainId, target.depositoryAddress);
      const requestedFrom = storedCursor !== null ? storedCursor + 1 : safeHead - maxBlockRange;
      const retainedFrom = Math.max(0, safeHead - maxBackfill);
      if (storedCursor !== null && requestedFrom < retainedFrom) {
        throw new Error(
          `WATCHTOWER_DISPUTE_BACKFILL_LIMIT_EXCEEDED:` +
          `${target.chainId}:${target.depositoryAddress}:${requestedFrom}:${retainedFrom}`,
        );
      }
      const flooredFrom = Math.max(0, requestedFrom, retainedFrom);
      if (flooredFrom > safeHead) continue;

      let cursor = flooredFrom - 1;
      for (let start = flooredFrom; start <= safeHead; start += maxBlockRange) {
        const end = Math.min(safeHead, start + maxBlockRange - 1);
        let chunkDeliveryFailed = false;
        const logs = await withTimeout(provider.getLogs({
            fromBlock: start,
            toBlock: end,
            address: target.depositoryAddress,
            topics: [DISPUTE_STARTED_TOPIC],
          }), rpcTimeoutMs, 'WATCHTOWER_DISPUTE_LOGS');
        if (logs.length > maxLogsPerChunk) {
          throw new Error(`WATCHTOWER_DISPUTE_LOG_LIMIT:${logs.length}:${maxLogsPerChunk}`);
        }
        for (const log of logs) {
          const event = parseDisputeStarted(log, target.chainId, target.depositoryAddress);
          if (!event) continue;
          eventsObserved += 1;
          for (const wake of selectWakeTargets(event, registrations)) {
            const dedupKey = `${disputeWakeCollapseKey(event)}:${wake.registration.tokenHash}`;
            if (await store.wasRecentlyWoken(dedupKey)) {
              notificationsSkipped += 1;
              continue;
            }
            const result = await sender.send(buildDisputeWakeNotification(wake));
            if (result.ok) {
              await store.markWoken(dedupKey, now());
              notificationsSent += 1;
            } else {
              errors += 1;
              chunkDeliveryFailed = true;
            }
          }
        }
        // Successful wakes are deduped durably, so replaying this chunk is
        // safe. Advancing past a failed wake would lose that dispute forever.
        if (chunkDeliveryFailed) break;
        cursor = end;
      }
      if (cursor >= flooredFrom) {
        await store.setCursor(target.chainId, target.depositoryAddress, cursor);
      }
    } catch (error) {
      errors += 1;
      disputeWatchLog.error('target.failed', {
        chainId: target.chainId,
        depositoryAddress: target.depositoryAddress,
        error: formatError(error),
      });
    }
  }

  return {
    targetsScanned: watchTargets.length,
    eventsObserved,
    notificationsSent,
    notificationsSkipped,
    errors,
  };
};
