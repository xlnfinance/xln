import type { AccountTx, EntityInput, EntityState, HashToSign } from '../../types';

export type JEventMempoolOp = {
  accountId: string;
  tx: AccountTx;
};

export type JEventApplyResult = {
  newState: EntityState;
  mempoolOps: JEventMempoolOp[];
  outputs: EntityInput[];
  dirtyAccounts: string[];
  hashesToSign?: HashToSign[];
};

export type JEventClaimTx = Extract<AccountTx, { type: 'j_event_claim' }>;
