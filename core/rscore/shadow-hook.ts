/**
 * Fire-and-forget entry point wired into the Account frame-commit path.
 *
 * Kept import-light on purpose: the mirror (and its child-process client) is
 * loaded dynamically only when XLN_RSCORE_SHADOW=1 in a Bun/Node runtime, so
 * browser bundles and non-shadow servers pay one env check per frame.
 */
import type { ShadowFrameInput, ShadowGap, ShadowReconciliation, ShadowStats } from './shadow';
import type { RuntimeState } from '../runtime/types';
import type { AccountReplica } from '../types/account';

type ShadowStatsLike = ShadowStats;

type MirrorLike = Readonly<{
  noteCommittedFrame(input: ShadowFrameInput): void;
  primeOwner(ownerEntityId: string, accounts: ReadonlyMap<string, AccountReplica>): Promise<void>;
  flushWave(): void;
  onGap(callback: (gap: ShadowGap) => void): void;
  onProgress(callback: () => void): void;
  settled(): Promise<void>;
  shutdown(): Promise<void>;
  stats(): ShadowStatsLike;
  selfReconcile(): Promise<Map<string, ShadowReconciliation>>;
}>;

let mirror: MirrorLike | null | undefined;
let pending: ShadowFrameInput[] | null = null;
/** Resolves once the mirror is armed (or has failed to arm). */
let arming: Promise<void> | null = null;

const shadowEnabled = (): boolean => {
  if (typeof process === 'undefined' || typeof process.env === 'undefined') return false;
  if (process.env['XLN_RSCORE_SHADOW'] !== '1') return false;
  return typeof globalThis.Bun !== 'undefined' || typeof process.versions?.node === 'string';
};

const entityAllowed = (ownerEntityId: string): boolean => {
  const filter = process.env['XLN_RSCORE_SHADOW_ENTITY'];
  if (!filter) return true;
  return filter.trim().toLowerCase() === ownerEntityId.trim().toLowerCase();
};

/**
 * Measured, not assumed: reducer microseconds per transition on each side, and
 * the round trip that includes transport so the IPC cost stays visible.
 */
const speedSummary = (stats: ShadowStatsLike): string => {
  const per = (total: number): string =>
    (stats.timedTxs === 0 ? 0 : total / stats.timedTxs).toFixed(1);
  const ratio = stats.rustEngineUs === 0
    ? 'n/a'
    : (stats.tsApplyUs / stats.rustEngineUs).toFixed(2);
  return `speed[txs=${stats.timedTxs} tsUs/tx=${per(stats.tsApplyUs)} ` +
    `rustUs/tx=${per(stats.rustEngineUs)} wireUs/tx=${per(stats.rustWireUs)} ts/rust=${ratio}]`;
};

const attachMirrorReporting = (started: MirrorLike): void => {
  const printStats = (): void => {
    try { console.error(`RSCORE_SHADOW_STATS ${JSON.stringify(started.stats())}`); } catch { /* observer-only */ }
  };
  started.onGap(gap => { haltOnGap(gap, printStats); });
  printStats();
  started.onProgress(printStats);
  process.once('beforeExit', printStats);
  process.once('exit', printStats);
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, printStats);
};

const createMirror = async (): Promise<MirrorLike> => {
  const [{ RscoreShadowMirror }, { RscoreProcessClient }] = await Promise.all([
    import('./shadow'),
    import('./client'),
  ]);
  const binaryPath = process.env['XLN_RSCORE_BINARY']
    ?? new URL('../../rscore/target/release/xln-rscore', import.meta.url).pathname;
  const started = new RscoreShadowMirror({
    binaryPath,
    workers: Number(process.env['XLN_RSCORE_SHADOW_WORKERS'] ?? '4'),
    maxOwners: Number(process.env['XLN_RSCORE_SHADOW_MAX_ENTITIES'] ?? '1'),
    makeClient: path => new RscoreProcessClient(path, {
      engineGeneration: Buffer.alloc(8, 0x5d),
      runtimeId: Buffer.alloc(20, 0x5d),
      sessionId: Buffer.alloc(16, 0x5d),
    }),
  });
  attachMirrorReporting(started);
  return started;
};

const armMirror = async (prime?: (started: MirrorLike) => Promise<void>): Promise<void> => {
  let started: MirrorLike | null = null;
  try {
    started = await createMirror();
    if (prime) await prime(started);
    for (const buffered of pending ?? []) started.noteCommittedFrame(buffered);
    started.flushWave();
    pending = null;
    mirror = started;
  } catch (error) {
    if (started) await started.shutdown().catch(() => undefined);
    pending = null;
    mirror = null;
    console.error(`RSCORE_SHADOW_INIT_FAILED:${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
};

/**
 * Microsecond clock for the TypeScript-vs-engine speed comparison. Returns 0
 * when the mirror is off, so the reducer pays one boolean check per tx and the
 * measurement never exists in a production run that did not ask for it.
 */
export const shadowClockUs = (): number =>
  shadowEnabled() ? Math.round(performance.now() * 1000) : 0;

export const noteAccountFrameForShadow = (input: ShadowFrameInput): void => {
  if (mirror === null) return;
  if (mirror === undefined) {
    if (!shadowEnabled()) {
      mirror = null;
      return;
    }
    if (!entityAllowed(input.ownerEntityId)) return;
    if (pending) {
      pending.push(input);
      return;
    }
    pending = [input];
    arming = armMirror();
    void arming.catch(() => undefined);
    return;
  }
  if (!entityAllowed(input.ownerEntityId)) return;
  mirror.noteCommittedFrame(input);
};

/** Prime the Rust process from the exact recovered Runtime checkpoint. */
export const primeShadowFromRuntimeState = async (state: RuntimeState): Promise<void> => {
  if (!shadowEnabled()) return;
  if (mirror !== undefined || arming !== null) throw new Error('RSCORE_SHADOW_PRIME_TOO_LATE');
  const owners = [...state.eReplicas.values()]
    .filter(replica => entityAllowed(replica.entityId))
    .sort((left, right) => left.entityId.localeCompare(right.entityId));
  if (owners.length === 0) throw new Error('RSCORE_SHADOW_PRIME_NO_OWNER');
  pending = [];
  arming = armMirror(async started => {
    for (const replica of owners) await started.primeOwner(replica.entityId, replica.state.accounts);
  });
  await arming;
};

/**
 * End-of-run parity gate: reconcile every mirrored tree and throw when the two
 * engines disagree or the mirror never covered an account. Returns silently
 * when shadow is off, so callers can invoke it unconditionally.
 */
/**
 * Strict replay mode: verify the whole tree after every Runtime frame instead
 * of only at the end, so a divergence names the exact frame that introduced it.
 */
export const shadowStrictEnabled = (): boolean =>
  shadowEnabled() && process.env['XLN_RSCORE_SHADOW_STRICT'] === '1';

/**
 * Strict live mode: the first parity gap stops the process where it happened.
 *
 * A gap is not only a divergence — a repair reseed or a refused account
 * silently restores agreement instead of proving it, so both halt too. The
 * dump carries the account, the frame height, the tx types of that frame and
 * (for divergences) which section's root differs, which is everything needed
 * to reproduce the frame in isolation.
 */
const haltOnGap = (gap: ShadowGap, printStats: () => void): void => {
  if (!shadowStrictEnabled()) return;
  try {
    console.error(`RSCORE_SHADOW_HALT ${JSON.stringify(gap)}`);
    printStats();
  } catch { /* observer-only */ }
  process.exit(RSCORE_SHADOW_HALT_EXIT_CODE);
};

/** Distinct exit code so a harness can tell a parity halt from a crash. */
export const RSCORE_SHADOW_HALT_EXIT_CODE = 70;

export const assertShadowParity = async (label = 'end-of-run'): Promise<void> => {
  // The mirror boots asynchronously (dynamic import, Hello, Restore). Waiting
  // for it is mandatory: returning early while it is still arming turned
  // "nothing was verified yet" into a pass.
  if (arming) await arming;
  const active = mirror;
  if (!active) {
    // Any caller asking for parity while shadow is enabled asks for proof.
    // Returning here after an init failure made the non-strict gate green
    // without a single Rust transition.
    if (shadowEnabled()) throw new Error(`RSCORE_SHADOW_PARITY_UNARMED:${label}`);
    return;
  }
  active.flushWave();
  await active.settled();
  const reports = await active.selfReconcile();
  const failures: string[] = [];
  // Coverage first: a run where the engine executed nothing, or where every
  // gap was papered over with a reseed, produces a clean reconciliation and
  // proves nothing. These counters are the difference between "the two
  // engines agree" and "the mirror never disagreed with itself".
  const stats = active.stats();
  if (stats.disabledReason !== null) failures.push(`disabled=${stats.disabledReason}`);
  if (stats.framesCompared === 0) failures.push('framesCompared=0');
  if (stats.matches !== stats.framesCompared) {
    failures.push(`matches=${stats.matches}!=compared=${stats.framesCompared}`);
  }
  if (stats.mismatches > 0) failures.push(`mismatches=${stats.mismatches}`);
  // Whole-tree checkpoints: every Runtime boundary compares the engine's
  // committed accounts root against the TypeScript forest, so an account that
  // drifted outside the frames being replayed cannot hide until the end.
  if (stats.forestMismatches > 0) failures.push(`forestMismatches=${stats.forestMismatches}`);
  if (stats.forestChecks === 0) failures.push('forestChecks=0');
  if (stats.reseedsRepair > 0) failures.push(`reseedsRepair=${stats.reseedsRepair}`);
  if (stats.dropped > 0) failures.push(`dropped=${stats.dropped}`);
  // Owners beyond the binding limit never reached the engine at all, so a
  // green report for the bound owner says nothing about them.
  if (stats.skippedUnboundOwner > 0) {
    failures.push(`skippedUnboundOwner=${stats.skippedUnboundOwner}`);
  }
  // An account whose state was imported but never executed a transition
  // reproduces the TS root by construction.
  if (stats.seededNeverExecuted > 0) {
    failures.push(`seededNeverExecuted=${stats.seededNeverExecuted}`);
  }
  if (stats.skippedIneligible > 0) {
    failures.push(`skippedIneligible=${stats.skippedIneligible}:${JSON.stringify(stats.ineligibleReasons)}`);
  }
  if (Object.keys(stats.unsupportedTxTypes).length > 0) {
    failures.push(`unsupportedTxTypes=${JSON.stringify(stats.unsupportedTxTypes)}`);
  }
  if (reports.size === 0) failures.push('reconciledOwners=0');
  for (const [owner, report] of reports) {
    if (report.mismatched.length > 0) {
      failures.push(`${owner}:mismatched=${JSON.stringify(report.mismatched).slice(0, 400)}`);
    }
    if (report.missingInEngine.length > 0) {
      failures.push(`${owner}:missingInEngine=${report.missingInEngine.length}`);
    }
    if (report.extraInEngine.length > 0) {
      failures.push(`${owner}:extraInEngine=${report.extraInEngine.length}`);
    }
    // The whole tree, not only leaf-by-leaf agreement: a divergent forest root
    // over identical leaves means the two radix implementations disagree.
    if (!report.forestRoot.equal) {
      failures.push(
        `${owner}:forestRoot ts=${report.forestRoot.typescript} rust=${report.forestRoot.rust}`,
      );
    }
  }
  for (const [owner, report] of reports) {
    if (report.matched === 0) failures.push(`${owner}:matchedAccounts=0`);
  }
  const summary = [...reports].map(([owner, report]) => `${owner.slice(0, 10)}:${report.matched}`).join(' ');
  if (failures.length > 0) {
    throw new Error(`RSCORE_SHADOW_PARITY_FAILED:${label}:${failures.join('|')}`);
  }
  console.error(
    `RSCORE_SHADOW_PARITY_OK ${label} matched=[${summary}] compared=${stats.framesCompared} ` +
    `reseeds=${stats.reseeds} forestChecks=${stats.forestChecks} ` +
    `executed=${JSON.stringify(stats.executedByType)} ${speedSummary(stats)}`,
  );
};

/**
 * Runtime frame boundary: every Account frame committed by this Runtime frame
 * goes to the engine as one wave, so the engine's worker pool sees the whole
 * frame at once instead of one account at a time. No-op when shadow is off.
 */
export const flushShadowWave = (): void => {
  mirror?.flushWave();
};

/** Test/shutdown access to the live mirror (null when disabled or not started). */
export const currentShadowMirror = (): MirrorLike | null => mirror ?? null;

/** Test seam: reset module state between test cases. */
export const resetShadowForTests = async (): Promise<void> => {
  const active = mirror;
  mirror = undefined;
  pending = null;
  arming = null;
  if (active) await active.shutdown();
};
