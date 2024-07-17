import User from '../app/User';
import ChannelState from './ChannelState';
import BlockMessage from './Messages/BlockMessage';
import { Subchannel } from './Subсhannel';
import Transition from './Transition';

export default interface IChannel {
  storage: any;

  push(transition: Transition): void;

  flush(): Promise<void>;

  getState(): ChannelState;

  load(): Promise<void>;

  receive(message: BlockMessage): Promise<void>;

  getSubсhannel(chainId: number): Subchannel | undefined;

  createSubсhannel(chainId: number): Subchannel;

  isLeft(): boolean;
}
