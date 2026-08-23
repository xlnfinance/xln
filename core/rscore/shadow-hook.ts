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
        process.once('beforeExit', printStats);
        process.once('exit', printStats);
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

/** Test/shutdown access to the live mirror (null when disabled or not started). */
export const currentShadowMirror = (): MirrorLike | null => mirror ?? null;

/** Test seam: reset module state between test cases. */
export const resetShadowForTests = async (): Promise<void> => {
  const active = mirror;
  mirror = undefined;
  pending = null;
  if (active) await active.shutdown();
};
