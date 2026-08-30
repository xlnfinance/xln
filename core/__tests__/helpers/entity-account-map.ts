import { computeEntityAccountValueHash } from '../../entity/consensus/state-root';
import { PersistentEntityAccountMap } from '../../entity/state/persistent-account-map';
import type { EntityState } from '../../entity/types';

export const emptyEntityAccountMap = (entityId: string): PersistentEntityAccountMap =>
  PersistentEntityAccountMap.empty(entityId, computeEntityAccountValueHash);

export const cloneEntityState = (state: EntityState): EntityState => ({
  ...structuredClone(state),
  // PersistentEntityAccountMap is immutable. structuredClone would erase its
  // class methods, so test replicas safely share the committed radix root.
  accounts: state.accounts,
});
