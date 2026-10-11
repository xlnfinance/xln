import type {
  EntityReplica,
  EntityState,
  RuntimeAdapterViewFrame,
} from '@xln/core/api/public/runtime-module';

type AccountDoc = NonNullable<RuntimeAdapterViewFrame['activeEntity']>['accounts']['items'][number];
type ReadMap<T> = T extends ReadonlyMap<infer Key, infer Value> ? ReadonlyMap<Key, Value> : T;
type ReadMapFields<T> = { [Key in keyof T]: ReadMap<T[Key]> };

/** A compact display page carries lifecycle metadata, never full dispute arguments. */
export type AccountReadView = Omit<AccountDoc, 'state' | 'mempoolCount' | 'pendingWithdrawals' | 'shadow' | 'lendingRisk'> & {
  state: ReadMapFields<AccountDoc['state']>;
  mempoolCount?: number;
  pendingWithdrawals: ReadMap<AccountDoc['pendingWithdrawals']>;
  shadow: {
    rebalance: ReadMapFields<AccountDoc['shadow']['rebalance']>;
  };
};

export type EntityReadState = Omit<EntityState, 'accounts'> & {
  accounts: ReadonlyMap<string, AccountReadView>;
};

/** Live replicas satisfy this read surface; a projected page is not a live replica. */
export type EntityReadView = Omit<EntityReplica, 'state' | 'mempool'> & {
  state: EntityReadState;
  mempool?: EntityReplica['mempool'];
};
