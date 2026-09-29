/**
 * trace → REGION TREE — blueprint render's structural model. Infer calls = leaves;
 * fan-out (map/filter/fold) = CONTAINERS, N iterations kept DISTINCT (Z-tabs). Built
 * from RAW invocation tree (not the scope-collapsing forest) — iterations survive.
 *
 * Walk rules: provenance point → LEAF; fan-out head → CONTAINER (child applications);
 * else (let/if/list/fn call) → PLUMBING, flattened through. WIRES: provenance edges
 * between leaves (`⋃ child.provenance` ∩ point set — same rule statechart/chain use).
 *
 * TCO: self-recursive fn (`loop ⊃ … ⊃ loop`) peeled into one `fanout`; each iteration
 * CUT at next recursive call (bodies don't leak). Loop iterations reuse `fanout` (Z-tabs).
 * PERF: spine walk O(N) total (early-return DFS).
 *
 * `traceToRegions(trace)` = `buildRegions(snapshotTrace(t), t)`. Trace APPEND-ONLY →
 * `TraceRegionFold` (`trace-region-fold.ts`) maintains incrementally O(Δ). Parity: strict
 * deep-equal test over EXPORTED pure helpers (`leafFor`, `conditionOf`, `regionsAt`, …).
 */
import { deepProvenance, toJS, type SchemeValue } from "@inhuman.tools/arrival";
import { APair } from "@inhuman.tools/arrival/reflect-internals";
import { schemeToSugarcoat } from "@inhuman.tools/arrival-sugarcoat";

import { carrierFieldEdges, scopedBindings, subtreeIds } from "./carrier-fields.js";
import {
  userCallSite,
  snapshotTrace,
  scopeId,
  type PlainInv,
  type PlainTrace,
  type EvalTrace,
  type Invocation,
} from "@inhuman.tools/arrival/provenance";
import { staticLoopBodyScopes, staticRecursiveHeads, STRUCTURAL_FORMS } from "./trace-to-forest.js";

/** A producer crossing a region's boundary — the region-model's first-class PORT.
 *  Keyed by producer's STRUCTURAL scope-id, NOT per-value: a N-times body emits
 *  ONE port per structural producer. */
interface RegionPort {
  /** Producer's structural scope-id (`head@line:col`) crossing the boundary. */
  producer: string;
  /** Consumer's named input slot the value flowed into (a `.prompt` kwarg) — off the
   *  crossing edge's `field`. */
  field?: string;
}

export type Region =
  | {
      kind: "leaf";
      id: number;
      label: string;
      /** Stable STRUCTURAL identity (`head@line:col`) — same string every iteration of one
       *  `(infer …)`. Render keys boundary ports by this: N-times body emits ONE exit port
       *  per structural producer, not N. */
      scope: string;
      nodeKind: "direct" | "prompt";
      /** Node metadata bound via `resultWithProvenance` — a `.prompt` leaf carries
       *  `{ kind:"prompt", path, model, inputs }`; a bare `(infer …)` has none. */
      meta?: unknown;
      /** The resolved inference result (`undefined` while running). */
      value?: unknown;
      /** running | resolved | rejected — pending vs result vs error in the card. */
      state: "running" | "resolved" | "rejected";
      /** Rejection detail for a `rejected` leaf — off `Invocation.error`. */
      error?: string;
      /** Cache HIT (replayed free) vs fresh (paid). `undefined` for non-infer leaves. */
      cached?: boolean;
    }
  | {
      /** A `<>` DECISION MARKER — the point a live branch (`if`/`cond`/…) decided
       *  one way HERE. Doesn't box/fork: divergence's absorbed by the enclosing region's
       *  iteration picker (map/filter/TCO Z-tabs); the marker just annotates "decision
       *  made here". The taken arm follows as ordinary siblings. */
      kind: "decision";
      id: number;
      /** Branch head — `if` | `cond` | `case` | `when` | `unless`. */
      label: string;
      /** Stable source-location identity (`head@line:col`) of the branch site. */
      scope: string;
      /** Human-readable branch test, recovered from AST — `score > 0.6`, `stage is "analyze"`.
       *  Known predicate shapes → tidy phrase; unrecognized → verbatim s-expression. AST-only:
       *  value-substitution (`score (0.73) > 0.6`) needs the test's runtime value, which the
       *  snapshot doesn't carry for non-points — next layer. `cond`/`case` stay unlabelled. */
      condition?: string;
      /** PER-ELEMENT verdicts for a NARROWING decision (`filter` today; survivorship
       *  family — `car`/`slice`/`take-while` — later), in collection order over the settled
       *  prefix. `kept` = survived; `origins` = inference points the ELEMENT'S VALUE
       *  deep-traces to (NOT the predicate outcome's provenance) — the pairing key that
       *  lets render absorb the verdict onto the producing fan-out's iterations
       *  (`⊘ filtered` on the dropped tab). `origins:[]` = entered without traced inference
       *  (carried literal) — unpaired row, still counted by `condition`. Absent on plain
       *  branch decisions. */
      verdicts?: { kept: boolean; origins: number[] }[];
    }
  | {
      kind: "fanout";
      id: number;
      /** Stable STRUCTURAL identity (`head@line:col`) of the fanout's call site — same
       *  string every iteration of an OUTER container this fanout nests in. The fanout's `id`
       *  is a per-pass runtime id, so it CANNOT key the cross-pass fold: a nested `(map …)`
       *  run once per outer persona gets a fresh `id` each pass. Keying render fold by
       *  `scope` folds all passes onto one container (matryoshka fix). */
      scope: string;
      /** The fused transform breadcrumb, outermost→innermost. ONE entry = plain
       *  `map`/`filter`/`TCO `loop`; SEVERAL = fused chain (`map ▸ filter ▸ map`) the
       *  cleanup pass collapsed into one frame. Each carries its own invocation id for
       *  cmd-click nav. For ELK the whole fanout — chain included — is ONE node. */
      stages: { label: string; id: number }[];
      /** Distinct iterations, MEANINGFUL ones only (degenerate — no inference — pruned).
       *  Render stacks them on Z-tabs. */
      iterations: Region[][];
      /** Raw incoming invocation count BEFORE pruning — banner reads "10 incoming, 5 mattered". */
      incoming: number;
      /** True when a TCO SELF-RECURSION loop (peeled from a body re-entering itself in tail
       *  position), vs a `map`/`filter` fan-out over a collection. Render draws a loop-back
       *  arc so recursion reads as recursion, not an N-way fan. */
      loop?: boolean;
      /** The container's BOUNDARY ports (Stage 2). `inputs` = external producers whose
       *  values flow into internals (entrance); `outputs` = internal producers whose values
       *  flow outside (exit). Derived by pure edge-vs-membership — an edge `P→C` is an input
       *  of every container holding `C` but not `P`, an output of every container holding
       *  `P` but not `C` — keyed by producer scope so each structural producer is ONE port
       *  regardless of iteration count. Lets a collapsed region show just its ports. */
      inputs: RegionPort[];
      outputs: RegionPort[];
    }
  | {
      /** The program's final STATEMENT OUTPUT — the value the last top-level expression
       *  returned. A single terminal node the whole graph flows into. */
      kind: "output";
      id: number;
      value: unknown;
      state: PlainInv["state"];
    };

export interface RegionGraph {
  /** Top-level meaningful regions, plumbing flattened away. */
  roots: Region[];
  /** Dataflow wires between leaf invocation ids (producer → consumer). `field` =
   *  consumer's INPUT slot the producer's value flowed into — the named kwarg of a
   *  `.prompt` consumer (`"analysis"` for `… :analysis a`), DERIVED by matching the
   *  producer's value against the consumer's `inputs` dict. Absent when the consumer
   *  isn't a `.prompt`, or when the value was PROJECTED/transformed before reaching
   *  the slot (then `inputs[k] !== producer.value` — attributing a projected input
   *  needs provenance-on-value, the v1 follow-up). */
  /** `fromField` marks a field-PLUCK: the consumer read only a SUBSET of the
   *  producer's fields (`(:verdict (infer …))`) rather than the whole value. Its
   *  presence tells the renderer to draw a granular per-field wire into that slot.
   *  Emitted by `attributeFromFields` from the static carrier's pins — appears only
   *  when the trace ran with `AutoBindings` armed; the consumer guards
   *  (`if (e.fromField !== undefined) continue`) honor it either way. */
  edges: { from: number; to: number; field?: string; fromField?: string; kind: "data" | "control" }[];
  warnings: string[];
}

export type RegionEdge = RegionGraph["edges"][number];

/** Heads that fan out: each applies a function across a collection. */
const FANOUT: ReadonlySet<string> = new Set([
  "map",
  "filter",
  "fold",
  "fold-left",
  "fold-right",
  "for-each",
  "mapcat",
  "flat-map",
  "flatmap",
]);

/** DNF control forms — the branching shapes. A branch is INVISIBLE plumbing by
 *  default (the taken arm flattens through), and becomes a rendered container
 *  ONLY when the SAME source-location branch was exercised ≥2 distinct ways
 *  across the whole trace (see `liveBranchScopes`). An always-one-way branch is
 *  seamless — in THIS run it never decided anything, so it isn't a decision. */
const BRANCH_FORMS: ReadonlySet<string> = new Set(["if", "cond", "case", "when", "unless"]);

const headOf = (inv: PlainInv): string => scopeId(inv.node).split("@")[0] ?? "?";

// Recover a human phrase from a branch's test Pair. Known shapes → tidy phrase;
// else → verbatim s-expression. AST-only: static predicate, not runtime value.
interface PairLike {
  car: unknown;
  cdr: unknown;
}
const asPair = (v: unknown): PairLike | null =>
  v !== null && typeof v === "object" && "car" in v && "cdr" in v ? (v as PairLike) : null;
const symOf = (v: unknown): string | undefined => {
  const n = (v as { __name__?: unknown } | null)?.__name__;
  return typeof n === "string" ? n : undefined;
};
const listOf = (v: unknown): unknown[] => {
  const out: unknown[] = [];
  for (let c = asPair(v); c; c = asPair(c.cdr)) out.push(c.car);
  return out;
};
/** Annotate a symbol with its resolved runtime value — `(sym) => "(value)" | ""`. */
type Annotate = (sym: string) => string;
const NO_ANNOTATE: Annotate = () => "";

const atomStr = (v: unknown, ann: Annotate = NO_ANNOTATE): string => {
  const s = symOf(v);
  if (s !== undefined) return `${s}${ann(s)}`;
  if (v === null) return "()";
  if (asPair(v)) return sexpr(v, ann);
  const vo = (v as { valueOf?: () => unknown } | undefined)?.valueOf?.();
  if (typeof vo === "string") return JSON.stringify(vo);
  if (typeof vo === "number" || typeof vo === "bigint" || typeof vo === "boolean") return String(vo);
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "…";
};
const sexpr = (v: unknown, ann: Annotate = NO_ANNOTATE): string =>
  asPair(v)
    ? `(${listOf(v)
        .map((x) => atomStr(x, ann))
        .join(" ")})`
    : atomStr(v, ann);

const INFIX: Readonly<Record<string, string>> = {
  ">": ">",
  "<": "<",
  ">=": "≥",
  "<=": "≤",
  "=": "=",
  "equal?": "is",
  "eq?": "is",
  "eqv?": "is",
};
/** The negated comparison — what the operator becomes on the arm where the test was
 *  FALSE. `a > b` failing IS `a ≤ b`. Equality's negation is `≠` / `is not`. */
const NEG_INFIX: Readonly<Record<string, string>> = {
  ">": "≤",
  "<": "≥",
  ">=": "<",
  "<=": ">",
  "=": "≠",
  "equal?": "is not",
  "eq?": "is not",
  "eqv?": "is not",
};

/** Render a test OPERAND. A compound operand (`(car prop)`) goes through sugarcoat
 *  — `prop[0]`, curly subscripts. A bare atom keeps its inline runtime-value annotation. */
const renderOperand = (operand: unknown, ann: Annotate): string => {
  if (asPair(operand)) {
    try {
      return schemeToSugarcoat(sexpr(operand, NO_ANNOTATE)).trim();
    } catch {
      return sexpr(operand, ann);
    }
  }
  return atomStr(operand, ann);
};

/** Render a test as the REALIZED condition for the arm that ran — no `→ yes/no`.
 * `taken` = test was true; on false each shape renders its own negation
 * (`a > b` → `a ≤ b`, `is empty` → `is not empty`, `not X` flips to `X`). So the pill
 * states the fact that actually held, not the predicate + outcome label. */
function readablePolar(test: unknown, taken: boolean, ann: Annotate = NO_ANNOTATE): string {
  const p = asPair(test);
  if (!p) {
    // Bare-symbol guard (`prop`): its realized truth is presence/absence.
    const s = symOf(test);
    const base = s === undefined ? atomStr(test, ann) : s;
    return taken ? `${base} is present` : `${base} is absent`;
  }
  const parts = listOf(test);
  const head = symOf(parts[0]);
  const opr = (i: number): string => renderOperand(parts[i], ann);
  if (head && INFIX[head] && parts.length === 3) return `${opr(1)} ${(taken ? INFIX : NEG_INFIX)[head]} ${opr(2)}`;
  if (head === "zero?" && parts.length === 2) return `${opr(1)} ${taken ? "=" : "≠"} 0`;
  if (head === "null?" && parts.length === 2) return `${opr(1)} is ${taken ? "" : "not "}empty`;
  if (head === "even?" && parts.length === 2) return `${opr(1)} is ${taken ? "" : "not "}even`;
  if (head === "odd?" && parts.length === 2) return `${opr(1)} is ${taken ? "" : "not "}odd`;
  if (head === "string-prefix?" && parts.length === 3)
    return `${opr(2)} ${taken ? "starts with" : "does not start with"} ${opr(1)}`;
  if (head === "not" && parts.length === 2) return readablePolar(parts[1], !taken, ann); // ¬¬ flips back
  const body = sexpr(test, ann); // fallback: verbatim s-expression
  return taken ? body : `not ${body}`;
}

// ── operand resolution (where the tested value CAME FROM) ────────────────────
// A decision branches on locals (`fails`, `pair`, `prop`) bound by enclosing lets
// whose value-expressions are unrendered plumbing — so a wire would point at an
// invisible node. Instead we resolve each operand to its binding site and read the
// actual value: `fails (∅)`, `pair (#f)`. This is "where it came from" made legible
// inline, the faithful form of operand-wiring when the producer isn't a drawn node.
const LET_FORMS: ReadonlySet<string> = new Set(["let", "let*", "letrec"]);

/** The value-expression a let-family node binds `sym` to, or undefined. */
const bindingValueExpr = (letNode: unknown, sym: string): { valExpr: unknown } | undefined => {
  const parts = listOf(letNode);
  // named let: slot 1 is the loop name (a symbol), bindings shift to slot 2.
  const bindings = symOf(parts[1]) === undefined ? parts[1] : parts[2];
  for (const b of listOf(bindings)) {
    const bp = listOf(b); // (name valExpr)
    if (symOf(bp[0]) === sym) return { valExpr: bp[1] };
  }
  return undefined;
};

/** Resolve a free symbol in a decision's test to its runtime value, by walking up to
 *  the enclosing let that bound it and reading that binding's producer invocation. */
const resolveRaw = (
  decision: PlainInv,
  sym: string,
  valueById: (id: number) => unknown,
): { value: unknown; producerId?: number } | undefined => {
  for (let anc = decision.parent; anc; anc = anc.parent) {
    if (!LET_FORMS.has(headOf(anc))) continue;
    const found = bindingValueExpr(anc.node, sym);
    if (found === undefined) continue;
    if (asPair(found.valExpr)) {
      const producer = anc.children.find((c) => c.node === found.valExpr);
      // `producerId` is the invocation that computed the binding — a candidate
      // data-input wire (drawn only when it's a rendered provenance point).
      return producer ? { value: valueById(producer.id), producerId: producer.id } : undefined;
    }
    // A literal-bound symbol (`(x 0.6)`) — the value IS the literal.
    return { value: found.valExpr };
  }
  return undefined;
};

/** Compact runtime-value glyph for inline annotation: `(∅)`, `(#f)`, `(0.73)`, `([3])`. */
const fmtVal = (v: unknown): string => {
  if (v === false) return " (#f)";
  if (v === true) return " (#t)";
  if (v === null || v === undefined) return " (∅)";
  if (Array.isArray(v)) return v.length === 0 ? " (∅)" : ` ([${v.length}])`;
  if (typeof v === "string") return ` (${JSON.stringify(v.length > 16 ? `${v.slice(0, 16)}…` : v)})`;
  if (typeof v === "number" || typeof v === "bigint") return ` (${String(v)})`;
  if (typeof v === "object") return " ({…})";
  return ` (${String(v)})`;
};

/** The test's runtime outcome. First the test child's materialized value (compound
 *  test → a child invocation carries the boolean); else, for a bare-symbol test,
 *  the resolved operand value. Scheme truthiness: only `#f` is false. */
const outcomeOf = (inv: PlainInv, testNode: unknown, valueById: (id: number) => unknown): "yes" | "no" | undefined => {
  const child = inv.children.find((c) => c.node === testNode);
  if (child?.value !== undefined) return child.value === false ? "no" : "yes";
  const sym = symOf(testNode);
  if (sym !== undefined) {
    const r = resolveRaw(inv, sym, valueById);
    // Only a KNOWN value decides the polarity. A pruned operand (a field-pluck whose stamped
    // value was GC'd by `pruneChildProvenance`) reads back undefined — which is NOT `#f`, so we
    // must NOT treat it as truthy; fall through to the structural arm check.
    if (r?.value !== undefined) return r.value === false ? "no" : "yes";
  }
  // Prune-proof: the taken branch actually ran, so its arm expression is a child invocation.
  // `(if TEST THEN ELSE)` → THEN ran ⇒ "yes", ELSE ran ⇒ "no". Recovers polarity for an operand
  // whose value was pruned (the same field-pluck-off-infer case the wiring gate handles).
  if (headOf(inv) === "if") {
    const parts = listOf(inv.node);
    if (inv.children.some((c) => c.node === parts[2])) return "yes";
    if (parts[3] !== undefined && inv.children.some((c) => c.node === parts[3])) return "no";
  }
  return undefined;
};

/** The readable condition for a branch invocation, or undefined for multi-clause
 *  forms (`cond`/`case`). Rendered as the REALIZED fact for the arm that ran (polarised
 *  by the recovered outcome — `a > b` on the true arm, `a ≤ b` on the false one), with
 *  static operands carrying their runtime values inline. */
const conditionOf = (
  inv: PlainInv,
  valueById: (id: number) => unknown,
  wired: ReadonlySet<string>,
): string | undefined => {
  const head = headOf(inv);
  if (head === "if" || head === "when" || head === "unless") {
    const test = listOf(inv.node)[1]; // (if TEST then else) → slot 1
    if (test === undefined) return undefined;
    // A WIRED operand's value arrives on a data wire (from the infer it derived from),
    // so the pill shows just its NAME — the value lives at the wire's source. A STATIC
    // (literal-rooted) operand has no wire, so its value is annotated inline.
    const ann: Annotate = (sym) => {
      if (wired.has(sym)) return "";
      const r = resolveRaw(inv, sym, valueById);
      return r === undefined ? "" : fmtVal(r.value);
    };
    // The realized condition is the test under its taken polarity: an undetermined
    // outcome falls back to the as-written (true) form.
    const outcome = outcomeOf(inv, test, valueById);
    return readablePolar(test, outcome !== "no", ann);
  }
  return undefined;
};

/** The provenance set carried by a raw scheme VALUE — non-empty when it's an AValue
 *  stamped by a producer (a field-pluck off an infer, an infer result). Read
 *  structurally to avoid importing AValue. Exported so `TraceRegionFold` can compute a
 *  branch's "dynamic-capable" predicate with the EXACT same logic `regionsAt` uses. */
export const valueProvenance = (v: unknown): Iterable<number> => {
  const p = (v as { provenance?: unknown } | null | undefined)?.provenance;
  return p != null && typeof (p as Iterable<number>)[Symbol.iterator] === "function" ? (p as Iterable<number>) : [];
};

/** Symbols appearing in a test expression (operator heads included — harmless). */
const symbolsIn = (node: unknown): string[] => {
  const s = symOf(node);
  if (s !== undefined) return [s];
  const p = asPair(node);
  if (!p) return [];
  return listOf(node).flatMap(symbolsIn);
};

/** The decision's DATA-input PRODUCERS: the invocations that computed the let-bound
 *  operands its test reads. A bare symbol `pair` or a compound `(> score 0.6)` both
 *  resolve through the enclosing lets to whichever invocation produced each operand.
 *  Every operand is, by construction, either literal-rooted (STATIC — no dataflow)
 *  or derived from an inference (then it ALWAYS carries that inference in TRANSITIVE
 *  provenance). So the caller follows provenance back to the inference origin(s)
 *  and wires from THOSE — a plumbing producer that derived from inferences still wires;
 *  a literal-only one wires nothing. */
export const decisionInputProducers = (
  inv: PlainInv,
  valueById: (id: number) => unknown,
): { sym: string; producerId: number }[] => {
  const head = headOf(inv);
  if (head !== "if" && head !== "when" && head !== "unless") return [];
  const test = listOf(inv.node)[1];
  if (test === undefined) return [];
  const out: { sym: string; producerId: number }[] = [];
  const seen = new Set<string>();
  for (const sym of symbolsIn(test)) {
    if (seen.has(sym)) continue;
    seen.add(sym);
    const r = resolveRaw(inv, sym, valueById);
    if (r?.producerId !== undefined) out.push({ sym, producerId: r.producerId });
  }
  return out;
};

/** The rosetta heads of a DIRECT, user-written inference call. A provenance point
 *  whose head is one of these is a raw `(infer …)` / `(infer/chat …)`. Any OTHER
 *  provenance point is a `.prompt` proc — now opaque, so its invocation IS the
 *  `(run-x …)` call at the real source location (head = binding `run-x`). */
const DIRECT_INFER_HEADS: ReadonlySet<string> = new Set(["infer", "infer/chat"]);

/** Classify an infer provenance point by its head: direct `(infer/chat …)` → `direct`,
 *  labelled by the rosetta head; a `.prompt` call `(run-x …)` → `prompt`, labelled by
 *  the binding `run-x`. A `.prompt` point mints on the resolver-generated `(infer/run …)`
 *  form (head/scope carry `@dotprompt:<path>`) — project through `userCallSite` first so
 *  label/scope read as the real `(run-x …)` while `id`/`meta`/`value`/`state` stay the
 *  point's own. */
export function leafFor(inv: PlainInv): Extract<Region, { kind: "leaf" }> {
  const site = userCallSite(inv);
  const head = headOf(site);
  return {
    kind: "leaf",
    id: inv.id,
    label: head,
    scope: site.scope,
    nodeKind: DIRECT_INFER_HEADS.has(headOf(inv)) ? "direct" : "prompt",
    meta: inv.metadata,
    value: inv.value,
    state: inv.state,
    error: inv.error,
    cached: inv.cached,
  };
}

/** A non-structural application that recurs on its own ancestor chain — the same
 *  loop-detection `traceToForest` uses. `let`/`if`/`begin` re-enter every iteration,
 *  so they're excluded. */
const hasSelfAncestor = (inv: PlainInv): boolean => {
  for (let p = inv.parent; p; p = p.parent) if (p.node === inv.node) return true;
  return false;
};

// ── shared origin resolution (field-point → producer) ─────────────────────────
/** Resolve a provenance id to its concrete producer origin. Under FORWARD (field-point
 *  mint retired), a `(:field x)` projection forwards the producer's own point rather
 *  than minting a field-point — so a provenance id IS its origin, this is identity.
 *  Kept named so call sites read as "resolve to origin" and localize the place a
 *  future grounded carrier would re-introduce a walk. */
export function resolveOriginVia(id: number): number {
  return id;
}

const EMPTY: ReadonlySet<number> = new Set();

/** ONE point's contribution to the Hasse (transitive-reduction) edge set, ascending id.
 *  `up` = x's in-graph upstream origins (already origin-resolved + ∩ points). Appends
 *  the non-redundant `u→x` edges and records `reach[x]` (x's full ancestor closure).
 *  Ascending id is a valid topological order, so a new point only ADDS edges and
 *  never invalidates an existing one — which is exactly what lets `TraceRegionFold`
 *  call this per new point and keep `edges`/`reach` identical to the from-scratch build.
 *  Returns the edges it appended (the caller pushes them into the shared list). */
export function addPointToHasse(
  x: number,
  up: ReadonlySet<number>,
  reach: Map<number, Set<number>>,
): { edges: RegionEdge[]; closure: Set<number> } {
  const closure = new Set<number>();
  for (const u of up) {
    closure.add(u);
    for (const a of reach.get(u) ?? EMPTY) closure.add(a);
  }
  const out: RegionEdge[] = [];
  for (const u of up) {
    // u→x is redundant iff another upstream w of x already reaches u.
    let redundant = false;
    for (const w of up) {
      if (w !== u && (reach.get(w) ?? EMPTY).has(u)) {
        redundant = true;
        break;
      }
    }
    if (!redundant) out.push({ from: u, to: x, kind: "data" });
  }
  reach.set(x, closure);
  return { edges: out, closure };
}

/** x's in-graph upstream origin set: ⋃ over x's children of child.provenance, origin-
 *  resolved (identity under forward) and kept iff it's a point and not x. */
export function upstreamOfPoint(x: PlainInv, pointIds: ReadonlySet<number>): Set<number> {
  const up = new Set<number>();
  for (const c of x.children)
    for (const p of c.provenance) {
      const o = resolveOriginVia(p);
      if (o !== x.id && pointIds.has(o)) up.add(o);
    }
  return up;
}

// ── the region walk (regionsAt) — shared by from-scratch + incremental ─────────

/** A `route` token for a branch invocation — the identity of its LAST evaluated child's
 *  node (the taken arm), or the void sentinel when it had no sub-invocation. Equal
 *  routes ⇒ the branch went the same way; ≥2 distinct routes at one scope ⇒ a live
 *  branch (it decided differently at least once). */
const BRANCH_VOID: object = Symbol("branch-route-void") as unknown as object;
export const routeOf = (inv: PlainInv): object => (inv.children.length > 0 ? inv.children.at(-1)!.node : BRANCH_VOID);

/** An OPTIONAL per-iteration memo hook (the incremental seam). `regionsAt` calls this
 *  at each iteration-producing site so `TraceRegionFold` can REUSE a frozen iteration's
 *  already-built `Region[]` instead of re-walking — while from-scratch leaves it unset.
 *  `freezable` = true iff the iteration's content can no longer change with trace growth
 *  (a loop iteration whose successor exists; a resolved map application); the hook may
 *  only cache when `freezable`. MUST be transparent — return a value deep-equal to
 *  `compute()` — so parity holds whether it caches or not. */
type IterationCache = (key: number, freezable: boolean, compute: () => Region[]) => Region[];

/** Everything `regionsAt` needs that is NOT the invocation itself — global signal sets
 *  + value/point accessors + per-walk collectors. Built fresh per from-scratch build;
 *  rebuilt (with cached membership) per incremental `current()`. */
export interface RegionWalkCtx {
  loopBodies: ReadonlySet<object>;
  liveBranchScopes: ReadonlySet<string>;
  pointIds: ReadonlySet<number>;
  valueById: (id: number) => unknown;
  /** Live value of an invocation id (for decision-operand provenance) — the snapshot
   *  drops plumbing values, so the decision path reads the live trace. `SchemeValue |
   *  undefined`, not `unknown`: RAW scheme-side `Invocation.value` (trace.ts).
   *  Decision peels use `toJS` once on that raw value; never soft-peel plain JS.
   *  a cast. */
  liveValueById: (id: number) => SchemeValue | undefined;
  /** Live INVOCATION provenance of an id — snapshot zeroes plumbing provenance, pruner
   *  frees most of it mid-run, but a `filter`'s direct children are prune-exempt (see
   *  `EvalTrace#pruneChildProvenance`): each per-element pred application's set names the
   *  inference origins that element's selection tested. The filter-predicate decision reads it. */
  liveProvenanceById: (id: number) => Iterable<number>;
  /** The provenance POINTS in an invocation's live subtree (topmost — not descending
   *  past a point). A field-pluck off an infer (`(:big (car (infer …)))`) carries its
   *  provenance on the stamped pluck VALUE, but that value is GC-pruned as non-point
   *  plumbing before the region build runs (`Trace#pruneChildProvenance`). The provenance
   *  survives STRUCTURALLY — the infer point lives in the pluck invocation's subtree, and
   *  points are never pruned — so the decision gate recovers it by walking here. */
  livePointsUnder: (id: number) => readonly number[];
  /** The producer POINTS a NAME was bound to within an invocation's live subtree — the
   *  auto-bindings sidecar (`withAutoBindings`) scoped to that subtree. The per-element
   *  pairing key for narrowing verdicts: a filter pred's PARAMETER binding inside
   *  pred-application j carries exactly element j's origins (the predicate OUTCOME's
   *  provenance would smear in compared-against elements — a Pareto test folds the whole
   *  pool). Absent when the trace runs without the sidecar. */
  boundPointsOf?: (id: number, name: string) => readonly number[];
  /** Collectors filled during the walk (knot→arm control wires, knot→operand data
   *  wires) — read after the walk to append the decision edges. */
  knotArm: { knot: number; arm: number }[];
  knotInputs: { knot: number; from: number }[];
  /** Incremental memo seam (unset for from-scratch). See {@link IterationCache}. */
  iterationCache?: IterationCache;
  /** OPTIONAL cached loop spine (the incremental win for TCO loops). Given a loop ENTRY
   *  invocation, returns its full ordered list of body-entries — so the walk does NOT
   *  re-DFS the whole recursion via `nextSameBody` each `current()` (which is O(N) — the
   *  per-iteration subtree contains the next entry deep inside, so re-finding it each pass
   *  re-scans every iteration). `TraceRegionFold` maintains this in O(Δ); from-scratch
   *  leaves it unset and walks `nextSameBody` directly. The returned spine MUST be the
   *  SAME chain `nextSameBody` would produce (entry, nextSameBody(entry), …) for parity. */
  loopSpine?: (entry: PlainInv) => PlainInv[];
}

const hasSameBodyAncestor = (inv: PlainInv): boolean => {
  for (let p = inv.parent; p; p = p.parent) if (p.node === inv.node) return true;
  return false;
};

/** The SAME loop's next iteration: shallowest descendant re-entering THIS body node.
 *  Early-return DFS, so summed over a spine the walk is O(N), not O(N²). */
export const nextSameBody = (entry: PlainInv): PlainInv | undefined => {
  const find = (n: PlainInv): PlainInv | undefined => {
    for (const c of n.children) {
      if (c.node === entry.node) return c;
      const deep = find(c);
      if (deep) return deep;
    }
    return undefined;
  };
  return find(entry);
};

/** The full body-entry spine of a loop, from `entry` via `nextSameBody`. The from-scratch
 *  enumeration (the incremental path supplies an equal cached list via `ctx.loopSpine`). */
export const walkSpine = (entry: PlainInv): PlainInv[] => {
  const out: PlainInv[] = [];
  for (let body: PlainInv | undefined = entry; body; body = nextSameBody(body)) out.push(body);
  return out;
};

const lastRegionId = (rs: Region[]): number | undefined => (rs.length > 0 ? rs.at(-1)!.id : undefined);

/**
 * Scheme truth of a **live** boxed value (only `#f` is false). Absent / not-yet-settled
 * is not a verdict (`undefined` — not soft-peeled plain JS). One membrane exit.
 */
function schemeTruth(raw: SchemeValue | undefined): unknown {
  return raw === undefined ? undefined : toJS(raw);
}

/**
 * The decision marker for a provenance-gated `filter` (see the fanout arm). Returns
 * `undefined` unless BOTH gates pass:
 *  - LIVE: this invocation's settled per-element predicate outcomes are MIXED (some kept,
 *    some dropped). One-way filtering is plumbing, exactly like a one-way branch.
 *  - DYNAMIC: the filtered collection's elements trace to inference points. Read DEEP off
 *    the non-application args' live values (`deepProvenance` — a packed list's origins live
 *    on its elements; the container itself is provenance-transparent), so a pool of
 *    candidate records wires from the evaluations that scored them.
 * Side effect on success: pushes the origin points into `ctx.knotInputs` (the data-ins of
 * the selection). Reads LIVE values throughout — the snapshot drops plumbing values — so
 * neither `snapshotTrace` nor the fold's mirrors need new fields (fold parity for free:
 * this runs inside the shared `regionsAt`).
 */
function filterDecision(inv: PlainInv, applChildren: PlainInv[], ctx: RegionWalkCtx): Region | undefined {
  let kept = 0;
  let dropped = 0;
  for (const c of applChildren) {
    if (c.state === "running") continue;
    if (schemeTruth(ctx.liveValueById(c.id)) === false) dropped++;
    else kept++;
  }
  if (kept === 0 || dropped === 0) return undefined; // one-way selection — invisible plumbing
  const origins = new Set<number>();
  const resolveInto = (ps: Iterable<number>, into: Set<number>): void => {
    for (const p of ps) {
      const o = resolveOriginVia(p);
      if (ctx.pointIds.has(o)) into.add(o);
    }
  };
  const addOrigins = (ps: Iterable<number>): void => resolveInto(ps, origins);
  // Per-element: pred invocation provenance (prune-exempt for filter children).
  for (const c of applChildren) addOrigins(ctx.liveProvenanceById(c.id));
  // Fallback: eval'd-once args' values, DEEP — covers pred whose comparisons happened
  // outside this subtree.
  if (origins.size === 0)
    for (const arg of inv.children) {
      if (arg.children.length > 0) continue;
      addOrigins(deepProvenance(ctx.liveValueById(arg.id)));
    }
  if (origins.size === 0) return undefined; // static — degenerate, dissolve
  // PER-ELEMENT VERDICTS. Pairing key = ELEMENT's OWN origins (predicate OUTCOME's
  // provenance is wrong — Pareto test folds compared-AGAINST elements). Two reads:
  //  1. BINDING (primary): pred param's auto-binding within appl j's subtree.
  //  2. POSITIONAL (fallback): eval'd-once collection arg aligning with applications.
  // Neither available ⇒ no verdicts; the aggregate `condition` stays honest.
  const param = ctx.boundPointsOf ? predParamOf(inv.node) : undefined;
  const collection = inv.children
    .filter((arg) => arg.children.length === 0)
    .map((arg) => listElements(ctx.liveValueById(arg.id)))
    .find((els) => els.length >= applChildren.length);
  const verdicts =
    param !== undefined || collection
      ? applChildren.flatMap((c, j) => {
          if (c.state === "running") return [];
          const elementOrigins = new Set<number>();
          if (param !== undefined) resolveInto(ctx.boundPointsOf!(c.id, param), elementOrigins);
          if (elementOrigins.size === 0 && collection) resolveInto(deepProvenance(collection[j]), elementOrigins);
          return [{ kept: schemeTruth(ctx.liveValueById(c.id)) !== false, origins: [...elementOrigins] }];
        })
      : undefined;
  const id = applChildren[0]!.id; // a pred application never becomes a region itself — free id
  for (const from of origins) ctx.knotInputs.push({ knot: id, from });
  return {
    kind: "decision",
    id,
    label: "filter",
    scope: scopeId(inv.node),
    condition: `kept ${kept} of ${kept + dropped}`,
    ...(verdicts ? { verdicts } : {}),
  };
}

/** The elements of a proper Scheme list, in order — `[]` for a non-list value. */
function listElements(v: unknown): unknown[] {
  const out: unknown[] = [];
  for (let cur = v; cur instanceof APair; cur = cur.cdr) out.push(cur.car);
  return out;
}

/** The ARGUMENT sub-ASTs of a call node `(head arg…)` — the cdr chain's cars. Used to
 *  tell an evaluated argument's invocation (its node IS an argument position) from an
 *  element application's (its node is the lambda/body). */
function astArgs(node: unknown): unknown[] {
  if (!(node instanceof APair)) return [];
  return listElements(node.cdr);
}

/** The pred lambda's FIRST parameter name off a `(filter (lambda (x) …) coll)` AST — the
 *  name whose per-application binding pairs each verdict to its element. A named or
 *  otherwise opaque pred yields undefined (verdicts then rely on the positional read). */
function predParamOf(node: unknown): string | undefined {
  if (!(node instanceof APair) || !(node.cdr instanceof APair)) return undefined;
  const pred = node.cdr.car;
  if (!(pred instanceof APair)) return undefined;
  const head = pred.car as { __name__?: unknown } | null;
  if (head === null || typeof head !== "object" || head.__name__ !== "lambda") return undefined;
  const params = pred.cdr instanceof APair ? pred.cdr.car : undefined;
  const first = params instanceof APair ? (params.car as { __name__?: unknown } | null) : undefined;
  return first !== null && first !== undefined && typeof first === "object" && typeof first.__name__ === "string"
    ? first.__name__
    : undefined;
}

/**
 * Walk one invocation into its meaningful regions — the SINGLE source of region-tree
 * truth, shared by `buildRegions` (from-scratch) and `TraceRegionFold.current()`
 * (incremental). Pure given `ctx` + the invocation subtree; the only side effects are
 * appends to `ctx.knotArm` / `ctx.knotInputs` (the decision wires, read after the walk).
 */
export function regionsAt(inv: PlainInv, ctx: RegionWalkCtx): Region[] {
  if (inv.isProvenancePoint) {
    // A point is an ATOMIC card — but its ARGUMENT subtree can hold OTHER points
    // (a nested `(infer …)`) or a live branch. Those carry the very provenance that
    // wires INTO this consumer, so HOIST them as PRECEDING siblings: the producers a
    // card depends on draw before it, the card stays atomic, every wire lands on a
    // rendered node. (The point's OWN value still flows downstream via its leaf id.)
    const hoisted = inv.children.flatMap((c) => regionsAt(c, ctx));
    return [...hoisted, leafFor(inv)];
  }

  if (ctx.loopBodies.has(inv.node as object)) {
    // A re-entrant body (an ancestor is the same loop's body) is the next
    // iteration; the loop ENTRY's spine walk owns it. Reached via flatten →
    // CUT, so the next iteration's body doesn't leak into this one.
    if (hasSameBodyAncestor(inv)) return [];

    // Loop ENTRY → one fanout container; iterations = the spine of body entries,
    // each cut at the next. The recursive call's arg eval (the `reflect` that
    // seeds the next iteration) lives OUTSIDE the next body, so it stays in THIS
    // iteration — correct: this iteration computed it. Sequential iters reuse
    // `fanout` (Z-tabs) by design.
    const iterations: Region[][] = [];
    let incoming = 0;
    // The spine of body-entries — from the cached list (incremental) or by walking
    // `nextSameBody` (from-scratch). IDENTICAL chains either way (parity contract).
    const spine = ctx.loopSpine ? ctx.loopSpine(inv) : walkSpine(inv);
    for (let i = 0; i < spine.length; i++) {
      const here = spine[i]!;
      // A loop iteration is FROZEN once its successor body-entry exists: the `if` has
      // definitively routed to the recursive call and this iteration's content (work +
      // the recursive call's arg-eval that surfaces here) can no longer change. The
      // LAST entry (no successor yet) is the growth frontier — never cached.
      const frozen = i < spine.length - 1;
      const regions = ctx.iterationCache
        ? ctx.iterationCache(here.id, frozen, () => here.children.flatMap((c) => regionsAt(c, ctx)))
        : here.children.flatMap((c) => regionsAt(c, ctx));
      // The TERMINAL spine entry with an EMPTY body is the loop's EXIT — the base case
      // returning the value. Not an "incoming iteration that got pruned": counting it
      // made a 4-round loop read `4 ← ×5`, implying a fifth round. A MID-spine empty
      // pass IS a real skip/discard round and stays counted.
      if (regions.length > 0) iterations.push(regions);
      if (regions.length > 0 || frozen) incoming += 1;
    }
    // Degenerate container (no inference anywhere in the loop) → drop it. The
    // cleanup is INLINE: an empty fanout never materializes, so an outer frame
    // whose only child was this loop also flattens to nothing and collapses too.
    if (iterations.length === 0) return [];
    // Label by the recursive fn name (the call head, e.g. `loop`), not the
    // body form (`let`).
    const label = inv.parent ? headOf(inv.parent) : headOf(inv);
    return [
      {
        kind: "fanout",
        id: inv.id,
        scope: scopeId(inv.node),
        stages: [{ label, id: inv.id }],
        iterations,
        incoming,
        loop: true,
        inputs: [],
        outputs: [],
      },
    ];
  }

  if (FANOUT.has(headOf(inv))) {
    // Iterations = the application children (those carrying a body). The eval'd-once args
    // (lambda, collection) are excluded TWO ways: most have no children, but an INLINE
    // collection expression (`(filter pred (map list …))`) does — its subtree made gepa's
    // failing-filter read `kept 6 of 11` over a 10-element collection (the 11th "element"
    // was the collection itself, its truthy list value counted kept). An evaluated
    // ARGUMENT is recognized by its node being one of the form's own argument ASTs;
    // element applications' nodes are the lambda/body, never an argument position.
    const argNodes = new Set(astArgs(inv.node));
    const applChildren = inv.children.filter((c) => c.children.length > 0 && !argNodes.has(c.node));
    // An iteration that flattens to nothing meaningful is dropped; `incoming`
    // keeps the RAW count so the banner can say "10 incoming, 5 mattered". A map
    // application is FROZEN once it has resolved (its subtree no longer grows —
    // map iterations are independent, unlike a loop spine), so the cache may reuse
    // it; a still-running application is the frontier and is recomputed each tick.
    const iterations = applChildren
      .map((c) =>
        ctx.iterationCache
          ? ctx.iterationCache(c.id, c.state !== "running", () => regionsAt(c, ctx))
          : regionsAt(c, ctx),
      )
      .filter((r) => r.length > 0);
    // FILTER-PREDICATE DECISION. A `filter` whose per-element predicate outcomes are
    // provenance-gated is a SELECTION the reader can act on — GEPA's `frontier` keeps or
    // drops candidates by their inferred scores — yet its predicate is pure code: no `if`
    // form, so the branch arm never fires, and (when the pred bodies carry no points) the
    // whole fanout flattens away. Emit ONE decision marker per such filter, gated exactly
    // like a branch: LIVE = both kept and dropped occurred in THIS invocation (a one-way
    // filter is invisible plumbing, as ever), DYNAMIC = the filtered collection's elements
    // trace to inference points (deep read — the container is provenance-transparent). Its
    // data-ins wire from those origin points and its control arm gates the surviving fanout,
    // so the render frames "kept k of n → [the kept work]". The marker's id is the first
    // element application's (the fanout keeps `inv.id`; a pred application is never itself a region).
    const decision = headOf(inv) === "filter" ? filterDecision(inv, applChildren, ctx) : undefined;
    // An INLINE argument expression carries real work — `(map car (filter …))` computes
    // its collection in an argument position, and that subtree holds the filter's own
    // decision (or even inference). It walks as PRECEDING SIBLINGS (the collection was
    // computed before the fan), never as an element: counting it as one is exactly the
    // phantom-11th bug this split fixes.
    const argRegions = inv.children
      .filter((c) => c.children.length > 0 && argNodes.has(c.node))
      .flatMap((c) => regionsAt(c, ctx));
    // Degenerate container (mapped/filtered over non-inference data) → drop it; a live
    // gated selection still shows its decision (pure-pred filters have empty bodies).
    if (iterations.length === 0) return decision ? [...argRegions, decision] : argRegions;
    if (decision) ctx.knotArm.push({ knot: decision.id, arm: inv.id });
    const fanout: Region = {
      kind: "fanout",
      id: inv.id,
      scope: scopeId(inv.node),
      stages: [{ label: headOf(inv), id: inv.id }],
      iterations,
      incoming: applChildren.length,
      inputs: [],
      outputs: [],
    };
    return decision ? [...argRegions, decision, fanout] : [...argRegions, fanout];
  }

  // A LIVE branch (decided ≥2 ways trace-wide) does NOT box — boxing every `if`
  // makes branches dominate and shatters a TCO loop whose body IS an `if` into a
  // nested tower of boxes (the loop never peels). Instead drop a `<>` DECISION
  // MARKER at the site and flatten through to the arm it took: the divergence is
  // already carried by the enclosing autonomous region's iteration picker, so the
  // marker just says "here's where the decision was made". An arm with no rendered
  // content this time (a bare-atom route) yields nothing → no marker either.
  if (BRANCH_FORMS.has(headOf(inv)) && ctx.liveBranchScopes.has(scopeId(inv.node))) {
    const inner = inv.children.flatMap((c) => regionsAt(c, ctx));
    if (inner.length === 0) return [];
    // Data-in: each operand traces (through plumbing) to the inference(s) that
    // produced it. Follow the operand back to its inference origin(s) and wire those
    // into the decision — a literal-rooted operand resolves to none (static, nothing
    // to draw). The provenance rides on the operand's VALUE (an AValue), not on its
    // producer invocation: a field-pluck like `(:verdict (car (infer …)))` leaves the
    // `:verdict` invocation's own provenance empty but stamps the plucked AValue with
    // the field point that resolves back to the infer. Read it live (`liveValueById`);
    // the snapshot drops plumbing values, but the live trace keeps them.
    //
    // An operand that resolves to ≥1 inference origin is WIRED: its value arrives on a
    // data wire, so the pill shows only its name (the value lives at the wire source).
    const wired = new Set<string>();
    const inputs: number[] = [];
    for (const { sym, producerId } of decisionInputProducers(inv, ctx.valueById)) {
      let origins = ctx.pointIds.has(producerId)
        ? [producerId]
        : [...valueProvenance(ctx.liveValueById(producerId))]
            .map((p) => resolveOriginVia(p))
            .filter((o) => ctx.pointIds.has(o));
      // Pruned pluck value (`(:big (car (infer …)))`): its stamped provenance was GC'd, but the
      // infer point survives in the live subtree — recover the origins structurally.
      if (origins.length === 0) origins = [...ctx.livePointsUnder(producerId)];
      if (origins.length === 0) continue;
      wired.add(sym);
      inputs.push(...origins);
    }
    // DYNAMIC-PROVENANCE GATE: a decision renders only when its outcome is
    // genuinely INDETERMINATE from the trace's dynamic data — i.e. at least one tested
    // operand traces back to an inference. A purely static test (`(if #t …)`, a
    // literal-only comparison `{10 + 20 < 50}`, a pool-shape guard like `pair`) is
    // degenerate: its result was fixed before the run, so it carries no decision the
    // reader can act on. Dissolve it — flatten to the gated work, no marker, no control
    // arm. We could only decide it because nothing inferred fed it; that's the tell.
    if (wired.size === 0) return inner;
    const arm = lastRegionId(inner);
    if (arm !== undefined) ctx.knotArm.push({ knot: inv.id, arm });
    for (const from of inputs) ctx.knotInputs.push({ knot: inv.id, from });
    return [
      {
        kind: "decision",
        id: inv.id,
        label: headOf(inv),
        scope: scopeId(inv.node),
        condition: conditionOf(inv, ctx.valueById, wired),
      },
      ...inner,
    ];
  }

  return inv.children.flatMap((c) => regionsAt(c, ctx)); // plumbing: flatten through
}

// ── field-edge attribution (consumer-field, DERIVED render-only) ───────────────

/** Everything the field-attribution + output + port phases need. */
export interface FinalizeCtx {
  points: PlainInv[];
  pointIds: ReadonlySet<number>;
  reach: Map<number, Set<number>>;
}

/**
 * The PRODUCER-side twin of `attributeFieldEdges`: stamp each data edge with `fromField` —
 * which OUTPUT field of the producer the consumer plucked (`(:verdict (car reactions))` →
 * `fromField:"verdict"`). Pin data reused verbatim from `carrierFieldEdges`, keyed by
 * `${producer}>${consumer}` — exact point-id endpoints region edges carry, so the join is a
 * direct `Map.get`. Pure.
 *
 * Only DATA edges qualify (control/decision/output carry no producer-field pluck). An edge
 * with no carrier entry — whole-value flow, positional plucks (`car`/index), or the
 * auto-bindings flag OFF — passes through unchanged, fully additive. Limitation: the carrier
 * aggregates to `Set<field>` per `(producer,consumer)` and loses which producer field fed
 * which consumer slot, so a producer plucked into two different slots of one consumer
 * over-generates (same fidelity ceiling `statechart.ts` accepts); a true (slot,fromField)-
 * paired carrier is a follow-up.
 */
export function attributeFromFields(edges: RegionEdge[], fromFieldEdges: Map<string, Set<string>>): RegionEdge[] {
  const out: RegionEdge[] = [];
  for (const e of edges) {
    const set = e.kind === "data" ? fromFieldEdges.get(`${e.from}>${e.to}`) : undefined;
    if (!set || set.size === 0) {
      out.push(e);
      continue;
    }
    // `{ ...e }` preserves any consumer-slot `field` already attached — the edge honestly
    // carries BOTH the consumer slot and the producer output row.
    for (const fromField of set) out.push({ ...e, fromField });
  }
  return out;
}

/**
 * Rewrite the base point→point data edges into FIELD-QUALIFIED edges (consumer-field
 * attribution). For a `.prompt` consumer, find which named input the producer flowed
 * into — the sound `inputsProvenance` path (immediate-writer Hasse-reduced per slot +
 * value-presence gate) when available, else a structural VALUE-PRESENCE match over
 * every input slot (same `valuePresent` test, no immediate-writer narrowing — the only
 * path available for a `.prompt` consumer, since the composable `dotprompt/render` →
 * `infer/run` split runs the render under `apply`, which does not thread `EvalContext`
 * and so cannot populate `inputsProvenance`; see `prompt.ts`'s "KNOWN NARROWINGS"). The
 * fallback checks EVERY slot (not just-the-first) so one producer feeding two slots
 * (`:score (list s) :also (list s)`) still emits two field-qualified edges, and a value
 * PACKED INTO A LIST or a field PLUCK both match via the same bidirectional
 * `valuePresent` the sound path uses. Returns the rewritten edge list (the same edges,
 * some now carrying `field`, some split into per-slot copies). Pure given `ctx`;
 * identical for from-scratch + incremental.
 */
export function attributeFieldEdges(edges: RegionEdge[], ctx: FinalizeCtx): RegionEdge[] {
  const { points, pointIds, reach } = ctx;
  const pointById = new Map(points.map((p) => [p.id, p]));
  // Per-consumer, per-slot IMMEDIATE producers. For each slot, resolve its provenance
  // ids to in-graph origins, then drop any origin reachable from another origin in the
  // SAME slot (the global-edge Hasse rule applied within the slot) — what's left is the
  // slot's direct writer(s). Memoized per consumer id; the loop below visits a consumer
  // once per inbound edge.
  const immediateCache = new Map<number, Record<string, Set<number>>>();
  const immediateBySlot = (consumer: number, ip: Record<string, number[]>): Record<string, Set<number>> => {
    const cached = immediateCache.get(consumer);
    if (cached) return cached;
    const out: Record<string, Set<number>> = {};
    for (const [k, ids] of Object.entries(ip)) {
      const origins = new Set<number>();
      for (const id of ids) {
        const o = resolveOriginVia(id);
        if (pointIds.has(o)) origins.add(o);
      }
      const immediate = new Set<number>();
      for (const o of origins) {
        let dominated = false;
        for (const o2 of origins) {
          if (o2 !== o && (reach.get(o2) ?? EMPTY).has(o)) {
            dominated = true;
            break;
          }
        }
        if (!dominated) immediate.add(o);
      }
      out[k] = immediate;
    }
    immediateCache.set(consumer, out);
    return out;
  };
  const asJson = (v: unknown): string | undefined => {
    try {
      return JSON.stringify(v);
    } catch {
      return undefined;
    }
  };
  // VALUE-PRESENCE — the Where-vs-Why gate. `inputsProvenance` carries a slot's
  // influenced-BY provenance, but field-to-field wiring wants value-flowed-FROM: a
  // producer wires into slot k only if its value actually shows up in k's value.
  const unwrap = (v: unknown): unknown =>
    v != null && typeof (v as { valueOf?: () => unknown }).valueOf === "function"
      ? (v as { valueOf: () => unknown }).valueOf()
      : v;
  const valuePresent = (needle: unknown, hay: unknown, depth = 0): boolean => {
    if (depth > 6) return false;
    const n = unwrap(needle);
    const h = unwrap(hay);
    const nj = asJson(n);
    if (nj !== undefined && nj !== "null" && asJson(h) === nj) return true;
    if (Array.isArray(h)) return h.some((e) => valuePresent(n, e, depth + 1));
    if (h && typeof h === "object") return Object.values(h).some((e) => valuePresent(n, e, depth + 1));
    if (typeof h === "string" && typeof n === "string" && n.length > 0) return h.includes(n);
    return false;
  };
  const out: RegionEdge[] = [];
  for (const e of edges) {
    const consumer = pointById.get(e.to);
    const meta = consumer?.metadata as
      | { kind?: string; inputs?: Record<string, unknown>; inputsProvenance?: Record<string, number[]> }
      | undefined;
    if (meta?.kind !== "prompt" || !meta.inputs) {
      out.push(e);
      continue;
    }

    if (meta.inputsProvenance) {
      const producerValue = pointById.get(e.from)?.value;
      const fields = Object.entries(immediateBySlot(e.to, meta.inputsProvenance))
        .filter(
          ([k, origins]) =>
            origins.has(e.from) &&
            // value-flowed-FROM, either direction: the producer embeds into the slot (slot ⊇ producer,
            // e.g. `(list a b)`) OR a MEMBER of the producer is the slot (slot ⊆ producer, a field pluck
            // `(field a "idea")`). Both are "producer's value flows into slot k".
            (valuePresent(producerValue, meta.inputs?.[k]) || valuePresent(meta.inputs?.[k], producerValue)),
        )
        .map(([k]) => k);
      if (fields.length > 0) {
        for (const field of fields) out.push({ ...e, field });
        continue;
      }
    }

    const producer = pointById.get(e.from);
    if (producer?.value === undefined) {
      out.push(e);
      continue;
    }
    // No `inputsProvenance` (the composable render can't attribute per-field origins
    // through `apply`) — fall back to the same VALUE-PRESENCE test the sound path uses,
    // over EVERY slot, so a producer feeding several slots (or embedded/plucked rather
    // than exactly-equal) still emits one field-qualified edge per matching slot.
    const fields = Object.entries(meta.inputs)
      .filter(([, v]) => valuePresent(producer.value, v) || valuePresent(v, producer.value))
      .map(([k]) => k);
    if (fields.length > 0) {
      for (const field of fields) out.push({ ...e, field });
      continue;
    }
    out.push(e);
  }
  return out;
}

/** The OUTPUT_ID sentinel — the program's statement-output terminal node id. */
const OUTPUT_ID = -1;

/** Append the program's STATEMENT-OUTPUT terminal node + its immediate-producer edges,
 *  when there's a graph to terminate and the final top-level form produced a value.
 *  Mutates `roots`/`edges` in place (matching the from-scratch order). */
export function appendOutput(
  roots: Region[],
  edges: RegionEdge[],
  final: PlainInv | undefined,
  ctx: FinalizeCtx,
): void {
  if (!(roots.length > 0 && final?.value !== undefined)) return;
  const origins = new Set<number>();
  for (const p of final.provenance) {
    const o = resolveOriginVia(p);
    if (ctx.pointIds.has(o)) origins.add(o);
  }
  for (const o of origins) {
    const redundant = [...origins].some((w) => w !== o && (ctx.reach.get(w) ?? EMPTY).has(o));
    if (!redundant) edges.push({ from: o, to: OUTPUT_ID, kind: "data" });
  }
  roots.push({ kind: "output", id: OUTPUT_ID, value: final.value, state: final.state });
}

/** Append the decision wires collected during the walk: knot→arm CONTROL edges, then
 *  the deduped operand→knot DATA edges. Mutates `edges` in place (from-scratch order). */
export function appendDecisionEdges(
  edges: RegionEdge[],
  knotArm: { knot: number; arm: number }[],
  knotInputs: { knot: number; from: number }[],
): void {
  for (const { knot, arm } of knotArm) edges.push({ from: knot, to: arm, kind: "control" });
  const seenInput = new Set<string>();
  for (const { knot, from } of knotInputs) {
    const key = `${from}->${knot}`;
    if (seenInput.has(key)) continue;
    seenInput.add(key);
    edges.push({ from, to: knot, kind: "data" });
  }
}

/** Stage 2a — populate each fanout container's boundary ports by pure edge-vs-membership
 *  over the region tree. Mutates the fanout regions' `inputs`/`outputs` in place. */
export function derivePorts(roots: Region[], edges: RegionEdge[]): void {
  const enclosing = new Map<number, number[]>(); // region id → enclosing fanout ids (outer→inner)
  const scopeById = new Map<number, string>(); // leaf/decision id → structural scope-id
  const fanoutById = new Map<number, Extract<Region, { kind: "fanout" }>>();
  const walk = (regions: Region[], ancestors: number[]): void => {
    for (const r of regions) {
      enclosing.set(r.id, ancestors);
      if (r.kind === "leaf" || r.kind === "decision") scopeById.set(r.id, r.scope);
      if (r.kind === "fanout") {
        fanoutById.set(r.id, r);
        const inner = [...ancestors, r.id];
        for (const iter of r.iterations) walk(iter, inner);
      }
    }
  };
  walk(roots, []);

  const inPorts = new Map<number, Map<string, RegionPort>>();
  const outPorts = new Map<number, Map<string, RegionPort>>();
  const addPort = (
    table: Map<number, Map<string, RegionPort>>,
    container: number,
    producer: string,
    field?: string,
  ): void => {
    const ports = table.get(container) ?? table.set(container, new Map()).get(container)!;
    const key = `${producer}|${field ?? ""}`;
    if (!ports.has(key)) ports.set(key, field === undefined ? { producer } : { producer, field });
  };
  for (const e of edges) {
    const producer = scopeById.get(e.from);
    if (producer === undefined) continue; // output terminal etc. — not a structural producer
    const fromAnc = new Set(enclosing.get(e.from));
    const toAnc = new Set(enclosing.get(e.to));
    for (const c of toAnc) if (!fromAnc.has(c)) addPort(inPorts, c, producer, e.field); // crosses IN
    for (const c of fromAnc) if (!toAnc.has(c)) addPort(outPorts, c, producer, e.field); // crosses OUT
  }
  const sortPorts = (ports: Map<string, RegionPort> | undefined): RegionPort[] =>
    [...(ports?.values() ?? [])].sort((a, b) =>
      a.producer === b.producer ? (a.field ?? "").localeCompare(b.field ?? "") : a.producer.localeCompare(b.producer),
    );
  for (const [id, fanout] of fanoutById) {
    fanout.inputs = sortPorts(inPorts.get(id));
    fanout.outputs = sortPorts(outPorts.get(id));
  }
}

/** Union the static + dynamic recursive-function heads / loop-body scopes (the two
 *  readers `traceToForest` uses). Pure over the invocation list; the fold extends the
 *  same sets incrementally. */
function recursionSignals(invocations: PlainInv[]): { recursiveHeads: Set<string>; loopBodies: Set<object> } {
  const recursiveHeads = staticRecursiveHeads(invocations);
  for (const inv of invocations) {
    if (STRUCTURAL_FORMS.has(headOf(inv))) continue;
    if (hasSelfAncestor(inv)) recursiveHeads.add(headOf(inv));
  }
  const loopBodies = staticLoopBodyScopes(invocations);
  for (const inv of invocations) {
    if (inv.parent && hasSelfAncestor(inv) && recursiveHeads.has(headOf(inv.parent))) {
      loopBodies.add(inv.node as object);
    }
  }
  return { recursiveHeads, loopBodies };
}

/** Branch-route liveness: a `(if …)`/`(cond …)`/… scope is LIVE (earns a `<>` marker)
 *  iff it took ≥2 distinct routes across the trace. Returns both the per-scope route
 *  multiset (so the fold can extend it) and the derived live-scope set. */
export function branchLiveness(invocations: PlainInv[]): {
  branchRoutes: Map<string, Set<object>>;
  liveBranchScopes: Set<string>;
} {
  const branchRoutes = new Map<string, Set<object>>();
  for (const inv of invocations) {
    if (!BRANCH_FORMS.has(headOf(inv))) continue;
    const scope = scopeId(inv.node);
    (branchRoutes.get(scope) ?? branchRoutes.set(scope, new Set()).get(scope)!).add(routeOf(inv));
  }
  const liveBranchScopes = new Set<string>();
  for (const [scope, routes] of branchRoutes) {
    if (routes.size >= 2) liveBranchScopes.add(scope);
  }
  return { branchRoutes, liveBranchScopes };
}

/**
 * The from-scratch region build over a (pre-computed) snapshot. `traceToRegions` is
 * exactly `buildRegions(snapshotTrace(trace), trace)`; `TraceRegionFold` reuses the SAME
 * pure helpers above to maintain this output incrementally. Kept structurally identical
 * to the original single-function build so the deep-equal parity test holds.
 */
function buildRegions(snap: PlainTrace, trace: EvalTrace): RegionGraph {
  const points = snap.invocations.filter((i) => i.isProvenancePoint);
  const pointIds = new Set(points.map((p) => p.id));

  // Live-value accessor for decision-operand substitution (memoized; pays the
  // membrane exit only for operands a decision actually references).
  // `Map<number, Invocation>` — `liveById` holds live invocations themselves (every reader
  // wants a DIFFERENT field: `.value`, `.provenance`, `.children`/`.isProvenancePoint`),
  // so the declared type is the real one, not a value-only projection readers cast past.
  // Live values are scheme-side; peel once with `toJS`. Absent → undefined (no soft peel).
  const liveById = new Map<number, Invocation>();
  for (const rec of trace.records.values()) for (const inv of rec.bindings) liveById.set(inv.id, inv);
  const valCache = new Map<number, unknown>();
  const valueById = (id: number): unknown => {
    if (valCache.has(id)) return valCache.get(id);
    const raw = liveById.get(id)?.value;
    const v = raw === undefined ? undefined : toJS(raw);
    valCache.set(id, v);
    return v;
  };
  const liveValueById = (id: number): SchemeValue | undefined => liveById.get(id)?.value;
  const liveProvenanceById = (id: number): Iterable<number> => liveById.get(id)?.provenance ?? [];
  // The topmost provenance points in an invocation's live subtree (do NOT descend past a
  // point — we want the immediate inference origins feeding the operand). Recovers a
  // pluck-off-infer's provenance structurally after `pruneChildProvenance` nulled the
  // stamped value (see `RegionWalkCtx.livePointsUnder`).
  const livePointsUnder = (id: number): number[] => {
    const root = liveById.get(id);
    if (!root) return [];
    const out: number[] = [];
    const stack: Invocation[] = [...root.children];
    while (stack.length > 0) {
      const n = stack.pop()!;
      if (n.isProvenancePoint) {
        if (pointIds.has(n.id)) out.push(n.id);
      } else stack.push(...n.children);
    }
    return out;
  };

  // Edges (Hasse transitive reduction) over the points, in ascending id order.
  const reach = new Map<number, Set<number>>();
  const edges: RegionEdge[] = [];
  for (const x of [...points].sort((a, b) => a.id - b.id)) {
    const up = upstreamOfPoint(x, pointIds);
    const { edges: added } = addPointToHasse(x.id, up, reach);
    edges.push(...added);
  }

  // Recursion + branch-liveness signals.
  const { loopBodies } = recursionSignals(snap.invocations);
  const { liveBranchScopes } = branchLiveness(snap.invocations);

  // The region walk.
  const knotArm: { knot: number; arm: number }[] = [];
  const knotInputs: { knot: number; from: number }[] = [];
  const auto = trace.autoBindings;
  const ctx: RegionWalkCtx = {
    loopBodies,
    liveBranchScopes,
    pointIds,
    valueById,
    liveValueById,
    liveProvenanceById,
    livePointsUnder,
    // The narrowing-verdict pairing key (see RegionWalkCtx.boundPointsOf) — the sidecar
    // scoped to the live invocation's subtree. Sidecar-less traces leave it unset.
    boundPointsOf: auto
      ? (id, name) => {
          const live = liveById.get(id);
          return live ? (scopedBindings(auto, subtreeIds(live), [name])[name] ?? []) : [];
        }
      : undefined,
    knotArm,
    knotInputs,
  };
  const tops = snap.invocations.filter((i) => !i.parent);
  const roots = tops.flatMap((t) => regionsAt(t, ctx));

  // Field attribution rewrites the base edges in place: first the consumer slot (`field`),
  // then the producer output row (`fromField`) reused from the carrier (empty + no-op when the
  // auto-bindings flag is OFF, so this is byte-identical for non-armed traces).
  const finalizeCtx: FinalizeCtx = { points, pointIds, reach };
  const attributed = attributeFromFields(attributeFieldEdges(edges, finalizeCtx), carrierFieldEdges(trace));
  edges.length = 0;
  edges.push(...attributed);

  // Decision wires, then the statement-output terminal.
  appendDecisionEdges(edges, knotArm, knotInputs);
  appendOutput(roots, edges, tops.at(-1), finalizeCtx);

  // Stage 2a — container boundary ports.
  derivePorts(roots, edges);

  return { roots, edges, warnings: [] };
}

export function traceToRegions(trace: EvalTrace): RegionGraph {
  return buildRegions(snapshotTrace(trace), trace);
}
