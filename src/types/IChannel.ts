import User from '../app/User';
import ChannelState from './ChannelState';
import FlushMessage from './Messages/FlushMessage';
import { Subchannel, Delta } from './Subchannel';
import Transition from '../app/Transition';

export default interface IChannel {
  storage: any;

  push(transition: Transition.Any): void;

  flush(): Promise<void>;

  getState(): ChannelState;

  load(): Promise<void>;

  receive(message: FlushMessage): Promise<void>;

  getSubchannelProofs(): any;

  getSubchannel(chainId: number): Subchannel | undefined;

  getDelta(chainId: number, tokenId: number): Delta | undefined;

  addSubchannel(chainId: number): Subchannel;

  isLeft(): boolean;
}
