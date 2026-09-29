// Chibi harness v2 — registries.ts (docs/test-suite-architecture.md F4).
//
// Typed rule tables replacing v1's substring/regex matching over stringified test names
// (`chibi-r7rs.spec.ts:80-338`). A rule matches a `TestStep` by:
//   - `symbols`  — the step's datum references ANY of the given identifiers, ANYWHERE in its
//                  tree (recursive; see `datumSymbols`). Exact string membership, never a
//                  substring/regex — a hyphenated compound (`list-tail`) never collides with a
//                  bare token (`tail`), which is exactly the class of over-match v1's regexes
//                  risked (`\bport\b` matching inside `output-port`, etc.).
//   - `form`     — the step's whitespace-normalized exact text equals the given string. Reserved
//                  for one-off rows where no identifier in the form is safely unique (common
//                  short names like `bar`/`ff`/`tail`/`=>` are reused across unrelated tests
//                  elsewhere in the corpus — verified by grep against r7rs-tests.scm, not
//                  assumed).
//   - `section`  — the step's `sectionPath` includes the given name (mirrors v1's
//                  `EXCLUDED_GROUPS`).
//
// Precedence: excluded > expected-failure > staged > run (§4). Every `ExpectedFailure` carries
// a `gate` — either the plan/issue that closes it, or an honest "permanent" note for the two
// rows that are IEEE-754 floor effects, not gaps.
//
// Transcription notes (deviations from v1, each deliberate):
//   - v1's `(real? -2.5)` EXPECTED_FAILURE no longer matches: the corpus's real? tests now use
//     genuine complex literals (`-2.5+0i`, `-2.5+0.0i`), which door at READ time (arrival omits
//     the complex tower) and become `unreadable` steps — never reaching a TestStep at all.
//     Dropped rather than carried as a guaranteed-dead rule.
//   - v1's `/set-cdr!.*ls1/` (excluding two cyclic-list tests "for lack of cycle-detection
//     support") is SUPERSEDED by the general `set-cdr!` purity ExpectedFailure below — those
//     tests call `set-cdr!` directly, which doors on purity grounds regardless of cycle
//     support, a more accurate root cause. Not transcribed as its own rule.
//   - v1's `"(define-syntax swap!"` IS real (line 660-670: a `(test '(2 1) (let (…) (define-syntax
//     swap! …) (swap! x y) (list x y)))` standalone test) — transcribed via the `swap!`
//     identifier (verified unique to this one test).
import type { Manifest, TestStep } from "./manifest.js";
import { normalizeText } from "./manifest.js";

export type Matcher =
  | { kind: "symbols"; anyOf: readonly string[] }
  | { kind: "form"; exact: string }
  | { kind: "section"; name: string };

export interface Exclusion {
  match: Matcher;
  feature: string;
  note?: string;
}

export interface ExpectedFailure {
  match: Matcher;
  reason: string;
  gate: string;
  maxMatches?: number;
}

export interface Staged {
  match: Matcher;
  spec: string;
}

export type Verdict =
  | { run: "it" }
  | { run: "skip"; feature: string }
  | { run: "fails"; reason: string; gate: string }
  | { run: "todo"; spec: string };

function matchesRule(match: Matcher, step: TestStep): boolean {
  switch (match.kind) {
    case "symbols":
      return match.anyOf.some((name) => step.symbols.has(name));
    case "form":
      return normalizeText(step.text) === match.exact;
    case "section":
      return step.sectionPath.includes(match.name);
  }
}

// ── EXCLUDED — features omitted by design (§11.2 point 2: substring rules → symbols matchers
//    where the substring was an identifier, form matchers where it was a one-off snippet). ────

export const EXCLUDED: readonly Exclusion[] = [
  {
    match: {
      kind: "symbols",
      anyOf: [
        "port?",
        "input-port?",
        "output-port?",
        "textual-port?",
        "binary-port?",
        "input-port-open?",
        "output-port-open?",
        "close-port",
        "close-input-port",
        "close-output-port",
        "current-input-port",
        "current-output-port",
        "current-error-port",
        "open-input-string",
        "open-output-string",
        "get-output-string",
        "open-input-bytevector",
        "open-output-bytevector",
        "get-output-bytevector",
        "open-input-file",
        "open-output-file",
        "with-input-from-file",
        "with-output-to-file",
        "call-with-input-file",
        "call-with-output-file",
        "call-with-port",
        "eof-object",
        "eof-object?",
        "peek-char",
        "read-char",
        "read-line",
        "read-string",
        "read-u8",
        "read-bytevector",
        "read-bytevector!",
        "char-ready?",
        "u8-ready?",
        "write-char",
        "write-string",
        "write-u8",
        "write-bytevector",
        "write-simple",
        "write-shared",
        "write",
        "display",
        "newline",
        "flush-output-port",
        "read",
      ],
    },
    feature: "ports & I/O (R7RS §6.13) — sandbox has no port/file I/O",
  },
  {
    match: { kind: "symbols", anyOf: ["file-exists?", "delete-file", "load"] },
    feature: "filesystem / load (R7RS §6.14) — sandbox omits (r7rs/host.ts doors)",
  },
  // Block-member symbol-visibility gap (manifest.ts blockMembers): each of these 5 is a
  // `(let* ((out (open-output-string)) (value …)) (test … (get-output-string out)) (test …
  // value))` block (r7rs-tests.scm §6.11, the SRFI-34 with-exception-handler examples) —
  // the `value`-only companion test doesn't itself reference `open-output-string`/
  // `get-output-string` (that's in the block's OWN binding head), so the ports Exclusion
  // above never sees it. The sibling test in each pair (which DOES mention
  // `get-output-string` directly) is already caught correctly.
  {
    match: { kind: "form", exact: normalizeText(`(test 65 value)`) },
    feature: "ports & I/O (R7RS §6.13) — sandbox has no port/file I/O",
    note: "block-member symbol-visibility gap: `out`/`value` come from `open-output-string` in the enclosing `let*`, not this test's own datum",
  },
  {
    match: { kind: "form", exact: normalizeText(`(test 'exception value)`) },
    feature: "ports & I/O (R7RS §6.13) — sandbox has no port/file I/O",
    note: "same block-member symbol-visibility gap as the row above",
  },
  {
    match: { kind: "form", exact: normalizeText(`(test 'positive value)`) },
    feature: "ports & I/O (R7RS §6.13) — sandbox has no port/file I/O",
    note: "same block-member symbol-visibility gap as the row above",
  },
  {
    match: { kind: "form", exact: normalizeText(`(test 'negative value)`) },
    feature: "ports & I/O (R7RS §6.13) — sandbox has no port/file I/O",
    note: "same block-member symbol-visibility gap as the row above",
  },
  {
    match: { kind: "form", exact: normalizeText(`(test 'zero value)`) },
    feature: "ports & I/O (R7RS §6.13) — sandbox has no port/file I/O",
    note: "same block-member symbol-visibility gap as the row above",
  },
  {
    match: {
      kind: "symbols",
      anyOf: ["command-line", "exit", "emergency-exit", "get-environment-variable", "get-environment-variables"],
    },
    feature: "process/system (R7RS §6.14) — sandbox omits",
  },
  {
    match: { kind: "symbols", anyOf: ["call-with-current-continuation", "call/cc", "dynamic-wind"] },
    feature: "call/cc / dynamic-wind — not implemented (sandbox design decision)",
  },
  {
    match: { kind: "symbols", anyOf: ["list-length"] },
    feature: "uses call/cc internally (list-length's own reference impl) — sandbox omits continuations",
    note: "the test forms reference `list-length` itself, not call/cc directly — matched by its own name",
  },
  {
    match: { kind: "symbols", anyOf: ["test-exception-handler-1", "something-went-wrong"] },
    feature:
      "helper (test-exception-handler-1) defined via call-with-current-continuation — sandbox omits continuations",
    note: "sibling test-exception-handler-2 uses `guard` instead and is NOT excluded — matches v1",
  },
  // square / exact-integer-sqrt / rationalize are implemented in r7rs/numeric (product pair
  // for isqrt). Cascade form exclusions below still skip chibi rows that bind via let*-values
  // (multi-return binder is purity-doored).
  {
    match: { kind: "form", exact: normalizeText(`(test 35 (* root rem))`) },
    feature: "exact-integer-sqrt product used via let*-values (multi-return binder doored) — cascading",
    note: "block-member symbol-visibility gap; isqrt itself is implemented as (s . r) pair",
  },
  {
    match: { kind: "form", exact: normalizeText(`(test 0 rem)`) },
    feature: "exact-integer-sqrt product used via let*-values (multi-return binder doored) — cascading",
    note: "same block-member gap as the row above",
  },
  {
    match: { kind: "form", exact: normalizeText(`(test (expt 2 140) (square root))`) },
    feature: "exact-integer-sqrt product used via let*-values (multi-return binder doored) — cascading",
    note: "2^140 block sibling of (test 0 rem); root unbound when let*-values is doored",
  },
  // (means ton) (r7rs-tests.scm:182-198, "4.2 Derived expression types") returns its three
  // Pythagorean-mean-style results via `(values …)`; the immediately-following block
  // (line 199) destructures them with `(let*-values (((a b c) (means …))) (test 27 a) …)`.
  // let*-values doors (multi-return, R7RS §6.10 omitted by design) WITHOUT throwing at the
  // binder head itself — verified directly (chibi-r7rs-v2.spec.ts run): the block aborts
  // with "Unbound variable `a'" (not a notImplemented door message), i.e. the doored binder
  // never introduces a/b/c, and the block's first body form is the one that discovers this.
  // Same block-member symbol-visibility gap as the exact-integer-sqrt trio directly above:
  // each member's OWN datum is just `(test N a)`/`(test N b)`/`(test N c)` — the enclosing
  // `let*-values`/`values`/`means` tokens live only in the BLOCK's own head, invisible to
  // `datumSymbols` on the individual member — so the general multi-values rule below can't
  // catch these three, and they need their own cascade rows.
  {
    match: { kind: "form", exact: normalizeText(`(test 27 a)`) },
    feature: "means's (values …) result destructured via let*-values (multi-return binder doored) — cascading",
    note: "block-member symbol-visibility gap; means/values/let*-values are in the block's own head, not this member's datum",
  },
  {
    match: { kind: "form", exact: normalizeText(`(test 9.728 b)`) },
    feature: "means's (values …) result destructured via let*-values (multi-return binder doored) — cascading",
    note: "same block-member gap as (test 27 a) above",
  },
  {
    match: { kind: "form", exact: normalizeText(`(test 1800/497 c)`) },
    feature: "means's (values …) result destructured via let*-values (multi-return binder doored) — cascading",
    note: "same block-member gap as (test 27 a) above",
  },
  {
    match: {
      kind: "symbols",
      anyOf: ["let-values", "let*-values", "call-with-values", "values", "define-values", "receive"],
    },
    feature: "multiple values (R7RS §6.10 / SRFI-8) — omitted by design (continuation family)",
  },
  // NOTE: v1 also excluded "define-record-type" — dropped here rather than transcribed. It is
  // structurally DEAD as a symbols-Exclusion: `define-record-type` only ever heads a `setup`
  // step (never a TestStep), so it can never match a manifest.tests row and would permanently
  // trip the dead-rule alarm. The corpus's downstream accessor tests (kons/kar/pare?/set-kar!,
  // r7rs-tests.scm:675-686) use corpus-chosen names not enumerable as a general rule — expected
  // to surface as genuine red, a follow-up triage item, not a harness gap.
  {
    match: {
      kind: "symbols",
      anyOf: ["make-rectangular", "make-polar", "real-part", "imag-part", "magnitude", "angle", "complex?"],
    },
    feature: "complex tower (R7RS §6.2.3 omitted)",
    note:
      "the complex LITERAL case doors at read time (an `unreadable` manifest step, handled " +
      "separately in the spec) — this rule covers the ACCESSOR/constructor calls (door at eval) " +
      "and complex? (honest always-#f stub; R7RS expects #t for reals)",
  },
  {
    match: {
      kind: "symbols",
      anyOf: ["eval", "environment", "null-environment", "scheme-report-environment", "interaction-environment"],
    },
    feature: "eval/environment reification (R7RS §6.12) — doored (sandbox + reification; see r7rs/eval.ts)",
  },
  {
    match: { kind: "symbols", anyOf: ["delay", "force", "make-promise", "delay-force", "promise?"] },
    feature:
      "delayed evaluation (R7RS §4.2.5) — omitted by design (defers a value's identity to force-time, not " +
      "construction-site; see r7rs/control.ts's notImplemented doors)",
  },
  {
    match: { kind: "symbols", anyOf: ["make-parameter", "parameterize"] },
    feature:
      "dynamic bindings (R7RS §4.2.6) — omitted by design (ties identity to call-time extent, not " +
      "construction-site; see r7rs/control.ts's notImplemented doors)",
  },
  {
    match: {
      kind: "form",
      exact: normalizeText(`(test 2 (head (tail (tail integers))))`),
    },
    feature: "delayed evaluation (R7RS §4.2.5 omitted) — cascading: `integers`'s own definition uses `delay`",
    note:
      "block-member symbol-visibility gap (manifest.ts blockMembers): the SETUP form defining `integers` via " +
      "`delay` is a sibling of this test, not part of its own datum, so the `delay` Exclusion above never sees " +
      "it — reported as a harness fix design, not editable here",
  },
  {
    match: {
      kind: "form",
      exact: normalizeText(`(test 5 (head (tail (tail (stream-filter odd? integers)))))`),
    },
    feature:
      "delayed evaluation (R7RS §4.2.5 omitted) — cascading: `stream-filter`/`integers` use `delay-force`/`delay`",
    note: "same block-member symbol-visibility gap as the `integers` row above",
  },
  {
    match: { kind: "symbols", anyOf: ["any-arity", "rest-arity", "dead-clause"] },
    feature:
      "case-lambda (R7RS §4.2.9) — doored not-yet (r7rs/control.ts); cascading unbound clause names " +
      "when the setup form's case-lambda head never binds them",
  },
  {
    match: { kind: "symbols", anyOf: ["radix"] },
    feature: "dynamic bindings (R7RS §4.2.6 omitted) — cascading: `radix` is defined via the doored `make-parameter`",
  },
  {
    match: { kind: "form", exact: normalizeText(`(test "12" (f 12))`) },
    feature: "dynamic bindings (R7RS §4.2.6 omitted) — cascading: `f` calls the never-defined `radix` parameter",
    note: "block/setup symbol-visibility gap — `f`'s own definition references `radix`, not this test's datum",
  },
  {
    match: {
      kind: "symbols",
      anyOf: ["current-second", "current-jiffy", "jiffies-per-second", "features"],
    },
    feature: "process/system (R7RS §6.14) — sandbox omits (extends the command-line/exit/env-var rule above)",
  },
  {
    match: { kind: "form", exact: normalizeText(`(test #t (list? env))`) },
    feature: "process/system (R7RS §6.14) — sandbox omits `get-environment-variables`",
    note: "block-member symbol-visibility gap: `env` is bound via `get-environment-variables` in the enclosing `let`, not this test's own datum",
  },
  {
    match: { kind: "form", exact: normalizeText(`(test #t (all? env-pair? env))`) },
    feature: "process/system (R7RS §6.14) — sandbox omits `get-environment-variables`",
    note: "same block-member symbol-visibility gap as the row above",
  },
  // -----------------------------------------------------------------------
  // `define-record-type` — genuinely UNBOUND (not a notImplemented door; verified via direct
  // exec: "Unbound variable `define-record-type'"), i.e. not implemented at all. As the
  // superseded-note above (§ "5 Program structure") already anticipated: it only ever heads a
  // `setup` step, never a TestStep, so it's structurally dead as a `symbols` Exclusion; the
  // downstream accessor tests use corpus-chosen names (kons/kar/kdr/pare?/set-kar!) that
  // aren't safely enumerable as a general rule (kar/kdr in particular collide with the
  // c[ad]+r resolver-structural family). Transcribed as five `form`-exact rows instead —
  // the anticipated follow-up triage.
  // -----------------------------------------------------------------------
  {
    match: { kind: "form", exact: normalizeText(`(test #t (pare? (kons 1 2)))`) },
    feature: "define-record-type — not implemented (unbound, R7RS §5.5)",
  },
  {
    match: { kind: "form", exact: normalizeText(`(test #f (pare? (cons 1 2)))`) },
    feature: "define-record-type — not implemented (unbound, R7RS §5.5)",
  },
  {
    match: { kind: "form", exact: normalizeText(`(test 1 (kar (kons 1 2)))`) },
    feature: "define-record-type — not implemented (unbound, R7RS §5.5)",
  },
  {
    match: { kind: "form", exact: normalizeText(`(test 2 (kdr (kons 1 2)))`) },
    feature: "define-record-type — not implemented (unbound, R7RS §5.5)",
  },
  {
    match: {
      kind: "form",
      exact: normalizeText(`(test 3 (let ((k (kons 1 2)))
          (set-kar! k 3)
          (kar k)))`),
    },
    feature: "define-record-type — not implemented (unbound, R7RS §5.5)",
  },
];

// ── EXPECTED_FAILURES — documented deviations, not bugs (§11.2 point 2). ─────────────────────

export const EXPECTED_FAILURES: readonly ExpectedFailure[] = [
  // -----------------------------------------------------------------------
  // FIXED (was the DOMINANT signature, 72 rows, all of "Numeric syntax"): let*/letrec/
  // letrec*/and/or are now `symbol.keyword` bindings (core.ts), matching the existing 11 —
  // see core.ts's own comment. `test-numeric-syntax`'s syntax-rules template
  // (r7rs-tests.scm:2297-2304) expands to a literal `(let* (…) …)`; the hygienic renamer
  // (syntax-rules.ts rename()) copies a keyworded form's env value onto its gensym, so the
  // renamed head now round-trips through `evaluatePair`'s value-first dispatch instead of
  // falling to the string-keyed `SPECIAL_FORMS` table and throwing "Unbound variable
  // `Symbol(#:let*)'". Rule removed; all matched rows verified green.
  //
  // A DIFFERENT, genuinely pre-existing gap was masked underneath the let* bug and is now
  // exposed: r7rs-tests.scm's own "Numeric syntax" section REDEFINES `test-numeric-syntax`
  // at line 2297 to use real string ports (`open-input-string`/`get-output-string`) —
  // harness-capability.ts's own prelude comment already documents this as "the corpus itself
  // REDEFINES this macro later … that redefinition is executed like any other setup form and
  // will shadow this one from that point on; the resulting cascade is expected, documented
  // red". Ports (R7RS §6.13) are omitted from arrival by design (EXCLUDED's own ports rule
  // above) — but the EXCLUDED "symbols" matcher only sees identifiers in the TEST STEP'S OWN
  // datum, and every one of these 72 invocations reads literally as `(test-numeric-syntax
  // "…" …)` with no `open-input-string` token of its own (the same block-member
  // symbol-visibility gap documented elsewhere in this file for manifest.ts's blockMembers) —
  // so it needs its own expected-failure row rather than being caught by the general ports
  // exclusion. Verified: every one of the 72 rows fails with the identical
  // "open-input-string is not available" door, none for any other reason.
  // -----------------------------------------------------------------------
  {
    match: { kind: "symbols", anyOf: ["test-numeric-syntax"] },
    reason:
      "block-member symbol-visibility gap: r7rs-tests.scm's own 'Numeric syntax' section redefines " +
      "test-numeric-syntax (line 2297) to use real string ports, which arrival omits by design (R7RS §6.13, " +
      "sandbox has no port/file I/O) — the setup form's `open-input-string` reference isn't visible to this " +
      "test step's own datum, so the general ports EXCLUDED rule can't catch it",
    gate: "permanent — ports/IO omitted by design, no fix planned (harness-capability.ts prelude's own documented cascade)",
  },
  // -----------------------------------------------------------------------
  // FIXED (2026-07-14, one-number rework, docs/design-history/arrival-one-number-rework.md):
  // the row for `(test #f (= 9007199254740992.0 9007199254740993))` is DEAD, not passing —
  // `9007199254740993` (2^53 + 1) now ParseErrors at read time (RATIO's safe-int-only exact
  // literal gate, §0.3), so the form never reaches a `TestStep` at all; it's a `registerUnreadable`
  // row now (chibi-r7rs-v2.spec.ts), like the complex-literal precedent this file's header
  // already documents for `(real? -2.5+0i)`. Dropped rather than carried as a guaranteed-dead
  // rule — verified via `registryCoherenceFindings` (was reporting "dead ExpectedFailure rule").
  // -----------------------------------------------------------------------
  {
    match: { kind: "form", exact: "(test #t (if (and (= a b) (= b c)) (= a c) #t))" },
    reason: "Numeric = non-transitivity across exact-bignum vs inexact (2^1000 ± 1) — IEEE/tower edge, known",
    gate: "permanent — IEEE 754/tower edge, no fix planned",
  },
  // -----------------------------------------------------------------------
  // One-number rework (RATIO, docs/design-history/arrival-one-number-rework.md §0.3): a
  // genuinely NEW expected failure, not a stale carry-over. The CLtL 12.3 transitivity example
  // (r7rs-tests.scm:838-841) computes `a = (/ 10.0 single-float-epsilon)` — JS's OWN double
  // epsilon (~2.22e-16), not a real single-float one, so `a` lands near 9e15, just past
  // Number.MAX_SAFE_INTEGER (9007199254740991) — then `j = (exact a)` throws (numeric.ts's
  // exactFn: the simplestInRange approximation itself would need a component beyond safe-int
  // range). Under the OLD bigint-rational representation this line never threw (bigints have
  // no ceiling); under RATIO, hitting exactly this boundary is the intended crash-on-overflow
  // behavior (§0.3: "exact results whose components leave safe range THROW"), not a bug.
  // -----------------------------------------------------------------------
  {
    match: {
      kind: "form",
      exact: normalizeText(`(test #t (if (and (<= a j) (< j (+ j 1))) (not (<= (+ j 1) a)) #t))`),
    },
    reason:
      "one-number rework (RATIO): (exact a) on a/≈9.007e15 (just past Number.MAX_SAFE_INTEGER) throws by design " +
      "(§0.3 crash-on-overflow) — the corpus's own float epsilon computation lands just past the safe-int ceiling",
    gate: "permanent — RATIO's safe-int component ceiling (docs/design-history/arrival-one-number-rework.md §0.3), no fix planned",
  },
  // (The former "One-number rework (RATIO) fallout" block — 13 xfail rules for the
  // env/r7rs/vectors.ts:149 / lists.ts BigInt-mint leftovers — was REMOVED 2026-07-14:
  // the concurrent-WIP protection lifted, the 3-line fix landed (vector-length/length
  // mint plain numbers), and all 26 affected rows genuinely pass. Exactly the lifecycle
  // the block's own comment predicted: "re-triage once the concurrent vectors.ts fix
  // lands — this rule will then go dead".)
  // -----------------------------------------------------------------------
  // Purity invariant — writing methods are OMITTED by design (every entity is frozen).
  // -----------------------------------------------------------------------
  {
    match: {
      kind: "symbols",
      anyOf: [
        "string-set!",
        "string-fill!",
        "string-copy!",
        "vector-set!",
        "vector-fill!",
        "vector-copy!",
        "bytevector-u8-set!",
        "bytevector-copy!",
        "bytevector-fill!",
        "set-car!",
        "set-cdr!",
        "append!",
        "list-set!",
      ],
    },
    reason: "intentional — purity invariant (frozen entities); writing methods are doored",
    gate: "plan-2026-06-11-purity-pass",
  },
  {
    match: { kind: "symbols", anyOf: ["set!"] },
    reason: "intentional — purity invariant; lexical set! (variable rebinding) is doored",
    gate: "plan-2026-06-11-purity-pass (r7rs/binding)",
  },
  {
    match: { kind: "form", exact: normalizeText(`(test 6 (+ x 1))`) },
    reason:
      "intentional — purity invariant; cascading — the enclosing block's sibling `(set! x 5)` doors, aborting before this member runs",
    gate: "plan-2026-06-11-purity-pass (r7rs/binding); block-member symbol-visibility gap in manifest.ts blockMembers (harness fix design, not editable here)",
  },
  {
    match: { kind: "form", exact: normalizeText(`(test 6 (force p))`) },
    reason:
      "intentional — purity invariant; cascading — `(define p (delay (begin (set! count …) …)))` evaluates its " +
      "argument (applicative order) before `delay`'s own door fires, so `set!` throws first",
    gate: "plan-2026-06-11-purity-pass (r7rs/binding); block-member symbol-visibility gap in manifest.ts blockMembers",
  },
  {
    match: { kind: "form", exact: normalizeText(`(test #t (eqv? x y))`) },
    reason: "intentional — purity invariant; cascading — the enclosing block's sibling `(set-cdr! x 4)` doors first",
    gate: "plan-2026-06-11-purity-pass; block-member symbol-visibility gap in manifest.ts blockMembers",
  },
  {
    match: { kind: "form", exact: normalizeText(`(test #f (list? y))`) },
    reason: "intentional — purity invariant; cascading — the enclosing block's sibling `(set-cdr! x 4)` doors first",
    gate: "plan-2026-06-11-purity-pass; block-member symbol-visibility gap in manifest.ts blockMembers",
  },
  {
    match: { kind: "form", exact: normalizeText(`(test #f (list? x))`) },
    reason: "intentional — purity invariant; cascading — the enclosing block's sibling `(set-cdr! x 4)` doors first",
    gate: "plan-2026-06-11-purity-pass; block-member symbol-visibility gap in manifest.ts blockMembers",
  },
  // -----------------------------------------------------------------------
  // Macro engine / hygiene gaps — pre-L1, separate from AValue work.
  //
  // NOTE: `let-syntax` (v1/early-v2 rule, symbols:["let-syntax"]) was REMOVED —
  // r7rs-tests.scm:408's nested let-syntax/syntax-rules hygiene test now passes
  // (verified directly via exec: returns 'outer as expected). Its only other match,
  // r7rs-tests.scm:398, is independently caught by the "set!" rule above (that test's
  // body also contains a literal set!, and "set!" precedes this bucket in iteration
  // order) — so the rule was fully dead and is deleted, not just narrowed.
  // -----------------------------------------------------------------------
  {
    match: { kind: "symbols", anyOf: ["swap!"] },
    reason: "Local define-syntax + set! inside the rewrite — pre-L1 hygiene gap",
    gate: "pre-L1 macro engine (hygiene)",
  },
  {
    match: { kind: "symbols", anyOf: ["my-or"] },
    reason: "Hygienic shadowing of let/if at the use site — pre-L1 hygiene gap",
    gate: "pre-L1 hygiene",
  },
  {
    match: { kind: "form", exact: "(test 'ok (let ((=> #f)) (cond (#t => 'ok))))" },
    reason: "Hygienic shadowing of cond's => auxiliary keyword — pre-L1 hygiene gap",
    gate: "pre-L1 hygiene",
  },
  {
    match: { kind: "symbols", anyOf: ["sequence1"] },
    reason: "Nested define-syntax defining a macro (be-like-begin) — inner macro unbound — pre-L1 macro engine gap",
    gate: "pre-L1 macro engine (nested define-syntax)",
  },
  {
    match: { kind: "symbols", anyOf: ["sequence2"] },
    reason: "Nested define-syntax defining a macro (be-like-begin) — inner macro unbound — pre-L1 macro engine gap",
    gate: "pre-L1 macro engine (nested define-syntax)",
  },
  {
    match: { kind: "symbols", anyOf: ["sequence3"] },
    reason: "Nested define-syntax defining a macro (be-like-begin) — inner macro unbound — pre-L1 macro engine gap",
    gate: "pre-L1 macro engine (nested define-syntax)",
  },
  {
    match: { kind: "symbols", anyOf: ["mad-hatter"] },
    reason: "Nested define-syntax (jabberwocky → hatter) — inner macro unbound — pre-L1 macro engine gap",
    gate: "pre-L1 macro engine (nested define-syntax)",
  },
  {
    match: { kind: "form", exact: "(test 'x (bar 1))" },
    reason: "Nested define-syntax (foo → bar) — inner macro unbound — pre-L1 macro engine gap",
    gate: "pre-L1 macro engine (nested define-syntax)",
  },
  {
    match: { kind: "form", exact: "(test 100 (ff 10))" },
    reason: "Nested define-syntax (ffoo → ff) — inner macro unbound — pre-L1 macro engine gap",
    gate: "pre-L1 macro engine (nested define-syntax)",
  },
  {
    match: { kind: "symbols", anyOf: ["elli-lit-1"] },
    reason: "Ellipsis used as a literal in the template — pre-L1 macro engine gap",
    gate: "pre-L1 macro engine (ellipsis handling)",
  },
  {
    match: {
      kind: "form",
      exact:
        '(test \'#((10 43) (31 41 51) (32 42 52) (63 77) ("rest:" . "tail")) (part-2x (10 (+ 21 22) (31 32) (41 42) (51 52) (+ 61 2) 77 . "tail")))',
    },
    reason: "Improper-list (dotted-tail) ellipsis pattern — pre-L1 macro engine gap",
    gate: "pre-L1 macro engine (ellipsis handling)",
  },
  // Ellipsis sub-pattern `(m n) ...` in the MIDDLE of a pattern (followed by a fixed `x y`
  // tail) — verified: `m`/`n` bind to `()` instead of the collected elements (expected
  // `(31 41 51)`/`(32 42 52)`, actual `()`/`()`); the head/tail-only parts (`a b`, `x y`)
  // bind fine. A middle-ellipsis-sub-pattern capture gap, same family as the other pre-L1
  // ellipsis-handling rows above.
  {
    match: {
      kind: "form",
      exact: normalizeText(
        `(test '#((10 43) (31 41 51) (32 42 52) (63 77)) (part-2 10 (+ 21 22) (31 32) (41 42) (51 52) (+ 61 2) 77))`,
      ),
    },
    reason: "Ellipsis sub-pattern `(m n) ...` in the middle of a pattern binds to () instead of the collected elements",
    gate: "pre-L1 macro engine (ellipsis handling)",
  },
  {
    match: {
      kind: "form",
      exact: normalizeText(
        `(test '#((10 43) (31 41 51) (32 42 52) (63 77) ("rest:")) (part-2x (10 (+ 21 22) (31 32) (41 42) (51 52) (+ 61 2) 77)))`,
      ),
    },
    reason: "Ellipsis sub-pattern `(m n) ...` in the middle of a pattern binds to () instead of the collected elements",
    gate: "pre-L1 macro engine (ellipsis handling)",
  },
  {
    match: { kind: "symbols", anyOf: ["underscore"] },
    reason: "`_` wildcard in a syntax-rules pattern — pre-L1 macro engine gap",
    gate: "pre-L1 macro engine",
  },
  {
    match: { kind: "symbols", anyOf: ["count-to-2_"] },
    reason: "`_` wildcard counting pattern (count-to-2_) — pre-L1 macro engine gap",
    gate: "pre-L1 macro engine",
  },
  {
    match: { kind: "form", exact: "(test 'bound-identifier=? (m k))" },
    reason: "let-syntax + bound-identifier=? hygiene comparison — pre-L1 hygiene gap",
    gate: "pre-L1 hygiene (bound-identifier=?)",
  },
  // -----------------------------------------------------------------------
  // Function/lambda identity — evaluating twice through the lookup/eval path yields
  // distinct closures, so `(eq? p p)` sees two objects.
  // -----------------------------------------------------------------------
  {
    match: { kind: "form", exact: "(test #t (let ((p (lambda (x) x))) (eq? p p)))" },
    reason: "Lambda identity — lookup/eval yields distinct closures, eq? sees two objects — pre-L1",
    gate: "pre-L1 (evaluator identity)",
  },
  // NOTE: narrowed from the original symbols:["gen-counter"] (2 matches) — that broad rule
  // ALSO caught `(test #f (eqv? (gen-counter) (gen-counter)))` @713, which now passes:
  // two SEPARATE gen-counter calls legitimately produce non-eqv? closures regardless of the
  // identity bug, so the expected #f actually holds (verified directly via exec). Only the
  // self-comparison form below (the same lexical binding looked up twice, the actual identity
  // bug's shape) remains genuinely broken.
  {
    match: { kind: "form", exact: normalizeText(`(test #t (let ((g (gen-counter))) (eqv? g g)))`) },
    reason: "Lambda identity — same root cause as the (eq? p p) case above",
    gate: "pre-L1 (evaluator identity)",
  },
  {
    match: { kind: "symbols", anyOf: ["gen-loser"] },
    reason: "Lambda identity — same root cause as the (eq? p p) case above",
    gate: "pre-L1 (evaluator identity)",
  },
  // -----------------------------------------------------------------------
  // 6.5 Symbols — symbol->string/string->symbol REMOVED (v1/early-v2 rule). Verified fixed:
  // the described bug ("core.ts uses JS dot-access that no longer resolves") no longer applies
  // — the implementation moved to r7rs/equality.ts and uses `s.__name__` cleanly (a real
  // ASymbol API, not raw dot-access into a stale type). Direct exec confirms
  // `(symbol->string 'flying-fish)` → "flying-fish". All 7 matched rows now pass; the stale
  // it.fails rows were the ONLY thing keeping them red (was failing with "Expect test to fail").
  // -----------------------------------------------------------------------
  // -----------------------------------------------------------------------
  // FIXED — harness comparator bug (chibi-test-equal?'s inexact branch, harness-capability.ts
  // prelude): epsilon-diff of two infinities was `(- +inf.0 +inf.0)` = NaN, never < epsilon.
  // Now routes through `=` first (which compares infinities correctly) before the subtraction.
  // Rows removed; verified green.
  // -----------------------------------------------------------------------
  // -----------------------------------------------------------------------
  // FIXED — member/assoc custom-compare bug (src/env/r7rs/lists.ts): the native impl called
  // `compare(obj, x)` as a raw JS function invocation; a scheme-level procedure value (e.g.
  // `string-ci=?`, `=`, or any user lambda) decodes to a boxed ANativeProcedure/ALambda object,
  // not `typeof === "function"`. Now routed through `call_function`, matching mapImpl's own
  // pattern. Rows removed; verified green.
  // -----------------------------------------------------------------------
  // -----------------------------------------------------------------------
  // FIXED — guard/raise value-loss bug (src/eval/evaluator.ts): a `%raise` of a raw non-Error
  // scheme value was stringified by the trampoline's failAndWrap before ever reaching evalTry's
  // catch (`new ArrivalError(String(error), frames, undefined)` — cause is typed `Error`, so the
  // original value couldn't ride there). Fixed via a module-level `rawRaisedValues` WeakMap
  // side channel (keyed by the wrapper instance) that evalTry's guard/catch binding now
  // consults to recover the ORIGINAL raised value. Rows removed; verified green.
  // -----------------------------------------------------------------------
];

// ── STAGED — none yet (mirrors v1's empty SKIPPED_TESTS). ────────────────────────────────────

export const STAGED: readonly Staged[] = [];

function describeMatch(match: Matcher): string {
  switch (match.kind) {
    case "symbols":
      return `symbols:[${match.anyOf.join(", ")}]`;
    case "form":
      return `form:"${match.exact.slice(0, 80)}"`;
    case "section":
      return `section:"${match.name}"`;
  }
}

/** The generic engine behind `verdictFor`/`registryCoherenceFindings`, factored out so a
 *  SECOND corpus with its own rule tables (e.g. chibi's own SRFI-1 `test.sld` —
 *  `registries-srfi1.ts`) gets the identical precedence/self-check machinery instead of a
 *  re-implementation that could drift from this one. The main corpus's own `verdictFor`/
 *  `registryCoherenceFindings` below are just this factory applied to `EXCLUDED`/
 *  `EXPECTED_FAILURES`/`STAGED` — zero behavior change from before this factoring. */
export function makeRegistry(
  excluded: readonly Exclusion[],
  expectedFailures: readonly ExpectedFailure[],
  staged: readonly Staged[],
): { verdictFor: (step: TestStep) => Verdict; registryCoherenceFindings: (manifest: Manifest) => string[] } {
  function verdictFor(step: TestStep): Verdict {
    for (const rule of excluded) if (matchesRule(rule.match, step)) return { run: "skip", feature: rule.feature };
    for (const rule of expectedFailures)
      if (matchesRule(rule.match, step)) return { run: "fails", reason: rule.reason, gate: rule.gate };
    for (const rule of staged) if (matchesRule(rule.match, step)) return { run: "todo", spec: rule.spec };
    return { run: "it" };
  }

  // P16 harness self-check (§4): dead-rule alarm (a rule matching zero manifest rows —
  // orphaned by an upstream fix, must be deleted) + over-match alarm (an ExpectedFailure
  // exceeding its declared `maxMatches`, protecting a sibling test that should stay green).
  // Returns a list of human-readable findings; empty means coherent.
  function registryCoherenceFindings(manifest: Manifest): string[] {
    const findings: string[] = [];
    const countMatches = (match: Matcher): number =>
      manifest.tests.reduce((n, t) => n + (matchesRule(match, t) ? 1 : 0), 0);

    for (const rule of excluded) {
      const n = countMatches(rule.match);
      if (n === 0) findings.push(`dead Exclusion rule (0 matches): ${describeMatch(rule.match)} — ${rule.feature}`);
    }
    for (const rule of expectedFailures) {
      const n = countMatches(rule.match);
      if (n === 0)
        findings.push(`dead ExpectedFailure rule (0 matches): ${describeMatch(rule.match)} — ${rule.reason}`);
      if (rule.maxMatches !== undefined && n > rule.maxMatches)
        findings.push(
          `over-match ExpectedFailure rule (${n} > maxMatches ${rule.maxMatches}): ${describeMatch(rule.match)} — ${rule.reason}`,
        );
    }
    for (const rule of staged) {
      const n = countMatches(rule.match);
      if (n === 0) findings.push(`dead Staged rule (0 matches): ${describeMatch(rule.match)} — ${rule.spec}`);
    }
    return findings;
  }

  return { verdictFor, registryCoherenceFindings };
}

const mainRegistry = makeRegistry(EXCLUDED, EXPECTED_FAILURES, STAGED);
export const verdictFor = mainRegistry.verdictFor;
export const registryCoherenceFindings = mainRegistry.registryCoherenceFindings;
