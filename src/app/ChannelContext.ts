import IChannelContext from '../types/IChannelContext';
import IChannelStorage from '../types/IChannelStorage';

import User from './User';

export default class ChannelContext implements IChannelContext {
  private storages: Map<string, IChannelStorage>;

  constructor(
    public user: User,
    public recipientUserId: string
  ) {
    this.storages = new Map();
  }

  getUserAddress(): string {
    return this.user.thisUserAddress;
  }

  getRecipientAddress(): string {
    return this.recipientUserId;
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
