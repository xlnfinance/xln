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
  commandId: string;
  commandSequence: number | null;
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
        command_id TEXT,
        command_sequence INTEGER,
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
    this.ensureWithdrawalColumn('command_id', 'ALTER TABLE withdrawals ADD COLUMN command_id TEXT');
    this.ensureWithdrawalColumn('command_sequence', 'ALTER TABLE withdrawals ADD COLUMN command_sequence INTEGER');
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
    routeJson: string;
    commandId: string;
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
            hashlock, route_json, command_id, command_sequence, daemon_error, created_at, updated_at, finalized_at,
            frame_height, started_at_ms
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'submitting', NULL, ?9, ?10, NULL, NULL, ?11, ?11, NULL, NULL, ?12)
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
          input.routeJson,
          input.commandId,
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

  setWithdrawalCommandSequence(id: string, commandId: string, commandSequence: number): WithdrawalRecord {
    if (!Number.isSafeInteger(commandSequence) || commandSequence <= 0) {
      throw new Error(`CUSTODY_WITHDRAWAL_COMMAND_SEQUENCE_INVALID:${String(commandSequence)}`);
    }
    const withdrawal = this.getWithdrawalById(id);
    if (!withdrawal || withdrawal.status !== 'submitting') {
      throw new Error(`CUSTODY_WITHDRAWAL_NOT_SUBMITTING:${id}`);
    }
    if (withdrawal.commandId !== commandId) {
      throw new Error(`CUSTODY_WITHDRAWAL_COMMAND_ID_CONFLICT:${id}`);
    }
    if (withdrawal.commandSequence !== null && withdrawal.commandSequence !== commandSequence) {
      throw new Error(`CUSTODY_WITHDRAWAL_COMMAND_SEQUENCE_CONFLICT:${id}`);
    }
    this.db.query(
      `UPDATE withdrawals SET command_sequence = ?2, updated_at = ?3
       WHERE id = ?1 AND status = 'submitting' AND command_id = ?4
         AND (command_sequence IS NULL OR command_sequence = ?2)`,
    ).run(id, commandSequence, now(), commandId);
    const updated = this.getWithdrawalById(id);
    if (!updated || updated.commandSequence !== commandSequence) {
      throw new Error(`CUSTODY_WITHDRAWAL_COMMAND_SEQUENCE_WRITE_FAILED:${id}`);
    }
    return updated;
  }

  listSubmittingWithdrawals(): WithdrawalRecord[] {
    const rows = this.db.query<{ id: string }>(
      `SELECT id FROM withdrawals WHERE status = 'submitting' ORDER BY created_at ASC, id ASC`,
    ).all();
    return rows.map(row => {
      const withdrawal = this.getWithdrawalById(row.id);
      if (!withdrawal) throw new Error(`CUSTODY_WITHDRAWAL_DISAPPEARED:${row.id}`);
      return withdrawal;
    });
  }

  markWithdrawalSent(params: {
    id: string;
    hashlock: string;
    routeJson: string;
    updatedAt: number;
  }): WithdrawalRecord | null {
    const txn = this.db.transaction((input: typeof params) => {
      const current = this.getWithdrawalById(input.id);
      if (!current) return null;
      const hashlock = input.hashlock.toLowerCase();
      if (current.status === 'sent' || current.status === 'finalized') {
        if (current.hashlock?.toLowerCase() !== hashlock || current.routeJson !== input.routeJson) {
          throw new Error(`CUSTODY_WITHDRAWAL_SENT_REPLAY_CONFLICT:${input.id}`);
        }
        return current;
      }
      if (current.status !== 'submitting') {
        throw new Error(`CUSTODY_WITHDRAWAL_TERMINAL_CONFLICT:${input.id}:${current.status}->sent`);
      }
      const updated = this.db
        .query(
          `UPDATE withdrawals
           SET status = 'sent', hashlock = ?2, route_json = ?3, updated_at = ?4, daemon_error = NULL
           WHERE id = ?1 AND status = 'submitting'`,
        )
        .run(input.id, hashlock, input.routeJson, input.updatedAt);
      if (Number(updated.changes) !== 1) {
        throw new Error(`CUSTODY_WITHDRAWAL_SENT_WRITE_CONFLICT:${input.id}`);
      }
      const sent = this.getWithdrawalById(input.id);
      if (!sent || sent.status !== 'sent' || sent.hashlock?.toLowerCase() !== hashlock) {
        throw new Error(`CUSTODY_WITHDRAWAL_SENT_WRITE_FAILED:${input.id}`);
      }
      return sent;
    });
    return txn(params);
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
      if (withdrawal.status === 'failed') return withdrawal;
      if (withdrawal.status !== 'submitting') {
        throw new Error(`CUSTODY_WITHDRAWAL_TERMINAL_CONFLICT:${input.id}:${withdrawal.status}->failed`);
      }
      // The sequence is persisted immediately before network I/O. Once it
      // exists, a lost response cannot prove whether the daemon committed the
      // payment, so an automatic refund could pay both the user and recipient.
      if (input.restoreBalance && withdrawal.commandSequence !== null) {
        throw new Error(`CUSTODY_WITHDRAWAL_PREPARED_REFUND_FORBIDDEN:${input.id}`);
      }
      if (input.restoreBalance) {
        const current = this.getBalanceAmount(withdrawal.userId, withdrawal.tokenId);
        this.setBalanceAmount(withdrawal.userId, withdrawal.tokenId, current + withdrawal.amountMinor, input.updatedAt);
      }
      const updated = this.db
        .query(
          `UPDATE withdrawals
           SET status = 'failed', daemon_error = ?2, updated_at = ?3, finalized_at = ?3
           WHERE id = ?1 AND status = 'submitting'`,
        )
        .run(input.id, input.error, input.updatedAt);
      if (Number(updated.changes) !== 1) {
        throw new Error(`CUSTODY_WITHDRAWAL_FAILED_WRITE_CONFLICT:${input.id}`);
      }
      const failed = this.getWithdrawalById(input.id);
      if (!failed || failed.status !== 'failed') {
        throw new Error(`CUSTODY_WITHDRAWAL_FAILED_WRITE_FAILED:${input.id}`);
      }
      return failed;
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
      if (withdrawal.status === 'failed') return withdrawal;
      if (withdrawal.status === 'finalized') {
        throw new Error(`CUSTODY_WITHDRAWAL_TERMINAL_CONFLICT:${withdrawal.id}:finalized->failed`);
      }
      const current = this.getBalanceAmount(withdrawal.userId, withdrawal.tokenId);
      this.setBalanceAmount(withdrawal.userId, withdrawal.tokenId, current + withdrawal.amountMinor, input.updatedAt);
      const updated = this.db
        .query(
          `UPDATE withdrawals
           SET status = 'failed', daemon_error = ?2, frame_height = ?3, updated_at = ?4, finalized_at = ?4
           WHERE hashlock = ?1 AND status IN ('submitting', 'sent')`,
        )
        .run(input.hashlock, input.error, input.frameHeight, input.updatedAt);
      if (Number(updated.changes) !== 1) {
        throw new Error(`CUSTODY_WITHDRAWAL_FAILED_WRITE_CONFLICT:${withdrawal.id}`);
      }
      const failed = this.getWithdrawalByHashlock(input.hashlock);
      if (!failed || failed.status !== 'failed') {
        throw new Error(`CUSTODY_WITHDRAWAL_FAILED_WRITE_FAILED:${withdrawal.id}`);
      }
      return failed;
    });
    return txn(params);
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
        command_id: string | null;
        command_sequence: number | null;
        daemon_error: string | null;
        created_at: number;
        updated_at: number;
        finalized_at: number | null;
        frame_height: number | null;
        started_at_ms: number | null;
      }>(
        `SELECT id, user_id, token_id, amount_minor, requested_amount_minor, fee_minor, target_entity_id, description, status, hashlock,
                route_json, command_id, command_sequence, daemon_error, created_at, updated_at, finalized_at, frame_height, started_at_ms
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
      commandId: row.command_id || `custody:${row.id}`,
      commandSequence: row.command_sequence,
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
        command_id: string | null;
        command_sequence: number | null;
        daemon_error: string | null;
        created_at: number;
        updated_at: number;
        finalized_at: number | null;
        frame_height: number | null;
        started_at_ms: number | null;
      }>(
        `SELECT id, user_id, token_id, amount_minor, requested_amount_minor, fee_minor, target_entity_id, description, status, hashlock,
                route_json, command_id, command_sequence, daemon_error, created_at, updated_at, finalized_at, frame_height, started_at_ms
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
        commandId: row.command_id || `custody:${row.id}`,
        commandSequence: row.command_sequence,
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
