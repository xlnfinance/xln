import { Database } from 'bun:sqlite';
import { chmodSync } from 'node:fs';
import type { xlnMppClient } from '../../../core/api/payments/mpp-client';
import { decodePreparedAgentPayment } from '../../../core/api/payments/agent-intent';
import { safeStringify } from '../../../core/protocol/serialization';

type IntentStore = Parameters<typeof xlnMppClient>[0]['intents'];
type StoredPayment = NonNullable<Awaited<ReturnType<IntentStore['get']>>>;

/** Application intents only; Runtime WAL remains the authority for financial state. */
export function paymentIntentStore(path: string) {
  const db = new Database(path, { create: true, strict: true });
  chmodSync(path, 0o600);
  db.exec(
    'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS intents (id TEXT PRIMARY KEY, value TEXT NOT NULL)',
  );
  const get = (id: string): StoredPayment | null => {
    const row = db.query<{ value: string }, [string]>('SELECT value FROM intents WHERE id=?').get(id);
    if (!row) return null;
    const value: unknown = JSON.parse(row.value);
    if (
      !value ||
      typeof value !== 'object' ||
      !('currency' in value) ||
      typeof value.currency !== 'string' ||
      !('payment' in value)
    ) {
      throw new Error('AGENT_INTENT_STORE_CORRUPT');
    }
    return { currency: value.currency, payment: decodePreparedAgentPayment(value.payment) };
  };
  const put = (id: string, value: StoredPayment) => {
    db.query('INSERT INTO intents VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(
      id,
      safeStringify(value),
    );
  };
  const remove = (id: string) => {
    db.query('DELETE FROM intents WHERE id=?').run(id);
  };
  const store: IntentStore = {
    get: async id => get(id),
    put: async (id, value) => put(id, value),
    delete: async id => remove(id),
    update: async (id, fn) =>
      db
        .transaction(() => {
          const change = fn(get(id));
          if (change.op === 'set') put(id, change.value);
          if (change.op === 'delete') remove(id);
          return change.result;
        })
        .immediate(),
  };
  return { store, close: () => db.close() };
}
