/**
 * Canonical J watcher -> runtime ingress surface.
 *
 * Import watcher delivery/cursor helpers from here, not from scattered runtime
 * files. The implementation is intentionally centralized so J-event fanout,
 * filtering, and runtime wake semantics do not fork.
 */

export {
  applyJEventsToEnv,
  buildJEventsRuntimeInput,
  buildRawJEventsRuntimeInput,
  collectRelevantJEventReplicaKeys,
  getWatcherStartBlock,
  getMinimumCommittedSignerJHeight,
  processEventBatch,
  rawEventToJEvents,
  rememberPendingWatcherJBlock,
  resolveCommittedWatcherCursor,
  setJEventIngressTransform,
  updateWatcherJurisdictionCursor,
  type EventBatchCounter,
  type JEventIngressBatch,
  type JEventsRuntimeInputBuildResult,
  type PendingWatcherJBlockMap,
  type RawJEvent,
  type RawJEventArgs,
} from './helpers';
