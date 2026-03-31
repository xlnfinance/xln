/**
 * Canonical J watcher -> runtime ingress surface.
 *
 * Import watcher delivery/cursor helpers from here, not from scattered runtime
 * files. The implementation is intentionally centralized so J-event fanout,
 * filtering, and runtime wake semantics do not fork.
 */

export {
  applyJEventsToEnv,
  getWatcherStartBlock,
  processEventBatch,
  updateWatcherJurisdictionCursor,
  type EventBatchCounter,
  type RawJEvent,
  type RawJEventArgs,
} from './helpers';
