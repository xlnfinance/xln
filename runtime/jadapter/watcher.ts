/**
 * Canonical J watcher -> runtime ingress surface.
 *
 * Infrastructure consumers can import this surface without knowing the owner
 * modules below. Consensus and Runtime handlers import the narrow owner module
 * they execute, which keeps dependency direction visible.
 */

export {
  buildJEventObservationInput,
  rawEventToJEvents,
  type EventBatchCounter,
  type JEventsRuntimeInputBuildResult,
} from './event-observation';

export {
  applyJEventsToEnv,
  buildJEventsRuntimeInput,
} from './manual-event-ingress';

export {
  enqueueJHistoryRange,
  buildJHistoryRangeRuntimeInput,
} from './history-ingress';

export {
  enqueueJHistoryRewind,
  enqueueJHistoryRewindForReplicaKeys,
} from './history-rewind';

export {
  findWatcherJurisdictionReplica,
  getMinimumCommittedSignerJHeight,
  getMinimumScannedSignerJHeight,
  isEntityReplicaRelevantToWatcher,
} from './watcher-replica';

export {
  applyWatcherJurisdictionCursor,
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
  isCanonicalEvent,
  isEventRelevantToEntity,
  type CanonicalJEventIngress,
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
