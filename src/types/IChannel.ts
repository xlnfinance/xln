import ISubChannel from './ISubChannel';
import BlockMessage from './Messages/BlockMessage';

export default interface IChannel {
  initialize(): Promise<void>;

  openSubChannel(otherUserAddress: string, tokenId: number): Promise<ISubChannel>;

  receive(message: BlockMessage): Promise<void>;
}
