import { BigNumberish } from "ethers";
import Transition, { createTransition, AnyTransition } from './Transition';

export type MoneyValue = bigint;

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

  proposedEvents: AnyTransition[];
  proposedEventsByLeft: boolean;
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

    proposedEvents: [],
    proposedEventsByLeft: false
  };

  return subchannel;
}