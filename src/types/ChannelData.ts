import Block from './Block';
import { Subchannel } from './Subchannel';
import Transition, { createTransition, AnyTransition }from './Transition';


export default interface ChannelData {
  mempool: AnyTransition[];
  isLeft: boolean;
  sentTransitions: number;
  pendingBlock: Block | null;
  pendingSignatures: Array<string>;
  rollbacks: number;

}
