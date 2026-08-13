export type DebtEnforceRequest = {
  tokenId: number;
  symbol: string;
  maxIterations: number;
  openCount: number;
  outstandingAmount: bigint;
  reserveAmount: bigint;
  payableAmount: bigint;
  nextDebtIndex: number | null;
};
