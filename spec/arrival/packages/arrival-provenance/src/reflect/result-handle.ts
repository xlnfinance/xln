// result-handle.ts — the handle a `(require/eval …)` / `(require/call …)` hands back to DISCOVERY.
//
// A run is CAUSAL by default (the cheap, sequential reduction — an untraced `runProgram`): the VALUE
// comes back fast and almost always succeeds. Provenance is the TELEOLOGICAL view — the whole
// derivation grasped at once (`why`/`where`/`how`/`dag`) — and it is built LAZILY, by a replay-bound
// traced re-run, only when first asked. A causal run reads the program forward one step at a time;
// a teleological run holds the entire computation as a single object.
//
// The payoff: value-delivery and provenance are independent failure domains. The data path can't be
// taken down by tracing overhead — only the lazy provenance re-run can hit the trace cap, and when it
// does it surfaces a "provenance unavailable here" door while `(result-value h)` still returns the data.
//
// A THIRD view, `attested()`, answers a different question — can this value be TRUSTED, not
// where did it come from. Same memoize-once discipline as `teleological()`. THIS WAVE (T6c): the
// attestation machinery (J1's static circuit, J2's live probe) has landed and is wired live via
// the host-injected `attestProvider` capability below — `attested()` resolves with a REAL,
// per-leaf verdict when the capability is present, and still throws (unchanged) when it is not
// (a run that never finished has no derivation to attest either — `attestProviderFor`,
// mcp-worker's discovery-run.ts, omits the capability whenever it omits `boxedValue`, mirroring
// the "present iff finished" contract those two already share). `grounded?`/`attest`
// (handle-provenance.ts) call this FIRST and fall back to a per-leaf, trace-based ADVISORY on the
// throw — unchanged by this wave; only the THROW's conditions changed, not that fallback path.
//
// HOST-INJECTED CAPABILITIES (#23/#15/T6c) — `capabilities` is the seam a host that already
// depends on both this analysis plane and the compiler (mcp-worker's `discovery-run.ts`) uses to
// hand this handle wiring `/reflect` must not build for itself:
//   - `circuitProvider` lets `circuitOf` (handle-provenance.ts) render a REAL static attribution
//     circuit instead of its architectural door — see that function's doc for exactly why
//     this subpath does not import `@inhuman.tools/arrival-mercury`.
//   - `boxedValue` is the RAW pre-`toJS`-peel AValue behind `value` (`RunHandle.result`,
//     `run-program.ts`'s own doc), which lets `leafRows` enumerate a container's real leaves
//     instead of treating a peeled JS blob as one atomic leaf.
//   - `attestProvider` (T6c) is the live static∧probe conjunction, per leaf — see `attested()`'s
//     own doc below. Its verdict shape (`AttestedLeafVerdict`) is a LOCAL, duck-typed mirror of
//     `@inhuman.tools/arrival-mercury/seal.ts`'s `SealVerdict` — never imported (same cycle
//     `circuitProvider` avoids by returning a plain `string`; this returns plain data instead).
// All three are ADDITIVE: absent capabilities leave every existing fail-closed behavior —
// `circuitOf`'s door, `leafRows`' single-peeled-leaf fallback, `attested()`'s throw — exactly as
// it was before this wave.

import type { EvalTrace } from "../trace.js";
import { arrival } from "@inhuman.tools/arrival/host-internals";

const RESULT_HANDLE = Symbol.for("arrival.ResultHandle");

/**
 * A field's address inside a (possibly nested) VALUE: an object key or an array index,
 * root-to-field. `[]` addresses the root value itself. Structurally identical to
 * `@inhuman.tools/arrival-mercury`'s `FieldPath` (verdict/field-prov.ts) and mcp-worker's
 * `attest-provider.ts`'s `LeafPath` — re-declared, not imported (this analysis plane does not
 * import the compiler, see `circuitOf`'s doc): a deliberate Nth non-declaration of the
 * SAME grammar, not a new one (field-prov.ts's own header already lists three; this is the
 * reflect-side copy the `:at` verbs thread through).
 */
export type FieldPath = readonly (string | number)[];

/**
 * One leaf's sealed verdict — structurally identical to `@inhuman.tools/arrival-mercury`'s
 * `SealVerdict` (seal.ts), duck-typed here rather than imported (this analysis plane does not
 * import the compiler — see this file's header). `content-attested`/`selection-attested` are the only
 * two POSITIVE kinds; everything else is `not-attestable` (the seal never distinguishes "provably
 * fake" from "unprovable" to a consumer — seal.ts's own doc on why).
 */
export type AttestedLeafVerdict =
  | { readonly kind: "content-attested" }
  | { readonly kind: "selection-attested"; readonly vocabulary: ReadonlySet<string> }
  | { readonly kind: "not-attestable"; readonly reason: string };

/** One value-position leaf's full attested row: its sequential `path` (the same enumeration order
 *  `leafRows`/`verdictLeafValues` already document leaf paths against), a display string for the
 *  leaf's baseline value, and its sealed verdict.
 *
 *  `at` (BC-4, field-granular-access.md §4.2.3/§5.1) is the REAL `FieldPath` this leaf addresses
 *  (mcp-worker's `staticLeavesOf` already computes it per leaf; it used to be discarded in favor
 *  of the ordinal `path`). ADDITIVE, alongside `path` — the frozen
 *  `mcp-worker/src/__tests__/attest-conjunction.test.ts` pins the ordinal `:path N` on the wire, so
 *  `path: number` stays exactly as it renders today; the ordinal's removal awaits that file's own
 *  authorization (see README.md C5 / field-granular-access.md §4.2.3). */
export interface AttestedLeaf {
  readonly path: number;
  readonly at: FieldPath;
  readonly display: string;
  readonly verdict: AttestedLeafVerdict;
}

/**
 * One `(… :at <path>)`-scoped field query's full result (BC-4, field-granular-access.md §4/§5) —
 * the SINGLE-FIELD sibling of {@link AttestedLeaf}'s whole-artifact enumeration. `cone` is a
 * PRE-RENDERED sexpr string (`circuitToSexpr`'s output over the resolved field's `StaticProv`
 * cone) — never the `StaticProv` object itself: this subpath does not hold an arrival-mercury
 * type, the SAME boundary `circuitProvider`'s plain-string return already crosses.
 */
export interface AttestedField {
  /** Echoed canonically from the RESOLVED query (field-granular-access.md §4.2.3), never the
   *  caller's own spelling — the parsed `FieldPath` after sugar expansion (a bare `"score"`
   *  echoes as `("score")`). */
  readonly at: FieldPath;
  readonly verdict: AttestedLeafVerdict;
  /** `circuitToSexpr(cone)`, pre-rendered host-side — see this type's own doc for why a string,
   *  never a StaticProv. Absent on a §2.5 QUERY REFUSAL (an absent key has no cone at all —
   *  the verdict's reason carries the door text instead). */
  readonly cone?: string;
  /** Present iff the static descent stopped before consuming the whole path (§2.4's frontier) —
   *  the unconsumed suffix. A frontier is a legitimate, often-positive outcome, not an error. */
  readonly frontier?: FieldPath;
  /** `StaticProv` NodeIds (bare numbers — the same "no head@line:col" honesty `circuitToSexpr`'s
   *  own `:site` already keeps) of every fan the descent crossed, root to leaf. Navigation-grade
   *  only; a non-empty list is why `verdict` is `not-attestable` (per-element seals are not sound
   *  yet — field-granular-access.md §4.1). */
  readonly crossedFans?: readonly number[];
}

/** Host-injected capabilities (#23/#15/T6c) — see this file's header for the seam these close. */
export interface ResultHandleCapabilities {
  /** Renders the static attribution circuit for the SAME source this handle's run executed.
   *  Sync — the circuit is a pure fold over an already-parsed program (I1's totality proof), no
   *  further await needed. `path` (BC-4, `:at` — field-granular-access.md §5.1) narrows to one
   *  field's cone instead of the whole circuit; absent ⇒ the whole-circuit rendering, byte-
   *  identical to before `:at` existed. */
  readonly circuitProvider?: (path?: FieldPath) => string;
  /**
   * The RAW pre-`toJS`-peel AValue. Presence is checked with `Object.hasOwn` at the read
   * site, NEVER `!== undefined` — a captured raw result CAN legitimately be the bare JS
   * `undefined` (e.g. `RunHandle.result` on a program with no evaluated top-level forms), so
   * `undefined` must still read as "the host captured this value", not as an absence signal. A
   * construction site that never captured a raw value at all (e.g. a timed-out causal run, which
   * has no derivation to grasp) must omit this key entirely, never set it to `undefined`.
   */
  readonly boxedValue?: unknown;
  /**
   * T6c — the live static∧probe conjunction, per leaf. Present iff the causal run finished (same
   * discipline as `boxedValue` — a timed-out run has nothing to attest). `attested()` calls this
   * once and memoizes the result.
   */
  readonly attestProvider?: () => Promise<readonly AttestedLeaf[]>;
  /**
   * BC-4 — the per-FIELD sibling of {@link attestProvider}: seals exactly the one field `path`
   * addresses (field-granular-access.md §4.1's `sealField`), rather than every build-decomposed
   * leaf of the whole value. Present under the SAME "iff the causal run finished" discipline as
   * `attestProvider`/`boxedValue`. Rejects (never resolves a fabricated positive) on a QUERY
   * refusal (an absent key, a step into a scalar, …, §2.5) — the caller sees a thrown door naming
   * the problem, mirroring `circuitOf`'s existing "no provider" door style; a CONSERVATISM (a dead
   * mux, a fan crossing, a frontier) still resolves normally, with the coarseness reflected in the
   * verdict/`frontier`/`crossedFans` fields, never a throw. NOT memoized (unlike `attestProvider`'s
   * `attested()`) — Wave 1 defers the per-run probe memo (field-granular-access.md §4.3, open Q6);
   * correctness first, a repeated `:at` ask simply re-resolves.
   */
  readonly attestFieldProvider?: (path: FieldPath) => Promise<AttestedField>;
}

/** A run's value, plus a lazy door to its teleological (provenance) view. Not wire-safe by design. */
export class ResultHandle {
  readonly [RESULT_HANDLE] = true;
  #teleological?: { trace: EvalTrace; outputNode: unknown };
  #error?: Error;
  #attestedError?: Error;
  #attested?: readonly AttestedLeaf[];

  constructor(
    /** The wire-safe causal value (already wire-safe-checked at the choke). */
    readonly value: unknown,
    /** Lazily builds the trace (a replay-bound teleological re-run), under the ASKING call's signal.
     *  Absent if the causal run didn't finish (a timed-out run has no derivation to grasp). */
    private readonly build?: (signal?: AbortSignal) => Promise<{ trace: EvalTrace; outputNode: unknown }>,
    /** Host-injected capabilities (#23/#15) — see this file's header. Absent by default; every
     *  existing construction site (and every existing caller) is unaffected. */
    readonly capabilities?: ResultHandleCapabilities,
  ) {}

  /** The teleological view: the trace + output node `why`/`where`/`how`/`dag` project. Built once
   *  (memoized). `signal` fans the ASKING call's cancellation into the replay-bound re-run. Throws a
   *  "provenance unavailable" door if the run is too large to trace or never finished — the VALUE is
   *  unaffected. An UPSTREAM abort is NOT memoized (transient — a later ask under a live signal may
   *  succeed); only a genuine too-large/didn't-finish verdict sticks. */
  async teleological(signal?: AbortSignal): Promise<{ trace: EvalTrace; outputNode: unknown }> {
    if (this.#error) throw this.#error;
    if (!this.#teleological) {
      if (!this.build) {
        throw (this.#error = new Error(
          "provenance unavailable: this run did not finish (timed out / too large), so it has no derivation to grasp.",
        ));
      }
      try {
        this.#teleological = await this.build(signal);
      } catch (error) {
        if (signal?.aborted && error instanceof Error && /abort/i.test(error.name + error.message)) {
          throw error; // upstream cancellation — do NOT poison the handle; the value still stands.
        }
        throw (this.#error = new Error(
          `provenance unavailable: the run is too large to trace (${error instanceof Error ? error.message : String(error)}).`,
        ));
      }
    }
    return this.#teleological;
  }

  /**
   * The attestation view: can this value be TRUSTED (not just where it came from). Memoized
   * once, like {@link teleological}. T6c: when the host injected an `attestProvider` capability
   * (present iff the causal run finished — mirrors `boxedValue`'s own discipline), this calls it
   * ONCE and resolves with the real, per-leaf `AttestedLeaf[]` — the static∧probe conjunction
   * (seal.ts's `seal()`), never a bare positive/negative rollup (a mixed result must attest and
   * refuse each leaf independently, `handle-provenance.ts`'s own doc). Absent the capability (no
   * host wired one, or the run never finished), this throws exactly as it always has — a thrown
   * door is cached too, so repeat calls don't re-attempt. `grounded?`/`attest`
   * (handle-provenance.ts) call this FIRST and render its resolved leaves, falling back to the
   * per-leaf trace-based ADVISORY only on the throw.
   */
  async attested(signal?: AbortSignal): Promise<readonly AttestedLeaf[]> {
    if (this.#attestedError) throw this.#attestedError;
    if (this.#attested) return this.#attested;
    if (!this.capabilities?.attestProvider) {
      throw (this.#attestedError = new Error(
        "attestation unavailable: no live attestProvider capability on this handle — " +
          "(grounded? h) returns the fail-closed verdict with a trace-based advisory.",
      ));
    }
    try {
      this.#attested = await this.capabilities.attestProvider();
      return this.#attested;
    } catch (error) {
      if (signal?.aborted && error instanceof Error && /abort/i.test(error.name + error.message)) {
        throw error; // upstream cancellation — do NOT poison the handle; a later ask may succeed.
      }
      throw (this.#attestedError = new Error(
        `attestation unavailable: the live conjunction failed (${error instanceof Error ? error.message : String(error)}).`,
      ));
    }
  }

  /**
   * BC-4 — seal exactly the field `path` addresses (field-granular-access.md §4/§5). Unlike
   * {@link attested}, NEVER memoized: Wave 1 defers the per-run probe memo (§4.3's open Q6), and a
   * different `path` per call would make a single memo slot actively wrong, not just stale. Throws
   * (never resolves a bare fail-closed placeholder) when no `attestFieldProvider` capability is
   * present — mirrors `circuitOf`'s own "no provider" door style — and propagates the provider's
   * own rejection verbatim otherwise (a §2.5 query refusal surfaces here as a thrown door; a
   * conservatism resolves normally, see `ResultHandleCapabilities.attestFieldProvider`'s doc).
   */
  async attestedField(path: FieldPath): Promise<AttestedField> {
    if (!this.capabilities?.attestFieldProvider) {
      throw new Error(
        "attestation unavailable: no live attestFieldProvider capability on this handle — " +
          "(grounded?/attest h) (without :at) still returns the whole-artifact fail-closed advisory.",
      );
    }
    return this.capabilities.attestFieldProvider(path);
  }
}

// `@arrival.private` (capability.ts's own `z.instance(ResultHandle)` contract, mirroring
// llm-plane-arrival-env/src/classes.ts's `McpServer`/`McpTool`/`LLMModel`): crosses the membrane
// as an opaque `AOpaqueHandle` — mint/reuse per run, `#<ResultHandle>` print, no structural
// `(:field h)` read. Additive alongside `is_result_handle`'s own `Symbol.for` brand (wire-safe.ts
// and other cross-module duck-typing call sites keep using that; this stamp is CONSUMED by the
// scheme-zod `instance(Ctor)` codec specifically, a different mechanism for a different crossing).
arrival.private(ResultHandle);

export function is_result_handle(v: unknown): v is ResultHandle {
  return typeof v === "object" && v !== null && (v as Record<symbol, unknown>)[RESULT_HANDLE] === true;
}
