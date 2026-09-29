// Pure token→value parsers for the Scheme numeric tower (exact/inexact, rational, complex, radix
// prefixes), string literals, characters, and symbols. No I/O, no lexer state — given a token string,
// returns the boxed value. Numeric-grammar helpers originate from the heritage reader.
import invariant from "tiny-invariant";
import { schemeFalse, schemeTrue } from "../values/primitives/ABool.js";
import { AString } from "../values/primitives/AString.js";
import { ASymbol } from "../values/primitives/ASymbol.js";
import { AExact } from "../values/primitives/AExact.js";
import { AInexact } from "../values/primitives/AInexact.js";
import { EMPTY_PROVENANCE } from "../values/primitives/AValue.js";
import { complexDoor } from "../values/numbers.js";
import { mintExact } from "../values/mint-numeric.js";
import { ParseError, strictGate, type SourceLocation } from "../errors.js";
import {
  char_re,
  complex_re,
  float_re,
  int_re,
  parsable_contants,
  pre_num_parse_re,
  rational_re,
} from "./lexical-grammar.js";
import { ACharacter } from "../values/primitives/ACharacter.js";
import type { SchemeValue } from "../values/types.js";

// Radix-aware bigint parser — the only consumer is the exact/rational/float parsers below.
function parseBigInt(str: string, radix: number = 10): bigint {
  str = str.trim();
  const negative = str.startsWith("-");
  if (negative || str.startsWith("+")) {
    str = str.slice(1);
  }
  let result = 0n;
  const base = BigInt(radix);
  for (const char of str.toLowerCase()) {
    const digit = Number.parseInt(char, radix);
    invariant(!Number.isNaN(digit), `Invalid digit '${char}' for radix ${radix}`);
    result = result * base + BigInt(digit);
  }
  return negative ? -result : result;
}

// Safe-integer gate for exact literals (docs/design-history/arrival-one-number-rework.md
// §0.3/§2.5): a source literal whose exact magnitude would leave `Number.isSafeInteger`
// range THROWS a teaching ParseError rather than silently truncating or minting an
// impossible AExact component — the RATIO design has no bignum escape hatch.
// DRIFT ALARM: reader's twin of `values/numbers.ts`'s private `parseSafeIntLiteral` —
// same law, duplicated rather than imported, because that helper belongs to
// `parseNumber` (a deliberately separate, non-dual-use host utility) while
// parse_rational/parse_integer/parse_float here are the reader's LIVE path (also called
// by `string->number`, env/r7rs/strings.ts).
const PARSE_SAFE_MAX = BigInt(Number.MAX_SAFE_INTEGER);
const PARSE_SAFE_MIN = BigInt(Number.MIN_SAFE_INTEGER);

function exactOverflowInLiteral(original: string): never {
  throw new ParseError(
    `exact literal ${original} exceeds safe-integer range — write it inexact (use #i, or an inexact form) if approximation is acceptable`,
    undefined,
    "E-NUMERIC-OVERFLOW",
  );
}

// Gates a magnitude read EXACTLY via `parseBigInt` (arbitrarily many source digits, no
// per-digit float rounding) before it is ever narrowed to a `number` — sound because a
// bigint magnitude outside [PARSE_SAFE_MIN, PARSE_SAFE_MAX] can never round back INTO
// that range on conversion (same argument as AExact.cmp's overflow fallback: rounding
// only ever lands on a representable neighbor of equal-or-greater distance from zero).
function toSafeExactComponent(magnitude: bigint, original: string): number {
  if (magnitude > PARSE_SAFE_MAX || magnitude < PARSE_SAFE_MIN) exactOverflowInLiteral(original);
  return Number(magnitude);
}

// Gates a magnitude that is already a JS `number` (from Number.parseFloat/Math.round) —
// the float-literal arms below, where the value started life as an IEEE double rather
// than a hand-parsed digit string.
function assertSafeExactComponent(value: number, original: string): number {
  if (!Number.isSafeInteger(value)) exactOverflowInLiteral(original);
  return value;
}

// ref: https://github.com/bestiejs/punycode.js/blob/master/punycode.js
function ucs2decode(string: string): number[] {
  const output: number[] = [];
  let counter = 0;
  const length = string.length;
  while (counter < length) {
    const value = string.charCodeAt(counter++);
    if (value >= 0xd8_00 && value <= 0xdb_ff && counter < length) {
      // High surrogate — decode the pair with the next code unit.
      const extra = string.charCodeAt(counter++);
      if ((extra & 0xfc_00) === 0xdc_00) {
        // Low surrogate: combine into one astral codepoint.
        output.push(((value & 0x3_ff) << 10) + (extra & 0x3_ff) + 0x1_00_00);
      } else {
        // Unmatched high surrogate — keep it standalone; back up so the next unit is re-read.
        output.push(value);
        counter--;
      }
    } else {
      output.push(value);
    }
  }
  return output;
}

function num_pre_parse(arg: string): {
  radix?: number;
  inexact?: boolean;
  exact?: boolean;
  number?: string;
} {
  const parts = arg.match(pre_num_parse_re);
  const options: {
    radix?: number;
    inexact?: boolean;
    exact?: boolean;
    number?: string;
  } = {};
  if (parts![1]) {
    // eslint-disable-next-line unicorn/prefer-spread -- prefix flags are ASCII source units (`split("")`), not code points
    const type = new Set(parts![1].replaceAll("#", "").toLowerCase().split(""));
    if (type.has("x")) {
      options.radix = 16;
    } else if (type.has("o")) {
      options.radix = 8;
    } else if (type.has("b")) {
      options.radix = 2;
    } else if (type.has("d")) {
      options.radix = 10;
    }
    if (type.has("i")) {
      options.inexact = true;
    }
    if (type.has("e")) {
      options.exact = true;
    }
  }
  options.number = parts![2];
  return options;
}

// The exported numeric parsers are DUAL-USE (the reader's leaf path AND the live
// `string->number` in env/r7rs/strings.ts) — hence the optional trailing `loc`: the
// reader passes the literal's own source span; the runtime caller omits it (a
// runtime-computed number has no source span of its own).
export function parse_rational(arg: string, radix = 10, loc?: SourceLocation): AExact | AInexact {
  const parse = num_pre_parse(arg);
  const parts = parse.number!.split("/");
  const r = parse.radix || radix;
  const numBig = parseBigInt(parts[0], r);
  const denomBig = parseBigInt(parts[1], r);
  if (parse.inexact) {
    return new AInexact(Number(numBig) / Number(denomBig), EMPTY_PROVENANCE, loc);
  }
  // Components gated BEFORE the mint (never decline-to-parse: a rejected rational token
  // must throw, not fall through to `parse_symbol` —
  // docs/design-history/arrival-one-number-rework.md §1's named hazard).
  return mintExact(
    toSafeExactComponent(numBig, arg),
    toSafeExactComponent(denomBig, arg),
    undefined,
    "parse rational",
    loc,
  );
}

export function parse_integer(arg: string, radix = 10, loc?: SourceLocation): AExact | AInexact {
  const parse = num_pre_parse(arg);
  const r = parse.radix || radix;
  if (parse.inexact) {
    return new AInexact(Number.parseInt(parse.number!, r), EMPTY_PROVENANCE, loc);
  }
  return mintExact(toSafeExactComponent(parseBigInt(parse.number!, r), arg), 1, undefined, "parse integer", loc);
}

function parse_character(arg: string, loc?: SourceLocation): ACharacter {
  let m = arg.match(/#\\x([0-9a-f]+)$/i);
  let char: string | undefined;
  if (m) {
    const ord = Number.parseInt(m[1], 16);
    char = String.fromCodePoint(ord);
  } else {
    m = arg.match(/#\\([\s\S]+)$/);
    if (m) {
      char = m[1];
    }
  }
  invariant(char !== undefined, `Parse: invalid character in ${arg}`);
  return new ACharacter(char, EMPTY_PROVENANCE, loc);
}

function string_to_float(str: string): number {
  return Number.parseFloat(str);
}

export function parse_float(arg: string, loc?: SourceLocation): AExact | AInexact {
  const parse = num_pre_parse(arg);
  const value = string_to_float(parse.number!);
  const simple_number = (parse.number!.match(/\.0$/) || !/\./.test(parse.number!)) && !/e/i.test(parse.number!);
  if (!parse.inexact && parse.exact && simple_number) {
    return mintExact(assertSafeExactComponent(Math.round(value), arg), 1, undefined, "parse float", loc);
  }
  // An EXPONENT numeral (e.g. "1e2") defaults to INEXACT regardless of magnitude
  // (R7RS §7.1.1: only a decimal-point-free, exponent-free numeral defaults exact) —
  // an explicit #e is required to reach the exact arm at all, and that arm (below,
  // "approximate as a rational via its decimal string") already handles any
  // integer-valued float uniformly, whether it came from decimal or exponent form. A
  // magnitude too big for a safe-int component ParseErrors there instead of
  // constructing an unbounded rational — there is no bignum fallback under RATIO.
  // Inexact float, but exact was requested — approximate as a rational via its decimal string.
  if (parse.exact) {
    const floatVal = value;
    if (Number.isInteger(floatVal)) {
      return mintExact(assertSafeExactComponent(Math.round(floatVal), arg), 1, undefined, "parse float", loc);
    }
    const str = floatVal.toString();
    const decimalIndex = str.indexOf(".");
    if (decimalIndex !== -1) {
      const decimals = str.length - decimalIndex - 1;
      const denom = 10 ** decimals;
      const num = Number(str.replace(".", "").replace("-", ""));
      const sign = floatVal < 0 ? -1 : 1;
      return mintExact(
        assertSafeExactComponent(sign * num, arg),
        assertSafeExactComponent(denom, arg),
        undefined,
        "parse float",
        loc,
      );
    }
    return mintExact(assertSafeExactComponent(Math.round(floatVal), arg), 1, undefined, "parse float", loc);
  }
  return new AInexact(value, EMPTY_PROVENANCE, loc);
}

export function parse_complex(_arg: string, _radix = 10): AExact | AInexact {
  // Complex literals are DOORED — arrival is reals-only (R7RS § 6.2.3 permits
  // omitting complex). The reader recognized the complex shape upstream (complex_re);
  // here we reject it with the teaching message instead of building a complex value.
  // Even a zero-imaginary literal (3+0i) is complex-tower notation we don't support —
  // write the real (3). `string->number` catches this and returns #f per R7RS
  // "not a number"; a literal in source surfaces the door.
  return complexDoor();
}

function parse_string(string: string, loc?: SourceLocation): AString {
  // handle non JSON escapes and skip unicode escape \u (even partial)
  string = string
    .replaceAll(/\\x([0-9a-f]+);/gi, function (_, hex) {
      // Emit the real codepoint as JSON \uXXXX escape(s). For astral codepoints
      // (> U+FFFF) String.fromCodePoint yields a UTF-16 surrogate pair, which we
      // re-emit as two \uXXXX units so JSON.parse reconstructs the true char.
      const codepoint = Number.parseInt(hex, 16);
      const utf16 = String.fromCodePoint(codepoint);
      let out = "";
      for (let i = 0; i < utf16.length; i++) {
        out += String.raw`\u` + utf16.charCodeAt(i).toString(16).padStart(4, "0");
      }
      return out;
    })
    .replaceAll("\n", String.raw`\n`); // scheme strings can be multiline
  const m = string.match(/(\\*)(\\x[0-9A-F])/i);
  if (m && m[1].length % 2 === 0) {
    throw new ParseError(`Invalid string literal, unclosed: ${m[2]}`, undefined, "E-STRING-UNCLOSED");
  }
  try {
    const str = new AString(JSON.parse(string), EMPTY_PROVENANCE, loc);
    str.freeze();
    return str;
  } catch (error) {
    throw new ParseError(
      `Invalid string literal: ${(error as Error).message.replace(/in JSON /, "").replace(/.*Error: /, "")}`,
      undefined,
      "E-STRING-INVALID",
    );
  }
}

// R7RS §7.1.1 escape grammar for `|...|` bar-quoted symbols: the five mnemonic escapes,
// a literal bar/backslash, an inline hex escape (`\x<hex>;`, any Unicode scalar — astral
// codepoints round-trip through `String.fromCodePoint`), and the line-continuation escape
// (`\`, intraline whitespace, a line ending, intraline whitespace — folds to nothing).
// Shared with nothing else: `parse_string` decodes JSON-shaped escapes via `JSON.parse`
// (a different delimiter, no `\a`/`\|`), so bar-symbols get their own small decoder rather
// than a forced, awkward reuse.
const BAR_SYMBOL_MNEMONICS: Record<string, string> = {
  a: "",
  b: "\b",
  t: "\t",
  n: "\n",
  r: "\r",
};

const BAR_SYMBOL_ESCAPE_RE = /\\(?:x([0-9a-fA-F]+);|([|\\abtnr])|[ \t]*\r?\n[ \t]*)/g;

// Decodes the content between one `|...|` pair's bars. Escapes are only meaningful inside
// the bars — the plain-text runs a token may adjoin (see `splitBarSegments`) are copied verbatim.
function decodeBarSymbolEscapes(content: string): string {
  // A backslash that doesn't open one of the four recognized escape forms is invalid R7RS
  // syntax — reject it rather than silently passing the stray backslash through.
  const stray = content.match(/\\(?!x[0-9a-fA-F]+;|[|\\abtnr]|[ \t]*\r?\n)/);
  if (stray !== null) {
    throw new ParseError(
      `Parse: invalid escape '\\${content.slice((stray.index ?? 0) + 1, (stray.index ?? 0) + 9)}' in |...| symbol literal`,
      undefined,
      "E-SYMBOL-BAR-ESCAPE",
    );
  }
  return content.replaceAll(BAR_SYMBOL_ESCAPE_RE, (_match, hex?: string, mnemonic?: string) => {
    if (hex !== undefined) {
      return String.fromCodePoint(Number.parseInt(hex, 16));
    }
    if (mnemonic !== undefined) {
      return mnemonic === "|" || mnemonic === "\\" ? mnemonic : BAR_SYMBOL_MNEMONICS[mnemonic];
    }
    // line continuation: intraline whitespace* line-ending intraline whitespace* → nothing
    return "";
  });
}

// Splits a reader token on UNESCAPED `|` boundaries into alternating plain/quoted runs.
// `|foo bar|` is a single quoted run; `abc|d e|fgh` (plain text directly adjoining a bar
// run with no separating whitespace — an existing reader tolerance, see the Lexer's
// `b_symbol_ex` state) is plain+quoted+plain. Inside a quoted run, `\` always escapes
// exactly the following character, so an escaped `\|` can never be mistaken for the close.
function splitBarSegments(token: string): { text: string; quoted: boolean }[] {
  const segments: { text: string; quoted: boolean }[] = [];
  let buf = "";
  let quoted = false;
  for (let i = 0; i < token.length; ++i) {
    const char = token[i];
    if (quoted && char === "\\") {
      buf += char + (token[i + 1] ?? "");
      ++i;
      continue;
    }
    if (char === "|") {
      segments.push({ text: buf, quoted });
      buf = "";
      quoted = !quoted;
      continue;
    }
    buf += char;
  }
  if (quoted) {
    throw new ParseError(
      `Parse: unterminated |...| symbol literal in ${token}`,
      undefined,
      "E-SYMBOL-BAR-UNTERMINATED",
    );
  }
  segments.push({ text: buf, quoted: false });
  return segments;
}

function parse_symbol(arg: string): ASymbol {
  if (!arg.includes("|")) {
    return new ASymbol(arg);
  }
  const name = splitBarSegments(arg)
    .map((segment) => (segment.quoted ? decodeBarSymbolEscapes(segment.text) : segment.text))
    .join("");
  return new ASymbol(name);
}

// ── Self-evaluating literal constants ──
// Hoisted to module scope so every `+inf.0` / `-inf.0` / `+nan.0` in source shares ONE instance.
// MUST stay boxed SchemeInexact, not raw JS numbers: a bare primitive leaks an un-AValue past
// the parser and breaks every downstream consumer that assumes numerics are SchemeExact/
// SchemeInexact (`is_inexact`, numeric operators in env/r7rs/numeric.ts, provenance algebra).
const nan = new AInexact(Number.NaN);
const posInf = new AInexact(Number.POSITIVE_INFINITY);
const negInf = new AInexact(Number.NEGATIVE_INFINITY);

const constants: Record<string, SchemeValue> = {
  "#t": schemeTrue,
  "#f": schemeFalse,
  "#true": schemeTrue,
  "#false": schemeFalse,
  "+inf.0": posInf,
  "-inf.0": negInf,
  "+nan.0": nan,
  "-nan.0": nan,
  ...parsable_contants,
};

// ── Token → value dispatch ──
// Constants first, then string, then the `#`-prefixed family (char), then the numeric tower;
// anything that falls through is a symbol. Order matters — the cheap `Object.hasOwn` and prefix tests
// gate the expensive numeric regexes.
export function parse_argument(arg: string, strict = false, loc?: SourceLocation): SchemeValue {
  // Strict (the R7RS portability control) rejects the loose-mode `#void`/`#null`
  // reader literals — a program that writes them is not portable to a stock Scheme.
  // The VALUES (void/nil) still exist; only the non-standard readable LITERAL is gated.
  if (arg === "#void" || arg === "#null") {
    strictGate(
      { strict },
      { op: "reader-literal", rule: `\`${arg}' has no R7RS reader syntax — it is a loose-mode-only literal` },
    );
  }
  // Constants stay SHARED singletons (#t/#f/±inf/nan) — deliberately location-less:
  // per-occurrence identity would break the shared-by-reference-forever design.
  if (Object.hasOwn(constants, arg)) {
    return constants[arg];
  }
  if (/^"[\s\S]*"$/.test(arg)) {
    return parse_string(arg, loc);
  } else if (arg[0] === "#") {
    if (char_re.test(arg)) {
      return parse_character(arg, loc);
    }
    // characters with more than one codepoint
    const m = arg.match(/#\\(.+)/);
    if (m && ucs2decode(m[1]).length === 1) {
      return parse_character(arg, loc);
    }
  }
  if (/[0-9a-f]|[+-]i/i.test(arg)) {
    if (arg.match(int_re)) {
      return parse_integer(arg, 10, loc);
    } else if (float_re.test(arg)) {
      return parse_float(arg, loc);
    } else if (arg.match(rational_re)) {
      return parse_rational(arg, 10, loc);
    } else if (arg.match(complex_re)) {
      return parse_complex(arg);
    }
  }
  if (/^#[iexobd]/.test(arg)) throw new ParseError(`Invalid numeric constant: ${arg}`, undefined, "E-NUMERIC-CONSTANT");
  // SYMBOLS deliberately stay LOCATION-LESS (interning off CONSTANT_CTX's flyweight table):
  // a per-occurrence span would mint per-occurrence instances — and raw reference identity
  // on interned symbols is load-bearing: memq/assq compare with `===` (env/r7rs/lists.ts),
  // and the specials quote-family table shares instances with parsed source through that
  // same table. deferred: per-occurrence symbol spans blocked until those `===` sites
  // delegate to `eq()` (structural-equal.ts).
  return parse_symbol(arg);
}
