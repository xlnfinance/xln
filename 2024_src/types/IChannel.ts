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

  getSubchannelProofs(dryRun: boolean): any;

  getSubchannel(chainId: number, dryRun: boolean): Subchannel | undefined;

  getDelta(chainId: number, tokenId: number, dryRun: boolean): Delta | undefined;

  addSubchannel(chainId: number): Subchannel;

  isLeft(): boolean;
}
