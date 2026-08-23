/**
 * Shadow mirror: replays every committed bilateral Account frame of the owning
 * entity into the Rust account engine and compares the per-account state root
 * (and the whole-tree accounts root) against the TypeScript authority.
 *
 * The mirror never influences consensus: it is fed fire-and-forget from the
 * frame-commit path, runs on its own queue, and on any internal failure
 * disables itself loudly. Divergences are counted and logged, never thrown
 * into the caller.
 *
 * Account lifecycle: the first time an account is seen (and after any frame
 * carrying txs outside the payment profile, or after a divergence) the mirror
 * reseeds it from the committed post-frame snapshot via UpsertAccounts, and
 * comparison resumes from the next frame.
 */
import { sha256 } from '@noble/hashes/sha2.js';

import { createStructuredLogger } from '../support/logger';
import type { AccountReplica, AccountTx } from '../types/account';
import type { RscoreProcessClient, RscoreWireValue } from './client';
import {
  SHADOW_SUPPORTED_TX_TYPES,
  accountSeedWire,
  accountTxWire,
  hexToWireBytes,
  shadowIneligibilityReason,
} from './shadow-wire';

const shadowLog = createStructuredLogger('rscore.shadow');

const MAX_QUEUE = 50_000;

export type ShadowFrameInput = Readonly<{
  ownerEntityId: string;
  counterpartyEntityId: string;
  frameHeight: number;
  byLeft: boolean;
  timestamp: number;
  jHeight: number;
  enforcementTimestamp: number;
  enforcementJHeight: number;
  accountTxs: readonly AccountTx[];
  /** TS authority root committed by this frame (hex). */
  committedStateRoot: string;
  /** Committed post-frame replica, read synchronously at note time. */
  account: AccountReplica;
}>;

type QueueEntry = Readonly<{
  kind: 'wave';
  accountKey: string;
  jobs: RscoreWireValue[][];
  expectedRootHex: string;
  frameHeight: number;
}> | Readonly<{
  kind: 'reseed';
  accountKey: string;
  seed: RscoreWireValue[];
  reason: string;
  frameHeight: number;
}>;

export type ShadowStats = {
  framesSeen: number;
  framesCompared: number;
  matches: number;
  mismatches: number;
  reseeds: number;
  skippedIneligible: number;
  dropped: number;
  disabledReason: string | null;
};

export class RscoreShadowMirror {
  readonly #binaryPath: string;
  readonly #workers: number;
  readonly #makeClient: (binaryPath: string) => RscoreProcessClient;
  #client: RscoreProcessClient | null = null;
  #started = false;
  readonly #registered = new Set<string>();
  readonly #needsReseed = new Set<string>();
  readonly #queue: QueueEntry[] = [];
  #draining = false;
  #disabledReason: string | null = null;
  readonly #stats: ShadowStats = {
    framesSeen: 0,
    framesCompared: 0,
    matches: 0,
    mismatches: 0,
    reseeds: 0,
    skippedIneligible: 0,
    dropped: 0,
    disabledReason: null,
  };
  #idle: Promise<void> = Promise.resolve();
  #idleResolve: (() => void) | null = null;

  constructor(options: Readonly<{
    binaryPath: string;
    workers: number;
    makeClient: (binaryPath: string) => RscoreProcessClient;
  }>) {
    this.#binaryPath = options.binaryPath;
    this.#workers = options.workers;
    this.#makeClient = options.makeClient;
  }

  stats(): ShadowStats {
    return { ...this.#stats, disabledReason: this.#disabledReason };
  }

  /** Resolves when the queue has fully drained — test/shutdown ordering only. */
  settled(): Promise<void> {
    return this.#idle;
  }

  noteCommittedFrame(input: ShadowFrameInput): void {
    if (this.#disabledReason) return;
    this.#stats.framesSeen += 1;
    // One mirror serves every local entity: the engine-side account id is the
    // hash of the (owner, counterparty) pair so two entities sharing a
    // counterparty never collide on one leaf.
    const accountIdBytes = pairAccountId(input.ownerEntityId, input.counterpartyEntityId);
    const accountKey = Buffer.from(accountIdBytes).toString('hex');
    if (process.env['XLN_RSCORE_SHADOW_TRACE'] === '1') {
      try {
        console.error(`SHADOW_TRACE note ${accountKey.slice(0, 8)} h${input.frameHeight} byLeft=${input.byLeft} txs=[${input.accountTxs.map(tx => tx.type).join(',')}] registered=${this.#registered.has(accountKey)} needsReseed=${this.#needsReseed.has(accountKey)}`);
      } catch { /* observer-only */ }
    }
    try {
      const supported = input.accountTxs.every(tx => SHADOW_SUPPORTED_TX_TYPES.has(tx.type));
      const fresh = !this.#registered.has(accountKey) || this.#needsReseed.has(accountKey);
      if (!supported || fresh) {
        const reason = shadowIneligibilityReason(input.account);
        if (reason !== null) {
          if (process.env['XLN_RSCORE_SHADOW_TRACE'] === '1') {
            try { console.error(`SHADOW_TRACE ineligible ${accountKey.slice(0, 8)} h${input.frameHeight} ${reason}`); } catch { /* observer-only */ }
          }
          // Live out-of-profile state: cannot seed. Forget the account; a
          // later clean snapshot re-registers it.
          this.#registered.delete(accountKey);
          this.#needsReseed.delete(accountKey);
          this.#stats.skippedIneligible += 1;
          return;
        }
        const seed = accountSeedWire(input.ownerEntityId, input.counterpartyEntityId, input.account);
        seed[0] = accountIdBytes;
        this.#push({
          kind: 'reseed',
          accountKey,
          seed,
          reason: fresh ? 'register' : 'unsupported-tx',
          frameHeight: input.frameHeight,
        });
        this.#registered.add(accountKey);
        this.#needsReseed.delete(accountKey);
        return;
      }
      const jobs: RscoreWireValue[][] = [];
      for (const [index, tx] of input.accountTxs.entries()) {
        const wire = accountTxWire(tx);
        if (wire === null) throw new Error(`SHADOW_TX_UNSUPPORTED:${tx.type}`);
        jobs.push([
          index,
          accountIdBytes,
          input.byLeft ? 0 : 1,
          [input.timestamp, input.enforcementTimestamp, input.enforcementJHeight, input.frameHeight - 1],
          wire,
        ]);
      }
      if (jobs.length === 0) {
        // Empty frames commit no state change worth a wave; verify via reseed
        // no-op instead of an empty (refused) batch.
        return;
      }
      this.#push({
        kind: 'wave',
        accountKey,
        jobs,
        expectedRootHex: input.committedStateRoot.trim().toLowerCase().replace(/^0x/, ''),
        frameHeight: input.frameHeight,
      });
    } catch (error) {
      this.#disable(`note:${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async shutdown(): Promise<void> {
    await this.#idle;
    if (this.#client) {
      try { await this.#client.shutdown(); } catch { /* already down */ }
      this.#client.kill();
      this.#client = null;
    }
  }

  #push(entry: QueueEntry): void {
    if (this.#queue.length >= MAX_QUEUE) {
      this.#stats.dropped += 1;
      // A dropped frame breaks the replay continuity for that account.
      this.#needsReseed.add(entry.accountKey);
      return;
    }
    this.#queue.push(entry);
    if (!this.#draining) {
      this.#draining = true;
      this.#idle = new Promise(resolve => { this.#idleResolve = resolve; });
      void this.#drain();
    }
  }

  async #drain(): Promise<void> {
    let lastEntry: QueueEntry | null = null;
    try {
      const client = await this.#ensureClient();
      while (this.#queue.length > 0) {
        const entry = this.#queue.shift()!;
        lastEntry = entry;
        if (entry.kind === 'reseed') {
          await client.upsertAccounts([entry.seed]);
          this.#stats.reseeds += 1;
          continue;
        }
        const prepared = (await client.prepare(entry.jobs)) as unknown[];
        const results = prepared[2] as unknown[];
        const rejected = results
          .map((row, index) => ({ verdict: (row as unknown[])[2] as unknown[], index }))
          .filter(({ verdict }) => Number(verdict[0]) !== 0);
        await client.commit(client.requestIdBytes(client.lastRequestId));
        this.#stats.framesCompared += 1;
        if (rejected.length > 0) {
          this.#recordMismatch(entry, `rejected:${JSON.stringify(rejected[0]?.verdict ?? null)}:job=${JSON.stringify(entry.jobs[rejected[0]?.index ?? 0]?.[4] ?? null, (_key, value) => (value instanceof Uint8Array || Buffer.isBuffer(value) ? 'bytes' : (value as unknown)))}`);
          continue;
        }
        const roots = prepared[4] as unknown[];
        const row = roots.find(candidate =>
          Buffer.from((candidate as unknown[])[0] as Uint8Array).toString('hex') === entry.accountKey);
        const actual = row ? Buffer.from((row as unknown[])[1] as Uint8Array).toString('hex') : 'missing';
        if (actual === entry.expectedRootHex) {
          this.#stats.matches += 1;
        } else {
          this.#recordMismatch(entry, `root:${actual}`);
        }
      }
    } catch (error) {
      const context = lastEntry
        ? `${lastEntry.kind}:h${lastEntry.frameHeight}:${JSON.stringify(
            lastEntry.kind === 'wave' ? lastEntry.jobs : lastEntry.seed,
            (_key, value) => {
              if (value instanceof Uint8Array || Buffer.isBuffer(value)) return `0x${Buffer.from(value as Uint8Array).toString('hex').slice(0, 16)}`;
              return value;
            },
          ).slice(0, 600)}`
        : 'idle';
      this.#disable(`drain:${error instanceof Error ? error.message : String(error)}:${context}`);
    } finally {
      this.#draining = false;
      this.#idleResolve?.();
      this.#idleResolve = null;
      if (this.#queue.length > 0 && !this.#disabledReason) {
        this.#draining = true;
        this.#idle = new Promise(resolve => { this.#idleResolve = resolve; });
        void this.#drain();
      }
    }
  }

  #recordMismatch(entry: Extract<QueueEntry, { kind: 'wave' }>, detail: string): void {
    this.#stats.mismatches += 1;
    this.#needsReseed.add(entry.accountKey);
    // Logging must never take the mirror down (scenario harnesses may turn
    // console.error into a thrown failure).
    try {
      shadowLog.error('shadow.divergence', {
        account: entry.accountKey,
        frameHeight: entry.frameHeight,
        expected: entry.expectedRootHex,
        detail,
      });
    } catch { /* observer-only */ }
  }

  async #ensureClient(): Promise<RscoreProcessClient> {
    if (this.#client && this.#started) return this.#client;
    const client = this.#makeClient(this.#binaryPath);
    await client.hello(this.#workers);
    await client.restore(0, []);
    this.#client = client;
    this.#started = true;
    return client;
  }

  #disable(reason: string): void {
    this.#disabledReason = reason;
    this.#stats.disabledReason = reason;
    this.#queue.length = 0;
    try {
      shadowLog.error('shadow.disabled', { reason });
    } catch { /* observer-only */ }
    if (this.#client) {
      this.#client.kill();
      this.#client = null;
    }
  }
}

/** Engine-side account id: sha256(ownerEntityId32 || counterpartyEntityId32). */
const pairAccountId = (ownerEntityId: string, counterpartyEntityId: string): Uint8Array => {
  const preimage = new Uint8Array(64);
  preimage.set(hexToWireBytes(ownerEntityId, 32, 'SHADOW_OWNER'), 0);
  preimage.set(hexToWireBytes(counterpartyEntityId, 32, 'SHADOW_ACCOUNT_ID'), 32);
  return sha256(preimage);
};
