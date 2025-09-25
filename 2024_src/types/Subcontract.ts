export interface StoredSubcontract {
  chainId: number;
  tokenId: number;
  contractAddress: string;
  leftDeposit: bigint;
  rightDeposit: bigint;
  leftWithdraw: bigint;
  rightWithdraw: bigint;
  status: 'active' | 'closing' | 'closed';
} 