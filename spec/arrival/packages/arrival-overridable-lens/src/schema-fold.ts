/**
 * `foldSchemaTag` — fold a PARSE-TREE node of an s/* schema-DSL form into its canonical
 * tagged-list JSON value, with ZERO evaluation. The pre-eval dual of core's `tagToJsonSchema`
 * (`@inhuman.tools/arrival/schema-tag`, which folds an ALREADY-evaluated JS tagged-list): this
 * one reads the raw parse node before any env exists. That's why it lives OUT of core — core
 * only ever has evaluated values in hand; only the out-of-core static lenses (studio's form
 * lens, the API's `derive` endpoint, the CLI's argv mapper) ever hold parse nodes.
 *
 * Also home to the low-level parse-node duck-typers the sibling `walk.ts` shares (`isPair`,
 * `isSymbol`, `symName`, `locationOf`, …). Pair / SchemeSymbol / SchemeString are duck-typed
 * because the concrete classes are not in arrival's public surface — same approach core's own
 * `reader/extract-defines.ts` and the API's `derive.ts` take. The `__location__` symbol is a
 * registry symbol (`Symbol.for("__location__")`) read off Pairs without importing primitives.
 */
import type { SourceLocation } from "@inhuman.tools/arrival/provenance";
import { toJS, type SchemeValue } from "@inhuman.tools/arrival";

export type { SourceLocation } from "@inhuman.tools/arrival/provenance";

export const LOCATION_KEY = Symbol.for("__location__");

export const isPair = (v: unknown): v is { car: unknown; cdr: unknown } =>
  v !== null && typeof v === "object" && "car" in v && "cdr" in v;

export const isSymbol = (v: unknown): v is { __name__: string | symbol } =>
  v !== null && typeof v === "object" && "__name__" in v;

export const isString = (v: unknown): v is { __string__: string } =>
  v !== null &&
  typeof v === "object" &&
  "__string__" in v &&
  typeof (v as { __string__: unknown }).__string__ === "string";

export const symName = (s: { __name__: string | symbol }): string =>
  typeof s.__name__ === "string" ? s.__name__ : (s.__name__.description ?? String(s.__name__));

export const locationOf = (form: unknown): SourceLocation | undefined =>
  (form as Record<symbol, unknown>)[LOCATION_KEY] as SourceLocation | undefined;

// ── s/* call-folding — statically evaluable by construction ────────────────
//
// s/* (`s/object`/`s/array`/`s/enum`/`s/optional`/`s/field`/`s/field/<type>` — the
// constructors of `arrival/schema`, `foundations/arrival/arrival/src/env/schema.ts`) are
// ORDINARY scheme calls with no side effect and no dependency on anything but their own
// (also foldable) arguments. `foldSchemaTag` recognizes their CALL SHAPE in the parse tree —
// symbol head + arity, mirroring each constructor's own scheme body exactly — and folds
// straight to the canonical tagged-list JSON form, with ZERO evaluation. Two non-call shapes
// fold too, the same two a `define/overridable` type tag could always be: a bare
// self-evaluating atom (`"string"`, kind-tagged by the reader at parse time already) and a
// quoted list literal (`'("enum" "a" "b")`, parsed as `(quote datum)` — `datum` is already
// pure boxed data by `quote`'s own semantics, so `toJS` unboxes the Pair-chain with no
// evaluation either, exactly the free lunch a bare atom gets).
//
// This produces the SAME canonical tagged-list core's `tagToJsonSchema` then consumes — the
// pre-eval half of one folding vocabulary, split across the eval boundary.

const kindOf = (v: unknown): unknown => (v !== null && typeof v === "object" && "kind" in v ? v.kind : undefined);

/** A parse-time self-evaluating atom (string/number/boolean) — no evaluation needed, the
 *  reader already tags these literally at `kind`. */
function literalAtom(node: unknown): { ok: true; value: string | number | boolean } | { ok: false } {
  const kind = kindOf(node);
  if (kind === "string" || kind === "number" || kind === "boolean") {
    return { ok: true, value: toJS(node as SchemeValue) as string | number | boolean };
  }
  return { ok: false };
}

/** Every element of a parse-tree list, as a JS array — walks `car`/`cdr` until the
 *  terminating `nil` (a non-Pair, per `isPair`'s structural check). */
function listOf(node: unknown): unknown[] {
  const out: unknown[] = [];
  let cur = node;
  while (isPair(cur)) {
    out.push(cur.car);
    cur = cur.cdr;
  }
  return out;
}

const SCHEMA_OPTIONAL_SUFFIX = "/optional";

/** Suffix an already-folded tag's HEAD with `/optional` — mirrors `s/optional`'s own scheme
 *  body (`env/schema.ts`), operating on the FOLDED JS value instead of a live scheme pair. */
function suffixOptional(tag: unknown): unknown {
  if (typeof tag === "string") return `${tag}${SCHEMA_OPTIONAL_SUFFIX}`;
  if (Array.isArray(tag) && tag.length > 0 && typeof tag[0] === "string") {
    return [`${tag[0]}${SCHEMA_OPTIONAL_SUFFIX}`, ...tag.slice(1)];
  }
  return tag;
}

/** `[name, typeValue]` or `[name, typeValue, desc]` — `nameNode`/`descNode` are parse-tree
 *  nodes (an author-supplied name/description is always a bare string literal), but
 *  `typeValue` is an ALREADY-FOLDED JS tagged-list value: the caller either folds it from a
 *  parse-tree node via `foldSchemaTag` (`s/field`, the composite sugars) or hands in a fixed
 *  literal directly (a `s/field/<type>` sugar's base type is hardcoded by the constructor
 *  itself, never parsed — see `fieldFromTypeNode` below for the parse-node-folding variant). */
function fieldWithType(
  nameNode: unknown,
  typeValue: unknown,
  descNode?: unknown,
): { ok: true; value: unknown[] } | { ok: false } {
  const name = literalAtom(nameNode);
  if (!name.ok || typeof name.value !== "string") return { ok: false };
  if (descNode === undefined) return { ok: true, value: [name.value, typeValue] };
  const desc = literalAtom(descNode);
  return desc.ok ? { ok: true, value: [name.value, typeValue, desc.value] } : { ok: false };
}

/** `(name type)` or `(name type desc)` → `[name, type]` / `[name, type, desc]`, folding
 *  `typeNode` recursively (an object field's type may itself be any s/* form). */
function fieldFromTypeNode(
  nameNode: unknown,
  typeNode: unknown,
  descNode?: unknown,
): { ok: true; value: unknown[] } | { ok: false } {
  const type = foldSchemaTag(typeNode);
  return type.ok ? fieldWithType(nameNode, type.value, descNode) : { ok: false };
}

/**
 * Fold a parsed schema-DSL node — a type tag, an object field spec, an array element, an enum
 * value — into its canonical tagged-list JSON form, with NO evaluation: the four pure `s/*`
 * constructors and the `s/field`/`s/field/*` sugars are recognized purely by CALL SHAPE
 * (symbol head + arity), exactly mirroring their scheme bodies in `env/schema.ts`. `{ok:false}`
 * for anything else (a bare symbol reference, a compound expression that isn't one of these
 * calls, a malformed arity) — the caller treats an unfoldable tag as "no static type", the
 * same posture an unrecognized literal already had before s/* existed.
 */
export function foldSchemaTag(node: unknown): { ok: true; value: unknown } | { ok: false } {
  const atom = literalAtom(node);
  if (atom.ok) return atom;
  if (!isPair(node)) return { ok: false };

  const head = node.car;

  // `(quote datum)` — the `'datum` shorthand desugars to this. `datum` is pure literal data
  // by quote's own semantics (never evaluated), so `toJS` unboxes the Pair-chain of
  // literals into a JS array/scalar directly.
  if (isSymbol(head) && symName(head) === "quote") {
    const quoted = listOf(node.cdr);
    if (quoted.length !== 1) return { ok: false };
    try {
      return { ok: true, value: toJS(quoted[0] as SchemeValue) };
    } catch {
      return { ok: false };
    }
  }

  if (!isSymbol(head)) return { ok: false };
  const args = listOf(node.cdr);

  switch (symName(head)) {
    case "s/object": {
      const fields: unknown[] = [];
      for (const f of args) {
        const folded = foldSchemaTag(f);
        if (!folded.ok) return { ok: false };
        fields.push(folded.value);
      }
      return { ok: true, value: ["object", ...fields] };
    }
    case "s/array": {
      if (args.length !== 1) return { ok: false };
      const el = foldSchemaTag(args[0]);
      return el.ok ? { ok: true, value: ["array", el.value] } : { ok: false };
    }
    case "s/enum": {
      const values: unknown[] = [];
      for (const v of args) {
        const lit = literalAtom(v);
        if (!lit.ok) return { ok: false };
        values.push(lit.value);
      }
      return values.length > 0 ? { ok: true, value: ["enum", ...values] } : { ok: false };
    }
    case "s/optional": {
      if (args.length !== 1) return { ok: false };
      const inner = foldSchemaTag(args[0]);
      return inner.ok ? { ok: true, value: suffixOptional(inner.value) } : { ok: false };
    }
    case "s/field":
      // (name type) or (name type desc) — the scheme body's own arg order; type folds
      // recursively (a field's type may itself be any s/* form).
      if (args.length === 2) return fieldFromTypeNode(args[0], args[1]);
      if (args.length === 3) return fieldFromTypeNode(args[0], args[1], args[2]);
      return { ok: false };
    case "s/string":
    case "s/number":
    case "s/integer":
    case "s/boolean": {
      // Zero-arg top-level scalar — the base type is HARDCODED by the constructor itself,
      // never parsed, same posture as the `s/field/<type>` sugars below.
      if (args.length > 0) return { ok: false };
      return { ok: true, value: symName(head).slice("s/".length) };
    }
    case "s/field/string":
    case "s/field/number":
    case "s/field/integer":
    case "s/field/boolean": {
      // The base type is HARDCODED by the constructor itself (never parsed) — a fixed
      // literal, not a node to fold.
      const bare = symName(head).slice("s/field/".length);
      if (args.length === 1) return fieldWithType(args[0], bare);
      if (args.length === 2) return fieldWithType(args[0], bare, args[1]);
      return { ok: false };
    }
    case "s/field/object":
    case "s/field/array":
    case "s/field/enum":
      // s/field/_composite: (name config) — no desc; (name desc config) — desc BEFORE
      // config (the authoring order the composite sugars use, e.g.
      // `(s/field/enum "bucket" "audience classification" (s/enum "A" "B"))`). `config`
      // folds recursively either way.
      if (args.length === 2) return fieldFromTypeNode(args[0], args[1]);
      if (args.length === 3) return fieldFromTypeNode(args[0], args[2], args[1]);
      return { ok: false };
    default:
      return { ok: false };
  }
}
