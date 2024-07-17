import Block from './Block';
import { Subchannel } from './Subchannel';
import Transition from './Transition';
import { DepositoryEvent } from './Transitions/ProposedEventTransition';

export default interface ChannelData {
  mempool: Transition[];
  isLeft: boolean;
  sentTransitions: number;
  pendingBlock: Block | null;
  pendingSignatures: Array<string>;
  rollbacks: number;
  pendingEvents: Array<DepositoryEvent>;
}
