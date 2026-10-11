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
type LendingSavingsStatus = 'open' | 'closing' | 'closed' | 'disputed';
/**
 * `defaulted` remains repayable. Changing a receivable's status never changes
 * the bank's independent savings liabilities or creates payment capacity.
 */
type LendingLoanStatus = 'opening' | 'active' | 'closing' | 'repaid' | 'defaulted' | 'disputed';

export interface LendingSavings {
  positionId: string;
  hubEntityId: string;
  lenderEntityId: string;
  tokenId: number;
  principalAmount: bigint;
  interestBps: number;
  termId: LendingTermId;
  termMs: number;
  createdAt: number;
  updatedAt: number;
  status: LendingSavingsStatus;
}

export interface LendingLoan {
  requestId: string;
  loanId: string;
  hubEntityId: string;
  borrowerEntityId: string;
  tokenId: number;
  /** Remaining principal; historical draws live in their signed Account frames. */
  principalAmount: bigint;
  accruedAt: number;
  accruedInterest: bigint;
  interestRemainder: bigint;
  /** Paid amount plus current outstanding quote; final paid amount once repaid. */
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
  savings: Map<string, LendingSavings>;
  loans: Map<string, LendingLoan>;
  /** Absence means the bank has authorized no new business. */
  terms?: Map<string, LendingBankTerms>;
  facilities?: Map<string, LendingFacility>;
}
