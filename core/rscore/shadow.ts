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
import { safeStringify } from '../protocol/serialization';
import { requirePersistentAccountStateMap } from '../account/state/persistent-state-map';
import type { ApplyAccountTxOk } from '../account/tx/apply-types';
import type { AccountReplica, AccountTx } from '../types/account';
import type { RscoreProcessClient, RscoreWireValue } from './client';
import {
  SHADOW_SUPPORTED_TX_TYPES,
  shadowOutputRows,
  accountSeedWire,
  accountTxWire,
  hexToWireBytes,
  shadowIneligibilityReason,
  type ShadowOutputRow,
} from './shadow-wire';

const shadowLog = createStructuredLogger('rscore.shadow');

const wireTuple = (value: unknown, code: string, length?: number): unknown[] => {
  if (!Array.isArray(value)) throw new Error(`${code}:tuple`);
  if (length !== undefined && value.length !== length) {
    throw new Error(`${code}:arity:${value.length}:${length}`);
  }
  return value;
};

const wireBytes = (value: unknown, code: string, length?: number): Uint8Array => {
  if (!(value instanceof Uint8Array)) throw new Error(`${code}:bytes`);
  if (length !== undefined && value.byteLength !== length) {
    throw new Error(`${code}:length:${value.byteLength}:${length}`);
  }
  return value;
};

const wireText = (value: unknown, code: string): string => {
  if (typeof value !== 'string') throw new Error(`${code}:text`);
  return value;
};

const wireInteger = (value: unknown, code: string): number => {
  const integer = Number(value);
  if (!Number.isSafeInteger(integer) || integer < 0) throw new Error(`${code}:integer`);
  return integer;
};

const wireOptionalText = (value: unknown, code: string): string | null =>
  value === null ? null : wireText(value, code);

const decodeEngineOutput = (value: unknown): ShadowOutputRow => {
  const output = wireTuple(value, 'SHADOW_ENGINE_OUTPUT');
  const tag = wireInteger(output[0], 'SHADOW_ENGINE_OUTPUT_TAG');
  if (tag === 0) {
    wireTuple(output, 'SHADOW_ENGINE_FORWARD', 7);
    const deliveryMode = wireInteger(output[5], 'SHADOW_ENGINE_FORWARD_MODE');
    if (deliveryMode !== 1) throw new Error(`SHADOW_ENGINE_FORWARD_MODE:${deliveryMode}`);
    return [
      'forward',
      wireInteger(output[1], 'SHADOW_ENGINE_FORWARD_TOKEN'),
      wireText(output[2], 'SHADOW_ENGINE_FORWARD_AMOUNT'),
      wireTuple(output[3], 'SHADOW_ENGINE_FORWARD_ROUTE')
        .map((hop, index) => wireText(hop, `SHADOW_ENGINE_FORWARD_ROUTE_${index}`)),
      wireOptionalText(output[4], 'SHADOW_ENGINE_FORWARD_DESCRIPTION'),
      'trusted',
      wireText(output[6], 'SHADOW_ENGINE_FORWARD_GATEWAY'),
    ];
  }
  if (tag === 1) {
    wireTuple(output, 'SHADOW_ENGINE_SECRET', 6);
    return [
      'secret',
      wireText(output[1], 'SHADOW_ENGINE_SECRET_LOCK'),
      wireText(output[2], 'SHADOW_ENGINE_SECRET_HASHLOCK'),
      wireText(output[3], 'SHADOW_ENGINE_SECRET_VALUE'),
      wireInteger(output[4], 'SHADOW_ENGINE_SECRET_TOKEN'),
      wireText(output[5], 'SHADOW_ENGINE_SECRET_AMOUNT'),
    ];
  }
  if (tag === 2) {
    wireTuple(output, 'SHADOW_ENGINE_ERROR', 6);
    return [
      'error',
      wireText(output[1], 'SHADOW_ENGINE_ERROR_LOCK'),
      wireText(output[2], 'SHADOW_ENGINE_ERROR_HASHLOCK'),
      wireInteger(output[3], 'SHADOW_ENGINE_ERROR_TOKEN'),
      wireText(output[4], 'SHADOW_ENGINE_ERROR_AMOUNT'),
      wireOptionalText(output[5], 'SHADOW_ENGINE_ERROR_REASON'),
    ];
  }
  throw new Error(`SHADOW_ENGINE_OUTPUT_TAG_UNSUPPORTED:${tag}`);
};

type IndexedShadowOutputRow = readonly [
  inputIndex: number,
  outputIndex: number,
  output: ShadowOutputRow,
];

/** Engine outputs normalized with their protocol-defined association intact. */
export const engineOutputProjection = (
  outputs: readonly unknown[],
  accountKey: string,
): IndexedShadowOutputRow[] => outputs
  .map(entry => wireTuple(entry, 'SHADOW_ENGINE_INDEXED_OUTPUT', 4))
  .filter(fields => Buffer.from(
    wireBytes(fields[2], 'SHADOW_ENGINE_ACCOUNT_ID', 32),
  ).toString('hex') === accountKey)
  .sort((left, right) => {
    const input = wireInteger(left[0], 'SHADOW_ENGINE_INPUT_INDEX')
      - wireInteger(right[0], 'SHADOW_ENGINE_INPUT_INDEX');
    return input !== 0
      ? input
      : wireInteger(left[1], 'SHADOW_ENGINE_OUTPUT_INDEX')
        - wireInteger(right[1], 'SHADOW_ENGINE_OUTPUT_INDEX');
  })
  .map(fields => [
    wireInteger(fields[0], 'SHADOW_ENGINE_INPUT_INDEX'),
    wireInteger(fields[1], 'SHADOW_ENGINE_OUTPUT_INDEX'),
    decodeEngineOutput(fields[3]),
  ]);

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
  /**
   * The authority's own per-tx results, in tx order. The mirror projects them
   * with the single canonical projector (shadowOutputRows), so the comparison
   * never depends on a second, hand-written derivation at each commit site.
   */
  txResults: readonly ApplyAccountTxOk[];
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
  expectedOutputs: readonly IndexedShadowOutputRow[];
}>;

/** One committed frame and its request-local jobs before Runtime-wave packing. */
type PendingWaveFrame = Readonly<{
  frame: WaveFrame;
  jobs: readonly RscoreWireValue[][];
}>;

type PendingSubwave = Readonly<{
  frames: WaveFrame[];
  jobs: RscoreWireValue[][];
}>;

/** Preserve per-account frame order while retaining cross-account parallelism. */
const packRuntimeSubwaves = (pending: readonly PendingWaveFrame[]): PendingSubwave[] => {
  const subwaves: PendingSubwave[] = [];
  const occurrence = new Map<string, number>();
  for (const pendingFrame of pending) {
    // frame_ack can commit the ACKed frame and the peer's next proposal in one
    // Runtime frame. The nth frame of each account belongs in the nth subwave.
    const depth = occurrence.get(pendingFrame.frame.accountKey) ?? 0;
    occurrence.set(pendingFrame.frame.accountKey, depth + 1);
    const subwave = subwaves[depth] ?? { frames: [], jobs: [] };
    const inputBase = subwave.jobs.length;
    subwave.frames.push({
      ...pendingFrame.frame,
      expectedOutputs: pendingFrame.frame.expectedOutputs.map(([inputIndex, outputIndex, output]) => [
        inputBase + inputIndex,
        outputIndex,
        output,
      ]),
    });
    for (const [index, job] of pendingFrame.jobs.entries()) {
      // Rust input indexes are request-local, contiguous, and bind returned
      // results/outputs to this exact subwave.
      subwave.jobs.push([inputBase + index, ...job.slice(1)]);
    }
    subwaves[depth] = subwave;
  }
  return subwaves;
};

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
  /**
   * Accounts whose state was imported from TypeScript but that never had a
   * single transition executed by the engine. A seeded account reproduces the
   * TS root by construction, so counting it as agreement proves nothing.
   */
  seededNeverExecuted: number;
  /** Transitions the engine actually executed, by tx type. */
  executedByType: Record<string, number>;
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
  /** Scoped keys seeded from TypeScript that have not executed a wave yet. */
  readonly #seeded = new Set<string>();
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
  readonly #pendingWave = new Map<string, PendingWaveFrame[]>();
  #draining = false;
  /** Changes on every observed committed frame, including skipped frames. */
  #noteEpoch = 0;
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
    seededNeverExecuted: 0,
    executedByType: {},
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
      seededNeverExecuted: this.#seeded.size,
      executedByType: { ...this.#stats.executedByType },
      disabledReason: this.#disabledReason,
    };
  }

  /**
   * Install the authoritative recovery checkpoint before replaying its WAL
   * tail. These accounts are the shared initial condition, not post-transition
   * reseeds, so they do not count as unexecuted shadow coverage.
   */
  async primeOwner(
    ownerEntityId: string,
    accounts: ReadonlyMap<string, AccountReplica>,
  ): Promise<void> {
    if (this.#disabledReason) throw new Error(`SHADOW_PRIME_DISABLED:${this.#disabledReason}`);
    const ownerKey = ownerEntityId.trim().toLowerCase();
    if (!this.#tryBindOwner(ownerKey)) throw new Error(`SHADOW_PRIME_OWNER_LIMIT:${ownerKey}`);
    if (this.#clients.has(ownerKey) || this.#mirrored.has(ownerKey)) {
      throw new Error(`SHADOW_PRIME_OWNER_ALREADY_LOADED:${ownerKey}`);
    }
    const ordered = [...accounts.entries()]
      .sort(([left], [right]) => left.localeCompare(right));
    const seeds = this.#checkpointSeeds(ownerEntityId, ordered);
    const { client, restored } = await this.#restoreCheckpoint(seeds);
    this.#clients.set(ownerKey, client);
    this.#noteRevision(ownerKey, restored);
    this.#mirrored.set(ownerKey, new Map());
    for (const [counterpartyId, account] of ordered) {
      const accountKey = Buffer.from(
        hexToWireBytes(counterpartyId, 32, 'SHADOW_PRIME_ACCOUNT_ID'),
      ).toString('hex');
      this.#registered.add(`${ownerKey}/${accountKey}`);
      this.#remember(ownerKey, counterpartyId, account);
    }
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
    let pageRevision: number | undefined;
    let cursor: Uint8Array | null = null;
    for (;;) {
      const page = wireTuple(
        await client.readAccountSummaryPage(cursor, 512, []),
        'SHADOW_SUMMARY_PAGE',
        4,
      );
      const revision = wireInteger(page[0], 'SHADOW_SUMMARY_REVISION');
      pageRevision ??= revision;
      if (revision !== pageRevision) {
        throw new Error(`SHADOW_RECONCILE_REVISION_CHANGED:${pageRevision}:${revision}`);
      }
      for (const row of wireTuple(page[1], 'SHADOW_SUMMARY_ROWS')) {
        const fields = wireTuple(row, 'SHADOW_SUMMARY_ROW', 7);
        const side = wireInteger(fields[1], 'SHADOW_SUMMARY_OWNER_SIDE');
        if (side !== 0 && side !== 1) throw new Error(`SHADOW_SUMMARY_OWNER_SIDE:${side}`);
        engineRows.set(`0x${Buffer.from(
          wireBytes(fields[0], 'SHADOW_SUMMARY_ACCOUNT_ID', 32),
        ).toString('hex')}`, {
          ownerSide: side === 0 ? 'left' : 'right',
          deltasRoot: `0x${Buffer.from(wireBytes(fields[4], 'SHADOW_SUMMARY_DELTAS_ROOT', 32)).toString('hex')}`,
          locksRoot: `0x${Buffer.from(wireBytes(fields[5], 'SHADOW_SUMMARY_LOCKS_ROOT', 32)).toString('hex')}`,
          accountStateRoot: `0x${Buffer.from(wireBytes(fields[6], 'SHADOW_SUMMARY_STATE_ROOT', 32)).toString('hex')}`,
        });
      }
      const next = page[2];
      if (next === null || next === undefined) break;
      cursor = wireBytes(next, 'SHADOW_SUMMARY_CURSOR', 32);
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
      for (const subwave of packRuntimeSubwaves(pending)) {
        if (subwave.jobs.length === 0) continue;
        this.#push({ kind: 'wave', ownerKey, frames: subwave.frames, jobs: subwave.jobs });
      }
    }
    this.#pendingWave.clear();
  }

  /** Resolves when the queue has fully drained — test/shutdown ordering only. */
  settled(): Promise<void> {
    return this.#idle;
  }

  noteCommittedFrame(input: ShadowFrameInput): void {
    if (this.#disabledReason) return;
    this.#noteEpoch += 1;
    this.#stats.framesSeen += 1;
    // Parity with the entity machine: the account key is the raw 32-byte
    // counterparty entity id, never a hash. Owners are separated by running
    // one engine process per owner entity, exactly the way the entity machine
    // owns exactly one account map.
    const ownerKey = input.ownerEntityId.trim().toLowerCase();
    if (!this.#tryBindOwner(ownerKey)) {
      this.#stats.skippedUnboundOwner += 1;
      return;
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
      if (input.txResults.length !== input.accountTxs.length) {
        throw new Error(
          `SHADOW_TX_RESULT_LENGTH:${input.txResults.length}:${input.accountTxs.length}`,
        );
      }
      const unsupported = input.accountTxs.filter(tx => !SHADOW_SUPPORTED_TX_TYPES.has(tx.type));
      for (const tx of unsupported) {
        this.#stats.unsupportedTxTypes[tx.type] = (this.#stats.unsupportedTxTypes[tx.type] ?? 0) + 1;
      }
      const supported = unsupported.length === 0;
      const fresh = !this.#registered.has(scopedKey) || this.#needsReseed.has(scopedKey);
      if (!supported || fresh) {
        // Reseeds are queued immediately while supported frames wait for the
        // Runtime boundary. Flush the earlier frames first; otherwise a later
        // unsupported frame of the same account would seed its post-state and
        // the queued earlier frame would be replayed on top of that state.
        this.flushWave();
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
        this.#seeded.add(scopedKey);
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
      const pending = this.#pendingWave.get(ownerKey) ?? [];
      pending.push({
        frame: {
          accountKey,
          frameHeight: input.frameHeight,
          expectedRootHex: input.committedStateRoot.trim().toLowerCase().replace(/^0x/, ''),
          txTypes: input.accountTxs.map(tx => tx.type),
          expectedOutputs: input.txResults.flatMap((result, inputIndex) =>
            shadowOutputRows(result).map((output, outputIndex) => [
              inputIndex,
              outputIndex,
              output,
            ]),
          ),
        },
        jobs,
      });
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
    this.flushWave();
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
        const { candidate, token } = await client.prepareCandidate(entry.jobs);
        const prepared = candidate as unknown[];
        const results = prepared[2] as unknown[];
        const verdicts = results
          .map((row, index) => ({ verdict: (row as unknown[])[2] as unknown[], index }))
        const rejected = verdicts.filter(({ verdict }) => Number(verdict[0]) !== 0);
        // Outputs and roots are read from the candidate before it is
        // committed, so a rejected wave never reaches the committed tree.
        const engineOutputs = prepared[3] as unknown[];
        const roots = prepared[4] as unknown[];
        const committed = (await client.commit(token)) as unknown[];
        // Count only verdicts the engine actually returned. Enqueue-time
        // accounting lied when a queue drop, process death or malformed reply
        // prevented execution altogether.
        const txTypes = entry.frames.flatMap(frame => frame.txTypes);
        if (verdicts.length !== txTypes.length) {
          throw new Error(`SHADOW_ENGINE_RESULT_LENGTH:${verdicts.length}:${txTypes.length}`);
        }
        for (const [index] of verdicts.entries()) {
          const type = txTypes[index];
          if (type === undefined) throw new Error(`SHADOW_ENGINE_RESULT_INDEX:${index}`);
          this.#stats.executedByType[type] = (this.#stats.executedByType[type] ?? 0) + 1;
        }
        for (const frame of entry.frames) {
          this.#seeded.delete(`${entry.ownerKey}/${frame.accountKey}`);
        }
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
        const rejection = rejected.length > 0
          ? `rejected:${JSON.stringify(rejected[0]?.verdict ?? null)}:job=${JSON.stringify(
              entry.jobs[rejected[0]?.index ?? 0]?.[4] ?? null,
              (_key, value) => (value instanceof Uint8Array || Buffer.isBuffer(value) ? 'bytes' : (value as unknown)),
            )}`
          : null;
        for (const frame of entry.frames) {
          const accountKey = frame.accountKey;
          // Counted only once a verdict exists, so framesCompared always equals
          // matches + mismatches; incrementing first let a stats snapshot taken
          // mid-frame report a comparison with no outcome.
          this.#stats.framesCompared += 1;
          const failure = revisionGap ?? rejection ?? this.#verifyAccount(
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
    expectedOutputs: readonly IndexedShadowOutputRow[],
    engineOutputs: readonly unknown[],
    roots: readonly unknown[],
  ): string | null {
    const actualOutputs = engineOutputProjection(engineOutputs, accountKey);
    const actualText = safeStringify(actualOutputs);
    const expectedText = safeStringify(expectedOutputs);
    if (actualText !== expectedText) {
      return `outputs:ts=${expectedText}:rust=${actualText}`;
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

  #tryBindOwner(ownerKey: string): boolean {
    if (this.#boundOwners.has(ownerKey)) return true;
    if (this.#boundOwners.size >= this.#maxOwners) return false;
    this.#boundOwners.add(ownerKey);
    return true;
  }

  #checkpointSeeds(
    ownerEntityId: string,
    accounts: readonly (readonly [string, AccountReplica])[],
  ): RscoreWireValue[][] {
    return accounts.map(([counterpartyId, account]) => {
      const reason = shadowIneligibilityReason(account);
      if (reason !== null) throw new Error(`SHADOW_PRIME_INELIGIBLE:${counterpartyId}:${reason}`);
      return accountSeedWire(ownerEntityId, counterpartyId, account);
    });
  }

  async #restoreCheckpoint(seeds: RscoreWireValue[][]): Promise<Readonly<{
    client: RscoreProcessClient;
    restored: unknown[];
  }>> {
    const client = this.#makeClient(this.#binaryPath);
    try {
      await client.hello(this.#workers);
      const restored = wireTuple(await client.restore(0, seeds), 'SHADOW_PRIME_RESTORE', 2);
      return { client, restored };
    } catch (error) {
      client.kill();
      throw error;
    }
  }

  /**
   * Reconcile every owner this mirror bound, against the live replicas it was
   * fed. Used as an end-of-run gate: identical trees mean the two engines are
   * interchangeable, and any gap names the exact account.
   */
  async selfReconcile(): Promise<Map<string, ShadowReconciliation>> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      this.flushWave();
      await this.#idle;
      const epoch = this.#noteEpoch;
      const reports = new Map<string, ShadowReconciliation>();
      try {
        for (const [ownerKey, accounts] of this.#mirrored) {
          reports.set(ownerKey, await this.reconcile(ownerKey, accounts));
        }
      } catch (error) {
        if (epoch !== this.#noteEpoch && attempt < 3) continue;
        throw error;
      }
      if (
        epoch === this.#noteEpoch
        && this.#pendingWave.size === 0
        && this.#queue.length === 0
        && !this.#draining
      ) {
        return reports;
      }
    }
    throw new Error('RSCORE_SHADOW_RECONCILE_NOT_QUIESCENT');
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
