export type DebtStatus = 'open' | 'paid' | 'forgiven';

export type DebtEventType = 'DebtCreated' | 'DebtEnforced' | 'DebtForgiven';

export interface DebtUpdate {
  eventType: DebtEventType;
  blockNumber: number;
  transactionHash: string;
  amountDelta: bigint;
  remainingAmount: bigint;
}

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
  forgivenAmount: bigint;
  createdDebtIndex: number;
  currentDebtIndex?: number | null;
  status: DebtStatus;
  createdAtBlock: number;
  createdTxHash: string;
  lastUpdatedBlock: number;
  lastUpdatedTxHash: string;
  lastEventType: DebtEventType;
  updates: DebtUpdate[];
}
