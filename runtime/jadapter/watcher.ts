/**
 * Canonical J watcher -> runtime ingress surface.
 *
 * Import watcher delivery/cursor helpers from here, not from scattered runtime
 * files. The implementation is intentionally centralized so J-event fanout,
 * filtering, and runtime wake semantics do not fork.
 */

export {
  applyJEventsToEnv,
  collectRelevantJEventReplicaKeys,
  getWatcherStartBlock,
  getMinimumCommittedSignerJHeight,
  processEventBatch,
  rawEventToJEvents,
  rememberPendingWatcherJBlock,
  resolveCommittedWatcherCursor,
  updateWatcherJurisdictionCursor,
  type EventBatchCounter,
  type PendingWatcherJBlockMap,
  type RawJEvent,
  type RawJEventArgs,
} from './helpers';
