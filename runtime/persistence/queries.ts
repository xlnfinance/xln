import {
  createPersistenceEntityQueries,
} from './entity-queries';
import {
  createPersistenceHistoryQueries,
} from './history-queries';
import {
  createPersistenceRecordingQueries,
} from './recording-queries';
import type { PersistenceQueryDeps } from './query-deps';

export {
  buildRecoveryJournalFromStorageFrame,
} from './history-queries';
export type {
  PersistedRuntimeActivityPage,
} from './history-queries';
export type {
  DetachedRuntimeRecordingAdapter,
} from './recording-queries';
export type {
  PersistenceQueryDeps,
} from './query-deps';

export const createPersistenceQueries = (deps: PersistenceQueryDeps) => {
  const entityQueries = createPersistenceEntityQueries(deps);
  const historyQueries = createPersistenceHistoryQueries(deps);
  const recordingQueries = createPersistenceRecordingQueries(
    deps,
    entityQueries,
    historyQueries,
  );
  return {
    ...entityQueries,
    ...historyQueries,
    ...recordingQueries,
  };
};
