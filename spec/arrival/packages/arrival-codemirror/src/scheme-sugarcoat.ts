import { LanguageSupport, StreamLanguage, type StreamParser, type StringStream } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

/**
 * StreamLanguage for Scheme + sugarcoat superset (readable lens).
 *
 * Covers s-exprs + curly-infix, dict `{}` / list `[]`, `k:` / `:key`, `=>`, `==`.
 * Delimiters discriminate at the opener (same odd/even + tight rules as the
 * sugarcoat reader) and stack so closes match. Radix/string/comment handling
 * lifted from the CodeMirror scheme mode.
 *
 * Emits ONLY tags (bring your own theme). Every custom token in tokenTable
 * or it renders as nothing — this is the contract with StreamLanguage.
 */

// ── keyword classification ────────────────────────────────────────────────
// Definition forms get t.definitionKeyword; control forms get t.controlKeyword.
// Everything else that is a known builtin stays a plain variableName (we do not
// over-paint the standard library — only the structural special forms read as
// keywords, matching how the sugarcoat lens treats `define`/`lambda`/`if`).
const set = (str: string): Set<string> => new Set(str.split(/\s+/).filter(Boolean));

export const DEFINITION_KEYWORDS = set(`
  define define-values define-syntax define-macro defmacro define-class define-record-type
  define/overridable
  lambda λ case-lambda opt-lambda
  let let* letrec letrec-syntax let-syntax let-values let*-values let/ec let/cc
  syntax-rules syntax-case
`);

export const CONTROL_KEYWORDS = set(`
  if cond when unless case else
  and or not
  begin do for-each map
  delay force dynamic-wind call/cc call-with-current-continuation
  quote quasiquote unquote unquote-splicing
  set! require import
`);

// ── number matchers (lifted from the CodeMirror scheme mode) ──────────────────
const binaryMatcher =
  /^(?:[-+]i|[-+][01]+#*(?:\/[01]+#*)?i|[-+]?[01]+#*(?:\/[01]+#*)?@[-+]?[01]+#*(?:\/[01]+#*)?|[-+]?[01]+#*(?:\/[01]+#*)?[-+](?:[01]+#*(?:\/[01]+#*)?)?i|[-+]?[01]+#*(?:\/[01]+#*)?)(?=[()\s;"]|$)/i;
const octalMatcher =
  /^(?:[-+]i|[-+][0-7]+#*(?:\/[0-7]+#*)?i|[-+]?[0-7]+#*(?:\/[0-7]+#*)?@[-+]?[0-7]+#*(?:\/[0-7]+#*)?|[-+]?[0-7]+#*(?:\/[0-7]+#*)?[-+](?:[0-7]+#*(?:\/[0-7]+#*)?)?i|[-+]?[0-7]+#*(?:\/[0-7]+#*)?)(?=[()\s;"]|$)/i;
const hexMatcher =
  /^(?:[-+]i|[-+][\da-f]+#*(?:\/[\da-f]+#*)?i|[-+]?[\da-f]+#*(?:\/[\da-f]+#*)?@[-+]?[\da-f]+#*(?:\/[\da-f]+#*)?|[-+]?[\da-f]+#*(?:\/[\da-f]+#*)?[-+](?:[\da-f]+#*(?:\/[\da-f]+#*)?)?i|[-+]?[\da-f]+#*(?:\/[\da-f]+#*)?)(?=[()\s;"]|$)/i;
const decimalMatcher =
  /^(?:[-+]i|[-+](?:(?:(?:\d+#+\.?#*|\d+\.\d*#*|\.\d+#*|\d+)(?:[esfdl][-+]?\d+)?)|\d+#*\/\d+#*)i|[-+]?(?:(?:(?:\d+#+\.?#*|\d+\.\d*#*|\.\d+#*|\d+)(?:[esfdl][-+]?\d+)?)|\d+#*\/\d+#*)@[-+]?(?:(?:(?:\d+#+\.?#*|\d+\.\d*#*|\.\d+#*|\d+)(?:[esfdl][-+]?\d+)?)|\d+#*\/\d+#*)|[-+]?(?:(?:(?:\d+#+\.?#*|\d+\.\d*#*|\.\d+#*|\d+)(?:[esfdl][-+]?\d+)?)|\d+#*\/\d+#*)[-+](?:(?:(?:\d+#+\.?#*|\d+\.\d*#*|\.\d+#*|\d+)(?:[esfdl][-+]?\d+)?)|\d+#*\/\d+#*)?i|(?:(?:(?:\d+#+\.?#*|\d+\.\d*#*|\.\d+#*|\d+)(?:[esfdl][-+]?\d+)?)|\d+#*\/\d+#*))(?=[()\s;"]|$)/i;

// A symbol body — same character class the sugarcoat reader treats as atom chars,
// minus the colon (colon is handled separately so `k:` / `:key` can tokenize).
const SYMBOL_BODY = /[\w\-!$%&*+./<=>?@^~]/;

/** Code-context delimiter family — open/close share a kind via delimStack. */
export type DelimKind = "dict" | "nexpr" | "list" | "sub" | "ambig" | "err";

interface SchemeSugarcoatState {
  mode: false | "string" | "comment" | "attext" | "atgraft";
  afterDefineHead: boolean; // next atom after `(define ...` → DEFNAME
  atDepth: number; // literal {} depth inside @head{...} (0 closes the body)
  graftDepth: number; // paren depth inside @() graft (0 = just closed)
  /** Code-context brace/bracket stack (not at-body). Close tags match open kind. */
  delimStack: DelimKind[];
}

// ── delimiter discrimination (mirrors arrival-sugarcoat reader) ─────────────
// Must stay in lockstep with sugarcoat-read GLYPH_PREC / classifyCurly / tight `[`.
const INFIX_OPS = new Set([
  "=>",
  "↦",
  "or",
  "||",
  "∨",
  "and",
  "&&",
  "∧",
  "==",
  "≡",
  "=",
  "eq?",
  "≈",
  "eqv?",
  "≃",
  "<",
  ">",
  "<=",
  "≤",
  ">=",
  "≥",
  "lt",
  "gt",
  "lte",
  "gte",
  "≠",
  "≢",
  "≉",
  "≄",
  "∷",
  "∈",
  "+",
  "-",
  "∘",
  "*",
  "/",
  "modulo",
  "quotient",
  "remainder",
]);

/** Prev char (before current stream.pos) is a value-ending glyph → tight postfix. */
function prevIsTightValue(stream: StringStream): boolean {
  if (stream.pos === 0) return false;
  const prev = stream.string[stream.pos - 1]!;
  if (/\s/.test(prev)) return false;
  // After an open delimiter the next `[`/`{` starts a free literal, not a postfix.
  if ("([{,".includes(prev)) return false;
  // Value-ending: symbol/number/string/close-paren/quote tails.
  return /[\w!$%&*+\-./<=>?@^~)\]}"'0-9]/.test(prev);
}

/** Forced n-expr: tight trailing-lambda after `.op` or method-arg `)`. */
function forcedNexprCurly(stream: StringStream): boolean {
  if (stream.pos === 0 || /\s/.test(stream.string[stream.pos - 1]!)) return false;
  const left = stream.string.slice(0, stream.pos);
  // `.map{` / `.fold{` / `xs.map{`
  if (/\.[\w!$%&*/<=>?^_~+-]+$/.test(left)) return true;
  // `.fold(0){` — tight after method-args close
  if (/\)$/.test(left)) return true;
  return false;
}

/**
 * Scan top-level forms inside a curly body (same line). Depth-aware, string-aware.
 * Returns forms up to depth-0 `}` or EOL. `closed` = saw matching close.
 */
export function scanCurlyBody(src: string, from: number): { forms: string[]; closed: boolean } {
  const forms: string[] = [];
  let i = from;
  const depth = 0; // nested {} () [] relative to body (body itself is depth 0 content)
  let form = "";
  const flush = () => {
    const t = form.trim();
    if (t.length > 0) forms.push(t);
    form = "";
  };
  while (i < src.length) {
    const c = src[i]!;
    if (c === "}" && depth === 0) {
      flush();
      return { forms, closed: true };
    }
    if (c === '"') {
      form += c;
      i++;
      while (i < src.length) {
        form += src[i];
        if (src[i] === "\\" && i + 1 < src.length) {
          form += src[i + 1];
          i += 2;
          continue;
        }
        if (src[i] === '"') {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === "(" || c === "[" || c === "{") {
      const open = c;
      const close = c === "(" ? ")" : c === "[" ? "]" : "}";
      let d = 1;
      form += c;
      i++;
      while (i < src.length && d > 0) {
        const x = src[i]!;
        form += x;
        if (x === '"') {
          i++;
          while (i < src.length) {
            form += src[i];
            if (src[i] === "\\" && i + 1 < src.length) {
              form += src[i + 1];
              i += 2;
              continue;
            }
            if (src[i] === '"') {
              i++;
              break;
            }
            i++;
          }
          continue;
        }
        if (x === open) d++;
        else if (x === close) d--;
        // nested different brackets still nest for depth of THIS pair only —
        // track per-type would be more accurate; mixed nests are rare in form
        // heads. For form-splitting we treat any open/close of same pair.
        i++;
      }
      continue;
    }
    if (/\s/.test(c) && depth === 0) {
      flush();
      i++;
      continue;
    }
    form += c;
    i++;
  }
  flush();
  return { forms, closed: false };
}

/** Classify flat forms inside `{…}` — pure, unit-tested. Mirrors sugarcoat-read.classifyCurly. */
export function classifyCurlyForms(
  forms: string[],
  opts: { closed: boolean; provisional?: boolean } = { closed: true },
): DelimKind {
  if (forms.length === 0) return "dict";
  if (forms.length === 1) return "nexpr"; // unwrap / degenerate
  const isOp = (w: string) => INFIX_OPS.has(w);
  if (forms.length % 2 === 1) {
    let alt = true;
    for (let i = 0; i < forms.length; i++) {
      if ((i % 2 === 1) !== isOp(forms[i]!)) {
        alt = false;
        break;
      }
    }
    if (alt) return "nexpr";
    // Odd non-alternating: if an odd slot has a non-op, error when closed; provisional nexpr while typing.
    if (!opts.closed || opts.provisional) return "ambig";
    return "err";
  }
  // even
  for (let i = 0; i < forms.length; i++) {
    if (i % 2 === 1 && isOp(forms[i]!)) return opts.closed ? "err" : "ambig"; // `{a +}` truncated
    if (i % 2 === 0 && isOp(forms[i]!)) return opts.closed ? "err" : "ambig";
  }
  return "dict";
}

function classifyCurlyOpen(stream: StringStream): DelimKind {
  if (forcedNexprCurly(stream)) return "nexpr";
  // Look ahead on this line only (StreamLanguage paints one line at a time).
  const { forms, closed } = scanCurlyBody(stream.string, stream.pos + 1); // after `{`
  if (!closed) {
    // Multi-line / incomplete: prefer n-expr/ambig so we don't flash dict on half-typed infix.
    if (forms.length === 0) return "dict"; // typing `{}`
    const k = classifyCurlyForms(forms, { closed: false, provisional: true });
    return k === "dict" ? "dict" : k === "nexpr" ? "nexpr" : "ambig";
  }
  return classifyCurlyForms(forms, { closed: true });
}

function classifyBracketOpen(stream: StringStream): DelimKind {
  return prevIsTightValue(stream) ? "sub" : "list";
}

const DELIM_TOKEN: Record<DelimKind, string> = {
  dict: "sugarcoatDictBrace",
  nexpr: "sugarcoatNexprBrace",
  list: "sugarcoatListBracket",
  sub: "sugarcoatSubBracket",
  ambig: "sugarcoatCurlyAmbig",
  err: "sugarcoatCurlyError",
};

function openDelim(state: SchemeSugarcoatState, kind: DelimKind): string {
  state.delimStack.push(kind);
  return DELIM_TOKEN[kind];
}

function closeCurly(state: SchemeSugarcoatState): string {
  const kind = state.delimStack.pop() ?? "nexpr";
  // Only curly kinds; if stack had a bracket, still emit something sensible.
  if (kind === "list" || kind === "sub") return DELIM_TOKEN.nexpr;
  return DELIM_TOKEN[kind];
}

function closeBracket(state: SchemeSugarcoatState): string {
  const kind = state.delimStack.pop() ?? "list";
  if (kind === "list" || kind === "sub") return DELIM_TOKEN[kind];
  return DELIM_TOKEN.list;
}

// @head{ opener (mirrors arrival-sugarcoat AT_HEAD) + balanced literal {} inside body.
const AT_OPENER = /^[^\s{}()[\]"@]*\{/;
const AT_INTERP = /[\w!$%&*/:<=>?^~+-]/;

/** @text body tokenizer. atDepth tracks literal braces (close only at 0).
 *  Returns null at EOL for multi-line @dedent bodies. Bare @ (no {) falls
 *  through to symbols. `@(` enters atgraft so the graft is code-highlighted. */
function tokenizeAtText(stream: StringStream, state: SchemeSugarcoatState): string | null {
  const c = stream.peek();
  if (c == null) return null; // end of line — stay in attext (multi-line body)
  if (c === "}") {
    stream.next();
    if (state.atDepth === 0) {
      state.mode = false;
      return ATCLOSE; // body close — not a code-context dict/n-expr brace
    }
    state.atDepth--;
    return "string"; // literal closing brace
  }
  if (c === "{") {
    stream.next();
    state.atDepth++;
    return "string"; // literal opening brace
  }
  if (c === "@") {
    stream.next(); // consume `@`
    const n = stream.peek();
    if (n === "(") {
      // Enter graft mode — highlight the interior as code, not one opaque INTERP blob.
      stream.next(); // consume `(`
      state.mode = "atgraft";
      state.graftDepth = 1;
      return INTERP; // `@(` opener pops as interp against the prose
    }
    if (n === "|") {
      stream.next(); // opening `|`
      stream.eatWhile((x: string) => x !== "|");
      stream.eat("|"); // closing `|`
      return INTERP;
    }
    // Nested `@head{` / `@{` — stay in attext; the `{` bumps atDepth as literal…
    // but nested at-expr heads should read as INTERP openers. Match opener and bump.
    if (n != null && AT_OPENER.test(stream.string.slice(stream.pos))) {
      stream.match(AT_OPENER); // head + `{`
      state.atDepth++; // nested body; outer close still at 0
      return ATOPEN;
    }
    stream.eatWhile(AT_INTERP); // bare `@id`
    // Tight `@id[…][…]` subscript chain
    while (stream.peek() === "[") {
      let depth = 0;
      let inStr = false;
      let ch: string | void;
      while ((ch = stream.next()) != null) {
        if (inStr) {
          if (ch === "\\") stream.next();
          else if (ch === '"') inStr = false;
          continue;
        }
        if (ch === '"') inStr = true;
        else if (ch === "[") depth++;
        else if (ch === "]" && --depth === 0) break;
      }
    }
    // Tight method chain `.op` / `.op()` / `.op{}` (mirrors sugarcoat-read;
    // op class excludes `:` so prose separators after unary methods stay prose)
    const AT_METHOD_OP = /[\w!$%&*/<=>?^~+-]/;
    while (stream.peek() === ".") {
      const afterDot = stream.string.slice(stream.pos + 1);
      if (!AT_METHOD_OP.test(afterDot[0] ?? "")) break;
      stream.next(); // .
      stream.eatWhile(AT_METHOD_OP);
      if (stream.peek() === "(") {
        let depth = 0;
        let inStr = false;
        let ch: string | void;
        while ((ch = stream.next()) != null) {
          if (inStr) {
            if (ch === "\\") stream.next();
            else if (ch === '"') inStr = false;
            continue;
          }
          if (ch === '"') inStr = true;
          else if (ch === "(") depth++;
          else if (ch === ")" && --depth === 0) break;
        }
      }
      if (stream.peek() === "{") {
        let depth = 0;
        let inStr = false;
        let ch: string | void;
        while ((ch = stream.next()) != null) {
          if (inStr) {
            if (ch === "\\") stream.next();
            else if (ch === '"') inStr = false;
            continue;
          }
          if (ch === '"') inStr = true;
          else if (ch === "{") depth++;
          else if (ch === "}" && --depth === 0) break;
        }
      }
    }
    return INTERP;
  }
  stream.eatWhile((x: string) => x !== "@" && x !== "{" && x !== "}"); // prose run
  return "string";
}

// Custom token names → resolved through tokenTable below.
const KEY = "sugarcoatKey"; // :key / k: colon-pairs → propertyName
const ARROW = "sugarcoatArrow"; // => → controlOperator
const COMPARE = "sugarcoatCompare"; // == → compareOperator
const LOGIC = "sugarcoatLogic"; // && || → logicOperator (legacy aliases)
const DICT_BRACE = "sugarcoatDictBrace"; // { } dict literal
const NEXPR_BRACE = "sugarcoatNexprBrace"; // { } curly-infix / trailing-λ
const LIST_BRACKET = "sugarcoatListBracket"; // free [ ]
const SUB_BRACKET = "sugarcoatSubBracket"; // tight subscript [ ]
const CURLY_AMBIG = "sugarcoatCurlyAmbig"; // mid-edit provisional { }
const CURLY_ERR = "sugarcoatCurlyError"; // broken curly shape
const ATCLOSE = "sugarcoatAtClose"; // @head{…} body close `}`
const DEFNAME = "sugarcoatDefName"; // defined name → definition(variableName)
const ATOPEN = "sugarcoatAtOpen"; // @head{ opener → keyword (the tagged-template head)
const INTERP = "sugarcoatInterp"; // @id / @(…) / @|…| inside a text body → variableName pop

/**
 * Code-mode token inside an `@()` graft. Mirrors the main code tokenizer for
 * strings, comments, symbols, keywords — but never enters attext (a `@head{`
 * inside a graft is rare and would desync the outer at-body). `(`/`)` depth is
 * tracked by the caller (atgraft branch); this only classifies one token.
 * Strings/block-comments are consumed inline so we stay in atgraft (multi-line
 * strings inside grafts are vanishingly rare).
 */
function tokenizeGraftCode(stream: StringStream, state: SchemeSugarcoatState): string | null {
  // Delimiters classified before consuming so prev-char tight checks see the right pos.
  const peek = stream.peek();
  if (peek === "{") {
    const kind = classifyCurlyOpen(stream);
    stream.next();
    return openDelim(state, kind);
  }
  if (peek === "}") {
    stream.next();
    return closeCurly(state);
  }
  if (peek === "[") {
    const kind = classifyBracketOpen(stream);
    stream.next();
    return openDelim(state, kind);
  }
  if (peek === "]") {
    stream.next();
    return closeBracket(state);
  }

  const ch = stream.next();
  if (ch == null) return null;

  if (ch === '"') {
    let escaped = false;
    let next: string | void;
    while ((next = stream.next()) != null) {
      if (next === '"' && !escaped) break;
      escaped = !escaped && next === "\\";
    }
    return "string";
  }

  if (ch === ";") {
    stream.skipToEnd();
    return "lineComment";
  }

  if (ch === "#" && stream.eat("|")) {
    let maybeEnd = false;
    let next: string | void;
    while ((next = stream.next()) != null) {
      if (next === "#" && maybeEnd) break;
      maybeEnd = next === "|";
    }
    return "blockComment";
  }

  if (ch === "'" || ch === "`") return "meta";
  if (ch === ",") {
    stream.eat("@");
    return "meta";
  }

  if (ch === ":" && SYMBOL_BODY.test(stream.peek() ?? "")) {
    stream.eatWhile(SYMBOL_BODY);
    return KEY;
  }

  if (ch === "=" && stream.peek() === ">") {
    stream.next();
    return ARROW;
  }
  if (ch === "=" && stream.peek() === "=") {
    stream.next();
    return COMPARE;
  }
  if (ch === "&" && stream.peek() === "&") {
    stream.next();
    return LOGIC;
  }
  if (ch === "|" && stream.peek() === "|") {
    stream.next();
    return LOGIC;
  }

  if (/[-+0-9.]/.test(ch)) {
    stream.backUp(1);
    if (stream.match(decimalMatcher)) return "number";
    stream.next();
  }

  stream.eatWhile(SYMBOL_BODY);
  if (stream.peek() === ":") {
    stream.next();
    return KEY;
  }
  const word = stream.current();
  if (DEFINITION_KEYWORDS.has(word)) return "definitionKeyword";
  if (CONTROL_KEYWORDS.has(word)) return "controlKeyword";
  return "variableName";
}

export const parser: StreamParser<SchemeSugarcoatState> = {
  name: "scheme-sugarcoat",
  startState: () => ({ mode: false, afterDefineHead: false, atDepth: 0, graftDepth: 0, delimStack: [] }),

  token(stream, state): string | null {
    // ── inside @() graft: code-highlight until the balanced close ──
    // Re-uses the normal code path below via a depth counter; on the closing
    // `)` we return to attext so prose/interp resume.
    if (state.mode === "atgraft") {
      if (stream.eatSpace()) return null;
      const ch = stream.peek();
      if (ch == null) return null;
      // closing paren of the graft
      if (ch === ")") {
        stream.next();
        state.graftDepth--;
        if (state.graftDepth === 0) {
          state.mode = "attext";
          return INTERP; // graft closer pops against prose
        }
        return "paren";
      }
      if (ch === "(") {
        stream.next();
        state.graftDepth++;
        return "paren";
      }
      // Fall through to the normal code tokenizer for this token, but keep
      // mode=atgraft (don't let `@head{` inside a graft start an at-body).
      // We handle the common cases inline; the rest mirrors the code path.
      return tokenizeGraftCode(stream, state);
    }
    // continue multi-line string
    if (state.mode === "string") {
      let escaped = false;
      let next: string | void;
      while ((next = stream.next()) != null) {
        if (next === '"' && !escaped) {
          state.mode = false;
          break;
        }
        escaped = !escaped && next === "\\";
      }
      return "string";
    }
    // continue #| |# block comment
    if (state.mode === "comment") {
      let maybeEnd = false;
      let next: string | void;
      while ((next = stream.next()) != null) {
        if (next === "#" && maybeEnd) {
          state.mode = false;
          break;
        }
        maybeEnd = next === "|";
      }
      return "blockComment";
    }
    // continue an `@…{…}` text body (possibly multi-line)
    if (state.mode === "attext") return tokenizeAtText(stream, state);

    if (stream.eatSpace()) return null;

    const ch = stream.next();
    if (ch == null) return null;

    // strings
    if (ch === '"') {
      state.mode = "string";
      // re-enter string mode handling for the rest of this line
      let escaped = false;
      let next: string | void;
      while ((next = stream.next()) != null) {
        if (next === '"' && !escaped) {
          state.mode = false;
          break;
        }
        escaped = !escaped && next === "\\";
      }
      return "string";
    }

    // quote / quasiquote / unquote shorthand → meta
    if (ch === "'" || ch === "`") return "meta";
    if (ch === ",") {
      stream.eat("@");
      return "meta";
    }

    // # forms: block comment, booleans, radix numbers
    if (ch === "#") {
      if (stream.eat("|")) {
        state.mode = "comment";
        return "blockComment";
      }
      if (stream.eat(/[tf]/i)) return "atom"; // #t / #f
      // NB: `stream.match(re)` CONSUMES the matched run — `re.test(...)` is not
      // equivalent (unicorn/prefer-regexp-test autofix breaks this; rule off in
      // eslint.config.mjs for this file).
      if (stream.eat(/b/i)) {
        if (stream.match(binaryMatcher)) return "number";
      } else if (stream.eat(/o/i)) {
        if (stream.match(octalMatcher)) return "number";
      } else if (stream.eat(/x/i)) {
        if (stream.match(hexMatcher)) return "number";
      } else if (stream.eat(/d/i) && stream.match(decimalMatcher)) return "number";
      stream.eatWhile(SYMBOL_BODY);
      return "atom";
    }

    // line comment
    if (ch === ";") {
      stream.skipToEnd();
      return "lineComment";
    }

    // ── curly braces: dict vs n-expr (classify at opener; stack for close) ──
    // We already consumed `ch` via stream.next() — back up for tight/lookahead.
    if (ch === "{") {
      stream.backUp(1);
      const kind = classifyCurlyOpen(stream);
      stream.next();
      return openDelim(state, kind);
    }
    if (ch === "}") return closeCurly(state);

    // ── round / square brackets ──
    if (ch === "(") {
      // Peek the head word to detect `(define NAME …)`-style definitions so the
      // bound name can read as a definition. We do NOT consume it — the head is
      // tokenized on the next pass — we only set a flag if the head is a def form.
      const rest = stream.string.slice(stream.pos);
      const head = /^\s*([\w\-!$%&*+./<=>?@^~λ]+)/.exec(rest)?.[1];
      state.afterDefineHead = head != null && DEFINITION_KEYWORDS.has(head) && head.startsWith("def");
      return "paren";
    }
    if (ch === "[") {
      stream.backUp(1);
      const kind = classifyBracketOpen(stream);
      stream.next();
      return openDelim(state, kind);
    }
    if (ch === ")") return "paren";
    if (ch === "]") return closeBracket(state);

    // ── leading-colon accessor `:key` ──
    if (ch === ":" && SYMBOL_BODY.test(stream.peek() ?? "")) {
      stream.eatWhile(SYMBOL_BODY);
      return KEY;
    }

    // ── sugarcoat glyph operators (only when they are standalone tokens) ──
    if (ch === "=" && stream.peek() === ">") {
      stream.next();
      return ARROW; // =>
    }
    if (ch === "=" && stream.peek() === "=") {
      stream.next();
      return COMPARE; // ==
    }
    if (ch === "&" && stream.peek() === "&") {
      stream.next();
      return LOGIC; // &&
    }
    if (ch === "|" && stream.peek() === "|") {
      stream.next();
      return LOGIC; // ||
    }

    // ── at-expression opener `@head{` / `@{` ── enter the text-body sub-mode. A bare
    // `@` / `@foo` (no following `{`) is NOT one — it falls through to symbol handling
    // (the accessor `@` / an `@`-symbol stay variableName).
    if (ch === "@" && AT_OPENER.test(stream.string.slice(stream.pos))) {
      stream.match(AT_OPENER); // consume head + `{`
      state.mode = "attext";
      state.atDepth = 0;
      return ATOPEN;
    }

    // ── numbers (non-prefixed decimal) ──
    if (/[-+0-9.]/.test(ch)) {
      stream.backUp(1);
      if (stream.match(decimalMatcher)) return "number";
      stream.next(); // not a number after all; fall through as a symbol char
    }

    // ── symbol / keyword / trailing-colon key ──
    stream.eatWhile(SYMBOL_BODY);
    // trailing-colon keyword pair `k:` — consume the colon and tag as a key.
    if (stream.peek() === ":") {
      stream.next();
      return KEY;
    }
    const word = stream.current();

    if (state.afterDefineHead) {
      // The token right after a definition head is the bound name.
      state.afterDefineHead = false;
      // unless it is itself a keyword (e.g. nested lambda), then keep keyword.
      if (!DEFINITION_KEYWORDS.has(word) && !CONTROL_KEYWORDS.has(word)) return DEFNAME;
    }

    if (DEFINITION_KEYWORDS.has(word)) return "definitionKeyword";
    if (CONTROL_KEYWORDS.has(word)) return "controlKeyword";
    return "variableName";
  },

  languageData: {
    closeBrackets: { brackets: ["(", "[", "{", '"'] },
    commentTokens: { line: ";", block: { open: "#|", close: "|#" } },
  },

  // CRITICAL: custom tokens (KEY/ARROW/...) must map here or they are invisible.
  // Non-customs go through CM's built-in tag map.
  tokenTable: {
    [KEY]: t.propertyName,
    [ARROW]: t.controlOperator,
    [COMPARE]: t.compareOperator,
    [LOGIC]: t.logicOperator,
    // Delimiter family: n-expr keeps sweet italic `brace`; dict is special(brace)
    // (data, no italic); list is squareBracket (recede); sub is special(squareBracket).
    [DICT_BRACE]: t.special(t.brace),
    [NEXPR_BRACE]: t.brace,
    [LIST_BRACKET]: t.squareBracket,
    [SUB_BRACKET]: t.special(t.squareBracket),
    [CURLY_AMBIG]: t.brace, // provisional — same family as n-expr (no wrong flash to dict)
    [CURLY_ERR]: t.invalid,
    [ATCLOSE]: t.keyword, // @body close — pairs with ATOPEN, not code curlies
    [DEFNAME]: t.definition(t.variableName),
    [ATOPEN]: t.keyword, // @head{ — the tagged-template head reads as a keyword
    [INTERP]: t.variableName, // @id / @(…) / @|…| — interpolation pops against the prose
  },
};

/** `LanguageSupport` for `.scm` (Scheme + sugarcoat). Tags only — no theme. */
export function schemeSugarcoat(): LanguageSupport {
  return new LanguageSupport(StreamLanguage.define(parser));
}
