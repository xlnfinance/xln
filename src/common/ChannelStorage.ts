import { Level } from 'level';
import { StoragePoint } from '../types/StoragePoint';
import IChannelStorage from '../types/IChannelStorage';
import { decode, encode } from '../utils/Codec';


export default class ChannelStorage implements IChannelStorage {
  constructor(
    private channelId: string,
    public db: Level,
  ) {
  }

  async put(point: StoragePoint): Promise<void> {
    const storeAt = `${this.channelId}:${this.zeroPad(point.state.blockNumber)}`;
    
    return this.db.put(storeAt, encode(point).toString());
  }

  async getLast(): Promise<StoragePoint | undefined> {
    for await (const [key, value] of this.db.iterator({
      gte: `${this.channelId}:${this.zeroPad(0)}`,
      lte: `${this.channelId}:${this.zeroPad(Number.MAX_SAFE_INTEGER)}`,
      reverse: true, // Read in reverse order
      limit: 1,
    })) {
      const str = decode(Buffer.from(value)) as StoragePoint;
      console.log("Storage point ",str);
      return str;
    }
  }

  async getValue<T>(key: string): Promise<T> {
    const pathKey = `${this.channelId}-${key}`;
    const res = (await this.db.get(pathKey) as unknown) as Buffer;

    console.log("resdec:"+key, res);

    const decoded = decode(res) as T
    console.log(decoded)
    return decoded;
  }

  setValue<T>(key: string, value: T): Promise<void> {
    const pathKey = `${this.channelId}-${key}`;
    return this.db.put(pathKey, encode(value) as any);
  }

  private zeroPad(num: number): string {
    return String(num).padStart(10, '0');
  }
}
