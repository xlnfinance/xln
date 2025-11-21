import IChannelStorage from './IChannelStorage';

export default interface IStorageContext {
  _db: any;

  initialize(userId: string): Promise<void>;

  getChannelStorage(channelId: string): IChannelStorage;
}
