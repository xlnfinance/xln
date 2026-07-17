import type { Env } from '../types';
import type {
  AccountJClaimMutationResult,
  AccountJClaimNode,
  AccountJClaimNodeChanges,
  AccountJClaimNodeStore,
} from '../types/account-j-claims';
import { getAccountJClaimNodeStore } from './j-claim-store';

export type AccountJClaimSession = {
  readonly store: AccountJClaimNodeStore;
  absorb(result: Pick<AccountJClaimMutationResult, 'newNodes' | 'replacedNodeHashes'>): void;
  changes(): AccountJClaimNodeChanges | undefined;
};

export const createAccountJClaimSession = (
  env: Env,
  base: AccountJClaimNodeStore = getAccountJClaimNodeStore(env),
): AccountJClaimSession => {
  const overlay = new Map<string, AccountJClaimNode>();
  const publishable = new Map<string, AccountJClaimNode>();
  const replaced = new Set<string>();
  return {
    store: { get: (hash) => overlay.get(hash) ?? base.get(hash) },
    absorb(result): void {
      for (const { hash, node } of result.newNodes) {
        overlay.set(hash, node);
        publishable.set(hash, node);
        replaced.delete(hash);
      }
      for (const hash of result.replacedNodeHashes) {
        if (!publishable.delete(hash)) replaced.add(hash);
      }
    },
    changes(): AccountJClaimNodeChanges | undefined {
      if (publishable.size === 0 && replaced.size === 0) return undefined;
      return Object.freeze({
        newNodes: Object.freeze([...publishable].map(([hash, node]) => Object.freeze({ hash, node }))),
        replacedNodeHashes: Object.freeze([...replaced].sort()),
      });
    },
  };
};
