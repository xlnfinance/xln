import IChannelContext from '../types/IChannelContext';
import IChannelStorage from '../types/IChannelStorage';
import ITransport from '../types/ITransport';
import IUserContext from '../types/IUserContext';

export default class ChannelContext implements IChannelContext {
  private storages: Map<string, IChannelStorage>;

  constructor(
    private userCtx: IUserContext,
    private recipientUserId: string,
    private transport: ITransport,
  ) {
    this.storages = new Map();
  }

  getUserId(): string {
    return this.userCtx.getAddress();
  }

  getRecipientUserId(): string {
    return this.recipientUserId;
  }

  getTransport(): ITransport {
    return this.transport;
  }

  getStorage(otherUserAddress: string): IChannelStorage {
    const channelId = `${this.userCtx.getAddress()}:${otherUserAddress}`;
    let storage = this.storages.get(channelId);
    if (!storage) {
      storage = this.userCtx.getStorageContext().getChannelStorage(channelId);
      this.storages.set(channelId, storage);
    }
    return storage;
  }

  signMessage(message: string): Promise<string> {
    return this.userCtx.signMessage(message);
  }

  async verifyMessage(message: string, signature: string, senderAddress: string): Promise<boolean> {
    // TODO DEBUG CODE FOR WORK HUB CHANNEL
    if (signature === '') {
      return true;
    }
    return await this.userCtx.verifyMessage(message, signature, senderAddress);
  }
}
