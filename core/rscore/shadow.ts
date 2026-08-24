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
import { createStructuredLogger } from '../support/logger';
import { requirePersistentAccountStateMap } from '../account/state/persistent-state-map';
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
/**
 * One engine process per owner entity means an unbounded stand (a lane with a
 * thousand user entities) would fork a thousand processes. Shadow is a
 * diagnostic, so it binds to the first N owners it sees and ignores the rest;
 * a hub-only run is the intended shape (N=1).
 */
const DEFAULT_MAX_OWNERS = 1;
/** Progress reporting cadence, in compared frames. */
const PROGRESS_EVERY = 500;
/**
 * Whole-tree reconciliation cadence, in compared frames. Per-frame comparison
 * only covers frames the mirror replayed; a periodic full diff also catches an
 * account that silently stopped being mirrored. 0 disables it.
 */
const RECONCILE_EVERY = Number(
  (typeof process === 'undefined' ? undefined : process.env['XLN_RSCORE_SHADOW_RECONCILE_EVERY'])
  ?? '0',
);

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
  ownerKey: string;
  accountKey: string;
  jobs: RscoreWireValue[][];
  expectedRootHex: string;
  frameHeight: number;
}> | Readonly<{
  kind: 'reseed';
  ownerKey: string;
  accountKey: string;
  seed: RscoreWireValue[];
  reason: string;
  frameHeight: number;
}>;

export type ShadowReconciliationMismatch = Readonly<{
  accountId: string;
  deltasRoot: Readonly<{ typescript: string; rust: string }>;
  locksRoot: Readonly<{ typescript: string; rust: string }>;
}>;

export type ShadowReconciliation = Readonly<{
  matched: number;
  mismatched: readonly ShadowReconciliationMismatch[];
  missingInEngine: readonly string[];
  extraInEngine: readonly string[];
}>;

export type ShadowStats = {
  framesSeen: number;
  framesCompared: number;
  matches: number;
  mismatches: number;
  reseeds: number;
  /** Frames carrying no account txs: nothing to replay, nothing to compare. */
  emptyFrames: number;
  skippedIneligible: number;
  /** Why accounts were refused, by out-of-profile section. */
  ineligibleReasons: Record<string, number>;
  /**
   * Account tx types the engine cannot replay, by count. These force a reseed
   * instead of a comparison, so this is the exact remaining port list for
   * parity across the entity's whole account interface.
   */
  unsupportedTxTypes: Record<string, number>;
  skippedUnboundOwner: number;
  dropped: number;
  /** Whole-tree diffs run mid-flight, and how many found a gap. */
  reconciliations: number;
  reconcileFailures: number;
  disabledReason: string | null;
};

export class RscoreShadowMirror {
  readonly #binaryPath: string;
  readonly #workers: number;
  readonly #makeClient: (binaryPath: string) => RscoreProcessClient;
  readonly #clients = new Map<string, RscoreProcessClient>();
  readonly #boundOwners = new Set<string>();
  readonly #maxOwners: number;
  readonly #registered = new Set<string>();
  /**
   * Live replica references, per owner, for self-reconciliation. These are the
   * very objects the entity owns and mutates in place, so the map stays
   * current without copying state; it retains nothing the entity has not
   * already retained.
   */
  readonly #mirrored = new Map<string, Map<string, AccountReplica>>();
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
    emptyFrames: 0,
    skippedIneligible: 0,
    ineligibleReasons: {},
    unsupportedTxTypes: {},
    skippedUnboundOwner: 0,
    dropped: 0,
    reconciliations: 0,
    reconcileFailures: 0,
    disabledReason: null,
  };
  #onProgress: (() => void) | null = null;
  #idle: Promise<void> = Promise.resolve();
  #idleResolve: (() => void) | null = null;

  constructor(options: Readonly<{
    binaryPath: string;
    workers: number;
    maxOwners?: number;
    makeClient: (binaryPath: string) => RscoreProcessClient;
  }>) {
    this.#binaryPath = options.binaryPath;
    this.#workers = options.workers;
    this.#maxOwners = options.maxOwners ?? DEFAULT_MAX_OWNERS;
    this.#makeClient = options.makeClient;
  }

  /** Observer hook: called every PROGRESS_EVERY compared frames. */
  onProgress(callback: () => void): void {
    this.#onProgress = callback;
  }

  stats(): ShadowStats {
    return {
      ...this.#stats,
      ineligibleReasons: { ...this.#stats.ineligibleReasons },
      unsupportedTxTypes: { ...this.#stats.unsupportedTxTypes },
      disabledReason: this.#disabledReason,
    };
  }

  /**
   * Whole-tree reconciliation: page every account the engine holds and compare
   * it against the authoritative TypeScript map, leaf by leaf. Per-frame
   * comparison only covers frames the mirror chose to replay; this covers the
   * entire committed tree, so accounts that were skipped, dropped or never
   * seen show up as gaps instead of passing silently. Intended for the end of
   * a deterministic replay: identical trees mean the two engines are
   * interchangeable across a crash.
   */
  async reconcile(
    ownerEntityId: string,
    accounts: ReadonlyMap<string, AccountReplica>,
  ): Promise<ShadowReconciliation> {
    const ownerKey = ownerEntityId.trim().toLowerCase();
    const client = await this.#ensureClient(ownerKey);
    const engineRows = new Map<string, { deltasRoot: string; locksRoot: string }>();
    let cursor: Uint8Array | null = null;
    for (;;) {
      const page = (await client.readAccountSummaryPage(cursor, 512, [])) as unknown[];
      for (const row of page[1] as unknown[]) {
        const fields = row as unknown[];
        engineRows.set(`0x${Buffer.from(fields[0] as Uint8Array).toString('hex')}`, {
          deltasRoot: `0x${Buffer.from(fields[4] as Uint8Array).toString('hex')}`,
          locksRoot: `0x${Buffer.from(fields[5] as Uint8Array).toString('hex')}`,
        });
      }
      const next = page[2];
      if (next === null || next === undefined) break;
      cursor = next as Uint8Array;
    }

    const matched: string[] = [];
    const mismatched: ShadowReconciliationMismatch[] = [];
    const missingInEngine: string[] = [];
    for (const [counterpartyId, account] of accounts) {
      const key = counterpartyId.trim().toLowerCase();
      const engine = engineRows.get(key);
      if (!engine) {
        missingInEngine.push(key);
        continue;
      }
      engineRows.delete(key);
      const deltasRoot = requirePersistentAccountStateMap(account.state.deltas, 'deltas')
        .rootHash().toLowerCase();
      const locksRoot = requirePersistentAccountStateMap(account.state.locks, 'locks')
        .rootHash().toLowerCase();
      if (engine.deltasRoot === deltasRoot && engine.locksRoot === locksRoot) {
        matched.push(key);
        continue;
      }
      mismatched.push({
        accountId: key,
        deltasRoot: { typescript: deltasRoot, rust: engine.deltasRoot },
        locksRoot: { typescript: locksRoot, rust: engine.locksRoot },
      });
    }
    return {
      matched: matched.length,
      mismatched,
      missingInEngine,
      extraInEngine: [...engineRows.keys()],
    };
  }

  /** Resolves when the queue has fully drained — test/shutdown ordering only. */
  settled(): Promise<void> {
    return this.#idle;
  }

  noteCommittedFrame(input: ShadowFrameInput): void {
    if (this.#disabledReason) return;
    this.#stats.framesSeen += 1;
    // Parity with the entity machine: the account key is the raw 32-byte
    // counterparty entity id, never a hash. Owners are separated by running
    // one engine process per owner entity, exactly the way the entity machine
    // owns exactly one account map.
    const ownerKey = input.ownerEntityId.trim().toLowerCase();
    if (!this.#boundOwners.has(ownerKey)) {
      if (this.#boundOwners.size >= this.#maxOwners) {
        this.#stats.skippedUnboundOwner += 1;
        return;
      }
      this.#boundOwners.add(ownerKey);
    }
    const accountIdBytes = hexToWireBytes(input.counterpartyEntityId, 32, 'SHADOW_ACCOUNT_ID');
    const accountKey = Buffer.from(accountIdBytes).toString('hex');
    const scopedKey = `${ownerKey}/${accountKey}`;
    if (process.env['XLN_RSCORE_SHADOW_TRACE'] === '1') {
      try {
        console.error(`SHADOW_TRACE note ${accountKey.slice(0, 8)} h${input.frameHeight} byLeft=${input.byLeft} txs=[${input.accountTxs.map(tx => tx.type).join(',')}] registered=${this.#registered.has(scopedKey)} needsReseed=${this.#needsReseed.has(scopedKey)}`);
      } catch { /* observer-only */ }
    }
    try {
      const unsupported = input.accountTxs.filter(tx => !SHADOW_SUPPORTED_TX_TYPES.has(tx.type));
      for (const tx of unsupported) {
        this.#stats.unsupportedTxTypes[tx.type] = (this.#stats.unsupportedTxTypes[tx.type] ?? 0) + 1;
      }
      const supported = unsupported.length === 0;
      const fresh = !this.#registered.has(scopedKey) || this.#needsReseed.has(scopedKey);
      if (!supported || fresh) {
        const reason = shadowIneligibilityReason(input.account);
        if (reason !== null) {
          if (process.env['XLN_RSCORE_SHADOW_TRACE'] === '1') {
            try { console.error(`SHADOW_TRACE ineligible ${accountKey.slice(0, 8)} h${input.frameHeight} ${reason}`); } catch { /* observer-only */ }
          }
          // Live out-of-profile state: cannot seed. Forget the account; a
          // later clean snapshot re-registers it.
          this.#registered.delete(scopedKey);
          this.#needsReseed.delete(scopedKey);
          this.#stats.skippedIneligible += 1;
          this.#stats.ineligibleReasons[reason] = (this.#stats.ineligibleReasons[reason] ?? 0) + 1;
          return;
        }
        const seed = accountSeedWire(input.ownerEntityId, input.counterpartyEntityId, input.account);
        this.#push({
          kind: 'reseed',
          ownerKey,
          accountKey,
          seed,
          reason: fresh ? 'register' : 'unsupported-tx',
          frameHeight: input.frameHeight,
        });
        this.#registered.add(scopedKey);
        this.#needsReseed.delete(scopedKey);
        this.#remember(ownerKey, input.counterpartyEntityId, input.account);
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
        // Ack-only frames carry no account txs: there is nothing to replay and
        // nothing to compare. Counted so framesSeen always adds up.
        this.#stats.emptyFrames += 1;
        return;
      }
      this.#remember(ownerKey, input.counterpartyEntityId, input.account);
      this.#push({
        kind: 'wave',
        ownerKey,
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
    for (const client of this.#clients.values()) {
      try { await client.shutdown(); } catch { /* already down */ }
      client.kill();
    }
    this.#clients.clear();
  }

  #push(entry: QueueEntry): void {
    if (this.#queue.length >= MAX_QUEUE) {
      this.#stats.dropped += 1;
      // A dropped frame breaks the replay continuity for that account.
      this.#needsReseed.add(`${entry.ownerKey}/${entry.accountKey}`);
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
      while (this.#queue.length > 0) {
        const entry = this.#queue.shift()!;
        lastEntry = entry;
        const client = await this.#ensureClient(entry.ownerKey);
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
        if (this.#stats.framesCompared % PROGRESS_EVERY === 0) {
          try { this.#onProgress?.(); } catch { /* observer-only */ }
        }
        // Only meaningful once the queue has drained: TypeScript mutates its
        // replicas in place, so while waves are still pending the engine is
        // legitimately behind and every diff would be a false alarm.
        if (RECONCILE_EVERY > 0
          && this.#stats.framesCompared % RECONCILE_EVERY === 0
          && this.#queue.length === 0) {
          const owned = this.#mirrored.get(entry.ownerKey);
          if (owned) {
            const report = await this.reconcile(entry.ownerKey, owned);
            this.#stats.reconciliations += 1;
            const gap = report.mismatched.length > 0 || report.missingInEngine.length > 0
              || report.extraInEngine.length > 0;
            // A frame that arrived while the diff was running puts the engine
            // behind again; only a still-quiet queue makes the gap real.
            if (gap && this.#queue.length === 0) this.#stats.reconcileFailures += 1;
            try {
              console.error(`RSCORE_SHADOW_RECONCILE matched=${report.matched} mismatched=${
                report.mismatched.length} missing=${report.missingInEngine.length} extra=${
                report.extraInEngine.length}`);
            } catch { /* observer-only */ }
          }
        }
        // Counted only once a verdict exists, so framesCompared always equals
        // matches + mismatches; incrementing first let a stats snapshot taken
        // mid-frame report a comparison with no outcome.
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
    this.#needsReseed.add(`${entry.ownerKey}/${entry.accountKey}`);
    // Logging must never take the mirror down (scenario harnesses may turn
    // console.error into a thrown failure).
    try {
      shadowLog.error('shadow.divergence', {
        owner: entry.ownerKey,
        account: entry.accountKey,
        frameHeight: entry.frameHeight,
        expected: entry.expectedRootHex,
        detail,
      });
    } catch { /* observer-only */ }
  }

  /**
   * One engine process per owner entity: the engine's account tree is keyed by
   * the raw counterparty entity id, so a process may only ever hold the
   * accounts of a single owner — exactly the entity machine's own scope.
   */
  #remember(ownerKey: string, counterpartyId: string, account: AccountReplica): void {
    const owned = this.#mirrored.get(ownerKey) ?? new Map<string, AccountReplica>();
    owned.set(counterpartyId.trim().toLowerCase(), account);
    this.#mirrored.set(ownerKey, owned);
  }

  /**
   * Reconcile every owner this mirror bound, against the live replicas it was
   * fed. Used as an end-of-run gate: identical trees mean the two engines are
   * interchangeable, and any gap names the exact account.
   */
  async selfReconcile(): Promise<Map<string, ShadowReconciliation>> {
    await this.#idle;
    const reports = new Map<string, ShadowReconciliation>();
    for (const [ownerKey, accounts] of this.#mirrored) {
      reports.set(ownerKey, await this.reconcile(ownerKey, accounts));
    }
    return reports;
  }

  async #ensureClient(ownerKey: string): Promise<RscoreProcessClient> {
    const existing = this.#clients.get(ownerKey);
    if (existing) return existing;
    const client = this.#makeClient(this.#binaryPath);
    await client.hello(this.#workers);
    await client.restore(0, []);
    this.#clients.set(ownerKey, client);
    return client;
  }

  #disable(reason: string): void {
    this.#disabledReason = reason;
    this.#stats.disabledReason = reason;
    this.#queue.length = 0;
    try {
      shadowLog.error('shadow.disabled', { reason });
    } catch { /* observer-only */ }
    for (const client of this.#clients.values()) client.kill();
    this.#clients.clear();
  }
}
