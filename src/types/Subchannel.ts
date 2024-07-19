import { BigNumberish } from "ethers";
import Transition from '../app/Transition';


export interface Delta {
  tokenId: number;
  collateral: bigint;
  ondelta: bigint
  offdelta:bigint;
  leftCreditLimit:bigint;
  rightCreditLimit:bigint;
  leftAllowence:bigint;
  rightAllowence:bigint;
}

export interface Payment {
  amount: bigint;
  hash: string;
  revealedUntilBlock: number;
}

export interface Subcontract {
  payment: Payment[];
  swap: [];
}

export interface Subchannel {
  chainId: number;
  deltas: Delta[];
  cooperativeNonce: number;
  disputeNonce: number;
  subcontracts: Subcontract[];

  proposedEvents: Transition.ProposedEvent[];
  proposedEventsByLeft: boolean;
}

export function createSubchannelData(chainId: number, tokenId: number): Subchannel {
  const delta: Delta = {
    tokenId: tokenId,
    collateral: 0n,
    ondelta: 0n,
    offdelta: 0n,
    leftCreditLimit: 0n,
    rightCreditLimit: 0n,
    leftAllowence: 0n,
    rightAllowence: 0n
  };

  const subchannel: Subchannel = {
    chainId: chainId,
    deltas: [],
    cooperativeNonce: 0,
    disputeNonce: 0,
    subcontracts: [],

    proposedEvents: [],
    proposedEventsByLeft: false
  };

  return subchannel;
}