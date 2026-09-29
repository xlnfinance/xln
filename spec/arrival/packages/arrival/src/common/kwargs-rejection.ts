// kwargs-rejection — the kwargs zod-decode humanizer + strict decode door
// (arrival-manifold docs/args-error-reporting-v2.md §2.5).
//
// This file OWNS the frozen rejection strings — the manifold's error-contract freezes
// line HEADS against them; mcp-substrate's own-decode clue family parses `:<param> —`
// line heads off them. Change them only with the design doc + the manifold re-freeze
// in the same motion.
//
// Grammar:
//   <qualified>: arguments rejected — <n> problem(s):
//     :<path> — <humanized issue>
//
// Two silent-strip hazards close here:
//   - key level: `z.object`'s default strip mode drops a misspelled OPTIONAL key with
//     no rejection at all → `z.strictObject` closes it (design doc §2.5);
//   - value level: `z.object` accepts ANY typeof-object input — a boxed AValue sent
//     where a field declares a plain-JS shape "passes" by stripping to `{}` → the
//     scheme-face guard below rejects it (an AValue can only be consumed by a schema
//     with a scheme face, i.e. one registered in scheme-zod's name registry — every
//     codec and `z.schemeValue`/`z.dynamic` are; plain `z.object`/`z.record` are not).

import { ZodError, ZodType, type ZodRawShape } from "zod";
import * as z from "./scheme-zod/index.js";
import { AValue } from "../values/primitives/AValue.js";
import { is_callable_value } from "../values/value-guards.js";
import { ArrivalError, type ErrorClass } from "../errors.js";
import { suggestFromVocabulary } from "../unbound-variable.js";

/** Same convention as arrival-manifold bind.ts's `previewOf` (design doc §2.5). */
const PREVIEW_MAX = 60;

function previewOf(v: unknown): string {
  const rendered = JSON.stringify(v) ?? String(v);
  return rendered.length > PREVIEW_MAX ? `${rendered.slice(0, PREVIEW_MAX)}...` : rendered;
}

/** The scheme-visible type word: an AValue names its own `kind` ("string", "number",
 *  "dict", …); raw JS falls back to typeof (+ array/null splits). */
function kindOf(v: unknown): string {
  if (v instanceof AValue) return v.kind;
  if (Array.isArray(v)) return "array";
  if (v === null) return "null";
  return typeof v;
}

/** The JS face of a value for previewing — an AValue projects through its own
 *  `arrival/toJS` protocol (never throws into the door path). A CALLABLE previews
 *  through `arrival/print` instead: its toJS is the reverse-membrane host fn (a real
 *  crossing, not a face), and previewing must display, never cross. */
function faceOf(v: unknown): unknown {
  if (v instanceof AValue) {
    if (is_callable_value(v)) return v["arrival/print"]();
    try {
      return v["arrival/toJS"]();
    } catch {
      return String(v);
    }
  }
  return v;
}

function valueAtPath(sent: unknown, path: readonly PropertyKey[]): unknown {
  let v: unknown = sent;
  for (const seg of path) {
    if (v === null || typeof v !== "object") return undefined;
    v = (v as Record<PropertyKey, unknown>)[seg];
  }
  return v;
}

/** One rendered problem line: `  :<path> — <detail>`. */
type ProblemLine = string;

/** The declared-type word for a field: a scheme-face codec answers its registry name
 *  ("number", "string", "dict", …); a plain zod schema answers its `def.type`. */
function declaredTypeOf(fieldSchema: unknown): string {
  return z.lookupName(fieldSchema) ?? (fieldSchema as { def?: { type?: string } })?.def?.type ?? "the declared type";
}

function issueLines(
  issue: ZodError["issues"][number],
  sent: Record<string, unknown>,
  shape: ZodRawShape,
): ProblemLine[] {
  const path = issue.path.map(String).join(".");
  // unrecognized_keys carries an EMPTY path and its own key list — render one line PER
  // key so every line keeps the `:<param> —` head the own-decode clue family parses. A key
  // NEAR a declared param (edit distance / canonical-form, via the same vocabulary-sourced
  // machinery unbound-variable.ts uses for symbol typos) gets a did-you-mean suffix — this
  // is the reject-and-hard-error PATH; a key with no near declared param never reaches here
  // at all when it's the ONLY problem (see `tryDropFarUnknownKeys` below).
  if (issue.code === "unrecognized_keys") {
    const declaredKeys = Object.keys(shape);
    return issue.keys.map((k) => {
      const [suggestion] = suggestFromVocabulary(k, declaredKeys);
      return suggestion ? `  :${k} — unknown key (did you mean :${suggestion}?)` : `  :${k} — unknown key`;
    });
  }
  const sentVal = valueAtPath(sent, issue.path);
  // Absent input reads as "missing (required)" whatever shape the schema takes —
  // a codec UNION (z.number = exact|inexact) reports absence as `invalid_union`,
  // a plain schema as `invalid_type`; the model's mistake is the same one.
  if (issue.path.length > 0 && sentVal === undefined) {
    return [`  :${path} — missing (required)`];
  }
  if (issue.code === "invalid_type") {
    return [`  :${path} — expected ${issue.expected}, got ${kindOf(sentVal)}: ${previewOf(faceOf(sentVal))}`];
  }
  // A codec-union miss ("Invalid input", no expected field) — name the declared type
  // from the field's own schema (§2.5's `:pageSize — expected number, got string: "50"`).
  if (issue.code === "invalid_union" && issue.path.length > 0) {
    const declared = declaredTypeOf(shape[String(issue.path[0])]);
    return [`  :${path} — expected ${declared}, got ${kindOf(sentVal)}: ${previewOf(faceOf(sentVal))}`];
  }
  // Anything else: zod's own per-issue message — never the whole dump.
  return [`  :${path} — ${issue.message}`];
}

/** Format a kwargs decode rejection into the frozen shape. Exported for the
 *  substrate/manifold layers that assert against (or parse) the grammar.
 *
 *  A genuinely ANONYMOUS def (empty parsed name) drops the name segment rather than
 *  rendering the broken `: arguments rejected` head — the headless degradation exists
 *  for any true anonymous rosetta. */
export function formatKwargsRejection(qualifiedName: string, problems: readonly ProblemLine[]): string {
  const head = qualifiedName === "" ? "arguments rejected" : `${qualifiedName}: arguments rejected`;
  return `${head} — ${problems.length} problem(s):\n${problems.join("\n")}`;
}

/** A kwargs call rejected at the strict decode chokepoint (`decodeKwargsStrict` below) —
 *  either the scheme-face guard (a boxed `AValue` sent where the declared shape has no
 *  scheme face) or the zod decode itself. Colocated here (not `errors.ts`) because the
 *  frozen rejection-string contract this file owns (manifold error-contract freezes line
 *  HEADS against `formatKwargsRejection`'s output; mcp-substrate own-decode clue family
 *  parses `:<param> —` line heads off it) is mechanism-local, not a leaf-safe general fact. */
export class KwargsRejectionError extends ArrivalError {
  // Interop boundary: covered by the nominal `instanceof ArrivalError` family rule
  // in interop-access.ts — no per-class stamp needed.
  public readonly name = "KwargsRejectionError";
  readonly "arrival/error-category": ErrorClass = "other";

  constructor(
    public readonly qualifiedName: string,
    public readonly problems: readonly ProblemLine[],
  ) {
    super(formatKwargsRejection(qualifiedName, problems));
  }
}

/** A field schema with no scheme face cannot consume a boxed scheme value: codecs and
 *  `z.schemeValue`/`z.dynamic` are registered in scheme-zod's name registry (resolved through optional/
 *  pipe wrappers by `lookupName`); a plain `z.object`/`z.record`/`z.enum` is not — an
 *  AValue reaching one would be silently mangled (strip-to-`{}`) or rejected with a
 *  JS-face message that misnames the value. Door it here with the scheme-face words. */
function schemaFaceProblems(shape: ZodRawShape, sent: Record<string, unknown>): ProblemLine[] {
  const problems: ProblemLine[] = [];
  for (const [key, fieldSchema] of Object.entries(shape)) {
    const sentVal = sent[key];
    if (!(sentVal instanceof AValue)) continue;
    if (z.lookupName(fieldSchema) !== undefined) continue;
    const declared = (fieldSchema as { def?: { type?: string } }).def?.type ?? "the declared shape";
    problems.push(`  :${key} — expected ${declared}, got ${kindOf(sentVal)}: ${previewOf(faceOf(sentVal))}`);
  }
  return problems;
}

// ─── far-unknown-key drop-with-note ────────────────────────────────────────────
// An unknown kwarg key is either a TYPO (near a declared param — keep the hard door) or
// genuine NOISE (far from every param — a model flattening a nested-object field, an
// invented arg, a stray envelope name). Only the SECOND case tolerates: dropped from
// `sent`, the call proceeds, and a NOTE says what was ignored. Load-bearing: the split
// runs BEFORE throwing, and a call is only ever tolerated when unrecognized_keys is its
// ONLY problem AND every one of those keys is far — one near key, or any co-occurring
// real issue (missing required, invalid_type, a scheme-face mismatch), still hard-rejects
// with every problem listed.

/** The manifold's per-call envelope args (mirrors arrival-manifold/src/names.ts's
 *  RESPONSE_SIZE_ARG_NAME / RESPONSE_ATTACHMENTS_ARG_NAME / EVAL_TIMEOUT_ARG_NAME) —
 *  duplicated as leaf string literals, not imported: arrival-manifold depends on this
 *  package, never the reverse, so this core module cannot reach up to name theirs.
 *  Both benchmark models independently invented `:response-size` on an INNER tool call,
 *  meaning "cap this result" — it's a real arg, just one level up (the REPL tool's own
 *  envelope), not this tool's. Naming the mixup here beats a bare "not a parameter." */
const ENVELOPE_ARG_NAMES: ReadonlySet<string> = new Set(["response-size", "response-attachments", "eval-timeout-ms"]);

function noteForDroppedKey(key: string): string {
  if (ENVELOPE_ARG_NAMES.has(key)) {
    return (
      `:${key} is not a parameter of this tool — it's an argument of the REPL tool ` +
      `itself (the manifold envelope wrapping every call), not this inner tool call.`
    );
  }
  return `:${key} is not a parameter of this tool — it was ignored.`;
}

/** WeakMap is a downward discovery seam (drain-once, no upward dep),
 *  keyed by the exact decoded object `decodeKwargsStrict` returns. */
const droppedKwargNotes = new WeakMap<object, readonly string[]>();

export function drainDroppedKwargNotes(value: unknown): readonly string[] | undefined {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return undefined;
  const notes = droppedKwargNotes.get(value as object);
  if (notes !== undefined) droppedKwargNotes.delete(value as object);
  return notes;
}

/** Attempts the far-unknown-key tolerance path for a caught ZodError: returns `{ value }`
 *  when EVERY problem in `error` is an `unrecognized_keys` issue AND every one of those
 *  keys is FAR (no near declared param) — the far keys are stripped from `sent` and the
 *  shape is re-decoded. Returns `undefined` (caller falls back to the hard door) for every
 *  other shape: a mixed near/far set, any co-occurring non-unrecognized_keys issue, or a
 *  filtered re-decode that still fails for some other reason. */
function tryDropFarUnknownKeys(
  shape: ZodRawShape,
  sent: Record<string, unknown>,
  error: ZodError,
): { value: unknown } | undefined {
  const unrecognizedIssues = error.issues.filter(
    (i): i is ZodError["issues"][number] & { keys: string[] } => i.code === "unrecognized_keys",
  );
  if (unrecognizedIssues.length !== error.issues.length || unrecognizedIssues.length === 0) return undefined;

  const declaredKeys = Object.keys(shape);
  const unknownKeys = unrecognizedIssues.flatMap((i) => i.keys);
  const anyNear = unknownKeys.some((k) => suggestFromVocabulary(k, declaredKeys).length > 0);
  if (anyNear) return undefined; // a typo among them — keep the hard door

  const filtered: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(sent)) {
    if (!unknownKeys.includes(k)) filtered[k] = v;
  }
  let value: unknown;
  try {
    value = z.decode(z.strictObject(shape) as unknown as ZodType, filtered);
  } catch {
    return undefined; // dropping didn't actually resolve it — fall back to the hard door
  }
  if (value !== null && (typeof value === "object" || typeof value === "function")) {
    droppedKwargNotes.set(value as object, unknownKeys.map(noteForDroppedKey));
  }
  return { value };
}

/**
 * The kwargs decode chokepoint (rosetta.ts's record-shaped `inputRest` path): STRICT
 * (unknown keys reject — never silently strip) + the scheme-face guard + the §2.5
 * humanizer + far-unknown-key tolerance. Non-Zod decode errors propagate untouched.
 */
export function decodeKwargsStrict(qualifiedName: string, shape: ZodRawShape, sent: Record<string, unknown>): unknown {
  const faceProblems = schemaFaceProblems(shape, sent);
  if (faceProblems.length > 0) {
    throw new KwargsRejectionError(qualifiedName, faceProblems);
  }
  try {
    return z.decode(z.strictObject(shape) as unknown as ZodType, sent);
  } catch (error) {
    if (error instanceof ZodError) {
      const dropped = tryDropFarUnknownKeys(shape, sent, error);
      if (dropped !== undefined) return dropped.value;
      const problems = error.issues.flatMap((issue) => issueLines(issue, sent, shape));
      throw new KwargsRejectionError(qualifiedName, problems);
    }
    throw error;
  }
}
