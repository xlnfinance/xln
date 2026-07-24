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

export class TornBatchRuntimeDb implements RuntimeDbLike {
  private appliedOperationsBeforeFailure: number | null = null;

  constructor(readonly durable: MemoryRuntimeDb) {}

  arm(appliedOperationsBeforeFailure: number): void {
    if (
      !Number.isSafeInteger(appliedOperationsBeforeFailure) ||
      appliedOperationsBeforeFailure < 0
    ) {
      throw new Error(
        `TORN_BATCH_OPERATION_COUNT_INVALID:${appliedOperationsBeforeFailure}`,
      );
    }
    this.appliedOperationsBeforeFailure = appliedOperationsBeforeFailure;
  }

  get(key: Buffer): Promise<Buffer> {
    return this.durable.get(key);
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
        const limit = this.appliedOperationsBeforeFailure;
        this.appliedOperationsBeforeFailure = null;
        const durableBatch = this.durable.batch();
        for (const operation of limit === null ? operations : operations.slice(0, limit)) {
          if (operation.kind === 'put') durableBatch.put(operation.key, operation.value);
          else durableBatch.del?.(operation.key);
        }
        await durableBatch.write();
        if (limit !== null) {
          throw new Error(
            `SIM_STORAGE_TORN_BATCH:applied=${Math.min(limit, operations.length)}:` +
            `planned=${operations.length}`,
          );
        }
      },
    };
  }

  keys(options?: {
    gte?: Buffer;
    lt?: Buffer;
    reverse?: boolean;
  }): AsyncIterable<Buffer> {
    return this.durable.keys(options);
  }
}
