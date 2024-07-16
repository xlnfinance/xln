import { StoragePoint } from './StoragePoint';

export default interface IChannelStorage {
  db: any;

  put(point: StoragePoint): Promise<void>;

  getLast(): Promise<StoragePoint | undefined>;

  getValue<T>(key: string): Promise<T>;

  setValue<T>(key: string, value: T): Promise<void>;
}
