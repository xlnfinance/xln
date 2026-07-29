import { cloneAccountState } from '../account/state-clone';
import type { AccountState } from '../types';
import { EntityCandidateMap } from './candidate-map';

/**
 * Account iteration is mutation-capable by convention, so it clones values.
 * This protects older reducers that mutate nested Maps inside `for..of`.
 */
export class EntityAccountCandidateMap
  extends EntityCandidateMap<string, AccountState> {
  constructor(base: Map<string, AccountState>) {
    super(base, cloneAccountState, true);
  }
}

export const createEntityAccountCandidateMap = (
  accounts: Map<string, AccountState>,
): EntityAccountCandidateMap => new EntityAccountCandidateMap(accounts);

export const snapshotEntityAccountMap = (
  accounts: Map<string, AccountState>,
): Map<string, AccountState> =>
  accounts instanceof EntityAccountCandidateMap
    ? accounts.snapshot()
    : accounts;

export const commitEntityAccountCandidate = (
  accounts: Map<string, AccountState>,
): Map<string, AccountState> =>
  accounts instanceof EntityAccountCandidateMap
    ? accounts.commit()
    : accounts;
