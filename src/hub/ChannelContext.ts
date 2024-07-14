/* eslint-disable @typescript-eslint/no-unused-vars */
import { Signer, verifyMessage as ethersVerifyMessage } from 'ethers';
import IChannelContext from '../types/IChannelContext';
import IChannelStorage from '../types/IChannelStorage';
import ITransport from '../types/ITransport';

export default class ChannelContext implements IChannelContext {
  constructor(
    private userId: string,
    private recipientUserId: string,
    private transport: ITransport,
    private storage: IChannelStorage,
    private signer: Signer,
  ) {}

  getUserId(): string {
    return this.userId;
  }

  getHubAddress(): string {
    return this.recipientUserId;
  }

  getTransport(): ITransport {
    return this.transport;
  }

  getStorage(): IChannelStorage {
    return this.storage;
  }

  async signMessage(message: string): Promise<string> {
    return this.signer.signMessage(message);
  }

  async verifyMessage(message: string, signature: string, senderAddress: string): Promise<boolean> {
    return ethersVerifyMessage(message, signature) === senderAddress;
  }
}
