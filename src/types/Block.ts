import Transition from './Transition';

export default interface Block {
  isLeft: boolean;

  previousState: any;
  
  previousBlockHash: string; // hash of previous block
  previousStateHash: string;

  transitions: Transition.Any[];

  blockNumber: number;
  timestamp: number;
}
