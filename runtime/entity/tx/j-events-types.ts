import type { AccountTx, EntityInput, EntityState, HashToSign } from '../../types';

export type JEventAccountTx = {
  accountId: string;
  tx: AccountTx;
};

export type JEventApplyResult = {
  newState: EntityState;
  accountTxs: JEventAccountTx[];
  outputs: EntityInput[];
  dirtyAccounts: string[];
  hashesToSign?: HashToSign[];
};

export type JEventClaimTx = Extract<AccountTx, { type: 'j_event_claim' }>;
