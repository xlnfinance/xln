import IChannelContext from '../types/IChannelContext';
import IChannelStorage from '../types/IChannelStorage';
import ITransport from '../types/ITransport';
import User from './User';

export default class ChannelContext implements IChannelContext {
  private storages: Map<string, IChannelStorage>;

  constructor(
    private user: User,
    private recipientUserId: string,
    private transport: ITransport,
  ) {
    this.storages = new Map();
  }

  getUserId(): string {
    return this.user.thisUserAddress;
  }

  getHubAddress(): string {
    return this.recipientUserId;
  }

  getTransport(): ITransport {
    return this.transport;
  }

  getStorage(otherUserAddress: string): IChannelStorage {
    const channelId = `${this.user.thisUserAddress}:${otherUserAddress}`;
    let storage = this.storages.get(channelId);
    if (!storage) {
      storage = this.user.storageContext.getChannelStorage(channelId);
      this.storages.set(channelId, storage);
    }
    return storage;
  }

  signMessage(message: string): Promise<string> {
    return this.user.signMessage(message);
  }

  async verifyMessage(message: string, signature: string, senderAddress: string): Promise<boolean> {
    // TODO DEBUG CODE FOR WORK HUB CHANNEL
    if (signature === '') {
      return true;
    }
    return await this.user.verifyMessage(message, signature, senderAddress);
  }
}
