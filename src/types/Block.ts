import Transition from './Transition';

export default interface Block {
  isLeft: boolean;

  previousBlockHash: string; // hash of previous block
  previousStateHash: string;

  transitions: Transition[];

  blockNumber: number;
  timestamp: number;
}