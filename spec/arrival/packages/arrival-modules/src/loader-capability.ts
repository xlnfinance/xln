// loader-capability — `arrivalLoaderCapability`: the module system as a plain
// EnvCapability, worked exemplar of docs/environments.md §LOADER.
// `(require …)` / `(require/extension …)` / `(require/register-extension …)` live here;
// per-run state on the capability's own axes (configuration + resources) — nothing
// wired imperatively, nothing pushed out through callbacks.
//
// Model (§LOADER):
//   • `fs` IS configuration; `require` is ALWAYS ENUMERATED, gated by `requiresConfig` —
//     without a derivable loader it binds a DoorProcedure naming `fs`/`loader` (static
//     "missing-configuration", not unbound variable)
//   • run state IS resources: single-flight require session (fresh bag per RunContext =
//     cache reset between runs) + per-live-env RuntimeAssembler (asyncDispose tears
//     extensions out at run teardown)
//   • `require/register-extension` is preludeOnly (must apply before preludes that call
//     it — last in root set / dep edge)
//
// Config consumed by `buildVocabulary` directly. Slice mirrors loader-facing fields of
// the session builder so the ONE shared config bag feeds this capability with no adapter
// (real structural zod checks; ignores the rest of the bag).
import { EnvCapability, execExpr, type EvalTap, type RunContext, type SchemeValue, z } from "@inhuman.tools/arrival";
import {
  AmbientRuntime,
  type AmbientValue,
  applyCallback,
  createRuntimeAssembler,
  ensurePreludeDefineFrame,
  type EnvPack,
  type EnvWithInternals,
  getCapabilityResources,
  is_applyable,
  isAmbientRuntime,
  type ResolvingAmbient,
  type RuntimeAssembler,
} from "@inhuman.tools/arrival/host-internals";
import { ABytevector, AString, theVoid } from "@inhuman.tools/arrival/reflect-internals";
import invariant from "tiny-invariant";

import { RequireCycleError, RequireResolverError } from "./errors.js";
import {
  lookupExtensionResolverIn,
  registerExtensionTransformer,
  type ExtensionResolverRegistry,
} from "./loader-extensions.js";
import {
  dataToScheme,
  dirOf,
  type FsReadLike,
  type Loader,
  makeFsLoader,
  pickHandler,
  type RunEnv,
  runEnvOf,
  runResolverOf,
  type SchemeVal,
} from "./loader.js";

/** Resolve a `(require/extension :name)` argument to the bare extension name. A keyword
 *  (`:sql`) is a self-evaluating symbol (arrival's keyword-tagless-apply.md) that stringifies
 *  to its own name including the leading `:` — strip it; a bare string passes through
 *  unchanged (so `(require/extension "sql")` also works, though `:sql` is the intended,
 *  path-distinct surface). */
function extensionName(arg: unknown): string {
  return String(arg).replace(/^:/, "");
}

const isFsReadLike = (v: unknown): v is FsReadLike =>
  v !== null && typeof v === "object" && typeof (v as FsReadLike).readFile === "function";

const isLoader = (v: unknown): v is Loader =>
  v !== null &&
  typeof v === "object" &&
  typeof (v as Loader).resolve === "function" &&
  typeof (v as Loader).read === "function" &&
  (v as Loader).resolvers instanceof Map;

/** Single-flight module cache + `.scm` cycle/loading bookkeeping. Fresh per RunContext —
 *  dropping the bag at teardown IS the cache reset. */
interface RequireSession {
  /** Each resolved path loads EXACTLY ONCE; sequential repeats and concurrent siblings
   *  await that one promise. */
  readonly inflight: Map<string, Promise<SchemeValue>>;
  /** Paths whose module forms are mid-evaluation (`.scm` load only): re-entrant require is
   *  a genuine R7RS cycle (awaiting would deadlock). */
  readonly evaluating: Set<string>;
  /** `.scm` require chain, for cycle / requireChain message. */
  readonly loadingStack: string[];
  /** Current module dir for relative resolves (seeded with entry `dirname`). SHARED stack
   *  assumes resolve dir stable across concurrent requires — true for same-dir fan-out.
   *  Concurrent cross-dir nested relative requires can mis-resolve (two chains share one stack).
   *
   *  deferred: correct fix threads dir per require-chain via EvalContext, but EvalContext
   *  has no per-eval dir field and execExpr exposes no passthrough; a dynamic-parameter
   *  mechanism would also need core-side support. A dir-carrying child scope is NOT viable
   *  (`.scm` defines must spill into the shared run env). Shared stack stays — correct for
   *  common same-dir case, racy only for concurrent cross-dir nested requires. */
  readonly dirStack: string[];
}

/** Per-RunContext resources bag for every loader verb. Built once per run;
 *  `[Symbol.asyncDispose]` (assembler dispose) runs at RunContext teardown. */
interface LoaderRunResources {
  readonly session: RequireSession;
  /** Derived once per run (`loader` wins over `fs`-derived). `undefined` only when neither
   *  armed — unreachable from require (requiresConfig door gates at bind). */
  readonly loader: Loader | undefined;
  /** File-suffix → resolver-verb-name. Fresh empty per run; populated ONLY from a prelude
   *  via `require/register-extension` (preludeOnly — post-prelude registration impossible). */
  readonly extensionResolvers: ExtensionResolverRegistry;
  /** Per-live-env RuntimeAssembler for `(require/extension …)`. Lazy on first touch;
   *  idempotent per env identity. */
  getOrCreateAssembler(env: RunEnv): RuntimeAssembler<RunEnv>;
  [Symbol.asyncDispose](): Promise<void>;
}

/** Extension-resolver registry for a runCtx — ONE decision point for require's lookup and
 *  register-extension's write. vocabulary === undefined is an invariant violation (bare
 *  RunContext never went through a sanctioned exec entry). Lazy-spawns via
 *  getCapabilityResources — same cache a real dispatch's this.resources would hit. */
function loaderRegistryOf(runCtx: RunContext): ExtensionResolverRegistry {
  invariant(
    runCtx.vocabulary !== undefined,
    "loaderRegistryOf: runCtx carries no vocabulary — require was dispatched outside a sanctioned exec entry point.",
  );
  const resources = getCapabilityResources(runCtx, arrivalLoaderCapability) as LoaderRunResources;
  return resources.extensionResolvers;
}

// Explicit `<any, any>`: declaration-emit can't portably name the inferred config type
// without referencing internal AmbientRuntime across the package boundary. External use
// goes through exec({ capabilities, config }), generic-erased; symbols body still checked
// against real shapes at the define call site.
export const arrivalLoaderCapability = EnvCapability.define("arrival/loader", {
  configuration: {
    /** PRIMARY: the raw read-capable filesystem arming `(require …)`. The capability derives its own
     *  `Loader` from this (`makeFsLoader`) — no host `makeFsLoader` step. */
    fs: z.custom<FsReadLike>(isFsReadLike, "fs must expose readFile(path)").optional(),
    /** COMPAT: a pre-built `Loader` (WINS over `fs`) — the seam for a caller that injects CUSTOM
     *  resolvers into the table (`./yaml` / `./toml` handlers). */
    loader: z.custom<Loader>(isLoader, "loader must have resolve()/read()/resolvers:Map").optional(),
    tap: z
      .custom<EvalTap>(
        (v: unknown): v is EvalTap => v !== null && typeof v === "object" && typeof (v as EvalTap).enter === "function",
        "tap must implement EvalTap.enter()",
      )
      .optional(),
    /** Base dir for resolving relative `(require …)` — the entry module's dirname. Seeds the
     *  per-run session's initial `dirStack`. (`z.custom` + typeof, not `z.string()`: the
     *  scheme-zod `z.string` export is a scheme AString CODEC, not the plain JS-string schema.) */
    dirname: z.custom<string>((v) => typeof v === "string", "dirname must be a string").optional(),
    /** Host-armed registry of named extension packs for `(require/extension :name)`.
     *  Absent ⇒ the verb DOORS (its `requiresConfig` names this key — same static-gate posture
     *  as `require`'s own fs/loader door). */
    extensionRegistry: z
      .custom<ReadonlyMap<string, EnvPack<RunEnv>>>((v) => v instanceof Map, "extensionRegistry must be a Map")
      .optional(),
  },
  /** One bag per RunContext (docs/execution.md §HERMETIC): session, config-derived loader,
   *  lazy per-env assembler — dispose tears runtime-applied extensions out. */
  resources: (config): LoaderRunResources => {
    const { fs, loader } = config as { fs?: FsReadLike; loader?: Loader; dirname?: string };
    let assembler: RuntimeAssembler<RunEnv> | undefined;
    let boundEnv: RunEnv | undefined;
    return {
      session: {
        inflight: new Map(),
        evaluating: new Set(),
        loadingStack: [],
        dirStack: [(config as { dirname?: string }).dirname ?? ""],
      },
      loader: loader ?? (fs ? makeFsLoader(fs) : undefined),
      extensionResolvers: new Map(),
      getOrCreateAssembler(env: RunEnv): RuntimeAssembler<RunEnv> {
        if (assembler === undefined || boundEnv !== env) {
          assembler = createRuntimeAssembler(env);
          boundEnv = env;
        }
        return assembler;
      },
      async [Symbol.asyncDispose](): Promise<void> {
        await assembler?.dispose();
      },
    };
  },
  // Flipped form: symbol record STATIC — every verb always enumerated; config-gating via
  // requiresConfig; impls read this.configuration/this.resources at dispatch.
  symbols: (symbol) => {
    // Assembly-time-only MACRO (§LOADER / §PRELUDE): unevaluated resolver name.
    // loaderRegistryOf referenced before const finishes — safe (lazy, post-load expansion).
    const registerExtension = symbol.macro`require/register-extension`(registerExtensionTransformer(loaderRegistryOf), {
      preludeOnly: true,
    });
    return {
      "require/register-extension": registerExtension,

      require:
        symbol.native`require: loads a module by specifier and returns its value or spills its defines into the environment`(
          {
            input: [z.schemeValue],
            output: [z.schemeValue],
            // ANY-OF: callable with either fs or loader; both absent ⇒ DoorProcedure naming the pair.
            requiresConfig: [["fs", "loader"]],
          },
          // RAW-BOUND native, never rosetta-wrapped (§LOADER): no provenance mint on the return
          // (callable data born when the proc is INVOKED); no return marshal (eval-module scheme
          // lambda survives where jsToScheme would void it).
          //
          // Within a `.scm`, forms execExpr in order (R5RS load — define-macro before next expand).
          // Requires are NOT globally sequential — `(map …)` parallelizes, so same path can be
          // required concurrently; inflight cache shares one load (a flat Set would misread
          // siblings as a cycle). Cycles THROW (R7RS; spill model has no partial exports) —
          // only `.scm` load can require during its own eval; value/eval modules are leaves.
          async function (...args: unknown[]): Promise<SchemeVal> {
            const resources = this.resources as LoaderRunResources | undefined;
            invariant(
              resources !== undefined,
              "require: no run resources — dispatched outside a resource-armed RunContext.",
            );
            const { session, loader } = resources;
            // requiresConfig already gated both-absent at bind.
            invariant(
              loader !== undefined,
              "require: no loader derivable — the fs/loader door should have bound instead.",
            );
            const { tap } = this.configuration as { tap?: EvalTap };
            const resolver = runResolverOf(this, "require");
            const { inflight, evaluating, loadingStack, dirStack } = session;
            const specifierArg = args[0];
            const path = await loader.resolve(String(specifierArg), dirStack.at(-1)!);

            const pending = inflight.get(path);
            if (pending) {
              // Own ancestor → real cycle. Else settled hit or concurrent sibling — share.
              RequireCycleError.invariant(!evaluating.has(path), [...loadingStack, path]);
              return await pending;
            }

            const load = (async (): Promise<SchemeValue> => {
              const contents = await loader.read(path);
              // Capability-registered suffix wins over builtin table. Registry stores NAME —
              // late-bound against THIS env (resource-armed resolver sees THIS env's resource).
              // Registered but unbound verb ⇒ fall through to builtin; missing handler IS the
              // scoping guarantee (must root the capability).
              const resolverName = lookupExtensionResolverIn(loaderRegistryOf(this.runCtx), path);
              const registered = resolverName === undefined ? undefined : resolver.lookup(resolverName);
              if (is_applyable(registered)) {
                // Scheme verb: contents boxed, return IS the module value (yaml/toml rosetta
                // encode the parse; handlebars native returns the pretreat lambda).
                const boxed = typeof contents === "string" ? new AString(contents) : new ABytevector(contents);
                return applyCallback(registered, [boxed], this);
              }
              const handler = pickHandler(path, loader.resolvers);
              RequireResolverError.invariant(handler !== undefined, "no-resolver", path);
              const result = await handler.resolve(contents, { path });

              let value: SchemeValue = theVoid;
              if (result.kind === "value") {
                // dataToScheme: arrays→lists, objects→member-readable. DATA only — JS function
                // would void (CALLABLE RULE, loader.ts); callables use kind:"eval" + scheme lambda.
                value = dataToScheme(result.value);
              } else {
                // load/eval: forms into run env; only load enters cycle domain.
                const isLoad = result.kind === "load";
                dirStack.push(dirOf(path));
                if (isLoad) {
                  evaluating.add(path);
                  loadingStack.push(path);
                }
                try {
                  // Composed resolver keeps capability base (null-rooted lexical alone loses stdlib).
                  // Thread this.runCtx so nested require shares vocabulary/meter/extension registry.
                  for (const form of result.forms) value = await execExpr(form, { resolver, tap, runCtx: this.runCtx });
                } finally {
                  if (isLoad) {
                    loadingStack.pop();
                    evaluating.delete(path);
                  }
                  dirStack.pop();
                }
                // load returns void singleton, not raw JS undefined.
                if (isLoad) value = theVoid;
              }
              return value;
            })();

            inflight.set(path, load);
            try {
              return await load;
            } catch (error) {
              // Don't poison cache — drop so path can retry. Annotate requireChain (deepest
              // wins). Best-effort if frozen.
              inflight.delete(path);
              if (error !== null && typeof error === "object" && !("requireChain" in error)) {
                try {
                  (error as { requireChain?: string[] }).requireChain = [...loadingStack, path];
                } catch {
                  /* frozen/sealed error — annotation is best-effort */
                }
              }
              throw error;
            }
          },
        ),

      "require/extension":
        symbol.native`require/extension: applies a host-registered extension pack (by :name) to the current env`(
          {
            input: [z.schemeValue],
            output: [z.schemeValue],
            // Absent registry ⇒ door naming extensionRegistry (same posture as require's fs/loader).
            requiresConfig: ["extensionRegistry"],
          },
          // RAW-BOUND (§LOADER). Applies pack via per-env RuntimeAssembler; returns void.
          // Mid-run scope shape (ruling 2026-08-13, audit B4): SEED child C' of the live
          // env carries register-extension + any preludeOnly binds (discarded — never
          // main-phase-resolvable); the pack's prelude TEXT evaluates against a child D'
          // of C', and D's OWN defines are copied into the run's persistent
          // prelude-define frame after apply — an extension's prelude defines ARE
          // main-phase bindings ("invocation survives, reference does not"; §PRELUDE).
          async function (...args: unknown[]): Promise<SchemeVal> {
            const resources = this.resources as LoaderRunResources | undefined;
            invariant(
              resources !== undefined,
              "require/extension: no run resources — dispatched outside a resource-armed RunContext.",
            );
            const { extensionRegistry } = this.configuration as {
              extensionRegistry?: ReadonlyMap<string, EnvPack<RunEnv>>;
            };
            invariant(
              extensionRegistry !== undefined,
              "require/extension: no extensionRegistry — the config door should have bound instead.",
            );
            const env = runEnvOf(this, "require/extension");
            const name = extensionName(args[0]);
            const pack = extensionRegistry.get(name);
            RequireResolverError.invariant(pack !== undefined, "no-extension", name, [...extensionRegistry.keys()]);
            const assembler = resources.getOrCreateAssembler(env);
            // Discarded child, hand-bound (SchemeEnv has no write member) — env.child + env.bind.
            invariant(
              isAmbientRuntime(env),
              "require/extension: the run env is not an arrival AmbientRuntime — a mid-run prelude scope must be minted off a real frame to receive bindings.",
            );
            const preludeScope = env.child(`prelude/${name}`) as EnvWithInternals;
            preludeScope.bind("require/register-extension", registerExtension.macro);
            // The eval child: pack prelude defines land HERE, apart from the seed binds.
            const preludeEvalScope = preludeScope.child(`prelude/${name}/defines`);
            await assembler.require(pack, {
              preludeScope: { set: (n, v) => preludeScope.bind(n, v as AmbientValue) },
              // through-unknown widen: assembler typed over structural RunEnv; frame is concrete.
              preludeEvalScope: preludeEvalScope as RunEnv & AmbientRuntime,
            });
            // Persist the pack's prelude defines into this run's define frame (own-record
            // read, sanctioned: list() is own names; values entered through `.bind`).
            const defines = ensurePreludeDefineFrame(this.runCtx) as EnvWithInternals<ResolvingAmbient>;
            for (const defineName of preludeEvalScope.list()) {
              defines.bind(defineName, preludeEvalScope.__env__[defineName]!);
            }
            return theVoid;
          },
        ),
    };
  },
});
