import ChannelState from './ChannelState';
import BlockMessage from './Messages/BlockMessage';
import { Subchannel } from './SubChannel';
import Transition from './Transition';

export default interface IChannel {
  push(transition: Transition): Promise<void>;

  send(): Promise<void>;

  getState(): ChannelState;

  initialize(): Promise<void>;

  receive(message: BlockMessage): Promise<void>;

  getSubсhannel(tokenId: number): Promise<Subchannel | undefined>;

  createSubсhannel(chainId: number): Promise<Subchannel>;
}
