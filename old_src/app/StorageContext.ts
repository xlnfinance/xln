import { Level } from 'level';
import ChannelStorage from './ChannelStorage';
import IStorageContext from '../types/IStorageContext';
import ENV from '../env';

import {exec} from 'child_process'

export default class StorageContext implements IStorageContext {
  public _db!: Level<string, Buffer>;

  initialize(userId: string): Promise<void> {
    if (!ENV.db[userId]) {
      exec('mkdir -p local-storage/' + userId);
      ENV.db[userId] = new Level<string, Buffer>(`local-storage/${userId}`, { valueEncoding: 'binary' });
      ENV.db[userId].open();
    }
    this._db = ENV.db[userId];
    
    return Promise.resolve();
  }

  getChannelStorage(channelId: string) {
    if (this._db === undefined) {
      throw new Error('StorageContext not initialized');
    }
    return new ChannelStorage(channelId, this._db);
  }
}
