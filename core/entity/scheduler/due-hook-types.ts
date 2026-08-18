import type { EntityInput } from '../types';

export type DueHookPlan = {
  outputs: EntityInput[];
  htlcTimeoutLocks: Array<{ accountId: string; lockId: string }>;
  disputePrepareCounterparties: Map<string, string>;
  disputeFinalizeCounterparties: Set<string>;
  shouldBroadcastQueuedDisputeFinalizations: boolean;
};

export const createDueHookPlan = (): DueHookPlan => ({
  outputs: [],
  htlcTimeoutLocks: [],
  disputePrepareCounterparties: new Map(),
  disputeFinalizeCounterparties: new Set(),
  shouldBroadcastQueuedDisputeFinalizations: false,
});
