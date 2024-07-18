import User from '../app/User';
import ChannelState from './ChannelState';
import FlushMessage from './Messages/FlushMessage';
import { Subchannel } from './Subchannel';
import Transition from './Transition';

export default interface IChannel {
  storage: any;

  push(transition: Transition.Any): void;

  flush(): Promise<void>;

  getState(): ChannelState;

  load(): Promise<void>;

  receive(message: FlushMessage): Promise<void>;

  getSubchannelProofs(): any;

  getSubchannel(chainId: number): Subchannel | undefined;

  addSubchannel(chainId: number): Subchannel;

  isLeft(): boolean;
}
