// handle-provenance.ts — the why/where/how/dag trichotomy+ (and the forward `blast`) over a ResultHandle.
//
// They project ONE `buildSlice(trace, outputNode)` / `traceToFlowGraph(trace)` — the
// Buneman/Green–Tannen provenance classification. They are ASYNC because the trace is the TELEOLOGICAL
// view, built lazily by a replay-bound re-run on first ask (`handle.teleological()`). If that re-run
// is too large to trace, `teleological()` throws a "provenance unavailable" door — the handle's VALUE
// is unaffected, so discovery keeps operating on the data.
//
// why/where/how/dag all answer BACKWARD ("why is this value what it is"); `blast` is the causal
// FORWARD complement ("what re-fires if I change this node") — the question an EDITING agent asks.
//
// `circuit`/`grounded?`/`attest` (T6a) are a THIRD question — "can this value be TRUSTED", not
// "where did it come from". Per the staging law (soundness is never staged, only coverage is),
// they ship their FINAL contract now: `grounded?`/`attest` always answer `not-attestable`, PER LEAF,
// until the attestation machinery (J1's static leg, J2's probe leg) lands. `circuit` (T6b/#23) is
// LIVE when the handle carries a host-injected `capabilities.circuitProvider` (mcp-worker's
// `discovery-run.ts`, which already depends on both this analysis plane and the compiler — see
// `circuitOf`'s doc) — and still the same architectural door otherwise. `grounded?`/`attest`'s
// per-leaf walk (#15) reads the host-injected `capabilities.boxedValue` (the RAW pre-peel AValue)
// when present, so a boxed container enumerates its real leaves instead of one atomic blob — the
// verdict is per-VALUE-POSITION-LEAF (arrival-provenance's own `groundingVerdict` leaf walk), never
// rolled up into one whole-result scalar — a mixed result (one grounded leaf beside one fabricated
// one, e.g. `(cons (number->string (:v e)) "FABRICATED")`) must attest and refuse each leaf
// INDEPENDENTLY. Each leaf carries its own trace-based ADVISORY, explicitly captioned as
// approximate, never a positive verdict — enumeration coverage improves with `boxedValue`, the
// verdict itself never does. Both verbs call `handle.attested()` first and fall back
// to the per-leaf advisory only on its (today: guaranteed) throw, so a later wave landing
// `attested()` for real flips them live without touching this fail-closed text.
//
// BC-4 — `:at` (field-granular-access.md §5): a keyword REFINEMENT of `circuit`/`grounded?`/
// `attest`, never a new verb. `:at (segments…)` narrows the question from "the whole value/circuit"
// to "one field" — resolved host-side (mcp-worker's discovery-run.ts, via arrival-mercury's
// `fieldProv`, which this analysis plane does not import) through the SAME host-injection seam
// `circuitProvider`/`attestProvider` use:
// `circuitProvider` now takes an optional `path`, and a NEW `attestFieldProvider` capability seals
// exactly one field. `parseFieldPathArg`/`renderFieldPath` are the shared wire-encode/decode this
// module and its callers (mcp-worker's REFLECT_VERBS dispatch) both use, so the sugar rule (a bare
// string/number is a 1-segment path) is defined exactly once.

import { buildSlice, flowForwardCone, traceToFlowGraph } from "../analysis.js";
import { groundingVerdict, verdictLeafValues } from "../verdict.js";

import type { AttestedField, AttestedLeaf, AttestedLeafVerdict, FieldPath, ResultHandle } from "./result-handle.js";

/**
 * Parse the wire-safe `:at` argument carried as one extra string on the existing
 * `...rest: string[]` pipe (`REFLECT_VERBS[…].fn`/`dispatchReflect`) — a JSON-encoded `FieldPath`
 * (an array of string/number segments) OR a bare JSON scalar, the latter being the 1-segment SUGAR
 * `(grounded? h :at "score")` names (field-granular-access.md §5.1, "V's own phrasing").
 * `undefined` in ⇒ `undefined` out (no `:at` supplied — whole-artifact/whole-circuit behavior,
 * byte-identical to before `:at` existed). Throws a plain, teaching `TypeError` on malformed
 * input — never silently guesses a path.
 */
export function parseFieldPathArg(raw: string | undefined): FieldPath | undefined {
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new TypeError(
      `:at — could not parse ${JSON.stringify(raw)} as a field path (expected a string, a number, ` +
        `or a list of strings/numbers).`,
    );
  }
  if (typeof parsed === "string" || typeof parsed === "number") return [parsed];
  if (Array.isArray(parsed) && parsed.every((seg) => typeof seg === "string" || typeof seg === "number")) {
    return parsed as FieldPath;
  }
  throw new TypeError(
    `:at — expected a field path (a bare string/number 1-segment sugar, or a list of strings/` +
      `numbers), got ${JSON.stringify(parsed)}.`,
  );
}

/** Render a `FieldPath` as the scheme list `:at` echoes on the wire — `("scores" 0)`; `()` for the
 *  root/whole-value path. Numbers render bare, strings quoted — the same convention
 *  `circuitToSexpr`'s own `:key`/`:ctor` rendering uses (arrival-mercury's `circuit-sexpr.ts`). */
export function renderFieldPath(path: FieldPath): string {
  return `(${path.map((seg) => (typeof seg === "number" ? String(seg) : quote(seg))).join(" ")})`;
}

/** why-provenance / lineage: the provenance-point ids the value depends on (the evidence reads). */
export async function whyOf(h: ResultHandle, signal?: AbortSignal): Promise<number[]> {
  const { trace, outputNode } = await h.teleological(signal);
  return buildSlice(trace, outputNode).points;
}

/** where-provenance / location: `scopeId` (`head@line:col`) of each kept form. */
export async function whereOf(h: ResultHandle, signal?: AbortSignal): Promise<string[]> {
  const { trace, outputNode } = await h.teleological(signal);
  return buildSlice(trace, outputNode).scopeIds;
}

/** how-provenance / derivation: a runnable Scheme slice that re-derives the value. */
export async function howOf(h: ResultHandle, signal?: AbortSignal): Promise<string> {
  const { trace, outputNode } = await h.teleological(signal);
  return buildSlice(trace, outputNode).program;
}

/** The console overview: the run's computation DAG as homoiconic S-EXPRESSION data — nodes (each
 *  form's scope-id + label + box-type + fan-out count + causal layer) and edges (field-qualified
 *  dataflow, loopbacks marked). Richest for infer/effect-bearing pipelines. */
export async function dagOf(h: ResultHandle, signal?: AbortSignal): Promise<string> {
  const { trace } = await h.teleological(signal);
  const g = traceToFlowGraph(trace);
  const s = (x: string): string => JSON.stringify(x);
  const node = (n: (typeof g.nodes)[number]): string =>
    `    (node ${s(n.id)} :label ${s(n.label)} :box ${n.boxType}${n.count > 1 ? ` :count ${n.count}` : ""}${
      n.layer == null ? "" : ` :layer ${n.layer}`
    }${n.parentId ? ` :parent ${s(n.parentId)}` : ""})`;
  const edge = (e: (typeof g.edges)[number]): string =>
    `    (-> ${s(e.from)} ${s(e.to)}${e.kind === "loopback" ? " :loopback #t" : ""}${
      e.fields?.length ? ` :fields (${e.fields.map(s).join(" ")})` : ""
    })`;
  return `(dag\n  (nodes\n${g.nodes.map(node).join("\n")})\n  (edges\n${g.edges.map(edge).join("\n")}))`;
}

/** forward-provenance / impact — the BLAST RADIUS: the dag scope-ids of every node that re-fires if
 *  `node` changes. The causal FORWARD complement of `why` (which is backward). `node` is a dag node
 *  scope-id (`head@line:col`, exactly as `dagOf` lists them and `whereOf` returns). Throws a door if
 *  the node isn't in the dag, routing a mistyped id to `(dag h)` rather than silently returning []. */
export async function blastOf(h: ResultHandle, node: string, signal?: AbortSignal): Promise<string[]> {
  const { trace } = await h.teleological(signal);
  const g = traceToFlowGraph(trace);
  if (!g.nodes.some((n) => n.id === node)) {
    throw new TypeError(
      `(blast … ${JSON.stringify(node)}) — no node with that scope-id in the dag. ` +
        `Call (dag h) to see the node ids (e.g. "infer@2:15").`,
    );
  }
  return [...flowForwardCone(g, node)];
}

// ── circuit / grounded? / attest — the grounding trichotomy (T6a) ─────────────────────────────

/** The one reason the FALLBACK path marks anything `not-attestable` — the live static∧probe
 *  conjunction (T6c, `handle.attested()`) could not run for THIS handle (no host-injected attest
 *  capability, or the causal run never finished) — never anything leaf-specific. Shared by the
 *  top-level `:reason` and (on `grounded?`) every leaf's own. */
const UNAVAILABLE_REASON = "live-conjunction-unavailable";

/** The caveat every trace-based advisory carries, verbatim: it is NOT an attestation.
 *  `groundingVerdict` answers "does this trace to a recorded read", which a SELECTED
 *  (grepped/filtered) value can satisfy just as well as a value whose CONTENT was actually
 *  produced by the read — the seal cannot tell those apart. That distinction is exactly what
 *  the static (J1) and probe (J2) legs draw when they run; when the conjunction can't run for a
 *  handle, this caveat is the honest limit of what's knowable here. */
const ADVISORY_CAVEAT = "trace-trusting, cannot distinguish content from selection — NOT an attestation";

const quote = (x: string): string => JSON.stringify(x);

/**
 * The `:leaves (…)` list `grounded?`/`attest` both embed — one row per value-position leaf of
 * `h.value`, via arrival-provenance's own leaf walk (`verdictLeafValues`) and its per-leaf seal
 * (`groundingVerdict`, re-run with EACH leaf's raw value standing in as the whole "result" —
 * the same leaf enumeration/addressing `groundingVerdict` already uses internally, so a leaf's
 * `:path` here is its index into that same walk order). `renderLeaf` shapes one row differently
 * for `grounded?` (carries its own `:reason`) vs `attest` (carries `:static`/`:probe`); the walk
 * and the per-leaf advisory computation are shared. `nil` (never an empty PARSE) when the trace
 * itself is unavailable (`unavailable` carries the door text) or when `h.value` has no leaves at
 * all (a bare nil/void result — nothing to attest).
 *
 * SOURCING (T6a/#15): `h.value` is documented (result-handle.ts) as the WIRE-SAFE causal value,
 * which in every current caller (discovery-run.ts's `runCausal`, via `RunHandle.finished`) is the
 * `toJS`-PEELED projection, not the raw boxed value `groundingVerdict` is designed to read
 * provenance off. A peeled container is JS data (an array/plain object), not
 * `APair`/`AVector`/`ADict`, so the walk does not descend it — it is ONE atomic, ungrounded leaf.
 *
 * `leafSourceValue` (below) closes that gap WHEN the host injected `capabilities.boxedValue` (the
 * RAW pre-peel AValue, `RunHandle.result` per `run-program.ts`'s own doc) — the leaf walk then
 * descends the real container, so a boxed cons of two leaves enumerates two, not one. Absent the
 * capability, the walk still falls back to `h.value` — today's coarser (single-leaf) behavior,
 * unchanged. Never a FALSE positive either way — just coarser enumeration without the capability.
 * `source` is the SAME re-derivation slice `(how h)` would show (`buildSlice(trace,
 * outputNode).program`) — real Scheme text, so the typed-literal gate has something genuine to
 * scan.
 */

/** The value {@link leafRows} walks for leaf enumeration — the host-injected raw `boxedValue`
 *  (#15) when the handle's `capabilities` carry one, else the peeled `h.value` (the documented
 *  single-leaf fallback). `Object.hasOwn`, not `!== undefined`: a captured raw value can
 *  legitimately BE `undefined` (result-handle.ts's own doc on why that isn't an absence signal
 *  here). */
function leafSourceValue(h: ResultHandle): unknown {
  return h.capabilities && Object.hasOwn(h.capabilities, "boxedValue") ? h.capabilities.boxedValue : h.value;
}

async function leafRows(
  h: ResultHandle,
  signal: AbortSignal | undefined,
  renderLeaf: (path: number, display: string, advisory: string) => string,
): Promise<{ leaves: string; unavailable?: string }> {
  try {
    const { trace, outputNode } = await h.teleological(signal);
    const { program } = buildSlice(trace, outputNode);
    const rawLeaves = verdictLeafValues(leafSourceValue(h));
    if (rawLeaves.length === 0) return { leaves: "nil" };
    const rows = rawLeaves.map((leafValue, path) => {
      // Re-seal with THIS leaf standing in as the whole result: an independent verdict per leaf,
      // never a whole-result rollup (Gate 1 alone would collapse a mixed grounded/fabricated
      // result to one "unsigned", exactly the mispairing this per-leaf shape must distinguish).
      const perLeaf = groundingVerdict({ result: leafValue, trace, source: program });
      const display = perLeaf.leaves[0]?.display ?? quote(String(leafValue));
      const advisory = `(advisory :from "trace-based-grounding" :verdict ${perLeaf.verdict} :caveat ${quote(ADVISORY_CAVEAT)})`;
      return renderLeaf(path, display, advisory);
    });
    return { leaves: `(${rows.join(" ")})` };
  } catch (error) {
    return { leaves: "nil", unavailable: error instanceof Error ? error.message : String(error) };
  }
}

/** `h.attested()`, swallowing its throw (no live `attestProvider` capability, or the run never
 *  finished). `undefined` on failure — `groundedOf`/`attestOf` fall back to the per-leaf
 *  trace-based advisory; the resolved `AttestedLeaf[]` on success (T6c — the live conjunction). */
async function tryAttested(h: ResultHandle, signal?: AbortSignal): Promise<readonly AttestedLeaf[] | undefined> {
  try {
    return await h.attested(signal);
  } catch {
    return undefined;
  }
}

/** One `AttestedLeafVerdict` (result-handle.ts — a duck-typed mirror of arrival-mercury's
 *  `SealVerdict`) rendered as the sexpr fragment `groundedOf`/`attestOf` embed per leaf. */
function renderAttestedVerdict(v: AttestedLeafVerdict): string {
  if (v.kind === "content-attested") return "content-attested";
  if (v.kind === "selection-attested")
    return `selection-attested :vocabulary (${[...v.vocabulary].map(quote).join(" ")})`;
  return `not-attestable :reason ${quote(v.reason)}`;
}

/** Render the LIVE (T6c) leaves — `leaf.display` is already a rendered literal (`leafRows`'
 *  fallback shape, `JSON.stringify` of the leaf's baseline value), embedded verbatim rather than
 *  re-quoted.
 *
 *  `:at (…)` (BC-4, field-granular-access.md §4.2.3) is the REAL FieldPath, ADDITIVE alongside the
 *  ordinal `:path N` — the frozen `mcp-worker/src/__tests__/attest-conjunction.test.ts` pins
 *  `(leaf :path N …)` on the wire (a literal substring match), so `:path` stays exactly as it
 *  renders today; `:at` is the new, addressable, program-edit-stable field the ordinal was never
 *  able to be. The ordinal's removal awaits that frozen file's own authorization (README.md C5). */
function renderAttestedLeaves(leaves: readonly AttestedLeaf[]): string {
  const rows = leaves.map(
    (leaf) =>
      `(leaf :path ${leaf.path} :at ${renderFieldPath(leaf.at)} :display ${leaf.display} :verdict ${renderAttestedVerdict(leaf.verdict)})`,
  );
  return `(${rows.join(" ")})`;
}

/**
 * Static attribution circuit — the compile-time attribution PLANE (as opposed to `dag`'s RUNTIME
 * computation DAG). T6b's finding: the SEAM this needs is real and traceable — `h.teleological()`
 * gives `{trace, outputNode}`, `buildSlice(trace, outputNode).program` is the SAME re-derivation
 * slice `(how h)` returns (real Scheme source text), and `@inhuman.tools/arrival-mercury` owns the
 * rest of the pipeline that source needs to become a circuit: `parseSexprs` → `desugar` →
 * `classify` → `extractProgram(forms, registry)` → `StaticProv` → `circuitToSexpr`.
 *
 * This analysis plane does not import the compiler (`arrival-mercury`): extract +
 * `circuitToSexpr` are a compiler concern, and a host that already depends on both
 * (mcp-worker) is the right place to close the seam. NEVER fabricate a circuit to
 * route around a missing provider.
 *
 * (#23) resolved this with a HOST-INJECTED bridge: `inhuman-mcp-worker` hands the
 * `ResultHandle` a `capabilities.circuitProvider` closure at CONSTRUCTION time
 * (discovery-run.ts), built over the same source text this handle's run executed.
 * `circuitOf` calls it when present; when absent (a handle built without the
 * capability — every test fixture in this package), the door below still fires,
 * routing callers to what this subpath unconditionally offers: the runtime DAG
 * (`dag`) and the backward evidence lineage (`why`). Async (like its siblings) so
 * either branch is a signature-compatible resolution.
 *
 * `path` (BC-4, `:at` — field-granular-access.md §5.1) narrows the render to one field's cone
 * (`fieldProv`, resolved host-side inside the injected provider — this subpath never sees a
 * `StaticProv`). A §2.5 QUERY REFUSAL (an absent key, a step into a scalar, …) surfaces as a
 * thrown door from the provider itself, propagated verbatim — never swallowed into a fake
 * rendering. Omitted ⇒ the whole-circuit rendering, byte-identical to before `:at` existed. */
export async function circuitOf(h: ResultHandle, signal?: AbortSignal, path?: FieldPath): Promise<string> {
  const provider = h.capabilities?.circuitProvider;
  if (provider) return provider(path);
  throw new TypeError(
    "(circuit h) — the static attribution circuit is produced by @inhuman.tools/arrival-mercury's " +
      "extract + circuitToSexpr. This analysis plane does not import the compiler; a host that " +
      "already depends on both injects circuitProvider at handle construction. This handle carries " +
      "no host-injected circuitProvider capability, so there is no live circuit to render. " +
      "(dag h) shows the runtime computation DAG and (why h) the evidence lineage.",
  );
}

/** `:at`-scoped meta a resolved {@link AttestedField} carries beyond its bare verdict — the cone
 *  sexpr (absent on a §2.5 query refusal), a frontier (§2.4, a legitimate coarseness, not an
 *  error), and/or the fan sites crossed (§3.3, navigation-grade). All optional; renders to `""`
 *  when nothing is present. */
function renderFieldMeta(field: AttestedField): string {
  let out = "";
  if (field.cone !== undefined) out += ` :cone ${field.cone}`;
  if (field.frontier !== undefined) out += ` :frontier ${renderFieldPath(field.frontier)}`;
  if (field.crossedFans !== undefined && field.crossedFans.length > 0)
    out += ` :crossed-fans (${field.crossedFans.join(" ")})`;
  return out;
}

/** `h.attestedField(path)` with the SAME fail-closed catch discipline as {@link tryAttested}: a
 *  handle the field conjunction can't run for (no `attestFieldProvider` capability — every
 *  fixture in this subpath — or a provider crash) resolves to a `not-attestable` verdict carrying
 *  the door text as its reason, NEVER a throw and NEVER a positive (the T6a staging law, verbatim:
 *  soundness is never staged). The `at` echoed is the caller's parsed path — nothing resolved. */
async function fieldOrFailClosed(h: ResultHandle, path: FieldPath, signal?: AbortSignal): Promise<AttestedField> {
  try {
    return await h.attestedField(path);
  } catch (error) {
    if (signal?.aborted && error instanceof Error && /abort/i.test(error.name + error.message)) {
      throw error; // upstream cancellation — not a verdict.
    }
    return {
      at: path,
      verdict: {
        kind: "not-attestable",
        reason: `${UNAVAILABLE_REASON}: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
}

/**
 * Grounding verdict over a handle — the LIVE static∧probe conjunction, PER LEAF, when
 * `handle.attested()` resolves (T6c); the fail-closed per-leaf trace-based ADVISORY (see this
 * section's header doc for the staging law) when it throws (no live `attestProvider` capability,
 * or the causal run never finished).
 *
 * `path` (BC-4, `:at` — field-granular-access.md §5.1) narrows to ONE field's verdict via
 * `handle.attestedField(path)`, never the whole-artifact walk above. A capability-absent handle
 * (or a provider crash) fails CLOSED — a `not-attestable` verdict carrying the door text as its
 * reason (`fieldOrFailClosed`), the same staging-law posture the whole-artifact fallback holds; a
 * §2.5 query refusal likewise arrives as a resolved `not-attestable` whose reason IS the teaching
 * door (the provider resolves refusals, never throws them — attest-provider.ts).
 */
export async function groundedOf(h: ResultHandle, signal?: AbortSignal, path?: FieldPath): Promise<string> {
  if (path !== undefined) {
    const field = await fieldOrFailClosed(h, path, signal);
    return `(grounding :at ${renderFieldPath(field.at)} :verdict ${renderAttestedVerdict(field.verdict)})`;
  }
  const positive = await tryAttested(h, signal);
  if (positive !== undefined) return `(grounding :leaves ${renderAttestedLeaves(positive)})`;
  const { leaves, unavailable } = await leafRows(
    h,
    signal,
    (ord, display, advisory) =>
      `(leaf :path ${ord} :display ${display} :verdict not-attestable :reason ${quote(UNAVAILABLE_REASON)} :advisory ${advisory})`,
  );
  const reason =
    unavailable === undefined ? UNAVAILABLE_REASON : `${UNAVAILABLE_REASON}; trace unavailable: ${unavailable}`;
  return `(grounding :reason ${quote(reason)} :leaves ${leaves})`;
}

/** The full attestation artifact over a handle — same live/fallback split as {@link groundedOf}:
 *  the real per-leaf `content-attested`/`selection-attested`/`not-attestable` verdicts when T6c's
 *  conjunction resolved, else the fail-closed per-leaf trace-based advisory (both legs `pending`).
 *
 * `path` (BC-4, `:at`) narrows to ONE field's full artifact — verdict PLUS the resolved cone
 * (`circuitToSexpr`, pre-rendered host-side) and, when applicable, the frontier/crossed-fans meta
 * (field-granular-access.md §5.1/§5.4's worked examples). Same fail-closed discipline as
 * {@link groundedOf}; a refusal's artifact carries the door text as its reason and no `:cone`. */
export async function attestOf(h: ResultHandle, signal?: AbortSignal, path?: FieldPath): Promise<string> {
  if (path !== undefined) {
    const field = await fieldOrFailClosed(h, path, signal);
    return `(attestation :at ${renderFieldPath(field.at)} :verdict ${renderAttestedVerdict(field.verdict)}${renderFieldMeta(field)})`;
  }
  const positive = await tryAttested(h, signal);
  if (positive !== undefined) return `(attestation :leaves ${renderAttestedLeaves(positive)})`;
  const { leaves, unavailable } = await leafRows(
    h,
    signal,
    (ord, display, advisory) =>
      `(leaf :path ${ord} :display ${display} :verdict not-attestable :static pending :probe pending :advisory ${advisory})`,
  );
  const reason =
    unavailable === undefined ? UNAVAILABLE_REASON : `${UNAVAILABLE_REASON}; trace unavailable: ${unavailable}`;
  return `(attestation :reason ${quote(reason)} :leaves ${leaves})`;
}

/** Metadata + impl fns for the reflect verbs. Used by `dispatchReflect` (host-side application to
 *  a real ResultHandle for the mcp wire-safe `reflect(verb, handleId, …)` path). The in-process
 *  `arrivalReflectCapability` declares its rosetta symbols directly (importing the of-fns), not by
 *  mapping this list. */
export interface ReflectVerb {
  readonly name: string;
  readonly type: string;
  readonly description: string;
  readonly args: readonly string[];
  readonly fn: (h: ResultHandle, signal: AbortSignal | undefined, ...rest: string[]) => unknown;
}

export const REFLECT_VERBS: readonly ReflectVerb[] = [
  {
    name: "why",
    type: "(h: ResultHandle): list",
    args: [],
    description: "Lineage: the evidence/infer reads the value depended on (why-provenance).",
    fn: (h, s) => whyOf(h, s),
  },
  {
    name: "where",
    type: "(h: ResultHandle): list",
    args: [],
    description: "Source locations (head@line:col) of the derivation (where-provenance).",
    fn: (h, s) => whereOf(h, s),
  },
  {
    name: "how",
    type: "(h: ResultHandle): string",
    args: [],
    description: "A runnable Scheme slice that re-derives the value (how-provenance).",
    fn: (h, s) => howOf(h, s),
  },
  {
    name: "dag",
    type: "(h: ResultHandle): string",
    args: [],
    description:
      "Console overview: the run's computation DAG as homoiconic sexpr (nodes + dataflow edges). Works on a PARTIAL trace too — a timed-out run's value is {__timeout__: #t, …} and (dag h) still shows how far it got.",
    fn: (h, s) => dagOf(h, s),
  },
  {
    name: "blast",
    type: "(h: ResultHandle, node: string): list",
    args: ["node"],
    description:
      "Impact / blast radius: the dag node ids that re-fire if `node` changes — the causal FORWARD complement of (why h). `node` is a head@line:col id from (dag h).",
    fn: (h, s, node) => blastOf(h, String(node), s),
  },
  {
    name: "circuit",
    type: "(h: ResultHandle, at?: field-path): sexpr",
    args: [],
    description:
      "Static attribution circuit — live when the handle carries a host-injected circuitProvider capability (this analysis plane does not import the compiler); otherwise throws, routing to (dag h)/(why h). Optional :at (a list of plain segments — strings for keys, numbers for positions; a bare string/number is the 1-segment path) narrows the render to one field's cone, with :frontier/:crossed-fans meta.",
    fn: (h, s, at) => circuitOf(h, s, parseFieldPathArg(at)),
  },
  {
    name: "grounded?",
    type: "(h: ResultHandle, at?: field-path): sexpr",
    args: [],
    description:
      "Grounding verdict over a handle's value, PER LEAF — the live static∧probe conjunction: content-attested / selection-attested / not-attestable per leaf; falls back to a fail-closed, trace-based ADVISORY (never a positive verdict) when the conjunction can't run for this handle. Optional :at (segments list; bare string/number = 1-segment path) answers for exactly ONE field instead of every leaf.",
    fn: (h, s, at) => groundedOf(h, s, parseFieldPathArg(at)),
  },
  {
    name: "attest",
    type: "(h: ResultHandle, at?: field-path): sexpr",
    args: [],
    description:
      "The full attestation artifact over a handle, PER LEAF — same live verdicts as (grounded? h), plus a selection-attested leaf's vocabulary and a not-attestable leaf's reason. Evidence read off a native dict narrows and attests; the alist idiom (list (cons k v) …) is a primitives-materialization that conservatively seals not-attestable. Optional :at (segments list; bare string/number = 1-segment path) seals exactly ONE field: verdict + its resolved cone (+ :frontier/:crossed-fans meta).",
    fn: (h, s, at) => attestOf(h, s, parseFieldPathArg(at)),
  },
  {
    name: "result-value",
    type: "(h: ResultHandle): unknown",
    args: [],
    description: "The value a run produced.",
    fn: (h) => h.value,
  },
];
