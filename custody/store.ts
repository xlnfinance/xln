import { Database } from 'bun:sqlite';

export type SessionRecord = {
  token: string;
  userId: string;
  createdAt: number;
  lastSeenAt: number;
};

export type BalanceRecord = {
  tokenId: number;
  amountMinor: bigint;
  updatedAt: number;
};

export type DepositRecord = {
  eventKey: string;
  userId: string | null;
  tokenId: number;
  amountMinor: bigint;
  description: string;
  fromEntityId: string;
  hashlock: string;
  frameHeight: number;
  createdAt: number;
  startedAtMs: number | null;
};

export type WithdrawalStatus = 'submitting' | 'sent' | 'finalized' | 'failed';

export type WithdrawalRecord = {
  id: string;
  userId: string;
  tokenId: number;
  amountMinor: bigint;
  requestedAmountMinor: bigint;
  feeMinor: bigint;
  targetEntityId: string;
  description: string;
  status: WithdrawalStatus;
  hashlock: string | null;
  routeJson: string | null;
  daemonError: string | null;
  createdAt: number;
  updatedAt: number;
  finalizedAt: number | null;
  frameHeight: number | null;
  startedAtMs: number | null;
};

export type ActivityRecord =
  | ({ kind: 'deposit' } & DepositRecord)
  | ({ kind: 'withdrawal' } & WithdrawalRecord);

const toBigInt = (value: string | bigint | number): bigint => {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(value);
  return BigInt(value);
};

const now = (): number => Date.now();

export class CustodyStore {
  private readonly db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { create: true, strict: true });
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS balances (
        user_id TEXT NOT NULL,
        token_id INTEGER NOT NULL,
        amount_minor TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, token_id)
      );

      CREATE TABLE IF NOT EXISTS deposits (
        event_key TEXT PRIMARY KEY,
        user_id TEXT,
        token_id INTEGER NOT NULL,
        amount_minor TEXT NOT NULL,
        description TEXT NOT NULL,
        from_entity_id TEXT NOT NULL,
        hashlock TEXT NOT NULL,
        frame_height INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        started_at_ms INTEGER
      );

      CREATE TABLE IF NOT EXISTS withdrawals (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        token_id INTEGER NOT NULL,
        amount_minor TEXT NOT NULL,
        requested_amount_minor TEXT NOT NULL DEFAULT '0',
        fee_minor TEXT NOT NULL DEFAULT '0',
        target_entity_id TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL,
        hashlock TEXT,
        route_json TEXT,
        daemon_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        finalized_at INTEGER,
        frame_height INTEGER,
        started_at_ms INTEGER
      );

      CREATE TABLE IF NOT EXISTS service_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    this.ensureDepositColumn('started_at_ms', 'ALTER TABLE deposits ADD COLUMN started_at_ms INTEGER');
    this.ensureWithdrawalColumn('requested_amount_minor', "ALTER TABLE withdrawals ADD COLUMN requested_amount_minor TEXT NOT NULL DEFAULT '0'");
    this.ensureWithdrawalColumn('fee_minor', "ALTER TABLE withdrawals ADD COLUMN fee_minor TEXT NOT NULL DEFAULT '0'");
    this.ensureWithdrawalColumn('started_at_ms', 'ALTER TABLE withdrawals ADD COLUMN started_at_ms INTEGER');
  }

  private ensureDepositColumn(columnName: string, alterSql: string): void {
    const columns = this.db
      .query<{ name: string }>('PRAGMA table_info(deposits)')
      .all()
      .map(row => row.name);
    if (!columns.includes(columnName)) {
      this.db.exec(alterSql);
    }
  }

  private ensureWithdrawalColumn(columnName: string, alterSql: string): void {
    const columns = this.db
      .query<{ name: string }>('PRAGMA table_info(withdrawals)')
      .all()
      .map(row => row.name);
    if (!columns.includes(columnName)) {
      this.db.exec(alterSql);
    }
  }

  close(): void {
    this.db.close();
  }

  getSessionByToken(token: string): SessionRecord | null {
    const row = this.db
      .query<{ token: string; user_id: string; created_at: number; last_seen_at: number }>(
        'SELECT token, user_id, created_at, last_seen_at FROM sessions WHERE token = ?1',
      )
      .get(token);
    if (!row) return null;
    return {
      token: row.token,
      userId: row.user_id,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
    };
  }

  userExists(userId: string): boolean {
    const row = this.db.query<{ found: number }>('SELECT 1 AS found FROM sessions WHERE user_id = ?1 LIMIT 1').get(userId);
    return !!row?.found;
  }

  createSession(token: string, userId: string): SessionRecord {
    const createdAt = now();
    this.db
      .query('INSERT INTO sessions (token, user_id, created_at, last_seen_at) VALUES (?1, ?2, ?3, ?3)')
      .run(token, userId, createdAt);
    return { token, userId, createdAt, lastSeenAt: createdAt };
  }

  touchSession(token: string): SessionRecord | null {
    const touchedAt = now();
    this.db.query('UPDATE sessions SET last_seen_at = ?2 WHERE token = ?1').run(token, touchedAt);
    return this.getSessionByToken(token);
  }

  getBalances(userId: string): BalanceRecord[] {
    const rows = this.db
      .query<{ token_id: number; amount_minor: string; updated_at: number }>(
        'SELECT token_id, amount_minor, updated_at FROM balances WHERE user_id = ?1 ORDER BY token_id ASC',
      )
      .all(userId);
    return rows.map(row => ({
      tokenId: row.token_id,
      amountMinor: toBigInt(row.amount_minor),
      updatedAt: row.updated_at,
    }));
  }

  getBalanceAmount(userId: string, tokenId: number): bigint {
    const row = this.db
      .query<{ amount_minor: string }>('SELECT amount_minor FROM balances WHERE user_id = ?1 AND token_id = ?2')
      .get(userId, tokenId);
    return row ? toBigInt(row.amount_minor) : 0n;
  }

  private setBalanceAmount(userId: string, tokenId: number, amountMinor: bigint, updatedAt: number): void {
    this.db
      .query(`
        INSERT INTO balances (user_id, token_id, amount_minor, updated_at)
        VALUES (?1, ?2, ?3, ?4)
        ON CONFLICT(user_id, token_id)
        DO UPDATE SET amount_minor = excluded.amount_minor, updated_at = excluded.updated_at
      `)
      .run(userId, tokenId, amountMinor.toString(), updatedAt);
  }

  creditDeposit(params: {
    eventKey: string;
    userId: string | null;
    tokenId: number;
    amountMinor: bigint;
    description: string;
    fromEntityId: string;
    hashlock: string;
    frameHeight: number;
    createdAt: number;
    startedAtMs?: number | null;
  }): { inserted: boolean; credited: boolean } {
    const insertDeposit = this.db.query(`
      INSERT INTO deposits (
        event_key, user_id, token_id, amount_minor, description, from_entity_id, hashlock, frame_height, created_at, started_at_ms
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
      ON CONFLICT(event_key) DO NOTHING
    `);

    const txn = this.db.transaction((input: typeof params) => {
      const result = insertDeposit.run(
        input.eventKey,
        input.userId,
        input.tokenId,
        input.amountMinor.toString(),
        input.description,
        input.fromEntityId,
        input.hashlock,
        input.frameHeight,
        input.createdAt,
        input.startedAtMs ?? null,
      );
      const inserted = Number(result.changes) > 0;
      if (!inserted) return { inserted: false, credited: false };
      if (input.userId && this.userExists(input.userId)) {
        const current = this.getBalanceAmount(input.userId, input.tokenId);
        this.setBalanceAmount(input.userId, input.tokenId, current + input.amountMinor, input.createdAt);
        return { inserted: true, credited: true };
      }
      return { inserted: true, credited: false };
    });

    return txn(params);
  }

  reserveWithdrawal(params: {
    id: string;
    userId: string;
    tokenId: number;
    amountMinor: bigint;
    requestedAmountMinor: bigint;
    feeMinor: bigint;
    targetEntityId: string;
    description: string;
    createdAt: number;
    startedAtMs?: number | null;
  }): WithdrawalRecord {
    const txn = this.db.transaction((input: typeof params) => {
      const current = this.getBalanceAmount(input.userId, input.tokenId);
      if (current < input.amountMinor) {
        throw new Error('Insufficient custody balance');
      }
      this.setBalanceAmount(input.userId, input.tokenId, current - input.amountMinor, input.createdAt);
      this.db
        .query(`
          INSERT INTO withdrawals (
            id, user_id, token_id, amount_minor, requested_amount_minor, fee_minor, target_entity_id, description, status,
            hashlock, route_json, daemon_error, created_at, updated_at, finalized_at, frame_height, started_at_ms
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'submitting', NULL, NULL, NULL, ?9, ?9, NULL, NULL, ?10)
        `)
        .run(
          input.id,
          input.userId,
          input.tokenId,
          input.amountMinor.toString(),
          input.requestedAmountMinor.toString(),
          input.feeMinor.toString(),
          input.targetEntityId,
          input.description,
          input.createdAt,
          input.startedAtMs ?? null,
        );
      return this.getWithdrawalById(input.id);
    });

    const withdrawal = txn(params);
    if (!withdrawal) {
      throw new Error('Failed to create withdrawal');
    }
    return withdrawal;
  }

  markWithdrawalSent(params: {
    id: string;
    hashlock: string;
    routeJson: string;
    updatedAt: number;
  }): WithdrawalRecord | null {
    this.db
      .query(
        `UPDATE withdrawals
         SET status = 'sent', hashlock = ?2, route_json = ?3, updated_at = ?4, daemon_error = NULL
         WHERE id = ?1 AND status = 'submitting'`,
      )
      .run(params.id, params.hashlock, params.routeJson, params.updatedAt);
    return this.getWithdrawalById(params.id);
  }

  failWithdrawalById(params: {
    id: string;
    error: string;
    updatedAt: number;
    restoreBalance: boolean;
  }): WithdrawalRecord | null {
    const txn = this.db.transaction((input: typeof params) => {
      const withdrawal = this.getWithdrawalById(input.id);
      if (!withdrawal) return null;
      if (input.restoreBalance && withdrawal.status === 'submitting') {
        const current = this.getBalanceAmount(withdrawal.userId, withdrawal.tokenId);
        this.setBalanceAmount(withdrawal.userId, withdrawal.tokenId, current + withdrawal.amountMinor, input.updatedAt);
      }
      this.db
        .query(
          `UPDATE withdrawals
           SET status = 'failed', daemon_error = ?2, updated_at = ?3, finalized_at = ?3
           WHERE id = ?1`,
        )
        .run(input.id, input.error, input.updatedAt);
      return this.getWithdrawalById(input.id);
    });
    return txn(params);
  }

  finalizeWithdrawalByHashlock(params: {
    hashlock: string;
    frameHeight: number;
    updatedAt: number;
  }): WithdrawalRecord | null {
    this.db
      .query(
        `UPDATE withdrawals
         SET status = 'finalized', frame_height = ?2, updated_at = ?3, finalized_at = ?3
         WHERE hashlock = ?1 AND status IN ('submitting', 'sent')`,
      )
      .run(params.hashlock, params.frameHeight, params.updatedAt);
    return this.getWithdrawalByHashlock(params.hashlock);
  }

  failWithdrawalByHashlock(params: {
    hashlock: string;
    error: string;
    frameHeight: number;
    updatedAt: number;
  }): WithdrawalRecord | null {
    const txn = this.db.transaction((input: typeof params) => {
      const withdrawal = this.getWithdrawalByHashlock(input.hashlock);
      if (!withdrawal) return null;
      if (withdrawal.status !== 'failed') {
        const current = this.getBalanceAmount(withdrawal.userId, withdrawal.tokenId);
        this.setBalanceAmount(withdrawal.userId, withdrawal.tokenId, current + withdrawal.amountMinor, input.updatedAt);
      }
      this.db
        .query(
          `UPDATE withdrawals
           SET status = 'failed', daemon_error = ?2, frame_height = ?3, updated_at = ?4, finalized_at = ?4
           WHERE hashlock = ?1`,
        )
        .run(input.hashlock, input.error, input.frameHeight, input.updatedAt);
      return this.getWithdrawalByHashlock(input.hashlock);
    });
    return txn(params);
  }

  recoverSubmittingWithdrawals(errorMessage: string): number {
    const withdrawals = this.db
      .query<{ id: string; user_id: string; token_id: number; amount_minor: string }>(
        `SELECT id, user_id, token_id, amount_minor FROM withdrawals WHERE status = 'submitting'`,
      )
      .all();
    if (withdrawals.length === 0) return 0;

    const txn = this.db.transaction((rows: typeof withdrawals) => {
      const touchedAt = now();
      for (const row of rows) {
        const current = this.getBalanceAmount(row.user_id, row.token_id);
        this.setBalanceAmount(row.user_id, row.token_id, current + toBigInt(row.amount_minor), touchedAt);
        this.db
          .query(
            `UPDATE withdrawals
             SET status = 'failed', daemon_error = ?2, updated_at = ?3, finalized_at = ?3
             WHERE id = ?1`,
          )
          .run(row.id, errorMessage, touchedAt);
      }
    });

    txn(withdrawals);
    return withdrawals.length;
  }

  getWithdrawalById(id: string): WithdrawalRecord | null {
    const row = this.db
      .query<{
        id: string;
        user_id: string;
        token_id: number;
        amount_minor: string;
        requested_amount_minor: string;
        fee_minor: string;
        target_entity_id: string;
        description: string;
        status: WithdrawalStatus;
        hashlock: string | null;
        route_json: string | null;
        daemon_error: string | null;
        created_at: number;
        updated_at: number;
        finalized_at: number | null;
        frame_height: number | null;
        started_at_ms: number | null;
      }>(
        `SELECT id, user_id, token_id, amount_minor, requested_amount_minor, fee_minor, target_entity_id, description, status, hashlock,
                route_json, daemon_error, created_at, updated_at, finalized_at, frame_height, started_at_ms
         FROM withdrawals WHERE id = ?1`,
      )
      .get(id);
    if (!row) return null;
    return {
      id: row.id,
      userId: row.user_id,
      tokenId: row.token_id,
      amountMinor: toBigInt(row.amount_minor),
      requestedAmountMinor: toBigInt(row.requested_amount_minor),
      feeMinor: toBigInt(row.fee_minor),
      targetEntityId: row.target_entity_id,
      description: row.description,
      status: row.status,
      hashlock: row.hashlock,
      routeJson: row.route_json,
      daemonError: row.daemon_error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      finalizedAt: row.finalized_at,
      frameHeight: row.frame_height,
      startedAtMs: row.started_at_ms,
    };
  }

  getWithdrawalByHashlock(hashlock: string): WithdrawalRecord | null {
    const row = this.db
      .query<{ id: string }>('SELECT id FROM withdrawals WHERE hashlock = ?1 LIMIT 1')
      .get(hashlock);
    return row ? this.getWithdrawalById(row.id) : null;
  }

  getRecentActivity(userId: string, limit = 20): ActivityRecord[] {
    const depositRows = this.db
      .query<{
        event_key: string;
        user_id: string | null;
        token_id: number;
        amount_minor: string;
        description: string;
        from_entity_id: string;
        hashlock: string;
        frame_height: number;
        created_at: number;
        started_at_ms: number | null;
      }>(
        `SELECT event_key, user_id, token_id, amount_minor, description, from_entity_id, hashlock, frame_height, created_at, started_at_ms
         FROM deposits WHERE user_id = ?1 ORDER BY created_at DESC LIMIT ?2`,
      )
      .all(userId, limit);

    const withdrawalRows = this.db
      .query<{
        id: string;
        user_id: string;
        token_id: number;
        amount_minor: string;
        requested_amount_minor: string;
        fee_minor: string;
        target_entity_id: string;
        description: string;
        status: WithdrawalStatus;
        hashlock: string | null;
        route_json: string | null;
        daemon_error: string | null;
        created_at: number;
        updated_at: number;
        finalized_at: number | null;
        frame_height: number | null;
        started_at_ms: number | null;
      }>(
        `SELECT id, user_id, token_id, amount_minor, requested_amount_minor, fee_minor, target_entity_id, description, status, hashlock,
                route_json, daemon_error, created_at, updated_at, finalized_at, frame_height, started_at_ms
         FROM withdrawals WHERE user_id = ?1 ORDER BY created_at DESC LIMIT ?2`,
      )
      .all(userId, limit);

    const activity: ActivityRecord[] = [
      ...depositRows.map(row => ({
        kind: 'deposit' as const,
        eventKey: row.event_key,
        userId: row.user_id,
        tokenId: row.token_id,
        amountMinor: toBigInt(row.amount_minor),
        description: row.description,
        fromEntityId: row.from_entity_id,
        hashlock: row.hashlock,
        frameHeight: row.frame_height,
        createdAt: row.created_at,
        startedAtMs: row.started_at_ms,
      })),
      ...withdrawalRows.map(row => ({
        kind: 'withdrawal' as const,
        id: row.id,
        userId: row.user_id,
        tokenId: row.token_id,
        amountMinor: toBigInt(row.amount_minor),
        requestedAmountMinor: toBigInt(row.requested_amount_minor),
        feeMinor: toBigInt(row.fee_minor),
        targetEntityId: row.target_entity_id,
        description: row.description,
        status: row.status,
        hashlock: row.hashlock,
        routeJson: row.route_json,
        daemonError: row.daemon_error,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        finalizedAt: row.finalized_at,
        frameHeight: row.frame_height,
        startedAtMs: row.started_at_ms,
      })),
    ];

    return activity
      .sort((left, right) => {
        const leftTs = left.kind === 'deposit' ? left.createdAt : left.updatedAt;
        const rightTs = right.kind === 'deposit' ? right.createdAt : right.updatedAt;
        return rightTs - leftTs;
      })
      .slice(0, limit);
  }

  getStateNumber(key: string, fallback = 0): number {
    const row = this.db.query<{ value: string }>('SELECT value FROM service_state WHERE key = ?1').get(key);
    if (!row) return fallback;
    const parsed = Number(row.value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  setStateNumber(key: string, value: number): void {
    this.db
      .query(`
        INSERT INTO service_state (key, value)
        VALUES (?1, ?2)
        ON CONFLICT(key)
        DO UPDATE SET value = excluded.value
      `)
      .run(key, String(value));
  }
}
