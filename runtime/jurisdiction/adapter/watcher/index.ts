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
} from '../events/event-observation';

export {
  applyJEventsToEnv,
  buildJEventsRuntimeInput,
} from '../events/manual-event-ingress';

export {
  enqueueJHistoryRange,
} from '../events/history-ingress';

export {
  enqueueJHistoryRewindForReplicaKeys,
} from '../events/history-rewind';

export {
  findWatcherJurisdictionReplica,
  getMinimumCommittedSignerJHeight,
  getMinimumScannedSignerJHeight,
  isEntityReplicaRelevantToWatcher,
} from './observe/watcher-replica';

export {
  getWatcherStartBlock,
  isWatcherJHistoryRangeDurable,
  rememberPendingWatcherJBlock,
  resolveCommittedWatcherCursor,
  updateWatcherJurisdictionCursor,
  type PendingWatcherJBlockMap,
  type PendingWatcherJHistoryRange,
} from './observe/watcher-cursor';

export {
  processEventBatch,
} from './observe/watcher-event-batch';

export {
  collectRelevantJEventReplicaKeys,
} from '../events/event-relevance';

export {
  applyJBlockHeadersIngressTransform,
  setJBlockHeadersIngressTransform,
  setJEventIngressTransform,
  setJHistoryRangeIngressTransform,
  type JBlockHeadersIngress,
  type JEventIngressBatch,
  type JHistoryRangeIngress,
} from '../events/ingress-transform';

export type { JEventIngress } from '../types';
