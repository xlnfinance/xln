/**
 * Canonical J watcher -> runtime ingress surface.
 *
 * Infrastructure consumers can import this surface without knowing the owner
 * modules below. Consensus and Runtime handlers import the narrow owner module
 * they execute, which keeps dependency direction visible.
 */

export {
  rawEventToJEvents,
  type EventBatchCounter,
} from './event-observation';

export {
  applyJEventsToEnv,
  buildJEventsRuntimeInput,
} from './manual-event-ingress';

export {
  enqueueJHistoryRange,
} from './history-ingress';

export {
  enqueueJHistoryRewindForReplicaKeys,
} from './history-rewind';

export {
  findWatcherJurisdictionReplica,
  getMinimumCommittedSignerJHeight,
  getMinimumScannedSignerJHeight,
  isEntityReplicaRelevantToWatcher,
} from './watcher-replica';

export {
  getWatcherStartBlock,
  isWatcherJHistoryRangeDurable,
  rememberPendingWatcherJBlock,
  resolveCommittedWatcherCursor,
  updateWatcherJurisdictionCursor,
  type PendingWatcherJBlockMap,
  type PendingWatcherJHistoryRange,
} from './watcher-cursor';

export {
  processEventBatch,
} from './watcher-event-batch';

export {
  collectRelevantJEventReplicaKeys,
} from './event-relevance';

export {
  applyJBlockHeadersIngressTransform,
  setJBlockHeadersIngressTransform,
  setJEventIngressTransform,
  setJHistoryRangeIngressTransform,
  type JBlockHeadersIngress,
  type JEventIngressBatch,
  type JHistoryRangeIngress,
} from './ingress-transform';

export type { JEventIngress } from './types';
