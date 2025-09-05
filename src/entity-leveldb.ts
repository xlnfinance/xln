import { KeyEncoding, ValueEncoding } from '@ethereumjs/util'
import { Level } from 'level'
import { MemoryLevel } from 'memory-level'

import type { BatchDBOp, DB, DBObject, EncodingOpts } from '@ethereumjs/util'
import type { AbstractLevel } from 'abstract-level'

// Helper to infer the `valueEncoding` option for `putting` a value in a levelDB
const getEncodings = (opts: EncodingOpts = {}) => {
  const encodings = { keyEncoding: '', valueEncoding: '' }
  switch (opts.valueEncoding) {
    case ValueEncoding.String:
      encodings.valueEncoding = 'utf8'
      break
    case ValueEncoding.Bytes:
      encodings.valueEncoding = 'view'
      break
    case ValueEncoding.JSON:
      encodings.valueEncoding = 'json'
      break
    default:
      encodings.valueEncoding = 'view'
  }
  switch (opts.keyEncoding) {
    case KeyEncoding.Bytes:
      encodings.keyEncoding = 'view'
      break
    case KeyEncoding.Number:
    case KeyEncoding.String:
      encodings.keyEncoding = 'utf8'
      break
    default:
      encodings.keyEncoding = 'utf8'
  }

  return encodings
}

/**
 * LevelDB is a thin wrapper around the underlying levelup db,
 * corresponding to the {@link DB}
 */
export function createLevelDB<
  TKey extends Uint8Array | string = Uint8Array | string,
  TValue extends Uint8Array | string | DBObject = Uint8Array | string | DBObject,
>(
  leveldb?: AbstractLevel<string | Uint8Array, string | Uint8Array, string | Uint8Array>,
): DB<TKey, TValue> {
  const _leveldb = leveldb ?? (new MemoryLevel({ keyEncoding: 'view', valueEncoding: 'view' }) as unknown as AbstractLevel<string | Uint8Array, string | Uint8Array, string | Uint8Array>)

  /**
   * Get a value from the database
   */
  async function get(key: TKey, opts?: EncodingOpts): Promise<TValue | undefined> {
    let value
    const encodings = getEncodings(opts)

    try {
      value = await _leveldb.get(key, encodings)
      if (value === null) return undefined
    } catch (error: any) {
      // https://github.com/Level/abstract-level/blob/915ad1317694d0ce8c580b5ab85d81e1e78a3137/abstract-level.js#L309
      // This should be `true` if the error came from LevelDB
      // so we can check for `NOT true` to identify any non-404 errors
      if (error.notFound !== true) {
        throw error
      }
    }
    // eslint-disable-next-line
    if (value && typeof value === 'object' && 'constructor' in value && value.constructor.name === 'Buffer') {
      value = Uint8Array.from(value as any)
    }
    return value as TValue
  }

  /**
   * Put a value in the database
   */
  async function put(key: TKey, val: TValue, opts?: {}): Promise<void> {
    const encodings = getEncodings(opts)
    await _leveldb.put(key, val, encodings)
  }

  /**
   * Delete a value from the database
   */
  async function del(key: TKey): Promise<void> {
    await _leveldb.del(key)
  }

  /**
   * Execute a batch of operations
   */
  async function batch(opStack: BatchDBOp<TKey, TValue>[]): Promise<void> {
    const levelOps: {
      keyEncoding: string
      valueEncoding: string
    }[] = []
    for (const op of opStack) {
      const encodings = getEncodings(op.opts)
      levelOps.push({ ...op, ...encodings })
    }

    // TODO: Investigate why as any is necessary
    await _leveldb.batch(levelOps as any)
  }

  /**
   * Create a shallow copy of the database
   */
  function shallowCopy(): DB<TKey, TValue> {
    return createLevelDB<TKey, TValue>(_leveldb)
  }

  /**
   * Open the database
   */
  function open() {
    return _leveldb.open()
  }

  return {
    get,
    put,
    del,
    batch,
    shallowCopy,
    open,
  }
}