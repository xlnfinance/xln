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
