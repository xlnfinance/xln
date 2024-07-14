import IChannelStorage from './IChannelStorage';
import ITransport from './ITransport';

export default interface IChannelContext {
  getUserId(): string;
  getHubAddress(): string;
  getTransport(): ITransport;
  getStorage(otherUserAddress: string): IChannelStorage;
  signMessage(message: string): Promise<string>;
  verifyMessage(message: string, signature: string, senderAddress: string): Promise<boolean>;
}
