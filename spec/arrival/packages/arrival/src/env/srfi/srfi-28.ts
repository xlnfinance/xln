// SRFI-28 — basic format strings (the string-destination subset). Scheme-bootstrap capability.
//
// SINGLE SOURCE: this module is the sole definition site. It is registered in
// `srfi/index.ts` (`allSrfi`) and reaches the base env via `base-packs.ts`.
//
// WHY: LLM agents in our sandboxed tool-calling REPL reach for `(format ...)` from
// training data (Common-Lisp / SRFI-28 idioms). Left unbound, a model that wants to
// build a message string crashes on `Unbound variable 'format'`. We complete the
// platform's grain by binding the PURE, string-returning subset honestly.
//
// SCOPE NARROWING (honest deltas from SRFI-28 / SRFI-48):
//   • SRFI-28 proper is `(format fmt-string arg ...)` → string. We bind exactly that.
//   • SRFI-48/CL put a DESTINATION first: `(format dest fmt-string arg ...)`. We admit
//     the `#f` destination ONLY — `(format #f "..." ...)` returns the same string. Any
//     OTHER destination (`#t` = current-output-port, or a port) is an IO effect, and
//     arrival ships no IO surface (see r7rs/host.ts) — it is a teaching door, not a
//     silent no-op.
//   • Directives: `~a` (display), `~s` (write), `~d` (decimal number), `~%` (newline),
//     `~~` (literal tilde), plus one bounded SRFI-48 subset — `~F` / `~w,dF` fixed-point
//     (optional width, optional `,decimals`; covers the CL-style `~,2f` models reach for
//     right after `~d`). SRFI-48's numeric-COLUMN directives (`~w` alone), `~r` (radix/
//     roman-numeral), and `~t`/`~_` whitespace directives are NOT bound — they are
//     presentation-layout, not value-rendering, and belong to a port-backed pretty-
//     printer we don't ship.
//   • Directive letters are case-insensitive (SRFI-48 admits `~A`/`~S`/`~D`/`~F`).
//
// PROVENANCE: `format` is a COLLAPSING op (it folds the fmt string + every arg into one
// fresh string), so — exactly like `string-append` / `string-join` — the result is
// `taintString(text, collapseProvenance(fmt, ...args))`, the DEEP union of every input's
// lineage (an arg may be a nested structure). See provenance-collapse.ts and the
// string-append comment in r7rs/strings.ts.
//
// RENDERING: values render through the printer's sole renderer `printValue` (display-
// style — strings bare), so `~a` reuses it directly. `~s` (write-style) is `~a` PLUS a
// re-readable double-quoted, backslash-escaped form for a top-level string (the one place
// the arrival printer, being display-only, differs from R7RS `write`). Non-string args
// render identically under `~a` and `~s`.

import type { CallCtx } from "../../run/CallCtx.js";
import { EnvCapability } from "../../common/capability.js";
import { stringValue, isSchemeNumber } from "../../values/op-helpers.js";
import { collapseProvenance, taintString } from "../../provenance/provenance-collapse.js";
import { printValue } from "../../values/print.js";
import { AString } from "../../values/primitives/AString.js";
import { ABool } from "../../values/primitives/ABool.js";
import { ArrivalError, type ErrorClass } from "../../errors.js";

/** A scheme string value (boxed AString, or a raw JS string on the odd pre-box path). */
const isStringLike = (v: unknown): v is AString | string => v instanceof AString || typeof v === "string";

/** Exactly `#f` (raw false or a boxed ABool false) — NOT `#null`, NOT `#t`, NOT a port. */
const isHashF = (v: unknown): boolean => v === false || (v instanceof ABool && v.value === false);

// The only IO effect a wrong destination would name — kept in the tone of r7rs/host.ts's
// IO doors: arrival is a pure inference plane, so streaming out has no construction-site.
const DEST_REASON =
  'format here is string-only: it returns the formatted string. A #t or port destination would stream to a port, but arrival ships no IO surface (it is a pure inference plane). Use (format #f ...) or (format "..." ...) to GET the string, then return it from your dataflow';

const SUPPORTED =
  "~a (display) ~s (write) ~d (decimal) ~F / ~w,dF (fixed-point, e.g. ~,2f) ~% (newline) ~~ (literal tilde)";

/** Display-style render (strings bare) — the printer's sole renderer. */
const displayOf = (arg: unknown): string => printValue(arg);

/** Write-style render — display, plus a re-readable quoted/escaped form for a string. */
const writeOf = (arg: unknown): string => {
  if (isStringLike(arg)) {
    const s = stringValue(arg);
    return `"${s.replaceAll("\\", "\\\\").replaceAll('"', String.raw`\"`)}"`;
  }
  return printValue(arg);
};

/** `format`'s own misuse doors — a bad destination, a dangling/unknown directive, an
 *  argument-count mismatch against the fmt string. Colocated here (not `errors.ts`),
 *  same discipline as `common/kwargs-rejection.ts`'s `KwargsRejectionError`: this
 *  file owns the format-string grammar these messages describe, so the class lives
 *  beside it rather than duplicating that context in the shared leaf. */
class FormatError extends ArrivalError {
  // Interop boundary: covered by the nominal `instanceof ArrivalError` family rule
  // in interop-access.ts — no per-class stamp needed.
  public readonly name = "FormatError";
  readonly "arrival/error-category": ErrorClass = "other";
}

export default EnvCapability.define("scheme/srfi-28", {
  symbols: (symbol, z) => ({
    format:
      symbol.native`format: fills a format string using ~ directives and returns the resulting string (SRFI-28/48); supports (format fmt arg ...) and (format #f fmt ...)`(
        // Contract: a FIXED head + an `inputRest` variadic tail (the rosetta idiom —
        // `_bake.ts`'s `normalizeInputVector`/`DecodedArgsWithRest`; same shape
        // family as `r7rs/strings.ts`'s `string-append`). The head's honest type is
        // `string | boolean` — SRFI-28 proper's fmt-string arg UNIONED with the
        // SRFI-48/CL `#f`-destination sentinel: a plain `z.string` would be a LIE
        // (`(format #f ...)` legitimately hands a boolean here), and this file has
        // no `as unknown`/`as any` license to paper over that. `#t` (or any other
        // boolean/non-string value that isn't the `#f` sentinel) is still a runtime
        // teaching door below (DEST_REASON) — z.union can't express "boolean, but
        // only false", and `symbol.native` never runtime-validates its contract
        // anyway (`_bake.ts`: "zod for TYPES purely" — no z.decode fires here), so
        // the union costs nothing beyond the .d.ts/static-arity precision it buys:
        // it statically pins format at ≥1 argument. `inputRest` is `z.schemeValue` — the
        // representation-BLIND scheme-value identity — since a directive-fill arg
        // can be ANY scheme value (rendered via `displayOf`/`writeOf`).
        { input: [z.union([z.string, z.boolean])], inputRest: z.schemeValue, output: [z.string] },
        function (this: CallCtx, head: AString | ABool | undefined, ...tail: unknown[]): AString {
          // ── Resolve destination vs format string ───────────────────────────────
          // SRFI-28: `head` IS the format string. SRFI-48/CL: `head` is a
          // destination; we admit `#f` only, and then `tail[0]` is the format.
          // (`head` reads `undefined` only when the evaluator hands us fewer args
          // than the contract declares — `symbol.native` never enforces arity.)
          let fmtValue: unknown;
          let rest: unknown[];
          // provInputs — the values whose lineage the fresh string inherits: the fmt
          // string + every arg (the `#f` destination carries no data, so it's excluded).
          let provInputs: unknown[];

          if (isStringLike(head)) {
            fmtValue = head;
            rest = tail;
            provInputs = [head, ...tail];
          } else if (isHashF(head)) {
            if (tail.length === 0 || !isStringLike(tail[0])) {
              throw new FormatError("format: (format #f fmt arg ...) needs a format string as its second argument", []);
            }
            fmtValue = tail[0];
            rest = tail.slice(1);
            provInputs = tail;
          } else if (head === undefined) {
            throw new FormatError("format: expected a format string (SRFI-28: (format fmt arg ...))", []);
          } else {
            throw new FormatError(`format: ${DEST_REASON}`, []);
          }

          const fmt = stringValue(fmtValue);

          // ── Walk the format string, filling directives from `rest` ─────────────
          let out = "";
          let argi = 0;
          const nextArg = (directive: string): unknown => {
            if (argi >= rest.length) {
              throw new FormatError(
                `format: too few arguments for "${fmt}" — the ${directive} directive has no argument to consume`,
                [],
              );
            }
            return rest[argi++];
          };

          for (let i = 0; i < fmt.length; i++) {
            const ch = fmt[i];
            if (ch !== "~") {
              out += ch;
              continue;
            }
            if (i + 1 >= fmt.length) {
              throw new FormatError(
                `format: dangling ~ at the end of "${fmt}" — a ~ must be followed by a directive (${SUPPORTED})`,
                [],
              );
            }
            // ── ~F / ~w,dF — SRFI-48's fixed-point directive family, a BOUNDED subset:
            // an optional width, an optional `,decimals`, then a case-insensitive `f`/`F`
            // — enough to cover `~,2f`, the CL-style habit models reach for right after
            // ~a/~s/~d (MCP-Atlas error-corpus `format-unknown-directive:~,` class). Tried
            // BEFORE the single-char switch below because the directive is multi-char
            // (digits + comma), unlike every other directive here. The rest of SRFI-48
            // (~r/~t/~c/~p, column directives, port-backed padding chars) is intentionally
            // NOT implemented — see the module header's scope-narrowing note.
            const fixedPoint = /^(\d*)(?:,(\d*))?f/i.exec(fmt.slice(i + 1));
            if (fixedPoint) {
              const [directiveText, widthStr, decimalsStr] = fixedPoint;
              const width = widthStr ? Number.parseInt(widthStr, 10) : undefined;
              const decimals = decimalsStr ? Number.parseInt(decimalsStr, 10) : undefined;
              const n = nextArg(`~${directiveText}`);
              if (!isSchemeNumber(n)) {
                throw new FormatError(
                  `format: the ~${directiveText} directive expects a number, got ${displayOf(n)}`,
                  [],
                );
              }
              const num = typeof n === "number" ? n : Number((n as { valueOf(): number | bigint }).valueOf());
              let rendered = decimals === undefined ? String(num) : num.toFixed(decimals);
              if (width !== undefined && rendered.length < width) {
                rendered = " ".repeat(width - rendered.length) + rendered;
              }
              out += rendered;
              i += directiveText.length;
              continue;
            }

            const d = fmt[++i];
            switch (d) {
              case "a":
              case "A":
                out += displayOf(nextArg("~a"));
                break;
              case "s":
              case "S":
                out += writeOf(nextArg("~s"));
                break;
              case "d":
              case "D": {
                const n = nextArg("~d");
                if (!isSchemeNumber(n)) {
                  throw new FormatError(`format: the ~d directive expects a number, got ${displayOf(n)}`, []);
                }
                out += displayOf(n);
                break;
              }
              case "%":
                out += "\n";
                break;
              case "~":
                out += "~";
                break;
              default:
                throw new FormatError(
                  `format: unknown directive ~${d} in "${fmt}" — supported directives are ${SUPPORTED}` +
                    ` — nearest form: numbers use ~d (integer) or ~F / ~w,dF (fixed-point); text uses ~a (display) or ~s (write)`,
                  [],
                );
            }
          }

          if (argi < rest.length) {
            throw new FormatError(
              `format: too many arguments for "${fmt}" — ${rest.length} given, ${argi} consumed by directives`,
              [],
            );
          }

          // Collapsing op: re-stamp the DEEP union of the fmt string + every arg's lineage.
          return taintString(out, collapseProvenance(...provInputs));
        },
      ),
  }),
});
