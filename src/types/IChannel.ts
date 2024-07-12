import ChannelState from './ChannelState';
import BlockMessage from './Messages/BlockMessage';
import Transition from './Transition';

export default interface IChannel {
  push(transition: Transition): Promise<void>;

  send(): Promise<void>;

  getState(): ChannelState;

  initialize(): Promise<void>;

  receive(message: BlockMessage): Promise<void>;
}