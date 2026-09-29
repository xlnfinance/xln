/**
 * Type-level Scheme identifier ↔ TypeScript binding-name serde.
 *
 * Typelevel projection is allowed to differ from run-faithful Mercury
 * (`cleanName` camelCase). This encoding is **lossless and reversible**: every
 * Scheme symbol becomes a legal TS IdentifierName so ambient `declare function`
 * / `const` can use bare names — no `__arr["…"]` property bag.
 *
 * Rules
 * ─────
 * 1. **Special characters** each become a `$token$` run (see {@link SCHEME_IDENT_CHAR_TOKENS}).
 *    `$` itself is `$dollar$` so introduced tokens never collide with source dollars.
 * 2. **Reserved words** (JS/TS keywords + a few binding hazards) that would
 *    otherwise be a plain identifier wrap the whole name: `import` → `$import$`.
 * 3. Letters, digits, and `_` pass through unchanged.
 * 4. Anything else (rare unicode / punctuation) → `$u{hex}$` (code point).
 *
 * Examples
 * ────────
 *   string->number  →  string$dash$$greater$number
 *   null?           →  null$qmark$
 *   list-ref        →  list$dash$ref
 *   chat/completion →  chat$slash$completion
 *   import          →  $import$
 *   $x              →  $dollar$x
 *   +               →  $plus$
 *   car             →  car
 */

/** Token name (no `$` wrappers) for each special character in a Scheme symbol. */
export const SCHEME_IDENT_CHAR_TOKENS: Readonly<Record<string, string>> = Object.freeze({
  $: "dollar",
  "-": "dash",
  "?": "qmark",
  "!": "bang",
  "*": "star",
  "/": "slash",
  "+": "plus",
  "=": "eq",
  "<": "less",
  ">": "greater",
  "@": "at",
  ":": "colon",
  ".": "dot",
  "%": "percent",
  "&": "amp",
  "^": "caret",
  "~": "tilde",
});

/** Reverse: token → single character. Built once from {@link SCHEME_IDENT_CHAR_TOKENS}. */
export const SCHEME_IDENT_TOKEN_CHARS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(Object.entries(SCHEME_IDENT_CHAR_TOKENS).map(([ch, tok]) => [tok, ch])),
);

/**
 * Whole-name wraps: if the Scheme symbol is exactly one of these (and contains no
 * specials), encode as `$name$`. Same set Mercury escapes in `cleanName`, plus
 * TypeScript-only binding hazards that still break ambient decls.
 *
 * Not every ES reserved word is a Scheme hazard we care about day-to-day; the set
 * is the union of keywords that cannot be a TS BindingIdentifier in strict code.
 */
export const SCHEME_IDENT_RESERVED: ReadonlySet<string> = new Set([
  // ES keywords / future-reserved — illegal (or hazardous) as BindingIdentifier
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "new",
  "null",
  "return",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
  "let",
  "static",
  "await",
  "async",
  "implements",
  "interface",
  "package",
  "private",
  "protected",
  "public",
  // strict-mode binding hazards
  "arguments",
  "eval",
  // Note: TS *type*-space names (`string`, `number`, `symbol`, `type`, …) are
  // legal value bindings (`const string = 1` typechecks). Do NOT wrap them —
  // Scheme has `string?` / `string-append` / `symbol->string` that only need
  // char-token encoding of their specials, not whole-name wraps.
]);

/** A single `$token$` body: letters only (char tokens + reserved wraps + `u`+hex). */
const TOKEN_BODY = /^[A-Z][A-Z0-9]*$/i;

/** Plain JS/TS identifier character (ASCII subset we preserve). */
const PLAIN = /\w/;

/**
 * Scheme symbol → legal TypeScript IdentifierName (lossless).
 *
 * @see module doc for rules and examples
 */
export function encodeSchemeIdent(scheme: string): string {
  if (scheme === "") return "$empty$";

  // Whole-name reserved wrap — only when the name is already a plain identifier.
  // `null?` is not reserved-as-a-whole; it goes through char encoding → `null$qmark$`.
  if (SCHEME_IDENT_RESERVED.has(scheme) && isPlainIdent(scheme)) {
    return `$${scheme}$`;
  }

  let out = "";
  for (const ch of scheme) {
    if (PLAIN.test(ch)) {
      out += ch;
      continue;
    }
    const tok = SCHEME_IDENT_CHAR_TOKENS[ch];
    if (tok !== undefined) {
      out += `$${tok}$`;
      continue;
    }
    const cp = ch.codePointAt(0)!;
    out += `$u${cp.toString(16)}$`;
  }

  // Leading digit is illegal as a TS IdentifierStart.
  if (/^\d/.test(out)) out = `$n$${out}`;

  // If char-encoding somehow yielded a bare reserved word (only possible for
  // reserved names with zero specials — already handled above). Defensive:
  if (SCHEME_IDENT_RESERVED.has(out) && isPlainIdent(out)) {
    out = `$${out}$`;
  }

  return out;
}

/**
 * Inverse of {@link encodeSchemeIdent}. Throws if `encoded` is not a well-formed
 * encoding (unknown `$token$`, truncated run, etc.).
 */
export function decodeSchemeIdent(encoded: string): string {
  if (encoded === "$empty$") return "";

  // Whole-name reserved / empty wraps: entire string is `$token$`.
  const whole = /^\$([A-Z][A-Z0-9]*)\$$/i.exec(encoded);
  if (whole) {
    const tok = whole[1]!;
    if (tok === "empty") return "";
    if (tok === "n") {
      // `$n$…` is a leading-digit prefix, not a whole-name wrap — fall through
      // only when the *entire* string is exactly `$n$` (degenerate).
      if (encoded === "$n$") throw new Error(`decodeSchemeIdent: incomplete $n$ prefix`);
    } else if (SCHEME_IDENT_RESERVED.has(tok) && SCHEME_IDENT_TOKEN_CHARS[tok] === undefined) {
      return tok;
    }
    // else: single char-token whole name like `$plus$` / `$dash$` — fall through
  }

  let i = 0;
  let out = "";
  while (i < encoded.length) {
    const c = encoded[i]!;
    if (c !== "$") {
      out += c;
      i += 1;
      continue;
    }
    const close = encoded.indexOf("$", i + 1);
    if (close === -1) {
      throw new Error(`decodeSchemeIdent: unclosed $ at ${i} in ${JSON.stringify(encoded)}`);
    }
    const tok = encoded.slice(i + 1, close);
    if (tok === "") {
      throw new Error(`decodeSchemeIdent: empty $…$ at ${i} in ${JSON.stringify(encoded)}`);
    }
    if (tok === "n") {
      // Leading-digit guard — emit nothing, continue (digits follow).
      i = close + 1;
      continue;
    }
    if (tok === "empty") {
      // Only valid as a whole-string encode; mid-stream is corrupt.
      throw new Error(`decodeSchemeIdent: $empty$ only valid as whole name`);
    }
    const ch = SCHEME_IDENT_TOKEN_CHARS[tok];
    if (ch !== undefined) {
      out += ch;
      i = close + 1;
      continue;
    }
    if (tok.startsWith("u") && /^u[0-9a-fA-F]+$/.test(tok)) {
      const cp = Number.parseInt(tok.slice(1), 16);
      out += String.fromCodePoint(cp);
      i = close + 1;
      continue;
    }
    // Reserved whole-wrap scanned mid-stream shouldn't happen for well-formed
    // encodes (`$import$` is the entire string). Treat unknown tokens as errors.
    if (SCHEME_IDENT_RESERVED.has(tok) && TOKEN_BODY.test(tok)) {
      out += tok;
      i = close + 1;
      continue;
    }
    throw new Error(`decodeSchemeIdent: unknown token $${tok}$ in ${JSON.stringify(encoded)}`);
  }
  return out;
}

/** True when encode(decode(x)) and decode(encode(x)) hold for well-formed inputs. */
export function isPlainIdent(s: string): boolean {
  return /^[A-Z_]\w*$/i.test(s);
}

/**
 * Reconstruct scheme spellings inside a TS checker/display string for humans.
 *
 * Encoded idents (`pair$qmark$`, `string$dash$append`, `$plus$`) → scheme
 * (`pair?`, `string-append`, `+`). Tokens without `$` pass through (`List`,
 * `car`, `string`). Malformed `$…$` runs stay as emitted (never throw).
 *
 * For USER-FACING text only (diagnostics, hover, completion detail). Injected
 * program annotations must stay encoded so they remain valid TS.
 */
export function schemeifyTsText(text: string): string {
  return text.replaceAll(/[A-Z_$][\w$]*/gi, (tok) => {
    if (!tok.includes("$")) return tok;
    try {
      return decodeSchemeIdent(tok);
    } catch {
      return tok;
    }
  });
}

/**
 * True when `name` needs no `$…$` runs — already a legal non-reserved TS binding.
 * Useful for emitters that want a fast path print.
 */
export function schemeIdentIsBareTs(scheme: string): boolean {
  return isPlainIdent(scheme) && !SCHEME_IDENT_RESERVED.has(scheme);
}
