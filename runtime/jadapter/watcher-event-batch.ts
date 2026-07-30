import type { RuntimeInput, RuntimeReplica, RuntimeTx } from '../runtime/types';
import { enqueueRuntimeInput } from '../runtime/input-queue';
import { indexReserveUpdatedEvents } from '../jurisdiction/event-evidence';
import { isCanonicalEvent } from './event-relevance';
import { applyJEventIngressTransform } from './ingress-transform';
import {
  assertJEventIngressOpen,
  buildJEventObservationInput,
  type EventBatchCounter,
} from './event-observation';
import {
  appendJHistoryRange,
  buildJHistoryRangeRuntimeInput,
} from './history-ingress';
import type { JEventIngress } from './types';

const MAX_DEDUP_LOGS = 50_000;

const eventIdentity = (
  event: JEventIngress,
  index: number,
  blockHash: string,
): string => {
  const txHash = event.transactionHash || '';
  const entity =
    event.name === 'ExternalWalletSnapshot' || event.name === 'ExternalWalletDelta'
      ? `:${String(event.args['entityId'] ?? '').toLowerCase()}:${String(event.args['owner'] ?? '').toLowerCase()}`
      : '';
  if (txHash && event.logIndex !== undefined) {
    return `${txHash.toLowerCase()}:${event.logIndex}${entity}`;
  }
  return txHash
    ? `${txHash.toLowerCase()}:${event.name}${entity}:${index}`
    : `${event.blockHash ?? blockHash}:${event.name}${entity}:${index}`;
};

const deduplicate = (
  events: JEventIngress[],
  counter: EventBatchCounter,
  blockHash: string,
  historicalCatchUp: boolean,
): JEventIngress[] => {
  const seen = counter._seenLogs ??= { set: new Set(), order: [] };
  const result: JEventIngress[] = [];
  events.forEach((event, index) => {
    const key = eventIdentity(event, index, blockHash);
    if (seen.set.has(key) && !historicalCatchUp) return;
    if (!seen.set.has(key)) {
      seen.set.add(key);
      seen.order.push(key);
    }
    result.push(event);
  });
  while (seen.order.length > MAX_DEDUP_LOGS) {
    const oldest = seen.order.shift();
    if (oldest) seen.set.delete(oldest);
  }
  return result;
};

const assertChainCoordinates = (
  events: JEventIngress[],
  blockNumber: number,
  blockHash: string,
  label: string,
): void => {
  for (const event of events) {
    if (Number(event.blockNumber) !== blockNumber) {
      throw new Error(`J_EVENT_CHAIN_BLOCK_NUMBER_MISMATCH:${label}`);
    }
    if (String(event.blockHash || '').toLowerCase() !== blockHash.toLowerCase()) {
      throw new Error(`J_EVENT_CHAIN_BLOCK_HASH_MISMATCH:${label}`);
    }
    if (
      event.name !== 'ExternalWalletSnapshot' &&
      (!Number.isSafeInteger(event.logIndex) || Number(event.logIndex) < 0)
    ) {
      throw new Error(`J_EVENT_CHAIN_LOG_INDEX_MISSING:${label}:${event.name}`);
    }
  }
};

export const processEventBatch = (
  rawEvents: JEventIngress[],
  env: RuntimeReplica,
  blockNumber: number,
  blockHash: string,
  counter: EventBatchCounter,
  adapterLabel: string,
  watcherDepositoryAddress?: string,
  deferHistoryRange = false,
  source: 'chain' | 'synthetic' = 'synthetic',
  watcherChainId?: number,
  historicalReplicaCatchUp = false,
  localRuntimeTxs: RuntimeTx[] = [],
): RuntimeInput | null => {
  const canonical = rawEvents.filter(isCanonicalEvent);
  if (canonical.length === 0) return null;
  assertJEventIngressOpen(env, adapterLabel);
  const deduped = deduplicate(
    canonical, counter, blockHash, historicalReplicaCatchUp,
  );
  if (deduped.length === 0) return null;

  const batch = applyJEventIngressTransform({
    events: deduped, blockNumber, blockHash,
  });
  if (
    !Number.isSafeInteger(batch.blockNumber) ||
    batch.blockNumber < 0 ||
    typeof batch.blockHash !== 'string' ||
    batch.events.length === 0
  ) {
    throw new Error(`J_EVENT_INGRESS_TRANSFORM_INVALID:${adapterLabel}`);
  }
  if (source === 'chain') {
    assertChainCoordinates(batch.events, batch.blockNumber, batch.blockHash, adapterLabel);
  }
  const built = buildJEventObservationInput(env, batch.events, {
    blockNumber: batch.blockNumber,
    blockHash: batch.blockHash,
    adapterLabel,
    txCounter: counter,
    logBatch: Boolean(env.debugJWatcherBatches),
    emitSettledDebugEvents: true,
    ...(watcherDepositoryAddress ? { watcherDepositoryAddress } : {}),
    ...(watcherChainId === undefined ? {} : { watcherChainId }),
  });
  if (!built && localRuntimeTxs.length === 0) return null;
  if (built) indexReserveUpdatedEvents(env, built.evidenceEvents);
  const base = built?.input ?? {
    timestamp: batch.blockNumber, runtimeTxs: [], entityInputs: [],
  };
  const authenticated: RuntimeInput = {
    ...base,
    runtimeTxs: [...localRuntimeTxs, ...base.runtimeTxs],
  };
  const range = deferHistoryRange || !built
    ? null
    : buildJHistoryRangeRuntimeInput(
        env, [authenticated], batch.blockNumber, batch.blockHash,
        watcherDepositoryAddress, [], watcherChainId,
      );
  const input = appendJHistoryRange(authenticated, range?.input ?? null);
  if (!deferHistoryRange) enqueueRuntimeInput(env, input);
  return input;
};
