import { Database } from 'bun:sqlite';
import { safeStringify } from '../../protocol/serialization';
import { CREDIT_POLICY } from './policy';
import type { CreditRequest } from './proof';

/** Officer-owned reservations are not financial state. Persist BEFORE sending:
 * an ambiguous command consumes its allowance; a restart never grants it twice.
 * SQLite serializes competing processes and fsyncs reservations and audit rows. */
export class CreditLedger {
  private db: Database;
  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    this.db.exec(`CREATE TABLE IF NOT EXISTS decisions (
      id INTEGER PRIMARY KEY, hub TEXT NOT NULL, borrower TEXT NOT NULL, day TEXT NOT NULL,
      nonce TEXT NOT NULL, usd TEXT NOT NULL, reserved INTEGER NOT NULL, evidence TEXT NOT NULL,
      UNIQUE(hub, borrower, day, nonce));
      CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, evidence TEXT NOT NULL);`);
  }
  spent(r: CreditRequest): bigint {
    const rows = this.db
      .query<{ usd: string }, [string, string, string]>(
        'SELECT usd FROM decisions WHERE hub=? AND borrower=? AND day=? AND reserved=1',
      )
      .all(r.hubEntityId, r.borrowerEntityId, r.day);
    return rows.reduce((sum, row) => sum + BigInt(row.usd), 0n);
  }
  record(
    r: CreditRequest,
    usd: bigint,
    reserved: boolean,
    evidence: unknown,
    allowance: bigint = CREDIT_POLICY.dailyCapUsd,
  ): void {
    this.db
      .transaction(() => {
        if (reserved && this.spent(r) + usd > allowance) throw new Error('DAILY_LIMIT');
        const prior = this.db
          .query('SELECT id FROM decisions WHERE hub=? AND borrower=? AND day=? AND nonce=?')
          .get(r.hubEntityId, r.borrowerEntityId, r.day, r.nonce);
        if (prior) throw new Error('PROOF_REUSED');
        this.db
          .query('INSERT INTO decisions(hub,borrower,day,nonce,usd,reserved,evidence) VALUES(?,?,?,?,?,?,?)')
          .run(
            r.hubEntityId,
            r.borrowerEntityId,
            r.day,
            r.nonce,
            usd.toString(),
            reserved ? 1 : 0,
            safeStringify(evidence),
          );
      })
      .immediate();
  }
  audit(evidence: unknown): void {
    this.db.query('INSERT INTO audit(evidence) VALUES(?)').run(safeStringify(evidence));
    console.log(safeStringify(evidence));
  }
  close(): void {
    this.db.close();
  }
}
