// lower — scheme → TypeScript LOWERING for the type-layer.
//
// "Scheme is a TS subset except lists and pairs." Walks the s-expr forest (`parseSexprs`
// from @inhuman.tools/arrival-syntax) and emits a TS *string* the lens compiles against
// the harvested prelude (carriers.ts + a `declare const` per tool). Emitted TS NEVER RUNS —
// exists only so the type-checker can narrow a lowered call against its tool signature
// (Σ∩T). Fidelity is about TYPES, not runtime: string-escape exactness, numeric precision
// are immaterial as long as the emitted form carries the right type.
//
// Cut between "plain TS" and "carrier vocabulary":
//   • application `(head a b)` → `head(a, b)` (scheme arg order) — or `_.op$escaped(a, b)`
//     for a non-identifier head (`+`, `string-append`, …) in the prelude's `_` namespace
//     under its escaped dotted name (name-escape.ts — so `typeof _.op` is legal).
//   • lists/pairs (ONLY non-TS-subset values) → carrier globals `list`/`cons`/`car`/`cdr`
//     (functional, never `.car`).
//   • vector `#(…)` → native TS array `[…]`.
//   • dict / keyword-access → object literal / index read.
//   • lambda → arrow; scalars → plain-TS image.
//
// SPAN-MAP (per top-level statement): alongside joined `ts`, returns one
// `{ tsRange, schemeSpan }` per statement — TS byte-range in joined output, scheme
// byte-range from `forms[i].span` (parseSexprs). Per-STATEMENT only: diagnose.ts maps a
// diagnostic's TS offset to the errored statement's scheme span; nothing reads
// sub-expression offsets. `{ ts }` is stable — callers that destructure `.ts` only keep working.

import { parseSexprs, type Node } from "@inhuman.tools/arrival-syntax";

import { escapeName, isTsIdentifier } from "./name-escape.js";

const IDENT = /^[A-Z_$][\w$]*$/i;
/** A plain decimal/integer numeric literal (also covers a leading sign + exponent). */
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
/** A rational literal `p/q` — lowered to a division so its TS type is `number`. */
const RATIONAL = /^([+-]?\d+)\/(\d+)$/;

// arrival-syntax's `Node` is `{ atom; str? } | { list }` (+ inert lead/trail/span/open).
// The package keeps `isAtom`/`isKeyword` out of the public surface, so we re-declare the
// few guards we need — anchored on the same structural shape, never a cast.
type AtomNode = { atom: string; str?: boolean };
type ListNode = { list: Node[] };

const isAtom = (n: Node | undefined): n is AtomNode => n != null && "atom" in n;
const isList = (n: Node | undefined): n is ListNode => n != null && "list" in n;
/** A word atom (not a string literal) — the symbol/operator/number lexeme position. */
const isWord = (n: Node | undefined): n is AtomNode => isAtom(n) && n.str !== true;
/** The bare `#` lexeme — the parser splits `#(…)` into `#` + the following list. */
const isVectorMark = (n: Node | undefined): boolean => isWord(n) && n.atom === "#";
/** A `:keyword` atom (dict key / field-access head); `:` alone is not a keyword. */
const isKeyword = (n: Node | undefined): n is AtomNode => isWord(n) && n.atom.startsWith(":") && n.atom.length > 1;
const keywordName = (n: AtomNode): string => n.atom.slice(1);

const propKey = (k: string): string => (IDENT.test(k) ? k : JSON.stringify(k));

/** One top-level statement's coordinate map: the TS byte-range it occupies in the joined
 *  `ts` output, and the scheme byte-range it lowered from. */
export interface LoweredStatement {
  readonly tsRange: readonly [start: number, end: number];
  readonly schemeSpan: readonly [start: number, end: number];
}

/** The separator `lower` joins top-level statements with — a byte-length constant the
 *  span-map's cumulative TS offset accounts for. */
const STATEMENT_SEP = ";\n";

/**
 * Lower a scheme program to a TypeScript type-inference string. Multiple top-level
 * forms become statements separated by `;\n`. `statements` is the per-statement span-map
 * (additive; `{ ts }` is unchanged).
 */
export function lower(scheme: string): { ts: string; statements: readonly LoweredStatement[] } {
  const forms = parseSexprs(scheme);
  const fragments = emitTopLevel(forms);
  const statements: LoweredStatement[] = [];
  let offset = 0;
  for (const fragment of fragments) {
    const start = offset;
    const end = start + fragment.ts.length;
    statements.push({ tsRange: [start, end], schemeSpan: fragment.schemeSpan });
    offset = end + STATEMENT_SEP.length; // the join inserts the separator after every fragment but the last
  }
  return { ts: fragments.map((f) => f.ts).join(STATEMENT_SEP), statements };
}

/** Lower the top-level forms into per-statement `{ ts, schemeSpan }`, fusing a `#` +
 *  following-list back into one vector statement (as `emitSeq` does). Each statement's
 *  scheme span covers from the first fused node's start to the last's end. A top-level
 *  `(define …)` gets the STATEMENT treatment (`emitTopLevelDefine` → `const …`) — legal
 *  only here; a `define` anywhere else (nested in a lambda body, an arg, …) falls through
 *  emitNode's default dispatch and keeps its prior application-call lowering unchanged. */
function emitTopLevel(nodes: Node[]): { ts: string; schemeSpan: readonly [number, number] }[] {
  const out: { ts: string; schemeSpan: readonly [number, number] }[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    const next = nodes[i + 1];
    if (isVectorMark(node) && isList(next)) {
      out.push({ ts: emitVector(next), schemeSpan: [nodeStart(node), nodeEnd(next)] });
      i++;
      continue;
    }
    const span: readonly [number, number] = [nodeStart(node), nodeEnd(node)];
    if (isList(node) && isWord(node.list[0]) && node.list[0].atom === "define") {
      const defineTs = emitTopLevelDefine(node.list);
      if (defineTs !== undefined) {
        out.push({ ts: defineTs, schemeSpan: span });
        continue;
      }
    }
    out.push({ ts: emitNode(node), schemeSpan: span });
  }
  return out;
}

/** `(define x e)` at TOP LEVEL → `const x = e` — a STATEMENT, legal only at top-level
 *  statement position (a `define` in expression position — a lambda body, an arg, …
 *  falls through emitNode's default dispatch instead, keeping its prior application-call
 *  lowering: `const` cannot appear there). `(define (f a b…) body…)` → `const f = (a: any,
 *  b: any) => body` (a multi-form body folds to a comma sequence, mirroring emitLambda;
 *  `: any` params are advisory polarity, avoiding TS7006 under noImplicitAny).
 *
 *  ACCEPTED RISK: same-program REDEFINE of a top-level name fires TS2451 ("Cannot
 *  redeclare block-scoped variable"). Not engineered around (`var` silently shadows
 *  scoping elsewhere; `let` invites a different mutation-shaped false positive).
 *
 *  Returns undefined for a malformed `(define)`/`(define ())` (no target) — the caller
 *  falls back to the ordinary application-call lowering. */
function emitTopLevelDefine(items: Node[]): string | undefined {
  const target = items[1];
  if (target === undefined) return undefined;
  if (isWord(target)) {
    const value = items[2] === undefined ? "undefined" : emitNode(items[2]);
    return `const ${escapeName(target.atom)} = ${value}`;
  }
  if (!isList(target)) return undefined;
  const nameNode = target.list[0];
  if (!isWord(nameNode)) return undefined;
  // Formals mirror emitLambda's lambdaParams (skip the dotted-tail marker atom), plus an
  // explicit `: any` per param — the advisory polarity this form needs but a plain lambda
  // arrow (inferred from its call site) does not.
  const params = target.list
    .slice(1)
    .filter((p): p is AtomNode => isWord(p) && p.atom !== ".")
    .map((p) => `${p.atom}: any`)
    .join(", ");
  const body = items.slice(2);
  const bodyTs =
    body.length === 0 ? "undefined" : body.length === 1 ? emitNode(body[0]) : `(${emitSeq(body).join(", ")})`;
  return `const ${escapeName(nameNode.atom)} = (${params}) => ${bodyTs}`;
}

/** A node's source start: its own `.span`, or (for a rare span-less synthesized node) the
 *  first spanned descendant's start. Top-level forms are always spanned by parseSexprs; the
 *  descent keeps the map total without a cast. */
function nodeStart(node: Node): number {
  if (node.span !== undefined) return node.span[0];
  if ("list" in node) {
    for (const child of node.list) {
      const s = nodeStart(child);
      if (s >= 0) return s;
    }
  }
  return 0;
}

function nodeEnd(node: Node): number {
  if (node.span !== undefined) return node.span[1];
  if ("list" in node) {
    for (let i = node.list.length - 1; i >= 0; i--) {
      const e = nodeEnd(node.list[i]!);
      if (e >= 0) return e;
    }
  }
  return 0;
}

/**
 * Lower a sibling sequence (a program's top forms, a call's args, a vector's / quoted
 * list's elements), fusing the parser's `#` + following-list back into one vector.
 */
function emitSeq(nodes: Node[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const next = nodes[i + 1];
    if (isVectorMark(nodes[i]) && isList(next)) {
      out.push(emitVector(next));
      i++;
      continue;
    }
    out.push(emitNode(nodes[i]));
  }
  return out;
}

function emitVector(node: ListNode): string {
  return `[${emitSeq(node.list).join(", ")}]`;
}

/** Emit a CALL's args, scheme order preserved. A `:keyword value` run FLIPS into a real object
 *  literal `{ key: value, … }` (the kwargs shape — `:name "Ada"` → `{ name: "Ada" }`), so the
 *  type-checker narrows each value as a plain object property and a kwargs tool's object input
 *  matches with no inverse decode. Leading non-keyword args stay positional (a mixed call
 *  `(f x :a 1)` → `f(x, { a: 1 })`); a bare keyword lowers to `{ key: undefined }`, which the
 *  property type rejects unless it admits undefined. `#(…)` values fuse to a vector as in emitSeq. */
function emitCallArgs(items: Node[]): string {
  const positional: string[] = [];
  const props: string[] = [];
  let kwargs = false;
  for (let i = 0; i < items.length; i++) {
    const node = items[i];
    if (isKeyword(node)) {
      kwargs = true;
      const key = propKey(keywordName(node));
      if (items[i + 1] === undefined) {
        props.push(`${key}: undefined`); // a bare keyword (mid-edit) → undefined; the property type bites
        continue;
      }
      const value = emitValueAt(items, i + 1);
      props.push(`${key}: ${value.ts}`);
      i += value.consumed; // consume the value node(s) (the keyword itself is consumed by the loop)
      continue;
    }
    const value = emitValueAt(items, i);
    positional.push(value.ts);
    i += value.consumed - 1;
  }
  const parts = [...positional];
  if (kwargs) parts.push(props.length === 0 ? "{}" : `{ ${props.join(", ")} }`);
  return parts.join(", ");
}

/** One value node at `items[i]`, fusing a `#(…)` vector (which the parser splits into `#` + list). */
function emitValueAt(items: Node[], i: number): { ts: string; consumed: number } {
  const item = items[i];
  const next = items[i + 1];
  if (isVectorMark(item) && isList(next)) return { ts: emitVector(next), consumed: 2 };
  return { ts: emitNode(item), consumed: 1 };
}

function emitNode(node: Node): string {
  return isAtom(node) ? emitAtom(node) : emitList(node);
}

function emitAtom(node: AtomNode): string {
  if (node.str === true) return JSON.stringify(node.atom);
  const t = node.atom;
  if (t === "#t" || t === "#true") return "true";
  if (t === "#f" || t === "#false") return "false";
  if (NUMBER.test(t)) return t;
  const rat = RATIONAL.exec(t);
  if (rat !== null) return `${rat[1]} / ${rat[2]}`;
  if (isTsIdentifier(t)) return t; // value-position symbol → the declared const / carrier global
  return `_.${escapeName(t)}`; // operator/symbol value → prelude `_` namespace member (escaped, dotted)
}

function emitList(node: ListNode): string {
  const items = node.list;
  if (items.length === 0) return "list()"; // bare () as a value = the empty list
  const head = items[0];

  // (:key obj) → obj["key"]  — keyword in head position is a field read.
  if (isKeyword(head)) {
    const obj = items[1] === undefined ? "undefined" : emitNode(items[1]);
    return `${obj}[${JSON.stringify(keywordName(head))}]`;
  }

  if (isWord(head)) {
    switch (head.atom) {
      case "quote":
        return emitQuote(items[1]);
      case "lambda":
        return emitLambda(items);
      case "dict":
        return emitDict(items);
      case "quasiquote":
        return emitQuasiquote(items[1]);
      case "unquote":
      case "unquote-splicing":
        // A stray unquote/unquote-splicing OUTSIDE a quasiquote (malformed, but kept
        // inert): degrade to the live inner expression.
        return items[1] === undefined ? "undefined" : emitNode(items[1]);
      // ── s.* combinators: TS RESERVED-WORD forms lowered to calls on the `s` property
      // bag (carriers.ts) instead of a bare head — `if(...)`/`let(...)`/`do(...)` as a
      // CALL parse-catastrophes (the token starts a statement, not an expression).
      case "if":
        return emitIf(items);
      case "let":
        return emitLet(items);
      case "let*":
        return emitLetStar(items[1], items.slice(2));
      case "letrec":
      case "letrec*":
        // Advisory fidelity only — mutual-recursion scoping is not modeled; same flat
        // emission as plain `let` (s.let).
        return emitLetBindings(items[1], items.slice(2));
      case "cond":
        return emitCond(items.slice(1));
      case "do":
        return `s.do(${emitCallArgs(items.slice(1))})`;
      case "case":
        return `s.case(${emitCallArgs(items.slice(1))})`;
    }
  }

  // Application — scheme arg order preserved; `:keyword value` args group into kwargs pairs.
  const args = emitCallArgs(items.slice(1));
  if (isWord(head)) {
    return isTsIdentifier(head.atom) ? `${head.atom}(${args})` : `_.${escapeName(head.atom)}(${args})`;
  }
  // Computed head (a nested application / lambda): `(expr a b)` → `expr(a, b)`.
  return `${emitNode(head)}(${args})`;
}

/** `(quote X)` from `'X`. A quoted atom → its value image (symbol → identifier — benign
 *  2304 noise; number/string → itself). A quoted LIST recurses as
 *  QUOTED DATA (never as an application) — `'(("a" 1))` → `list(list("a", 1))`, never the
 *  false-positive `list("a"(1))` that treating the nested list as a call would produce (a
 *  string-literal head would get CALLED). A dotted datum `'(a . b)` → `cons(a, b)`, folding
 *  right through any preceding proper elements: `'(a b . c)` → `cons(a, cons(b, c))`. */
function emitQuote(datum: Node | undefined): string {
  return datum === undefined ? "list()" : emitQuotedDatum(datum);
}

function emitQuotedDatum(datum: Node): string {
  return isList(datum) ? emitQuoteLikeList(datum.list, emitQuotedDatum) : emitNode(datum);
}

/** `(quasiquote X)` from `` `X ``. Degrades to QUOTED DATA exactly like `emitQuote` — a
 *  nested list recurses, a dotted tail folds to `cons` — EXCEPT an `(unquote e)` /
 *  `(unquote-splicing e)` node found ANYWHERE inside emits the LIVE expression `emitNode(e)`,
 *  not further-quoted data. No interpolation/splicing semantics are modeled (advisory
 *  typing only, per the type-layer's inference-only contract) — the unquoted piece's
 *  inferred type is what narrows; splicing behaves identically to plain unquote here. */
function emitQuasiquote(datum: Node | undefined): string {
  return datum === undefined ? "list()" : emitQuasiDatum(datum);
}

function emitQuasiDatum(datum: Node): string {
  if (!isList(datum)) return emitNode(datum);
  const head = datum.list[0];
  if (isWord(head) && (head.atom === "unquote" || head.atom === "unquote-splicing")) {
    const inner = datum.list[1];
    return inner === undefined ? "undefined" : emitNode(inner);
  }
  return emitQuoteLikeList(datum.list, emitQuasiDatum);
}

/** Shared list-body emitter for QUOTE and QUASIQUOTE: fuses `#` + list into a vector (as
 *  `emitSeq`), detects a dotted tail via the bare `.` WORD marker (never a string atom —
 *  R7RS improper-list tail) and folds it into nested `cons(...)`, and recurses every other
 *  element through `emitElem` (quote vs. quasiquote differ only in that recursive step —
 *  quasiquote's `emitElem` additionally un-quotes an `(unquote …)`/`(unquote-splicing …)`
 *  node it encounters). */
function emitQuoteLikeList(items: Node[], emitElem: (n: Node) => string): string {
  const parts: string[] = [];
  let dotSeen = false;
  for (let i = 0; i < items.length; i++) {
    const node = items[i]!;
    if (isWord(node) && node.atom === "." && !dotSeen) {
      dotSeen = true; // the dot itself emits nothing; the following element is the tail
      continue;
    }
    const next = items[i + 1];
    if (isVectorMark(node) && isList(next)) {
      parts.push(emitVector(next)); // vector elements stay plain values (unchanged behavior)
      i++;
      continue;
    }
    parts.push(emitElem(node));
  }
  if (!dotSeen) return `list(${parts.join(", ")})`;
  let acc = parts.at(-1)!;
  for (let i = parts.length - 2; i >= 0; i--) acc = `cons(${parts[i]}, ${acc})`;
  return acc;
}

/** `(lambda (x y) body…)` → `((x, y) => body)`. A multi-form body folds to a comma
 *  sequence (its TS type is the last form's); a symbol formals position is rest-args. */
function emitLambda(items: Node[]): string {
  const params = lambdaParams(items[1]);
  const body = items.slice(2);
  const bodyTs =
    body.length === 0 ? "undefined" : body.length === 1 ? emitNode(body[0]) : `(${emitSeq(body).join(", ")})`;
  return `((${params}) => ${bodyTs})`;
}

function lambdaParams(formals: Node | undefined): string {
  if (formals === undefined) return "";
  if (isWord(formals)) return `...${formals.atom}`; // (lambda rest body…) variadic
  if (!isList(formals)) return "";
  const names: string[] = [];
  for (const p of formals.list) {
    if (isWord(p) && p.atom !== ".") names.push(p.atom); // skip the dotted-tail marker
  }
  return names.join(", ");
}

function emitDict(items: Node[]): string {
  const pairs: string[] = [];
  for (let i = 1; i < items.length; i += 2) {
    const keyNode = items[i];
    const key = isKeyword(keyNode) ? keywordName(keyNode) : isAtom(keyNode) ? keyNode.atom : "";
    const value = items[i + 1] === undefined ? "undefined" : emitNode(items[i + 1]);
    pairs.push(`${propKey(key)}: ${value}`);
  }
  return pairs.length === 0 ? "{}" : `{ ${pairs.join(", ")} }`;
}

// ── s.* combinators — the reserved-word forms (carriers.ts's `s` namespace) ────────────

function emitIf(items: Node[]): string {
  const c = items[1] === undefined ? "undefined" : emitNode(items[1]);
  const a = items[2] === undefined ? "undefined" : emitNode(items[2]);
  if (items[3] === undefined) return `s.if(${c}, ${a})`;
  return `s.if(${c}, ${a}, ${emitNode(items[3])})`;
}

/** One `((name value) …)` binding-list read as parallel `{ names, values }` arrays — the
 *  shared shape `let`/named-let/letrec pull their binding pairs from. A malformed binding
 *  (no name) is skipped rather than crashing the emitter. */
function readBindings(bindingsNode: Node | undefined): { names: string[]; values: string[] } {
  const bindings = isList(bindingsNode) ? bindingsNode.list : [];
  const names: string[] = [];
  const values: string[] = [];
  for (const b of bindings) {
    if (!isList(b)) continue;
    const nameNode = b.list[0];
    if (!isWord(nameNode)) continue;
    names.push(nameNode.atom);
    values.push(b.list[1] === undefined ? "undefined" : emitNode(b.list[1]));
  }
  return { names, values };
}

function letBodyTs(body: Node[]): string {
  return body.length === 0 ? "undefined" : body.length === 1 ? emitNode(body[0]) : `(${emitSeq(body).join(", ")})`;
}

/** `(let ((a v1) (b v2)) body…)` → `s.let(v1, v2, (a, b) => body)` — a single flat call.
 *  Also the emission target for `letrec`/`letrec*` (advisory fidelity — mutual-recursion
 *  scoping is not modeled). */
function emitLetBindings(bindingsNode: Node | undefined, body: Node[]): string {
  const { names, values } = readBindings(bindingsNode);
  const lambda = `(${names.join(", ")}) => ${letBodyTs(body)}`;
  return `s.let(${[...values, lambda].join(", ")})`;
}

/** `(let …)` dispatch: a WORD immediately after `let` is a named let (`(let loop ((i 0))
 *  body…)`), never a bindings list — plain `let`'s bindings position is always a list
 *  (possibly empty, `()`), never a bare symbol. */
function emitLet(items: Node[]): string {
  const second = items[1];
  if (isWord(second)) return emitNamedLet(second.atom, items[2], items.slice(3));
  return emitLetBindings(second, items.slice(2));
}

function emitNamedLet(loopName: string, bindingsNode: Node | undefined, body: Node[]): string {
  const { names, values } = readBindings(bindingsNode);
  const lambda = `(${[loopName, ...names].join(", ")}) => ${letBodyTs(body)}`;
  return `s.namedLet(${[...values, lambda].join(", ")})`;
}

/** `let*` → NESTED `s.let` calls — sequential scoping (each binding's value can see the
 *  previous ones) is structural and can't be expressed as one flat call. */
function emitLetStar(bindingsNode: Node | undefined, body: Node[]): string {
  const bindings = isList(bindingsNode) ? bindingsNode.list : [];
  return emitLetStarFrom(bindings, 0, body);
}

function emitLetStarFrom(bindings: Node[], i: number, body: Node[]): string {
  if (i >= bindings.length) return letBodyTs(body);
  const b = bindings[i];
  if (!isList(b)) return emitLetStarFrom(bindings, i + 1, body);
  const nameNode = b.list[0];
  const name = isWord(nameNode) ? nameNode.atom : "_";
  const value = b.list[1] === undefined ? "undefined" : emitNode(b.list[1]);
  const inner = emitLetStarFrom(bindings, i + 1, body);
  return `s.let(${value}, (${name}) => ${inner})`;
}

/** `(cond (test e…) … (else d…))` → `s.cond([test, e], …, [true, d])` — `else` → `true`
 *  (the `else(` head is what breaks `cond` today); a multi-expression clause body folds to
 *  a comma sequence, same as everywhere else. */
function emitCond(clauses: Node[]): string {
  const parts = clauses.map((clause) => {
    if (!isList(clause)) return "[true, undefined]";
    const [test, ...bodyItems] = clause.list;
    const isElse = isWord(test) && test.atom === "else";
    const testTs = isElse || test === undefined ? "true" : emitNode(test);
    return `[${testTs}, ${letBodyTs(bodyItems)}]`;
  });
  return `s.cond(${parts.join(", ")})`;
}
