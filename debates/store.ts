import { createHash, randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { defaultJudgeBoards, type AggregatedVerdict, type JudgeConfig, type JudgeVerdict } from './ai';

export type SessionRecord = {
  token: string;
  userId: string;
  createdAt: number;
  lastSeenAt: number;
};

export type UserRecord = {
  id: string;
  entityId: string | null;
  signerId: string | null;
  displayName: string | null;
  createdAt: number;
  lastSeenAt: number;
};

export type BalanceRecord = {
  tokenId: number;
  availableMinor: bigint;
  lockedMinor: bigint;
  spentMinor: bigint;
  updatedAt: number;
};

export type ChallengeStatus = 'waiting_for_counterparty' | 'active' | 'ready_for_judging' | 'judging' | 'finalized' | 'cancelled';
export type ChallengeVisibility = 'public' | 'unlisted' | 'private';
export type DebateSide = 'A' | 'B';
export type WithdrawalStatus = 'submitting' | 'sent' | 'finalized' | 'failed';

export type DebateMessageRecord = {
  id: string;
  challengeId: string;
  roundNumber: number;
  side: DebateSide;
  userId: string;
  body: string;
  bodyHash: string;
  charsCount: number;
  createdAt: number;
};

export type ChallengeRecord = {
  id: string;
  slug: string;
  createdByUserId: string;
  sideAUserId: string | null;
  sideBUserId: string | null;
  statement: string;
  sideALabel: string;
  sideBLabel: string;
  status: ChallengeStatus;
  visibility: ChallengeVisibility;
  tokenId: number;
  stakeMinor: bigint;
  payoutRule: string;
  roundsTotal: number;
  currentRound: number;
  messageLimitChars: number;
  turnTimeLimitSec: number | null;
  inviteToken: string | null;
  rulesJson: string;
  contextJson: string;
  judgeBoardJson: string;
  createdAt: number;
  acceptedAt: number | null;
  startedAt: number | null;
  judgingStartedAt: number | null;
  finalizedAt: number | null;
};

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
  frameHeight: number | null;
  createdAt: number;
  updatedAt: number;
  finalizedAt: number | null;
  daemonError: string | null;
  startedAtMs: number | null;
};

type ChallengeRow = Omit<ChallengeRecord, 'stakeMinor'> & { stakeMinor: string };
type BalanceRow = {
  token_id: number;
  available_minor: string;
  locked_minor: string;
  spent_minor: string;
  updated_at: number;
};

const now = (): number => Date.now();
const toBigInt = (value: string | number | bigint): bigint =>
  typeof value === 'bigint' ? value : BigInt(value);

const id = (prefix: string): string => `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 20)}`;

const hash = (value: string): string => `sha256:${createHash('sha256').update(value).digest('hex')}`;

const slugify = (value: string): string => {
  const base = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `${base || 'debate'}-${randomUUID().replaceAll('-', '').slice(0, 8)}`;
};

const parseJson = <T>(raw: string, fallback: T): T => {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

export class DebatesStore {
  private readonly db: Database;

  constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (dir && dir !== '.') mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath, { create: true, strict: true });
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec('PRAGMA temp_store = MEMORY;');
    this.initSchema();
  }

  close(): void {
    this.db.close();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        entity_id TEXT,
        signer_id TEXT,
        display_name TEXT,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS balances (
        user_id TEXT NOT NULL,
        token_id INTEGER NOT NULL,
        available_minor TEXT NOT NULL,
        locked_minor TEXT NOT NULL,
        spent_minor TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, token_id),
        FOREIGN KEY (user_id) REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS ledger_entries (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        token_id INTEGER NOT NULL,
        delta_available_minor TEXT NOT NULL,
        delta_locked_minor TEXT NOT NULL,
        delta_spent_minor TEXT NOT NULL,
        reason TEXT NOT NULL,
        reference_type TEXT,
        reference_id TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id)
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
        requested_amount_minor TEXT NOT NULL,
        fee_minor TEXT NOT NULL,
        target_entity_id TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL,
        hashlock TEXT,
        route_json TEXT,
        frame_height INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        finalized_at INTEGER,
        daemon_error TEXT,
        started_at_ms INTEGER,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS challenges (
        id TEXT PRIMARY KEY,
        slug TEXT UNIQUE NOT NULL,
        created_by_user_id TEXT NOT NULL,
        side_a_user_id TEXT,
        side_b_user_id TEXT,
        statement TEXT NOT NULL,
        side_a_label TEXT NOT NULL,
        side_b_label TEXT NOT NULL,
        status TEXT NOT NULL,
        visibility TEXT NOT NULL,
        token_id INTEGER NOT NULL,
        stake_minor TEXT NOT NULL,
        payout_rule TEXT NOT NULL,
        rounds_total INTEGER NOT NULL,
        current_round INTEGER NOT NULL,
        message_limit_chars INTEGER NOT NULL,
        turn_time_limit_sec INTEGER,
        invite_token TEXT,
        rules_json TEXT NOT NULL,
        context_json TEXT NOT NULL,
        judge_board_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        accepted_at INTEGER,
        started_at INTEGER,
        judging_started_at INTEGER,
        finalized_at INTEGER,
        FOREIGN KEY (created_by_user_id) REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS challenge_locks (
        id TEXT PRIMARY KEY,
        challenge_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        token_id INTEGER NOT NULL,
        amount_minor TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        released_at INTEGER,
        FOREIGN KEY (challenge_id) REFERENCES challenges(id),
        FOREIGN KEY (user_id) REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS debate_messages (
        id TEXT PRIMARY KEY,
        challenge_id TEXT NOT NULL,
        round_number INTEGER NOT NULL,
        side TEXT NOT NULL,
        user_id TEXT NOT NULL,
        body TEXT NOT NULL,
        body_hash TEXT NOT NULL,
        chars_count INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE (challenge_id, round_number, side),
        FOREIGN KEY (challenge_id) REFERENCES challenges(id),
        FOREIGN KEY (user_id) REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS judge_runs (
        id TEXT PRIMARY KEY,
        challenge_id TEXT NOT NULL,
        judge_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        status TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        verdict_json TEXT,
        error TEXT,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        FOREIGN KEY (challenge_id) REFERENCES challenges(id)
      );

      CREATE TABLE IF NOT EXISTS verdicts (
        id TEXT PRIMARY KEY,
        challenge_id TEXT NOT NULL UNIQUE,
        winner TEXT NOT NULL,
        method TEXT NOT NULL,
        votes_json TEXT NOT NULL,
        confidence REAL NOT NULL,
        payout_json TEXT NOT NULL,
        summary TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (challenge_id) REFERENCES challenges(id)
      );

      CREATE TABLE IF NOT EXISTS service_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_ledger_user_time ON ledger_entries(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_challenges_status_time ON challenges(status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_challenges_visibility_time ON challenges(visibility, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_challenges_side_a ON challenges(side_a_user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_challenges_side_b ON challenges(side_b_user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_challenge_order ON debate_messages(challenge_id, round_number, side);
      CREATE INDEX IF NOT EXISTS idx_locks_challenge ON challenge_locks(challenge_id);
      CREATE INDEX IF NOT EXISTS idx_withdrawals_user_time ON withdrawals(user_id, created_at DESC);
    `);
  }

  createSession(displayName?: string): SessionRecord {
    const createdAt = now();
    const userId = id('usr');
    const token = randomUUID().replaceAll('-', '');
    const txn = this.db.transaction(() => {
      this.db.query(`
        INSERT INTO users (id, entity_id, signer_id, display_name, created_at, last_seen_at)
        VALUES (?1, NULL, NULL, ?2, ?3, ?3)
      `).run(userId, displayName || `Debater ${userId.slice(-4)}`, createdAt);
      this.db.query(`
        INSERT INTO sessions (token, user_id, created_at, last_seen_at)
        VALUES (?1, ?2, ?3, ?3)
      `).run(token, userId, createdAt);
    });
    txn();
    return { token, userId, createdAt, lastSeenAt: createdAt };
  }

  createDemoUser(displayName: string): UserRecord {
    const at = now();
    const userId = id('demo');
    this.db.query(`
      INSERT INTO users (id, entity_id, signer_id, display_name, created_at, last_seen_at)
      VALUES (?1, NULL, NULL, ?2, ?3, ?3)
    `).run(userId, displayName, at);
    return this.getUser(userId)!;
  }

  getSessionByToken(token: string): SessionRecord | null {
    const row = this.db.query<{ token: string; user_id: string; created_at: number; last_seen_at: number }>(`
      SELECT token, user_id, created_at, last_seen_at FROM sessions WHERE token = ?1
    `).get(token);
    return row ? { token: row.token, userId: row.user_id, createdAt: row.created_at, lastSeenAt: row.last_seen_at } : null;
  }

  touchSession(token: string): SessionRecord | null {
    const touchedAt = now();
    this.db.query('UPDATE sessions SET last_seen_at = ?2 WHERE token = ?1').run(token, touchedAt);
    const session = this.getSessionByToken(token);
    if (session) {
      this.db.query('UPDATE users SET last_seen_at = ?2 WHERE id = ?1').run(session.userId, touchedAt);
    }
    return session;
  }

  getUser(userId: string): UserRecord | null {
    const row = this.db.query<{
      id: string; entity_id: string | null; signer_id: string | null; display_name: string | null; created_at: number; last_seen_at: number;
    }>('SELECT id, entity_id, signer_id, display_name, created_at, last_seen_at FROM users WHERE id = ?1').get(userId);
    return row ? {
      id: row.id,
      entityId: row.entity_id,
      signerId: row.signer_id,
      displayName: row.display_name,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
    } : null;
  }

  userExists(userId: string): boolean {
    return !!this.db.query<{ found: number }>('SELECT 1 AS found FROM users WHERE id = ?1 LIMIT 1').get(userId)?.found;
  }

  getBalances(userId: string): BalanceRecord[] {
    return this.db.query<BalanceRow>(`
      SELECT token_id, available_minor, locked_minor, spent_minor, updated_at
      FROM balances WHERE user_id = ?1 ORDER BY token_id ASC
    `).all(userId).map(row => ({
      tokenId: row.token_id,
      availableMinor: toBigInt(row.available_minor),
      lockedMinor: toBigInt(row.locked_minor),
      spentMinor: toBigInt(row.spent_minor),
      updatedAt: row.updated_at,
    }));
  }

  getBalance(userId: string, tokenId: number): BalanceRecord {
    const row = this.db.query<BalanceRow>(`
      SELECT token_id, available_minor, locked_minor, spent_minor, updated_at
      FROM balances WHERE user_id = ?1 AND token_id = ?2
    `).get(userId, tokenId);
    return row ? {
      tokenId: row.token_id,
      availableMinor: toBigInt(row.available_minor),
      lockedMinor: toBigInt(row.locked_minor),
      spentMinor: toBigInt(row.spent_minor),
      updatedAt: row.updated_at,
    } : { tokenId, availableMinor: 0n, lockedMinor: 0n, spentMinor: 0n, updatedAt: 0 };
  }

  private setBalance(userId: string, balance: BalanceRecord, updatedAt: number): void {
    this.db.query(`
      INSERT INTO balances (user_id, token_id, available_minor, locked_minor, spent_minor, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6)
      ON CONFLICT(user_id, token_id) DO UPDATE SET
        available_minor = excluded.available_minor,
        locked_minor = excluded.locked_minor,
        spent_minor = excluded.spent_minor,
        updated_at = excluded.updated_at
    `).run(
      userId,
      balance.tokenId,
      balance.availableMinor.toString(),
      balance.lockedMinor.toString(),
      balance.spentMinor.toString(),
      updatedAt,
    );
  }

  private addLedger(
    userId: string,
    tokenId: number,
    deltaAvailable: bigint,
    deltaLocked: bigint,
    deltaSpent: bigint,
    reason: string,
    referenceType?: string,
    referenceId?: string,
    createdAt = now(),
  ): void {
    this.db.query(`
      INSERT INTO ledger_entries (
        id, user_id, token_id, delta_available_minor, delta_locked_minor, delta_spent_minor,
        reason, reference_type, reference_id, created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
    `).run(
      id('led'),
      userId,
      tokenId,
      deltaAvailable.toString(),
      deltaLocked.toString(),
      deltaSpent.toString(),
      reason,
      referenceType || null,
      referenceId || null,
      createdAt,
    );
  }

  adjustBalance(input: {
    userId: string;
    tokenId: number;
    deltaAvailable?: bigint;
    deltaLocked?: bigint;
    deltaSpent?: bigint;
    reason: string;
    referenceType?: string;
    referenceId?: string;
  }): BalanceRecord {
    const at = now();
    const txn = this.db.transaction(() => {
      const current = this.getBalance(input.userId, input.tokenId);
      const next = {
        ...current,
        availableMinor: current.availableMinor + (input.deltaAvailable ?? 0n),
        lockedMinor: current.lockedMinor + (input.deltaLocked ?? 0n),
        spentMinor: current.spentMinor + (input.deltaSpent ?? 0n),
        updatedAt: at,
      };
      if (next.availableMinor < 0n || next.lockedMinor < 0n || next.spentMinor < 0n) {
        throw new Error('Balance cannot go negative');
      }
      this.setBalance(input.userId, next, at);
      this.addLedger(
        input.userId,
        input.tokenId,
        input.deltaAvailable ?? 0n,
        input.deltaLocked ?? 0n,
        input.deltaSpent ?? 0n,
        input.reason,
        input.referenceType,
        input.referenceId,
        at,
      );
      return next;
    });
    return txn();
  }

  fundDevBalance(userId: string, tokenId: number, amountMinor: bigint): BalanceRecord {
    return this.adjustBalance({
      userId,
      tokenId,
      deltaAvailable: amountMinor,
      reason: 'dev_fund',
      referenceType: 'dev',
      referenceId: randomUUID(),
    });
  }

  creditDeposit(input: {
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
    const txn = this.db.transaction((params: typeof input) => {
      const result = this.db.query(`
        INSERT INTO deposits (
          event_key, user_id, token_id, amount_minor, description, from_entity_id, hashlock, frame_height, created_at, started_at_ms
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
        ON CONFLICT(event_key) DO NOTHING
      `).run(
        params.eventKey,
        params.userId,
        params.tokenId,
        params.amountMinor.toString(),
        params.description,
        params.fromEntityId,
        params.hashlock,
        params.frameHeight,
        params.createdAt,
        params.startedAtMs ?? null,
      );
      const inserted = Number(result.changes) > 0;
      if (!inserted) return { inserted: false, credited: false };
      if (params.userId && this.userExists(params.userId)) {
        const current = this.getBalance(params.userId, params.tokenId);
        this.setBalance(params.userId, {
          ...current,
          availableMinor: current.availableMinor + params.amountMinor,
          updatedAt: params.createdAt,
        }, params.createdAt);
        this.addLedger(params.userId, params.tokenId, params.amountMinor, 0n, 0n, 'xln_deposit', 'deposit', params.eventKey, params.createdAt);
        return { inserted: true, credited: true };
      }
      return { inserted: true, credited: false };
    });
    return txn(input);
  }

  createChallenge(input: {
    userId: string;
    statement: string;
    sideALabel: string;
    sideBLabel: string;
    visibility: ChallengeVisibility;
    tokenId: number;
    stakeMinor: bigint;
    roundsTotal: number;
    messageLimitChars: number;
    context: unknown;
    rules: unknown;
    judgeBoard: JudgeConfig[];
  }): ChallengeRecord {
    const at = now();
    const challengeId = id('chl');
    const slug = slugify(input.statement);
    const inviteToken = randomUUID().replaceAll('-', '');
    const board = input.judgeBoard.length > 0 ? input.judgeBoard : defaultJudgeBoards['classic3']!;
    const txn = this.db.transaction(() => {
      this.db.query(`
        INSERT INTO challenges (
          id, slug, created_by_user_id, side_a_user_id, side_b_user_id, statement, side_a_label, side_b_label,
          status, visibility, token_id, stake_minor, payout_rule, rounds_total, current_round, message_limit_chars,
          turn_time_limit_sec, invite_token, rules_json, context_json, judge_board_json, created_at
        ) VALUES (?1, ?2, ?3, ?3, NULL, ?4, ?5, ?6, 'waiting_for_counterparty', ?7, ?8, ?9, 'winner_takes_all',
          ?10, 1, ?11, NULL, ?12, ?13, ?14, ?15, ?16)
      `).run(
        challengeId,
        slug,
        input.userId,
        input.statement,
        input.sideALabel,
        input.sideBLabel,
        input.visibility,
        input.tokenId,
        input.stakeMinor.toString(),
        input.roundsTotal,
        input.messageLimitChars,
        inviteToken,
        JSON.stringify(input.rules),
        JSON.stringify(input.context),
        JSON.stringify(board),
        at,
      );
      if (input.stakeMinor > 0n) {
        this.lockFunds(input.userId, input.tokenId, input.stakeMinor, challengeId, 'creator_stake');
      }
      return this.getChallengeBySlug(slug)!;
    });
    return txn();
  }

  private lockFunds(userId: string, tokenId: number, amountMinor: bigint, challengeId: string, reason: string): void {
    const current = this.getBalance(userId, tokenId);
    if (current.availableMinor < amountMinor) throw new Error('Insufficient available balance');
    const at = now();
    this.setBalance(userId, {
      ...current,
      availableMinor: current.availableMinor - amountMinor,
      lockedMinor: current.lockedMinor + amountMinor,
      updatedAt: at,
    }, at);
    this.addLedger(userId, tokenId, -amountMinor, amountMinor, 0n, reason, 'challenge', challengeId, at);
    this.db.query(`
      INSERT INTO challenge_locks (id, challenge_id, user_id, token_id, amount_minor, status, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, 'locked', ?6)
    `).run(id('lck'), challengeId, userId, tokenId, amountMinor.toString(), at);
  }

  acceptChallenge(slug: string, userId: string): ChallengeRecord {
    const at = now();
    const txn = this.db.transaction(() => {
      const challenge = this.getChallengeBySlug(slug);
      if (!challenge) throw new Error('Challenge not found');
      if (challenge.status !== 'waiting_for_counterparty') throw new Error('Challenge is not waiting for a counterparty');
      if (challenge.sideAUserId === userId) throw new Error('Creator cannot accept as counterparty');
      if (challenge.stakeMinor > 0n) {
        this.lockFunds(userId, challenge.tokenId, challenge.stakeMinor, challenge.id, 'counterparty_stake');
      }
      this.db.query(`
        UPDATE challenges
        SET side_b_user_id = ?2, status = 'active', accepted_at = ?3, started_at = ?3
        WHERE slug = ?1
      `).run(slug, userId, at);
      return this.getChallengeBySlug(slug)!;
    });
    return txn();
  }

  getChallengeBySlug(slug: string): ChallengeRecord | null {
    const row = this.db.query<ChallengeRow>(`
      SELECT
        id, slug, created_by_user_id AS createdByUserId, side_a_user_id AS sideAUserId, side_b_user_id AS sideBUserId,
        statement, side_a_label AS sideALabel, side_b_label AS sideBLabel, status, visibility, token_id AS tokenId,
        stake_minor AS stakeMinor, payout_rule AS payoutRule, rounds_total AS roundsTotal, current_round AS currentRound,
        message_limit_chars AS messageLimitChars, turn_time_limit_sec AS turnTimeLimitSec, invite_token AS inviteToken,
        rules_json AS rulesJson, context_json AS contextJson, judge_board_json AS judgeBoardJson, created_at AS createdAt,
        accepted_at AS acceptedAt, started_at AS startedAt, judging_started_at AS judgingStartedAt, finalized_at AS finalizedAt
      FROM challenges WHERE slug = ?1
    `).get(slug);
    return row ? { ...row, stakeMinor: toBigInt(row.stakeMinor) } : null;
  }

  getChallengeById(challengeId: string): ChallengeRecord | null {
    const slug = this.db.query<{ slug: string }>('SELECT slug FROM challenges WHERE id = ?1').get(challengeId)?.slug;
    return slug ? this.getChallengeBySlug(slug) : null;
  }

  listPublicChallenges(limit = 40): ChallengeRecord[] {
    return this.db.query<ChallengeRow>(`
      SELECT
        id, slug, created_by_user_id AS createdByUserId, side_a_user_id AS sideAUserId, side_b_user_id AS sideBUserId,
        statement, side_a_label AS sideALabel, side_b_label AS sideBLabel, status, visibility, token_id AS tokenId,
        stake_minor AS stakeMinor, payout_rule AS payoutRule, rounds_total AS roundsTotal, current_round AS currentRound,
        message_limit_chars AS messageLimitChars, turn_time_limit_sec AS turnTimeLimitSec, invite_token AS inviteToken,
        rules_json AS rulesJson, context_json AS contextJson, judge_board_json AS judgeBoardJson, created_at AS createdAt,
        accepted_at AS acceptedAt, started_at AS startedAt, judging_started_at AS judgingStartedAt, finalized_at AS finalizedAt
      FROM challenges
      WHERE visibility = 'public'
      ORDER BY created_at DESC
      LIMIT ?1
    `).all(limit).map(row => ({ ...row, stakeMinor: toBigInt(row.stakeMinor) }));
  }

  listUserChallenges(userId: string, limit = 40): ChallengeRecord[] {
    return this.db.query<ChallengeRow>(`
      SELECT
        id, slug, created_by_user_id AS createdByUserId, side_a_user_id AS sideAUserId, side_b_user_id AS sideBUserId,
        statement, side_a_label AS sideALabel, side_b_label AS sideBLabel, status, visibility, token_id AS tokenId,
        stake_minor AS stakeMinor, payout_rule AS payoutRule, rounds_total AS roundsTotal, current_round AS currentRound,
        message_limit_chars AS messageLimitChars, turn_time_limit_sec AS turnTimeLimitSec, invite_token AS inviteToken,
        rules_json AS rulesJson, context_json AS contextJson, judge_board_json AS judgeBoardJson, created_at AS createdAt,
        accepted_at AS acceptedAt, started_at AS startedAt, judging_started_at AS judgingStartedAt, finalized_at AS finalizedAt
      FROM challenges
      WHERE side_a_user_id = ?1 OR side_b_user_id = ?1 OR created_by_user_id = ?1
      ORDER BY created_at DESC
      LIMIT ?2
    `).all(userId, limit).map(row => ({ ...row, stakeMinor: toBigInt(row.stakeMinor) }));
  }

  getMessages(challengeId: string): DebateMessageRecord[] {
    return this.db.query<{
      id: string; challenge_id: string; round_number: number; side: DebateSide; user_id: string; body: string; body_hash: string; chars_count: number; created_at: number;
    }>(`
      SELECT id, challenge_id, round_number, side, user_id, body, body_hash, chars_count, created_at
      FROM debate_messages
      WHERE challenge_id = ?1
      ORDER BY round_number ASC, CASE side WHEN 'A' THEN 0 ELSE 1 END ASC
    `).all(challengeId).map(row => ({
      id: row.id,
      challengeId: row.challenge_id,
      roundNumber: row.round_number,
      side: row.side,
      userId: row.user_id,
      body: row.body,
      bodyHash: row.body_hash,
      charsCount: row.chars_count,
      createdAt: row.created_at,
    }));
  }

  addMessage(slug: string, userId: string, body: string): { challenge: ChallengeRecord; message: DebateMessageRecord } {
    const at = now();
    const txn = this.db.transaction(() => {
      const challenge = this.getChallengeBySlug(slug);
      if (!challenge) throw new Error('Challenge not found');
      if (challenge.status !== 'active') throw new Error('Challenge is not active');
      const cleanBody = String(body || '').trim();
      if (!cleanBody) throw new Error('Message is required');
      if (cleanBody.length > challenge.messageLimitChars) throw new Error(`Message exceeds ${challenge.messageLimitChars} characters`);
      const messages = this.getMessages(challenge.id);
      if (messages.length >= challenge.roundsTotal * 2) throw new Error('Debate transcript is complete');
      const expectedSide: DebateSide = messages.length % 2 === 0 ? 'A' : 'B';
      const expectedUser = expectedSide === 'A' ? challenge.sideAUserId : challenge.sideBUserId;
      if (expectedUser !== userId) throw new Error(`It is side ${expectedSide}'s turn`);
      const roundNumber = Math.floor(messages.length / 2) + 1;
      const message: DebateMessageRecord = {
        id: id('msg'),
        challengeId: challenge.id,
        roundNumber,
        side: expectedSide,
        userId,
        body: cleanBody,
        bodyHash: hash(cleanBody),
        charsCount: cleanBody.length,
        createdAt: at,
      };
      this.db.query(`
        INSERT INTO debate_messages (id, challenge_id, round_number, side, user_id, body, body_hash, chars_count, created_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
      `).run(message.id, message.challengeId, message.roundNumber, message.side, message.userId, message.body, message.bodyHash, message.charsCount, message.createdAt);
      const newCount = messages.length + 1;
      if (newCount >= challenge.roundsTotal * 2) {
        this.db.query("UPDATE challenges SET status = 'ready_for_judging', current_round = rounds_total WHERE id = ?1").run(challenge.id);
      } else {
        this.db.query('UPDATE challenges SET current_round = ?2 WHERE id = ?1').run(challenge.id, Math.floor(newCount / 2) + 1);
      }
      return { challenge: this.getChallengeBySlug(slug)!, message };
    });
    return txn();
  }

  addDemoMessage(challengeId: string, userId: string, roundNumber: number, side: DebateSide, body: string, createdAt: number): DebateMessageRecord {
    const message: DebateMessageRecord = {
      id: id('msg'),
      challengeId,
      roundNumber,
      side,
      userId,
      body,
      bodyHash: hash(body),
      charsCount: body.length,
      createdAt,
    };
    this.db.query(`
      INSERT INTO debate_messages (id, challenge_id, round_number, side, user_id, body, body_hash, chars_count, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
    `).run(message.id, message.challengeId, message.roundNumber, message.side, message.userId, message.body, message.bodyHash, message.charsCount, message.createdAt);
    return message;
  }

  beginJudging(challengeId: string): void {
    const at = now();
    this.db.query("UPDATE challenges SET status = 'judging', judging_started_at = ?2 WHERE id = ?1 AND status = 'ready_for_judging'")
      .run(challengeId, at);
  }

  markReadyForJudging(challengeId: string): void {
    this.db.query("UPDATE challenges SET status = 'ready_for_judging', current_round = rounds_total WHERE id = ?1 AND status = 'active'")
      .run(challengeId);
  }

  recordJudgeRun(input: {
    challengeId: string;
    judge: JudgeConfig;
    inputHash: string;
    verdict: JudgeVerdict;
  }): void {
    const at = now();
    this.db.query(`
      INSERT INTO judge_runs (id, challenge_id, judge_id, provider, model, status, input_hash, verdict_json, started_at, completed_at)
      VALUES (?1, ?2, ?3, ?4, ?5, 'completed', ?6, ?7, ?8, ?8)
    `).run(
      id('jrn'),
      input.challengeId,
      input.judge.id,
      input.judge.provider,
      input.judge.model,
      input.inputHash,
      JSON.stringify(input.verdict),
      at,
    );
  }

  finalizeVerdict(challengeId: string, aggregated: AggregatedVerdict): void {
    const at = now();
    const txn = this.db.transaction(() => {
      const challenge = this.getChallengeById(challengeId);
      if (!challenge) throw new Error('Challenge not found');
      if (challenge.status !== 'judging' && challenge.status !== 'ready_for_judging') {
        throw new Error('Challenge is not ready for verdict');
      }
      const locks = this.db.query<{ id: string; user_id: string; token_id: number; amount_minor: string }>(`
        SELECT id, user_id, token_id, amount_minor FROM challenge_locks
        WHERE challenge_id = ?1 AND status = 'locked'
      `).all(challengeId);
      const totalLocked = locks.reduce((sum, lock) => sum + toBigInt(lock.amount_minor), 0n);
      const winnerUserId = aggregated.winner === 'A'
        ? challenge.sideAUserId
        : aggregated.winner === 'B'
          ? challenge.sideBUserId
          : null;
      const payoutJson = {
        tokenId: challenge.tokenId,
        winner: aggregated.winner,
        winnerUserId,
        winnerAmountMinor: winnerUserId ? totalLocked.toString() : '0',
        platformFeeMinor: '0',
        inferenceFeeMinor: '0',
        scores1000: aggregated.scores1000,
        margin: aggregated.margin,
      };

      if (winnerUserId && totalLocked > 0n) {
        for (const lock of locks) {
          const amount = toBigInt(lock.amount_minor);
          const current = this.getBalance(lock.user_id, lock.token_id);
          this.setBalance(lock.user_id, {
            ...current,
            lockedMinor: current.lockedMinor - amount,
            updatedAt: at,
          }, at);
          this.addLedger(lock.user_id, lock.token_id, 0n, -amount, 0n, 'challenge_released_from_escrow', 'challenge', challengeId, at);
        }
        const winnerBalance = this.getBalance(winnerUserId, challenge.tokenId);
        this.setBalance(winnerUserId, {
          ...winnerBalance,
          availableMinor: winnerBalance.availableMinor + totalLocked,
          updatedAt: at,
        }, at);
        this.addLedger(winnerUserId, challenge.tokenId, totalLocked, 0n, 0n, 'challenge_winnings', 'challenge', challengeId, at);
      } else {
        for (const lock of locks) {
          const amount = toBigInt(lock.amount_minor);
          const current = this.getBalance(lock.user_id, lock.token_id);
          this.setBalance(lock.user_id, {
            ...current,
            availableMinor: current.availableMinor + amount,
            lockedMinor: current.lockedMinor - amount,
            updatedAt: at,
          }, at);
          this.addLedger(lock.user_id, lock.token_id, amount, -amount, 0n, 'challenge_draw_refund', 'challenge', challengeId, at);
        }
      }

      this.db.query("UPDATE challenge_locks SET status = 'released', released_at = ?2 WHERE challenge_id = ?1 AND status = 'locked'")
        .run(challengeId, at);
      this.db.query(`
        INSERT INTO verdicts (id, challenge_id, winner, method, votes_json, confidence, payout_json, summary, created_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
      `).run(
        id('vdt'),
        challengeId,
        aggregated.winner,
        aggregated.method,
        JSON.stringify(aggregated.votes),
        aggregated.confidence,
        JSON.stringify(payoutJson),
        aggregated.summary,
        at,
      );
      this.db.query("UPDATE challenges SET status = 'finalized', finalized_at = ?2 WHERE id = ?1").run(challengeId, at);
    });
    txn();
  }

  getVerdict(challengeId: string) {
    return this.db.query<{
      id: string; challenge_id: string; winner: string; method: string; votes_json: string; confidence: number; payout_json: string; summary: string; created_at: number;
    }>(`
      SELECT id, challenge_id, winner, method, votes_json, confidence, payout_json, summary, created_at
      FROM verdicts WHERE challenge_id = ?1
    `).get(challengeId);
  }

  getJudgeRuns(challengeId: string) {
    return this.db.query<{
      id: string; judge_id: string; provider: string; model: string; status: string; input_hash: string; verdict_json: string | null; error: string | null; started_at: number; completed_at: number | null;
    }>(`
      SELECT id, judge_id, provider, model, status, input_hash, verdict_json, error, started_at, completed_at
      FROM judge_runs WHERE challenge_id = ?1 ORDER BY started_at ASC
    `).all(challengeId);
  }

  createWithdrawal(input: {
    userId: string;
    tokenId: number;
    amountMinor: bigint;
    targetEntityId: string;
    feeMinor?: bigint;
    hashlock?: string;
    routeJson?: string;
    offlineFinalized?: boolean;
  }): WithdrawalRecord {
    const at = now();
    const withdrawalId = id('wd');
    const feeMinor = input.feeMinor ?? 0n;
    const total = input.amountMinor + feeMinor;
    const txn = this.db.transaction(() => {
      const current = this.getBalance(input.userId, input.tokenId);
      if (current.availableMinor < total) throw new Error('Insufficient available balance');
      this.setBalance(input.userId, {
        ...current,
        availableMinor: current.availableMinor - total,
        spentMinor: current.spentMinor + feeMinor,
        updatedAt: at,
      }, at);
      this.addLedger(input.userId, input.tokenId, -total, 0n, feeMinor, 'withdrawal_reserved', 'withdrawal', withdrawalId, at);
      this.db.query(`
        INSERT INTO withdrawals (
          id, user_id, token_id, amount_minor, requested_amount_minor, fee_minor, target_entity_id, description,
          status, hashlock, route_json, created_at, updated_at, finalized_at, started_at_ms
        ) VALUES (?1, ?2, ?3, ?4, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11, ?12, ?11)
      `).run(
        withdrawalId,
        input.userId,
        input.tokenId,
        total.toString(),
        feeMinor.toString(),
        input.targetEntityId,
        `debates-withdrawal:${withdrawalId}`,
        input.offlineFinalized ? 'finalized' : 'sent',
        input.hashlock || `offline_${withdrawalId}`,
        input.routeJson || null,
        at,
        input.offlineFinalized ? at : null,
      );
      return this.getWithdrawal(withdrawalId)!;
    });
    return txn();
  }

  reserveWithdrawal(input: {
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
    const txn = this.db.transaction((params: typeof input) => {
      const current = this.getBalance(params.userId, params.tokenId);
      if (current.availableMinor < params.amountMinor) throw new Error('Insufficient available balance');
      this.setBalance(params.userId, {
        ...current,
        availableMinor: current.availableMinor - params.amountMinor,
        spentMinor: current.spentMinor + params.feeMinor,
        updatedAt: params.createdAt,
      }, params.createdAt);
      this.addLedger(params.userId, params.tokenId, -params.amountMinor, 0n, params.feeMinor, 'withdrawal_reserved', 'withdrawal', params.id, params.createdAt);
      this.db.query(`
        INSERT INTO withdrawals (
          id, user_id, token_id, amount_minor, requested_amount_minor, fee_minor, target_entity_id, description,
          status, hashlock, route_json, frame_height, created_at, updated_at, finalized_at, daemon_error, started_at_ms
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'submitting', NULL, NULL, NULL, ?9, ?9, NULL, NULL, ?10)
      `).run(
        params.id,
        params.userId,
        params.tokenId,
        params.amountMinor.toString(),
        params.requestedAmountMinor.toString(),
        params.feeMinor.toString(),
        params.targetEntityId,
        params.description,
        params.createdAt,
        params.startedAtMs ?? null,
      );
      return this.getWithdrawal(params.id)!;
    });
    return txn(input);
  }

  markWithdrawalSent(input: { id: string; hashlock: string; routeJson: string; updatedAt: number }): WithdrawalRecord | null {
    this.db.query(`
      UPDATE withdrawals
      SET status = 'sent', hashlock = ?2, route_json = ?3, updated_at = ?4, daemon_error = NULL
      WHERE id = ?1 AND status = 'submitting'
    `).run(input.id, input.hashlock, input.routeJson, input.updatedAt);
    return this.getWithdrawal(input.id);
  }

  failWithdrawalById(input: { id: string; error: string; updatedAt: number; restoreBalance: boolean }): WithdrawalRecord | null {
    const txn = this.db.transaction((params: typeof input) => {
      const withdrawal = this.getWithdrawal(params.id);
      if (!withdrawal) return null;
      if (params.restoreBalance && withdrawal.status === 'submitting') {
        const current = this.getBalance(withdrawal.userId, withdrawal.tokenId);
        this.setBalance(withdrawal.userId, {
          ...current,
          availableMinor: current.availableMinor + withdrawal.amountMinor,
          spentMinor: current.spentMinor >= withdrawal.feeMinor ? current.spentMinor - withdrawal.feeMinor : current.spentMinor,
          updatedAt: params.updatedAt,
        }, params.updatedAt);
        this.addLedger(withdrawal.userId, withdrawal.tokenId, withdrawal.amountMinor, 0n, -withdrawal.feeMinor, 'withdrawal_failed_restore', 'withdrawal', withdrawal.id, params.updatedAt);
      }
      this.db.query(`
        UPDATE withdrawals
        SET status = 'failed', daemon_error = ?2, updated_at = ?3, finalized_at = ?3
        WHERE id = ?1
      `).run(params.id, params.error, params.updatedAt);
      return this.getWithdrawal(params.id);
    });
    return txn(input);
  }

  finalizeWithdrawalByHashlock(input: { hashlock: string; frameHeight: number; updatedAt: number }): WithdrawalRecord | null {
    this.db.query(`
      UPDATE withdrawals
      SET status = 'finalized', frame_height = ?2, updated_at = ?3, finalized_at = ?3
      WHERE hashlock = ?1 AND status IN ('submitting', 'sent')
    `).run(input.hashlock, input.frameHeight, input.updatedAt);
    return this.getWithdrawalByHashlock(input.hashlock);
  }

  failWithdrawalByHashlock(input: { hashlock: string; error: string; frameHeight: number; updatedAt: number }): WithdrawalRecord | null {
    const txn = this.db.transaction((params: typeof input) => {
      const withdrawal = this.getWithdrawalByHashlock(params.hashlock);
      if (!withdrawal) return null;
      if (withdrawal.status !== 'failed') {
        const current = this.getBalance(withdrawal.userId, withdrawal.tokenId);
        this.setBalance(withdrawal.userId, {
          ...current,
          availableMinor: current.availableMinor + withdrawal.amountMinor,
          spentMinor: current.spentMinor >= withdrawal.feeMinor ? current.spentMinor - withdrawal.feeMinor : current.spentMinor,
          updatedAt: params.updatedAt,
        }, params.updatedAt);
        this.addLedger(withdrawal.userId, withdrawal.tokenId, withdrawal.amountMinor, 0n, -withdrawal.feeMinor, 'withdrawal_failed_restore', 'withdrawal', withdrawal.id, params.updatedAt);
      }
      this.db.query(`
        UPDATE withdrawals
        SET status = 'failed', daemon_error = ?2, frame_height = ?3, updated_at = ?4, finalized_at = ?4
        WHERE hashlock = ?1
      `).run(params.hashlock, params.error, params.frameHeight, params.updatedAt);
      return this.getWithdrawalByHashlock(params.hashlock);
    });
    return txn(input);
  }

  getWithdrawalByHashlock(hashlock: string): WithdrawalRecord | null {
    const row = this.db.query<{ id: string }>('SELECT id FROM withdrawals WHERE hashlock = ?1 LIMIT 1').get(hashlock);
    return row ? this.getWithdrawal(row.id) : null;
  }

  recoverSubmittingWithdrawals(errorMessage: string): number {
    const rows = this.db.query<{ id: string }>("SELECT id FROM withdrawals WHERE status = 'submitting'").all();
    const at = now();
    const txn = this.db.transaction((items: typeof rows) => {
      for (const item of items) {
        this.failWithdrawalById({ id: item.id, error: errorMessage, updatedAt: at, restoreBalance: true });
      }
    });
    txn(rows);
    return rows.length;
  }

  getWithdrawal(withdrawalId: string): WithdrawalRecord | null {
    const row = this.db.query<{
      id: string; user_id: string; token_id: number; amount_minor: string; requested_amount_minor: string; fee_minor: string; target_entity_id: string;
      description: string; status: WithdrawalStatus; hashlock: string | null; route_json: string | null; frame_height: number | null; created_at: number; updated_at: number;
      finalized_at: number | null; daemon_error: string | null; started_at_ms: number | null;
    }>('SELECT * FROM withdrawals WHERE id = ?1').get(withdrawalId);
    return row ? {
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
      frameHeight: row.frame_height,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      finalizedAt: row.finalized_at,
      daemonError: row.daemon_error,
      startedAtMs: row.started_at_ms,
    } : null;
  }

  getRecentLedger(userId: string, limit = 40) {
    return this.db.query<{
      id: string; token_id: number; delta_available_minor: string; delta_locked_minor: string; delta_spent_minor: string; reason: string; reference_type: string | null; reference_id: string | null; created_at: number;
    }>(`
      SELECT id, token_id, delta_available_minor, delta_locked_minor, delta_spent_minor, reason, reference_type, reference_id, created_at
      FROM ledger_entries WHERE user_id = ?1 ORDER BY created_at DESC LIMIT ?2
    `).all(userId, limit);
  }

  getStateNumber(key: string, fallback = 0): number {
    const row = this.db.query<{ value: string }>('SELECT value FROM service_state WHERE key = ?1').get(key);
    if (!row) return fallback;
    const parsed = Number(row.value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  setStateNumber(key: string, value: number): void {
    this.db.query(`
      INSERT INTO service_state (key, value)
      VALUES (?1, ?2)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, String(value));
  }

  parseChallengePayload(challenge: ChallengeRecord) {
    return {
      ...challenge,
      stakeMinor: challenge.stakeMinor.toString(),
      rules: parseJson(challenge.rulesJson, {}),
      context: parseJson(challenge.contextJson, {}),
      judgeBoard: parseJson<JudgeConfig[]>(challenge.judgeBoardJson, []),
    };
  }

  inputHashForChallenge(challenge: ChallengeRecord, messages: DebateMessageRecord[]): string {
    return hash(JSON.stringify({
      challengeId: challenge.id,
      statement: challenge.statement,
      rules: challenge.rulesJson,
      context: challenge.contextJson,
      messages: messages.map(message => ({
        roundNumber: message.roundNumber,
        side: message.side,
        bodyHash: message.bodyHash,
      })),
    }));
  }
}
