import IChannelStorage from './IChannelStorage';
import User from '../app/User';

export default interface IChannelContext {
  user: User;
  getUserAddress(): string;
  getRecipientAddress(): string;

  getStorage(otherUserAddress: string): IChannelStorage;
  signMessage(message: string): Promise<string>;
  verifyMessage(message: string, signature: string, senderAddress: string): Promise<boolean>;
}
