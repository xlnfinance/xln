import Block from './Block';
import { Subchannel } from './Subchannel';
import Transition from '../app/Transition';


export default interface ChannelData {
  mempool: Transition.Any[];
  isLeft: boolean;
  subcontracts: Map<number, any>;
  sentTransitions: number;
  pendingBlock: Block | null;
  pendingSignatures: Array<string>;
  rollbacks: number;

}
