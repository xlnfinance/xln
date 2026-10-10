import { Buffer } from '../../support/platform-crypto';
import type { RuntimeDbLike } from '../types';

type PreparedRow = Readonly<{ key: Buffer; value: Buffer }>;

const lowerBound = (rows: readonly PreparedRow[], key: Buffer): number => {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const row = rows[middle];
    if (row && Buffer.compare(row.key, key) < 0) low = middle + 1;
    else high = middle;
  }
  return low;
};

/**
 * Read-only DB holding exactly the rows of a planned replacement batch (later
 * puts win, as in the batch). A replacement verifies this view before its
 * atomic swap, so a failed check leaves the previous state untouched.
 */
export const createPreparedRowsView = (rows: readonly PreparedRow[]): RuntimeDbLike => {
  const values = new Map<string, PreparedRow>();
  for (const row of rows) values.set(row.key.toString('hex'), row);
  const sorted = [...values.values()].sort((left, right) => Buffer.compare(left.key, right.key));
  return {
    get: async key => {
      const row = values.get(key.toString('hex'));
      if (row) return Buffer.from(row.value);
      const error = new Error(`STORAGE_PREPARED_ROW_NOT_FOUND:${key.toString('hex')}`);
      error.name = 'NotFoundError';
      throw error;
    },
    batch: () => {
      throw new Error('STORAGE_PREPARED_ROWS_READ_ONLY');
    },
    keys: async function* (options = {}) {
      const start = options.gte ? lowerBound(sorted, options.gte) : 0;
      const end = options.lt ? lowerBound(sorted, options.lt) : sorted.length;
      const keys = sorted.slice(start, Math.max(start, end)).map(row => row.key);
      yield* options.reverse === true ? keys.reverse() : keys;
    },
  };
};
