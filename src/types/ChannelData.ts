import Block from './Block';
import { Subchannel } from './Subchannel';
import Transition from './Transition';


export default interface ChannelData {
  mempool: Transition.Any[];
  isLeft: boolean;
  sentTransitions: number;
  pendingBlock: Block | null;
  pendingSignatures: Array<string>;
  rollbacks: number;

}
