/**
 * Char ops — the R7RS § 6.6 character cluster: predicates, comparisons,
 * classification, case conversion, and char/integer conversions.
 *
 * Each op declares a zod contract and its impl works on the contract's SCHEME
 * face (`Impl<…,"scheme">`): predicates return the schemeTrue/schemeFalse
 * flyweights (a `z.boolean` output demands an ABool), digit-value's numeric arm
 * boxes to AExact/AInexact.
 */

import foldCase from "fold-case";
import dedent from "dedent";
import unicodeProperties from "unicode-properties";
import invariant from "tiny-invariant";

import { withContractFields } from "../../common/symbols/_bake.js";
import type { CallCtx } from "../../run/CallCtx.js";
import { charValue, coerceNumeric, deriveOrd, schemeBool as bool } from "../../values/op-helpers.js";
import { schemeFalse, schemeTrue } from "../../values/primitives/ABool.js";
import { AInexact } from "../../values/primitives/AInexact.js";
import { AExact } from "../../values/primitives/AExact.js";
import { ACharacter } from "../../values/primitives/ACharacter.js";
import { EnvCapability } from "../../common/capability.js";

export default EnvCapability.define("scheme/chars", {
  symbols: (symbol, z) => ({
    // Char harvest image is string (single-char); no separate ambient Char carrier.
    "char?": withContractFields(symbol.taglessGuard`char?: #t iff obj is a character`, {
      type: dedent`
          {
            (x: unknown): x is string;
            <T>(x: T): x is Extract<T, string>;
          }
        `,
    }),

    "char=?": symbol.native`char=?: typed equivalence over characters`(
      { input: [], inputRest: z.char, output: [z.boolean] },
      function (this: CallCtx, ...chars) {
        if (chars.length < 2) return schemeTrue;
        const first = charValue(chars[0]);
        return bool(chars.slice(1).every((c) => charValue(c) === first));
      },
    ),

    // char</>/<=/>= derive from SchemeCharacter's arrival/tagless-final/lte via the
    // shared deriveOrd chain.
    "char<?": symbol.native`char<?: strictly-increasing character order`(
      { input: [], inputRest: z.char, output: [z.boolean] },
      deriveOrd("<"),
    ),
    "char>?": symbol.native`char>?: strictly-decreasing character order`(
      { input: [], inputRest: z.char, output: [z.boolean] },
      deriveOrd(">"),
    ),
    "char<=?": symbol.native`char<=?: non-decreasing character order`(
      { input: [], inputRest: z.char, output: [z.boolean] },
      deriveOrd("<="),
    ),
    "char>=?": symbol.native`char>=?: non-increasing character order`(
      { input: [], inputRest: z.char, output: [z.boolean] },
      deriveOrd(">="),
    ),

    "char-ci=?": symbol.native`char-ci=?: case-insensitive character equivalence`(
      { input: [], inputRest: z.char, output: [z.boolean] },
      function (this: CallCtx, ...chars) {
        if (chars.length < 2) return schemeTrue;
        const first = charValue(chars[0]).toLowerCase();
        return bool(chars.slice(1).every((c) => charValue(c).toLowerCase() === first));
      },
    ),

    "char-ci<?": symbol.native`char-ci<?: case-insensitive strictly-increasing order`(
      { input: [], inputRest: z.char, output: [z.boolean] },
      function (this: CallCtx, ...chars) {
        for (let i = 0; i < chars.length - 1; i++) {
          if (charValue(chars[i]).toLowerCase() >= charValue(chars[i + 1]).toLowerCase()) return schemeFalse;
        }
        return schemeTrue;
      },
    ),

    "char-ci>?": symbol.native`char-ci>?: case-insensitive strictly-decreasing order`(
      { input: [], inputRest: z.char, output: [z.boolean] },
      function (this: CallCtx, ...chars) {
        for (let i = 0; i < chars.length - 1; i++) {
          if (charValue(chars[i]).toLowerCase() <= charValue(chars[i + 1]).toLowerCase()) return schemeFalse;
        }
        return schemeTrue;
      },
    ),

    "char-ci<=?": symbol.native`char-ci<=?: case-insensitive non-decreasing order`(
      { input: [], inputRest: z.char, output: [z.boolean] },
      function (this: CallCtx, ...chars) {
        for (let i = 0; i < chars.length - 1; i++) {
          if (charValue(chars[i]).toLowerCase() > charValue(chars[i + 1]).toLowerCase()) return schemeFalse;
        }
        return schemeTrue;
      },
    ),

    "char-ci>=?": symbol.native`char-ci>=?: case-insensitive non-increasing order`(
      { input: [], inputRest: z.char, output: [z.boolean] },
      function (this: CallCtx, ...chars) {
        for (let i = 0; i < chars.length - 1; i++) {
          if (charValue(chars[i]).toLowerCase() < charValue(chars[i + 1]).toLowerCase()) return schemeFalse;
        }
        return schemeTrue;
      },
    ),

    // R7RS § 6.6: each predicate returns #t iff the character's Unicode general
    // category falls in the expected set. A round-trip-case heuristic
    // (`lower !== upper`) misses every category-Lo script (CJK, Hangul, Hebrew,
    // Arabic, …) because Lo has no case mapping → lower === upper → predicate
    // returns #f. `unicodeProperties.getCategory(codepoint)` is the source of
    // truth.
    "char-alphabetic?": symbol.native`char-alphabetic?: #t iff the character is a letter`(
      { input: [z.char], output: [z.boolean] },
      function (this: CallCtx, char) {
        const cp = charValue(char).codePointAt(0)!;
        switch (unicodeProperties.getCategory(cp)) {
          case "Lu":
          case "Ll":
          case "Lt":
          case "Lm":
          case "Lo":
            return schemeTrue;
          default:
            return schemeFalse;
        }
      },
    ),

    "char-numeric?": symbol.native`char-numeric?: #t iff the character is a numeric digit`(
      { input: [z.char], output: [z.boolean] },
      function (this: CallCtx, char) {
        const cp = charValue(char).codePointAt(0)!;
        // Number categories: Nd (decimal digit), Nl (letter number), No (other).
        // A bare `isDigit` matches only Nd, misclassifying CJK and Roman
        // numerals (Nl).
        switch (unicodeProperties.getCategory(cp)) {
          case "Nd":
          case "Nl":
          case "No":
            return schemeTrue;
          default:
            return schemeFalse;
        }
      },
    ),

    "char-whitespace?": symbol.native`char-whitespace?: #t iff the character is whitespace`(
      { input: [z.char], output: [z.boolean] },
      function (this: CallCtx, char) {
        // JS \s ≈ Unicode White_Space property — covers ASCII tab/LF/CR/space
        // plus the Z* categories (Zs/Zl/Zp) plus a few format chars. Closer to
        // R7RS than getCategory alone (which would miss tab/LF as Cc).
        return bool(/^\s$/.test(charValue(char)));
      },
    ),

    "char-upper-case?": symbol.native`char-upper-case?: #t iff the character is uppercase`(
      { input: [z.char], output: [z.boolean] },
      function (this: CallCtx, char) {
        const cp = charValue(char).codePointAt(0)!;
        return bool(unicodeProperties.getCategory(cp) === "Lu");
      },
    ),

    "char-lower-case?": symbol.native`char-lower-case?: #t iff the character is lowercase`(
      { input: [z.char], output: [z.boolean] },
      function (this: CallCtx, char) {
        const cp = charValue(char).codePointAt(0)!;
        return bool(unicodeProperties.getCategory(cp) === "Ll");
      },
    ),

    "digit-value": symbol.native`digit-value: numeric value of a digit character, or #f`(
      { input: [z.char], output: [z.union([z.number, z.boolean])] },
      function (this: CallCtx, char) {
        const c = charValue(char);
        const codePoint = c.codePointAt(0)!;
        if (!unicodeProperties.isDigit(codePoint)) return schemeFalse;
        const numericValue = unicodeProperties.getNumericValue(codePoint);
        if (numericValue === null) return schemeFalse;
        // The scheme face of the numeric arm: exact for integers (digits), inexact for the
        // rare fractional numeric values (vulgar-fraction No characters).
        return Number.isInteger(numericValue) ? new AExact(numericValue) : new AInexact(numericValue);
      },
    ),

    "char-upcase": symbol.native`char-upcase: uppercase form of the character`(
      { input: [z.char], output: [z.char] },
      function (this: CallCtx, char) {
        return new ACharacter(charValue(char).toUpperCase());
      },
    ),

    "char-downcase": symbol.native`char-downcase: lowercase form of the character`(
      { input: [z.char], output: [z.char] },
      function (this: CallCtx, char) {
        return new ACharacter(charValue(char).toLowerCase());
      },
    ),

    "char-foldcase": symbol.native`char-foldcase: case-folded form of the character`(
      { input: [z.char], output: [z.char] },
      function (this: CallCtx, char) {
        const c = charValue(char);
        const folded = foldCase(c);
        // R7RS § 6.6: char-foldcase returns a character (single Unicode scalar).
        // When fold would expand to MULTIPLE chars (Eszett ß → "ss", Greek final
        // sigma, etc.), there is no single-char result, so the operation MUST
        // return the input unchanged. Truncating to `folded[0]` produces a
        // different character (ß → s) which violates the round-trip identity.
        return [...folded].length === 1 ? new ACharacter(folded) : char;
      },
    ),

    // Character/integer conversion
    // R7RS § 6.6: return the Unicode SCALAR (code point), not the UTF-16 code unit.
    // `charCodeAt(0)` is wrong for non-BMP chars (e.g. emoji): it returns the high
    // surrogate (e.g. 0xD83D for 😀) instead of the full code point (0x1F600).
    // `codePointAt(0)` reads a full surrogate pair when present.
    "char->integer": symbol.native`char->integer: Unicode scalar value of the character`(
      { input: [z.char], output: [z.exact] },
      function (this: CallCtx, char) {
        return new AExact(charValue(char).codePointAt(0)!);
      },
    ),

    // R7RS § 6.6: inverse of char->integer over Unicode scalar range.
    // `fromCharCode` silently truncates above 0xFFFF (modulo 0x10000), corrupting
    // any non-BMP code point. `fromCodePoint` accepts up to U+10FFFF and emits
    // the correct surrogate pair. Surrogate code points themselves (D800..DFFF)
    // are NOT Unicode scalars per the standard; reject explicitly.
    "integer->char": symbol.native`integer->char: character for a Unicode scalar value`(
      { input: [z.schemeNumber], output: [z.char] },
      function (this: CallCtx, n) {
        // ctx-neutral by design (see strings.ts's parallel note): `num` is unwrapped
        // to a raw code point below and never escapes as a boxed value — the mint
        // that DOES escape (the returned ACharacter) already threads `this.runCtx`.
        const num = coerceNumeric(n);
        const code = num instanceof AExact ? Number(num.num) : Math.floor(num.real);
        invariant(code >= 0 && code <= 0x10_ff_ff, `integer->char: code point ${code} out of Unicode range`);
        invariant(
          code < 0xd8_00 || code > 0xdf_ff,
          `integer->char: surrogate code point ${code.toString(16)} is not a Unicode scalar`,
        );
        return new ACharacter(String.fromCodePoint(code));
      },
    ),
  }),
});
