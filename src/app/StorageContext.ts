import { Level } from 'level';
import ChannelStorage from './ChannelStorage';
import IStorageContext from '../types/IStorageContext';

import {exec} from 'child_process'

export default class StorageContext implements IStorageContext {
  public _db!: Level<string, Buffer>;

  initialize(userId: string): Promise<void> {
    exec(`rm -rf local-storage/${userId}`)

    this._db = new Level<string, Buffer>(`local-storage/${userId}`, { valueEncoding: 'binary' });
    return this._db.open();
  }

  getChannelStorage(channelId: string) {
    return new ChannelStorage(channelId, this._db);
  }
}
