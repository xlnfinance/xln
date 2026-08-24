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
import { computeAccountStateRoot } from '../account/commitment/state-root';
import { PersistentRadixValueMap } from '../protocol/state/persistent-radix-value-map';
import { requirePersistentAccountStateMap } from '../account/state/persistent-state-map';
import type { AccountOutput, AccountReplica, AccountTx } from '../types/account';
import type { RscoreProcessClient, RscoreWireValue } from './client';
import {
  SHADOW_SUPPORTED_TX_TYPES,
  accountSeedWire,
  accountTxWire,
  hexToWireBytes,
  shadowIneligibilityReason,
} from './shadow-wire';

const shadowLog = createStructuredLogger('rscore.shadow');

/**
 * Output-channel parity, as a canonical ordered list of strings.
 *
 * Both engines emit two comparable signals for the payment profile: the
 * trusted-payment forward, and the HTLC secret released by a resolve. The
 * account state root says nothing about either — a lost or invented forward
 * keeps the same balances — so they are compared explicitly.
 */
const expectedOutputProjection = (input: ShadowFrameInput): string[] => {
  const rows: string[] = [];
  for (const output of input.outputs) {
    if (output.kind !== 'directPaymentForward') continue;
    rows.push([
      'forward',
      output.tokenId,
      output.amount.toString(),
      output.route.join('>'),
      output.description ?? '',
      output.trustedGatewayEntityId,
    ].join('|'));
  }
  for (const tx of input.accountTxs) {
    if (tx.type !== 'htlc_resolve' || tx.data.outcome !== 'secret') continue;
    rows.push(['secret', tx.data.lockId].join('|'));
  }
  return rows;
};

/** Same projection, read back from the engine's typed outputs. */
const engineOutputProjection = (outputs: readonly unknown[], accountKey: string): string[] => {
  const rows: string[] = [];
  for (const entry of outputs) {
    const fields = entry as unknown[];
    if (Buffer.from(fields[2] as Uint8Array).toString('hex') !== accountKey) continue;
    const output = fields[3] as unknown[];
    const tag = Number(output[0]);
    if (tag === 0) {
      rows.push([
        'forward',
        Number(output[1]),
        String(output[2]),
        (output[3] as string[]).join('>'),
        (output[4] as string | null) ?? '',
        String(output[6]),
      ].join('|'));
      continue;
    }
    if (tag === 1) rows.push(['secret', String(output[1])].join('|'));
  }
  return rows;
};

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
  /** Effects the committed frame produced (the TS authority's output channel). */
  outputs: readonly AccountOutput[];
  /** TS authority root committed by this frame (hex). */
  committedStateRoot: string;
  /** Committed post-frame replica, read synchronously at note time. */
  account: AccountReplica;
}>;

/** One mirrored Account frame inside a wave. */
type WaveFrame = Readonly<{
  accountKey: string;
  frameHeight: number;
  expectedRootHex: string;
  txTypes: readonly string[];
  /** Canonical projection of the TS outputs this frame must reproduce. */
  expectedOutputs: readonly string[];
}>;

type QueueEntry = Readonly<{
  kind: 'wave';
  ownerKey: string;
  /** Every account frame of one Runtime frame, in commit order. */
  frames: readonly WaveFrame[];
  jobs: RscoreWireValue[][];
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
  /** The whole leaf: identity, dispute config, journal counters, every section. */
  accountStateRoot: Readonly<{ typescript: string; rust: string }>;
  /** Which section moved, when the full root differs. */
  deltasRoot: Readonly<{ typescript: string; rust: string }>;
  locksRoot: Readonly<{ typescript: string; rust: string }>;
  ownerSide: Readonly<{ typescript: string; rust: string }>;
}>;

export type ShadowReconciliation = Readonly<{
  matched: number;
  /**
   * Radix-16 forest over the payment-profile account state roots — the tree
   * the Rust engine commits. This is NOT the production Entity accounts root:
   * the Entity leaf additionally commits the replica envelope (mempool,
   * current/pending frames, acks, hankos, withdrawals).
   */
  forestRoot: Readonly<{ typescript: string; rust: string; equal: boolean }>;
  mismatched: readonly ShadowReconciliationMismatch[];
  missingInEngine: readonly string[];
  extraInEngine: readonly string[];
}>;

/**
 * A parity gap the mirror observed. Divergence is the obvious one; a repair
 * reseed and a refused account are gaps too — they silently restore agreement
 * instead of proving it, so a strict run must treat them as failures.
 */
export type ShadowGap = Readonly<{
  kind: 'divergence' | 'reseed-repair' | 'ineligible';
  owner: string;
  account: string;
  frameHeight: number;
  detail: string;
  txTypes: readonly string[];
  /** Per-section roots, filled in for divergences so the dump names the section. */
  sections?: Readonly<Record<string, Readonly<{ typescript: string; rust: string }>>>;
}>;

export type ShadowStats = {
  framesSeen: number;
  framesCompared: number;
  matches: number;
  mismatches: number;
  reseeds: number;
  /** Reseeds that repaired a gap (unsupported tx, drop, divergence) rather than registering a new account. */
  reseedsRepair: number;
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
  /** Verify each Account frame on its own wave instead of batching. */
  readonly #strictFrames: boolean;
  readonly #registered = new Set<string>();
  /**
   * Live replica references, per owner, for self-reconciliation. These are the
   * very objects the entity owns and mutates in place, so the map stays
   * current without copying state; it retains nothing the entity has not
   * already retained.
   */
  readonly #mirrored = new Map<string, Map<string, AccountReplica>>();
  readonly #needsReseed = new Set<string>();
  /** Last accounts-forest root and revision the engine reported per owner. */
  readonly #lastCommittedRoot = new Map<string, string>();
  readonly #lastRevision = new Map<string, number>();
  readonly #queue: QueueEntry[] = [];
  /**
   * Account frames committed since the last Runtime frame boundary, per owner.
   * They are handed to the engine as ONE Prepare: the engine groups jobs by
   * account id and runs distinct accounts on its worker pool, so batching by
   * Runtime frame is what actually fills the cores. Sending one account frame
   * per Prepare left a single Rayon task and idle workers.
   */
  readonly #pendingWave = new Map<string, { frames: WaveFrame[]; jobs: RscoreWireValue[][] }>();
  #draining = false;
  #disabledReason: string | null = null;
  readonly #stats: ShadowStats = {
    framesSeen: 0,
    framesCompared: 0,
    matches: 0,
    mismatches: 0,
    reseeds: 0,
    reseedsRepair: 0,
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
  #onGap: ((gap: ShadowGap) => void) | null = null;
  #idle: Promise<void> = Promise.resolve();
  #idleResolve: (() => void) | null = null;

  constructor(options: Readonly<{
    binaryPath: string;
    workers: number;
    maxOwners?: number;
    strictFrames?: boolean;
    makeClient: (binaryPath: string) => RscoreProcessClient;
  }>) {
    this.#binaryPath = options.binaryPath;
    this.#workers = options.workers;
    this.#maxOwners = options.maxOwners ?? DEFAULT_MAX_OWNERS;
    this.#strictFrames = options.strictFrames ?? false;
    this.#makeClient = options.makeClient;
  }

  /** Observer hook: called every PROGRESS_EVERY compared frames. */
  onProgress(callback: () => void): void {
    this.#onProgress = callback;
  }

  /**
   * Observer hook for every parity gap. A strict run halts here on the first
   * one; the default run only counts them.
   */
  onGap(callback: (gap: ShadowGap) => void): void {
    this.#onGap = callback;
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
    const engineRows = new Map<string, {
      ownerSide: string;
      deltasRoot: string;
      locksRoot: string;
      accountStateRoot: string;
    }>();
    let cursor: Uint8Array | null = null;
    for (;;) {
      const page = (await client.readAccountSummaryPage(cursor, 512, [])) as unknown[];
      for (const row of page[1] as unknown[]) {
        const fields = row as unknown[];
        engineRows.set(`0x${Buffer.from(fields[0] as Uint8Array).toString('hex')}`, {
          ownerSide: Number(fields[1]) === 0 ? 'left' : 'right',
          deltasRoot: `0x${Buffer.from(fields[4] as Uint8Array).toString('hex')}`,
          locksRoot: `0x${Buffer.from(fields[5] as Uint8Array).toString('hex')}`,
          accountStateRoot: `0x${Buffer.from(fields[6] as Uint8Array).toString('hex')}`,
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
      // The authority value: the root the last committed frame certified.
      // Comparing the two map roots alone left identity, dispute config, the
      // journal counters and every carried section unverified.
      const accountStateRoot = computeAccountStateRoot(account.state).toLowerCase();
      const ownerSide = account.state.leftEntity.trim().toLowerCase() === ownerKey ? 'left' : 'right';
      if (engine.accountStateRoot === accountStateRoot && engine.ownerSide === ownerSide) {
        matched.push(key);
        continue;
      }
      mismatched.push({
        accountId: key,
        accountStateRoot: { typescript: accountStateRoot, rust: engine.accountStateRoot },
        deltasRoot: { typescript: deltasRoot, rust: engine.deltasRoot },
        locksRoot: { typescript: locksRoot, rust: engine.locksRoot },
        ownerSide: { typescript: ownerSide, rust: engine.ownerSide },
      });
    }
    // Same data model as the engine's tree: key = 32-byte counterparty id,
    // leaf = payment-profile account state root.
    let forest = PersistentRadixValueMap.empty<string, AccountReplica>({
      radix: 16,
      ownKey: (key: string): string => key,
      keyBytes: (key: string): Uint8Array => hexToWireBytes(key, 32, 'SHADOW_FOREST_KEY'),
      valueHash: (account: AccountReplica): string => computeAccountStateRoot(account.state),
      ownValue: (account: AccountReplica): AccountReplica => account,
    });
    for (const [counterpartyId, account] of accounts) {
      forest = forest.updated(counterpartyId.trim().toLowerCase(), account);
    }
    const typescriptForest = forest.rootHash().toLowerCase();
    const rustForest = (this.#lastCommittedRoot.get(ownerKey) ?? '').toLowerCase();
    return {
      matched: matched.length,
      forestRoot: {
        typescript: typescriptForest,
        rust: rustForest,
        equal: rustForest !== '' && rustForest === typescriptForest,
      },
      mismatched,
      missingInEngine,
      extraInEngine: [...engineRows.keys()],
    };
  }

  /**
   * Runtime frame boundary: hand every account frame committed since the last
   * boundary to the engine as one wave.
   */
  flushWave(): void {
    if (this.#disabledReason) return;
    for (const [ownerKey, pending] of this.#pendingWave) {
      if (pending.jobs.length === 0) continue;
      this.#push({ kind: 'wave', ownerKey, frames: pending.frames, jobs: pending.jobs });
    }
    this.#pendingWave.clear();
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
          this.#reportGap({
            kind: 'ineligible',
            owner: ownerKey,
            account: accountKey,
            frameHeight: input.frameHeight,
            detail: reason,
            txTypes: input.accountTxs.map(tx => tx.type),
          });
          return;
        }
        const seed = accountSeedWire(input.ownerEntityId, input.counterpartyEntityId, input.account);
        const repair = !fresh || this.#needsReseed.has(scopedKey);
        this.#push({
          kind: 'reseed',
          ownerKey,
          accountKey,
          seed,
          reason: repair ? (supported ? 'repair' : 'unsupported-tx') : 'register',
          frameHeight: input.frameHeight,
        });
        if (repair) {
          this.#stats.reseedsRepair += 1;
          this.#reportGap({
            kind: 'reseed-repair',
            owner: ownerKey,
            account: accountKey,
            frameHeight: input.frameHeight,
            detail: supported ? 'continuity-lost' : `unsupported:${unsupported.map(tx => tx.type).join(',')}`,
            txTypes: input.accountTxs.map(tx => tx.type),
          });
        }
        this.#registered.add(scopedKey);
        this.#needsReseed.delete(scopedKey);
        this.#remember(ownerKey, input.counterpartyEntityId, input.account);
        return;
      }
      const jobs: RscoreWireValue[][] = [];
      const inputBase = this.#pendingWave.get(ownerKey)?.jobs.length ?? 0;
      for (const [index, tx] of input.accountTxs.entries()) {
        const wire = accountTxWire(tx);
        if (wire === null) throw new Error(`SHADOW_TX_UNSUPPORTED:${tx.type}`);
        jobs.push([
          inputBase + index,
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
      const pending = this.#pendingWave.get(ownerKey) ?? { frames: [], jobs: [] };
      pending.frames.push({
        accountKey,
        frameHeight: input.frameHeight,
        expectedRootHex: input.committedStateRoot.trim().toLowerCase().replace(/^0x/, ''),
        txTypes: input.accountTxs.map(tx => tx.type),
        expectedOutputs: expectedOutputProjection(input),
      });
      pending.jobs.push(...jobs);
      this.#pendingWave.set(ownerKey, pending);
      // Strict mode verifies frame by frame, so it never batches: a batched
      // wave only proves the final per-account root, and an intermediate frame
      // that lands on the same state would go unnoticed.
      if (this.#strictFrames) this.flushWave();
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
      // A dropped wave breaks replay continuity for every account it carried.
      if (entry.kind === 'reseed') this.#needsReseed.add(`${entry.ownerKey}/${entry.accountKey}`);
      else for (const frame of entry.frames) this.#needsReseed.add(`${entry.ownerKey}/${frame.accountKey}`);
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
          const upserted = (await client.upsertAccounts([entry.seed])) as unknown[];
          this.#noteRevision(entry.ownerKey, upserted);
          this.#stats.reseeds += 1;
          continue;
        }
        const prepared = (await client.prepare(entry.jobs)) as unknown[];
        const results = prepared[2] as unknown[];
        const rejected = results
          .map((row, index) => ({ verdict: (row as unknown[])[2] as unknown[], index }))
          .filter(({ verdict }) => Number(verdict[0]) !== 0);
        // Outputs and roots are read from the candidate before it is
        // committed, so a rejected wave never reaches the committed tree.
        const engineOutputs = prepared[3] as unknown[];
        const roots = prepared[4] as unknown[];
        const committed = (await client.commit(client.requestIdBytes(client.lastRequestId))) as unknown[];
        // The engine's revision must advance by exactly one per commit; a gap
        // means a candidate was silently dropped or replayed.
        const expectedRevision = (this.#lastRevision.get(entry.ownerKey) ?? 0) + 1;
        const revisionGap = Number(committed[0]) !== expectedRevision
          ? `revision:${committed[0]}!=${expectedRevision}`
          : null;
        this.#noteRevision(entry.ownerKey, committed);
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
              || report.extraInEngine.length > 0 || !report.forestRoot.equal;
            // A frame that arrived while the diff was running puts the engine
            // behind again; only a still-quiet queue makes the gap real.
            if (gap && this.#queue.length === 0) this.#stats.reconcileFailures += 1;
            try {
              console.error(`RSCORE_SHADOW_RECONCILE matched=${report.matched} mismatched=${
                report.mismatched.length} missing=${report.missingInEngine.length} extra=${
                report.extraInEngine.length} forestRoot=${report.forestRoot.equal}`);
            } catch { /* observer-only */ }
          }
        }
        // A wave carries the Account frames of one Runtime frame — by design
        // at most one per counterparty, because an Account input already
        // combines the ack and the proposal. A second frame for the same
        // account in one wave breaks that invariant, and its intermediate root
        // would go unverified, so it is reported instead of collapsed.
        const frameOf = new Map<string, WaveFrame>();
        const duplicated: string[] = [];
        for (const frame of entry.frames) {
          if (frameOf.has(frame.accountKey)) duplicated.push(frame.accountKey);
          frameOf.set(frame.accountKey, frame);
        }
        const rejection = rejected.length > 0
          ? `rejected:${JSON.stringify(rejected[0]?.verdict ?? null)}:job=${JSON.stringify(
              entry.jobs[rejected[0]?.index ?? 0]?.[4] ?? null,
              (_key, value) => (value instanceof Uint8Array || Buffer.isBuffer(value) ? 'bytes' : (value as unknown)),
            )}`
          : null;
        for (const [accountKey, frame] of frameOf) {
          // Counted only once a verdict exists, so framesCompared always equals
          // matches + mismatches; incrementing first let a stats snapshot taken
          // mid-frame report a comparison with no outcome.
          this.#stats.framesCompared += 1;
          const duplicate = duplicated.includes(accountKey)
            ? `waveCarriedTwoFramesForOneAccount:${duplicated.length}`
            : null;
          const failure = revisionGap ?? rejection ?? duplicate ?? this.#verifyAccount(
            accountKey,
            frame,
            frame.expectedOutputs,
            engineOutputs,
            roots,
          );
          if (failure === null) {
            this.#stats.matches += 1;
            continue;
          }
          await this.#recordMismatch(entry, accountKey, frame, failure);
        }
      }
    } catch (error) {
      const context = lastEntry
        ? `${lastEntry.kind}:${JSON.stringify(
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

  /** Outputs then final root, for one account of a wave. Null when it matches. */
  #verifyAccount(
    accountKey: string,
    frame: WaveFrame,
    expectedOutputs: readonly string[],
    engineOutputs: readonly unknown[],
    roots: readonly unknown[],
  ): string | null {
    const actualOutputs = engineOutputProjection(engineOutputs, accountKey);
    if (actualOutputs.join('\n') !== expectedOutputs.join('\n')) {
      return `outputs:ts=${JSON.stringify(expectedOutputs)}:rust=${JSON.stringify(actualOutputs)}`;
    }
    const row = roots.find(candidate =>
      Buffer.from((candidate as unknown[])[0] as Uint8Array).toString('hex') === accountKey);
    const actual = row ? Buffer.from((row as unknown[])[1] as Uint8Array).toString('hex') : 'missing';
    return actual === frame.expectedRootHex ? null : `root:${actual}`;
  }

  async #recordMismatch(
    entry: Extract<QueueEntry, { kind: 'wave' }>,
    accountKey: string,
    frame: WaveFrame,
    detail: string,
  ): Promise<void> {
    this.#stats.mismatches += 1;
    this.#needsReseed.add(`${entry.ownerKey}/${accountKey}`);
    const sections = await this.#diverginSections(entry.ownerKey, accountKey);
    // Logging must never take the mirror down (scenario harnesses may turn
    // console.error into a thrown failure).
    try {
      shadowLog.error('shadow.divergence', {
        owner: entry.ownerKey,
        account: accountKey,
        frameHeight: frame.frameHeight,
        expected: frame.expectedRootHex,
        detail,
        sections,
      });
    } catch { /* observer-only */ }
    this.#reportGap({
      kind: 'divergence',
      owner: entry.ownerKey,
      account: accountKey,
      frameHeight: frame.frameHeight,
      detail,
      txTypes: frame.txTypes,
      ...(sections ? { sections } : {}),
    });
  }

  /**
   * Which section of the account diverged. The frame comparison only proves
   * the state roots differ; this pages the engine for the one account and
   * diffs its per-section roots against the TypeScript replica, so the halt
   * dump names deltas vs locks vs fee policies instead of one opaque hash.
   */
  async #diverginSections(
    ownerKey: string,
    accountKey: string,
  ): Promise<Record<string, { typescript: string; rust: string }> | undefined> {
    const account = this.#mirrored.get(ownerKey)?.get(`0x${accountKey}`);
    if (!account) return undefined;
    try {
      const client = await this.#ensureClient(ownerKey);
      const page = (await client.readAccountSummaryPage(null, 512, [])) as unknown[];
      const row = (page[1] as unknown[]).find(candidate =>
        Buffer.from((candidate as unknown[])[0] as Uint8Array).toString('hex') === accountKey);
      if (!row) return undefined;
      const fields = row as unknown[];
      const engine = (index: number): string =>
        `0x${Buffer.from(fields[index] as Uint8Array).toString('hex')}`;
      return {
        deltas: {
          typescript: requirePersistentAccountStateMap(account.state.deltas, 'deltas')
            .rootHash().toLowerCase(),
          rust: engine(4),
        },
        locks: {
          typescript: requirePersistentAccountStateMap(account.state.locks, 'locks')
            .rootHash().toLowerCase(),
          rust: engine(5),
        },
      };
    } catch {
      return undefined;
    }
  }

  /** Reply shape for commit/upsert alike: [revision, accountsRoot]. */
  #noteRevision(ownerKey: string, reply: readonly unknown[]): void {
    this.#lastRevision.set(ownerKey, Number(reply[0]));
    this.#lastCommittedRoot.set(
      ownerKey,
      `0x${Buffer.from(reply[1] as Uint8Array).toString('hex')}`,
    );
  }

  #reportGap(gap: ShadowGap): void {
    try { this.#onGap?.(gap); } catch { /* observer-only */ }
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
