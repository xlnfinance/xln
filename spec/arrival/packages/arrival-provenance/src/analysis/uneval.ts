// uneval.ts — the `{result, meta, uneval}` container + the selector-eval step.
//
// By design (no new entity): a traced run yields a container whose `uneval` is NOT special
// trickery — `uneval("(car result)")` evaluates the selector as ONE MORE tapped step (with the
// program's output bound to `result`, so the effective value carries provenance intact), then
// reverse-slices the trace by that effective value's provenance into a re-runnable Scheme program
// that re-derives exactly it.
//
// Why this is sound (and why arrival was made pure): the language is pure dataflow with on-value
// provenance, so the effective value's origin set IS its dependency set, and a program restricted
// to that derivation reproduces the value (the Galois-slicing `uneval` of Perera–Cheney; purity is
// the theorem that makes the least slice exist and be sound). The container's `program` is the
// real SLICE (via `buildSlice`): only the top-level forms the effective value depends on, plus
// the selector. Intra-form minimal slicing (sub-form re-synthesis) is the deferred increment.
//
// This is the RETROSPECTIVE half of the original `provenance/uneval.ts` (provenance
// analysis-stack relocation): `buildUneval` reverse-slices a FINISHED trace. Its sibling, the
// PROSPECTIVE wire-emission half (`unevalWire`/`WireEmission`) is a production dependency of
// core's `wireframe/builder.ts` (called at wireframe-BUILD time, not analysis time) — so it
// stayed in core, still at `provenance/uneval.ts`, unmoved. The two halves shared a file only
// because both start from "a closed re-derivation of a value"; they have zero code in common
// (verified: no shared helpers, no shared imports) and this relocation is the first point they
// needed genuinely different homes.
import { execState, parse, toJS, type LexicalScope, type SchemeValue } from "@inhuman.tools/arrival";
import {
  buildSlice,
  writeForm,
  defineNameOf,
  lastTopLevelForm,
  type EvalTrace,
} from "@inhuman.tools/arrival/provenance";
import { AValue } from "@inhuman.tools/arrival/reflect-internals";

/** Same fusion as arrival `LexicalScopeWithInternals` (on `/host-internals` after rebuild). */
type UnevalWritableScope = LexicalScope & { readonly env: { bind(name: string, value: SchemeValue): void } };

/** One reverse-chain answer: the effective value the selector produced, the origin reads it
 *  traces to, and a re-runnable Scheme program that re-derives it. */
export interface Uneval {
  /** The effective value the selector picked out (peeled to plain JS). */
  value: unknown;
  /** The origin-IDs the value traces to — the provenance-point invocations (the evidence reads /
   *  marked derivations). Empty if the selector produced a non-provenanced value. */
  provenance: number[];
  /** A re-runnable Scheme program re-deriving the value: the SLICE — only the top-level forms the
   *  effective value depends on (the backward dependence cone), followed by the selector that
   *  picks it out. Unrelated forms are pruned; referenced literal defines are kept. */
  program: string;
  /** The dynamic point-cone — the provenance-point ids the value depends on (the evidence reads
   *  / derivations). The per-leaf→read join key; also a UI source-highlight seed. */
  points: number[];
  /** `scopeId` of each kept form (stable source-location keys, for UI highlighting). */
  scopeIds: string[];
}

/** A traced run's return value, by design: the answer, run metadata, and `uneval`. */
export interface UnevalContainer {
  /** The program's output value (peeled to plain JS). */
  result: unknown;
  meta: { forms: number };
  /** Evaluate a selector ("(car result)", "(:PID (car result))") as one more tapped step and
   *  reverse-slice the trace by the effective value's provenance. */
  uneval: (selector: string) => Promise<Uneval>;
}

/** Build the `{result, meta, uneval}` container from a finished traced run. `result` is the run's
 *  final value as a raw AValue (provenance intact — NOT `toJS`-peeled); `scope` is the post-run
 *  lexical scope (so the selector evaluates with the run's defines visible and `result` bound, and
 *  — since Stage C Cut 3b — the selector's heads resolve through the SAME self-hosted base every
 *  run shares, `execState`'s own `BASE_ROSTER` fold, not a caller-supplied ambient handle); `trace`
 *  is the run's EvalTrace (so the selector's step records, and the slice can read the whole
 *  lineage). `source` is the original program text (the v1 program render). */
export function buildUneval(opts: {
  // A finished run's continuation handle is `ExecState.scope` (equivalently `RunHandle.scope`).
  scope: LexicalScope;
  result: unknown;
  trace: EvalTrace;
  source: string;
  forms: readonly unknown[];
}): UnevalContainer {
  const { scope, result, trace, forms } = opts;
  // The run's OUTPUT expression (the last top-level form) is what produces `result`. The slice is
  // anchored on the symbols IT references, so the derivation of `result` is reproduced in full;
  // we then bind `result` to it and append the selector — the selector picks the effective value
  // out of the reproduced output. Anchoring on the output form (not the value's provenance cone)
  // is what makes the slice CLOSED: its binding form + whole consumer chain are kept by reference.
  // The run's OUTPUT form — explicit `forms` if threaded, else the trace's last top-level form
  // (captured HERE, before any selector eval pollutes the trace with its own top-level form).
  const outputForm = forms.length > 0 ? forms.at(-1) : lastTopLevelForm(trace);
  const outputName = outputForm === undefined ? null : defineNameOf(outputForm);
  // `result` re-expressed in the slice's terms: the output's name if it's a define, else the
  // output expression rendered back to source.
  const resultExpr = outputForm === undefined ? "result" : (outputName ?? writeForm(outputForm));

  /** One scheme→JS exit; void / absent values stay `undefined` (no soft peel of plain JS). */
  const peel = (v: unknown): unknown => (v === undefined ? undefined : toJS(v as SchemeValue));

  return {
    // `result`/`v` (below) are declared `unknown` at this public boundary (this file's own
    // `scope.define("result", result as never)` already casts the same value to bind it into
    // the interpreter's scope — it must genuinely be a SchemeValue to be usable there).
    result: peel(result),
    meta: { forms: forms.length },
    uneval: async (selector: string): Promise<Uneval> => {
      // Bind the run's output as `result`, then evaluate the selector as ONE more tapped step —
      // the effective value is produced by the SAME pure evaluator, so it carries provenance and
      // becomes a trace node, exactly like any value the program itself computed.
      const writable = scope as UnevalWritableScope;
      writable.env.bind("result", result as never);
      const sel = await parse(selector);
      const lastForm = sel.at(-1);
      if (lastForm === undefined) throw new Error(`uneval: selector "${selector}" parsed to zero forms`);
      const state = await execState(lastForm, { scope, tap: trace });
      let v: unknown = state.values.at(-1);
      if (v != null && typeof (v as { then?: unknown }).then === "function") v = await (v as Promise<unknown>);
      const provenance = v instanceof AValue ? [...v.provenance] : [];
      // The SLICE: the reachable derivation of the run's output (static backward reference-closure
      // from the output's symbols), then a LET that binds `result` to the reproduced output and
      // evaluates the selector against it. A `let` (not a top-level `(define result …)`) avoids a
      // collision when the program's own output binding is itself named `result` (which produced a
      // degenerate `(define result result)`). Closed + re-runnable by construction.
      const slice = buildSlice(trace, outputForm);
      const tail = `(let ((result ${resultExpr})) ${selector.trim()})`;
      const program = slice.program ? `${slice.program}\n${tail}` : tail;
      // `v` is the tapped step's result — same evaluator-output contract as `result` above.
      return {
        value: peel(v),
        provenance,
        program,
        points: slice.points,
        scopeIds: slice.scopeIds,
      };
    },
  };
}
