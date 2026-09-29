/**
 * Terminal syntax highlighting for Scheme / sugarcoat INPUT and settled source — the fuller
 * sibling of `sexpr-color.ts` (which is deliberately parens-only-subtle for VALUE output).
 * Here we colour code: definition forms, control forms, strings, comments, keywords,
 * booleans. Same discipline as the codemirror eject — the tokenizer emits colour, the
 * terminal is the theme; no `@codemirror/language` runtime is dragged in.
 *
 * Same hard invariant as the value colorizer: colour adds ONLY escapes, never a byte.
 * `stripAnsi(highlightScheme(s)) === s` for every input; `mode "none"` is exact identity.
 * The tokenizer preserves every character (whitespace, unterminated strings, partial input
 * mid-keystroke) and only wraps whole tokens.
 */
import { colorMode, DARCULA, paintHex } from "./tints.js";

type ColorMode = ReturnType<typeof colorMode>;

/** A number literal — decimal, signed, rational, or radix-prefixed (mirrors sexpr-color). */
function isNumber(atom: string): boolean {
  return /^[+-]?(\d|\.\d|#[xbodei])/i.test(atom);
}

// Keyword classification — copied from arrival-codemirror's `scheme-sugarcoat.ts`
// (DEFINITION_KEYWORDS / CONTROL_KEYWORDS), the source of truth. Duplicated (not imported)
// because that module pulls the CodeMirror runtime; these sets are small and stable, and a
// terminal has no lezer highlighter to read from. If they drift, re-sync from there.
const DEFINITION_KEYWORDS = new Set(
  `define define-values define-syntax define-macro defmacro define-class define-record-type
   define/overridable lambda λ case-lambda opt-lambda
   let let* letrec letrec-syntax let-syntax let-values let*-values let/ec let/cc
   syntax-rules syntax-case`
    .split(/\s+/)
    .filter(Boolean),
);
const CONTROL_KEYWORDS = new Set(
  `if cond when unless case else and or not begin do for-each map
   delay force dynamic-wind call/cc call-with-current-continuation
   quote quasiquote unquote unquote-splicing set! require import`
    .split(/\s+/)
    .filter(Boolean),
);

const DELIM = new Set(["(", ")", "[", "]", "{", "}"]);

/** Classify an atom → its darcula hex. Same palette as the value colorizer (sexpr-color.ts)
 *  so the input line, block source, and output value all agree: keywords orange, `:kw`
 *  purple, numbers/booleans blue, everything else the baseline symbol gray-blue. */
function atomColor(atom: string): string {
  if (DEFINITION_KEYWORDS.has(atom) || CONTROL_KEYWORDS.has(atom)) return DARCULA.keyword;
  if (atom === "#t" || atom === "#f" || atom === "#true" || atom === "#false" || atom === "nil")
    return DARCULA.constant;
  if (atom.length > 1 && atom.startsWith(":")) return DARCULA.property; // :keyword
  if (isNumber(atom)) return DARCULA.number;
  return DARCULA.symbol;
}

function tint(text: string, hex: string, mode: ColorMode): string {
  return mode === "none" ? text : paintHex(text, hex, mode);
}

/** Highlight Scheme/sugarcoat source. `mode` defaults to the live terminal capability;
 *  `"none"` is exact identity. */
export function highlightScheme(src: string, mode: ColorMode = colorMode()): string {
  if (mode === "none") return src;
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i]!;

    if (ch === '"') {
      let j = i + 1;
      while (j < n) {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === '"') {
          j += 1;
          break;
        }
        j += 1;
      }
      out += tint(src.slice(i, j), DARCULA.string, mode);
      i = j;
      continue;
    }

    if (ch === "#" && src[i + 1] === "|") {
      const end = src.indexOf("|#", i + 2);
      const j = end === -1 ? n : end + 2;
      out += tint(src.slice(i, j), DARCULA.comment, mode);
      i = j;
      continue;
    }

    if (ch === ";") {
      let j = i;
      while (j < n && src[j] !== "\n") j += 1;
      out += tint(src.slice(i, j), DARCULA.comment, mode);
      i = j;
      continue;
    }

    if (DELIM.has(ch)) {
      out += tint(ch, DARCULA.delimiter, mode);
      i += 1;
      continue;
    }

    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      out += ch;
      i += 1;
      continue;
    }

    let j = i;
    while (j < n) {
      const c = src[j]!;
      if (DELIM.has(c) || c === '"' || c === ";" || c === " " || c === "\t" || c === "\n" || c === "\r") break;
      j += 1;
    }
    const atom = src.slice(i, j);
    out += tint(atom, atomColor(atom), mode);
    i = j;
  }
  return out;
}
