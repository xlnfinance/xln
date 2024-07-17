import IChannelStorage from './IChannelStorage';


export default interface IChannelContext {
  user: any;
  getUserAddress(): string;
  getRecipientAddress(): string;

  getStorage(otherUserAddress: string): IChannelStorage;
  signMessage(message: string): Promise<string>;
  verifyMessage(message: string, signature: string, senderAddress: string): Promise<boolean>;
}
