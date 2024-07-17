import { Level } from 'level';
import ChannelStorage from './ChannelStorage';
import IStorageContext from '../types/IStorageContext';

export default class StorageContext implements IStorageContext {
  public _db!: Level<string, Buffer>;

  initialize(userId: string): Promise<void> {
    this._db = new Level<string, Buffer>(`local-storage/${userId}`, { valueEncoding: 'binary' });
    return this._db.open();
  }

  getChannelStorage(channelId: string) {
    return new ChannelStorage(channelId, this._db);
  }
}
