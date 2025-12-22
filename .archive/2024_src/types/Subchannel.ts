import { BigNumberish } from "ethers";
import * as Transition from '../app/Transition';

export interface Delta {
  tokenId: number;
  collateral: bigint;
  ondelta: bigint
  offdelta: bigint;
  leftCreditLimit: bigint;
  rightCreditLimit: bigint;
  leftAllowance: bigint;
  rightAllowance: bigint;
}

export interface ProposedEventData {
  type: string;
  chainId: number;
  tokenId: number;
  collateral: bigint;
  ondelta: bigint;
}

export interface Subchannel {
  chainId: number;
  tokenId: number;
  leftCreditLimit: bigint;
  rightCreditLimit: bigint;
  leftAllowance: bigint;
  rightAllowance: bigint;
  collateral: bigint;
  ondelta: bigint;
  offdelta: bigint;
  deltas: Delta[];
  cooperativeNonce: number;
  disputeNonce: number;
  proposedEvents: ProposedEventData[];
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
    leftAllowance: 0n,
    rightAllowance: 0n
  };

  const subchannel: Subchannel = {
    chainId: chainId,
    tokenId: tokenId,
    leftCreditLimit: 0n,
    rightCreditLimit: 0n,
    leftAllowance: 0n,
    rightAllowance: 0n,
    collateral: 0n,
    ondelta: 0n,
    offdelta: 0n,
    deltas: [delta],
    cooperativeNonce: 0,
    disputeNonce: 0,
    proposedEvents: [],
    proposedEventsByLeft: false
  };

  return subchannel;
}