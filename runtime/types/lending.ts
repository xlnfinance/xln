export type LendingTermId = '1h' | '1d' | '1m';

export type LendingPoolStatus = 'open' | 'closed';
export type LendingLoanStatus = 'active' | 'repaid';

export interface LendingPoolPosition {
  positionId: string;
  hubEntityId: string;
  lenderEntityId: string;
  tokenId: number;
  principalAmount: bigint;
  availableAmount: bigint;
  borrowedAmount: bigint;
  interestBps: number;
  termId: LendingTermId;
  termMs: number;
  createdAt: number;
  updatedAt: number;
  status: LendingPoolStatus;
}

export interface LendingLoan {
  loanId: string;
  hubEntityId: string;
  borrowerEntityId: string;
  lenderEntityId: string;
  positionId: string;
  tokenId: number;
  principalAmount: bigint;
  interestAmount: bigint;
  repaymentAmount: bigint;
  repaidAmount: bigint;
  interestBps: number;
  termId: LendingTermId;
  termMs: number;
  openedAt: number;
  dueAt: number;
  updatedAt: number;
  status: LendingLoanStatus;
}

export interface LendingState {
  pools: Map<string, LendingPoolPosition>;
  loans: Map<string, LendingLoan>;
}
