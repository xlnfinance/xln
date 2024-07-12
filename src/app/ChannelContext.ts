import IChannelContext from '../types/IChannelContext';
import IChannelStorage from '../types/IChannelStorage';
import ITransport from '../types/ITransport';
import IUserContext from '../types/IUserContext';

export default class ChannelContext implements IChannelContext {
  private storage: IChannelStorage;

  constructor(
    private userCtx: IUserContext,
    private recipientUserId: string,
    private transport: ITransport,
  ) {
    this.storage = this.userCtx.getStorageContext().getChannelStorage(this.makeChannelId());
  }

  private makeChannelId() {
    return `${this.userCtx.getAddress()}:${this.recipientUserId}`;
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

  getStorage(): IChannelStorage {
    return this.storage;
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
