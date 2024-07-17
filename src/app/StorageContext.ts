import { Level } from 'level';
import ChannelStorage from '../common/ChannelStorage';
import IStorageContext from '../types/IStorageContext';

export default class StorageContext implements IStorageContext {
  public _db!: Level;

  initialize(userId: string): Promise<void> {
    this._db = new Level(`local-storage/${userId}`, { valueEncoding: 'binary' });
    return this._db.open();
  }

  getChannelStorage(channelId: string) {
    return new ChannelStorage(channelId, this._db);
  }
}
