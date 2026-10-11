export type LendingTermId = '1h' | '1d' | '1m';

/** Bank-owned pricing; the Account domain prevents reuse on another deployment. */
export type LendingBankTerms = Readonly<{
  chainId: number;
  depositoryAddress: string;
  tokenId: number;
  termId: LendingTermId;
  savingsInterestBps: number;
  loanInterestBps: number;
  loanLateMs: number;
  expiresAt: number;
}>;

/** Funding permission is separate from the Account's maximum unsecured risk. */
export type LendingFacility = Readonly<{
  borrowerEntityId: string;
  chainId: number;
  depositoryAddress: string;
  jNonce: number;
  tokenId: number;
  termId: LendingTermId;
  maxPrincipal: bigint;
  expiresAt: number;
}>;

/** `disputed` retires the Account claim; it does not assert full cash recovery. */
type LendingPoolStatus = 'open' | 'closing' | 'closed' | 'disputed';
/**
 * `defaulted` remains repayable: the term passed without repayment and the hub
 * released the depositor claim. The signed clock determines the bank's current
 * claim against the borrower; recovery must not credit the depositor twice.
 */
type LendingLoanStatus = 'opening' | 'active' | 'closing' | 'repaid' | 'defaulted' | 'disputed';

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
  requestId: string;
  loanId: string;
  hubEntityId: string;
  borrowerEntityId: string;
  lenderEntityId: string;
  positionId: string;
  tokenId: number;
  principalAmount: bigint;
  interestAmount: bigint;
  /** Term amount while live; actual settled amount once repaid. Views quote the signed clock. */
  repaymentAmount: bigint;
  repaidAmount: bigint;
  interestBps: number;
  termId: LendingTermId;
  termMs: number;
  openedAt: number;
  lateMs: number;
  dueAt: number;
  updatedAt: number;
  status: LendingLoanStatus;
  /** Exact bank approval at origination; changing a facility cannot rewrite it. */
  approval?: LendingFacility;
}

export interface LendingState {
  pools: Map<string, LendingPoolPosition>;
  loans: Map<string, LendingLoan>;
  /** Absence means the bank has authorized no new business. */
  terms?: Map<string, LendingBankTerms>;
  facilities?: Map<string, LendingFacility>;
}
