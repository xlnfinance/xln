/**
 * verdict.ts — the whole-result grounding seal (the production seal walker).
 *
 * `groundingVerdict` answers ONE question about a finished traced run: does EVERY
 * value-position leaf of the result trace back to at least one recorded source
 * point? It is the host-side API of the seal (completion-plan gap 4, V5): a host
 * (manifold post-eval, an MCP result step, a runner-plane harness) calls it AFTER
 * the run, over the same `{ result, trace, source, forms }` bag `buildUneval`
 * (core `provenance/uneval.ts`) consumes — the two compose over one run without
 * reshaping. There is deliberately no in-language `(seal result)` verb yet
 * (deferred until trace-self-access exists — V5).
 *
 * ── THE TRUTH-ORACLE DISCLAIMER (normative — carried verbatim on every report) ──
 * This seal is a lineage-completeness oracle, not a truth oracle: `signable` means
 * every leaf traces to recorded reads — it will sign a provably-traced fabrication
 * from a lying tool. It never means 'true'.
 * ────────────────────────────────────────────────────────────────────────────────
 *
 * WHY PER-LEAF, NEVER THE UNION. `deepProvenance` UNIONS every reachable leaf's
 * provenance, so a partial fabrication — one real read beside one typed literal —
 * reads as grounded at the top level (the union is non-empty) while one of its
 * leaves is a bare literal. The seal therefore walks the value tree itself and
 * grounds each leaf on its OWN `provenance.size` (the per-leaf law core CI pins in
 * `lineage-grounding.test.ts`); the union is structurally incapable of answering
 * this question.
 *
 * WHY A TYPED-LITERAL GATE ON TOP. Arrival's provenance is CAUSAL: a literal
 * returned from an `if` whose condition read a source inherits that read's
 * provenance (control-flow forwarding — correct for the lineage graph), so a
 * model-typed verdict string can arrive GROUNDED. Because the program is data, the
 * gate reads the SOURCE: a string leaf that exactly equals a string literal the
 * program's author typed was authored, not read — it is refused even when its
 * provenance is real. This also closes the grep door: filtering for a hardcoded
 * value and returning the match still equals the source literal.
 *
 * TWO GROUNDING TIERS (V6). The v1 GATE is lineage-grounding (`provenance.size >
 * 0` per leaf). The attestation BRAND (`values/attestation.ts` — drop-on-compute
 * by construction) is REPORTED per leaf as data, and gates only under the opt-in
 * `attestation: "required"` mode: requiring the brand on every leaf would unsign
 * legitimately DERIVED findings (computation drops the brand by design), so the
 * two tiers answer different questions — "does it trace to a read?" (default)
 * versus "is it a source read verbatim, never recomputed?" (required).
 *
 * Behavioral reference: sift-submission's `sealVerdict` (proof-of-concept; its
 * per-leaf walk, laundering gate, and trichotomy are the spec — the code is not).
 * Deliberate divergences from sift are noted inline where they occur.
 */

import { ANil } from "@inhuman.tools/arrival";
import {
  AValue,
  APair,
  AVoid,
  ABool,
  AString,
  AVector,
  ADict,
  ASymbol,
} from "@inhuman.tools/arrival/reflect-internals";
import { isAttested } from "@inhuman.tools/arrival/attestation";

import { buildSlice, writeForm, defineNameOf, lastTopLevelForm, resolveReadIds } from "./analysis.js";
import type { CoreEvalTrace } from "./trace.js";

/** The normative disclaimer — pinned by test, embedded in every report. NEVER weaken:
 *  the one marketing claim this module must forever refuse is "doesn't hallucinate". */
export const TRUTH_ORACLE_DISCLAIMER =
  "This seal is a lineage-completeness oracle, not a truth oracle: `signable` means every leaf " +
  "traces to recorded reads — it will sign a provably-traced fabrication from a lying tool. " +
  "It never means 'true'.";

/** A single gate's status. `n/a` = not reached (a prior gate already failed) or not
 *  enabled (`focus` without a `focusLimit`; `attestation` outside `required` mode). */
export type CheckStatus = "pass" | "fail" | "n/a";

/** Where a verdict leaf CAME FROM — descriptive origin, not a judgment.
 *  - `grounded`   — a substantive value tracing to ≥1 recorded source point.
 *  - `empty-read` — a read RAN but returned an absence (nil / #f / "" / void): the
 *    source had nothing. Not typed by the author — but not a positive finding either.
 *  - `input`      — typed or passed in; no recorded read behind it. */
export type LeafOrigin = "grounded" | "empty-read" | "input";

/** One value-position leaf of the result, told as its origin story. */
export interface VerdictLeaf {
  /** The RAW leaf (boxed value, provenance + attestation brand intact) — kept raw so
   *  a consumer can run its own projections; `display` is the report-safe rendering. */
  value: unknown;
  /** Human/report projection of the leaf (strings quoted, booleans as #t/#f). */
  display: string;
  origin: LeafOrigin;
  /** The resolved source-point ids this leaf traces to — a subset of
   *  `reverseChain.points` by construction (the per-leaf→read join actually holds). */
  reads: number[];
  /** The source VERB names the reads resolve to (e.g. "evidence-read") — what a
   *  caller can ACT on; raw id numbers steer nobody. Deduped, first-seen order. */
  from: string[];
  /** The attestation BRAND (`isAttested`) on this exact box — REPORTED as data in
   *  every mode (V6); it becomes a gate only under `attestation: "required"`. */
  attested: boolean;
  /** The human line for this leaf. */
  status: string;
}

/** The four ordered gates. Order is load-bearing: grounding first (cheapest, names
 *  the fabricated leaves), then the source-text laundering gate, then the opt-in
 *  brand gate, then focus — a later gate is `n/a` once an earlier one fails. */
export interface VerdictChecks {
  grounding: CheckStatus;
  typedLiteral: CheckStatus;
  attestation: CheckStatus;
  focus: CheckStatus;
}

/** The runnable FINDING→READS join: a Scheme slice that re-derives the verdict from
 *  its reads (a verdict that re-runs, not metadata). Same shape as core's `Slice`
 *  surface, terminal appended. */
export interface ReverseChain {
  program: string;
  points: number[];
  scopeIds: string[];
}

/** The seal — trichotomy verdict + gate record + per-leaf report + the re-derivation
 *  certificate. `report` and `disclaimer` BOTH carry the truth-oracle disclaimer:
 *  a consumer that forwards only the prose still forwards the scope of the claim. */
export interface GroundingVerdict {
  /** - `signable`  — every leaf grounded, none source-typed, gates passed.
   *  - `scoped`    — grounded and honest, but broader than `focusLimit` (a survey,
   *    not a focused finding). Never upgrades to `signable` by omission.
   *  - `unsigned`  — a leaf is fabricated/hollow, source-typed, or (required mode)
   *    unattested. Did not sign. */
  verdict: "signable" | "scoped" | "unsigned";
  checks: VerdictChecks;
  leaves: VerdictLeaf[];
  /** The full report line: ontological headline + gate coaching + the disclaimer. */
  report: string;
  /** {@link TRUTH_ORACLE_DISCLAIMER}, structurally present on every verdict. */
  disclaimer: string;
  /** Present iff grounding + typed-literal pass — an unsigned-for-laundering verdict
   *  gets NO certificate (re-running a typed literal's slice would launder it: it
   *  re-derives the typed value, not a fact read from a source). An attestation-mode
   *  refusal KEEPS its chain (deliberate divergence from a blanket "unsigned = no
   *  chain": the derivation is honest — the chain shows exactly which computation
   *  dropped the brand). */
  reverseChain?: ReverseChain;
}

/** Options — field names align with `buildUneval`'s bag (`result`/`trace`/`source`/
 *  `forms`) so one destructuring feeds both. */
export interface GroundingVerdictOptions {
  /** The run's final value as a RAW boxed value (provenance intact — never the
   *  `toJS`-peeled projection; peeling strips the provenance this seal reads). */
  result: unknown;
  /** The finished run's trace (core `EvalTrace` or this package's observable one). */
  trace: CoreEvalTrace;
  /** The program's source text — the typed-literal gate reads it (the program IS data). */
  source: string;
  /** The parsed top-level forms, if the host kept them (same convention as
   *  `buildUneval`): the last form anchors the reverse chain; falls back to the
   *  trace's last top-level form. */
  forms?: readonly unknown[];
  /** Focus gate (explicit opt, generalized from sift's hardwired arg): a grounded
   *  result with more leaves than this degrades to `scoped` — never to `signable`,
   *  never to `unsigned`. Omitted ⇒ the focus gate is off (`n/a`). */
  focusLimit?: number;
  /** Extra atomic-leaf cut (generalized from sift's hardwired "row object = atomic
   *  leaf"): return `true` to treat a value as ONE leaf, grounded as a unit by its
   *  own provenance, instead of descending it. Membrane row objects (`AObject`) are
   *  always atomic — they crossed the membrane as a unit and legitimately carry
   *  empty fields (bulk data, not a hollow claim). */
  leafCut?: (value: unknown) => boolean;
  /** `"reported"` (default): the attestation brand is per-leaf DATA, never a gate.
   *  `"required"`: every leaf must carry the brand — the stronger source-read-only
   *  discipline (a derived value must be re-asserted via `attest`/`s/*` to sign). */
  attestation?: "reported" | "required";
}

// ── The leaf walk ────────────────────────────────────────────────────────────────

/**
 * Collect the value-position LEAVES of a result — the conclusion data — recursing
 * into what the PROGRAM assembled (pair spines by their car elements, vector
 * elements, dict entry values) and stopping at what crossed the membrane as a unit
 * (row objects) or at a caller's `leafCut`. The spine cells and containers are
 * scaffolding; the leaves are the claim. Cycle-guarded.
 *
 * Divergences from the sift reference, both closing laundering holes:
 *   - an IMPROPER tail (`(cons grounded "lie")`) is a leaf — sift's spine loop
 *     silently dropped non-nil tails, so a dotted fabrication rode a grounded car;
 *   - vectors and dicts are descended — arrival results legitimately arrive as
 *     `[…]` / `{…}`, and treating the container as one leaf would ground fabricated
 *     elements by the container's (empty) own provenance. A dict entry still
 *     PENDING (the lazy membrane's promise) is pushed as-is: a pending read is not
 *     a settled finding, so it grounds as `input` — loud, never skipped.
 *
 * A nil/void/#f/"" ELEMENT is pushed as a (hollow) leaf — a read that ran and found
 * nothing is a FAILED read, not a free pass. Only a bare-nil/void RESULT yields
 * zero leaves ("nothing to sign"), matching the reference.
 */
export function verdictLeafValues(value: unknown, leafCut?: (value: unknown) => boolean): unknown[] {
  const out: unknown[] = [];
  const seen = new Set<unknown>();
  const element = (el: unknown): void => {
    if (leafCut?.(el) === true) {
      out.push(el);
      return;
    }
    if (el instanceof APair) {
      spine(el);
      return;
    }
    if (el instanceof AVector) {
      if (seen.has(el)) return;
      seen.add(el);
      for (const item of el.__vector__) element(item);
      return;
    }
    if (el instanceof ADict) {
      if (seen.has(el)) return;
      seen.add(el);
      for (const key of el.keys()) element(el.get(key));
      return;
    }
    out.push(el); // scalar | row object | hollow element | broken read → atomic leaf
  };
  const spine = (pair: unknown): void => {
    let node: unknown = pair;
    while (node instanceof APair) {
      if (seen.has(node)) return;
      seen.add(node);
      element(node.car);
      node = node.cdr;
    }
    // A proper list ends in nil (structural, not data); an improper tail IS data.
    if (!(node instanceof ANil)) element(node);
  };
  if (value instanceof ANil || value instanceof AVoid) return out; // bare-absence result: zero leaves
  element(value);
  return out;
}

// ── Grounding semantics ──────────────────────────────────────────────────────────

/** A HOLLOW value asserts nothing: nil (a read that found no row), void (an
 *  unspecified return), #f (a failed comparison / false flag — `[…, #f]` is a failed
 *  check the author approved by reading CODE, not the runtime), and an empty/
 *  whitespace string (a field read that came back "" carries a real read's
 *  provenance yet proves nothing — the observed `[""]`-signs-as-C2 hole). #t is NOT
 *  hollow: a true boolean field positively asserts a state. To assert an absence,
 *  a verdict carries the positive evidence (the inode, the filename), never a bare #f. */
function isHollow(v: unknown): boolean {
  if (v instanceof ANil || v instanceof AVoid) return true;
  if (v instanceof ABool) return v.value === false;
  if (v instanceof AString) return v.__string__.trim() === "";
  return false;
}

/** GROUNDED = a positive (non-hollow) boxed value whose OWN provenance reaches ≥1
 *  source point. A non-AValue (raw JS, a pending promise) is exactly the ungrounded
 *  case: an unstamped value has no recorded read behind it. */
function leafGrounded(v: unknown): boolean {
  return v instanceof AValue && !isHollow(v) && v.provenance.size > 0;
}

function leafOrigin(v: unknown): LeafOrigin {
  if (leafGrounded(v)) return "grounded";
  if (v instanceof AValue && v.provenance.size > 0) return "empty-read"; // ran, found nothing
  return "input"; // typed literal / passed param / broken read — no read behind it
}

/** Report-safe projection of a leaf. Strings quoted (so "" is visible), booleans as
 *  #t/#f; every other boxed value renders via its own display repr. No `toJS`
 *  here — projection must never throw on a value the walk already accepted. */
function displayLeaf(v: unknown): string {
  if (v instanceof AString) return JSON.stringify(v.__string__);
  if (v instanceof ABool) return v.value ? "#t" : "#f";
  if (v instanceof AValue) return String(v);
  if (typeof v === "string") return JSON.stringify(v);
  return String(v);
}

// ── Read-verb resolution ─────────────────────────────────────────────────────────

/** id → head-symbol name of the minting invocation, for every id in `want`. The
 *  head symbol of a read's form ("evidence-read", "socket/netscan") is the verb a
 *  caller can act on. One `invocationLog` pass for the whole verdict. */
function readVerbIndex(trace: CoreEvalTrace, want: ReadonlySet<number>): Map<number, string> {
  const verbs = new Map<number, string>();
  if (want.size === 0) return verbs;
  for (const inv of trace.invocationLog) {
    if (!want.has(inv.id)) continue;
    const head: unknown = inv.node.car;
    if (head instanceof ASymbol && typeof head.__name__ === "string") verbs.set(inv.id, head.__name__);
  }
  return verbs;
}

// ── The typed-literal (laundering) gate ──────────────────────────────────────────

/** Every string literal the program's author TYPED in the source. Scheme strings
 *  are `"…"` with backslash escapes; unescaped so a leaf value compares equal to
 *  its source spelling. */
export function sourceStringLiterals(source: string): Set<string> {
  const out = new Set<string>();
  const re = /"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) out.add(m[1].replaceAll(/\\(.)/g, "$1"));
  return out;
}

/** The leaves whose string content exactly equals a source-typed literal — authored,
 *  not read, regardless of the (causal, control-flow-inherited) provenance they
 *  carry. Row objects are atomic leaves, so a field INSIDE a read row that happens
 *  to match a search literal is untouched — only values the author ASSEMBLED into
 *  the result are checked. */
function typedLiteralLeaves(leaves: readonly unknown[], source: string): string[] {
  const literals = sourceStringLiterals(source);
  if (literals.size === 0) return [];
  const typed: string[] = [];
  for (const leaf of leaves) {
    if (leaf instanceof AString && literals.has(leaf.__string__)) typed.push(leaf.__string__);
  }
  return typed;
}

// ── The seal ─────────────────────────────────────────────────────────────────────

/** The reverse chain: the static backward reference-closure of the run's OUTPUT
 *  form (core `buildSlice` — the same anchor `buildUneval` uses), terminated by the
 *  output itself, so the program re-runs to exactly this finding. */
function reverseChainOf(trace: CoreEvalTrace, forms: readonly unknown[] | undefined): ReverseChain | undefined {
  const outputForm = forms === undefined || forms.length === 0 ? lastTopLevelForm(trace) : forms.at(-1);
  if (outputForm === undefined) return undefined;
  const slice = buildSlice(trace, outputForm);
  const terminal = defineNameOf(outputForm) ?? writeForm(outputForm);
  return { program: `${slice.program}\n${terminal}`.trim(), points: slice.points, scopeIds: slice.scopeIds };
}

function leafStatus(leaf: Pick<VerdictLeaf, "origin" | "from">): string {
  switch (leaf.origin) {
    case "grounded":
      return leaf.from.length > 0 ? `read from ${leaf.from.join(", ")}` : "read from a recorded source";
    case "empty-read":
      return "an empty read — the source ran and returned nothing";
    case "input":
      return "typed or passed in — no recorded read behind it";
  }
}

/** The ontological headline — descriptive, never scary: it tells the caller where
 *  its values came from, and frames the bar as a property of signatures ("a seal
 *  attests to what was READ"), not a reprimand. Ungrounded leaves are NAMED. */
function headlineOf(leaves: readonly VerdictLeaf[]): string {
  if (leaves.length === 0) {
    return "grounding: empty result — nothing was read or assembled, so there is nothing to sign.";
  }
  const grounded = leaves.filter((l) => l.origin === "grounded");
  const empty = leaves.filter((l) => l.origin === "empty-read");
  const input = leaves.filter((l) => l.origin === "input");
  const verbs = [...new Set(grounded.flatMap((l) => l.from))];
  const verbSuffix = verbs.length > 0 ? ` (${verbs.join(", ")})` : "";
  if (empty.length === 0 && input.length === 0) {
    return `grounding: all ${leaves.length} leaves trace to recorded reads${verbSuffix}.`;
  }
  const parts: string[] = [];
  if (grounded.length > 0) parts.push(`${grounded.length} trace to recorded reads${verbSuffix}`);
  if (empty.length > 0) parts.push(`${empty.length} from empty reads (${empty.map((l) => l.display).join(", ")})`);
  if (input.length > 0) parts.push(`${input.length} from input (${input.map((l) => l.display).join(", ")})`);
  return (
    `grounding: ${parts.join("; ")} of ${leaves.length} leaves — a seal attests to what was READ, ` +
    "so it signs only when every leaf traces to a recorded read."
  );
}

/**
 * Compute the grounding seal for one finished traced run — the four gates, in
 * order; see the module doc for the two-tier design and the disclaimer's scope.
 *
 * Gate order: grounding (per-leaf lineage — the v1 gate) → typed-literal
 * (source-text laundering) → attestation (opt-in `required` brand gate) → focus
 * (breadth). The first failing gate names its leaves in `report` and leaves the
 * later gates `n/a`.
 */
export function groundingVerdict(opts: GroundingVerdictOptions): GroundingVerdict {
  const { result, trace, source, forms, focusLimit, leafCut, attestation = "reported" } = opts;

  // The per-leaf walk + per-leaf report (computed once, carried on every outcome).
  const rawLeaves = verdictLeafValues(result, leafCut);
  const allReads = new Set<number>();
  const leafReads = rawLeaves.map((l) => {
    const reads = l instanceof AValue ? resolveReadIds(trace, l.provenance) : [];
    for (const id of reads) allReads.add(id);
    return reads;
  });
  const verbIndex = readVerbIndex(trace, allReads);
  const leaves: VerdictLeaf[] = rawLeaves.map((l, i) => {
    const origin = leafOrigin(l);
    const reads = leafReads[i];
    const from = [...new Set(reads.map((id) => verbIndex.get(id)).filter((n): n is string => n !== undefined))];
    const partial = { value: l, display: displayLeaf(l), origin, reads, from, attested: isAttested(l) };
    return { ...partial, status: leafStatus(partial) };
  });
  const headline = headlineOf(leaves);

  const seal = (
    verdict: GroundingVerdict["verdict"],
    checks: VerdictChecks,
    coaching: string | undefined,
    reverseChain: ReverseChain | undefined,
  ): GroundingVerdict => {
    const prose = coaching === undefined ? headline : `${headline} ${coaching}`;
    return {
      verdict,
      checks,
      leaves,
      report: `${prose}\n${TRUTH_ORACLE_DISCLAIMER}`,
      disclaimer: TRUTH_ORACLE_DISCLAIMER,
      ...(reverseChain === undefined ? {} : { reverseChain }),
    };
  };

  // Gate 1 — grounding: every leaf traces to ≥1 source point (and there IS a leaf).
  if (leaves.length === 0 || leaves.some((l) => l.origin !== "grounded")) {
    return seal(
      "unsigned",
      { grounding: "fail", typedLiteral: "n/a", attestation: "n/a", focus: "n/a" },
      undefined, // the headline already names the ungrounded leaves
      undefined, // no chain: an ungrounded result has no honest derivation to show
    );
  }

  // Gate 2 — typed-literal laundering: a leaf that equals a source-typed string was
  // authored, not read (causal provenance grounds it; the source text convicts it).
  // NO reverse chain: a re-derivation certificate over a typed verdict would launder
  // it — the slice re-runs to the typed literal, not to a fact read from a source.
  const typed = typedLiteralLeaves(rawLeaves, source);
  if (typed.length > 0) {
    return seal(
      "unsigned",
      { grounding: "pass", typedLiteral: "fail", attestation: "n/a", focus: "n/a" },
      `laundering gate — ${typed.length} value(s) equal a literal typed in the program source ` +
        `(${typed.map((t) => JSON.stringify(t)).join(", ")}); a sealed value must be READ from a ` +
        "source (e.g. (:field row)), never typed or grepped-for. Derive it from the source value.",
      undefined,
    );
  }

  // Grounded AND read: the finding is honestly re-derivable — build the certificate
  // once; every remaining outcome (signable, scoped, required-mode refusal) keeps it.
  const reverseChain = reverseChainOf(trace, forms);

  // Gate 3 — attestation brand, opt-in (V6). Reported mode never gates ("n/a"): the
  // brand drops on compute BY DESIGN, so requiring it by default would unsign every
  // legitimately derived finding. Required mode is the source-read-only discipline.
  if (attestation === "required") {
    const unattested = leaves.filter((l) => !l.attested);
    if (unattested.length > 0) {
      return seal(
        "unsigned",
        { grounding: "pass", typedLiteral: "pass", attestation: "fail", focus: "n/a" },
        `attestation gate (required mode) — ${unattested.length} leaf/leaves carry no attestation ` +
          `brand (${unattested.map((l) => l.display).join(", ")}). The brand drops on compute by ` +
          "design: a derived value is lineage-grounded but not a verbatim source read. Re-assert " +
          "it (attest / an s/* validator) or seal in the default reported mode.",
        reverseChain,
      );
    }
  }

  // Gate 4 — focus (explicit opt): grounded-but-broad degrades to `scoped`, never up.
  const attestationCheck: CheckStatus = attestation === "required" ? "pass" : "n/a";
  if (focusLimit !== undefined && leaves.length > focusLimit) {
    return seal(
      "scoped",
      { grounding: "pass", typedLiteral: "pass", attestation: attestationCheck, focus: "fail" },
      `This is a SURVEY — a grounded whole table (${leaves.length} leaves > focus limit ` +
        `${focusLimit}). Surveying is a legitimate lane for mapping the data, not a failure. To ` +
        "SIGN a finding, narrow to the row(s) that prove ONE claim and return only their few values.",
      reverseChain,
    );
  }

  return seal(
    "signable",
    {
      grounding: "pass",
      typedLiteral: "pass",
      attestation: attestationCheck,
      focus: focusLimit === undefined ? "n/a" : "pass",
    },
    undefined,
    reverseChain,
  );
}
