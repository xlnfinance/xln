import Transition from '../app/Transition';

export default interface Block {
  isLeft: boolean;
  
  previousBlockHash: string; // hash of previous block
  previousStateHash: string;

  transitions: Transition.Any[];

  blockId: number;
  timestamp: number;
}
