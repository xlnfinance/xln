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
  applyJBlockHeadersIngressTransform,
  buildJEventsRuntimeInput,
  buildRawJEventsRuntimeInput,
  collectRelevantJEventReplicaKeys,
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
  setJEventIngressTransform,
  setJBlockHeadersIngressTransform,
  setJHistoryRangeIngressTransform,
  updateWatcherJurisdictionCursor,
  type EventBatchCounter,
  type JEventIngressBatch,
  type JBlockHeadersIngress,
  type JHistoryRangeIngress,
  type JEventsRuntimeInputBuildResult,
  type PendingWatcherJBlockMap,
  type PendingWatcherJHistoryRange,
  type RawJEvent,
  type RawJEventArgs,
} from './helpers';
