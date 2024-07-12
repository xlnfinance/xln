import Block from './Block';
import Transition from './Transition';

export default interface ChannelPrivateState {
  mempool: Transition[];
  isLeft: boolean;
  sentTransitions: number;
  pendingBlock: Block | null;
  pendingSignatures: Array<string>;
  rollbacks: number;
}
