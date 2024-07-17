import User from '../app/User';
import ChannelState from './ChannelState';
import BlockMessage from './Messages/BlockMessage';
import { Subchannel } from './Subchannel';
import Transition from './Transition';

export default interface IChannel {
  storage: any;

  push(transition: Transition): void;

  flush(): Promise<void>;

  getState(): ChannelState;

  load(): Promise<void>;

  receive(message: BlockMessage): Promise<void>;

  getSubchannel(chainId: number): Subchannel | undefined;

  createSubchannel(chainId: number): Subchannel;

  isLeft(): boolean;
}
