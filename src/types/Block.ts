import Transition, { createTransition, AnyTransition }from './Transition';

export default interface Block {
  isLeft: boolean;

  previousState: any;
  
  previousBlockHash: string; // hash of previous block
  previousStateHash: string;

  transitions: AnyTransition[];

  blockNumber: number;
  timestamp: number;
}
