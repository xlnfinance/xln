import { Level } from 'level';
import { StoragePoint } from '../types/StoragePoint';
import IChannelStorage from '../types/IChannelStorage';
import { decode, encode } from '../utils/Codec';


export default class ChannelStorage implements IChannelStorage {
  constructor(
    private channelId: string,
    public db: Level<string, Buffer>,
  ) {
  }

  async put(point: StoragePoint): Promise<void> {
    const storeAt = `${this.channelId}:${this.zeroPad(point.state.blockId)}`;
    
    return this.db.put(storeAt, encode(point));
  }

  async getLast(): Promise<StoragePoint | undefined> {
    for await (const [key, value] of this.db.iterator({
      gte: `${this.channelId}:${this.zeroPad(0)}`,
      lte: `${this.channelId}:${this.zeroPad(Number.MAX_SAFE_INTEGER)}`,
      reverse: true, // Read in reverse order
      limit: 1,
    })) {
      return decode(value) as StoragePoint;;
    }
  }

  async getValue<T>(key: string): Promise<T> {
    const pathKey = `${this.channelId}-${key}`;
    const res = await this.db.get(pathKey);

    return decode(res) as T;
  }

  setValue<T>(key: string, value: T): Promise<void> {
    const pathKey = `${this.channelId}-${key}`;
    return this.db.put(pathKey, encode(value));
  }

  private zeroPad(num: number): string {
    return String(num).padStart(10, '0');
  }
}
