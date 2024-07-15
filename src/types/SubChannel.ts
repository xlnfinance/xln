export interface TokenDelta {
  tokenId: number;
  collateral: bigint;
  ondelta: bigint;
  offdelta: bigint;
  leftCreditLimit: bigint;
  rightCreditLimit: bigint;
}

export interface Payment {
  amount: bigint;
  hash: string;
  revealedUntilBlock: bigint;
}

export interface Subcontract {
  payment: Payment[];
  swap: [];
}

export interface Subchannel {
  chainId: number;
  deltas: TokenDelta[];
  cooperativeNonce: number;
  disputeNonce: number;
  subcontracts: Subcontract[];
}

export function createSubchannelData(chainId: number, tokenId: number): Subchannel {
  const delta: TokenDelta = {
    tokenId: tokenId,
    collateral: 0n,
    ondelta: 0n,
    offdelta: 0n,
    leftCreditLimit: 0n,
    rightCreditLimit: 0n,
  };

  const subchannel: Subchannel = {
    chainId: chainId,
    deltas: [delta],
    cooperativeNonce: 0,
    disputeNonce: 0,
    subcontracts: [],
  };

  return subchannel;
}