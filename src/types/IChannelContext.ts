import IChannelStorage from './IChannelStorage';
import ITransport from './ITransport';

export default interface IChannelContext {
  getUserId(): string;
  getRecipientUserId(): string;
  getTransport(): ITransport;
  getStorage(): IChannelStorage;

  signMessage(message: string): Promise<string>;
  verifyMessage(message: string, signature: string, senderAddress: string): Promise<boolean>;
}
