// schema-to-ts — the HARVEST: a scheme-zod schema (and an AEntity's normalized
// input/output) → a TypeScript type-STRING. `signatureOf` feeds the lens's ambient
// prelude (prelude.ts, one arrow per grant tool); `printType`/`sTagToTsType` are the
// standalone schema and schema-DSL-tag printers.
//
// Three layers:
//
//   1. printType(schema) — one zod schema → its TS type-string. Wraps zod-to-ts
//      (`zodToTs` + `printNode`) with io:"output" (a CODEC prints its DECODED JS side:
//      z.string → "string", z.exact → "number" — exact is a safe-integer ratio of
//      `number`s, never bigint) plus the instanceof override. Output is one line.
//
//   2. instanceof OVERRIDE — scheme-identity primitives (z.pair / z.schemeString /
//      z.lambda / …) are "custom" to zod and UNREPRESENTABLE by default.
//      `scheme-zod.ts`'s `lookupName(schema)` resolves by identity to a canonical NAME;
//      IMAGE_BY_NAME maps that name to the TS image. This file keeps no class-name or
//      schema-identity recognition tables — a new scheme-zod primitive needs ONE entry in
//      scheme-zod.ts's NAMES map, plus (if not the robust `unknown` default) one
//      IMAGE_BY_NAME entry here.
//
//   3. signatureOf(def) — args-vector → function-signature composer. Contract normalizes
//      to ONE schema per side (z.tuple for positional, array-ish for variadic /
//      multiple-values — symbol.ts normalizeVector):
//        input  z.tuple([A,B]) → "(a: A, b: B)"; z.array(T) → "(...args: T[])"
//        output z.tuple([R]) → "R"; z.tuple([A,B]) → "[A, B]"; z.array(T) → "T[]"
//        rosetta is implicitly ASYNC (bake awaits) → Promise<…>; native is sync.

import { zodToTs, printNode, createAuxiliaryTypeStore, type OptionalTypeOverrideFunction } from "zod-to-ts";
import * as z from "../common/scheme-zod/index.js";
import { tagToJsonSchema } from "../common/schema-tag.js";
import type { AEntity } from "../common/symbols/_bake.js";

// Scheme primitive → its PLAIN-TS IMAGE (Scheme is a TS subset; see carriers.ts).
//
// Harvest re-presents each scheme primitive as the TS type the lens narrows against:
// membrane makes a boundary value its plain JS type; list/pair/vector project to the
// carrier vocabulary. Keyed by SCHEMA IDENTITY. `z.pair` is `cons(schemeValue, schemeValue)`
// (scheme-zod.ts on `pair`) — named "cons", not "pair" — so it prints via the named-
// generic pre-check as `Tuple<SchemeValue, SchemeValue>`, not this table. Unmapped
// custom/instanceof primitives degrade to `unknown` (total-harvest; never throw).
type Ts = typeof import("typescript");
type NodeBuilder = (ts: Ts) => import("typescript").TypeNode;

const unknownNode: NodeBuilder = (ts) => ts.factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
const stringNode: NodeBuilder = (ts) => ts.factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword);
const numberNode: NodeBuilder = (ts) => ts.factory.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword);
const booleanNode: NodeBuilder = (ts) => ts.factory.createKeywordTypeNode(ts.SyntaxKind.BooleanKeyword);
const nullNode: NodeBuilder = (ts) => ts.factory.createLiteralTypeNode(ts.factory.createNull());
const uint8ArrayNode: NodeBuilder = (ts) => ts.factory.createTypeReferenceNode("Uint8Array", undefined);
const voidNode: NodeBuilder = (ts) => ts.factory.createKeywordTypeNode(ts.SyntaxKind.VoidKeyword);
/** `SchemeValue` — the honest top type `z.schemeValue` prints (carriers.ts's own
 *  declaration, ambient in the lens's prelude — see prelude.ts's `carrierVocabulary`), NOT
 *  the bare `unknown` keyword: distinct from an unmapped/unregistered schema's `unknown`
 *  DEFAULT, this is a DELIBERATE unconstrained slot. */
const schemeValueNode: NodeBuilder = (ts) => ts.factory.createTypeReferenceNode("SchemeValue", undefined);
/** `(...args: unknown[]) => unknown` — z.lambda's callable image. */
const lambdaNode: NodeBuilder = (ts) => {
  const restParam = ts.factory.createParameterDeclaration(
    undefined,
    ts.factory.createToken(ts.SyntaxKind.DotDotDotToken),
    ts.factory.createIdentifier("args"),
    undefined,
    ts.factory.createArrayTypeNode(unknownNode(ts)),
    undefined,
  );
  return ts.factory.createFunctionTypeNode(undefined, [restParam], unknownNode(ts));
};

// Keyed by the canonical NAME `lookupName()` returns — NOT class-name-string, NOT
// schema-object-identity. Keying on either would need a second recognition table here,
// hand-synced on every new scheme-zod primitive. scheme-zod.ts owns identity; this file
// only knows how to PRINT a given name.
const IMAGE_BY_NAME: ReadonlyMap<string, NodeBuilder> = new Map<string, NodeBuilder>([
  // no "pair" — `z.pair` is named "cons"; prints via named-generic pre-check as Tuple<…>
  ["string", stringNode],
  ["foldName", stringNode],
  ["exact", numberNode],
  ["inexact", numberNode],
  // number/exact/bigint are UNIONS of two same-output codecs; without an image they'd
  // print `number | number`. Image is the carrier, once. `bigint`'s face is `number` too
  // (docs/design-history/arrival-one-number-rework.md §2.3: exact is a safe-integer ratio
  // of `number`s; z.bigint is retired and never decodes to a real JS bigint).
  ["number", numberNode],
  ["bigint", numberNode],
  // looseNumber / looseAnyNumber CODECs: OUT is bare z.custom so NaN/±Inf stay legal.
  // Without an image the OUT custom leaf prints as unknown. Teach the names; do NOT
  // rewrite OUT to z.number() (rejects non-finites).
  ["looseNumber", numberNode],
  ["looseAnyNumber", numberNode],
  ["symbol", stringNode],
  // bytevector CODEC out = z.instanceof(Uint8Array) (custom leaf → `unknown`); image
  // restores Uint8Array carrier.
  ["bytevector", uint8ArrayNode],
  ["nil", nullNode],
  ["boolean", booleanNode],
  ["char", stringNode],
  // "schemeValue" (honest top, native/contour) → named `SchemeValue` alias; "dynamic"
  // (rosetta escape hatch) → bare `unknown` — same runtime shape, deliberately NOT the
  // named alias (a rosetta `z.dynamic` slot is genuinely unknowable, not "any scheme value").
  ["schemeValue", schemeValueNode],
  ["dynamic", unknownNode],
  ["lambda", lambdaNode],
  ["undefinedResult", voidNode], // R7RS "unspecified" → void
  // "error" omitted on purpose: unmapped NAME → unknownNode default (never throw).
  // R7RSError has no ambient carrier type; "unknown" is the honest print.
]);

/** The zod-to-ts override: scheme-zod vocabulary schema → plain-TS image via `lookupName`
 *  (identity-based, owned by scheme-zod.ts); UNMAPPED name → `unknown`, never throw
 *  (total-harvest). Non-vocabulary schemas (object/array/union/literal/… and codecs via
 *  `io:"output"`) defer to zod-to-ts (return undefined).
 *
 *  Registered name WITH image prints that image (including CODECS — most primitives are
 *  pipes, not leaf customs). Registered name WITHOUT image (`schemeNumber`/`vector`/`dict`/
 *  `list`/`cons`, and unions whose members carry their own image) returns undefined so
 *  zod-to-ts composes per-member — `z.schemeNumber` prints "number | number" undeduped
 *  (same known gap as `z.vector`). Unregistered leaf custom → `unknown`; compound defers. */
const instanceofOverride: OptionalTypeOverrideFunction = (schema, typescript) => {
  // Named-generic pre-check — MUST fire before the leaf guard: `list`/`cons` are CODECS
  // (`_zod.def.type === "pipe"`), so that guard would early-return them to zod-to-ts, which
  // decomposes structurally (`list` → `Cons<T> | null`, `cons` → `[A, B]`) and loses the name.
  // Scoped to the two registered collection names via COLLECTION_ELEMENT — only homogeneous
  // `list`/`cons` register an element; a `schemeNumber`-style union has no element
  // registration → skips this, reaching per-member composition below.
  const element = z.lookupCollectionElement(schema);
  if (element !== undefined) {
    const name = z.lookupName(schema);
    if (name === "list" && !Array.isArray(element)) {
      return typescript.factory.createTypeReferenceNode("List", [harvestNode(element as z.ZodTypeAny)]);
    }
    if (name === "cons" && Array.isArray(element)) {
      // Fixed 2-product — Tuple, not a Pair brand. List generalizes pair spines;
      // a cons of two arbitrary slots is just a native 2-tuple.
      const [carE, cdrE] = element as readonly [z.ZodTypeAny, z.ZodTypeAny];
      return typescript.factory.createTypeReferenceNode("Tuple", [harvestNode(carE), harvestNode(cdrE)]);
    }
  }
  // Registered vocabulary name → its image. MUST run before the leaf guard: primitives are
  // CODECS (pipe), so the guard would defer to zod-to-ts and print the raw OUT schema
  // (undefinedResult→undefined, bytevector→unknown, number→number|number) instead of the
  // carrier image (void / Uint8Array / number). Name with NO image → undefined → composed
  // per-member (schemeNumber → number | number; vector/dict/list/cons → structural).
  const name = z.lookupName(schema);
  if (name !== undefined) {
    const builder = IMAGE_BY_NAME.get(name);
    return builder ? builder(typescript) : undefined;
  }
  // Unregistered: leaf custom → unknown (never throw); compound → zod-to-ts.
  const s = schema as { _zod?: { def?: { type?: string } } };
  if (s?._zod?.def?.type !== "custom") return undefined;
  return unknownNode(typescript);
};

/** Collapse zod-to-ts's pretty-printed (multi-line, indented) output to a single
 *  readable line: runs of whitespace → one space, no space before ; } ] , and a
 *  trailing-member-separator tidy so an object reads "{ k: T; n: U }" (no dangling
 *  semicolon before the close brace). */
function flatten(printed: string): string {
  return printed
    .replaceAll(/\s+/g, " ")
    .replaceAll(/\(\s+/g, "(")
    .replaceAll(/\s+\)/g, ")")
    .replaceAll(/\[\s+/g, "[")
    .replaceAll(/\s+\]/g, "]")
    .replaceAll(/\{\s+/g, "{ ")
    .replaceAll(/\s+\}/g, " }")
    .replaceAll(/\s+;/g, ";")
    .replaceAll(/\s+,/g, ",")
    .replaceAll(/;\s*\}/g, " }") // drop the trailing member separator: "; }" → " }"
    .replaceAll(/\{\s+\}/g, "{}")
    .replaceAll(/\[\s*\]/g, "[]")
    .trim();
}

/**
 * Print one scheme-zod schema as a single-line TypeScript type-string.
 *
 * Codecs print their DECODED (output) side (io:"output"): z.string → "string",
 * z.exact → "number" (safe-integer ratio of `number`s — never a real bigint).
 * instanceof primitives print via the override (z.pair → "Tuple"). Compounds compose
 * (z.object → "{ k: T; … }", z.array → "T[]", z.tuple → "[A, B]", z.union → "A | B").
 */
// Raw zod-to-ts TypeNode (before flatten/print). Split so the named-generic pre-check
// can nest an element's node as a type argument (`List<…>`) — a string can't be a
// TypeReferenceNode's type arg.
function harvestNode(schema: z.ZodTypeAny): import("typescript").TypeNode {
  const { node } = zodToTs(schema as never, {
    auxiliaryTypeStore: createAuxiliaryTypeStore(),
    overrideFunction: instanceofOverride,
    io: "output",
    unrepresentable: "throw",
  });
  return node as import("typescript").TypeNode;
}

export function printType(schema: z.ZodTypeAny): string {
  return flatten(printNode(harvestNode(schema)));
}

/**
 * Zod prints `additionalProperties: false` objects with a trailing
 * `[x: string]: never` index. That is faithful to closed JSON Schema, but in the
 * type lens it is hover noise: structural `{ a: string }` already rejects unknown
 * keys on read, and the never-index creates ugly unions with open dict literals
 * (`{ summary; key-points: string[] } | { summary; key-points: never[]; [x: string]: never }`).
 * Strip it for lens-facing schema→TS (prompt faces, etc.).
 */
function stripClosedNeverIndex(tsType: string): string {
  return tsType
    .replaceAll(/;\s*\[x: string\]:\s*never/g, "")
    .replaceAll(/\{\s*\[x: string\]:\s*never;\s*/g, "{ ")
    .replaceAll(/\[x: string\]:\s*never;\s*/g, "");
}

/**
 * Print an s/* schema-DSL TAG (`tagToJsonSchema`'s own input shape — e.g.
 * `["object", ["summary", "string", "a one-line summary"]]`) as a TS type string —
 * the STATIC projection `env/schema/schema.ts`'s header promises alongside the runtime one
 * (`tagToJsonSchema` → `z.fromJSONSchema`, the validator). Routes through the SAME
 * JSON Schema lowering and the SAME zod reconstruction the runtime validator uses, so
 * this can never disagree with what a tag actually validates as. Never throws — a
 * malformed or unrepresentable tag degrades to "unknown" (the harvest's total-coverage
 * posture, matching `signatureOf`'s own catch-all).
 */
export function sTagToTsType(tag: unknown): string {
  try {
    return stripClosedNeverIndex(
      printType(z.fromJSONSchema(tagToJsonSchema(tag) as Parameters<typeof z.fromJSONSchema>[0])),
    );
  } catch {
    return "unknown";
  }
}

// signatureOf — vector → function-signature composer.
// Reads AEntity's NORMALIZED in/out (one schema per side, symbol.ts normalizeVector):
// z.tuple for positional, array-ish for variadic / multiple-values.

interface TupleDef {
  type: "tuple";
  items: readonly z.ZodTypeAny[];
  rest?: z.ZodTypeAny | null;
}
interface ArrayDef {
  type: "array";
  element: z.ZodTypeAny;
}

function zodDef(schema: z.ZodTypeAny): { type?: string } & Partial<TupleDef> & Partial<ArrayDef> {
  return (schema as { _zod?: { def?: unknown } })._zod?.def as never;
}

/** Spreadsheet-style positional parameter names: a, b, … z, a1, b1, … */
function paramName(i: number): string {
  const letter = String.fromCharCode(97 + (i % 26));
  const wrap = Math.floor(i / 26);
  return wrap === 0 ? letter : letter + String(wrap);
}

/** The PARAMETER LIST from a normalized input schema. A z.tuple → "(a: A, b: B)"
 *  (its items, named positionally; empty → "()"); an array-ish schema → a variadic
 *  rest param "(...args: T[])". */
function paramList(input: z.ZodTypeAny): string {
  const def = zodDef(input);
  if (def.type === "tuple") {
    const items = def.items ?? [];
    const params = items.map((item, i) => `${paramName(i)}: ${printType(item)}`);
    // A variadic tail (z.tuple([...], rest)) → a trailing rest param. A ZERO-item tuple+rest
    // (e.g. `{input: [], inputRest: z.dynamic}`) has no fixed prefix at all — structurally the
    // same "purely variadic" shape as the array-ish branch below, so it gets the same "args"
    // name; only a genuine fixed-head-plus-tail earns the "rest" name.
    if (def.rest != null) params.push(`...${items.length === 0 ? "args" : "rest"}: ${printType(def.rest)}[]`);
    return `(${params.join(", ")})`;
  }
  if (def.type === "array" && def.element != null) {
    return `(...args: ${printType(def.element)}[])`;
  }
  // Any other single schema as the whole input vector: one positional arg.
  return `(a: ${printType(input)})`;
}

/** The RETURN TYPE from a normalized output schema. A 1-tuple → bare "R" (single
 *  value); an n-tuple → "[A, B]" (multiple-values); an array-ish schema → "T[]"
 *  (variadic values). */
function returnType(output: z.ZodTypeAny): string {
  const def = zodDef(output);
  if (def.type === "tuple") {
    const items = def.items ?? [];
    if (def.rest == null && items.length === 1) {
      // 1-tuple output = the impl returns a SINGLE value (symbol.ts isSingleOutput).
      return printType(items[0]);
    }
    // n-tuple (or variadic tuple) = the multiple-values vector.
    return printType(output);
  }
  return printType(output);
}

/**
 * Compose the full ".d.ts member" arrow signature for a baked AEntity.
 *
 *   native  → "(a: A, b: B) => R"            (sync; impl works on scheme values)
 *   rosetta → "(a: A, b: B) => Promise<R>"   (bake awaits → implicitly async)
 *   door    → "never"                         (an omitted verb; not callable)
 *
 * A 1-tuple output collapses to a bare return; an n-tuple becomes a
 * multiple-values "[A, B]"; a variadic input becomes "(...args: T[])".
 */
export function signatureOf(def: AEntity): string {
  // door = omitted verb (not callable); keyword = special-form syntax; macro / define-syntax
  // = a non-evaluating transformer (syntax, not a value-level callable — a `symbol.defineSyntax`
  // body's "free variables" name the EXPANSION env, a categorically different story from a
  // value-level callable's argument list). None carries an in/out codec surface, so all print
  // as `never` until the type-lens grows a dedicated syntax representation.
  if (def.kind === "door" || def.kind === "keyword" || def.kind === "macro" || def.kind === "define-syntax") {
    return "never";
  }
  // A `symbol.value` raw DATA binding carries no contract at all — nothing to derive a
  // signature from (the value is host-supplied, its shape undeclared). Loose by design.
  if (def.kind === "value") return "unknown";
  // Author-asserted `type` override (Contract.type on native/rosetta/sequence/define, or
  // TaglessGuardSymbolDef.type on type-predicate guards). Present ⇒ final for the harvest;
  // absent ⇒ derive from in/out. `"type" in def` so pure-tagless (no field) falls through.
  if ("type" in def && def.type !== undefined) return def.type;
  try {
    // A `symbol.define` CONSTANT (`callable: false`) is a plain VALUE, not a call
    // boundary — harvests as its bare return type (`declare const x: T;`), never an
    // arrow (`in`/`out` still normalize to the 0-ary-procedure convention, so
    // `paramList(def.in)` would print a spurious `()` param list for it).
    if (def.kind === "define" && !def.callable) return returnType(def.out);
    const params = paramList(def.in);
    const ret = returnType(def.out);
    // Only "rosetta" is a genuine JS-membrane crossing (async by construction); every
    // other kind — including "define", a scheme-face contour like "native"/"sequence"/
    // "tagless" (its JS impl happens to await internally, but that's an implementation
    // detail of the validating wrapper, not a membrane crossing) — harvests SYNC.
    const wrapped = def.kind === "rosetta" ? `Promise<${ret}>` : ret;
    return `${params} => ${wrapped}`;
  } catch {
    // TOTAL HARVEST: an unrepresentable schema must NEVER collapse typed mode — degrade this
    // ONE symbol to a loose arrow (it just isn't narrowed; its slots stay Σ-only), never throw.
    return "(...args: unknown[]) => unknown";
  }
}
