/**
 * The canonical static walk over top-level `(define/overridable name type default)` forms —
 * the ONE parse-tree walk shared by every out-of-core overridable lens (studio's form fields,
 * the API's `derive` `:input` schema, the CLI's argv mapping). Each consumer used to duck-type
 * its own copy; this is that copy, unified.
 *
 * Pure parse: nothing is evaluated. Top-level only — a `(define/overridable …)` nested inside
 * another form's body (a `let`, a lambda) is correctly invisible; only true top-level
 * declarations are knobs. `name` must be a bare symbol and `default` must be PRESENT (the
 * macro's fixed 3-arity, `env/overridable/overridable.ts`) — a short `(define/overridable name
 * type)` is an incomplete declaration and is skipped, not guessed at.
 *
 * The walk hands back the raw `typeNode`/`defaultNode` parse nodes rather than source slices:
 * each consumer folds the type (`foldSchemaTag`) and evaluates/reads the default itself, off
 * the node directly. (A prior slice-and-re-parse layer existed only because the form lens ran
 * before this walk was shared; with nodes in hand it is unnecessary.)
 */
import { parse, type SchemeValue } from "@inhuman.tools/arrival";

import { isPair, isSymbol, symName, locationOf, type SourceLocation } from "./schema-fold.js";

/** The `define/overridable` authoring head — arrival's `arrival/overridable` capability's
 *  macro (`env/overridable/overridable.ts`). It survives into the parse tree verbatim because
 *  a static scan never expands macros, so this scanner reads it directly. */
export const OVERRIDABLE_DEFINE_HEAD = "define/overridable";

/** One statically-walked overridable declaration, as raw parse nodes. `typeNode` is the `type`
 *  argument (fold it with `foldSchemaTag`); `defaultNode` is the `default` argument (evaluate
 *  it with `execState`, or read it structurally, per the consumer's need). Both are
 *  `SchemeValue` — they came straight out of `parse`, so the evaluating consumer feeds them to
 *  `execState`/`toJS` directly while a folding consumer still treats them as `unknown`. */
export interface OverridableForm {
  name: string;
  typeNode: SchemeValue;
  defaultNode: SchemeValue;
  location?: SourceLocation;
}

/** Parse one top-level form into its {@link OverridableForm}, or null if it isn't a complete
 *  `(define/overridable name type default)` shape (wrong head, non-symbol name, missing type
 *  or default). */
function overridableFormOf(form: unknown): OverridableForm | null {
  if (!isPair(form) || !isSymbol(form.car) || symName(form.car) !== OVERRIDABLE_DEFINE_HEAD) return null;
  const a1 = form.cdr;
  if (!isPair(a1) || !isSymbol(a1.car)) return null; // name must be a bare symbol
  const name = symName(a1.car);
  const a2 = a1.cdr;
  if (!isPair(a2)) return null; // needs a `type` argument
  const a3 = a2.cdr;
  if (!isPair(a3)) return null; // needs a `default` argument (fixed 3-arity macro)
  // `car`s narrow to `unknown` off the structural `isPair` guard, but every form here came out
  // of `parse` — they are SchemeValues, cast once at this boundary so consumers needn't.
  const typeNode = a2.car as SchemeValue;
  const defaultNode = a3.car as SchemeValue;
  return { name, typeNode, defaultNode, location: locationOf(form) };
}

/**
 * Every top-level `(define/overridable …)` in an ALREADY-PARSED form list, in declaration
 * order. Pure — no parse, never throws. The base a caller with forms already in hand (the
 * API's `derive`, which is handed the parsed forms) builds on.
 */
export function overridableFormsFromForms(forms: readonly unknown[]): OverridableForm[] {
  const out: OverridableForm[] = [];
  for (const form of forms) {
    const f = overridableFormOf(form);
    if (f) out.push(f);
  }
  return out;
}

/**
 * Every top-level `(define/overridable …)` in a source string, in declaration order. Parses,
 * then walks; returns `[]` on parse failure (the form lens's contract — an unparseable draft
 * cell shows no knobs rather than throwing mid-edit). A consumer that wants a parse failure to
 * be LOUD (the CLI) parses itself and calls {@link overridableFormsFromForms} on the result.
 */
export async function extractOverridableForms(source: string): Promise<OverridableForm[]> {
  let forms: unknown[];
  try {
    forms = (await parse(source)) as unknown[];
  } catch {
    return [];
  }
  return overridableFormsFromForms(forms);
}

/**
 * Every top-level `(require "path")` string argument in a source, in order — a cell's direct
 * config dependencies. The form lens follows these to reach overridable knobs declared in a
 * required file (`(require "config.scm")` → config.scm's knobs). Pure parse; `[]` on failure.
 * Top-level only; reads the path string, never executes the require.
 */
export async function extractRequires(source: string): Promise<string[]> {
  let forms: unknown[];
  try {
    forms = (await parse(source)) as unknown[];
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const form of forms) {
    if (!isPair(form) || !isSymbol(form.car) || symName(form.car) !== "require") continue;
    const arg = isPair(form.cdr) ? form.cdr.car : undefined;
    if (arg !== null && typeof arg === "object" && "__string__" in arg) {
      const s = (arg as { __string__?: string }).__string__;
      if (typeof s === "string") out.push(s);
    }
  }
  return out;
}
