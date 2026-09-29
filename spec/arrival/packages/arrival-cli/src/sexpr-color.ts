/**
 * Type-aware ANSI coloring of serializer s-expr output — the "human looking at a TTY" view
 * of a value. The repo's compensated-darcula palette (`tints.ts` DARCULA, shared with the
 * code highlighter) dispatched on the LEAF TYPE, so a value reads by type at a glance:
 * strings & chars green, numbers / booleans / `nil` blue, `:keywords` purple, plain symbols
 * the baseline gray-blue, delimiters dim. (Structure itself is the sugarcoat lens's job — it
 * already renders dicts as `key:` and breaks big forms; this only paints the tokens.)
 *
 * The one hard invariant: coloring adds ONLY escape sequences, never a character of text.
 * `stripAnsi(colorizeSexpr(s)) === s` for every input, and `colorizeSexpr(s, "none") === s`
 * exactly. The tokenizer preserves every byte (whitespace included) and only wraps whole
 * tokens — never reflows, trims, or normalizes. Safe over the serializer's extras
 * (`#| … |#` truncation markers, `#attachment` tags): an unrecognized run is just a symbol,
 * passed through in the default foreground.
 */
import { colorMode, DARCULA, paintHex } from "./tints.js";

type ColorMode = ReturnType<typeof colorMode>;

const DELIM = new Set(["(", ")", "[", "]", "{", "}"]);

/** A number literal — decimal, signed, rational (`1/2`), or radix-prefixed (`#xff`). */
function isNumber(atom: string): boolean {
  return /^[+-]?(\d|\.\d|#[xbodei])/i.test(atom);
}

/** The darcula hex for a leaf atom. Every leaf gets a color (symbols the baseline gray-blue),
 *  so the value palette matches the code highlighter exactly. */
function atomColor(atom: string): string {
  if (atom.length > 1 && atom.startsWith(":")) return DARCULA.property; // :keyword → purple
  if (atom === "#t" || atom === "#f" || atom === "#true" || atom === "#false" || atom === "nil")
    return DARCULA.constant;
  if (atom.startsWith("#\\")) return DARCULA.string; // char literal → green (like a string)
  if (isNumber(atom)) return DARCULA.number; // number → blue
  return DARCULA.symbol; // plain identifier → baseline gray-blue
}

/** Emit `text` in `hex` unless the mode is `none` (then raw). */
function tint(text: string, hex: string, mode: ColorMode): string {
  return mode === "none" ? text : paintHex(text, hex, mode);
}

/**
 * Color a serializer s-expr string by leaf type. `mode` defaults to the live terminal's
 * capability; pass `"none"` for a guaranteed-identity pass. The POLICY of whether to color
 * lives in `output-mode.ts` — this only renders once that's decided yes.
 */
export function colorizeSexpr(src: string, mode: ColorMode = colorMode()): string {
  if (mode === "none") return src;
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i]!;

    // String literal — consume through the closing quote, honoring `\` escapes. An
    // unterminated string (truncated output) runs to end-of-input, still round-trips.
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
      out += tint(src.slice(i, j), DARCULA.string, mode); // string → green
      i = j;
      continue;
    }

    // Block comment `#| … |#` — the serializer's truncation marker.
    if (ch === "#" && src[i + 1] === "|") {
      const end = src.indexOf("|#", i + 2);
      const j = end === -1 ? n : end + 2;
      out += tint(src.slice(i, j), DARCULA.comment, mode);
      i = j;
      continue;
    }

    // Line comment `; …` to end of line.
    if (ch === ";") {
      let j = i;
      while (j < n && src[j] !== "\n") j += 1;
      out += tint(src.slice(i, j), DARCULA.comment, mode);
      i = j;
      continue;
    }

    // Delimiter — one dim character (structure recedes).
    if (DELIM.has(ch)) {
      out += tint(ch, DARCULA.delimiter, mode);
      i += 1;
      continue;
    }

    // Whitespace — passed through verbatim.
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      out += ch;
      i += 1;
      continue;
    }

    // Atom — a run up to the next delimiter / whitespace / string / comment start. `#\ ` (a
    // space char literal) is kept whole so it isn't split on its own space.
    let j = i;
    if (ch === "#" && src[i + 1] === "\\") j = i + 3; // #\<one char>, incl. #\space
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
