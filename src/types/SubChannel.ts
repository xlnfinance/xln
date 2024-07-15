import { BigNumberish } from "ethers";

export type MoneyValue = number;

export interface TokenDelta {
  tokenId: number;
  collateral: MoneyValue;
  ondelta: MoneyValue;
  offdelta: MoneyValue;
  leftCreditLimit: MoneyValue;
  rightCreditLimit: MoneyValue;
}

export interface Payment {
  amount: MoneyValue;
  hash: string;
  revealedUntilBlock: number;
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
    collateral: 0,
    ondelta: 0,
    offdelta: 0,
    leftCreditLimit: 0,
    rightCreditLimit: 0,
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