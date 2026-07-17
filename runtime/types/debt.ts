export type DebtStatus = 'open' | 'paid' | 'forgiven';

export type DebtEventType = 'DebtCreated' | 'DebtEnforced' | 'DebtForgiven';

/** One active on-chain obligation. Terminal history lives in the bounded Runtime activity WAL. */
export interface DebtEntry {
  debtId: string;
  tokenId: number;
  debtor: string;
  creditor: string;
  counterparty: string;
  direction: 'out' | 'in';
  createdAmount: bigint;
  paidAmount: bigint;
  remainingAmount: bigint;
  createdDebtIndex: number;
  currentDebtIndex: number;
  status: 'open';
  createdAtBlock: number;
  createdTxHash: string;
  lastUpdatedBlock: number;
  lastUpdatedTxHash: string;
  lastEventType: DebtEventType;
}
