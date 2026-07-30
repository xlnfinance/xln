import { cloneAccountState } from '../account/state-clone';
import type { AccountReplica } from '../types/account';
import { EntityCandidateMap } from './candidate-map';

/**
 * Account iteration is mutation-capable by convention, so it clones values.
 * This protects older reducers that mutate nested Maps inside `for..of`.
 */
export class EntityAccountCandidateMap
  extends EntityCandidateMap<string, AccountReplica> {
  constructor(base: Map<string, AccountReplica>) {
    super(base, cloneAccountState, true);
  }

  /**
   * Canonical state-root projection is pure and must not turn every untouched
   * Account into a mutable candidate. Do not use this iterator in reducers:
   * untouched values still belong to the certified base State.
   */
  entriesForConsensusCommitment(): MapIterator<[string, AccountReplica]> {
    return this.visibleEntriesWithoutCloning();
  }
}

export const createEntityAccountCandidateMap = (
  accounts: Map<string, AccountReplica>,
): EntityAccountCandidateMap => new EntityAccountCandidateMap(accounts);

export const snapshotEntityAccountMap = (
  accounts: Map<string, AccountReplica>,
): Map<string, AccountReplica> =>
  accounts instanceof EntityAccountCandidateMap
    ? accounts.snapshot()
    : accounts;

export const commitEntityAccountCandidate = (
  accounts: Map<string, AccountReplica>,
): Map<string, AccountReplica> =>
  accounts instanceof EntityAccountCandidateMap
    ? accounts.commit()
    : accounts;

export const entityAccountCommitmentEntries = (
  accounts: Map<string, AccountReplica>,
): MapIterator<[string, AccountReplica]> =>
  accounts instanceof EntityAccountCandidateMap
    ? accounts.entriesForConsensusCommitment()
    : accounts.entries();
