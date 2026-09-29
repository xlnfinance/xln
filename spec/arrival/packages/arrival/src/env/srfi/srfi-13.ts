// SRFI-13 — string library completion. Sole definition site (base-packs via allSrfi).
//
// Completes the grain scheme/strings starts (case trio + R7RS string core):
// string-contains / string-contains?, predicates, slices, trim/pad, index/count,
// join/tokenize, plus SRFI-152 string-split (most-reached missing name).
// implement-or-door for the rest.
//
// Scope vs full SRFI-13:
//   • criteria = CHAR or 1-arg PREDICATE (no char-sets; SRFI-14 doored in srfi-stubs)
//   • no optional start/end (slice with substring first)
//   • remaining official exports doored here; R7RS mutators doored in scheme/strings
//
// deferred: z.list(z.string) — join/tokenize/split carry author-asserted type: over
// z.schemeValue until scheme-zod grows element-typed lists.
//
// Provenance: derived counts stamp withInputProvenance; join deep-unions via
// taintString(collapseProvenance); split/tokenize taint each piece from the source.

import invariant from "tiny-invariant";
import dedent from "dedent";
import { type } from "../../membrane/typecheck.js";
import { type RunContext } from "../../run/RunContext.js";
import { ACallable, applyCallback } from "../../values/primitives/ACallable.js";
import { type CallCtx, makeCallCtx } from "../../run/CallCtx.js";
import { EnvCapability } from "../../common/capability.js";
import {
  assertAllocatable,
  charValue,
  schemeBool,
  stringValue,
  toIndex,
  withInputProvenance,
} from "../../values/op-helpers.js";
import { type ABool } from "../../values/primitives/ABool.js";
import { collapseProvenance, taintString } from "../../provenance/provenance-collapse.js";
import { AString } from "../../values/primitives/AString.js";
import { AExact } from "../../values/primitives/AExact.js";
import { APair } from "../../values/primitives/APair.js";
import { nil } from "../../values/primitives/ANil.js";
import { ACharacter } from "../../values/primitives/ACharacter.js";
import { is_false, is_promise } from "../../values/value-guards.js";
import { promise_all } from "../../utils/promises.js";
import { to_array } from "../pack-helpers.js";
import type { AListAlike } from "../../values/types.js";

// ── implement-or-door inventory (official SRFI-13 names not live in this pack) ─
// R7RS peers (scheme/strings) cover string?/make-string/string/length/ref/append/
// list conversion/copy/map/for-each/upcase/downcase + mutator doors.
const PURITY =
  "every value is frozen by design — mutating a string after construction would falsify the provenance lineage it carries; construct a new string instead";
const SHARED =
  "shared-text substrings are not part of this sandbox — strings are independent values; use string-copy / substring / string-append / string-concatenate pure twins";
const START_END =
  "optional start/end parse helpers are omitted — arrival's SRFI-13 ops take whole strings; slice first with substring / string-copy";
const KMP = "low-level KMP search machinery is not shipped; use string-contains / string-index";
const CMP =
  "SRFI-13 comparison names without ? are not bound — use R7RS string=? / string<? / string-ci=? family (scheme/strings + equality)";
const SUBSET =
  "not in the shipped SRFI-13 pure subset (no char-sets, no start/end, agent grain); compose from string->list / filter / list->string / substring / string-append or the live SRFI-13 verbs";

const DOORS = {
  // purity — SRFI-13-only mutators (R7RS string-set!/fill!/copy! already in scheme/strings)
  "string-reverse!": `${PURITY}; use string-reverse`,
  "string-titlecase!": `${PURITY}; use string-titlecase once live, or pure case maps`,
  "string-upcase!": `${PURITY}; use string-upcase`,
  "string-downcase!": `${PURITY}; use string-downcase`,
  "string-map!": `${PURITY}; use string-map`,
  "string-xcopy!": `${PURITY}; use xsubstring / substring + string-append`,

  // shared storage
  "substring/shared": SHARED,
  "string-concatenate/shared": SHARED,
  "string-append/shared": SHARED,
  "string-concatenate-reverse/shared": SHARED,

  // start/end parse internals
  "string-parse-start+end": START_END,
  "string-parse-final-start+end": START_END,
  "let-string-start+end": START_END,
  "check-substring-spec": START_END,
  "substring-spec-ok?": START_END,

  // KMP internals
  "make-kmp-restart-vector": KMP,
  "kmp-step": KMP,
  "string-kmp-partial-search": KMP,

  // SRFI comparison names (R7RS uses string=? etc.)
  "string-compare": "multi-return / continuation-style compare is doored; use string=? / string<? / string-ci=?",
  "string-compare-ci": "multi-return / continuation-style ci-compare is doored; use string-ci=? / string-ci<?",
  "string<>": CMP,
  "string=": CMP,
  "string<": CMP,
  "string>": CMP,
  "string<=": CMP,
  "string>=": CMP,
  "string-ci<>": CMP,
  "string-ci=": CMP,
  "string-ci<": CMP,
  "string-ci>": CMP,
  "string-ci<=": CMP,
  "string-ci>=": CMP,
  "string-hash": "string hash keys not shipped; use an explicit key / dict path, not a hash of the text",
  "string-hash-ci": "string hash keys not shipped; use an explicit key / dict path",

  // pure not-yet-in-subset (compositional redirects where cheap)
  "string-every": SUBSET,
  "string-any": SUBSET,
  "string-tabulate": SUBSET,
  "reverse-list->string": `${SUBSET}; or (list->string (reverse chars))`,
  "string-index-right": SUBSET,
  "string-skip": SUBSET,
  "string-skip-right": SUBSET,
  "string-contains-ci": `${SUBSET}; or lowercase both sides then string-contains`,
  "string-prefix-length": SUBSET,
  "string-suffix-length": SUBSET,
  "string-prefix-length-ci": SUBSET,
  "string-suffix-length-ci": SUBSET,
  "string-prefix-ci?": `${SUBSET}; or string-prefix? after foldcase`,
  "string-suffix-ci?": `${SUBSET}; or string-suffix? after foldcase`,
  "string-titlecase": SUBSET,
  "string-concatenate": `${SUBSET}; or (apply string-append list-of-strings)`,
  "string-concatenate-reverse": `${SUBSET}; or concatenate of reverse`,
  "string-fold": SUBSET,
  "string-fold-right": SUBSET,
  "string-unfold": SUBSET,
  "string-unfold-right": SUBSET,
  "string-for-each-index": SUBSET,
  xsubstring: SUBSET,
  "string-replace": SUBSET,
  "string-filter":
    "build compositionally: (list->string (filter pred (string->list s))) using filter (SRFI-1), string->list and list->string (R7RS)",
  "string-delete":
    "build compositionally: (list->string (remove pred (string->list s))) using remove (SRFI-1), string->list and list->string (R7RS)",
} as const satisfies Record<string, string>;

// ── criterion machinery ──────────────────────────────────────────────────────
// SRFI-13 criteria: we honestly support a CHAR (equality) or a ONE-ARG PREDICATE
// (a scheme callable, invoked exactly the way srfi-1's `find` invokes its matcher —
// truthiness is `!is_false && !is_nil`, and an async membrane callback is awaited).
// SRFI-13 char-sets are NOT supported (no charset type here).

const isWhitespace = (c: string): boolean => /\s/u.test(c);

/** Per-character match flags for a criterion; a promise when the predicate is async.
 * `runCtx` is REQUIRED (never defaulted to CONSTANT_CTX): a user-supplied criterion
 * predicate is arbitrary scheme code, invoked through `applyCallback`'s runCtx slot —
 * a defaulted CONSTANT_CTX would run every trim/index/count/tokenize predicate
 * unmetered, off cache/effects/abort, regardless of what the invoking run actually
 * configured. Every caller below threads its own `this.runCtx`. */
function criterionFlags(
  criterion: ACallable,
  chars: readonly string[],
  runCtx: RunContext,
): boolean[] | Promise<boolean[]> {
  if (criterion instanceof ACharacter) {
    const ch = charValue(criterion);
    return chars.map((c) => c === ch);
  }
  // Seam-routed: the criterion predicate is a callable VALUE (membrane-boxed), not a bare fn.
  // No live invocation reaches this leaf (only a bare `runCtx` one hop away) — a real CallCtx
  // with invocation undefined, degraded exactly as the pre-CallCtx-threading path.
  const results = chars.map((c) => applyCallback(criterion, [new ACharacter(c)], makeCallCtx(runCtx)));
  const collapse = (rs: unknown[]) => rs.map((v) => !is_false(v)); // R7RS: only #f is false
  // pred may be an async membrane callback → await before deciding (see string-map).
  if (results.some(is_promise)) {
    return (promise_all(results) as Promise<unknown[]>).then(collapse);
  }
  return collapse(results);
}

/** Sync-or-async continuation over the flags — keeps every op's happy path synchronous. */
function afterFlags<T>(flags: boolean[] | Promise<boolean[]>, fn: (f: boolean[]) => T): T | Promise<T> {
  return is_promise(flags) ? (flags as Promise<boolean[]>).then(fn) : fn(flags as boolean[]);
}

/** Shared body of the trim trio — `side` picks which end(s) shed matching chars.
 * `function(this: CallCtx, ...)` (not an arrow) — the returned closure is bound
 * directly as a `symbol.native` impl, so dispatch delivers the live ctx via `this`
 * (capability.ts's `hostImpl.apply(makeCallCtx(runCtx), args)`); threaded into
 * `criterionFlags` (a user predicate must observe the run's real ctx) and into the
 * result mint below. */
function trimImpl(name: string, side: "both" | "left" | "right") {
  return function (this: CallCtx, str: AString, criterion?: ACallable): AString | Promise<AString> {
    const chars = [...stringValue(str)];
    const runCtx = this.runCtx;
    // Default criterion: whitespace (SRFI-13's char-set:whitespace, sans charsets).
    const flags = criterion === undefined ? chars.map(isWhitespace) : criterionFlags(criterion, chars, runCtx);
    return afterFlags(flags, (f) => {
      let start = 0;
      let end = chars.length;
      if (side !== "right") while (start < end && f[start]) start++;
      if (side !== "left") while (end > start && f[end - 1]) end--;
      // A trim is a slice — same lineage rule as string-copy (the criterion shapes
      // the slice, but a char criterion is still a value input; include it).
      return withInputProvenance(
        criterion === undefined ? [str] : [str, criterion],
        new AString(chars.slice(start, end).join("")),
      );
    });
  };
}

/** Shared body of take/drop and their -right twins — n out of range is an error (SRFI-13).
 * `function(this: CallCtx, ...)` (not an arrow) — same dispatch-`this` reasoning as
 * `trimImpl` above. */
function sliceImpl(name: string, pick: (chars: string[], k: number) => string[]) {
  return function (this: CallCtx, str: unknown, n: unknown): AString {
    const chars = [...stringValue(str)];
    const k = toIndex(n);
    invariant(
      Number.isInteger(k) && k >= 0 && k <= chars.length,
      `${name}: index ${k} out of range for a string of length ${chars.length}`,
    );
    // A slice — same lineage rule as string-copy (n shapes the slice, no meaning of its own).
    return withInputProvenance([str], new AString(pick(chars, k).join("")));
  };
}

export default EnvCapability.define("scheme/srfi-13", {
  symbols: (symbol, z) => ({
    "string-null?": symbol.native`string-null?: #t iff the string is empty (SRFI-13)`(
      { input: [z.string], output: [z.boolean] },
      function (this: CallCtx, str): ABool {
        return withInputProvenance([str], schemeBool(stringValue(str).length === 0));
      },
    ),

    // SRFI-13 argument order: the AFFIX comes first — (string-prefix? prefix s).
    "string-prefix?": symbol.native`string-prefix?: #t iff s starts with prefix — (string-prefix? prefix s) (SRFI-13)`(
      { input: [z.string, z.string], output: [z.boolean] },
      function (this: CallCtx, prefix, str): ABool {
        return withInputProvenance([prefix, str], schemeBool(stringValue(str).startsWith(stringValue(prefix))));
      },
    ),

    "string-suffix?": symbol.native`string-suffix?: #t iff s ends with suffix — (string-suffix? suffix s) (SRFI-13)`(
      { input: [z.string, z.string], output: [z.boolean] },
      function (this: CallCtx, suffix, str): ABool {
        return withInputProvenance([suffix, str], schemeBool(stringValue(str).endsWith(stringValue(suffix))));
      },
    ),

    // Index-or-#f, like string-contains (#f is the ONLY false value — index 0 is truthy).
    "string-index":
      symbol.native`string-index: index of the first char matching a char or one-arg predicate, or #f (SRFI-13; no charsets)`(
        {
          input: [z.string, z.lambda],
          output: [z.union([z.exact, z.boolean])],
          type: dedent`
          {
            (s: string, criterion: string | ((c: string) => unknown)): number | false;
          }
        `,
        },
        function (this: CallCtx, str, criterion): AExact | ABool | Promise<AExact | ABool> {
          const chars = [...stringValue(str)];
          return afterFlags(criterionFlags(criterion, chars, this.runCtx), (f) => {
            const i = f.indexOf(true);
            return withInputProvenance([str, criterion], i === -1 ? schemeBool(false) : new AExact(i));
          });
        },
      ),

    "string-count":
      symbol.native`string-count: how many chars match a char or one-arg predicate (SRFI-13; no charsets)`(
        {
          input: [z.string, z.lambda],
          output: [z.exact],
          type: dedent`
          {
            (s: string, criterion: string | ((c: string) => unknown)): number;
          }
        `,
        },
        function (this: CallCtx, str, criterion): AExact | Promise<AExact> {
          const chars = [...stringValue(str)];
          const runCtx = this.runCtx;
          return afterFlags(criterionFlags(criterion, chars, runCtx), (f) => {
            const n = f.reduce((acc, hit) => acc + (hit ? 1 : 0), 0);
            return withInputProvenance([str, criterion], new AExact(n));
          });
        },
      ),

    "string-take":
      symbol.native`string-take: the first n characters of the string; n out of range is an error (SRFI-13)`(
        {
          input: [z.string, z.schemeNumber],
          output: [z.string],
          type: dedent`
          {
            (s: string, n: number): string;
          }
        `,
        },
        sliceImpl("string-take", (chars, k) => chars.slice(0, k)),
      ),

    "string-drop":
      symbol.native`string-drop: the string without its first n characters; n out of range is an error (SRFI-13)`(
        {
          input: [z.string, z.schemeNumber],
          output: [z.string],
          type: dedent`
          {
            (s: string, n: number): string;
          }
        `,
        },
        sliceImpl("string-drop", (chars, k) => chars.slice(k)),
      ),

    "string-take-right":
      symbol.native`string-take-right: the last n characters of the string; n out of range is an error (SRFI-13)`(
        {
          input: [z.string, z.schemeNumber],
          output: [z.string],
          type: dedent`
          {
            (s: string, n: number): string;
          }
        `,
        },
        sliceImpl("string-take-right", (chars, k) => chars.slice(chars.length - k)),
      ),

    "string-drop-right":
      symbol.native`string-drop-right: the string without its last n characters; n out of range is an error (SRFI-13)`(
        {
          input: [z.string, z.schemeNumber],
          output: [z.string],
          type: dedent`
          {
            (s: string, n: number): string;
          }
        `,
        },
        sliceImpl("string-drop-right", (chars, k) => chars.slice(0, chars.length - k)),
      ),

    // Official SRFI-13: string-trim = LEFT only; string-trim-both = both ends.
    // string-trim-left is a non-index synonym of official left trim (compat).
    "string-trim":
      symbol.native`string-trim: the left end shed of whitespace, or of chars matching a char/one-arg predicate (SRFI-13; no charsets)`(
        { input: [z.string, z.lambda.optional()], output: [z.string] },
        trimImpl("string-trim", "left"),
      ),

    "string-trim-both":
      symbol.native`string-trim-both: both ends shed of whitespace, or of chars matching a char/one-arg predicate (SRFI-13; no charsets)`(
        { input: [z.string, z.lambda.optional()], output: [z.string] },
        trimImpl("string-trim-both", "both"),
      ),

    "string-trim-left": symbol.alias`string-trim`,

    "string-trim-right":
      symbol.native`string-trim-right: the right end shed of whitespace, or of chars matching a char/one-arg predicate (SRFI-13; no charsets)`(
        { input: [z.string, z.lambda.optional()], output: [z.string] },
        trimImpl("string-trim-right", "right"),
      ),

    // SRFI-13 pads to EXACTLY len: `string-pad` right-justifies (pads on the left,
    // TRUNCATES from the left when too long — keeps the string's tail);
    // `string-pad-right` left-justifies (pads/truncates on the right).
    "string-pad":
      symbol.native`string-pad: right-justified to exactly len — pads on the left with char (default space), truncates from the left when too long (SRFI-13)`(
        { input: [z.string, z.schemeNumber, z.char.optional()], output: [z.string] },
        function (this: CallCtx, str, len, char): AString {
          const chars = [...stringValue(str)];
          const k = toIndex(len);
          // O(1) cap check BEFORE `.repeat` allocates — see assertAllocatable.
          assertAllocatable(k, "string-pad");
          const fill = char === undefined ? " " : charValue(char);
          const text =
            chars.length >= k ? chars.slice(chars.length - k).join("") : fill.repeat(k - chars.length) + chars.join("");
          // Like make-string: a present fill char contributes lineage; the length shapes only.
          return withInputProvenance(char === undefined ? [str] : [str, char], new AString(text));
        },
      ),

    "string-pad-right":
      symbol.native`string-pad-right: left-justified to exactly len — pads on the right with char (default space), truncates on the right when too long (SRFI-13)`(
        { input: [z.string, z.schemeNumber, z.char.optional()], output: [z.string] },
        function (this: CallCtx, str, len, char): AString {
          const chars = [...stringValue(str)];
          const k = toIndex(len);
          assertAllocatable(k, "string-pad-right");
          const fill = char === undefined ? " " : charValue(char);
          const text = chars.length >= k ? chars.slice(0, k).join("") : chars.join("") + fill.repeat(k - chars.length);
          return withInputProvenance(char === undefined ? [str] : [str, char], new AString(text));
        },
      ),

    "string-reverse": symbol.native`string-reverse: a reversed copy of the string (SRFI-13)`(
      { input: [z.string], output: [z.string] },
      function (this: CallCtx, str): AString {
        return withInputProvenance([str], new AString([...stringValue(str)].toReversed().join("")));
      },
    ),

    // Substring search (SRFI-13). Index-or-#f: #f is the ONLY false value in Scheme,
    // so index 0 is truthy and `(if (string-contains h n) …)` reads naturally.
    // `string-contains?` is the boolean-predicate twin. Both stamp the lineage of
    // the strings they searched.
    "string-contains": symbol.native`string-contains: index of the first occurrence of sub, or #f (SRFI-13)`(
      { input: [z.string, z.string], output: [z.union([z.exact, z.boolean])] },
      function (this: CallCtx, str, sub) {
        const i = stringValue(str).indexOf(stringValue(sub));
        return withInputProvenance([str, sub], i === -1 ? schemeBool(false) : new AExact(i));
      },
    ),

    "string-contains?": symbol.native`string-contains?: #t iff str contains sub (SRFI-13)`(
      { input: [z.string, z.string], output: [z.boolean] },
      function (this: CallCtx, str, sub) {
        return withInputProvenance([str, sub], schemeBool(stringValue(str).includes(stringValue(sub))));
      },
    ),

    "string-join":
      symbol.native`string-join: the list of strings folded to one with a delimiter (default single space) (SRFI-13)`(
        {
          input: [z.listAlike, z.string.optional()],
          output: [z.union([z.string, z.string])],
          // scheme-zod has no element-typed list schema, so the list input is `z.schemeValue` (→ `unknown`)
          // and the output union images to the redundant `string | string`. Author-assert what the
          // impl proves by eye: it `to_array`s the input and typechecks each element is a string, and
          // folds to one string. `List<string>` (carriers.ts vocabulary) is the honest, informative image.
          type: "(list: List<string>, delimiter?: string) => string",
        },
        function (this: CallCtx, list, delimiter) {
          const parts = to_array("string-join")(list);
          const sep = delimiter === undefined ? " " : stringValue(delimiter);
          // Collapsing op: fold the list to one string, then re-stamp the DEEP union of
          // every element's lineage (+ the delimiter's) — see string-append.
          return taintString(parts.map(stringValue).join(sep), collapseProvenance(list, delimiter));
        },
      ),

    // NOTE the inversion vs trim: tokenize's criterion selects TOKEN chars (what to
    // KEEP), trim's selects what to SHED. Default: maximal non-whitespace runs.
    "string-tokenize":
      symbol.native`string-tokenize: the list of maximal runs of token chars — default non-whitespace, or chars matching a char/one-arg predicate (SRFI-13; no charsets)`(
        {
          input: [z.string, z.lambda.optional()],
          output: [z.schemeValue],
          // Output `z.schemeValue` images to `unknown`, but the impl `APair.fromArray`s the tokens — it
          // returns a proper list of token strings. Author-assert `List<string>`. criterion stays
          // `unknown` (a char OR a one-arg predicate — a char's `string` image would misread as "a
          // whole string"; the docstring teaches the domain), matching the sibling trim/index ops.
          type: "(str: string, criterion?: unknown) => List<string>",
        },
        function (this: CallCtx, str, criterion): AListAlike | Promise<AListAlike> {
          const chars = [...stringValue(str)];
          const runCtx = this.runCtx;
          const flags =
            criterion === undefined ? chars.map((c) => !isWhitespace(c)) : criterionFlags(criterion, chars, runCtx);
          return afterFlags(flags, (f) => {
            // Splitting op: each token is a fresh derived string — taint each with the
            // source's lineage so list elements stay grounded (cf. string-split below).
            const prov = collapseProvenance(str, criterion);
            // Only `taintString` (always an AString) is ever pushed below — narrow off the
            // unused raw-`string` arm so `APair.fromArray` sees the honest `SchemeValue[]`.
            const tokens: AString[] = [];
            let current = "";
            for (const [i, char] of chars.entries()) {
              if (f[i]) {
                current += char;
              } else if (current !== "") {
                tokens.push(taintString(current, prov));
                current = "";
              }
            }
            if (current !== "") tokens.push(taintString(current, prov));
            return APair.fromArray(runCtx, tokens);
          });
        },
      ),

    // SRFI-152 (NOT SRFI-13 — string-split is absent there); bound in this pack anyway
    // because it is the #1 symbol models reach for after seeing string-contains.
    //
    // DIALECT PRECEDENT: Gauche, Guile, and MIT/GNU Scheme all accept a single
    // CHARACTER delimiter here (`(string-split "a,b,c" #\,)`), not just a string —
    // it is the idiom a model trained on those dialects reaches for by reflex, and
    // an MCP-Atlas error-corpus autopsy found it as a 9x-rate, cascade-seeding class
    // (`invariant-type-mismatch:string-split:expected-string-got-character`). Rather
    // than teach the string-only form, complete the grain: accept a character
    // delimiter, coerced to the single-char string it denotes — string-only
    // behavior (including the empty-subject/empty-list rule below) is unchanged.
    "string-split":
      symbol.native`string-split: the list of the string's pieces around a literal delimiter — a string, or a single character (Gauche/Guile/MIT accept a char delimiter too); empty string yields '() (SRFI-152)`(
        {
          input: [z.string, z.union([z.string, z.char])],
          output: [z.schemeValue],
          // Output `z.schemeValue` images to `unknown`, but the impl `APair.fromArray`s the pieces — a proper
          // list of strings (`List<string>`). The `string | char` delimiter images to the redundant
          // `string | string` (string and schemeChar both print `string`); the honest image is a
          // single `string` delimiter. Both recovered by the author assertion.
          type: "(str: string, delimiter: string) => List<string>",
        },
        function (this: CallCtx, str, delimiter) {
          const s = stringValue(str);
          // SRFI-152 refinement over plain JS `.split`: an empty subject is NO fields.
          if (s === "") return nil;
          // `symbol.native` contracts are TYPE-ONLY — never validated at runtime (native
          // doctrine: no codec, no validation). `stringValue`'s fallback (`String(x)`) would
          // silently coerce a non-string/char delimiter to SOME string instead of erroring, so
          // the type-mismatch door needs an explicit guard here.
          invariant(
            delimiter instanceof AString || delimiter instanceof ACharacter,
            () => `string-split: delimiter must be a string or character, got ${type(delimiter)}`,
          );
          const delimiterStr = delimiter instanceof ACharacter ? charValue(delimiter) : stringValue(delimiter);
          const prov = collapseProvenance(str, delimiter);
          return APair.fromArray(
            this.runCtx,
            s.split(delimiterStr).map((piece) => taintString(piece, prov)),
          );
        },
      ),

    // Official SRFI-13 names not live above — purity / subset doors (see DOORS).
    // string-filter lives here so the pack owns the full index.
    ...Object.fromEntries(
      Object.entries(DOORS).map(([name, reason]) => [name, symbol.notImplemented`${name}: ${reason}`]),
    ),
  }),
});
