import IChannelStorage from './IChannelStorage';

export default interface IStorageContext {
  initialize(userId: string): Promise<void>;

  getChannelStorage(channelId: string): IChannelStorage;
}
