import Block from './Block';
import { Subchannel } from './SubChannel';
import Transition from './Transition';
import { DepositoryEvent } from './Transitions/ProposedEventTransition';

export default interface ChannelPrivateState {
  mempool: Transition[];
  isLeft: boolean;
  sentTransitions: number;
  pendingBlock: Block | null;
  pendingSignatures: Array<string>;
  rollbacks: number;
  pendingEvents: Array<DepositoryEvent>;
}
