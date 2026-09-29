/**
 * Eager single-evaluation tripwire for modules that keep dynamic-extent state
 * in a module-local binding.
 *
 * A bundler (Vite `/@fs` + prebundle, esbuild/wrangler subpath split) can
 * evaluate the same source twice in one isolate. Module-local holders then
 * split: one copy writes, the other reads empty, and the failure looks like
 * a missing ambient. Pinning the holder on `globalThis` would silently merge
 * the copies — the wrong response; the isolate is already malformed.
 *
 * `globalThis` is used ONLY as a load-identity registry (`Symbol.for` key).
 * The holder itself stays module-local.
 */
export class DuplicateModuleLoadError extends Error {
  readonly name = "DuplicateModuleLoadError";
  constructor(readonly moduleId: string) {
    super(
      `${moduleId} evaluated twice in this isolate. A bundler duplicated the module; ` +
        `Arrival's dynamic-extent state is module-local and a second copy would split it.`,
    );
  }
}

export function assertSingleLoad(moduleId: string): void {
  const key = Symbol.for(`arrival/single-load/${moduleId}`);
  const g = globalThis as Record<symbol, true | undefined>;
  if (g[key] === true) throw new DuplicateModuleLoadError(moduleId);
  g[key] = true;
}
