/**
 * Sugarcoat → Scheme READER. Inverts sugarcoat-render.ts so a live sugarcoat view can be
 * saved back to canonical scm losslessly (stored entities are ALWAYS raw scm;
 * sugarcoat is a lens). The law: read(render(x)) ≡ x on Scheme.
 *
 * Two layers:
 *   1. I-expressions (indentation): a line + its more-indented descendants form a
 *      list. `define (f x)` ⏎ body → (define (f x) body). A 1-token line with no
 *      children is just that token; multi-token / has-children becomes a list.
 *   2. delimited sub-exprs: `(…)` Scheme lists, free `[…]` → `(list …)`, and `{…}`
 *      which is ODD/EVEN-split: even-arity kv pairs → `(dict …)`; odd operand·op·operand
 *      alternation → curly-infix n-expr (precedence ladder + arrow → lambda + glyphs).
 *      Bracket mode overrides indentation — a `{…}`/`[…]` may span physical lines, so
 *      lines with unbalanced brackets are coalesced before indentation grouping.
 *   plus colon-pairs: under kwarg calls a `key: value` line contributes :key + value.
 *
 * SRFI-105 space-significance: inside n-expr `{}` an operator is a whitespace-isolated
 * token equal to an operator string (so `config/min-for-boundary` is one atom).
 */
import invariant from "tiny-invariant";

import {
  parseSexprs,
  nodeEq,
  printScheme,
  encodeAccessor,
  accessorStepLetters,
  registerSugarcoatReader,
  type Node,
  type PairStep,
} from "./sugarcoat-render.js";

// glyph → canonical op (inverse of INFIX_GLYPH). INJECTIVE for equal?: only ==←equal?
// is remapped in the default ASCII skin; `and`/`or` surface as themselves. Math-skin
// glyphs (`≡`/`∧`/`∨`/…) and legacy `&&`/`||` also fold to the canonical op.
// Word-form comparisons `lt`/`gt`/`lte`/`gte` (hand-typed or pre-rewrite) fold to the
// R7RS heads — same destination as the glyphs they render to — so save prefers scheme
// `<`/`>`/`<=`/`>=` (one-way modernization; not id for those four heads).
// Everything else (=, eq?, eqv?, arithmetic) is its own op. Reader is skin-agnostic.
const GLYPH_OP: Record<string, string> = {
  "==": "equal?",
  "&&": "and", // legacy alias — render now emits `and`
  "||": "or", // legacy alias — render now emits `or`
  "≡": "equal?",
  "∧": "and",
  "∨": "or",
  "≈": "eq?",
  "≃": "eqv?",
  "≤": "<=",
  "≥": ">=",
  // word-form comparisons → R7RS (also accepted as infix glyphs in n-expr)
  lt: "<",
  gt: ">",
  lte: "<=",
  gte: ">=",
  "∷": "cons", // math-skin infix heads: `{a ∷ b}`, `{x ∈ xs}`, `{f ∘ g}`
  "∈": "member",
  "∘": "compose",
};
const opOf = (glyph: string): string => GLYPH_OP[glyph] ?? glyph;

// Negated-comparison glyphs → the relop they wrap in `(not (relop …))` (Family B,
// bidirectional). The infix builder special-cases these to nest under `not`.
const NEG_READ: Record<string, string> = { "≠": "=", "≢": "equal?", "≉": "eq?", "≄": "eqv?" };

// glyph → precedence — must mirror sugarcoat-render's INFIX_PREC. `=>`/`↦` loosest.
// Canonical `and`/`or` are first-class ops; math glyphs + legacy `&&`/`||` mirror them.
const GLYPH_PREC: Record<string, number> = {
  "=>": 0,
  "↦": 0, // math lambda arrow (maps-to) — same as `=>`
  or: 1,
  "||": 1, // legacy
  "∨": 1,
  and: 2,
  "&&": 2, // legacy
  "∧": 2,
  "==": 3,
  "≡": 3,
  "=": 3,
  "eq?": 3,
  "≈": 3,
  "eqv?": 3,
  "≃": 3,
  "<": 3,
  ">": 3,
  "<=": 3,
  "≤": 3,
  ">=": 3,
  "≥": 3,
  // word-form comparisons (prefer-n-expr aliases; fold via GLYPH_OP to R7RS)
  lt: 3,
  gt: 3,
  lte: 3,
  gte: 3,
  // negated-comparison glyphs (math skin) — same tier; each expands to `(not (relop …))`.
  "≠": 3,
  "≢": 3,
  "≉": 3,
  "≄": 3,
  "∷": 3, // cons — comparison tier (looser than arithmetic)
  "∈": 3, // member
  "+": 4,
  "-": 4,
  "∘": 5, // compose — tight, like `.`
  // Multiplicative tier MUST mirror sugarcoat-render's INFIX_PREC — render emits
  // `modulo`/`quotient`/`remainder` as infix, so read has to recognise them back
  // or `{a modulo b}` fails as "unbalanced {" (round-trip break).
  "*": 5,
  "/": 5,
  modulo: 5,
  quotient: 5,
  remainder: 5,
};
const isOp = (w: string): boolean => w in GLYPH_PREC;
const isAtomNode = (n: Node): n is { atom: string; str?: boolean } => "atom" in n;
/** True when a flat curly item is a bare operator atom (not a string, not a list). */
const isOpAtom = (n: Node): n is { atom: string } => isAtomNode(n) && !n.str && isOp(n.atom);

/** Logical op family for the licenseless-mixing door (ASCII + legacy + math). */
const LOGICAL_AND = new Set(["and", "&&", "∧"]);
const LOGICAL_OR = new Set(["or", "||", "∨"]);
/** True when a flat operand·op·operand sequence mixes `and` and `or` at the top
 *  level (no nested `{…}` to group them). Nested lists already containerize. */
function hasBareMixedLogicals(items: Node[]): boolean {
  let sawAnd = false;
  let sawOr = false;
  for (let i = 1; i < items.length; i += 2) {
    const n = items[i];
    if (!isOpAtom(n)) continue;
    if (LOGICAL_AND.has(n.atom)) sawAnd = true;
    if (LOGICAL_OR.has(n.atom)) sawOr = true;
  }
  return sawAnd && sawOr;
}

/**
 * Classify a flat sequence of forms inside `{…}` (ops are ordinary atoms here).
 *   empty              → dict
 *   one form           → unwrap (SRFI-105 identity; braces are noise)
 *   odd ≥3, ops at 1,3,5… and non-ops at 0,2,4… → n-expr (curly-infix)
 *   even, no op-at-odd → dict
 *   anything else      → error (broken infix or odd non-infix)
 */
type CurlyKind = "dict" | "unwrap" | "infix" | "error";
function classifyCurly(items: Node[]): CurlyKind {
  if (items.length === 0) return "dict";
  if (items.length === 1) return "unwrap";
  // Full operand·op·operand… alternation (odd length, ops only on odd indices).
  if (items.length % 2 === 1) {
    let alt = true;
    for (const [i, item] of items.entries()) {
      if ((i % 2 === 1) !== isOpAtom(item!)) {
        alt = false;
        break;
      }
    }
    if (alt) return "infix";
    // Odd but not alternating — e.g. `{a b c}`, or `{a + b c}` (op then trailing junk).
    return "error";
  }
  // Even length: dict unless an operator sits where an operand/key should, or an
  // odd slot holds an op (truncated infix like `{a +}` → [a, +]).
  for (const [i, item] of items.entries()) {
    if (i % 2 === 1 && isOpAtom(item!)) return "error"; // `{a +}` or `{a + b +}`
    if (i % 2 === 0 && isOpAtom(item!)) return "error"; // `{+ 1}` as broken n-expr
  }
  return "dict";
}

/** Suffix-key flip at dict KEY positions: `name:` → `:name` (arrival dict-grammar). */
function normalizeDictKeys(items: Node[]): Node[] {
  const out: Node[] = [];
  for (let i = 0; i < items.length; i += 2) {
    let k = items[i]!;
    const v = items[i + 1];
    if (
      isAtomNode(k) &&
      !k.str &&
      k.atom.length > 1 &&
      k.atom.endsWith(":") &&
      !k.atom.startsWith(":") &&
      !k.atom.endsWith("::")
    ) {
      k = { atom: `:${k.atom.slice(0, -1)}` };
    }
    out.push(k);
    if (v !== undefined) out.push(v);
  }
  return out;
}

const LET_FAMILY = new Set(["let", "let*", "letrec", "letrec*"]);
const bindingShaped = (n: Node): boolean => !isAtomNode(n) && n.list.length === 2 && isAtomNode(n.list[0]);
/** Re-introduce the elided bindings `(( ))` for a let-family form. The render drops
 *  it (each binding shown `name`⏎`value`); here we collect the leading binding-shaped
 *  children back into a bindings list. Non-elided forms (items[1] already a bindings
 *  list — first elem a list, or empty) are left untouched. */
function regroupLetFamily(node: Node): Node {
  if (isAtomNode(node) || node.list.length < 2) return node;
  const h = node.list[0];
  if (!isAtomNode(h) || !LET_FAMILY.has(h.atom)) return node;
  // NAMED let `(let loop binding… body)`: the loop symbol is child 1, bindings start at 2.
  // (A plain let's child 1 is a list — the first elided binding or the `(( ))` group.)
  const named = isAtomNode(node.list[1]) && node.list.length > 2;
  const bindStart = named ? 2 : 1;
  const x = node.list[bindStart];
  const alreadyBindingsList = x !== undefined && !isAtomNode(x) && (x.list.length === 0 || !isAtomNode(x.list[0]));
  if (alreadyBindingsList) return node;
  const bindings: Node[] = [];
  let i = bindStart;
  // Never consume the LAST child: a let-family form requires a body, so when every child is
  // binding-shaped the final one is the body (it would otherwise be swallowed into the
  // bindings, emitting a body-less let).
  while (i < node.list.length - 1 && bindingShaped(node.list[i])) bindings.push(node.list[i++]);
  if (bindings.length === 0) return node;
  const prefix = named ? [h, node.list[1]!] : [h];
  return { list: [...prefix, { list: bindings }, ...node.list.slice(i)] };
}

// `start`/`end` are absolute offsets in the ORIGINAL sugarcoat text, present only when
// `tokenize` is given a `base` (single-physical-line LogLines). They thread up into
// `Node.span` for the editor's parameter hints; coalesced multi-line content passes
// no base, so its tokens carry no offsets and produce no hints (graceful).
// `tight` (on `(` only) = no whitespace separates this token from the one before
// it on the same source line. The method-dot reader needs it to tell a call-args
// group `fold(knil)` (tight) from a sibling operand `clicking? (cons …)` (loose) —
// the tokenizer discards whitespace, so adjacency must be recorded as it lexes.
// Computed locally (independent of `base`), so it's present even when offsets aren't.
type Tok =
  | { t: "(" | ")" | "{" | "}" | "[" | "]"; start?: number; end?: number; tight?: boolean }
  | { t: "."; start?: number; end?: number } // method-dot (postfix apply) — see splitMethodDots
  | { t: "quote"; v: "'" | "`" | "," | ",@"; start?: number; end?: number }
  | { t: "word"; v: string; str?: boolean; start?: number; end?: number }
  | { t: "at"; node: Node; start?: number; end?: number }; // @head{…} at-expression (already parsed)

// ident-start glyphs (R7RS initial set, minus digits): a `.` only splits when the
// next char is one of these — so `0.5`/`x.5` (decimals) and `(a . b)` stay whole.
const IDENT_START = /[A-Z!$%&*/:<=>?^_~]/i;

/** `rewrite_L` — split a raw WORD at each method-dot into `(word? .)* word` tokens.
 *  A `.` at index k splits iff (a) it is SINGLE — neither neighbour is `.` (so `..`
 *  `...` `a...` stay whole), and (b) the next char is an ident-start, non-digit.
 *  Word-INITIAL dots split too (no preceding word emitted) — that is the line-leading
 *  `.map` (§3.4) and the post-delimiter `recv.op.op` case, where `}`/`]`/`)` break
 *  the run so the dot starts a fresh one. `\.` is an escaped LITERAL dot: unescaped
 *  into the symbol here, re-escaped on render. A lone `.` (dotted pair) and a word
 *  with no qualifying dot return `[word]` unchanged — the reclamation is free (corpus
 *  has 0 in-word code dots, 0 space-flanked dotted pairs). */
function splitMethodDots(w: string, s: number, base?: number): Tok[] {
  const out: Tok[] = [];
  const at = (a: number, b: number) => (base == null ? {} : { start: base + s + a, end: base + s + b });
  let seg = "";
  let segStart = 0;
  let k = 0;
  while (k < w.length) {
    const c = w[k];
    if (c === "\\" && w[k + 1] === ".") {
      seg += "."; // escaped literal dot — stays in the symbol
      k += 2;
      continue;
    }
    const prev = k > 0 ? w[k - 1] : undefined;
    const next = w[k + 1];
    if (
      c === "." &&
      prev !== "." && // single dot — `..`/`...` stay whole (k=0 has no prev → passes)
      next !== "." &&
      next !== undefined &&
      IDENT_START.test(next) &&
      !/\d/.test(next)
    ) {
      if (seg.length > 0) out.push({ t: "word", v: seg, ...at(segStart, k) }); // left segment, if any
      out.push({ t: ".", ...at(k, k + 1) });
      seg = "";
      segStart = k + 1;
      k++;
      continue;
    }
    seg += c;
    k++;
  }
  if (seg.length > 0 || out.length === 0) out.push({ t: "word", v: seg, ...at(segStart, k) });
  return out;
}

/** One `[…]` index, classified. Integers are PAIR access (`[k]`→pull, `[k:]`→drop,
 *  fused into `c[ad]+r` words); a `:keyword` is STATIC key access (→ `(:k obj)`, the
 *  recommended keyword-as-fn form); any other identifier or string is DYNAMIC key
 *  access (→ `(@ obj key)`). One bracket surface, disambiguated purely by the index's
 *  shape so the destinations can never collide. Inverse of sugarcoat-render's emission. */
type Subscript = PairStep | { key: string } | { dyn: Node };

function parseSubscript(t: Extract<Tok, { t: "word" }>): Subscript {
  const idx = t.v;
  if (t.str) return { dyn: atom(idx, true) }; // "name" → dynamic string key
  if (/^\d+$/.test(idx)) return { pull: Number(idx) }; // [k]  → take element k
  if (/^\d+:$/.test(idx)) {
    const k = Number(idx.slice(0, -1));
    invariant(k >= 1, () => `bad subscript '[${idx}]'`); // [k:] → drop first k (k ≥ 1)
    return { drop: k };
  }
  if (idx.startsWith(":") && idx.length > 1) return { key: idx }; // :verdict → static key
  return { dyn: atom(idx) }; // identifier → dynamic key
}

/** r7rs `(scheme cxr)` defines accessor words of up to 4 letters (car … cddddr).
 *  The DEFAULT reader caps subscript fusion at this many accessor-word letters, so
 *  a long chain like `x[0][1][2]` lowers to nested standard words `(caddr (cadar
 *  x))` rather than one non-portable `caddadar`. Pass `accessorDepth: Infinity` for
 *  unbounded fusion (one `c[ad]+r` word per chain, resolved by the runtime catchall
 *  on both interpreter and compiler). A single inherently-deep subscript (`x[5]`,
 *  only ever produced by rendering an already-non-standard word) is never split —
 *  splitting would break the sugarcoat-side round-trip — so the cap governs fusion of
 *  ADJACENT subscripts, the only place the reader actually has a choice. */
export const R7RS_ACCESSOR_DEPTH = 4;

// reader-macro prefix → the symbol it expands to (mirrors parseSexprs).
const QUOTE_WRAP: Record<string, string> = {
  "'": "quote",
  "`": "quasiquote",
  ",": "unquote",
  ",@": "unquote-splicing",
};

// ── at-expressions (prose / tagged-template sub-reader) ─────────────────────────
// `@head{ text }` → (head <part>…); headless `@{…}` and `@str{…}` both → `(str …)`
// (`str` is the explicit alias of the headless default); `@dedent{…}` dissolves to
// (str <dedented>). Inside a body the only escape is `@`: `@id`
// interpolates, `@(datum)` grafts code, `@head{…}` nests. Everything else — quotes,
// newlines, balanced `{}` — is literal text.

// head of `@head{`: any non-delimiter run (str, string-append, dedent, config/x).
const AT_HEAD = /[^\s{}()[\]"@]/;
// bare `@id` interpolation: ident-ish; STOPS at `.` (not in the class) so prose
// periods stay literal — richer holes use the `@(expr)` graft.
const AT_INTERP = /[\w!$%&*/:<=>?^~+-]/;
const strAtom = (s: string): Node => ({ atom: s, str: true });

// String atoms store the SOURCE-escaped form (the normal string tokenizer preserves
// backslash sequences; printScheme wraps verbatim). The at-body reader accumulates
// RAW characters (so dedent can see real newlines), then escapes at the end.
const SCHEME_ESC: Record<string, string> = {
  "\\": "\\\\",
  '"': String.raw`\"`,
  "\n": String.raw`\n`,
  "\r": String.raw`\r`,
  "\t": String.raw`\t`,
};
const escapeSchemeString = (s: string): string => s.replaceAll(/[\\"\n\r\t]/g, (ch) => SCHEME_ESC[ch]);
const escapeStrParts = (parts: Node[]): Node[] =>
  parts.map((p) => ("atom" in p && p.str ? strAtom(escapeSchemeString(p.atom)) : p));

/** Strip the common leading indentation from `@dedent{…}` literal parts — the
 *  cognitive-rung `dedent` head applied at read, so it dissolves to plain `str`.
 *  Indentation only ever follows a `\n` inside a literal part (interpolations break
 *  parts), so the strip is intra-part. The first line (inline after `{`) is excluded;
 *  blank lines don't lower the minimum. */
function dedentParts(parts: Node[]): Node[] {
  const skel = parts.map((p) => ("atom" in p && p.str ? p.atom : "\u0000")).join("");
  const lines = skel.split("\n");
  let min = Infinity;
  for (let k = 1; k < lines.length; k++) {
    if (lines[k].trim() === "") continue; // blank line — ignore
    min = Math.min(min, /^[ \t]*/.exec(lines[k])![0].length);
  }
  if (min === Infinity || min === 0) return parts;
  return parts.map((p) =>
    "atom" in p && p.str ? strAtom(p.atom.replaceAll(/\n([ \t]*)/g, (_m, ws: string) => `\n${ws.slice(min)}`)) : p,
  );
}

/** Bare `@id` interpolation name, restricted class (§3b). `i` points past the `@`. */
function readInterpId(src: string, i: number): { id: string; end: number } {
  let id = "";
  while (i < src.length && AT_INTERP.test(src[i])) {
    id += src[i];
    i++;
  }
  return { id, end: i };
}

/**
 * Tight trailing `[…]` subscript chain after a bare interp name — the surface
 * `@persona[:id]` / `@xs[0][1:]`. String-aware so a dynamic key's quoted text
 * can't spoof the bracket balance. Returns `end === start` when no chain.
 */
function readTightSubscripts(src: string, start: number): { end: number } {
  let i = start;
  while (i < src.length && src[i] === "[") {
    let depth = 0;
    let inStr = false;
    for (; i < src.length; i++) {
      const c = src[i];
      if (inStr) {
        if (c === "\\") i++;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === "[") depth++;
      else if (c === "]" && --depth === 0) {
        i++;
        break;
      }
    }
  }
  return { end: i };
}

/**
 * Tight trailing method chain after a bare interp name / subscripts —
 * `@hints.map{(h) => …}` / `@xs.filter{ it > 0 }.length`. Only TIGHT
 * `.op` / `.op(…)` / `.op{…}` (no space before `(`/`{`), matching the
 * code-context method reader. Returns `end === start` when no chain.
 *
 * Op names exclude `:` — otherwise `@view.number->string:` (next prose is
 * a separator colon) greedily eats `number->string:` as one symbol.
 */
const AT_METHOD_OP = /[\w!$%&*/<=>?^~+-]/; // AT_INTERP minus `:`
function readTightMethodChain(src: string, start: number): { end: number } {
  let i = start;
  while (i < src.length && src[i] === ".") {
    // op name — at least one method-op char
    let j = i + 1;
    if (j >= src.length || !AT_METHOD_OP.test(src[j]!)) break;
    while (j < src.length && AT_METHOD_OP.test(src[j]!)) j++;
    // optional tight (args)
    if (src[j] === "(") {
      let depth = 0;
      let inStr = false;
      for (; j < src.length; j++) {
        const c = src[j]!;
        if (inStr) {
          if (c === "\\") j++;
          else if (c === '"') inStr = false;
          continue;
        }
        if (c === '"') inStr = true;
        else if (c === "(") depth++;
        else if (c === ")" && --depth === 0) {
          j++;
          break;
        }
      }
    }
    // optional tight { trailing-lambda / curly body }
    if (src[j] === "{") {
      let depth = 0;
      let inStr = false;
      for (; j < src.length; j++) {
        const c = src[j]!;
        if (inStr) {
          if (c === "\\") j++;
          else if (c === '"') inStr = false;
          continue;
        }
        if (c === '"') inStr = true;
        else if (c === "{") depth++;
        else if (c === "}" && --depth === 0) {
          j++;
          break;
        }
      }
    }
    i = j;
  }
  return { end: i };
}

/** `@(datum)` graft — read the balanced `(…)` raw (string/escape aware) and parse it
 *  as one sugarcoat expression. `i` points at the `(`. */
function readGraftParen(src: string, i: number): { node: Node; end: number } {
  let depth = 0;
  let inStr = false;
  let j = i;
  for (; j < src.length; j++) {
    const c = src[j];
    if (inStr) {
      if (c === "\\") j++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) {
      j++;
      break;
    }
  }
  return { node: readSugarcoatExpr(src.slice(i, j)), end: j };
}

/** An at-expression iff `@`, optional head, then `{`. Returns null for a bare
 *  `@`/`@foo` (stays an ordinary symbol — backwards-compat, §2). `i` points at `@`.
 *
 *  Heads containing `.` are rejected — `@hints.map{…}` is a bare-interp method
 *  chain, not an at-expr with head `hints.map` (AT_HEAD would otherwise eat the
 *  dots and steal the method brace as a text body). */
function tryReadAtExpr(src: string, i: number): { node: Node; end: number } | null {
  let j = i + 1;
  while (j < src.length && AT_HEAD.test(src[j]!)) j++;
  if (src[j] !== "{") return null;
  // headless `@{…}` → str; `@str{…}` is the same head (explicit alias, not R7RS `string`).
  const rawHead = src.slice(i + 1, j);
  if (rawHead.includes(".")) return null; // method chain, not at-expr head
  const head = rawHead === "" || rawHead === "str" ? "str" : rawHead;
  const { parts, end } = parseAtBody(src, j + 1); // past `{` — RAW literal parts
  // dedent runs on raw text (real newlines), THEN literal parts get source-escaped.
  const finalParts = escapeStrParts(head === "dedent" ? dedentParts(parts) : parts);
  const node: Node =
    head === "dedent"
      ? { list: [atom("str"), ...finalParts] } // dedent dissolves to str (§4)
      : { list: [atom(head), ...finalParts] };
  return { node, end };
}

/** Read a text body from just-past-`{` to its matching `}`. Coalesces literal runs
 *  into single string parts; `@` escapes to a graft / nested at-expr / interpolation;
 *  balanced literal `{}` stay verbatim. */
function parseAtBody(src: string, i: number): { parts: Node[]; end: number } {
  const parts: Node[] = [];
  let buf = "";
  const flush = (): void => {
    if (buf.length > 0) {
      parts.push(strAtom(buf));
      buf = "";
    }
  };
  let depth = 0; // balanced LITERAL braces inside the body
  while (i < src.length) {
    const c = src[i];
    if (c === "}") {
      if (depth === 0) {
        i++;
        break; // body close
      }
      depth--;
      buf += c;
      i++;
      continue;
    }
    if (c === "{") {
      depth++;
      buf += c;
      i++;
      continue; // literal brace (balanced)
    }
    if (c === "@") {
      if (src[i + 1] === "(") {
        flush();
        const g = readGraftParen(src, i + 1);
        parts.push(g.node);
        i = g.end;
        continue;
      }
      if (src[i + 1] === "|") {
        // `@|sym|` — explicit-boundary interpolation, for when the next literal char
        // would otherwise glue onto a bare `@id` (`@|name|!` vs the greedy `@name!`).
        let k = i + 2;
        let sym = "";
        while (k < src.length && src[k] !== "|") {
          sym += src[k];
          k++;
        }
        if (src[k] === "|") {
          flush();
          parts.push(atom(sym));
          i = k + 1;
          continue;
        }
      }
      const nested = tryReadAtExpr(src, i);
      if (nested) {
        flush();
        parts.push(nested.node);
        i = nested.end;
        continue;
      }
      const { id, end: idEnd } = readInterpId(src, i + 1);
      if (id.length > 0) {
        flush();
        // Tight postfix after `@id`: subscripts then method chain —
        // `@persona[:id]`, `@hints.map{(h) => @{…}}`. Spaced `@id […]` /
        // `@id .map` leaves the rest as prose (deliberate boundary).
        const afterSubs = readTightSubscripts(src, idEnd).end;
        const chainEnd = readTightMethodChain(src, afterSubs).end;
        if (chainEnd > idEnd) {
          // `id + postfix` without the leading `@` — same grammar as
          // code-context `hints.map{…}` / `persona[:id]`.
          parts.push(readSugarcoatExpr(src.slice(i + 1, chainEnd)));
          i = chainEnd;
        } else {
          parts.push(atom(id));
          i = idEnd;
        }
        continue;
      }
      buf += c; // lone `@` → literal
      i++;
      continue;
    }
    buf += c;
    i++;
  }
  flush();
  return { parts, end: i };
}

function tokenize(src: string, base?: number): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  // Stamp absolute offsets onto a token iff a base is given (see Tok's note).
  const at = (start: number, end: number) => (base == null ? {} : { start: base + start, end: base + end });
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const s = i;
    if (c === "(" || c === ")" || c === "{" || c === "}" || c === "[" || c === "]") {
      i++;
      const tight = s > 0 && !/\s/.test(src[s - 1]);
      toks.push({ t: c, ...at(s, i), tight });
      continue;
    }
    if (c === "'" || c === "`") {
      i++;
      toks.push({ t: "quote", v: c, ...at(s, i) });
      continue;
    }
    if (c === ",") {
      const v = src[i + 1] === "@" ? ",@" : ",";
      i += v.length;
      toks.push({ t: "quote", v, ...at(s, i) });
      continue;
    }
    if (c === '"') {
      let str = "";
      i++;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === "\\") {
          str += src[i] + (src[i + 1] ?? "");
          i += 2;
        } else {
          str += src[i];
          i++;
        }
      }
      i++;
      toks.push({ t: "word", v: str, str: true, ...at(s, i) });
      continue;
    }
    if (c === "@") {
      // `@head{…}` at-expression — read the raw body (newlines intact). A bare
      // `@`/`@foo` (no `{`) is NOT one → fall through to the word run, stays a symbol.
      const r = tryReadAtExpr(src, i);
      if (r) {
        toks.push({ t: "at", node: r.node, ...at(s, r.end) });
        i = r.end;
        continue;
      }
    }
    let j = i;
    while (j < src.length && !/\s/.test(src[j]) && !'(){}[]"'.includes(src[j])) j++;
    for (const tk of splitMethodDots(src.slice(i, j), s, base)) toks.push(tk);
    i = j;
  }
  return toks;
}

/** Racket `#:limit` ≡ arrival `:limit` — same identity as ASymbol keyword mint. */
const canonKeyword = (w: string): string => (w.length > 2 && w.startsWith("#:") ? `:${w.slice(2)}` : w);
const atom = (w: string, str?: boolean): Node => (str ? { atom: w, str: true } : { atom: canonKeyword(w) });
const isColonKey = (t: Tok): t is Extract<Tok, { t: "word" }> =>
  t.t === "word" && !t.str && t.v.length > 1 && t.v.endsWith(":") && !t.v.slice(0, -1).includes(":");

/** Parse a token array into a SEQUENCE of Scheme elements: `(…)` lists, `{…}`
 *  curlies, quoted data, and atoms. Colon-keys are NOT handled here — parseNode
 *  strips a line-leading `key:` first, so trailing-colon tokens never reach this. */
function parseElements(toks: Tok[], accessorDepth: number = R7RS_ACCESSOR_DEPTH): Node[] {
  let pos = 0;
  const peek = (): Tok | undefined => toks[pos];
  const next = (): Tok => toks[pos++];

  // Run `read`, then stamp the produced node's source span from the tokens it
  // consumed ([first.start, last.end]) — present only when the tokens carry offsets
  // (single-line content). Inert metadata for the editor's parameter hints.
  const spanned = (read: () => Node): Node => {
    const startPos = pos;
    const node = read();
    const s = toks[startPos]?.start;
    const e = toks[pos - 1]?.end;
    if (s != null && e != null && node.span == null) node.span = [s, e];
    return node;
  };

  // Postfix subscripts: consume any `[…]` following an operand. Integer indices FUSE
  // into pair-accessor words (`xs[0]`→(car xs), `xs[1:]`→(cdr xs), `xs[0][1]`→(cadar
  // xs) — one word, not (cadr (car xs))), capped at `accessorDepth` accessor-word
  // letters (overflow flushes the current word and starts fresh, so default mode
  // emits only portable standard words). A KEY index (`[:k]` / `[ident]`) can't be
  // part of a c[ad]+r word, so it flushes the pending pair run and wraps on its own:
  // `xs[:verdict]`→(:verdict xs), `xs[k]`→(@ xs k). Binds tighter than infix, so it's
  // applied to each fully-read datum/operand before the infix climber sees it.
  function withSubscripts(node: Node): Node {
    let n = node;
    let pairs: PairStep[] = [];
    let letters = 0;
    const flush = (): void => {
      if (pairs.length === 0) return;
      n = { list: [atom(encodeAccessor(pairs)), n] };
      pairs = [];
      letters = 0;
    };
    // Tight `[` only — a spaced `[…]` is a free list literal (`(f [1 2])`), not a
    // subscript. Same adjacency rule as method-arg `(` / trailing-lambda `{`.
    for (;;) {
      const p = peek();
      if (p?.t === "[" && p.tight) {
        // fall through to subscript arm below
      } else if (p?.t === ".") {
        // method-dot arm
      } else break;
      if (p.t === ".") {
        // method-dot step `.op`, `.op { B }`, `.op(args)`, `.op(args){ B }` — the
        // receiver-last fold: every step seats the receiver in the LAST arg slot,
        // exactly as a subscript does. A method breaks the c[ad]+r run (flush first).
        next(); // .
        const opTok = next();
        invariant(!!opTok && opTok.t === "word" && !opTok.str, "expected method name after '.'");
        flush();
        const op = atom(opTok.v);
        const args: Node[] = []; // optional positional group: seed for fold/reduce (§7.3)
        // Only a TIGHT paren is call-args: `fold(knil)`. A space-separated `(…)` is a
        // sibling operand (`(clicking? x) (cons …)`), not args — never swallow it.
        const argParen = peek();
        if (argParen?.t === "(" && argParen.tight) {
          next();
          while (peek() && peek()!.t !== ")") args.push(datum());
          invariant(peek()?.t === ")", "unbalanced '(' in method args");
          next();
        }
        // Only a TIGHT brace is THIS step's trailing lambda (`map{…}`, `fold(knil){…}`).
        // A space-separated `{…}` is a sibling curly operand (`recv.op {n + 1}`) — leave
        // it for parseElements, else a bare method swallows its neighbour. Tight on `op`
        // (bare) or on the closing `)` of a tight arg-group; mirrors the arg-paren rule.
        const lamBrace = peek();
        if (lamBrace?.t === "{" && lamBrace.tight) {
          next();
          const lam = trailingLambda(); // arrow / implicit-`it` body; consumes `}`
          n = { list: [op, lam, ...args, n] }; // (op Λ args… recv)
        } else {
          n = { list: [op, ...args, n] }; // (op args… recv)  — bare / positional pipe
        }
        continue;
      }
      next(); // [
      const t = next();
      invariant(!!t && t.t === "word", "expected index inside '[ ]'");
      const close = next();
      invariant(!!close && close.t === "]", "unbalanced '['");
      const sub = parseSubscript(t);
      if ("pull" in sub || "drop" in sub) {
        const cost = accessorStepLetters(sub);
        if (letters > 0 && letters + cost > accessorDepth) flush();
        pairs.push(sub);
        letters += cost;
      } else {
        flush(); // a key access breaks the c[ad]+r run
        n =
          "key" in sub
            ? { list: [atom(sub.key), n] } // (:verdict obj) — static keyword-as-fn
            : { list: [atom("@"), n, sub.dyn] }; // (@ obj key)  — dynamic field access
      }
    }
    flush();
    return n;
  }

  // The `nil` glyph is the inverse of sugarcoat-render's `'()`→`nil`: a bare `nil`
  // at a VALUE position folds back to `(quote ())`. Guarded to `quoteDepth === 0` so a
  // quoted `'nil` (the SYMBOL nil — a valid R7RS datum) stays a symbol, not the empty
  // list. (A program that binds `nil` as a variable renders WITHOUT the glyph — see
  // collectNilAllowed — so the only bare `nil` tokens the reader meets are empty-lists.)
  let quoteDepth = 0;
  const wordNode = (v: string, str?: boolean): Node => {
    if (str) return atom(v, true);
    // `nil` → `(quote ())` at value position (guarded so quoted `'nil` stays a symbol).
    if (v === "nil" && quoteDepth === 0) return { list: [atom("quote"), { list: [] }] };
    // The cond partial-arrow glyph → the R7RS `=>` receiver symbol. `=?>` is the ASCII
    // form; `⇀`/`⇸` (partial-function arrows) are accepted as the math skin. Pure
    // invented punctuation — never a user symbol — so it folds unconditionally.
    if (v === "=?>" || v === "⇀" || v === "⇸") return atom("=>");
    return atom(v);
  };

  // `'`/`` ` ``/`,`/`,@` prefix → (quote datum) etc. Recurses (`''x` → nested).
  function quoted(parseDatum: () => Node): Node {
    const t = peek();
    if (t?.t === "quote") {
      next();
      quoteDepth++;
      const inner = quoted(parseDatum);
      quoteDepth--;
      return { list: [atom(QUOTE_WRAP[t.v]), inner] };
    }
    return parseDatum();
  }

  // The standard datum read: span the BASE operand first (so `5` inside `5[0]`
  // is its own align/hover target), then the subscript-wrapped whole (so the
  // sugared (car 5) node spans `5[0]`) — spanned() only fills empty spans, so
  // the two stamps never fight.
  const datum = (): Node => spanned(() => withSubscripts(spanned(() => quoted(schemeDatum))));

  function schemeList(): Node {
    const items: Node[] = [];
    while (peek() && peek()!.t !== ")") items.push(datum());
    invariant(!!peek(), "unbalanced (");
    next();
    return { list: items };
  }
  /** Free-standing `[…]` → `(list …)`. Tight postfix `xs[0]` never reaches here
   *  (withSubscripts peels those after the base datum is read). */
  function freeList(): Node {
    const items: Node[] = [];
    while (peek() && peek()!.t !== "]") items.push(datum());
    invariant(peek()?.t === "]", "unbalanced [");
    next();
    return { list: [atom("list"), ...items] };
  }
  function schemeDatum(): Node {
    const t = next();
    if (t.t === "(") return schemeList();
    if (t.t === "[") return freeList();
    if (t.t === "{") return curly();
    if (t.t === "at") return t.node;
    if (t.t === "word") return wordNode(t.v, t.str);
    invariant(false, () => `unexpected '${t.t}'`);
  }

  function curlyAtomic(): Node {
    const t = peek();
    invariant(!!t, "unexpected end in curly");
    if (t.t === "(") {
      next();
      return schemeList();
    }
    if (t.t === "[") {
      next();
      return freeList();
    }
    if (t.t === "{") {
      next();
      return curly();
    }
    if (t.t === "at") {
      next();
      return t.node;
    }
    if (t.t === "word" && !isOp(t.v)) {
      next();
      return wordNode(t.v, t.str);
    }
    invariant(false, () => `expected operand in curly, got '${t.t === "word" ? t.v : t.t}'`);
  }
  /** Flat curly item: same as an operand, but operator words are allowed as atoms
   *  so classification can see the operand·op·operand skeleton. */
  function curlyFlatItem(): Node {
    return spanned(() =>
      withSubscripts(
        spanned(() =>
          quoted(() => {
            const t = peek();
            invariant(!!t, "unexpected end in curly");
            if (t.t === "(") {
              next();
              return schemeList();
            }
            if (t.t === "[") {
              next();
              return freeList();
            }
            if (t.t === "{") {
              next();
              return curly();
            }
            if (t.t === "at") {
              next();
              return t.node;
            }
            if (t.t === "word") {
              next();
              return wordNode(t.v, t.str);
            }
            invariant(false, () => `unexpected '${t.t}' in curly`);
          }),
        ),
      ),
    );
  }
  function curlyOperand(): Node {
    // double-spanned like `datum`: infix operands are read OUTSIDE schemeList's
    // item loop, so they need their own stamps (atoms in `{n - 1}` are
    // hover/align targets; the inner stamp covers a subscripted base).
    return spanned(() => withSubscripts(spanned(() => quoted(curlyAtomic))));
  }
  function infix(minPrec: number): Node {
    let left = curlyOperand();
    for (;;) {
      const t = peek();
      if (t?.t !== "word" || !isOp(t.v) || GLYPH_PREC[t.v] < minPrec) break;
      const glyph = t.v;
      const p = GLYPH_PREC[glyph];
      const operands = [left];
      for (let tk = peek(); tk?.t === "word" && tk.v === glyph; tk = peek()) {
        next();
        operands.push(infix(p + 1));
      }
      left =
        glyph === "=>" || glyph === "↦" // ASCII or math (maps-to) lambda arrow
          ? { list: [atom("lambda"), operands[0], operands[1]] }
          : NEG_READ[glyph] // `≠`/`≢`/`≉`/`≄` → (not (relop …))
            ? { list: [atom("not"), { list: [atom(NEG_READ[glyph]), ...operands] }] }
            : { list: [atom(opOf(glyph)), ...operands] };
    }
    return left;
  }
  /** Close-check for `{…}` contexts, phrased for the actual failure. When the token
   *  that stopped the infix parse is a WORD, the problem is almost never bracket
   *  balance — it's an unknown infix operator (a removed glyph like `??`, a typo) or
   *  a second datum where an operator belongs. Name it and list the vocabulary. */
  function requireCurlyClose(context: string): void {
    const t = peek();
    if (t?.t === "}") return;
    if (t?.t === "word")
      invariant(
        false,
        () =>
          `expected '}' or an infix operator, got '${t.v}'${context} — operators: ${Object.keys(GLYPH_PREC).join(" ")}`,
      );
    invariant(false, () => `unbalanced {${context}`);
  }
  /**
   * `{…}` is shared by dicts and n-exprs. Classify by flat shape first:
   *   {} / even kv pairs → (dict …)
   *   single form → unwrap
   *   odd operand·op·operand… → Pratt infix (reset + reparse)
   *   else → door naming the odd/even rule
   * Trailing-lambda bodies call `infix` directly (always n-expr context).
   */
  function curly(): Node {
    if (peek()?.t === "}") {
      next();
      return { list: [atom("dict")] };
    }
    const start = pos;
    const items: Node[] = [];
    while (peek() && peek()!.t !== "}") items.push(curlyFlatItem());
    const kind = classifyCurly(items);
    if (kind === "dict") {
      invariant(peek()?.t === "}", "unbalanced {");
      next();
      return { list: [atom("dict"), ...normalizeDictKeys(items)] };
    }
    if (kind === "unwrap") {
      invariant(peek()?.t === "}", "unbalanced {");
      next();
      return items[0]!;
    }
    if (kind === "infix") {
      // LICENSELESS boolean mixing (doctrine §5.2): a bare chain that mixes `and`
      // and `or` without braces is ambiguous to humans even when precedence is
      // defined. Render always containerizes (`{{a and b} or c}`); read doors the
      // unbraced mix so the exit is "brace the groups".
      if (hasBareMixedLogicals(items)) {
        invariant(
          false,
          () =>
            "mixed 'and'/'or' in one '{…}' without braces — boolean mixing is licenseless; " +
            "brace each group, e.g. {{a and b} or c} (not {a and b or c})",
        );
      }
      pos = start; // reparse with precedence climber (handles mixed ops + =>)
      const e = infix(0);
      requireCurlyClose("");
      next();
      return e;
    }
    // Broken shape — name the rule so the door teaches odd/even separation.
    // Prefer the unknown-operator phrasing when an odd slot holds a non-op word
    // (`{a ?? b}`), so mid-edit typos still point at the operator vocabulary.
    const oddSlot = items.find((it, i) => i % 2 === 1 && isAtomNode(it) && !it.str && !isOp(it.atom));
    if (oddSlot && isAtomNode(oddSlot)) {
      invariant(
        false,
        () =>
          `expected '}' or an infix operator, got '${oddSlot.atom}' — operators: ${Object.keys(GLYPH_PREC).join(" ")}`,
      );
    }
    invariant(
      false,
      () =>
        `ambiguous or broken '{…}' — even forms are a dict (kv pairs); odd operand·op·operand is an n-expr; ` +
        `operators: ${Object.keys(GLYPH_PREC).join(" ")}`,
    );
  }

  // A `{ … }` trailing lambda after `.op` (caller has consumed the `{`). The body
  // is read as a curly infix to precedence 0, so a top-level `=>` surfaces as a
  // lambda node with EXPLICIT params (`{(acc x) => …}` ⇒ (lambda (acc x) …)). With
  // no top `=>`, the body is wrapped in the IMPLICIT single-param pronoun `it`
  // (§3.3): `{B}` ⇒ (lambda (it) B). Consumes the closing `}`.
  function trailingLambda(): Node {
    const body = infix(0);
    requireCurlyClose(
      " in trailing-lambda body (code context: indentation forms don't group inside braces — " +
        "write the body delimited, e.g. .map{(r) => (dict :id r[:id])}, or bind pieces in a let* first)",
    );
    next();
    // Pass a body through only when it's ALREADY the arrow-lambda shape `(lambda (p…) …)`
    // — param slot a LIST. A variadic `(lambda x)` (x a rest-symbol atom) is NOT what the
    // arrow form produces, so it's a body datum to wrap in the pronoun, not double-skip.
    const isLam =
      !isAtomNode(body) &&
      body.list.length >= 2 &&
      isAtomNode(body.list[0]) &&
      body.list[0].atom === "lambda" &&
      !isAtomNode(body.list[1]);
    return isLam ? body : { list: [atom("lambda"), { list: [atom("it")] }, body] };
  }

  const elems: Node[] = [];
  while (pos < toks.length) elems.push(datum());
  return elems;
}

/** Single fully-delimited expression — phase-1 entry (used by the curly/arrow
 *  round-trip tests). For multi-element input it returns the first element. */
export function readSugarcoatExpr(src: string, opts: ReadOpts = {}): Node {
  const elems = parseElements(tokenize(stripComments(src)), opts.accessorDepth);
  invariant(elems.length === 1, () => `expected one expression, got ${elems.length}`);
  return elems[0];
}

/** Reader knobs. `accessorDepth` caps pair-accessor subscript fusion (see
 *  R7RS_ACCESSOR_DEPTH); omit for the portable default, `Infinity` for unbounded. */
export interface ReadOpts {
  accessorDepth?: number;
}

// ── I-expression layer ────────────────────────────────────────────────────────

const leadingSpaces = (s: string): number => s.length - s.trimStart().length;

/** Net bracket depth of a string, ignoring brackets inside "strings". */
function bracketDepth(s: string): number {
  let d = 0,
    inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
      continue;
    }
    switch (c) {
      case '"': {
        inStr = true;
        break;
      }
      case "(":
      case "{":
      case "[": {
        d++;
        break;
      }
      case ")":
      case "}":
      case "]":
        {
          d--;
          // No default
        }
        break;
    }
  }
  return d;
}

/** `base` = absolute offset of `content[0]` in the original sugarcoat text, for span
 *  attachment. Set only for a SINGLE-physical-line LogLine (offsets map directly);
 *  a coalesced multi-line one leaves it undefined → its nodes get no spans → no
 *  parameter hints there (rare, and the broken-`{…}` form is still readable). */
interface LogLine {
  indent: number;
  content: string;
  base?: number;
}

/** Coalesce physical lines whose brackets are unbalanced into one logical line
 *  (so a multi-line `{…}` becomes a single parseable unit; bracket mode overrides
 *  indentation). Logical-line indent = its first physical line's indent. */
function coalesce(physical: { text: string; base: number }[]): LogLine[] {
  const out: LogLine[] = [];
  let i = 0;
  while (i < physical.length) {
    const indent = leadingSpaces(physical[i].text);
    let content = physical[i].text.trim();
    const base = physical[i].base + indent; // content[0]'s absolute offset (trim drops `indent` leading chars)
    let joined = false;
    while (i + 1 < physical.length && bracketDepth(content) > 0) {
      i++;
      // Preserve the raw continuation (newline + original indentation): inside an
      // `@…{…}` text body newlines and indentation are literal content (dedent needs
      // to see the indent). For code/curly the reader skips all whitespace, so `\n`
      // vs ` ` is equivalent — joined lines carry no `base`, hence no spans either way.
      content += `\n${physical[i].text}`;
      joined = true;
    }
    out.push(joined ? { indent, content } : { indent, content, base });
    i++;
  }
  return out;
}

/** Parse one logical line + all deeper-indented descendants → the element(s) it
 *  contributes to its parent's list (usually 1; 2 for an inline colon-pair). */
function parseNode(lines: LogLine[], idx: number, accessorDepth?: number): { elems: Node[]; next: number } {
  const line = lines[idx];
  const toks = tokenize(line.content, line.base); // `base` absent (coalesced) → no spans
  const childElems: Node[] = [];
  // §3.4 newline method chains: a leading run of direct-child LEAF lines whose first
  // token is a method-DOT are not arguments — their tokens fold onto the parent
  // line's value (same CST + §4.3 receiver-last fold as the inline `recv.op` chain,
  // just broken across lines by SRFI-110 indentation). Collected before the value is
  // parsed; appended to `toks` so `withSubscripts` consumes the `.op` run.
  const contToks: Tok[] = [];
  let j = idx + 1;
  while (j < lines.length && lines[j].indent > line.indent) {
    const childToks = tokenize(lines[j].content, lines[j].base);
    const isStepLine = childToks[0]?.t === "." && (j + 1 >= lines.length || lines[j + 1].indent <= lines[j].indent);
    if (childElems.length === 0 && isStepLine) {
      contToks.push(...childToks);
      j++;
      continue;
    }
    const r = parseNode(lines, j, accessorDepth);
    childElems.push(...r.elems);
    j = r.next;
  }
  const headToks = contToks.length > 0 ? [...toks, ...contToks] : toks;

  // colon-pair: a line whose FIRST token is a TRAILING-colon key (`summary:`) is a
  // kwarg pair → :summary + value. Value = rest-of-line ++ children (one expr).
  // (Leading-colon `:personas` is an accessor HEAD, not a key — it falls through.)
  const head0 = toks[0];
  if (toks.length > 0 && isColonKey(head0)) {
    const key = atom(`:${head0.v.slice(0, -1)}`);
    const valueElems = parseElements(toks.slice(1), accessorDepth);
    const all = [...valueElems, ...childElems];
    invariant(all.length > 0, () => `colon key '${head0.v}' has no value`);
    return { elems: [key, all.length === 1 ? all[0] : { list: all }], next: j };
  }

  const head = parseElements(headToks, accessorDepth);
  if (childElems.length === 0) {
    // SRFI-110: a CHILDLESS line of multiple datums is a list (`string-upcase s`
    // → (string-upcase s)) — same rule readSugarcoat applies to a whole top-level
    // form. Splicing them as siblings instead silently rewrote a hand-typed
    // body to junk on save-back. (The render never emits such lines — inline
    // children keep their parens — so the round-trip law never exercised this.)
    if (head.length > 1) {
      const node: Node = { list: head };
      if (line.base != null) node.span = [line.base, line.base + line.content.length];
      return { elems: [node], next: j };
    }
    return { elems: head, next: j };
  }
  // head tokens + children form one list (e.g. `define (f x)` ⏎ body, `(else …)`).
  // regroupLetFamily re-wraps elided let/let* bindings into their `(( ))`.
  const node = regroupLetFamily({ list: [...head, ...childElems] });
  // Span the composite from its line extents (when both endpoints are on
  // un-coalesced lines) — the whole-form span a definition/diagnostic lift
  // lands on when its Scheme span covers the entire form.
  const last = lines[j - 1];
  if (node.span == null && line.base != null && last.base != null) {
    node.span = [line.base, last.base + last.content.length];
  }
  return { elems: [node], next: j };
}

/** Blank a `;`-line-comment (to end of line) to SPACES, string-aware — they're
 *  trivia in the sugarcoat view (sugarcoat-render re-emits them from the Scheme AST's
 *  lead/trail). Length-PRESERVING (comment → spaces, not removed) so every other
 *  char keeps its offset: that's what lets sugarcoat-text spans (for the parameter
 *  hints) stay valid in the editor's comment-bearing buffer. tokenize skips the
 *  spaces, so the parsed Nodes are identical to before. Newlines are kept.
 *
 *  At-expression text bodies treat `;` as LITERAL prose (`@{;@x}` is semicolon +
 *  interp, not a comment). `@()` grafts re-enter code mode so `;` is a comment
 *  again inside the graft. */
function stripComments(text: string): string {
  let out = "";
  let inStr = false;
  // -1 = code; ≥0 = at-body brace depth (0 = body, ready to close on `}`)
  let atDepth = -1;
  const blankComment = (from: number): number => {
    let i = from;
    while (i < text.length && text[i] !== "\n") {
      out += " ";
      i++;
    }
    return i - 1; // caller for-loop i++ re-lands on \n / end
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inStr) {
      out += c;
      if (c === "\\") {
        out += text[i + 1] ?? "";
        i++;
      } else if (c === '"') inStr = false;
      continue;
    }
    if (atDepth >= 0) {
      // ── at-expression text body ──
      if (c === "{") {
        atDepth++;
        out += c;
        continue;
      }
      if (c === "}") {
        if (atDepth === 0) atDepth = -1;
        else atDepth--;
        out += c;
        continue;
      }
      if (c === "@" && text[i + 1] === "(") {
        // graft: code mode until the balanced `)`
        out += "@(";
        i += 2;
        let depth = 1;
        let gStr = false;
        for (; i < text.length && depth > 0; i++) {
          const g = text[i]!;
          if (gStr) {
            out += g;
            if (g === "\\") {
              out += text[i + 1] ?? "";
              i++;
            } else if (g === '"') gStr = false;
            continue;
          }
          if (g === '"') {
            gStr = true;
            out += g;
            continue;
          }
          if (g === ";") {
            i = blankComment(i);
            continue;
          }
          if (g === "(") depth++;
          else if (g === ")") depth--;
          out += g;
        }
        i--; // outer for-loop advances
        continue;
      }
      // `;` is literal prose in at-body (not a comment)
      out += c;
      continue;
    }
    // ── code ──
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    // `@head{` / `@{` — enter at-body after the opening brace
    if (c === "@" && /^[^\s{}()[\]"@]*\{/.test(text.slice(i + 1))) {
      out += "@";
      i++;
      while (i < text.length && text[i] !== "{") {
        out += text[i];
        i++;
      }
      if (i < text.length && text[i] === "{") {
        out += "{";
        atDepth = 0;
      }
      continue;
    }
    if (c === ";") {
      i = blankComment(i);
      continue;
    }
    out += c;
  }
  return out;
}

/** Split into top-level forms (blank-line separated), keeping each form's absolute
 *  start offset in `text` — so spans computed within a form map back to the buffer.
 *  Exported so a lenient consumer (param hints) can read forms one-at-a-time and
 *  skip an unparseable one rather than lose the whole file. */
export function splitFormsWithBase(text: string): { text: string; base: number }[] {
  const out: { text: string; base: number }[] = [];
  const sep = /\n[ \t]*\n+/g;
  let last = 0;
  for (let m = sep.exec(text); m; m = sep.exec(text)) {
    out.push({ text: text.slice(last, m.index), base: last });
    last = m.index + m[0].length;
  }
  out.push({ text: text.slice(last), base: last });
  return out;
}

/** Full reader: sugarcoat text → Scheme forms. */
export function readSugarcoat(text: string, opts: ReadOpts = {}): Node[] {
  // Split into top-level forms by blank line FIRST: in the render, blank lines
  // appear ONLY between top-level forms (a comment is contiguous with its node),
  // so this is the true boundary. THEN blank comments within each form (length-
  // preserving, so form/line offsets stay valid for span attachment). Stripping
  // BEFORE the split would instead let an inner comment's blank line split one form
  // into two (form-count drift → reprint).
  return splitFormsWithBase(text)
    .map(({ text: f, base }) => ({ text: stripComments(f), base }))
    .filter(({ text: f }) => f.trim().length > 0)
    .map(({ text: formText, base: formBase }) => {
      // Physical lines with absolute bases — blank lines dropped, but offsets keep
      // counting (incl. each consumed "\n") so a kept line's base is exact.
      const physical: { text: string; base: number }[] = [];
      let off = 0;
      for (const lineText of formText.split("\n")) {
        if (lineText.trim().length > 0) physical.push({ text: lineText, base: formBase + off });
        off += lineText.length + 1;
      }
      const lines = coalesce(physical);
      const { elems } = parseNode(lines, 0, opts.accessorDepth);
      return elems.length === 1 ? elems[0] : { list: elems };
    });
}

// ── save-back: sugarcoat → Scheme, preserving unchanged forms ──────────────────────

/** Byte spans of the top-level forms in Scheme source, in order. Inter-form
 *  whitespace and `;` line-comments are NOT part of any span (preserved verbatim
 *  on splice). String- and comment-aware so brackets inside them don't miscount. */
export function topFormSpans(src: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    // Skip inter-form whitespace + line comments.
    while (i < n) {
      if (/\s/.test(src[i])) {
        i++;
        continue;
      }
      if (src[i] === ";") {
        while (i < n && src[i] !== "\n") i++;
        continue;
      }
      break;
    }
    if (i >= n) break;
    const start = i;
    // A form may carry leading quote/quasiquote/unquote prefixes (they bind tight).
    while (i < n && (src[i] === "'" || src[i] === "`" || src[i] === ","))
      i += src[i] === "," && src[i + 1] === "@" ? 2 : 1;
    if (i < n && (src[i] === "(" || src[i] === "[")) {
      // Balanced bracket group, string- & comment-aware.
      let depth = 0;
      let inStr = false;
      for (; i < n; i++) {
        const c = src[i];
        if (inStr) {
          if (c === "\\") i++;
          else if (c === '"') inStr = false;
          continue;
        }
        if (c === '"') inStr = true;
        else if (c === ";") {
          while (i + 1 < n && src[i + 1] !== "\n") i++;
        } else if (c === "(" || c === "[") depth++;
        else if ((c === ")" || c === "]") && --depth === 0) {
          i++;
          break;
        }
      }
    } else if (i < n && src[i] === '"') {
      i++;
      while (i < n && src[i] !== '"') i += src[i] === "\\" ? 2 : 1;
      i++;
    } else {
      // Bare atom (symbol / number).
      while (i < n && !/\s/.test(src[i]) && !'()[];"'.includes(src[i])) i++;
    }
    spans.push({ start, end: i });
  }
  return spans;
}

/**
 * Fold an edited sugarcoat view back into canonical Scheme. Every UNCHANGED top-level
 * form is preserved byte-for-byte (its comments + hand-formatting intact); only
 * forms whose AST changed are reprinted (canonical, via printScheme). Falls back to
 * a whole-file canonical reprint when the form correspondence is uncertain — the
 * form count differs (a form added/removed in sugarcoat) or a span doesn't parse to
 * exactly one form. Throws if the sugarcoat text is malformed (the caller keeps its
 * buffer and skips the save). The law: `sugarcoatToScheme(schemeToSugarcoat(c), c) === c`
 * byte-for-byte — viewing-then-saving an UNEDITED sugarcoat view never touches storage.
 */
export function sugarcoatToScheme(sugarcoatText: string, prevScheme: string, opts: ReadOpts = {}): string {
  const sugarcoatForms = readSugarcoat(sugarcoatText, opts); // throws on malformed sugarcoat → caller handles
  const reprintAll = (): string => `${sugarcoatForms.map((f) => printScheme(f)).join("\n\n")}\n`;

  const spans = topFormSpans(prevScheme);
  if (spans.length !== sugarcoatForms.length) return reprintAll(); // form added/removed → uncertain

  const prevParsed = spans.map((s) => parseSexprs(prevScheme.slice(s.start, s.end)));
  if (prevParsed.some((forms) => forms.length !== 1)) return reprintAll(); // ambiguous split → uncertain

  // Certain: 1:1 correspondence. Splice changed forms in from the end so earlier
  // spans' offsets stay valid; unchanged forms (and all inter-form bytes) survive.
  let out = prevScheme;
  for (let i = spans.length - 1; i >= 0; i--) {
    if (nodeEq(sugarcoatForms[i], prevParsed[i][0])) continue; // unchanged → keep original bytes
    out = out.slice(0, spans[i].start) + printScheme(sugarcoatForms[i]) + out.slice(spans[i].end);
  }
  return out;
}

// Wire the dual-path schemeToSugarcoat: sweet orthography (I-expr, @{}, =>, …)
// re-enters via this reader instead of the Scheme spine. Import of this module
// (via sugarcoat.ts / any test that pulls readSugarcoat) installs the hook.
registerSugarcoatReader(readSugarcoat);
