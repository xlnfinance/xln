import Block from './Block';
import { Subchannel } from './Subchannel';
import Transition from '../app/Transition';


export default interface ChannelData {
  isLeft: boolean;
  sentTransitions: number;
  pendingBlock: Block | null;
  pendingSignatures: Array<string>;
  rollbacks: number;

  sendCounter: number;
  receiveCounter: number;
}
