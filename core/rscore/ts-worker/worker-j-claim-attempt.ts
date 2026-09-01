import {
  collectReachableAccountJClaimNodes,
  hashAccountJClaimNode,
} from '../../account/j-claims/j-claim-accumulator';
import type { AccountReplica } from '../../types/account';
import type {
  AccountJClaimNode,
  AccountJClaimNodeChanges,
  AccountJClaimNodeStore,
} from '../../types/finance/account-j-claims';

export type WorkerJClaimAttempt = Readonly<{
  store: AccountJClaimNodeStore;
  absorb(changes: AccountJClaimNodeChanges | undefined): void;
  publish(): boolean;
}>;

/**
 * Later transitions in one worker attempt must see prior nodes. Replaced nodes
 * stay readable because only the committed Runtime forest can prove that a
 * content-addressed node is globally unreachable and safe to delete.
 */
export const createWorkerJClaimAttempt = (
  committed: Map<string, AccountJClaimNode>,
): WorkerJClaimAttempt => {
  const additions = new Map<string, AccountJClaimNode>();
  let changed = false;
  return {
    store: { get: hash => additions.get(hash) ?? committed.get(hash) },
    absorb(changes): void {
      if (changes && (changes.newNodes.length > 0 || changes.replacedNodeHashes.length > 0)) {
        changed = true;
      }
      for (const { hash, node } of changes?.newNodes ?? []) {
        const actual = hashAccountJClaimNode(node);
        if (actual !== hash) throw new Error(`TS_ACCOUNT_WORKER_JCLAIM_DELTA_CORRUPT:${hash}:${actual}`);
        additions.set(hash, node);
      }
    },
    publish(): boolean {
      for (const [hash, node] of additions) committed.set(hash, node);
      return changed;
    },
  };
};

/**
 * This cache is isolate-local, so its reachability authority is exactly the
 * Account roots resident in that isolate. Include rollback bases until the
 * candidate is superseded; pruning against only the new candidate would make
 * `restorePrevious` unable to traverse its old roots.
 */
export const pruneWorkerJClaimNodes = (
  store: Map<string, AccountJClaimNode>,
  accountSets: readonly Iterable<AccountReplica>[],
): void => {
  const states = accountSets.flatMap(accounts => [...accounts].flatMap(account => [
    account.state.leftPendingJClaims,
    account.state.rightPendingJClaims,
  ]));
  const reachable = collectReachableAccountJClaimNodes(store, states);
  store.clear();
  for (const [hash, node] of reachable) store.set(hash, node);
};
