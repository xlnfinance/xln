import { is_function } from "../values/value-guards.js";
import { AJSArray } from "./AJSArray.js";
import { AJSObject } from "./AJSObject.js";

/**
 * `type()` — the human-facing type NAME of any value, for error messages and the one
 * macro-literal dispatch site (eval/syntax-rules `same_atom`).
 *
 * THE KIND IS (MOST OF) THE TYPE: every AValue subclass carries a concrete
 * `readonly kind: AKind` field (AValue.ts), and this module is a thin reader over
 * that field for the value family — no central instanceof switch over the value
 * kernel. `kind` covers only the AValue family; classes outside it (Macro, Syntax,
 * AmbientRuntime, the errors.ts hierarchy, …) fall through to the `foreign:<CtorName>`
 * rung below.
 *
 * TWO FACES, visible in the function body: the IN-MONAD face (the membrane arms +
 * the `kind` read) handles a properly-boxed AValue; the LEAK face (the raw-JS
 * ladder + the foreign/object fallback) handles a raw JS value sitting where a
 * boxed one belongs. Each leak rung is a P7-catalogued violation, not a feature —
 * see the inline notes; retiring a leak at its membrane crossing deletes the
 * corresponding rung here, never renames it into `kind` vocabulary.
 *
 * Lives in membrane/ (moved from utils/ — hermeticity audit P5) since its two
 * explicit membrane arms below need AJSArray/AJSObject; env/* and eval/* import
 * it downward same as any other membrane leaf. Cycle-safe — neither class (nor
 * anything either one imports: values/*, membrane/rosetta.js,
 * membrane/interop-access.js, errors.js, eval/guards.js) imports Macro/Syntax
 * or this module, so no ESM init cycle opens.
 *
 * Deliberate treatments (each defends a non-obvious branch):
 * - `null` guard stays FIRST: `null.constructor` throws.
 * - raw JS `NaN` reports `"NaN"`; a BOXED AInexact holding NaN reports `"number"` like
 *   any inexact. Asymmetry kept: the raw NaN name flags an unboxed JS value leaking
 *   into a message — renaming boxed NaN would hide that signal.
 * - AJSArray/AJSObject are checked BEFORE the generic `kind` read: both extend AValue,
 *   but their `kind` deliberately diverges from their membrane identity (AJSArray.kind
 *   === "vector", AJSObject.kind === "object" — chosen for tagless-final dispatch parity
 *   with the native containers they mimic), so reporting `kind` directly would collapse
 *   "borrowed via membrane" into "native scheme value", losing a real distinction.
 * - raw `Array`/`RegExp` are FOREIGN natives (cannot carry a `kind`): the only two
 *   instanceof arms left at the raw-JS boundary. Raw arrays report `"array"` —
 *   deliberately distinct from AJSArray's `"js-array"` (borrowed vs raw is a real
 *   difference at a membrane).
 * - anything object-shaped with neither a membrane role, a `kind`, nor a native arm
 *   reports `foreign:<CtorName>` — an honest, greppable marker, not a lowercased
 *   constructor name that would silently mint unbounded vocabulary (e.g. "r7rserror").
 * - plain objects (ctor === Object) and anonymous classes report `"object"`.
 * - callers may still override for pedagogy (evaluator's not-callable door reports
 *   dict-SHAPED AJSObjects as "dict" — a door-specific teaching choice, not a brand).
 *
 * Adjacent vocabularies that are deliberately NOT this one: scheme-zod's `named()`
 * codec names (a third namespace by design, see its header) and polyglot's in-scheme
 * `%dict-guard` phrases. Do not unify.
 */
export function type(obj: unknown): string {
  // ── LEAK FACE (rungs 1-5): raw JS sitting in a value position. Kept VERBATIM —
  // each rung is a P7 violation-inventory entry; deleting one is how a future leak
  // retirement (boxing that raw value at its membrane crossing) shows up here. ──
  if (obj === null) return "null";
  if (typeof obj === "number") return Number.isNaN(obj) ? "NaN" : "number"; // leak: unboxed scalar return
  if (typeof obj === "bigint") return "number"; // residual leak inventory: membrane now DOORS bigint (NoLensError); this face only if one smuggled past
  if (obj === undefined) return "void";
  if (typeof obj !== "object") return typeof obj; // leak: bare fns in env space, raw string/boolean/symbol

  // ── IN-MONAD FACE: the membrane arms, then the value family's own `kind`. ──
  if (obj instanceof AJSArray) return "js-array";
  if (obj instanceof AJSObject) return "js-object";
  const kind = (obj as { kind?: unknown }).kind;
  if (typeof kind === "string") return kind;

  // ── LEAK FACE (rungs 6-7): foreign natives that cannot carry a `kind`. ──
  if (Array.isArray(obj)) return "array"; // leak: raw arrays through list ops
  if (obj instanceof RegExp) return "regex"; // leak: a raw RegExp reaching a value position

  const ctor = (obj as { constructor?: { name?: string } }).constructor;
  const name = ctor?.name;
  if (!name || name === "Object") return "object";
  return `foreign:${name}`;
}

export function typeErrorMessage(fn: unknown, got: string, expected: unknown, position: number | null = null) {
  let postfix = fn ? ` in expression \`${fn}\`` : "";
  if (position !== null) {
    postfix += ` (argument ${position})`;
  }
  if (is_function(expected)) {
    return `Invalid type: got ${got}${postfix}`;
  }
  if (Array.isArray(expected)) {
    if (expected.length === 1) {
      const first = expected[0].toLowerCase();
      expected = `a${"aeiou".includes(first) ? "n " : " "}${expected[0]}`;
    } else {
      expected = new Intl.ListFormat("en", {
        style: "long",
        type: "disjunction",
      }).format(expected);
    }
  }
  return `Expecting ${expected} got ${got}${postfix}`;
}
