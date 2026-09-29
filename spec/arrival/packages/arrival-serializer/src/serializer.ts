import "@here.build/arrival-env";

const isNil = (element: any) => element?.constructor?.name === "ANil";

/**
 * S-expression serializer for Arrival — two phases over any JavaScript value.
 *
 * `toSExpr` walks a value into an `SExpr` intermediate tree, dispatching each node through a
 * `Symbol.toSExpr` custom representation (scheme pairs/exacts/symbols, AValues, the context marker
 * objects) and detecting cycles with a DFS path-set. `formatSExpr` renders that tree to text.
 * Three entry points share the one walk: `toSExprString` (text), `toSExprStringWithElisions`
 * (+ the collected `ElisionRecord`s), and `serializeWithExtras` (+ extracted binary blobs). The
 * extra sinks are ADDITIVE — the plain `toSExprString` path stays byte-identical whether or not
 * a sink is active.
 *
 * PARSEABLE REDUCTION (the one law). Every way this serializer drops content — per-collection
 * tail-truncation, middle-elision, per-string capping, binary-leaf extraction, and the final
 * pathological hard-cut — leaves output that STILL PARSES and round-trips to the shown sample.
 * A reduction signals INLINE, never with a top-of-output banner and never silently
 * (errors-as-doors): a `#| … |#` block comment the reader ignores, or a
 * `#attachment "att-N (mime, size)"` tagged literal whose blob rides a separate content block.
 * The inline markers ARE the signal.
 *
 * FAIR SHRINK-TO-FIT. Caps are opt-in — a bare indent renders uncapped. When set, per-element
 * limits apply STREAMING: the tail of a 10k-element array is never serialized, it costs
 * `maxItems`. If the capped render still exceeds `maxTotalChars`, the limits SHRINK uniformly and
 * re-render rather than tail-cutting the text — a tail-cut would gut a sibling (sever PSSCAN from
 * a `[PSLIST PSSCAN]` diff). Only floor-still-over-budget falls back to a hard content cut,
 * itself marked inline.
 *
 * SYNCHRONOUS MODULE STATE. The per-render context — `activeCaps`, `activeCollector`,
 * `activeElisionSink`, `activeReduced`, `activeLineageEnvelopes` — lives at module scope, not
 * threaded through every recursive `toSExpr`. Safe because serialization is SYNCHRONOUS: no
 * re-entrancy within one call. Each is saved and restored (not merely reset) so a caller's
 * `format` callback that re-enters a serializer entry point cannot clobber the outer call's state.
 */

export const SEXPR_TAG = Symbol.for("expression");

// Unique symbols for serialization markers
const QUOTED_MARKER = Symbol.for("arrival:quoted");
const FORCE_QUOTED_STRING_MARKER = Symbol.for("arrival:force_quoted_string");
const EXPR_MARKER = Symbol.for("arrival:expr");
const TAGGED_MARKER = Symbol.for("arrival:tagged");
const TRUNCATED_MARKER = Symbol.for("arrival:truncated");

/**
 * Per-render truncation budget. Serialization is SYNCHRONOUS, so a module-level
 * "active caps" is safe (no re-entrancy within a single `toSExprString` call) and
 * spares threading caps through every recursive `toSExpr`. The caps are applied
 * STREAMING — at each collection/string we stop emitting at the cap and never
 * serialize the tail (a 10k-element array costs `maxItems`, not 10k).
 *
 * `primaryArray`/`primaryLimit`/`defaultLimit` and `elideHead`/`elideTail` back the
 * middle-elision feature (opt-in — see `SerializeOpts` below): `primaryArray` is the ONE
 * array (by REFERENCE) that earns the elevated `primaryLimit`; every other collection uses
 * `defaultLimit`. `elideHead`/`elideTail` gate middle-elision itself — `Infinity`/`0` (the
 * `NO_CAPS` defaults) mean "off", matching today's tail-truncation exactly.
 */
type Caps = {
  maxItems: number;
  maxStringChars: number;
  elideHead: number;
  elideTail: number;
  primaryArray: readonly unknown[] | null;
  primaryLimit: number;
  defaultLimit: number;
};
const NO_CAPS: Caps = {
  maxItems: Infinity,
  maxStringChars: Infinity,
  elideHead: Infinity,
  elideTail: 0,
  primaryArray: null,
  primaryLimit: Infinity,
  defaultLimit: Infinity,
};
let activeCaps: Caps = NO_CAPS;

/** Lineage-envelope opt-in for the CURRENT render (mirrors `activeCaps`'s module-level
 *  threading — serialization is synchronous, so this is safe without cloning through every
 *  recursive `toSExpr`). Default `false`: an AValue's `{provenance, kind, source…}` envelope
 *  is INTERNAL plumbing, never model-visible output — see the guard in `toSExprDispatch`
 *  below. `true` only inside a `toSExprString`/`serializeWithExtras` call whose
 *  `SerializeOpts.lineageEnvelopes` was set (lineage-debugging consumers opting in). */
let activeLineageEnvelopes = false;

/** Did the CURRENT render pass actually drop content? Flipped by `truncatedMarker` (collection
 *  tail-truncation and middle-elision), `capString`, and the hard-cut. Reset at the start of
 *  every shrink-to-fit pass so only the FINAL pass stands. `toSExprString` snapshots it into
 *  `lastRenderReduced` (saved/restored like the other module flags, so a `format` callback that
 *  re-enters cannot clobber the outer call). */
let activeReduced = false;
let lastRenderReduced = false;
const markReduced = (): void => {
  activeReduced = true;
};
const beginReducedPass = (): void => {
  activeReduced = false;
};

/** A `#| … |#` block-comment marker the formatter renders verbatim, so a truncated
 *  list still PARSES (the comment is ignored) — it round-trips to the shown sample. */
const truncatedMarker = (note: string): SExpr => {
  markReduced();
  return { [TRUNCATED_MARKER]: note };
};

// ── {core, extras}: serializer-side binary-leaf extraction ─────────────────────────────────
// The seam lives HERE because this is the one place that walks every output value under the caps
// machinery: position (the in-text tag) and payload (the collected blob) never desync because one
// walk produced both. Extraction happens iff the caller used the `serializeWithExtras` entry
// point; `toSExprString` itself stays byte-identical.

/** One extracted binary leaf: the id baked into the core text's `#attachment` tag + the blob
 *  itself. Rendering strategy is DOWNSTREAM-owned — this contract carries everything any
 *  strategy needs. */
export interface SerializedExtra {
  /** Call-scoped attachment id — `att-N` — the same id inside the core tag. */
  id: string;
  blob: Blob;
}

export interface SerializedOutput {
  /** The response text itself — s-expr with `#attachment` tags in place of binary leaves. */
  core: string;
  /** What downstream must render EXTRA — collected during THIS render, in encounter order. */
  extras: readonly SerializedExtra[];
  /** Binary leaves rendered tag-only because the quota was already full — never collected, so
   *  downstream never spends base64 work on them. CUMULATIVE over the shared `ExtrasState`
   *  (the per-call total a drained note reports); a per-render delta is `after − before`. */
  overflow: number;
}

/** ONE call's shared attachment numbering + quota, threaded across its renders so ids stay
 *  unique per call and the quota is global to the call (the `AttachmentSink.beginCall(quota)`
 *  shape, consulted DURING the walk). */
export interface ExtrasState {
  /** Next `att-N` ordinal (1-based). */
  next: number;
  /** Quota left — at 0 every further binary leaf renders tag-only and is NOT collected. */
  remaining: number;
  /** Leaves rendered tag-only past quota so far. */
  overflow: number;
}

export const initialExtrasState = (quota = Infinity): ExtrasState => ({
  next: 1,
  remaining: quota,
  overflow: 0,
});

/** The size token inside a tag/label — `34kB` class, human-scaled: exact bytes buys the model
 *  nothing beyond the order of magnitude (the same reasoning as arrival-manifold's hidden stub). */
export const formatByteSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
};

type ActiveExtrasCollector = {
  state: ExtrasState;
  extras: SerializedExtra[];
  /** Entry snapshot — each shrink-to-fit render pass rewinds to it (see `beginCollectorPass`). */
  snapshot: ExtrasState;
};
let activeCollector: ActiveExtrasCollector | null = null;

/** Rewind the collector for a render pass. `toSExprString`'s shrink-to-fit loop re-renders the
 *  same value; without the rewind every pass would re-collect the same blobs (duplicate extras)
 *  and burn quota per pass. Only the FINAL pass's collection stands — which is also the pass
 *  whose tags are actually in the returned core, so position and payload agree. */
const beginCollectorPass = (): void => {
  if (activeCollector === null) return;
  const { state, snapshot } = activeCollector;
  state.next = snapshot.next;
  state.remaining = snapshot.remaining;
  state.overflow = snapshot.overflow;
  activeCollector.extras.length = 0;
};

/** The binary leaf under `obj`, if it is one: a `Blob` itself, or an AValue whose `toJS`
 *  projection is a Blob — the same `"arrival/toJS"` protocol-key dispatch as the
 *  empty-provenance branch below, but provenance-blind: the pixels are the leaf either way. */
const binaryLeafOf = (obj: any): Blob | undefined => {
  if (obj instanceof Blob) return obj;
  if (typeof obj["arrival/toJS"] === "function" && typeof obj.kind === "string") {
    const projected = obj["arrival/toJS"]();
    if (projected instanceof Blob) return projected;
  }
  return undefined;
};

/** Collect one binary leaf (quota consulted DURING the walk): within quota it joins `extras`
 *  and renders as `#attachment "att-N (mime, size)"`; past quota it renders tag-only
 *  (`over-quota` in place of an id — nothing to reference) and is NEVER collected, so no
 *  base64 work is ever spent downstream on a block that would be dropped. Both tag shapes
 *  ride TAGGED_MARKER, so the core text still PARSES (same law as the truncation markers). */
/** The Clojure-style tagged-literal marker object (`context.tagged`'s shape). SExpr's object
 *  arm indexes by symbol only, so the string `value` field rides a widened structural alias —
 *  the formatter reads it back at its TAGGED_MARKER branch. */
const attachmentTag = (text: string): SExpr => {
  const tagged: { [key: symbol]: unknown; value: string } = { [TAGGED_MARKER]: "attachment", value: text };
  return tagged;
};

const collectBinaryLeaf = (collector: ActiveExtrasCollector, blob: Blob): SExpr => {
  const mime = blob.type || "application/octet-stream";
  const descriptor = `(${mime}, ${formatByteSize(blob.size)})`;
  const { state } = collector;
  if (state.remaining <= 0) {
    state.overflow += 1;
    return attachmentTag(`over-quota ${descriptor}`);
  }
  const id = `att-${state.next}`;
  state.next += 1;
  state.remaining -= 1;
  collector.extras.push({ id, blob });
  return attachmentTag(`${id} ${descriptor}`);
};

// ── Middle-elision (opt-in — see `SerializeOpts.elideHead`/`elideTail`) ─────────────────────
// A too-long array rendered as "head ... +N more of TOTAL" at the very tail reads, to a model,
// as a near-complete dump with a buried footnote — an easy miss (the grounding failure: a
// 100-item array shown ~93-deep with the missing-7 marker at the very end was read as complete,
// and the answer was in the 7). Middle-elision instead shows a SMALL head + SMALL tail around a
// LOUD marker, so incompleteness sits where it can't be skimmed past, plus records an
// `ElisionRecord` (when a sink is active) for the trailing `;; Note:` block downstream.

export interface ElisionRecord {
  /** Total length of the elided collection. */
  total: number;
  /** How many items/entries were NOT rendered (the hidden middle). */
  notRendered: number;
  /** Shape descriptor (`describeElision`) over the SHOWN head+tail items. */
  shownShape: string;
  /** Shape descriptor over the HIDDEN middle items. */
  hiddenShape: string;
}

/** Collected elisions for the render CURRENTLY in flight, or `null` when nothing is collecting
 *  (the plain `toSExprString` path never sets this — backward-compatible by construction). */
let activeElisionSink: ElisionRecord[] | null = null;

/** Rewind the sink for a render pass — mirrors `beginCollectorPass`: `toSExprString`'s
 *  shrink-to-fit loop re-renders the same value, so only the FINAL pass's elisions must stand. */
const beginElisionPass = (): void => {
  if (activeElisionSink === null) return;
  activeElisionSink.length = 0;
};

type ElisionKind = "object" | "array" | "number" | "string" | "boolean" | "null" | "other";

const PLURAL_KIND: Record<ElisionKind, string> = {
  number: "numbers",
  string: "strings",
  boolean: "booleans",
  object: "objects",
  array: "arrays",
  null: "nils",
  other: "items",
};

const kindOf = (x: unknown): ElisionKind => {
  if (x === null) return "null";
  if (Array.isArray(x)) return "array";
  if (typeof x === "object") return "object";
  if (typeof x === "number" || typeof x === "string" || typeof x === "boolean") return typeof x as ElisionKind;
  return "other";
};

/** The descriptor phrase filling `<N> ___ were not rendered` — a cheap ONE-LEVEL shape scan
 *  over a list of hidden (or shown) items, never a deep walk. `items.length > 1000` skips type
 *  identification entirely (cost guard) and just says "items". */
function describeElision(items: readonly unknown[]): string {
  if (items.length === 0 || items.length > 1000) return "items";

  const kinds = items.map(kindOf);
  const uniqueKinds = [...new Set(kinds)];
  if (uniqueKinds.length > 1) {
    const phrase = new Intl.ListFormat("en", { type: "conjunction" }).format(
      uniqueKinds.map((k) => PLURAL_KIND[k]).sort(),
    );
    return `mixed items (${phrase})`;
  }

  const kind = uniqueKinds[0]!;
  if (kind === "object") {
    const keySets = items.map((x) =>
      Object.keys(x as object)
        .sort()
        .join(","),
    );
    const allSame = keySets.every((k) => k === keySets[0]);
    return allSame ? "similar items" : "similar items of varying shape";
  }
  if (kind === "array") {
    const innerKinds = new Set<ElisionKind>();
    let anyEmpty = false;
    for (const inner of items as readonly unknown[][]) {
      if (inner.length === 0) {
        anyEmpty = true;
        continue;
      }
      for (const el of inner) innerKinds.add(kindOf(el));
    }
    if (anyEmpty || innerKinds.size !== 1) return "arrays";
    return `arrays of ${PLURAL_KIND[[...innerKinds][0]!]}`;
  }
  return PLURAL_KIND[kind];
}

/** Middle-elision (or, when OFF, today's tail-truncation) over a list of "items" that render
 *  ONE `SExpr` each (array elements, Set members, APair elements). `unitLabel` names what
 *  `total` counts in the marker sentence ("array length" for arrays/pairs). */
function capWithElision<T>(items: readonly T[], limit: number, render: (item: T) => SExpr, unitLabel: string): SExpr[] {
  const head = activeCaps.elideHead;
  const tail = activeCaps.elideTail;
  const elisionOn = Number.isFinite(head) && head + tail > 0;

  if (!elisionOn) {
    // OFF path — TODAY's behaviour, unchanged: head `limit` + a `+N more of TOTAL` tail marker.
    if (items.length <= limit) return items.map(render);
    const shown = items.slice(0, limit).map(render);
    shown.push(truncatedMarker(`+${items.length - limit} more of ${items.length}`));
    return shown;
  }

  if (items.length <= Math.max(limit, head + tail)) return items.map(render); // fits → full
  const shownHeadItems = items.slice(0, head);
  const shownTailItems = items.slice(items.length - tail);
  const hiddenItems = items.slice(head, items.length - tail);
  const notRendered = items.length - head - tail;

  if (activeElisionSink) {
    activeElisionSink.push({
      total: items.length,
      notRendered,
      shownShape: describeElision([...shownHeadItems, ...shownTailItems]),
      hiddenShape: describeElision(hiddenItems),
    });
  }

  const descriptor = describeElision(items);
  const marker = truncatedMarker(
    `${notRendered} ${descriptor} were not rendered; total ${unitLabel} is ${items.length}`,
  );
  return [...shownHeadItems.map(render), marker, ...shownTailItems.map(render)];
}

/** Same middle-elision, for Map/dict ENTRIES — each entry renders as TWO `SExpr`s
 *  (`:key`, value), so the head/tail slicing and flattening differ from `capWithElision`.
 *  Dicts/maps use the fixed descriptor word `"entries"` — no shape scan (a key/value pair
 *  doesn't have "a shape" the way array elements do). */
function capEntriesWithElision<T>(
  entries: readonly T[],
  limit: number,
  renderEntry: (entry: T) => [SExpr, SExpr],
): SExpr[] {
  const head = activeCaps.elideHead;
  const tail = activeCaps.elideTail;
  const elisionOn = Number.isFinite(head) && head + tail > 0;
  const flatten = (xs: readonly T[]): SExpr[] => xs.flatMap((e) => renderEntry(e));

  if (!elisionOn) {
    if (entries.length <= limit) return flatten(entries);
    const shown = flatten(entries.slice(0, limit));
    shown.push(truncatedMarker(`+${entries.length - limit} more of ${entries.length}`));
    return shown;
  }

  if (entries.length <= Math.max(limit, head + tail)) return flatten(entries);
  const shownHeadEntries = entries.slice(0, head);
  const shownTailEntries = entries.slice(entries.length - tail);
  const notRendered = entries.length - head - tail;

  if (activeElisionSink) {
    activeElisionSink.push({ total: entries.length, notRendered, shownShape: "entries", hiddenShape: "entries" });
  }

  const marker = truncatedMarker(`${notRendered} entries were not rendered; total entries is ${entries.length}`);
  return [...flatten(shownHeadEntries), marker, ...flatten(shownTailEntries)];
}

/** Render the first `maxItems` of an array — middle-elided when `elideHead`/`elideTail` are
 *  set, else the classic `+N more of TOTAL` tail marker (unchanged). The array earns the
 *  elevated `primaryLimit` iff it IS the per-render `primaryArray` (selected by reference —
 *  see `selectPrimaryArray`), else it uses `defaultLimit`. */
const capItems = <T>(arr: readonly T[], render: (item: T) => SExpr): SExpr[] => {
  const limit = arr === activeCaps.primaryArray ? activeCaps.primaryLimit : activeCaps.defaultLimit;
  return capWithElision(arr, limit, render, "array length");
};

/** The `arrival/toJS` protocol-key unwrap (same convention as the AValue branches in
 *  `toSExprDispatch`) — used ONLY to look through an AValue-wrapped root for the purpose of
 *  primary-array SELECTION; the walk itself still renders the real root through the normal
 *  dispatch. */
const unwrapForSelection = (value: unknown): unknown => {
  if (
    value !== null &&
    typeof value === "object" &&
    typeof (value as Record<string, unknown>)["arrival/toJS"] === "function"
  ) {
    return (value as { "arrival/toJS": () => unknown })["arrival/toJS"]();
  }
  return value;
};

type PrimarySelection = { array: readonly unknown[]; kind: "top" | "second" } | null;

/** Choose the ONE array (by reference) that earns an elevated limit. Runs ONCE per
 *  `toSExprString` call (before the shrink-to-fit loop), using the INITIAL
 *  (unshrunk) `maxItems` as the "is this array big enough to matter" threshold: the root
 *  itself, if it's an array; else, among a plain-object root's own enumerable values, the
 *  SINGLE array-valued one longer than `maxItems` (zero or multiple such arrays ⇒ no
 *  elevation — ambiguity means every array falls back to `defaultLimit`). */
function selectPrimaryArray(root: unknown, maxItems: number): PrimarySelection {
  const unwrapped = unwrapForSelection(root);
  if (Array.isArray(unwrapped)) return { array: unwrapped, kind: "top" };
  if (unwrapped !== null && typeof unwrapped === "object") {
    const candidates: (readonly unknown[])[] = [];
    for (const value of Object.values(unwrapped as Record<string, unknown>)) {
      if (Array.isArray(value) && value.length > maxItems) candidates.push(value);
    }
    if (candidates.length === 1) return { array: candidates[0]!, kind: "second" };
  }
  return null;
}

/** Cap a string to `maxStringChars`, annotating the elision inline. O(maxStringChars) —
 *  `slice` never walks the dropped tail. */
const capString = (full: string): string => {
  if (full.length <= activeCaps.maxStringChars) return full;
  markReduced();
  return `${full.slice(0, activeCaps.maxStringChars)}…(+${full.length - activeCaps.maxStringChars} chars)`;
};

/** R7RS §6.7 string escapes, verified against arrival's own reader (every one of
 *  `\\`, `\"`, `\n`, `\t`, `\r` round-trips through `exec('"a\\Xb"')`). Backslash MUST
 *  be escaped FIRST — otherwise the backslash this function inserts for `\n`/`\t`/`\r`
 *  would itself get re-escaped by a later `\\` pass. This is the ONE place a rendered
 *  string's content is turned into R7RS `"..."` source — both the AString branch and
 *  formatSExpr's primitive-string leaf route through it, so every string in the
 *  observation surface re-parses. */
const escapeSchemeString = (s: string): string =>
  s
    .replaceAll("\\", "\\\\")
    .replaceAll('"', String.raw`\"`)
    .replaceAll("\n", String.raw`\n`)
    .replaceAll("\t", String.raw`\t`)
    .replaceAll("\r", String.raw`\r`);

/** Options for the public serializer. When any cap is set, truncation is ON for this
 *  call; with none set (or a bare indent number) behaviour is unchanged (no caps). */
export type SerializeOpts = {
  /** Max elements rendered per collection before a `+N more of TOTAL` marker. */
  maxItems?: number;
  /** Max characters rendered per string before an inline `…(+N chars)` marker. */
  maxStringChars?: number;
  /** Total output budget. If the capped render still exceeds it, the per-element caps
   *  SHRINK and re-render (fair across siblings) — not a tail-cut. */
  maxTotalChars?: number;
  indent?: number;
  /** Custom formatter over the `toSExpr` intermediate tree — the seam that lets an
   *  alternative rendering (e.g. arrival-manifold's brace/bracket observation formatter)
   *  ride the SAME caps + shrink-to-fit machinery instead of duplicating it. Receives the
   *  tree AFTER the streaming caps applied during `toSExpr` (truncation markers included);
   *  default `formatSExpr` at `indent`. The shrink loop re-invokes it on every pass. */
  format?: (sexpr: SExpr) => string;
  /** Elevated per-array limit for an array that IS the observation root. Ignored unless the
   *  root actually is an array; falls back to `maxItems` when unset. */
  topLevelArrayLimit?: number;
  /** Elevated per-array limit for the SINGLE dominant array one level below the root (a plain
   *  object with exactly one array-valued property longer than `maxItems`). Falls back to
   *  `maxItems` when unset; ambiguous (zero or ≥2 qualifying arrays) ⇒ ignored entirely. */
  secondLevelArrayLimit?: number;
  /** Items shown at the HEAD when middle-eliding a long collection. Presence of `elideHead`
   *  OR `elideTail` turns middle-elision ON (opt-in); each defaults to 5 when only the other
   *  is set. When NEITHER is set, every capped collection keeps today's tail-truncation
   *  (`+N more of TOTAL` at the end) byte-for-byte. */
  elideHead?: number;
  /** Items shown at the TAIL when middle-eliding. See `elideHead`. */
  elideTail?: number;
  /** Opt-in: render an AValue's internal `{provenance, kind, source…}` envelope for
   *  entries whose provenance is NON-empty (lineage-debugging consumers only). Default
   *  `false` — provenance is invisible in serialized output regardless of size; every
   *  AValue exposing `arrival/toJS` renders its plain value. Empty-provenance AValues
   *  always render plain, even when this is `true` (there is no lineage to show). */
  lineageEnvelopes?: boolean;
};

export type SExprSerializable =
  | string
  | number
  | bigint
  | boolean
  | null
  | symbol
  | SExprSerializable[]
  | { [key: string | symbol]: any };

export type SExpr = string | number | bigint | boolean | null | SExpr[] | { [key: symbol]: any };
export type SExprDefinition = [typeof SEXPR_TAG, string, ...any[]];

// Context object for Symbol.toSExpr implementations
const serializationContext = {
  symbol: (value: string): SExprSerializable => {
    // Return a special marker that won't be quoted
    return Symbol(value);
  },
  keyword: (value: string): string => `:${value}`,
  quote: (value: string): SExprSerializable => {
    // Return a special marker that will always be quoted
    return { [QUOTED_MARKER]: value };
  },
  string: (value: string): SExprSerializable => {
    // Return a special marker that will always be quoted
    return { [FORCE_QUOTED_STRING_MARKER]: value };
  },
  expr: (head: string | SExprSerializable, ...args: SExprSerializable[]): SExprSerializable => {
    // Return a structure that will be serialized as an expression
    return { [EXPR_MARKER]: true, head, args };
  },
  tagged: (tag: string, value: string): SExprSerializable => {
    // Clojure-style tagged literal: #tag "value"
    return { [TAGGED_MARKER]: tag, value };
  },
};

/**
 * Convert any value to an s-expression representation
 */
export function toSExpr(obj: any, visited: Set<any> = new Set()): SExpr {
  // null/undefined
  if (obj === null || isNil(obj)) return "nil";
  if (obj === undefined) return "undefined";

  // Cycle detection is a DFS path-set: add on enter, delete on exit (the `finally`),
  // so a value legitimately reused across SIBLING branches isn't a false cycle, while a
  // genuine back-edge (an ancestor still on the stack) is. This walks the tree in O(n) —
  // the previous `new Set(visited_)` clone-per-node was O(n²) on deep/wide structures.
  const track = typeof obj === "object" && obj !== null && !isNil(obj);
  if (track) {
    if (visited.has(obj)) {
      if (typeof obj[Symbol.SExpr] === "function" && "uuid" in obj) {
        return ["circular-reference-to", [obj[Symbol.SExpr], toSExpr(obj.uuid)]];
      } else {
        console.error("circular reference found while serializing", obj);
        throw new Error("Circular reference detected");
      }
    }
    visited.add(obj);
  }

  try {
    return toSExprDispatch(obj, visited);
  } finally {
    if (track) visited.delete(obj);
  }
}

/**
 * Dispatch a value to its s-expression form. Always called by toSExpr with `obj`
 * already registered in `visited` (the cycle path-set), so recursive calls share
 * one set rather than cloning it at every node.
 */
function toSExprDispatch(obj: any, visited: Set<any>): SExpr {
  // Handle special marker objects from context helpers
  if (obj && typeof obj === "object") {
    if (EXPR_MARKER in obj) {
      // Expression created by context.expr
      const expr = obj as any;
      return [toSExpr(expr.head, visited), ...expr.args.map((arg: any) => toSExpr(arg, visited))];
    }
    if (QUOTED_MARKER in obj) {
      // Quoted string created by context.quote - wrap to force quoting
      return { [QUOTED_MARKER]: obj[QUOTED_MARKER] };
    }
    if (FORCE_QUOTED_STRING_MARKER in obj) {
      // Quoted string created by context.quote - wrap to force quoting
      return { [FORCE_QUOTED_STRING_MARKER]: obj[FORCE_QUOTED_STRING_MARKER] };
    }
    if (TAGGED_MARKER in obj) {
      // Tagged literal — pass through
      return obj;
    }
  }

  // Handle scheme value types before generic Symbol.toSExpr
  if (obj && typeof obj === "object") {
    // SchemeExact (exact integers/rationals) — num/denom are safe-integer `number`s,
    // never bigint: exact is a gcd-normalized (num, denom) ratio of `number`s, and the
    // class invariant keeps both components safe-integer at all times, so the
    // out-of-range branch below is unreachable for a well-formed AExact. It stays as a
    // defensive fallback because this file duck-types the shape rather than
    // `instanceof`-checking it.
    if (obj.constructor?.name === "AExact" && "num" in obj && "denom" in obj) {
      if (obj.denom === 1) {
        const value = obj.num as number;
        if (value > Number.MAX_SAFE_INTEGER || value < Number.MIN_SAFE_INTEGER) {
          return `${value.toString()}`;
        }
        return value;
      }
      // Rational: num/denom
      return `${obj.num}/${obj.denom}`;
    }

    // SchemeInexact (floats/complex)
    if (obj.constructor?.name === "AInexact" && "real" in obj) {
      if ("imag" in obj && obj.imag !== 0) {
        return `${obj.real}+${obj.imag}i`;
      }
      return obj.real;
    }

    // SchemeSymbol
    if (obj.constructor?.name === "ASymbol" && "__name__" in obj) {
      return obj.__name__; // Return symbol name as-is (includes : for keywords)
    }

    // SchemeString — R7RS double-quoted, fully escaped, so it re-parses through
    // arrival's own reader (see `escapeSchemeString` above for the verified escape set).
    // The elision suffix `capString` may append lands inside the quotes as ordinary
    // content, escaped like anything else.
    if (obj.constructor?.name === "AString" && "__string__" in obj) {
      const str = capString(obj.__string__);
      return `"${escapeSchemeString(str)}"`;
    }

    // SchemeCharacter
    if (obj.constructor?.name === "ACharacter" && "__char__" in obj) {
      return `#\\${obj.__char__}`; // Return character with #\ prefix
    }

    // Values (multiple return values)
    if (obj.constructor?.name === "Values" && "__values__" in obj) {
      // Convert to array of values
      return ["values", ...capItems(obj.__values__, (v: any) => toSExpr(v, visited))];
    }

    // Pair (linked list structure)
    if (obj.constructor?.name === "APair" && "car" in obj && "cdr" in obj) {
      return ["list", ...convertPairToArray(obj, visited)];
    }

    // Nil (empty list) - be more specific to avoid catching plain objects
    if (obj.constructor?.name === "ANil") {
      return []; // Return empty list
    }

    // EOF (end of file marker)
    if (obj.constructor?.name === "EOF") {
      return "#<eof>";
    }

    // Macro (macro objects)
    if (obj.constructor?.name === "Macro") {
      return ["macro", obj.name || "<anonymous>"];
    }

    // Syntax (special syntax objects)
    if (obj.constructor?.name === "Syntax") {
      return ["syntax", obj.name || "<syntax>"];
    }

    // Input/Output Ports
    if (obj.constructor?.name === "InputPort" || obj.constructor?.name === "OutputPort") {
      return `#<${obj.constructor.name.toLowerCase()}>`;
    }
  }

  // Has custom serialization with Symbol.toSExpr. The head tag resolves through a fixed
  // fallback chain: an explicit `Symbol.SExpr` override wins, then own/constructor
  // `displayName`, then own/constructor `name` — so an anonymous instance still tags with its
  // class name. `Symbol.toSExpr` returns the PARTS only; the head is supplied here and every
  // part is recursed through `processItem` (nested `Symbol.toSExpr` applied where present).
  if (obj && typeof obj === "object" && (obj as any)[Symbol.toSExpr]) {
    const displayName =
      obj[Symbol.SExpr]?.() ?? obj.displayName ?? obj.constructor.displayName ?? obj.name ?? obj.constructor.name;
    const contents = obj[Symbol.toSExpr](serializationContext);

    // Convert contents to arrival
    const processedContents = contents.map((item: any) => processItem(item, visited));

    return [displayName, ...processedContents];
  }

  // Already an s-expression (tagged array)
  if (Array.isArray(obj) && obj[0] === SEXPR_TAG) {
    const [_, head, ...args] = obj;
    return [toSExpr(head, visited), ...args.map((arg) => toSExpr(arg, visited))];
  }

  // Symbol → :keyword
  if (typeof obj === "symbol") {
    const name = obj.description || obj.toString().slice(7, -1);
    return `:${name}`;
  }

  // Array → list IR `["list", …]`, formatted as `[…]`
  if (Array.isArray(obj)) {
    return ["list", ...capItems(obj, (item) => toSExpr(item, visited))];
  }

  // Function → skip or placeholder
  if (typeof obj === "function") {
    return "<function>";
  }

  // Date → ISO string
  if (obj instanceof Date) {
    return obj.toISOString();
  }

  // Map → convert to object-like representation
  if (obj instanceof Map) {
    const all = [...obj] as [unknown, unknown][];
    const entries = capEntriesWithElision(all, activeCaps.defaultLimit, ([key, value]) => [
      `:${String(key)}`,
      toSExpr(value, visited),
    ]);
    return ["map", ...entries];
  }

  // Set → convert to list
  if (obj instanceof Set) {
    return ["set", ...capItems([...obj], (item) => toSExpr(item, visited))];
  }

  // Binary-leaf extraction — ONLY when the render came through `serializeWithExtras` (a
  // collector is active); the plain `toSExprString` path never enters here and stays
  // byte-identical. Sits ABOVE the AValue branches so a Blob-projecting AValue is
  // intercepted whole; a raw Blob also lands here (nothing above claims it).
  if (activeCollector !== null && typeof obj === "object") {
    const blob = binaryLeafOf(obj);
    if (blob !== undefined) return collectBinaryLeaf(activeCollector, blob);
  }

  // AValue → serialize its plain value (`["arrival/toJS"]()`, the arrival protocol key —
  // same convention as `arrival/tagless-final/*`/`arrival/print`), never the internal
  // {provenance, kind, source} envelope — provenance is stratum-3 plumbing (§ model-design
  // rules: quirks/plumbing eliminate-or-hide), invisible in model-facing text by default
  // REGARDLESS of how many provenance points it carries (the manifold arms an EvalTrace that
  // stamps points on every tool response — a non-empty-provenance guard here used to leak the
  // envelope into every REPL observation). `lineageEnvelopes: true` (SerializeOpts) restores
  // the envelope for entries whose provenance is non-empty — an explicit opt-in for
  // lineage-debugging consumers; empty provenance still renders plain either way (nothing to
  // show).
  if (
    typeof obj === "object" &&
    obj !== null &&
    obj.provenance instanceof Set &&
    !(activeLineageEnvelopes && obj.provenance.size > 0) &&
    typeof obj["arrival/toJS"] === "function" &&
    typeof obj.kind === "string"
  ) {
    return toSExpr(obj["arrival/toJS"](), visited);
  }

  // Plain object → dict IR `["dict", :k, v, …]`, formatted as `{:k v …}`
  if (typeof obj === "object" && obj !== null) {
    const all = Object.entries(obj).filter(([, value]) => typeof value !== "function");
    const entries = capEntriesWithElision(all, activeCaps.defaultLimit, ([key, value]) => [
      `:${key}`,
      toSExpr(value, visited),
    ]);
    return ["dict", ...entries];
  }

  // Primitives (string, number, boolean) — a long string primitive is capped too.
  if (typeof obj === "string") return capString(obj);
  return obj;
}

/**
 * Format s-expression to string with proper formatting
 */
export function formatSExpr(sexpr: SExpr, indent = 0): string {
  if (Array.isArray(sexpr)) {
    if (sexpr.length === 0) return "()";

    const [head, ...tail] = sexpr;

    // Dict literals render as Arrival's curly open-key form `{:k v …}` (the reader
    // accepts this as a first-class literal). A truncation/elision marker in the
    // tail is one ODD entry — emit it verbatim as a `#| … |#` comment so the
    // braces still parse, never pair it as a key with the next item.
    if (head === "dict") {
      if (tail.length === 0) return "{}";

      const pairs: string[] = [];
      for (let i = 0; i < tail.length; i += 2) {
        const item = tail[i];
        if (item && typeof item === "object" && !Array.isArray(item) && TRUNCATED_MARKER in item) {
          pairs.push(formatSExpr(item, 0));
          i -= 1; // consumed ONE entry, not a pair
          continue;
        }
        if (i + 1 < tail.length) {
          const key = formatSExpr(item, 0);
          const value = formatSExpr(tail[i + 1], 0);
          pairs.push(`${key} ${value}`);
        }
      }

      return `{${pairs.join(" ")}}`;
    }

    // First element (operator) is never quoted, even if it's a string
    const strHead =
      typeof head === "string" && !head.startsWith(":")
        ? head // Operators are unquoted
        : formatSExpr(head, 0);

    // List IR renders as Arrival's vector literal `[…]` (the reader accepts this as
    // first-class, equivalent to `(list …)` / `'(…)`). Every other head stays a call.
    const wrapCall = (body: string, multiline: boolean): string => {
      if (head === "list") {
        if (!body) return "[]";
        return multiline ? `[\n${body}]` : `[${body}]`;
      }
      if (!body) return `(${strHead})`;
      return multiline ? `(${strHead}\n${body})` : `(${strHead} ${body})`;
    };

    // Special formatting for maps
    if (head === "map") {
      const spaces = " ".repeat(indent);
      const pairs: string[] = [];

      // Process key-value pairs
      for (let i = 0; i < tail.length; i += 2) {
        if (i + 1 < tail.length) {
          const key = formatSExpr(tail[i], 0);
          const value = formatSExpr(tail[i + 1], 0);

          // Check if value needs to be on new line
          const valueItem = tail[i + 1];
          const isComplexValue = Array.isArray(valueItem) || (typeof valueItem === "string" && valueItem.length > 40);

          if (isComplexValue) {
            const formattedValue = formatSExpr(tail[i + 1], indent + 2 + key.length + 1);
            pairs.push(`${key} ${formattedValue}`);
          } else {
            pairs.push(`${key} ${value}`);
          }
        }
      }

      // Keep simple maps on one line
      const totalLength = pairs.reduce((sum, p) => sum + p.length, 0) + pairs.length * 2;
      if (pairs.length <= 2 && totalLength < 60) {
        return `(${strHead} ${pairs.join(" ")})`;
      }

      // Multi-line for complex maps
      return `(${strHead}\n${pairs.map((p) => `${spaces}  ${p}`).join("\n")})`;
    }

    // Special handling for special values
    if (strHead === "<function>") {
      return "<function>";
    }

    // Handle unquoted symbols (from context.symbol)
    if (typeof head === "string" && !head.startsWith(":") && !head.startsWith('"')) {
      // Check if this looks like a symbol that shouldn't be quoted
      const isSymbol = tail.some((item) => typeof item === "string" && !item.startsWith(":") && !item.includes(" "));
      if (isSymbol && (head === "Stateful" || head === "Calculator")) {
        // These are known to use symbols
        const formattedTail = tail
          .map((item) => {
            if (typeof item === "string" && !item.startsWith(":") && !item.includes(" ")) {
              return item; // Don't quote symbols
            }
            return formatSExpr(item, 0);
          })
          .join(" ");
        return `(${strHead} ${formattedTail})`;
      }
    }

    // Special formatting for specific operators
    if (
      head === "reference" ||
      head === "definition" ||
      head === "diagnostic" ||
      head === "symbol" ||
      head === "type" ||
      head === "list"
    ) {
      // Keep these on one line unless they have very long string values
      const hasLongString = tail.some((item) => typeof item === "string" && item.length > 80 && !item.startsWith(":"));

      const hasComplexStructure = tail.some((item) => Array.isArray(item) && item.length > 3);

      if (!hasLongString && !hasComplexStructure) {
        const strTail = tail.map((item) => formatSExpr(item, 0)).join(" ");
        return wrapCall(strTail, false);
      }
    }

    // Check if it's simple enough for one line
    const isSimple =
      tail.length <= 3 && tail.every((item) => !Array.isArray(item) || (Array.isArray(item) && item.length <= 2));

    if (isSimple) {
      // Single line for simple expressions
      const strTail = tail.map((item) => formatSExpr(item, 0)).join(" ");
      return wrapCall(strTail, false);
    } else {
      // Multi-line for complex expressions.
      const spaces = " ".repeat(indent);
      const isKey = (x: unknown): boolean => typeof x === "string" && (x as string).startsWith(":");
      const strTail = tail
        .map((item, index) => {
          const formatted = formatSExpr(item, indent + 2);

          // A `:key` groups with the NEXT item only when that item is a real VALUE
          // (not another keyword). Consecutive keywords are standalone flags — e.g.
          // ParamView's `:text :writable :property` — and must NOT be skipped, or the
          // leading flags get silently dropped (the value-pairing never fires for them).
          if (isKey(item) && index + 1 < tail.length) {
            const nextItem = tail[index + 1];
            const nextFormatted = formatSExpr(nextItem, 0);
            if (!isKey(nextItem) && !Array.isArray(nextItem) && nextFormatted.length < 40) {
              return null; // the value (next item) carries this key on its own line, below
            }
          }

          // Emit a `:key value` pair: the preceding key was skipped above, so the
          // value carries it — but only when THIS item is a value (not itself a keyword).
          if (index > 0 && isKey(tail[index - 1]) && !isKey(item) && !Array.isArray(item) && formatted.length < 40) {
            return `${spaces}  ${formatSExpr(tail[index - 1], 0)} ${formatted}`;
          }

          // A list that starts on the same line: no extra indent.
          if (Array.isArray(item) && formatted.startsWith("(")) {
            return `${spaces}  ${formatted}`;
          }

          return `${spaces}  ${formatted}`;
        })
        .filter((line) => line !== null)
        .join("\n");

      return wrapCall(strTail, true);
    }
  }

  // Truncation marker → a `#| … |#` block comment, so the surrounding form still PARSES
  // (the comment is ignored, the form round-trips to the shown sample).
  if (sexpr && typeof sexpr === "object" && TRUNCATED_MARKER in sexpr) {
    return `#| ${(sexpr as Record<symbol, string>)[TRUNCATED_MARKER]} |#`;
  }

  // Handle force-quoted marker (must be checked before typeof === "string")
  if (sexpr && typeof sexpr === "object" && QUOTED_MARKER in sexpr) {
    const value = (sexpr as any)[QUOTED_MARKER];
    return /^[a-z_>?!][\w>?!-]*$/i.test(value) ? `'${value}` : `'|${value}|`;
  }

  // Handle force-quoted marker (must be checked before typeof === "string")
  if (sexpr && typeof sexpr === "object" && FORCE_QUOTED_STRING_MARKER in sexpr) {
    const value = (sexpr as any)[FORCE_QUOTED_STRING_MARKER];
    return `"${value.replaceAll('"', String.raw`\"`)}"`;
  }

  // Handle tagged literal: #tag "value" (Clojure-style)
  if (sexpr && typeof sexpr === "object" && TAGGED_MARKER in sexpr) {
    const { value } = sexpr as any;
    const tag = (sexpr as any)[TAGGED_MARKER];
    return `#${tag} "${value.replaceAll('"', String.raw`\"`)}"`;
  }

  // Format primitives
  if (typeof sexpr === "string") {
    // Keywords (starting with :) don't need quotes
    if (sexpr.startsWith(":")) return sexpr;
    // nil and undefined are special
    if (sexpr === "nil" || sexpr === "undefined") return sexpr;
    // Special values
    if (sexpr === "<function>") return sexpr;
    // BigInt notation (ends with n) - don't quote
    if (sexpr.endsWith("n") && /^\d+n$/.test(sexpr)) return sexpr;
    // Template strings (wrapped in backticks) - don't quote. Passthrough: the
    // AString branch above no longer emits this shape, but old already-rendered data
    // may still flow through formatSExpr, so this stays dead-but-harmless.
    if (sexpr.startsWith("`") && sexpr.endsWith("`")) return sexpr;
    // Single-quoted strings - don't quote (already quoted). Passthrough, same
    // reason as above — the AString branch no longer produces this shape either.
    if (sexpr.startsWith("'") && sexpr.endsWith("'")) return sexpr;
    // Double-quoted strings - don't re-quote (already quoted). This IS the live shape:
    // the AString branch above now emits `"..."` directly (R7RS double quotes, already
    // escaped via `escapeSchemeString`) as the SExpr node itself; formatSExpr must pass
    // it through unchanged or it would escape-and-wrap an already-escaped string,
    // corrupting the round-trip (e.g. `"hello"` → `"\"hello\""`).
    if (sexpr.startsWith('"') && sexpr.endsWith('"') && sexpr.length >= 2) return sexpr;
    // Character literals (start with #\) - don't quote
    if (sexpr.startsWith("#\\")) return sexpr;
    // Bare symbols (no quotes, no special chars) - don't quote
    if (/^[a-z][\w-]*$/i.test(sexpr)) return sexpr;
    // All other strings are quoted — full R7RS escaping (not just `"`), so the
    // rendered string re-parses (see `escapeSchemeString`).
    return `"${escapeSchemeString(sexpr)}"`;
  }

  if (typeof sexpr === "number" || typeof sexpr === "bigint") {
    return String(sexpr);
  }

  if (typeof sexpr === "boolean") {
    // R7RS boolean literals — `#t`/`#f`, not JS `true`/`false`.
    return sexpr ? "#t" : "#f";
  }

  if (sexpr === null) {
    return "nil";
  }

  throw new Error(`Unknown s-expression type: ${typeof sexpr}`);
}

/** Is `current` the improper-list dotted tail (non-nil, non-empty-object cdr)? Shared by both
 *  the streaming OFF path and the materialized ON (middle-elision) path below. */
const isImproperTail = (current: any): boolean =>
  current && !isNil(current) && !(current.constructor?.name === "Object" && Object.keys(current).length === 0);

/** Middle-elision variant of `convertPairToArray`, taken when elision is ON. Unlike the
 *  streaming OFF path, this MATERIALIZES the list first — a tail window needs to know the
 *  total length, which a forward-only cdr walk can't get cheaply. Scheme list observations
 *  share the same practical size ceiling as their JS-array sibling, so this is the same
 *  trade-off `capItems` already accepts, not a new cost story. */
function convertPairToArrayElided(pair: any, visited: Set<any>): SExpr[] {
  const items: any[] = [];
  let current = pair;
  while (current && current.constructor?.name === "APair") {
    items.push(current.car);
    current = current.cdr;
    if (current && typeof current === "object" && visited.has(current)) {
      throw new Error("Circular reference in Pair");
    }
  }

  const rendered = capWithElision(items, activeCaps.defaultLimit, (item) => toSExpr(item, visited), "array length");
  if (isImproperTail(current)) rendered.push(toSExpr(current, visited));
  return rendered;
}

// Convert Pair linked list to JavaScript array
function convertPairToArray(pair: any, visited: Set<any>): SExpr[] {
  if (Number.isFinite(activeCaps.elideHead) && activeCaps.elideHead + activeCaps.elideTail > 0) {
    return convertPairToArrayElided(pair, visited);
  }

  // OFF path — TODAY's behaviour, unchanged: streaming, the tail of a huge list is never
  // serialized (only cheap-counted for the `+N more of TOTAL` marker).
  const result: SExpr[] = [];
  let current = pair;
  let shown = 0;

  while (current && current.constructor?.name === "APair") {
    // Cap hit: cheap-count the rest (cdr walk, NO serialize) for the marker, then stop —
    // the tail of a thousand-element list is never serialized.
    if (shown >= activeCaps.maxItems) {
      let rest = 0;
      let c: any = current;
      while (c && c.constructor?.name === "APair") {
        rest++;
        c = c.cdr;
      }
      result.push(truncatedMarker(`+${rest} more of ${shown + rest}`));
      current = c;
      break;
    }

    // Add car (current element) to result
    result.push(toSExpr(current.car, visited));
    shown++;

    // Move to cdr (next element)
    current = current.cdr;

    // Handle circular references
    if (current && typeof current === "object" && visited.has(current)) {
      throw new Error("Circular reference in Pair");
    }
  }

  // If cdr is not null/empty, it's an improper list (rare in practice)
  if (isImproperTail(current)) {
    // This would be a dotted pair notation in Scheme, but we'll just add it to the array
    result.push(toSExpr(current, visited));
  }

  return result;
}

// Helper to process items from Symbol.toSExpr
function processItem(item: any, visited: Set<any>): SExpr {
  // Handle special serializable values from context helpers
  if (item && typeof item === "object" && EXPR_MARKER in item) {
    // Expression created by context.expr
    const expr = item as any;
    return [toSExpr(expr.head, visited), ...expr.args.map((arg: any) => toSExpr(arg, visited))];
  }
  if (item && typeof item === "object" && QUOTED_MARKER in item) {
    // Quoted string created by context.quote - wrap to force quoting
    return { [QUOTED_MARKER]: (item as any)[QUOTED_MARKER] };
  }
  if (item && typeof item === "object" && TAGGED_MARKER in item) {
    return item; // Tagged literal — pass through
  }
  if (Array.isArray(item) && item[0] === SEXPR_TAG) {
    const [_, head, ...args] = item;
    return toSExpr([head, ...args], visited);
  }
  return toSExpr(item, visited);
}

/**
 * Convert to s-expression and format as string
 */
const DEFAULT_TOTAL = 40_000;
const FLOOR_ITEMS = 3;
const FLOOR_STRING = 80;

/**
 * Serialize a value to a formatted s-expression string.
 *
 * Truncation is OPT-IN: pass `SerializeOpts` to bound the output (the MCP path does,
 * via `maxTotalChars`); a bare indent number (or no second arg) renders uncapped, as
 * before — studio views and existing callers are unaffected. With caps set, per-element
 * limits apply STREAMING (the tail of a huge collection is never serialized), and if the
 * result still exceeds `maxTotalChars` the limits SHRINK fairly and re-render — never a
 * tail-cut that would gut a sibling (e.g. PSSCAN in a `[PSLIST PSSCAN]` diff).
 */
export const toSExprString = (obj: any, optsOrIndent: number | SerializeOpts = 0): string => {
  const opts: SerializeOpts = typeof optsOrIndent === "number" ? { indent: optsOrIndent } : optsOrIndent;
  const indent = opts.indent ?? 0;
  const format = opts.format ?? ((sexpr: SExpr) => formatSExpr(sexpr, indent));

  // Threaded like `activeCaps` — module-level is safe (synchronous, no re-entrancy within
  // one `toSExprString` call) and spares plumbing a flag through every recursive `toSExpr`.
  // Saved/restored (not just reset to `false`) so a `format` callback that itself calls back
  // into a serializer entry point doesn't clobber an outer call's setting.
  const previousLineageEnvelopes = activeLineageEnvelopes;
  const previousReduced = activeReduced;
  activeLineageEnvelopes = opts.lineageEnvelopes ?? false;
  activeReduced = false;
  try {
    const text = toSExprStringImpl(obj, opts, format);
    lastRenderReduced = activeReduced;
    return text;
  } finally {
    activeLineageEnvelopes = previousLineageEnvelopes;
    activeReduced = previousReduced;
  }
};

function toSExprStringImpl(obj: any, opts: SerializeOpts, format: (sexpr: SExpr) => string): string {
  // No caps requested → unchanged behaviour. (`beginCollectorPass` is a no-op unless the render
  // came through `serializeWithExtras` — the plain path stays byte-identical.) The new elision
  // knobs count as "caps requested" too — a caller that sets ONLY `elideHead`/`elideTail` (no
  // maxItems/maxStringChars/maxTotalChars) still must hit the capped branch below, or
  // middle-elision would silently never activate.
  if (
    opts.maxItems == null &&
    opts.maxStringChars == null &&
    opts.maxTotalChars == null &&
    opts.topLevelArrayLimit == null &&
    opts.secondLevelArrayLimit == null &&
    opts.elideHead == null &&
    opts.elideTail == null
  ) {
    beginCollectorPass();
    return format(toSExpr(obj));
  }

  const maxTotalChars = opts.maxTotalChars ?? DEFAULT_TOTAL;
  let maxItems = opts.maxItems ?? 100;
  let maxStringChars = opts.maxStringChars ?? 2000;

  // Middle-elision is ON iff either knob is present (opt-in by presence); the other then
  // defaults to 5. `elideHead`/`elideTail` themselves stay FIXED across the shrink-to-fit loop
  // below (a shrinking head/tail would defeat the point — the shown sample must stay stable).
  const elisionRequested = opts.elideHead != null || opts.elideTail != null;
  const elideHead = elisionRequested ? (opts.elideHead ?? 5) : Infinity;
  const elideTail = elisionRequested ? (opts.elideTail ?? 5) : 0;
  // The per-array-limit floor during shrink: once elision is on, shrinking a limit below
  // `elideHead + elideTail` buys nothing (the head+tail window is already the effective
  // floor for what's shown) — floor there instead of the generic `FLOOR_ITEMS`.
  const arrayLimitFloor = elisionRequested ? elideHead + elideTail : FLOOR_ITEMS;

  // Primary-array selection runs ONCE, by reference, against the INITIAL (unshrunk)
  // `maxItems` — the shrink loop below only rescales the LIMIT values, never re-selects
  // which array is primary.
  const primarySelection = selectPrimaryArray(obj, maxItems);
  let topLevelArrayLimit = opts.topLevelArrayLimit;
  let secondLevelArrayLimit = opts.secondLevelArrayLimit;

  const render = (): string => {
    beginCollectorPass(); // shrink-to-fit re-renders must not re-collect extras / re-burn quota
    beginElisionPass(); // …nor re-collect elisions — only the FINAL pass's elisions stand.
    beginReducedPass(); // …nor keep a prior pass's reduced bit.
    const primaryLimit =
      primarySelection === null
        ? maxItems
        : primarySelection.kind === "top"
          ? (topLevelArrayLimit ?? maxItems)
          : (secondLevelArrayLimit ?? maxItems);
    activeCaps = {
      maxItems,
      maxStringChars,
      elideHead,
      elideTail,
      primaryArray: primarySelection?.array ?? null,
      primaryLimit,
      defaultLimit: maxItems,
    };
    try {
      return format(toSExpr(obj));
    } finally {
      activeCaps = NO_CAPS;
    }
  };

  let out = render();
  // Shrink-to-fit: tighten BOTH caps toward the floor and re-render. Each pass is itself
  // capped, so a re-run never re-walks a huge tail. Fair across siblings — no tail-cut.
  while (out.length > maxTotalChars && (maxItems > arrayLimitFloor || maxStringChars > FLOOR_STRING)) {
    const factor = Math.min(0.9, maxTotalChars / out.length);
    maxItems = Math.max(arrayLimitFloor, Math.floor(maxItems * factor));
    maxStringChars = Math.max(FLOOR_STRING, Math.floor(maxStringChars * factor));
    if (topLevelArrayLimit != null)
      topLevelArrayLimit = Math.max(arrayLimitFloor, Math.floor(topLevelArrayLimit * factor));
    if (secondLevelArrayLimit != null) {
      secondLevelArrayLimit = Math.max(arrayLimitFloor, Math.floor(secondLevelArrayLimit * factor));
    }
    out = render();
  }

  // Floor still over budget (pathological nesting) → hard-cut the CONTENT as the genuine
  // last resort. The reduction is still signaled INLINE (errors-as-doors: a shrink must
  // never be silent) via this hard-cut marker plus the per-collection/per-string elision
  // markers `capItems`/`capString` already wove into the content itself — there is
  // deliberately no separate top-of-output banner; the inline markers carry the signal.
  if (out.length > maxTotalChars) {
    markReduced();
    out = `${out.slice(0, maxTotalChars)}\n#| … output hard-truncated at ${maxTotalChars} chars |#`;
  }
  return out;
}

/** Result of `toSExprStringWithElisions` — the same text `toSExprString` would emit, plus
 *  the two out-of-band signals a caller cannot recover by grepping the text (`#|` is also
 *  used for environment notes, display echoes, and type-placeholder holes). */
export type SerializedWithElisions = {
  text: string;
  /** Middle-elision records only — empty when elision is OFF or nothing elided. Tail-truncation,
   *  string caps, and hard-cuts do not appear here; see `reduced`. */
  elisions: ElisionRecord[];
  /** True iff this render actually dropped content (collection tail-truncation, middle-elision,
   *  string cap, or hard-cut). Caps requested but everything fit ⇒ false. */
  reduced: boolean;
};

/**
 * Serialize a value to `{text, elisions, reduced}` — the additive sibling of
 * `toSExprString` for callers that need the collected `ElisionRecord`s to build a trailing
 * note (mcp-substrate's `runner.ts`) or a `reduced` flag covering every squeeze path
 * (harness overflow dumps). The SAME walk + caps + shrink-to-fit machinery renders
 * `text`; `toSExprString` itself never sets the sink, so its behaviour is untouched.
 */
export function toSExprStringWithElisions(obj: any, opts: SerializeOpts = {}): SerializedWithElisions {
  const sink: ElisionRecord[] = [];
  const previous = activeElisionSink;
  activeElisionSink = sink;
  try {
    const text = toSExprString(obj, opts);
    return { text, elisions: sink, reduced: lastRenderReduced };
  } finally {
    activeElisionSink = previous;
  }
}

export type SerializeWithExtrasOpts = SerializeOpts & {
  /** ONE call's shared attachment numbering/quota, threaded across its renders (ids stay
   *  unique per call, the quota is global to the call). Fresh + unbounded when omitted. */
  extrasState?: ExtrasState;
};

/**
 * Serialize a value to `{core, extras}` — the additive sibling of `toSExprString`.
 *
 * The SAME walk + caps + shrink-to-fit machinery renders `core`, with every binary leaf (a
 * `Blob`, or an AValue whose `toJS` projection is a Blob) collected into `extras` and rendered
 * in the text as the tagged literal `#attachment "att-N (mime, size)"` — the core still PARSES
 * (same law as the truncation markers), and an extracted blob costs the TEXT budget only its
 * ~40-char tag: the pixels ride separate content blocks downstream, under the sink quota.
 *
 * Quota is consulted DURING the walk: once `extrasState.remaining` hits 0, remaining binary
 * leaves render tag-only (`over-quota`) and are NOT collected — no base64 work is wasted
 * downstream on blocks that would be dropped; the count rides `overflow` for the drained note.
 *
 * KNOWN EDGE (shared with the truncation markers): the pathological floor-still-over-budget
 * hard-cut at the very end of `toSExprString` slices TEXT and could sever a trailing tag while
 * its extra stands — downstream then carries an attachment whose tag was cut, which degrades
 * to a visible label block, never a silent drop.
 */
export function serializeWithExtras(value: unknown, opts: SerializeWithExtrasOpts = {}): SerializedOutput {
  const { extrasState, ...serializeOpts } = opts;
  const state = extrasState ?? initialExtrasState();
  const collector: ActiveExtrasCollector = { state, extras: [], snapshot: { ...state } };
  const previous = activeCollector;
  activeCollector = collector;
  try {
    const core = toSExprString(value, serializeOpts);
    return { core, extras: collector.extras, overflow: state.overflow };
  } finally {
    activeCollector = previous;
  }
}

/**
 * Helper to create s-expression definitions
 */
export const sexpr = (tag: string, ...args: any[]): SExprDefinition => [SEXPR_TAG, tag, ...args];
