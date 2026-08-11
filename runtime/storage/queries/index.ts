import {
  createPersistenceEntityQueries,
} from './entity';
import {
  createPersistenceHistoryQueries,
} from './history';
import {
  createPersistenceRecordingQueries,
} from './recording';
import type { PersistenceQueryDeps } from './deps';

export {
  buildRecoveryJournalFromStorageFrame,
} from './history';
export type {
} from './history';
export type {
} from './recording';
export type {
  PersistenceQueryDeps,
} from './deps';

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
