// -------------------------------------------------------------------------
// :: errors.ts — single home for every arrival Error subclass.
//
// Runtime LEAF: NO runtime imports. Interop-boundary is on the READER side
// (interop-access.ts's instanceof checks). value-guards is NOT safe to depend
// on here — it imports the primitive barrel as VALUES and would leave AValue
// undefined when a subclass extends it. StackFrame / SchemeValue are TYPE-only.
// -------------------------------------------------------------------------
import type { StackFrame } from "./eval/evaluator.js";
import type { SchemeValue } from "./values/types.js";

// SPEC-TAXONOMY CODES — stable ids (E-UNTERMINATED, E-DICT-DUP-KEY, …).
// Polyglot grammar specs match on `code`, not prose.

// -------------------------------------------------------------------------
// :: Source Location Tracking
// -------------------------------------------------------------------------

export interface SourceLocation {
  /** 1-indexed line number */
  line: number;
  /** 0-indexed column number */
  col: number;
  /** 0-indexed byte offset from start of source */
  offset: number;
  source?: string;
}

export function formatLocation(loc: SourceLocation): string {
  const source = loc.source ? `${loc.source}:` : "";
  return `${source}${loc.line}:${loc.col}`;
}

export class Unterminated extends Error {
  // Interop: instanceof Unterminated arm in interop-access.ts (non-ArrivalError roots get an arm).

  /** errors-as-doors: X.invariant(cond, ...facts) throws the RECEIVER, never bare Error.
   *  Repeated per-class — Unterminated/ParseError do not extend ArrivalError. */
  static invariant<T extends new (...args: any) => any>(
    this: T,
    condition: boolean,
    ...args: ConstructorParameters<T>
  ): asserts condition {
    if (!condition) throw new this(...args);
  }

  location?: SourceLocation;
  /** Stable spec-taxonomy id — see SPEC-TAXONOMY CODES in the file header. */
  readonly code = "E-UNTERMINATED";

  constructor(message: string, location?: SourceLocation) {
    super(location ? `${message} at ${formatLocation(location)}` : message);
    this.name = "Unterminated";
    this.location = location;
  }
}

export class ParseError extends Error {
  // Interop: instanceof ParseError arm in interop-access.ts.

  /** Same invariant idiom as Unterminated — repeated per non-ArrivalError root. */
  static invariant<T extends new (...args: any) => any>(
    this: T,
    condition: boolean,
    ...args: ConstructorParameters<T>
  ): asserts condition {
    if (!condition) throw new this(...args);
  }

  location?: SourceLocation;
  /** Stable spec-taxonomy id (e.g. E-DICT-DUP-KEY) — see SPEC-TAXONOMY CODES
   *  in the file header. */
  code?: string;

  constructor(message: string, location?: SourceLocation, code?: string) {
    super(location ? `${message} at ${formatLocation(location)}` : message);
    this.name = "ParseError";
    this.location = location;
    this.code = code;
  }
}

export class EvalError extends Error {
  // Interop: instanceof EvalError arm in interop-access.ts.

  location?: SourceLocation;
  code?: unknown;
  /** Corrected-form the door teaches. String when unambiguous; array when ≥2 clear
   *  readings. `code` routes, `hint` teaches. */
  hint?: string | string[];

  constructor(message: string, options?: { location?: SourceLocation; code?: unknown; hint?: string | string[] }) {
    const loc = options?.location;
    super(loc ? `${message} at ${formatLocation(loc)}` : message);
    this.name = "EvalError";
    this.location = options?.location;
    this.code = options?.code;
    this.hint = options?.hint;
  }
}

// -------------------------------------------------------------------------
// :: ErrorClass — closed taxonomy both worlds classify into. Oracle compares
// CLASS, never message. Every ArrivalError subclass declares its own literal
// `"arrival/error-category"` — compile-time-checked fact ON the type.
// -------------------------------------------------------------------------
export type ErrorClass =
  | "empty-list-access"
  | "unbound-variable"
  | "type-mismatch"
  | "division-by-zero"
  | "arity-mismatch"
  | "unsupported-form"
  | "exact-overflow" // crash-on-overflow guarantee — see ExactOverflowError
  | "prohibited-dynamics" // immutability/no-dynamics-by-design — see PurityError
  | "domain-immutability" // temporal zoning of domain lanes (CQS) — see ResourcePathConflictError
  | "contract-shape" // bake-time contract contradiction — ProvenanceRoleShapeError, CacheClassShapeError, ResourcePathDeclarationError
  | "user-error" // R7RS (error …) raise
  /** @deprecated Prefer a named class — the fallback bin accumulates unrelated failures. */
  | "other";

// -------------------------------------------------------------------------
// :: ArrivalError — base for every arrival / Scheme-level error.
// StackFrame is TYPE-only — value terms throw without pulling the evaluator.
// -------------------------------------------------------------------------

function readLocation(code: SchemeValue): SourceLocation | undefined {
  return "location" in code ? code.location : undefined;
}

export abstract class ArrivalError extends Error {
  // Interop: nominal instanceof ArrivalError family rule in interop-access.ts.
  public readonly name: string = "ArrivalError";

  abstract readonly "arrival/error-category": ErrorClass;

  /** errors-as-doors: MyError.invariant(cond, ...facts) throws the RECEIVER.
   *  NOT the global @here.build/error-invariant install (that strips messages under
   *  NODE_ENV=production; arrival doors never strip — message richness is free). */
  static invariant<T extends new (...args: any) => any>(
    this: T,
    condition: boolean,
    ...args: ConstructorParameters<T>
  ): asserts condition {
    if (!condition) throw new this(...args);
  }

  constructor(
    message: string,
    public readonly schemeStack: StackFrame[] = [],
    public readonly cause?: Error,
  ) {
    super(message);
    // Capture on THIS wrapper only — capturing on the cause overwrites its original stack.
    Error.captureStackTrace?.(this);
  }

  get stack() {
    return this.cause?.stack ?? super.stack;
  }

  toString(): string {
    let result = `${this.name}: ${this.message}`;
    if (this.schemeStack.length > 0) {
      result += "\n\nScheme Stack Trace:";
      for (const [i, frame] of this.schemeStack.entries()) {
        const env = frame.env_name ? ` [${frame.env_name}]` : "";
        const proc = frame.procedure ? ` in ${frame.procedure}` : "";
        const loc = frame.location ?? readLocation(frame.code);
        const locStr = loc ? ` at ${formatLocation(loc)}` : "";
        result += `\n  ${i + 1}. ${String(frame.code)}${locStr}${proc}${env}`;
      }
    }
    return result;
  }
}

// RAW HOST-runtime error — V8/engine throw from a native impl that skipped its contract.
// Message is the only discriminant (engine-authored phrases; arrival never writes them).
// Host bug is an INTERNAL defect — keeps scheme stack. Matching is conservative.
const HOST_RUNTIME_BUG_RE =
  /Cannot read propert|reading '|is not a function|is not iterable|is not a constructor|Spread syntax requires|Maximum call stack|is not defined/;
// Returns boolean, not `e is Error` — a predicate would make else-branch `never`.
export function isHostRuntimeBug(e: unknown): boolean {
  return (
    (e instanceof TypeError || e instanceof RangeError || e instanceof ReferenceError) &&
    HOST_RUNTIME_BUG_RE.test(e.message)
  );
}

/** Render a thrown error into a display-ready message for a host's run-error surface. A
 *  non-empty `schemeStack` contributes form-by-form frames (`toString()` — form +
 *  file:line + procedure); a `requireChain` (annotated by `@inhuman.tools/arrival-modules`
 *  when a throw escapes a required module — entry → failing module) is appended. Plain
 *  errors fall back to `.message`. `requireChain` stays duck-typed: the loader annotates
 *  it best-effort onto whatever error escapes, frozen targets included. */
export function formatRunError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const err = error as Error & { schemeStack?: unknown[]; requireChain?: unknown };
  // Only prefer toString when there is a non-empty scheme stack — empty arrays still
  // make `"schemeStack" in error` true but add nothing over `.message`.
  const hasStack = Array.isArray(err.schemeStack) && err.schemeStack.length > 0;
  const base = hasStack ? error.toString() : error.message;
  const chain = err.requireChain;
  return Array.isArray(chain) && chain.length > 0 ? `${base}\n\nrequire chain: ${chain.join(" → ")}` : base;
}

// -------------------------------------------------------------------------
// :: BudgetExceededError — run containment (wall-clock), never a fault.
// Call sites build their own full message.
// -------------------------------------------------------------------------
export class BudgetExceededError extends ArrivalError {
  public readonly name = "BudgetExceededError";
  readonly "arrival/error-category": ErrorClass = "other";
}

// -------------------------------------------------------------------------
// :: PurityError — deliberately-omitted feature (PURE DATAFLOW: mutation and
// dynamics omitted by design — they'd falsify lineage). symbol.notImplemented doors throw this.
// -------------------------------------------------------------------------
export class PurityError extends ArrivalError {
  public readonly owner: string;
  public readonly name = "PurityError";
  readonly "arrival/error-category": ErrorClass = "prohibited-dynamics";

  constructor(
    message: string,
    /** Omitted feature, e.g. "set-cdr!" — routing/telemetry key. */
    public readonly feature: string,
    /** Door's owning capability when stamped; else "owned-by/purity-invariant". */
    owner?: string,
  ) {
    super(message);
    this.owner = owner ?? "owned-by/purity-invariant";
  }
}

// -------------------------------------------------------------------------
// :: PortabilityError + strictGate — loose/strict (R7RS-portability) divergence.
// LOOSE (default) tolerates modern conveniences; STRICT rejects with educational error.
// -------------------------------------------------------------------------
export class PortabilityError extends ArrivalError {
  public readonly name = "PortabilityError";
  readonly "arrival/error-category": ErrorClass = "other";

  constructor(
    public readonly op: string,
    public readonly rule: string,
    public readonly alternative?: string,
  ) {
    super(`${op}: not portable in strict mode — ${rule}${alternative ? ` (${alternative})` : ""}`);
  }
}

/** `runCtx` is read structurally so this leaf does not import a concrete run type. */
export function strictGate(
  runCtx: { readonly strict: boolean } | undefined,
  divergence: { op: string; rule: string; alternative?: string },
): void {
  if (runCtx?.strict) {
    throw new PortabilityError(divergence.op, divergence.rule, divergence.alternative);
  }
}

// -------------------------------------------------------------------------
// :: ProvenanceRoleShapeError — declared `provenance` role vs contract SHAPE.
//
// A symbol declares a `provenance` role (the declaration vocabulary — pipe/fan/source/
// sink/transparent/loop/opaque) that its OWN contract's normalized in/out vectors
// structurally disprove. Thrown at ASSEMBLY (bake time —
// `common/symbols/{native,rosetta,sequence}.ts`, via `assertProvenanceRoleShape` in
// `_bake.ts`), never at call time. LIMIT: shape catches CONTRADICTIONS, not LIES — a
// JS body that fans while declared `pipe` is consistent-but-wrong and invisible to shape.
// -------------------------------------------------------------------------
export class ProvenanceRoleShapeError extends ArrivalError {
  public readonly name = "ProvenanceRoleShapeError";
  readonly "arrival/error-category": ErrorClass = "contract-shape";

  constructor(
    /** The declaring symbol's name — routing/telemetry key. */
    public readonly op: string,
    public readonly role: string,
    public readonly rule: string,
  ) {
    super(`${op}: declared provenance role "${role}" contradicts its own contract — ${rule}`);
  }
}

// -------------------------------------------------------------------------
// :: CacheClassShapeError — declared `cacheClass` vs contract SHAPE.
//
// A symbol declares the `view` cache class (Solidity vocabulary — cacheable ACROSS
// runs, a boundary snapshot worth persisting) but its own contract is structurally
// non-serializable: a `z.lambda` arm (a callable can't be a snapshot) or a raw-scheme-value
// slot (`z.schemeValue`/`z.dynamic` — neither carries a
// serialization story). Thrown at
// ASSEMBLY (bake time — `common/symbols/{native,rosetta,sequence}.ts`, via
// `assertCacheClassShape` in `_bake.ts`, beside `assertProvenanceRoleShape`), never
// at call time. `pure` gets NO shape gate — its recovery is re-call, nothing of it
// is persisted; the author's way out of this door is declaring `pure` (or nothing).
// -------------------------------------------------------------------------
export class CacheClassShapeError extends ArrivalError {
  public readonly name = "CacheClassShapeError";
  readonly "arrival/error-category": ErrorClass = "contract-shape";

  constructor(
    /** The declaring symbol's name — routing/telemetry key. */
    public readonly op: string,
    /** The declared cache class the contract's shape disproves (always `"view"` today). */
    public readonly cacheClass: string,
    public readonly rule: string,
  ) {
    super(`${op}: declared cache class "${cacheClass}" contradicts its own contract — ${rule}`);
  }
}

// -------------------------------------------------------------------------
// :: ContractSlotKindError — CONTOUR/CROSSING slot-kind wall, runtime twin.
//
// The type-level brand bans (`_bake.ts` §1.7: ContourOnly bans `z.schemeValue`
// from rosetta contracts; CrossingOnly bans `z.dynamic`/`z.instance` from
// native/sequence/define contracts) are invisible to an untyped or `as never`
// caller. `assertSlotKinds` (`_bake.ts`, called by every factory) re-checks the
// same wall at ASSEMBLY (bake time), copying the `assertNoResourcePathProducers`
// pattern. Shallow scope — same top-level slot view as the sibling shape gates.
// -------------------------------------------------------------------------
export class ContractSlotKindError extends ArrivalError {
  public readonly name = "ContractSlotKindError";
  readonly "arrival/error-category": ErrorClass = "contract-shape";

  constructor(
    /** The declaring symbol's name — routing/telemetry key. */
    public readonly op: string,
    /** The factory kind whose wall the slot violates. */
    public readonly kind: "rosetta" | "native" | "sequence" | "define",
    public readonly side: "input" | "output",
    public readonly slotName: string,
  ) {
    super(
      kind === "rosetta"
        ? `${op}: z.${slotName} is not legal in a rosetta contract's ${side} — rosetta crosses the ` +
            `membrane, so this slot needs a real codec, z.procedure (callables), or z.dynamic ` +
            `(fully-generic pass-through slots only — an awkward shape wants a real codec)`
        : `${op}: z.${slotName} is not legal in a ${kind} contract's ${side} — this contour never ` +
            `crosses the membrane, so z.schemeValue (the honest top type) or a real codec is always ` +
            `the honest choice`,
    );
  }
}

// -------------------------------------------------------------------------
// :: ContractSealError — the contract is frozen at symbol instantiation.
//
// A contract is the declaration of record (harvest/catalog/static readers and
// the dispatch spine treat its fields as truth); it freezes the moment it gets
// inside the symbol instance (ruling 2026-08-13). The ONLY post-factory
// declaration channels are `withContractFields` (type/emit/narrows/refPolicy)
// and `withCallbackRoles` (role vocabulary) — both RE-MINT a new instance with
// a new frozen contract, and both enforce their whitelist at runtime. This
// door fires when a caller pushes a gated field (queries/cacheClass/
// provenance/…) or an out-of-vocabulary role through those channels.
// -------------------------------------------------------------------------
export class ContractSealError extends ArrivalError {
  public readonly name = "ContractSealError";
  readonly "arrival/error-category": ErrorClass = "contract-shape";

  constructor(
    /** The symbol's name — routing/telemetry key. */
    public readonly op: string,
    public readonly channel: "withContractFields" | "withCallbackRoles",
    public readonly rule: string,
  ) {
    super(`${op}: ${channel} refused — ${rule}`);
  }
}

// -------------------------------------------------------------------------
// :: InteropAccessError — a Scheme access that would cross an interop boundary.
// -------------------------------------------------------------------------
export class InteropAccessError extends Error {
  constructor(
    message: string,
    public readonly key: string | symbol,
    public readonly boundaryType: string,
  ) {
    super(message);
    this.name = "InteropAccessError";
  }
}

/**
 * A borrowed source could not be frozen — `Object.freeze` itself threw instead of
 * applying (or silently no-opping, its ordinary behavior on every plain object/array
 * and well-behaved Proxy). This happens only for a genuinely foreign Proxy whose traps
 * violate the invariants `Object.freeze`/`Object.isFrozen` require of it (e.g. an
 * `ownKeys` trap that disagrees with its own `getOwnPropertyDescriptor` answers, or a
 * `preventExtensions` trap that refuses). Named + exported (P5, docs/PRINCIPLES.md):
 * the freeze-on-first-read contract (docs/membrane.md §BOXING) fails loudly at the
 * crossing that tripped it, rather than leaving the source silently mutable — see
 * AJSObject.ts / AJSArray.ts's `freezeSource`.
 */
export class ForeignProxyFreezeError extends Error {
  constructor(cause: unknown) {
    super(
      "a foreign Proxy with a non-standard ownKeys trap reached the membrane and could not be " +
        "frozen (docs/membrane.md §BOXING's freeze-on-first-read contract) — Object.freeze itself " +
        `threw: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = "ForeignProxyFreezeError";
  }
}

// -------------------------------------------------------------------------
// :: R7RS error types (Section 6.11).
// -------------------------------------------------------------------------

/** R7RS error object — errors created by the `error` procedure. */
export class R7RSError extends Error {
  /** Interop boundary: covered by the `instanceof R7RSError` arm in
   *  interop-access.ts's `isInteropBoundary` (see the note on Unterminated above) —
   *  R7RSReadError/R7RSFileError inherit the boundary through it too. */

  readonly irritants: unknown[];
  readonly name: string = "R7RSError";
  /** Not an `ArrivalError` (R7RS errors are user-raised, not internal doors), but
   *  still names its own category directly — the ONE non-`ArrivalError` class that
   *  does: `failAndWrap` (eval/evaluator.ts) normally wraps an `(error …)` raise
   *  under a generic wrapper whose category forwards from this field, but a bare,
   *  unwrapped `R7RSError` reaching a classifier (the rare defensive case) still
   *  self-reports correctly without that forwarding. */
  readonly "arrival/error-category": ErrorClass = "user-error";

  constructor(message: string, ...irritants: unknown[]) {
    super(message);
    this.irritants = irritants;
  }
}

export class R7RSReadError extends R7RSError {
  readonly name = "R7RSReadError";
}

export class R7RSFileError extends R7RSError {
  readonly name = "R7RSFileError";
}

// -------------------------------------------------------------------------
// :: Env-assembly errors (teaching, errors-as-doors) — the C3 kernel.
// -------------------------------------------------------------------------
export class AssembleCycleError extends Error {
  constructor(public readonly cycle: readonly string[]) {
    super(
      `env-pack dependency cycle: ${cycle.join(" → ")}. Packs form a DAG; break the edge ` +
        `(or model a genuine mutual as a declare-then-wire two-phase pack).`,
    );
    this.name = "AssembleCycleError";
  }
}
export class AssembleConfigConflictError extends Error {
  constructor(public readonly packName: string) {
    super(
      `env-pack "${packName}" appears twice in one assembly with different config. One name = one ` +
        `config per assembly — you armed the same capability two ways. Dedup the pack or unify the config.`,
    );
    this.name = "AssembleConfigConflictError";
  }
}
export class AssembleLinearizationError extends Error {
  constructor(public readonly packName: string) {
    super(
      `env-pack "${packName}" has an inconsistent dependency precedence (C3 merge failed): a dep ` +
        `ordering contradicts another. Reorder the conflicting deps so a single linearization exists.`,
    );
    this.name = "AssembleLinearizationError";
  }
}
export class AssemblePackError extends Error {
  constructor(
    public readonly packName: string,
    public readonly cause: unknown,
  ) {
    super(`env-pack "${packName}" failed to apply: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "AssemblePackError";
  }
}
export class AssemblePackTimeoutError extends Error {
  constructor(
    public readonly packName: string,
    public readonly ms: number,
  ) {
    super(`env-pack "${packName}" did not finish applying within ${ms}ms (a wedged await import?).`);
    this.name = "AssemblePackTimeoutError";
  }
}

// -------------------------------------------------------------------------
// :: Vocabulary-artifact errors (env/vocabulary.ts buildVocabulary) — capability-DAG
// counterpart to the env-pack errors above (same C3 core, different domain).
// -------------------------------------------------------------------------
export class VocabularyCapabilityConflictError extends Error {
  constructor(public readonly capabilityName: string) {
    super(
      `two DIFFERENT EnvCapability objects both declare the name "${capabilityName}" — one name must ` +
        `identify one capability object across a DAG. Rename one of them, or confirm both call sites ` +
        `import the SAME module-singleton instance.`,
    );
    this.name = "VocabularyCapabilityConflictError";
  }
}

// -------------------------------------------------------------------------
// :: ResourceNotLiveError — a resource touched before the env accessor spawned it.
// -------------------------------------------------------------------------
export class ResourceNotLiveError extends Error {
  constructor(public readonly kind: string) {
    super(
      `resource "${kind}" was accessed via .live before it was spawned. The env accessor pre-spawns a ` +
        `capability's resources on first symbol touch — if you see this, the method ran outside that gate ` +
        `(use .get() for an explicit lazy acquire instead).`,
    );
    this.name = "ResourceNotLiveError";
  }
}

// -------------------------------------------------------------------------
// :: PreludeMembershipError — a port-reaching define asked for prelude membership.
//
// Prelude membership is PURE-ONLY — a top-level define whose body transitively reaches
// a port (directly, or through a reference to another port-reaching define, checked to
// a fixpoint) is wireframe material, never prelude. Port-reaching defines are excluded
// because name indirection would smuggle sources into "pure" wire bodies — γ would
// re-invoke them on replay, breaking the frozen-payload guarantee. Thrown by
// `provenance/prelude.ts`'s `assertPreludeEligible` — errors-as-doors: names WHY, never
// a bare rejection.
// -------------------------------------------------------------------------
export class PreludeMembershipError extends ArrivalError {
  public readonly name = "PreludeMembershipError";
  readonly "arrival/error-category": ErrorClass = "other";

  constructor(
    /** The define's name — routing/telemetry key. */
    public readonly define: string,
    public readonly reason: string,
  ) {
    super(`"${define}" is not prelude-eligible — ${reason}`);
  }
}

// -------------------------------------------------------------------------
// :: WireLocalityError — a wire body's free variable is not accounted for.
//
// A wire is a closed arrival lambda: FV(body) ⊆ params ∪ prelude-names, checked at
// emission (the wire-locality law). Locality is thereby syntactic; declared-vs-actual
// consumption drift is unrepresentable. Thrown by `provenance/uneval.ts`'s
// `unevalWire` — the EMISSION-time check, not a post-hoc audit. errors-as-doors: names
// the variable, where, and the route (a port-reaching define must be a wireframe node,
// never a captured value).
// -------------------------------------------------------------------------
export class WireLocalityError extends ArrivalError {
  public readonly name = "WireLocalityError";
  readonly "arrival/error-category": ErrorClass = "other";

  constructor(
    public readonly variable: string,
    /** `scopeId` of the wire body's surface form — where the wire was cut. */
    public readonly span: string,
    public readonly reason: string,
  ) {
    super(`wire-locality: free variable "${variable}" in the wire at ${span} — ${reason}`);
  }
}

// -------------------------------------------------------------------------
// :: DefineLocalityError — a `symbol.define` body's free variable escapes its
// capability's own bake-time allowlist (WireLocalityError's SIBLING, one level
// down — the bake FV law: `FV(B) ⊆ SPECIAL_FORMS ∪ KEYWORD_SYNTAX ∪ ownNames(K) ∪
// exports(transitiveDeps(K)) ∪ resolver-synth family`). Thrown at BAKE (first
// `lower()`/`apply()` that evaluates the define), never at call time — an
// undeclared cross-capability reference is a declaration-authoring bug the design
// converts into a bake-time door instead of assembly-order luck.
// -------------------------------------------------------------------------
export class DefineLocalityError extends ArrivalError {
  public readonly name = "DefineLocalityError";
  readonly "arrival/error-category": ErrorClass = "other";

  constructor(
    public readonly variable: string,
    /** The declaring define's OWN name (bare, as authored). */
    public readonly define: string,
    /** The owning capability's name. */
    public readonly owner: string,
  ) {
    super(
      `symbol.define "${define}" @ ${owner}: free variable "${variable}" is not in scope — ` +
        `declare a \`deps\` edge on the capability exporting "${variable}", or bind it in "${owner}" itself`,
    );
  }
}

// -------------------------------------------------------------------------
// :: DefineForwardReferenceError — an EAGER (non-lambda) `symbol.define` RHS
// referencing a LATER sibling define in the same capability. Ordering is
// decidable statically, so this is a named bake-time door rather than an
// eval-time crash.
// -------------------------------------------------------------------------
export class DefineForwardReferenceError extends ArrivalError {
  public readonly name = "DefineForwardReferenceError";
  readonly "arrival/error-category": ErrorClass = "other";

  constructor(
    /** The declaring (eager) define's own name. */
    public readonly define: string,
    /** The later-declared sibling name it references before that sibling evaluates. */
    public readonly reference: string,
    /** The owning capability's name. */
    public readonly owner: string,
  ) {
    super(
      `symbol.define "${define}" @ ${owner}: its RHS is not a lambda (evaluates EAGERLY, in ` +
        `declaration order) but references "${reference}", declared LATER in the same capability — ` +
        `reorder "${reference}" before "${define}", or wrap "${define}"'s RHS in a lambda so the ` +
        `reference late-binds`,
    );
  }
}

// Named doors below: facts as typed fields; message built once from those facts.
// Call sites are `throw new X(facts…)` or `X.invariant(cond, facts…)`.
// Message text that tests/classifiers match is stable.

// -------------------------------------------------------------------------
// :: Membrane doors — JS↔Scheme refuse. Each names a different cure (fix writer /
// add branch / await / use directly / re-enter / detach) so each is its own class.
// -------------------------------------------------------------------------

/** AmbientRuntime storage (or a fallback resolver's answer) held/returned a raw JS
 *  scalar instead of a boxed scheme value — a writer or resolver bypassed the
 *  membrane. Fires on the READ so the message can name the binding; the fix is
 *  always at the WRITER/resolver, never the read site (`AmbientRuntime.ts`'s
 *  `assertNotRawInStorage`/`assertResolvedBinding`). */
export class RawCrossingError extends ArrivalError {
  public readonly name = "RawCrossingError";
  readonly "arrival/error-category": ErrorClass = "other";

  constructor(
    /** Which door caught it — storage read vs a fallback resolver's answer. */
    public readonly site: "storage" | "resolver",
    public readonly variable: string,
    /** The raw JS `typeof` the value carried (never a boxed scheme value). */
    public readonly jsType: string,
    /** Env name (storage site) or resolver id (resolver site). */
    public readonly where: string,
  ) {
    super(
      site === "storage"
        ? `\`${variable}\` resolved to a raw JS ${jsType} in ${where} — a writer bypassed the ` +
            `storage membrane. AmbientRuntime storage is inside the membrane: values enter the interpreter ` +
            `only as capabilities (EnvCapability symbols/resolvers) or overrides (exec's \`override\`), ` +
            `each boxing at its own boundary (jsToScheme). Fix the writer, not this read.`
        : `resolver "${where}" answered \`${variable}\` with a raw JS ${jsType} — a resolver ` +
            `boxes at its own boundary (jsToScheme under the read's ctx; a \`pure\` resolver mints ` +
            `run-neutrally, since its hits are memoized across runs). Raw JS never enters resolution.`,
    );
  }
}

/** `toJS` / element recursion reached a boxed shape with no `arrival/toJS`
 *  protocol term — a silent return would leak the value's internal
 *  representation to a JS caller expecting a plain value (P5, docs/PRINCIPLES.md).
 *  Terminal-passthrough door: every `AValue` subclass implements the protocol. */
export class UnrecognizedCrossingError extends ArrivalError {
  public readonly name = "UnrecognizedCrossingError";
  readonly "arrival/error-category": ErrorClass = "other";

  constructor(
    /** `value.constructor.name`, or the anonymous-object fallback. */
    public readonly typeName: string,
  ) {
    super(
      `toJS: no arrival/toJS protocol term for ${typeName} — every boxed shape implements the ` +
        `egress protocol (P7). Silently returning it would leak the value's internal ` +
        `representation to a JS caller expecting a plain value; the membrane fails loudly ` +
        `at the crossing instead (P5, docs/PRINCIPLES.md).`,
    );
  }
}

/** A rosetta impl's RETURN carried a boxed scheme value (AValue) — an ILLEGAL WORLD
 *  FLIP (ruling 2026-08-13). The impl lives on the JS side of the membrane; its return
 *  crosses back through encode/jsToScheme, which own boxing, provenance stamping, and
 *  attestation. An already-boxed value there would ride jsToScheme's owned-artifact
 *  pass-through and skip the mint — the membrane crashes at the crossing instead.
 *  Checked bare AND nested inside plain arrays/objects (the shapes jsToScheme recurses);
 *  fires BEFORE z.encode so coded slots teach the same cure as escape slots. */
export class WorldFlipError extends ArrivalError {
  public readonly name = "WorldFlipError";
  readonly "arrival/error-category": ErrorClass = "other";

  constructor(
    public readonly op: string,
    /** The offending value's class name (e.g. "AString"). */
    public readonly typeName: string,
  ) {
    super(
      `${op}: the impl returned a boxed scheme value (${typeName}) — an illegal world flip. ` +
        `A rosetta impl speaks plain JS; its return crosses back through the membrane, which owns ` +
        `boxing, provenance, and attestation. Return the raw JS value and let the membrane box it — ` +
        `or declare the verb symbol.native if it genuinely works over scheme values.`,
    );
  }
}

/** A bare `Promise` reached `jsToScheme` directly — every sanctioned path settles
 *  first (rosetta wrappers await their fn results; a Promise INSIDE a structure
 *  settles lazily on first read). A raw Promise in scheme space would be an
 *  opaque, unawaitable leak (P5, docs/PRINCIPLES.md). */
export class AsyncCrossingError extends ArrivalError {
  public readonly name = "AsyncCrossingError";
  readonly "arrival/error-category": ErrorClass = "other";

  constructor() {
    super(
      "jsToScheme: a bare Promise cannot cross the membrane — await it before crossing " +
        "(rosetta wrappers already await their fn results), or hand the STRUCTURE holding it " +
        "to the sandbox and let the entry read settle it lazily (AJSObject/ADict entries and " +
        "AJSArray elements settle on first access, sync after settlement). A raw Promise in " +
        "scheme space would be an opaque leak (P5, docs/PRINCIPLES.md).",
    );
  }
}

/** jsToScheme's INCOMPATIBILITY DOOR (rosetta.ts INCOMPATIBILITY_DOOR_CLAIMS):
 *  every inbound value crosses via OWNED-ARTIFACT mark, FOREIGN LENS, or here —
 *  no lens exists. Never a silent degrade. Each kind names its own cure. */
export class NoLensError extends ArrivalError {
  public readonly name = "NoLensError";
  readonly "arrival/error-category": ErrorClass = "other";

  constructor(
    public readonly kind: "unique-symbol" | "unbranded-class" | "bigint",
    /** unbranded-class only: `value.constructor?.name` (or the anonymous-object fallback). */
    public readonly className?: string,
  ) {
    super(
      kind === "unique-symbol"
        ? "jsToScheme: no lens for a unique JS symbol — it has no portable Scheme representation " +
            "and no identity a Scheme program could reconstruct across a crossing. Register it " +
            "(`Symbol.for(name)`) to cross as a `:keyword`, or pass a string/keyword directly instead."
        : kind === "bigint"
          ? "jsToScheme: no lens for a host bigint — arrival's exact numbers are safe-integer ratios, " +
            "not unbounded integers. Convert with Number/bigintToNumber in the safe range (or pass an " +
            "inexact/string), then re-cross; raw bigint never enters scheme."
          : `jsToScheme: no lens for a ${className} instance — arrival's foreign-lens table recognizes ` +
            "plain data (arrays / plain objects / primitives) and explicitly-branded handles only. Mark " +
            "the class `@arrival.private` (interop-access.ts's markInteropPrivate) to cross it as an " +
            "opaque handle, or hand plain data (a plain object/array built from its fields) instead.",
    );
  }
}

/** `toJS` received a value already on the JS side of the membrane. STRICT one-way
 *  door: the caller is confused about which side it stands on. */
export class RedundantCrossingError extends ArrivalError {
  public readonly name = "RedundantCrossingError";
  readonly "arrival/error-category": ErrorClass = "other";

  constructor(public readonly direction: "toJS" = "toJS") {
    super(
      "toJS: received a non-scheme value — toJS is the Scheme→JS membrane exit; a raw JS " +
        "value is already JS. Pass it through directly.",
    );
  }
}

/** Rule 1's door (region-scope.ts): a reverse-lambda callback handed to host JS was
 *  invoked AFTER its exporting symbol call already returned. Callbacks are
 *  region-bound to the calling symbol; a persistent handler needs an explicit
 *  capability granting a DETACHED scope. */
export class RegionEscapeError extends ArrivalError {
  public readonly name = "RegionEscapeError";
  readonly "arrival/error-category": ErrorClass = "other";

  constructor() {
    super(
      "reverse lambda escaped its invocation — callbacks are region-bound to the calling symbol; " +
        "a wrapper handed to host JS may only be invoked WHILE the symbol call that exported it is " +
        "still running. Persistent handlers (a subscription kept past the call's return) need an " +
        "explicit capability granting a DETACHED scope — this is not that, by default.",
    );
  }
}

/** Rule 2's door (region-scope.ts): a symbol invocation returned while one or more
 *  reverse-lambda re-entries it started were still in flight. Every re-entry
 *  started during a call must settle (resolve or reject) before that call returns. */
export class RegionIncompleteError extends ArrivalError {
  public readonly name = "RegionIncompleteError";
  readonly "arrival/error-category": ErrorClass = "other";

  constructor(
    /** How many reverse-lambda calls were still in flight at close. */
    public readonly pending: number,
  ) {
    super(
      `symbol returned with ${pending} reverse-lambda call${pending === 1 ? "" : "s"} incomplete — ` +
        "every reverse-lambda call started during a symbol invocation must settle (resolve or reject) " +
        "before that symbol returns. Await each re-entry, or use a persistent-handler capability for " +
        "fire-and-forget work instead of leaving a call in flight.",
    );
  }
}

// -------------------------------------------------------------------------
// :: Name-resolution doors — three distinct failures of "the symbol you wrote."
// -------------------------------------------------------------------------

/** The ONE builder for "Unbound variable", shared by every arrival-side throw
 *  site (`AmbientRuntime.get`, `eval/Resolver.ts#resolveSynth`,
 *  `eval/evaluator.ts#resolvedBindingOrThrow`) — promoted from the bare
 *  `unbound-variable.ts` factory (`unboundVariableError`), which still builds the
 *  `suggestions` list and constructs this class. `publicMessage`/`enriched` ride
 *  alongside `.message` for the MCP/agent-facing surface and a typed "did this
 *  enrich?" signal.
 *
 *  Extends `ArrivalError`: `failAndWrap`'s `if (error instanceof ArrivalError)
 *  throw error` rethrows a live throw UNWRAPPED (it's already arrival-level and
 *  self-teaching) instead of nesting it under a fresh wrapper's `.cause` — so
 *  `.enriched` rides directly on the caught error at a live throw site, never
 *  under `.cause` (vocabulary-suggestions.law.test.ts's LIVE `.enriched` law pins
 *  this). */
export class UnboundVariableError extends ArrivalError {
  public readonly name = "UnboundVariableError";
  readonly "arrival/error-category": ErrorClass = "unbound-variable";
  /** Agent/MCP-facing wording (same hint, different frame — see unbound-variable.ts). */
  public readonly publicMessage: string;
  /** True iff a did-you-mean suffix was appended (a near name existed in vocabulary). */
  public readonly enriched: boolean;

  constructor(
    public readonly variable: string,
    /** Near vocabulary matches, best first (empty ⇒ the plain wall, no hint). */
    public readonly suggestions: readonly string[] = [],
    /** A ROUTING hint for a known dead-end idiom (Racket `#:kwargs`, `require`, …) — full
     *  prose, rendered in place of (never alongside) a "did you mean" suggestion list. This
     *  is a DISJOINT gate from `suggestions`: an idiom match is a name-exact hit against a
     *  small hardcoded table (unbound-variable.ts's idiom routes), not a fuzzy vocabulary
     *  near-miss — the two never fire on the same name. See benchmark-defect-register.md B8. */
    routingHint?: string,
  ) {
    const hint =
      routingHint ??
      (suggestions.length === 0 ? undefined : `did you mean ${suggestions.map((s) => `\`${s}\``).join(" or ")}?`);
    super(hint ? `Unbound variable \`${variable}' — ${hint}` : `Unbound variable \`${variable}'`);
    this.publicMessage = hint
      ? `symbol ${variable} does not exist - look at list of available functions at tool description (${hint})`
      : `symbol ${variable} does not exist - look at list of available functions at tool description`;
    this.enriched = hint !== undefined;
  }
}

/** Operator/call-head position held a non-callable value — designed off the
 *  MCP-Atlas error-corpus autopsy (evaluator.ts's `notCallableError`/
 *  `nonCallableHeadError`). The `quoted-string` variant is the corpus's #1 class:
 *  a model writes a tool/symbol name as a STRING in call-head position (data, not
 *  a reference) — echoing the string's own content back reads like the tool
 *  itself failed, so this variant names the cure (drop the quotes) instead. */
export class NotCallableError extends ArrivalError {
  public readonly name = "NotCallableError";
  readonly "arrival/error-category": ErrorClass = "type-mismatch";

  constructor(
    public readonly kind: "type" | "quoted-string",
    /** The scheme-visible type name (`type()`, e.g. "dict"/"vector"/"number") — always
     *  set, used by the `"type"` variant. */
    public readonly typeName: string,
    /** The string's own content — set only for the `"quoted-string"` variant. */
    public readonly content?: string,
  ) {
    super(
      kind === "quoted-string"
        ? `"${content}" is a string, not a function — a quoted name is data, it is never called. ` +
            `Drop the quotes and call the symbol directly: (${content} …).`
        : `Not callable: a ${typeName} sits in operator/call-head position, and a ${typeName} is not a function` +
            ` — common cause: extra parentheses — ((f x)) calls f's RESULT, not f; write (f x).`,
    );
  }
}

/** A resolved binding is a structural non-value the evaluator cannot carry (a
 *  scope, or the internal-only RegExp face number-parsing/syntax-rules patterns
 *  use) — `eval/evaluator.ts#resolvedBindingOrThrow`. */
export class ResolvedNonValueError extends ArrivalError {
  public readonly name = "ResolvedNonValueError";
  readonly "arrival/error-category": ErrorClass = "other";

  constructor(
    public readonly variable: string,
    public readonly kind: "environment" | "regexp",
  ) {
    super(
      kind === "environment"
        ? `\`${variable}' is an environment — neither a value nor applicable`
        : `\`${variable}' resolved to a regular expression — neither a value nor applicable`,
    );
  }
}

// -------------------------------------------------------------------------
// :: SpecialFormShapeError — a special form's own shape guard failed.
//
// ~50 sites across evaluator.ts (if/quote/quasiquote/unquote(-splicing)/define/
// lambda/define-macro/let/let*/letrec/cond/case/when/unless/do/while/try/`=>`
// clauses/improper-list-call) are boundary-reachable — malformed-but-plausible
// Scheme a model can trivially write. A plain tiny-invariant guard there prefixes
// "Invariant failed: " (tiny-invariant's own wording), which reads like an engine
// bug rather than a program mistake; this door reads as the program mistake it is.
// ONE class, not 50: the FORM is a fact carried on the instance, not a taxonomy of
// identities — per-form classes would be taxonomy noise. Same SHAPE as the
// bracket-bindings exemplar above (`EvalError` + `E-LET-BRACKET-*` codes: form/code
// carried as facts, message built once); `code` stays optional here (most sites
// carry no corpus code, and backfilling one per form is deferred).
// -------------------------------------------------------------------------
export class SpecialFormShapeError extends ArrivalError {
  public readonly name = "SpecialFormShapeError";
  readonly "arrival/error-category": ErrorClass = "other";

  constructor(
    /** The special form whose shape guard failed (`if`, `let`, `=>`, `apply`, …) —
     *  routing/telemetry key. */
    public readonly form: string,
    /** What's wrong — terse at most sites; per-form what/why/fix enrichment is deferred. */
    public readonly problem: string,
    /** Stable spec-taxonomy id, when the corpus already matches one. */
    public readonly code?: string,
    public readonly location?: SourceLocation,
  ) {
    super(location ? `${form}: ${problem} at ${formatLocation(location)}` : `${form}: ${problem}`);
  }
}

// -------------------------------------------------------------------------
// :: Contract/shape doors — a call/schema shape a contract's own boundary rejects.
// -------------------------------------------------------------------------

/** `exec`'s `output` contract, at the exit boundary: the program produced no
 *  forms at all, or its last value doesn't satisfy the declared schema. The
 *  outbound twin of define/overridable's inbound validation. */
export class OutputContractError extends ArrivalError {
  public readonly name = "OutputContractError";
  readonly "arrival/error-category": ErrorClass = "type-mismatch";

  constructor(
    /** `describeExitSchema(contract)` — what the contract declared. */
    public readonly expected: string,
    /** `"no-forms"`, or `describeExitValue(...)` of what the program actually produced. */
    public readonly got: "no-forms" | string,
    /** The zod issue list, joined — set only when `got !== "no-forms"`. */
    public readonly issues?: string,
  ) {
    super(
      got === "no-forms"
        ? `exec output contract: expected ${expected}, got NO forms at all — an empty program has no ` +
            "last result to validate; drop the `output` option or run a real form"
        : `exec output contract: expected ${expected}, got ${got} — ${issues} — the program's last form ` +
            "must satisfy the declared `output` schema at the exit boundary (the outbound twin of " +
            "define/overridable's validation)",
    );
  }
}

/** A `KeywordPairingError`'s sibling family: kwargs call-shape doors at
 *  bake/normalize time (`common/symbols/_bake.ts`) — a dangling `:key` with no
 *  value, or an `inputRest` variadic tail declared over a non-tuple `input`
 *  (no well-defined prefix length to split at). */
export class KeywordPairingError extends ArrivalError {
  public readonly name = "KeywordPairingError";
  readonly "arrival/error-category": ErrorClass = "other";

  constructor(
    public readonly kind: "dangling-keyword" | "input-rest-needs-tuple",
    /** Set only for `"dangling-keyword"` — the odd arg count observed. */
    public readonly argCount?: number,
  ) {
    super(
      kind === "dangling-keyword"
        ? "kwargs call has a dangling keyword with no value — expected interleaved `:key value` " +
            `pairs, got ${argCount} arg(s)`
        : "inputRest requires `input` to be a fixed positional tuple (e.g. [z.string]) — a single " +
            "schema `input` has no well-defined prefix length to split the rest at",
    );
  }
}

/** A `schema/object` tagged-list field isn't the `(name type)`/`(name type
 *  description)` shape the JSON-Schema lowering (`common/schema-tag.ts`) requires. */
export class SchemaFieldShapeError extends ArrivalError {
  public readonly name = "SchemaFieldShapeError";
  readonly "arrival/error-category": ErrorClass = "other";

  constructor() {
    super("schema/object: field must be (name type) or (name type description)");
  }
}

/** A scheme-zod codec's decode/encode side hit a value it cannot faithfully
 *  represent on the other face — an exact rational with no integer/bigint form,
 *  an inexact outside JS's safe-integer range or with a fractional part, a
 *  circular or improper list. Model-reachable (a program's own value reaching a
 *  native's arg decode), so these are doors, not invariants — every decode-side
 *  throw in `common/scheme-zod.ts` self-documents that; this class gives them
 *  one shared identity instead of ad hoc `Error`/`TypeError`. */
export class CodecFidelityError extends ArrivalError {
  public readonly name = "CodecFidelityError";
  readonly "arrival/error-category": ErrorClass = "other";

  constructor(
    /** Which named codec refused (`exact`/`number`/`integer`/`bigint`/`list`/…). */
    public readonly codec: string,
    /** What about the value the codec cannot represent, plus the alternative when one exists. */
    public readonly problem: string,
  ) {
    super(`${codec} codec: ${problem}`);
  }
}

// -------------------------------------------------------------------------
// :: Capability-assembly doors — joins the existing `Assemble*` family
// (env-pack DAG assembly) with symbol-declaration-time doors from `common/capability.ts`
// and `eval/{generator-exec,exec-phases}.ts`.
// -------------------------------------------------------------------------

/** A `symbol.alias` declaration is unwireable: its target isn't declared in the
 *  SAME capability's own `symbols` record (an alias only dissolves to a sibling),
 *  or its target is itself another alias (chains aren't supported). */
export class AliasTargetError extends ArrivalError {
  public readonly name = "AliasTargetError";
  readonly "arrival/error-category": ErrorClass = "other";

  constructor(
    public readonly capabilityName: string,
    /** The name the alias is bound as. */
    public readonly aliasName: string,
    /** The alias's declared target name. */
    public readonly targetName: string,
    public readonly kind: "missing-target" | "chained-alias",
  ) {
    super(
      kind === "missing-target"
        ? `capability "${capabilityName}": symbol.alias\`${targetName}\` (bound as "${aliasName}") has no ` +
            `target — "${targetName}" is not declared in this capability's own \`symbols\` record. An ` +
            `alias can only dissolve to a SIBLING symbol declared in the SAME capability; declare ` +
            `"${targetName}" first, or fix the alias's target name.`
        : `capability "${capabilityName}": symbol.alias\`${targetName}\` (bound as "${aliasName}") targets ` +
            `another alias ("${targetName}") — alias chains are not supported; alias directly to the ` +
            `real symbol.`,
    );
  }
}

/** A capability's `symbols` record binds a minted `symbol.*` value (native/rosetta/
 *  sequence/tagless/tagless-guard/door/keyword) under a record KEY that doesn't match
 *  the value's OWN name (the tagged-template head every factory parses at mint time,
 *  `common/symbols/_bake.ts`'s `parseNameDoc`). The key is the record's own identity —
 *  `common/capability.ts`'s bind loop reads it to compute `verb = prefix + key` — so a
 *  mismatch means the bound verb and the value's self-reported identity (its `.contract
 *  .name`/`.door.name`/`.name`) permanently disagree, silently, for every diagnostic that
 *  reads the value's own name back (a door's `PurityError`, a lineage trace, `env.get(op)
 *  .name` introspection). Declaration-time authoring bug, not a runtime condition — the
 *  fix is renaming the record key (or the template head) to match, never a rebind. */
export class SymbolKeyMismatchError extends ArrivalError {
  public readonly name = "SymbolKeyMismatchError";
  readonly "arrival/error-category": ErrorClass = "other";

  constructor(
    public readonly capabilityName: string,
    /** The `symbols` record key this value was declared under. */
    public readonly recordKey: string,
    /** The value's own mint-time name (its tagged-template head). */
    public readonly mintedName: string,
  ) {
    super(
      `capability "${capabilityName}": symbol declared under record key "${recordKey}" carries a different ` +
        `own name ("${mintedName}") — the \`symbols\` record key must match the value's tagged-template head ` +
        `exactly (e.g. \`{ ${mintedName}: symbol.native\`${mintedName}: …\`(...) }\`), so the bound verb and the ` +
        `value's self-reported identity never disagree.`,
    );
  }
}

/** A seam expected a concrete `AmbientRuntime` (or an `assembleAmbient()`
 *  product) and got a hand-rolled/structural stand-in instead — `eval/
 *  generator-exec.ts` (`exec`/`execExpr`/the prelude evalScheme),
 *  `eval/exec-phases.ts` (`ambientBase`), `common/capability.ts` (a pack's
 *  `apply`). Every one of these messages decomposes as `${site}: ${detail}` —
 *  kept as free text (not further split into facts) because the four sites'
 *  phrasing genuinely differs in shape, not just in filled-in values. */
export class AmbientShapeError extends ArrivalError {
  public readonly name = "AmbientShapeError";
  readonly "arrival/error-category": ErrorClass = "other";

  constructor(
    /** The call site's own name (`"exec"`, `"execExpr"`, `"prelude evalScheme"`,
     *  `capability "${name}"`, …). */
    public readonly site: string,
    public readonly detail: string,
  ) {
    super(`${site}: ${detail}`);
  }
}

// -------------------------------------------------------------------------
// :: Provenance/wire doors — joins ReplayScopeError/WireLocalityError family
// (those colocated with their mechanism; this one lives in the shared home).
// -------------------------------------------------------------------------

/** A wire's declared `params` name has no matching key in the caller-supplied
 *  ingress bindings (`provenance/gamma.ts`'s `assertIngressCovers`) — a caller bug
 *  (a param a replay driver forgot to supply), named at γ's own boundary instead
 *  of surfacing as an opaque unbound-variable error three calls deep in `exec`. */
export class IngressBindingError extends ArrivalError {
  public readonly name = "IngressBindingError";
  readonly "arrival/error-category": ErrorClass = "other";

  constructor(
    public readonly span: string,
    public readonly param: string,
  ) {
    super(
      `hermeticApply: wire "${span}" declares param "${param}" but no ingress binding was supplied for ` +
        "it — every name in wire.params must have a matching key in ingress, or " +
        "the applied lambda hits an unbound variable deep inside exec instead of this door.",
    );
  }
}

/** A trace (`provenance/trace.ts`'s `EvalTrace`) hit its entry cap — the message
 *  carries "budget exceeded" so the same wall-clock-deadline classifier
 *  (`/budget exceeded|abort|maximum call stack/i`) treats a runaway trace as
 *  contained rather than an unhandled crash. Run aborts with a partial trace
 *  instead of OOMing the isolate or freezing the canvas. */
export class TraceBudgetError extends ArrivalError {
  public readonly name = "TraceBudgetError";
  readonly "arrival/error-category": ErrorClass = "other";

  constructor(public readonly maxEntries: number) {
    // A DOOR, not a dead end: never offer a remedy the reader cannot perform. An
    // MCP-facing model cannot reach a host-process env var (there is no
    // `ARRIVAL_TRACE_MAX` knob in the tool schema) — only actionable fixes belong
    // in the message (bound the loop, work on a slice, use a built-in that does
    // the work in one step).
    //
    // Say explicitly that this ends a PROGRAM, not a SESSION (EvalTrace.beginRun
    // re-arms the cap per run) — an agent not told this may read the whole world
    // as dead and stop making progress instead of continuing past it.
    super(
      `this program traced ${maxEntries} evaluation steps and was stopped — a loop this big is ` +
        `almost always unintended.\n` +
        `Your earlier definitions are INTACT and the session is fine — only this program was stopped.\n` +
        `Try: bound the loop (fewer iterations), work on a slice first (e.g. \`(take xs 100)\`), or ` +
        `use a built-in that does the work in one step (\`string-split\`, \`filter\`, \`assoc\`) ` +
        `instead of walking char-by-char.`,
    );
  }
}

// -------------------------------------------------------------------------
// :: Value doors — a value-level operation refuses a shape it cannot honor.
// -------------------------------------------------------------------------

/** `sort`'s default comparator hit an element declaring no `arrival/tagless-final/
 *  lte` (no natural order, e.g. a bare pair) — `values/op-helpers.ts`. Supply an
 *  explicit comparator instead of relying on the default total order. */
export class ComparatorRequiredError extends ArrivalError {
  public readonly name = "ComparatorRequiredError";
  readonly "arrival/error-category": ErrorClass = "other";

  constructor(public readonly elementDescription: string) {
    super(
      `sort: cannot order a ${elementDescription} (it declares no arrival/tagless-final/lte; supply a comparator).`,
    );
  }
}

/** arrival omits the complex numeric tower entirely (R7RS § 6.2.3 permits this) —
 *  `sqrt` of a negative, `make-rectangular`/`make-polar`, a `3+4i` literal, and
 *  `real-part`/`imag-part`/`magnitude`/`angle` all door here (`values/numbers.ts`'s
 *  `complexDoor`) rather than silently misparsing. */
export class ComplexNumberError extends ArrivalError {
  public readonly name = "ComplexNumberError";
  readonly "arrival/error-category": ErrorClass = "other";

  constructor() {
    super("complex numbers are not supported in arrival — inexact reals only; pass real/imag as separate values");
  }
}

/** A receiver primitive has no `arrival/tagless-final/<op>` term implementing a
 *  dispatched tagless op (`common/symbols/tagless.ts`'s `symbol.tagless` binder).
 *  MODEL-REACHABLE (e.g. `(car 1)`), so this is a door, not an invariant — see the
 *  not-callable doors note in evaluator.ts for why `invariant`'s "Invariant
 *  failed: " prefix reads wrong for a program mistake. */
export class TaglessProtocolError extends ArrivalError {
  public readonly name = "TaglessProtocolError";
  readonly "arrival/error-category": ErrorClass = "other";

  constructor(
    public readonly op: string,
    /** The scheme-visible receiver description (tagless.ts's local describeReceiver). */
    public readonly receiver: string,
    /** The `arrival/tagless-final/<op>` term name the receiver is missing. */
    public readonly termName: string,
  ) {
    super(
      `${op}: the ${receiver} primitive does not support \`${op}\` (it declares no ${termName}). A ` +
        `tagless op lives ON the arrival terms whose algebra implements it.`,
    );
  }
}

// -------------------------------------------------------------------------
// :: TypeTagError — `define/overridable`'s s/* type-tag validation door.
//
// Two distinct failures under one class (they share the same authoring context —
// the binding's declared type — but neither is the other's fact variant of a THIRD
// thing): a type tag `lowerTag` cannot turn into a real validator at all
// ("unrecognized-tag"), or a value (an override or the in-form default) failing
// its own declared type at `overridable/resolve` ("value-mismatch"). `env/overridable/overridable.ts`.
// -------------------------------------------------------------------------
export class TypeTagError extends ArrivalError {
  public readonly name = "TypeTagError";
  readonly "arrival/error-category": ErrorClass = "other";

  constructor(
    /** The `define/overridable` binding name — routing/telemetry key. */
    public readonly bindingName: string,
    public readonly kind: "unrecognized-tag" | "value-mismatch",
    /** unrecognized-tag: `JSON.stringify(jsTag)` + the lowering failure reason, already joined.
     *  value-mismatch: `describeTag(jsTag)` — what the declared type expects. */
    public readonly expectedOrReason: string,
    /** value-mismatch only: `describeValue(raw)` — what actually arrived. */
    public readonly got?: string,
    /** value-mismatch only: which source supplied the value. */
    public readonly source?: "an environment override" | "the in-form default",
  ) {
    super(
      kind === "unrecognized-tag"
        ? `define/overridable ${bindingName}: unrecognized type tag ${expectedOrReason} — expected an s/* ` +
            `expression: (s/string)/(s/number)/(s/integer)/(s/boolean), (s/enum value...), ` +
            `(s/object (s/field ...)...) or (s/array tag) (see @inhuman.tools/arrival/capabilities/schema), optionally ` +
            `wrapped in (s/optional ...)`
        : `define/overridable ${bindingName}: expected ${expectedOrReason}, got ${got} (from ${source}) — ` +
            `${
              source === "an environment override"
                ? "the environment that supplied this value should validate at its own boundary too"
                : "a default must satisfy its own declared type — that's the plain-define-plus-validation floor"
            }`,
    );
  }
}

// -------------------------------------------------------------------------
// :: CarrierMismatchError — `append`'s non-last-operand door (R7RS §6.4).
//
// A non-last operand must be a proper list (append walks its car-spine to splice
// each element) — a vector/string/bytevector/other carrier there can't silently
// contribute "nothing" or become the whole result. Names the carrier and, when one
// exists, the sibling verb that actually concatenates it (`env/r7rs/lists.ts`).
// -------------------------------------------------------------------------
export class CarrierMismatchError extends ArrivalError {
  public readonly name = "CarrierMismatchError";
  readonly "arrival/error-category": ErrorClass = "other";

  constructor(
    /** The spine-walking verb that refused (currently always "append"). */
    public readonly verb: string,
    /** The operand's own scheme-visible type name (`type(item)`). */
    public readonly carrier: string,
    /** The sibling verb that concatenates this carrier, when one exists
     *  ("vector-append"/"string-append"/"bytevector-append"). */
    public readonly alternative?: string,
  ) {
    super(
      alternative
        ? `${verb}: every argument but the last must be a proper list, got a ${carrier} — use ` +
            `\`${alternative}\` to concatenate ${carrier}s`
        : `${verb}: every argument but the last must be a proper list, got a ${carrier} — ${verb} only ` +
            `splices list spines, not this carrier`,
    );
  }
}

// -------------------------------------------------------------------------
// :: OFFENDING_VALUE — symbol-keyed metadata on a collection-type-error: the
// value a collection op refused. SYMBOL-KEYED metadata rides the error OBJECT;
// `error.message` is NEVER touched. Consumers read ONLY through offendingValueOf
// (failAndWrap rewraps throws — top-level-only symbol read is always undefined
// through real exec paths; walk .cause).
// -------------------------------------------------------------------------

export const OFFENDING_VALUE = Symbol("arrival/offending-value");

/** Max cause-chain depth (failAndWrap adds at most one ArrivalError layer). */
const OFFENDING_VALUE_MAX_CAUSE_DEPTH = 4;

/** Attach offending VALUE to a collection-type-error. Metadata rides the error
 *  OBJECT (plain symbol assignment, never message). try/catch so a frozen error
 *  never masks the real throw. Returns same error by reference for inline throw. */
export function attachOffendingValue<E>(error: E, value: unknown): E {
  try {
    (error as unknown as Record<symbol, unknown>)[OFFENDING_VALUE] = value;
  } catch {
    // Never let metadata attachment mask the real error being thrown.
  }
  return error;
}

export function offendingValueOf(error: unknown): unknown | undefined {
  let node: unknown = error;
  for (let depth = 0; depth < OFFENDING_VALUE_MAX_CAUSE_DEPTH && typeof node === "object" && node !== null; depth++) {
    const value = (node as Record<symbol, unknown>)[OFFENDING_VALUE];
    if (value !== undefined) return value;
    node = (node as { cause?: unknown }).cause;
  }
  return undefined;
}

// KwargsRejectionError lives in common/kwargs-rejection.ts (mechanism-local).
