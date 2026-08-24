/**
 * Fire-and-forget entry point wired into the Account frame-commit path.
 *
 * Kept import-light on purpose: the mirror (and its child-process client) is
 * loaded dynamically only when XLN_RSCORE_SHADOW=1 in a Bun/Node runtime, so
 * browser bundles and non-shadow servers pay one env check per frame.
 */
import type { ShadowFrameInput } from './shadow';

type MirrorLike = Readonly<{
  noteCommittedFrame(input: ShadowFrameInput): void;
  settled(): Promise<void>;
  shutdown(): Promise<void>;
  stats(): unknown;
  selfReconcile(): Promise<Map<string, {
    matched: number;
    mismatched: readonly unknown[];
    missingInEngine: readonly string[];
    extraInEngine: readonly string[];
  }>>;
}>;

let mirror: MirrorLike | null | undefined;
let pending: ShadowFrameInput[] | null = null;

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
    void (async () => {
      try {
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
        for (const buffered of pending ?? []) started.noteCommittedFrame(buffered);
        pending = null;
        mirror = started;
        const printStats = (): void => {
          try { console.error(`RSCORE_SHADOW_STATS ${JSON.stringify(started.stats())}`); } catch { /* observer-only */ }
        };
        // A hub runtime is killed with a signal and never reaches 'exit', so
        // exit-only reporting silently looks identical to "shadow never ran".
        printStats();
        started.onProgress(printStats);
        process.once('beforeExit', printStats);
        process.once('exit', printStats);
        for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, printStats);
      } catch (error) {
        pending = null;
        mirror = null;
        console.error(`RSCORE_SHADOW_INIT_FAILED:${error instanceof Error ? error.message : String(error)}`);
      }
    })();
    return;
  }
  if (!entityAllowed(input.ownerEntityId)) return;
  mirror.noteCommittedFrame(input);
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

export const assertShadowParity = async (label = 'end-of-run'): Promise<void> => {
  const active = mirror;
  if (!active) {
    // Strict mode asks for proof, so an unarmed mirror is itself a failure:
    // silently verifying nothing is exactly the trap this mode exists to close.
    if (shadowStrictEnabled() && pending === null) {
      throw new Error(`RSCORE_SHADOW_PARITY_UNARMED:${label}`);
    }
    return;
  }
  const reports = await active.selfReconcile();
  const failures: string[] = [];
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
  }
  const summary = [...reports].map(([owner, report]) => `${owner.slice(0, 10)}:${report.matched}`).join(' ');
  if (failures.length > 0) {
    throw new Error(`RSCORE_SHADOW_PARITY_FAILED:${label}:${failures.join('|')}`);
  }
  console.error(`RSCORE_SHADOW_PARITY_OK ${label} matched=[${summary}]`);
};

/** Test/shutdown access to the live mirror (null when disabled or not started). */
export const currentShadowMirror = (): MirrorLike | null => mirror ?? null;

/** Test seam: reset module state between test cases. */
export const resetShadowForTests = async (): Promise<void> => {
  const active = mirror;
  mirror = undefined;
  pending = null;
  if (active) await active.shutdown();
};
