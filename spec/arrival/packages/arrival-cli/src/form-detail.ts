/**
 * Drill-down: select one form from the outline (its `scopeId`) and see WHAT its N
 * invocations were. This must AGGREGATE, not dump — `if ×177` shown as 177 lines is a
 * firehose, not a reveal. So a form's detail is a small
 * fixed-size summary of a possibly-huge invocation set:
 *
 *   • a header — the aggregate: `×N`, state breakdown, call-depth range, tail/cached counts;
 *   • "called from" — the distinct PARENT templates and how often this form ran under each
 *     (the recursion/HOF context, collapsed: fib's `if` is "×176 from fib, ×1 from root");
 *   • a bounded SAMPLE of individual invocations — depth, state, and the value WHERE THE
 *     TRACE RETAINED IT. Pure scaffolding values are pruned (the leak fix); we print
 *     `«value elided»` honestly rather than inventing or silently dropping.
 *
 * Pure and headless: `formDetail(trace, scope)` returns a plain data object; `render…`
 * turns it into lines. A `--form <scope>` flag drives it with no keyboard — the same data
 * a later interactive selection or a `--export json` would carry.
 */
import {
  headOf,
  scopeId,
  type EvalTrace,
  type Invocation,
  type InvocationState,
} from "@inhuman.tools/arrival/provenance";
import { toSExprString } from "@inhuman.tools/arrival-serializer";

import { fileUrl, hyperlink } from "./osc.js";
import { paint, type TintName, type colorMode } from "./tints.js";

type ColorMode = ReturnType<typeof colorMode>;

/** How many individual invocations to show before "…and N more" — the sample cap that
 *  keeps a 177-invocation form to a screenful. */
const SAMPLE_CAP = 6;
/** Per-value render budget — a sampled value is a glance, not a dump. */
const VALUE_OPTS = { maxItems: 12, maxStringChars: 120, maxTotalChars: 240 };

export interface InvocationSample {
  readonly depth: number;
  readonly state: InvocationState;
  /** Rendered value (s-expr), `null` when the trace pruned it, error message when rejected. */
  readonly value: string | null;
  readonly tail: boolean;
  readonly cached: boolean | undefined;
}

export interface FormDetail {
  readonly scope: string;
  readonly head: string;
  readonly found: boolean;
  readonly count: number;
  /** state → how many invocations. */
  readonly states: Partial<Record<InvocationState, number>>;
  readonly depthMin: number;
  readonly depthMax: number;
  readonly tailCount: number;
  readonly cachedCount: number;
  /** Parent template `scopeId` → count, sorted desc. `"(root)"` for a parentless invocation. */
  readonly callers: ReadonlyArray<readonly [string, number]>;
  readonly samples: readonly InvocationSample[];
  readonly moreSamples: number;
}

function renderValue(inv: Invocation): string | null {
  if (inv.state === "rejected") {
    const e = inv.error;
    return e instanceof Error ? e.message : String(e);
  }
  // A resolved invocation with no retained value is a pruned scaffolding value — not void
  // per se, but indistinguishable here, and honesty is "we didn't keep it".
  if (inv.value === undefined) return null;
  return toSExprString(inv.value, VALUE_OPTS);
}

/** Compute the drill-down data for `scope` against a settled (or in-flight) trace. */
export function formDetail(trace: EvalTrace, scope: string): FormDetail {
  let invs: Invocation[] = [];
  let head = scope;
  for (const [pair, rec] of trace.records) {
    if (scopeId(pair) === scope) {
      invs = [...rec.bindings];
      head = headOf(pair);
      break;
    }
  }
  if (invs.length === 0) {
    return {
      scope,
      head,
      found: false,
      count: 0,
      states: {},
      depthMin: 0,
      depthMax: 0,
      tailCount: 0,
      cachedCount: 0,
      callers: [],
      samples: [],
      moreSamples: 0,
    };
  }

  const states: Partial<Record<InvocationState, number>> = {};
  const callerTally = new Map<string, number>();
  let depthMin = Infinity;
  let depthMax = 0;
  let tailCount = 0;
  let cachedCount = 0;
  for (const inv of invs) {
    states[inv.state] = (states[inv.state] ?? 0) + 1;
    const depth = inv.ancestors().length - 1; // exclude self
    depthMin = Math.min(depthMin, depth);
    depthMax = Math.max(depthMax, depth);
    if (inv.tailPosition) tailCount += 1;
    if (inv.cached === true) cachedCount += 1;
    const caller = inv.parent === null ? "(root)" : scopeId(inv.parent.node);
    callerTally.set(caller, (callerTally.get(caller) ?? 0) + 1);
  }
  const callers = [...callerTally.entries()].sort((a, b) => b[1] - a[1]);

  const samples: InvocationSample[] = invs.slice(0, SAMPLE_CAP).map((inv) => ({
    depth: inv.ancestors().length - 1,
    state: inv.state,
    value: renderValue(inv),
    tail: inv.tailPosition,
    cached: inv.cached,
  }));

  return {
    scope,
    head,
    found: true,
    count: invs.length,
    states,
    depthMin: depthMin === Infinity ? 0 : depthMin,
    depthMax,
    tailCount,
    cachedCount,
    callers,
    samples,
    moreSamples: Math.max(0, invs.length - SAMPLE_CAP),
  };
}

function tint(text: string, name: TintName, mode: ColorMode): string {
  return mode === "none" ? text : paint(text, name, mode);
}

/** Pull the `line` out of a `scopeId` string (`head@line:col`, or `head@source:line:col`) —
 *  `undefined` for a location-less scope like the callers' `"(root)"` sentinel. */
function scopeLine(scope: string): number | undefined {
  const m = /@(?:.*:)?(\d+):\d+$/.exec(scope);
  return m === null || m[1] === undefined ? undefined : Number(m[1]);
}

/** Wrap already-tinted `text` in an OSC 8 hyperlink to `scope`'s source location, when a
 *  `file` and a live color `mode` are both present — the same gate as the outline renderer,
 *  so piped/`none` output never picks up escape bytes. */
function withLocationLink(text: string, scope: string, mode: ColorMode, file: string | undefined): string {
  if (file === undefined || mode === "none") return text;
  const line = scopeLine(scope);
  return line === undefined ? text : hyperlink(fileUrl(file, line), text);
}

function statesSummary(states: Partial<Record<InvocationState, number>>): string {
  const parts: string[] = [];
  if (states.resolved) parts.push(`${states.resolved} done`);
  if (states.running) parts.push(`${states.running} running`);
  if (states.rejected) parts.push(`${states.rejected} error`);
  return parts.join(", ");
}

/** Render a `FormDetail` to lines. Subtle: dim scaffolding (locations, "called from"),
 *  the head + count the one bright bit, errors escalate. `file` (the run's absolute source
 *  path, when known) makes the head and each "called from" site an OSC 8 hyperlink to its
 *  source location — gated on a live color `mode` so piped/`none` output stays untouched. */
export function renderFormDetail(d: FormDetail, mode: ColorMode = "none", file?: string): string[] {
  if (!d.found) {
    return [tint(`no form ${d.scope} in this run — is the scopeId right? (see --outline)`, "gutter", mode)];
  }
  const errored = (d.states.rejected ?? 0) > 0;
  const headTint: TintName = errored ? "error" : "done";
  const lines: string[] = [];

  const depth = d.depthMin === d.depthMax ? `depth ${d.depthMin}` : `depth ${d.depthMin}–${d.depthMax}`;
  const extras = [depth];
  if (d.tailCount > 0) extras.push(`${d.tailCount} tail`);
  if (d.cachedCount > 0) extras.push(`${d.cachedCount} cached`);
  const headText = withLocationLink(tint(d.head, headTint, mode), d.scope, mode, file);
  lines.push(
    `${headText} ${tint(`×${d.count}`, "accent", mode)}  ` +
      `${tint(statesSummary(d.states), headTint, mode)}  ${tint(`· ${extras.join(" · ")}`, "gutter", mode)}`,
  );

  if (d.callers.length > 0) {
    lines.push(tint("  called from:", "gutter", mode));
    for (const [caller, n] of d.callers.slice(0, 5)) {
      const callerText = withLocationLink(tint(caller, "gutter", mode), caller, mode, file);
      lines.push(`    ${callerText} ${tint(`×${n}`, "accent", mode)}`);
    }
    if (d.callers.length > 5) lines.push(tint(`    …and ${d.callers.length - 5} more call sites`, "gutter", mode));
  }

  // When no sampled value survived the trace's pruning (pure scaffolding — a bare
  // `(* n n)`), the per-row value column would be a wall of "«value elided»". Collapse it
  // to one honest line that still carries the depth ladder (the recursion's shape). When
  // values ARE retained (an `infer` point, a top-level form, an error message), show them
  // per-row — that's the actual reveal.
  const hasValues = d.samples.some((s) => s.value !== null);
  if (!hasValues) {
    const depths = d.samples.map((s) => `d${s.depth}`).join(" ");
    const more = d.moreSamples > 0 ? ` …+${d.moreSamples}` : "";
    lines.push(tint(`  values pruned (pure); sampled depths: ${depths}${more}`, "gutter", mode));
    return lines;
  }
  lines.push(tint("  samples:", "gutter", mode));
  for (const s of d.samples) {
    const stateTint: TintName = s.state === "rejected" ? "error" : "done";
    const badge = [`d${s.depth}`];
    if (s.tail) badge.push("tail");
    if (s.cached === true) badge.push("cached");
    const val = s.value === null ? tint("«elided»", "gutter", mode) : tint(s.value, stateTint, mode);
    lines.push(`    ${tint(badge.join(" "), "gutter", mode)}  ${val}`);
  }
  if (d.moreSamples > 0) lines.push(tint(`    …and ${d.moreSamples} more invocations`, "gutter", mode));
  return lines;
}
