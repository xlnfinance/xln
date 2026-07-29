/**
 * Canonical J watcher -> runtime ingress surface.
 *
 * Import watcher delivery/cursor helpers from here, not from scattered runtime
 * files. The implementation is intentionally centralized so J-event fanout,
 * filtering, and runtime wake semantics do not fork.
 */

export {
  applyJEventsToEnv,
  applyWatcherJurisdictionCursor,
  buildJEventsRuntimeInput,
  buildJEventObservationInput,
  enqueueJHistoryRewind,
  enqueueJHistoryRewindForReplicaKeys,
  getWatcherStartBlock,
  findWatcherJurisdictionReplica,
  getMinimumCommittedSignerJHeight,
  getMinimumScannedSignerJHeight,
  isWatcherJHistoryRangeDurable,
  enqueueJHistoryRange,
  isEntityReplicaRelevantToWatcher,
  processEventBatch,
  rawEventToJEvents,
  rememberPendingWatcherJBlock,
  resolveCommittedWatcherCursor,
  updateWatcherJurisdictionCursor,
  type EventBatchCounter,
  type JEventsRuntimeInputBuildResult,
  type PendingWatcherJBlockMap,
  type PendingWatcherJHistoryRange,
} from './helpers';

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
