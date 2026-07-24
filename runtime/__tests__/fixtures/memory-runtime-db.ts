import type { RuntimeDbLike } from '../../storage/types';

type MemoryOperation =
  | { kind: 'put'; key: Buffer; value: Buffer }
  | { kind: 'del'; key: Buffer };

export class MemoryRuntimeDb implements RuntimeDbLike {
  readonly rows = new Map<string, Buffer>();
  putCount = 0;
  delCount = 0;
  lastBatchOperations: Array<{ kind: 'put' | 'del'; key: string }> = [];

  async get(key: Buffer): Promise<Buffer> {
    const value = this.rows.get(key.toString('hex'));
    if (!value) {
      const error = new Error('NotFound') as Error & { code?: string };
      error.code = 'LEVEL_NOT_FOUND';
      throw error;
    }
    return Buffer.from(value);
  }

  batch() {
    const operations: MemoryOperation[] = [];
    return {
      put: (key: Buffer, value: Buffer) => operations.push({
        kind: 'put',
        key: Buffer.from(key),
        value: Buffer.from(value),
      }),
      del: (key: Buffer) => operations.push({ kind: 'del', key: Buffer.from(key) }),
      write: async () => {
        this.lastBatchOperations = operations.map(operation => ({
          kind: operation.kind,
          key: operation.key.toString('hex'),
        }));
        for (const operation of operations) {
          const key = operation.key.toString('hex');
          if (operation.kind === 'put') {
            this.putCount += 1;
            this.rows.set(key, Buffer.from(operation.value));
          } else {
            this.delCount += 1;
            this.rows.delete(key);
          }
        }
      },
    };
  }

  async *keys(options?: {
    gte?: Buffer;
    lt?: Buffer;
    reverse?: boolean;
  }): AsyncIterable<Buffer> {
    const keys = Array.from(this.rows.keys(), key => Buffer.from(key, 'hex'))
      .filter(key => !options?.gte || Buffer.compare(key, options.gte) >= 0)
      .filter(key => !options?.lt || Buffer.compare(key, options.lt) < 0)
      .sort(Buffer.compare);
    if (options?.reverse) keys.reverse();
    yield* keys;
  }
}
