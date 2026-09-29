import { readSugarcoat, splitFormsWithBase } from "./sugarcoat-read.js";
import { type Node, parseSexprs } from "./sugarcoat-render.js";

/**
 * Parameter-name inlay hints. For a call to a `(define (f a b c) …)`, place a hint
 * before each positional arg naming its formal — the IDE inlay-hint idea, applied
 * to scheme. It's intent-over-materialization for code: a positional call hides the
 * parameter names; the hint restores them as transparent glass, never written into
 * the source.
 *
 * Pure function of the text → `{pos, name}[]`, where `pos` is the arg's start offset
 * (the hint renders just before it). Lens-agnostic in spirit; this entry parses
 * Scheme (`parseSexprs`). The sugarcoat lens reuses the same resolver over a
 * span-bearing sugarcoat parse — a follow-up. Returns `[]` on a parse error so a
 * mid-edit buffer shows no hints rather than throwing.
 *
 * v1 scope (deliberate): user `define`d functions only — no builtins (no formals to
 * read) — and a FLAT name→formals map, so lexical shadowing of a same-named binding
 * isn't yet resolved. Both are the "declared statically via define" subset.
 */

export interface ParamHint {
  /** Char offset of the arg this hint labels; the widget renders immediately before it. */
  pos: number;
  /** The formal parameter's name. */
  name: string;
}

type Atom = { atom: string; str?: boolean; span?: readonly [number, number] };
type List = { list: Node[]; span?: readonly [number, number] };
const isAtom = (n: Node | undefined): n is Atom => n != null && "atom" in n;
const isList = (n: Node | undefined): n is List => n != null && "list" in n;

/** First source offset of a node — its own span, or, for a span-LESS synthesized list (the
 *  sugarcoat I-expression reader wraps `a` + an indented value into a `(a v)` binding with no
 *  span of its own), the start of its first child, recursively. So a hint lands on the
 *  binding's visible start (`(` inline, the symbol in an I-expression) in either lens. */
const startOf = (n: Node | undefined): number | undefined =>
  n == null ? undefined : n.span ? n.span[0] : isList(n) ? startOf(n.list[0]) : undefined;

/** Drop a dotted-rest tail: `(a b . rest)` tokenizes as `[a, b, ., rest]`; cut at the
 *  `.` so the rest param takes no positional hint (rest hinting is a follow-up). */
const positional = (names: string[]): string[] => {
  const dot = names.indexOf(".");
  return dot === -1 ? names : names.slice(0, dot);
};

/** A function-shaped define → its name + positional formals, else null:
 *    (define (f a b c) …)        → { name: "f", params: ["a","b","c"] }
 *    (define f (lambda (a b) …))  → { name: "f", params: ["a","b"] }  */
function defOf(nd: Node): { name: string; params: string[] } | null {
  if (!isList(nd) || nd.list.length < 2 || !isAtom(nd.list[0]) || nd.list[0].atom !== "define") return null;
  const sig = nd.list[1];
  // (define (f a b c) …) — flat-list signature. Bind the list first so `.every`'s
  // type-guard overload narrows it to Atom[] (it can't narrow a `sig.list` access).
  if (isList(sig)) {
    const formals = sig.list;
    if (formals.length > 0 && formals.every(isAtom)) {
      const names = formals.map((a) => a.atom);
      return { name: names[0], params: positional(names.slice(1)) };
    }
  }
  // (define f (lambda (a b) …))
  const val = nd.list[2];
  if (isAtom(sig) && isList(val) && isAtom(val.list[0]) && val.list[0].atom === "lambda" && isList(val.list[1])) {
    const formals = val.list[1].list;
    if (formals.every(isAtom)) {
      return { name: sig.atom, params: positional(formals.map((a) => a.atom)) };
    }
  }
  return null;
}

/** A `:keyword` arg means the call is self-labeling (a kwarg call) — skip hints. */
const hasKwarg = (args: Node[]): boolean => args.some((a) => isAtom(a) && a.atom.startsWith(":"));

/** Scheme lens: hints over the Scheme `.scm` parse. */
export function paramHints(src: string): ParamHint[] {
  try {
    return hintsFromForms(parseSexprs(src));
  } catch {
    return []; // mid-edit / malformed → no hints
  }
}

/** Recursively shift every `span` in a node tree by `delta` (a form parsed in
 *  isolation has spans relative to its own start; this lifts them to buffer-absolute). */
function shiftSpans(nd: Node, delta: number): void {
  if (nd.span) nd.span = [nd.span[0] + delta, nd.span[1] + delta];
  if ("list" in nd) for (const c of nd.list) shiftSpans(c, delta);
}

/** Sugarcoat lens: the SAME resolver over a span-bearing sugarcoat parse. Read top-level
 *  forms ONE AT A TIME so a single form the sugarcoat reader can't yet handle drops
 *  only its own hints, not the whole file's. Defines are still collected globally
 *  across every form that DID parse, so a call resolves against a define in another
 *  form. Spans are in sugarcoat-text (buffer) coordinates. */
export function paramHintsSugarcoat(src: string): ParamHint[] {
  const forms: Node[] = [];
  for (const { text, base } of splitFormsWithBase(src)) {
    if (!text.trim()) continue;
    try {
      for (const form of readSugarcoat(text)) {
        shiftSpans(form, base); // form parsed at 0 → lift to its place in the buffer
        forms.push(form);
      }
    } catch {
      // this form uses something the sugarcoat reader doesn't handle yet — skip it
    }
  }
  return hintsFromForms(forms);
}

/** The lens-agnostic core: walk a span-bearing `Node` forest, hint every positional
 *  arg of a call to a function-define found in the same forest. */
function hintsFromForms(forms: Node[]): ParamHint[] {
  // 1. Collect function-defines anywhere in the tree → name → formals.
  const defs = new Map<string, string[]>();
  const scan = (nd: Node): void => {
    if (!isList(nd)) return;
    const d = defOf(nd);
    if (d) defs.set(d.name, d.params);
    for (const c of nd.list) scan(c);
  };
  for (const f of forms) scan(f);

  // 2. Walk; emit a hint before each positional arg of a call to a known define, AND a
  //    semantic position label for the built-in control forms `if` (cond/then/else) and
  //    `let`/`let*` (a `let:` per binding + `return:` on the body's value). The control-form
  //    labels need no defines, so this runs even when the file declares none.
  //    A define/lambda's formals list is a BINDING site, not a call — skip it.
  const hints: ParamHint[] = [];
  const walk = (nd: Node): void => {
    if (!isList(nd) || nd.list.length === 0) return;
    const head = nd.list[0];
    if (isAtom(head) && (head.atom === "define" || head.atom === "lambda" || head.atom === "define-macro")) {
      for (let k = 2; k < nd.list.length; k++) walk(nd.list[k]); // body only; skip the formals
      return;
    }
    // `(if cond then else)` → cond:/then:/else: before each branch (else optional).
    if (isAtom(head) && head.atom === "if") {
      const labels = ["cond", "then", "else"];
      for (let a = 1; a < nd.list.length && a <= 3; a++) {
        const pos = startOf(nd.list[a]);
        if (pos !== undefined) hints.push({ pos, name: labels[a - 1] });
      }
      for (const c of nd.list) walk(c);
      return;
    }
    // `(let ((s v) …) body…)` → a `let:` before each binding + `return:` on the body's
    // value (its last form). Also a NAMED let `(let loop ((s v) …) body…)` — skip the
    // leading name atom to find the bindings list. `let*` is the same shape, never named.
    if (isAtom(head) && (head.atom === "let" || head.atom === "let*")) {
      let i = 1;
      if (isAtom(nd.list[i])) i++; // named let: step past the loop name
      const bindings = nd.list[i];
      if (isList(bindings))
        for (const b of bindings.list) {
          const pos = startOf(b);
          if (pos !== undefined) hints.push({ pos, name: "let" });
        }
      if (nd.list.length > i + 1) {
        const pos = startOf(nd.list.at(-1));
        if (pos !== undefined) hints.push({ pos, name: "return" });
      }
      for (const c of nd.list) walk(c);
      return;
    }
    if (isAtom(head) && defs.has(head.atom)) {
      const params = defs.get(head.atom)!;
      const args = nd.list.slice(1);
      if (!hasKwarg(args)) {
        for (let a = 0; a < args.length && a < params.length; a++) {
          const span = args[a].span;
          if (span) hints.push({ pos: span[0], name: params[a] });
        }
      }
    }
    for (const c of nd.list) walk(c);
  };
  for (const f of forms) walk(f);
  return hints;
}
