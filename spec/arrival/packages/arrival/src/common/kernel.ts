// kernel.ts — IMPLEMENTATION of arrival's env-assembly machine. Env-agnostic core: closure +
// 3-color cycle detection, identity dedup, and C3 linearization (the merge) — `linearize`,
// shared with `env/vocabulary.ts`'s `buildVocabulary` via `dag-linearize.ts`'s domain-agnostic
// walk. Live consumer: `createRuntimeAssembler` — mid-run, live-env pack applier backing
// `(require/extension :name)` (§LOADER): host-supplied `EnvPack`s registered via
// `@inhuman.tools/arrival-modules`' `extensionRegistry` config key, applied onto an ALREADY-LIVE env
// after vocabulary-path bootstrap has already run. Bootstrap assembly is
// `env/vocabulary.ts`'s `buildVocabulary` (mints a frozen `Vocabulary` map — not this module).
//
// The MODEL — what assembly is, why C3 (= Python MRO), the dep-edge-is-grant law, apply-once —
// is docs/environments.md §ASSEMBLY; this file enforces the mid-run half of it.

// Errors (teaching, errors-as-doors) live in errors.ts. Imported here for the throw sites
// below.
import {
  AssembleConfigConflictError,
  AssembleCycleError,
  AssembleLinearizationError,
  AssemblePackError,
  AssemblePackTimeoutError,
} from "../errors.js";
// Shared C3 (Python MRO) core — extracted so `env/vocabulary.ts`'s EnvCapability-DAG walk
// reuses the SAME algorithm. This module keeps throwing its OWN error types via the hooks
// `linearizeDag` calls back into.
import { linearizeDag } from "./dag-linearize.js";

/** A capability contribution to an env. Identity = (name, config). `deps` are the DAG edges. */
export interface EnvPack<E = unknown> {
  readonly name: string;
  readonly deps?: readonly EnvPack<E>[];
  /** Host-injected arming for THIS pack (inferPack.config = the InferFn, mcpPack.config = the
   *  resolver). Two same-name packs with non-equal config in one assembly = AssembleConfigConflictError. */
  readonly config?: unknown;
  /** Runs once, after all deps, in C3 order. May await import / bind / ctx.onDispose.
   *  MUST contribute symbols via the env's membrane-wrapping API, never a bare host closure. */
  apply(env: E, ctx: PackContext<E>): void | Promise<void>;
}

/** The narrow surface a `preludeOnly` symbol's BINDING lands on. Deliberately just `.set`:
 *  capability.ts's bindTarget only ever writes. BOOTSTRAP assembly (`env/vocabulary.ts`'s
 *  `buildVocabulary`) mirrors it into its own `preludeOnly` Map; MID-RUN application
 *  (this module's `RuntimeAssembler`) hands the caller's adapter over a real, discarded child
 *  frame (`@inhuman.tools/arrival-modules` wraps `AmbientRuntime.bind` — `SchemeEnv` itself
 *  carries no write member; docs/environments.md §HERMETIC). */
export interface PreludeBindTarget {
  set(name: string, value: unknown): unknown;
}

export interface PackContext<E = unknown> {
  /** Register a teardown thunk; run LIFO by `RuntimeAssembler.dispose()`. */
  onDispose(fn: () => void | Promise<void>): void;
  /** The C3 linearization this pack sits in (highest precedence first) — debug/audit. */
  readonly order: readonly string[];
  /** The scope a `preludeOnly` symbol routes its BINDING onto instead of the runtime env —
   *  caller-supplied (`RuntimeAssembler.require`): a discarded child `C'` of the live env
   *  (@inhuman.tools/arrival-modules's `arrivalLoaderCapability`,
   *  `require/extension`'s declaration). Undefined when that caller passes none.
   *  Bootstrap's `preludeOnly` binding lands on `env/vocabulary.ts`'s `preludeOnly` Map
   *  directly, no kernel-level overlay. */
  readonly preludeScope?: PreludeBindTarget;
  /** The scope a capability's `prelude` TEXT is evaluated AGAINST — distinct from
   *  `preludeScope` (the bind target). MID-RUN (ruling 2026-08-13, audit B4):
   *  `preludeScope` = a discarded seed child `C'` of the live env (register-extension +
   *  preludeOnly binds — never main-phase-resolvable); `preludeEvalScope` = a child `D'`
   *  of `C'` the prelude evaluates in. Re-parenting a LIVE env is unsafe (concurrent
   *  lookups), so lookups miss `D'`/`C'` → hit `liveEnv` → base. After `require()`
   *  returns, the CALLER (`@inhuman.tools/arrival-modules`) copies `D'`'s own defines into the
   *  run's persistent prelude-define frame — a mid-run pack's prelude DOES contribute
   *  runtime bindings; only the seed dies. NOTE: binding persistence is CALLER-DEFINED —
   *  bootstrap `.set` persists via `Vocabulary`; mid-run `.set` (the seed) is discarded. */
  readonly preludeEvalScope?: E;
}

const packTimeoutMs = (): number => Number(process.env.ASSEMBLE_PACK_TIMEOUT_MS) || 30_000;

/** Structural-or-identity config equality: reference-equal (functions, resolvers) OR deep-equal
 *  for plain data. Functions are never structurally equal — only the same reference dedups. */
function configEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "function" || typeof b === "function") return false;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => configEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

function withTimeout<T>(p: Promise<T> | T, ms: number, name: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new AssemblePackTimeoutError(name, ms)), ms);
  });
  return Promise.race([Promise.resolve(p), timeout]).finally(() => clearTimeout(timer));
}

/** Shared core: closure + cycle-detect + dedup + C3 linearization. Returns the apply order
 *  (highest precedence first) and the deduped packs by name. Delegates the walk to
 *  `dag-linearize.ts`'s domain-agnostic core (same algorithm `env/vocabulary.ts` reuses for
 *  the EnvCapability DAG), supplying EnvPack's OWN identity rule (config equality, not object
 *  identity) and error types via the hooks. */
function linearize<E>(roots: readonly EnvPack<E>[]): { order: string[]; byName: Map<string, EnvPack<E>> } {
  return linearizeDag(roots, {
    onRevisit: (existing, candidate) => {
      if (!configEqual(existing.config, candidate.config)) throw new AssembleConfigConflictError(candidate.name);
    },
    onCycle: (path) => {
      throw new AssembleCycleError(path);
    },
    onInconsistent: (owner) => {
      throw new AssembleLinearizationError(owner);
    },
  });
}

/** A live-env assembler for RUNTIME pack application — the `(require/extension :name)` path
 *  (§LOADER). The mid-run single-flight contract — apply onto an ALREADY-LIVE env, a second or
 *  concurrent `require` awaiting the one in-flight apply (never re-applying), deps applied first in
 *  C3 order, a pack reached two ways applied once — is docs/environments.md §ASSEMBLY. Disposers collect
 *  for a single LIFO `dispose()` tied to the env's teardown. */
export interface RuntimeAssembler<E = unknown> {
  /** Apply `pack` (and any not-yet-applied deps) to the live env, in C3 order. Idempotent.
   *  `opts.preludeScope`/`opts.preludeEvalScope`, when passed, are threaded onto every applied
   *  pack's `ctx` for THIS require() call only — see `PackContext.preludeScope` /
   *  `.preludeEvalScope` (a scheme-aware caller seeds a discarded CHILD scope here — the live
   *  env can't be handed to bootstrap's phase-gated machinery mid-run, and it must not
   *  accumulate prelude defines). */
  require(pack: EnvPack<E>, opts?: { preludeScope?: PreludeBindTarget; preludeEvalScope?: E }): Promise<void>;
  /** Tear down every runtime-applied pack, LIFO (reverse of apply order). */
  dispose(): Promise<void>;
}

export function createRuntimeAssembler<E>(env: E): RuntimeAssembler<E> {
  // name → the in-flight-or-settled apply promise. Presence = APPLYING|APPLIED (single-flight key);
  // a rejecting apply deletes its entry so a later require may retry (FAILED → APPLYING).
  const applied = new Map<string, Promise<void>>();
  const disposers: Array<() => void | Promise<void>> = [];

  const applyOne = (
    name: string,
    pack: EnvPack<E>,
    order: readonly string[],
    preludeOpts: { preludeScope?: PreludeBindTarget; preludeEvalScope?: E },
  ): Promise<void> => {
    const existing = applied.get(name);
    if (existing) return existing; // idempotent + single-flight (no await between get and set below)
    const ctx: PackContext<E> = {
      onDispose: (fn) => disposers.push(fn),
      order,
      preludeScope: preludeOpts.preludeScope,
      preludeEvalScope: preludeOpts.preludeEvalScope,
    };
    // The async IIFE turns a SYNCHRONOUS throw in apply() into a rejection so the catch handles it
    // uniformly (a bare `pack.apply(...)` would throw before withTimeout was even called).
    const p = (async () => withTimeout(pack.apply(env, ctx), packTimeoutMs(), name))().catch((error) => {
      applied.delete(name); // FAILED: drop so a re-require retries; the pack's own disposers ran via ctx
      if (error instanceof AssemblePackTimeoutError) throw error;
      throw new AssemblePackError(name, error);
    });
    applied.set(name, p);
    return p;
  };

  return {
    require: async (
      pack: EnvPack<E>,
      opts: { preludeScope?: PreludeBindTarget; preludeEvalScope?: E } = {},
    ): Promise<void> => {
      const { order, byName } = linearize([pack]);
      // Apply least-precedence (deps) first, matching construction's last-write-wins order.
      for (const name of order.toReversed()) {
        await applyOne(name, byName.get(name)!, order, opts);
      }
    },
    dispose: async (): Promise<void> => {
      for (let i = disposers.length - 1; i >= 0; i--) {
        try {
          await disposers[i]();
        } catch {
          /* best-effort teardown */
        }
      }
    },
  };
}
