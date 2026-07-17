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
import { createXlnJsonRpcProvider } from '../jadapter';
import { assertWatchtowerRpcUrlAllowed } from './action';
import { buildDisputeWakeNotification, disputeWakeCollapseKey, selectWakeTargets } from '../push/dispute-wake';
import { createStructuredLogger } from '../infra/logger';
import type { DisputeWakeEvent, PushSender, StoredPushRegistration } from '../push/types';

const DISPUTE_STARTED_ABI = [
  'event DisputeStarted(bytes32 indexed sender, bytes32 indexed counterentity, uint256 indexed nonce, bytes32 proofbodyHash, bytes32 watchSeed, bytes starterInitialArguments, bytes starterIncrementedArguments, uint256 disputeTimeout)',
] as const;
const DISPUTE_INTERFACE = new Interface(DISPUTE_STARTED_ABI);
const DISPUTE_STARTED_TOPIC = DISPUTE_INTERFACE.getEvent('DisputeStarted')!.topicHash;

const DEFAULT_MAX_BLOCK_RANGE = 5_000;
const DEFAULT_MAX_BACKFILL_BLOCKS = 50_000;
const disputeWatchLog = createStructuredLogger('watchtower.dispute_watch');

const formatError = (error: unknown): string => error instanceof Error ? error.message : String(error);

type WatchLog = { topics: readonly string[]; data: string; blockNumber?: number; transactionHash?: string };

type WatchProvider = {
  getBlockNumber: () => Promise<number>;
  getLogs: (filter: Record<string, unknown>) => Promise<WatchLog[]>;
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
  try {
    const parsed = DISPUTE_INTERFACE.parseLog({ topics: [...(log.topics || [])], data: String(log.data || '0x') });
    if (!parsed || parsed.name !== 'DisputeStarted') return null;
    return {
      chainId,
      depositoryAddress: depositoryAddress.toLowerCase(),
      sender: String(parsed.args[0]).toLowerCase(),
      counterentity: String(parsed.args[1]).toLowerCase(),
      nonce: Number(parsed.args[2]),
      blockNumber: Number(log.blockNumber || 0),
      ...(log.transactionHash ? { txHash: String(log.transactionHash) } : {}),
    };
  } catch {
    return null;
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
  const customProviderFactory = options?.providerFactory;
  const providerFactory = customProviderFactory
    || ((rpcUrl: string) => createXlnJsonRpcProvider(rpcUrl) as unknown as WatchProvider);

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

      const head = Math.max(0, Math.floor(Number(await provider.getBlockNumber())));
      const storedCursor = await store.getCursor(target.chainId, target.depositoryAddress);
      const requestedFrom = storedCursor !== null ? storedCursor + 1 : head - maxBlockRange;
      const flooredFrom = Math.max(0, requestedFrom, head - maxBackfill);

      let cursor = flooredFrom - 1;
      for (let start = flooredFrom; start <= head; start += maxBlockRange) {
        const end = Math.min(head, start + maxBlockRange - 1);
        const logs = await provider.getLogs({
          fromBlock: start,
          toBlock: end,
          address: target.depositoryAddress,
          topics: [DISPUTE_STARTED_TOPIC],
        });
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
            }
          }
        }
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
