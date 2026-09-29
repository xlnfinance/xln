# The Polyglot Grammar

> The mental model, stated once, ahead of the code. Arrival's reader and evaluator
> speak R7RS Scheme faithfully, and add a small, named set of **compile-erased
> supersets** where the platform's own grain leaves a symmetry unfinished: `[…]` and
> `{…}` collection literals, a position-scoped comma separator, a suffix-keyword flip,
> bracket bindings and bracket clauses for the let/cond families, a member-access
> protocol, and the serializer prefix `#attachment`. Every one lowers to plain R7RS with
> zero non-spec residue — the surface is wider, the emitted meaning is stock Scheme. This
> document says what each superset IS, where its grammar lives, and why the door it
> closes is the only globally consistent shape. It is the model;
> [`grammar.ebnf`](../src/reader/grammar.ebnf) (`@inhuman.tools/arrival/grammar.ebnf`) is
> the formal productions of that model (R7RS §7.1 plus the supersets below); the
> `*.spec.ts` / `*.test.ts` files under `src/reader/__tests__/polyglot/` and
> `src/reader/__tests__/grammar-ebnf/` are its executable pins. Parser success on a
> string and eBNF rejection of that string is a bug in the eBNF — unless the Parser is
> a silent-loss quirk (a second `.` in a list, a dotted `#(` / `#u8(`), which is a
> Parser door. The eBNF is the structural membership floor; doors teach why a
> CFG-legal string is still not a program.

Section anchors are CAPS so code comments can cite `docs/grammar.md §<ANCHOR>`. Each
section closes with its enforcement sites (files, no line numbers — those rot). Every
claim here is grounded in those files; when code and this document disagree, one is a
bug — decide which before writing a line.

Constitutional ground: `PRINCIPLES.md §V` — **P13** (the platform's grain decides the
surface; departures are named supersets, no hidden host semantics) and **P14** (no
shadow features; every capability is reachable from a production entry or explicitly
staged). `RULINGS.md` **R6** (the curly-infix ban) and the **key taxonomy**. This
document elaborates the mechanism those laws constrain; it links them, never restates
their text.

---

## 0. PHILOSOPHY — the platform grain decides the surface

**The reader ships R7RS; it widens only where R7RS leaves a shape undefined, and every
widening is a bounded, named, compile-erased superset.** This is P13 made concrete for
the language surface: Racket and Clojure forms appear _only_ at positions R7RS calls
malformed, each lowering to a form stock Scheme already accepts. There is no
Host-under-the-hood style "JS is the real semantics underneath" — a hidden host interpretation is a
third reading the provenance and type layers never agreed to (P13's forbidden state).

A superset earns its place iff it (a) lowers to pure spec with zero non-spec output
residue, (b) completes a symmetry the platform's own grain left open — a datum already
legal _everywhere else_ that one position inertly rejected — and (c) is explicitly
enumerated, not an open escape hatch (P14). The curly-infix ban (§INFIX, `RULINGS.md`
R6) is the mirror image: a candidate superset that fails (b) — braces would carry two
grammars at once and an infix-shaped dict would misparse silently — so it is refused at
a loud door instead of admitted. Faithfulness is judged at the _output_: the authoring
surface is wider, the compiled artifact is R7RS.

---

## 1. LITERALS — the `[…]` and `{…}` collection nodes

**Two collection literals extend the reader, each minting a node whose CLASS carries
its own grammar — the reader never erases which bracket produced it.** The distinction
is load-bearing because the two literals evaluate their contents differently, and a
conforming reader must keep them apart:

| surface     | node                 | `evalElements` | code-position meaning                                    |
| ----------- | -------------------- | -------------- | -------------------------------------------------------- |
| `[form …]`  | `AVector` (literal)  | `true`         | elements evaluate — lowers once (cached) to `(vector …)` |
| `#(form …)` | `AVector` (constant) | `false`        | R7RS constant — elements never evaluate                  |
| `{form …}`  | `ADict` (literal)    | —              | lowers once (cached) to `(dict …)`                       |

`evalElements === true` is the single reader-set marker distinguishing a `[…]` literal
from an R7RS `#(…)` constant; the Parser stamps it on `[`, and it survives as a field
on the produced `AVector`. It is also the detection every downstream superset keys off
(§BINDINGS, §CLAUSES) — no separate reader or lexer mode exists.

**Both `[…]` and `{…}` are dual data/code by construction, and the node's class is what
makes the duality free.** A `{…}` node is an `ADict`, not a distinct AST kind, precisely
so it behaves correctly in all three contexts:

- **CODE position** — the evaluator lowers the node ONCE, cached, to the equivalent
  application: `{:k v}` ≡ `(dict :k v)`, `[a b]` ≡ `(vector a b)`. Evaluation, membrane
  marshaling and provenance all ride the normal apply path — the literal
  invents no second evaluation route.
- **`quote` context** — `evalQuote` returns the node itself: a first-class readable
  `ADict`/`AVector` whose values are the raw forms. `(@ '{:a (f x)} :a)` reads back the
  unevaluated form `(f x)`. A distinct syntax-node kind would break this — `quote` must
  yield a value.
- **`quasiquote` context** — the forms are walked element-wise (unquote fires at
  level 1) and the node is re-minted via `ADict.fromLiteralForms` / the vector re-mint.

The `{…}` datum face is an `ADict` — the same in-class pattern `AVector` uses for `[…]`;
`AJSObject` (the borrowed-host-object carrier) plays no part in the dict-literal syntax.
Dict keys are read-time-static (`:keyword` / `"string"`, both folding to one string key)
or an `(unquote …)` form (a quasiquote-substituted key, validated post-substitution).

**Enforcement sites:** `reader/dict-grammar.ts`, `reader/Parser.ts`,
`values/primitives/ADict.ts`, `values/primitives/AVector.ts`,
[`grammar.ebnf`](../src/reader/grammar.ebnf) (`vec-lit` / `dict-lit`).

---

## 2. COMMA — the position-scoped separator

**A comma is R7RS `unquote` everywhere except at an element boundary inside a `[…]`/`{…}`
literal, where at most ONE comma is absorbed as a separator.** R7RS classes `,` as a
token-level delimiter; the literal absorbs it as visual JSON/array punctuation without
ever changing its base meaning outside the brackets. The rule is a small named law
because it looks arbitrary until stated as the only consistent one.

**THE COMMA RULE.**

1. **Position-scoped.** A comma is a separator ONLY at an element boundary inside `[…]`
   or `{…}`. Leading commas, everywhere outside the literals, and any comma that is not
   at a boundary stay R7RS `unquote`.
2. **One per boundary.** At most one comma is absorbed per element boundary; a second
   comma at the same boundary is `unquote` again.
3. **Even-boundary-only for maps.** Inside `{…}` a separator comma is absorbed only at
   an EVEN boundary — after a complete key/value pair. JSON puts `:` between key and
   value and `,` between pairs, never inside one; an odd-boundary comma stays `unquote`.
4. **`,@` is never a separator.** `unquote-splicing` always reads as itself.
5. **One trailing separator tolerated** before the close delimiter.

Canonical pin (the mixed case that fixes every clause at once):
`{:a ,quoted,,anotherQuoted ,quotedValue}`
≡ `{:a (unquote quoted) (unquote anotherQuoted) (unquote quotedValue)}` — the first `,`
is the odd-boundary unquote on the value, the doubled `,,` is separator-then-unquote,
and every `,` that lands mid-pair stays `unquote`.

**Enforcement sites:** `reader/Parser.ts`, `reader/Lexer.ts`,
`reader/__tests__/polyglot/reader-baseline.spec.ts`.

---

## 3. SUFFIX-FLIP — the trailing-colon key

**At KEY position inside `{…}`, a symbol token with a SINGLE trailing colon flips to the
keyword key: `{flight_number: "X"}` ≡ `{:flight_number "X"}`.** The trailing colon is the
explicit commitment marker, symmetric to the leading `:x` prefix — an author declaring
"this is a key," so the JSON habit of writing `key:` reads correctly.

The flip is deliberately narrow, and each boundary of its narrowness is load-bearing:

- **Explicit declaration only.** A bare `{x 1}` stays `E-DICT-BAD-KEY` — an unmarked
  symbol could be intended as a reference, so the reader refuses to guess. Only the
  trailing colon opts in.
- **Position-scoped.** The flip fires at dict KEY position only; `foo:` outside `{}` is
  a plain symbol.
- **Shape-bounded.** `a::`, `:a`, and a lone `:` are not suffix keys — the marker is
  exactly one trailing colon on a name of length ≥ 2.
- **Shared keyspace.** A flipped key shares the duplicate-detection keyspace with
  `:key`/`"key"`; all three spellings of one key collide as duplicates.

Maps also absorb at most one lone `:` token at an ODD boundary — the verbatim-JSON
string-key colon in `{"a": 1}`.

**The GLUED forms are lexer-scoped, and the lexer's tokenization decides the meaning
before the dict grammar ever runs:**

- `{a:1}` lexes as ONE symbol token `a:1` — not a key/value pair. It doors as a bad key
  (the teaching door), because a space is what separates key from value.
- `{"a":1}` lexes the value as the keyword token `:1` — only a space after the colon
  (`{"a": 1}`) yields the JSON string-key meaning.

**Enforcement sites:** `reader/dict-grammar.ts` (`suffixKeyName`), `reader/Parser.ts`
(`make_dict_literal` validation), `reader/Lexer.ts` (glued-form tokenization).

---

## 4. INFIX — the curly-infix ban

**`{…}` is the dict literal, and an infix-shaped `{a * b}` is DETECTED and BANNED at a
teaching door, never silently misparsed.** This is `RULINGS.md` R6: the dict literal
wins the brace unconditionally. SRFI-105 curly-infix / neoteric n-expressions live in
the sugarcoat syntax layer only; the core reader has no curly-infix mode and reads no
flag to enable one (P14 — a flag no entry can set is the codebase lying about what it
ships).

**Why a ban and not a silent parse.** SRFI-105 n-expressions flatten to an ODD-length
element sequence (`k` operands + `k−1` operators = `2k−1`) with a bare symbol in the
operator slot. If braces carried both grammars, a dict-shaped infix expression — or an
infix-shaped dict — would misparse _silently_, the worst failure a reader can have. The
ban keeps the error loud and points at the prefix form.

**The detection guards the genuine-dict false positive.** The infix door fires only when
the element count is odd and ≥ 3, index 1 is a symbol, AND index 0 does NOT look like a
key (`staticDictKey` / `suffixKeyName` / `isUnquoteForm` all reject it). That combination
is "operand operator operand," never "key value key" — a shape that can never be a
legitimate dict (a real one has a key-shaped element 0). So `{:a foo :b}` (a valid key at
index 0, a dangling `:b` — genuinely odd arity) doors as `E-DICT-BAD-KEY`, while `{a * b}`
doors as `E-DICT-INFIX-BANNED` with the message steering to `(* a b)`. The door is checked
FIRST, before key validation reads the same shape into its own, less specific error.

**Enforcement sites:** `reader/Parser.ts` (`make_dict_literal`).

---

## 5. BINDINGS — bracket bindings for the let-family

**The bindings slot of `let`, `let*`, `letrec`, `letrec*`, named `let`, and `do`
additionally accepts a `[…]` vector datum — a named, compile-erased superset that
completes the reader's own grain.** `[…]` is already a first-class datum in every other
position (§LITERALS); the let-family was the one place it was inertly rejected. Models
trained on Racket write `(let* ([a 1] [b 2]) …)`; models trained on Clojure write
`(let [a 1 b 2] …)`. Both now evaluate byte-identically to the parenthesized R7RS image.

> **BG-numbering note.** The `normalizeBindings`/`normalizeClause` section of
> `src/eval/evaluator.ts` numbers its own local rules `R1`–`R6`, `R9`. Those file-local
> numbers COLLIDE with `RULINGS.md`'s global R-ledger (where `R2` is container facts, `R6`
> the curly-infix ban, `R9` container `toJS`), which is a different thing entirely. This
> document renames them to a **BG-series** to keep the two ledgers apart: the evaluator's
> local `Rn` is this document's **BGn** (so local `R2a` = **BG2a**, local `R9` = **BG9**).
> The mapping is 1:1; the source comments keep their local numbers until their next fold.

The rules, BG-numbered:

- **BG1 — no grammar change.** Detection is `evalElements === true` at a binding-position
  node (§LITERALS). No reader or lexer change: `quote` and macros still see a plain vector
  datum, so a quoted let form's bindings slot stays inert data, and a `[…]` literal in an
  init value or body position stays data.
- **BG2 — two surfaces.**
  - **BG2a whole-list (Clojure):** `(let [a 1 b 2] …)` — `bindings` itself is the vector,
    rewritten to `((a 1) (b 2))` wholesale. NOT accepted for `do` (its 3-element steps make
    pairwise grouping ambiguous — BG2a exclusion).
  - **BG2b per-element (Racket):** each ELEMENT may be a vector `[a 1]` / `[i 0 (+ i 1)]`
    (`do` only), rewritten in place.
  - **BG2c mixing** is free: a paren-pair element passes through untouched, so one bindings
    list may mix `(a 1)` and `[b 2]`.
- **BG3 — pure syntactic rewrite.** `normalizeBindings` runs once, before the existing
  per-binding walk, producing the SAME cons-list-of-pairs a hand-written paren form
  produces. Every downstream line then evaluates a plain list with no brackets in it —
  equivalence to the paren image is structural, not case-by-case.
- **BG4 — malformed shapes keep the two door codes** (§ERRORS): `E-LET-BRACKET-BINDINGS-LIST`
  (odd whole-list count, or the whole-list form on `do`) and `E-LET-BRACKET-BINDING`
  (per-element wrong length, or a non-symbol — including a Clojure destructuring vector —
  in the name slot).
- **BG5 — scope bound.** ONLY the six forms' bindings slots (plus the BG9 clause positions,
  §CLAUSES). Never lambda formals, `when`/`unless`, head position, or any data position.
  `#(…)` (`evalElements === false`) is never touched — it falls straight through the generic
  `is_pair` invariant.

**BG6 — non-intersection is why no context-dependent meaning exists.** Each bracket surface
has exactly ONE legal reading among the parent dialects, and Arrival's meaning equals that
unique reading. No shape exists whose Scheme meaning and Clojure/Racket meaning both exist
and disagree:

| surface           | R7RS      | Racket | Clojure | Arrival          |
| ----------------- | --------- | ------ | ------- | ---------------- |
| `(let ((s v)) …)` | legal     | legal  | —       | untouched        |
| `(let ([s v]) …)` | malformed | legal  | —       | = Racket (BG2b)  |
| `(let [s v …] …)` | malformed | —      | legal   | = Clojure (BG2a) |

Where R7RS calls a shape malformed, Arrival gives it the single well-defined dialect
meaning — which, by BG3, is byte-identical to a form R7RS DOES accept. The union of the
three readings is a FUNCTION: one input shape → one meaning, no branch on surrounding
context.

**Enforcement sites:** `eval/evaluator.ts` (`normalizeBindings`), `reader/Parser.ts`
(the `evalElements` stamp on `[`), `values/primitives/AVector.ts`.

---

## 6. CLAUSES — bracket clauses for cond / case / do

**The CLAUSE positions of `cond`, `case`, and `do`'s test-result clause additionally
accept a `[…]` vector, elementwise ≡ the parenthesized clause** —
`(cond [(> x 1) "a"] [else "b"])`, `(case k [(1 2) "low"] [else "hi"])`. `cond`/`case`/`do`
are evaluator special forms (not syntax-rules prelude macros), so consumption lands in the
same file and shape as §BINDINGS: `normalizeClause` runs once per clause, before the
existing clause walk, producing the plain-list shape a paren clause already is. The
structural-equivalence argument is BG3's, transposed to clauses.

**BG9 — the datum-list head stays a LIST, never bracket-converted.** `normalizeClause`
converts ONLY the clause's own wrapper; it never looks inside element 0. So a `case`
clause's datum-list head stays data: `[(1 2) "low"]`'s vector elements are `[(1 2), "low"]`,
and rewrapping them as a list gives `((1 2) "low")` with the inner `(1 2)` untouched —
exactly the paren image. A datum-list head that is _itself_ a bracket vector
(`[[1 2] "low"]`) does NOT lower to `((1 2) "low")`; it doors `E-CASE-BRACKET-DATUM-LIST`,
naming the vector-ness itself as the confusion, because the datum list is data and is never
bracket-converted even inside a bracketed clause.

**The two clause doors** (§ERRORS): an empty clause `[]` doors `E-COND-BRACKET-CLAUSE`
(shared across cond/case/do — a clause needs at least its test/datum slot); the datum-list
door above. `#(…)` and non-vector clauses pass through to the existing `is_pair(clause)`
invariants.

**Non-intersection (BG6, clause edition).** Bracket clauses are a purely Racket surface —
Clojure's `cond` is flat, with no clause grouping — so no dialect conflict exists, and
Racket's reading already equals the rewrite.

**Enforcement sites:** `eval/evaluator.ts` (`normalizeClause`, `evalCond`/`evalCase`/`evalDo`).

---

## 7. MEMBER-ACCESS — two syntaxes over one interop read

_(This section owns the SYNTAX face of member access. The read MECHANISM — the interop
policy, the prototype-walk boundary, the module-local capability brand — lives in
`docs/membrane.md §MEMBER-READ`, its canonical home. Cross-link, don't restate.)_

**Two surface syntaxes read a member, and both bottom out in ONE interop read.** `@` /
`@?` / `@keys` (the explicit read/has/keys surface) and `(:key obj)` (the keyword
accessor, Clojure-style) are two spellings over one read that mirrors GraalVM Truffle's
`InteropLibrary.readMember` — a foreign object exposes its members, not its language's
internals. Both dispatch onto the receiver's own `arrival/tagless-final/get|has|keys`
terms; they are origin-agnostic, so a dict, a membrane-exposed foreign value, and an
array all read the same way. Arrival is a polyglot runtime, not a host with a fenced
guest, so there is no per-type accessor — the receiver's own term is the dispatch.

`normalizeMemberKey` is the ONE home of key normalization for this surface: `valueOf`-
unwrap a boxed key, refuse a nil/null key, stringify, strip a leading `:` accessor sigil.
The receiver then folds the result (`ADict`'s `foldKeyName` handles the `SchemeValue`
route the keyword accessor takes).

**ABSENCE IS THE SEMANTICS.** A term-less receiver — a Scheme leaf, a raw FFI value, a
function — answers `nil` / `#f` / `()` from the `@` family, never a value's internal
provenance or kind. A missing KEY on a present dict is likewise `nil` (`(:b {:a 1})` →
`nil`): absence of the datum is the value, not an error. The one divergence between the
two syntaxes is exactly here — the `:key` accessor over a genuine NON-DICT operand
(`(:a 5)`) throws code-less (§ERRORS), where the `@` verb over a term-less receiver
returns `nil`. The keyword accessor is a first-class function throughout: `((lambda (f)
(f {:a 7})) :a)` → `7`, and it threads with the dialect idioms
(`(->> p :versions last :state)`).

**The dotted-path side-door is deliberately unsupported — a NAMED negative boundary.**
`foo.bar.baz` sugar → member-walk is NOT a resolution path. It would side-door BOTH the
membrane face and the provenance field-step classification, reaching members without
crossing the one interop read. A dotted identifier resolves as an ordinary (unbound)
symbol — the normal unbound-variable door. `@` and `:key` are THE member-access surface;
there is exactly one way in.

**Enforcement sites:** `env/polyglot/polyglot.ts` (`@`/`@?`/`@keys`/`dict`,
`normalizeMemberKey`), `values/primitives/ADict.ts`, `values/primitives/ASymbol.ts`
(the self-evaluating keyword accessor), `eval/Resolver.ts` (`resolveSynth`, the
dotted-path negative boundary), `membrane/interop-access.ts` (mechanism — see
`docs/membrane.md §MEMBER-READ`).

---

## 8. ERRORS — the door taxonomy

Every grammar rejection is a teaching door carrying a stable, machine-checkable `code`
on the thrown error (`errorClass` reads it off `.code` or the nearest cause). Messages
stay free to teach; the specs match ONLY the class.

| Code                          | Meaning                                                                                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `E-DICT-ODD-ARITY`            | `{…}` has an odd element count (a key without its value)                                                                                               |
| `E-DICT-BAD-KEY`              | `{…}` key is not a `:keyword` / `"string"` / trailing-colon `key:` / unquote form (read time), or a substituted key folded to a non-string (eval time) |
| `E-DICT-DUP-KEY`              | duplicate `{…}` key (read-time static, or post-quasiquote-substitution)                                                                                |
| `E-DICT-INFIX-BANNED`         | `{…}` is infix-shaped (`{a * b}`) — the SRFI-105 curly-infix ban (§INFIX); steers to the prefix `(op …)` form                                          |
| `E-LITERAL-DOT`               | `.` inside a `[…]`/`{…}` literal, or a dotted tail on `#(` / `#u8(`                                                                                     |
| `E-DOT-EXTRA-ELEMENT`         | more than one datum after `.` in a paren list (`(a . b c)`, `(a . b . c)`)                                                                              |
| `E-EXPECTING-DATUM`           | quote-family prefix (`'`, `` ` ``, `,`, `,@`) dangling against a close delimiter                                                                       |
| `E-UNTERMINATED`              | EOF inside an open string/list/literal                                                                                                                 |
| `E-BRACKET-MISMATCH`          | close delimiter does not pair its opener (`(a]`)                                                                                                       |
| `E-BRACKET-UNEXPECTED`        | close delimiter with nothing open (`]`)                                                                                                                |
| `E-LET-BRACKET-BINDINGS-LIST` | a whole-list bracket bindings form is malformed: odd element count, or the whole-list form on `do` (§BINDINGS, BG4)                                    |
| `E-LET-BRACKET-BINDING`       | a per-element bracket binding is malformed: wrong length (≠2; ≠2–3 for `do`), or a non-symbol (incl. a destructuring vector) in the name slot          |
| `E-COND-BRACKET-CLAUSE`       | a `cond`/`case`/`do`-test bracket clause is empty (`[]`)                                                                                               |
| `E-CASE-BRACKET-DATUM-LIST`   | a `case` clause's datum-list head is itself a bracket vector — the datum list is data, never bracket-converted (§CLAUSES, BG9)                         |

**One member-access rejection is code-less by design.** The `:key` accessor over a
non-dict operand (`(:a 5)`) throws a plain `Error` — no stable `.code`, `errorClass`
answers `undefined`. It is the "no members to read" path, not a grammar door, and the
specs assert it via the any-error convention (§MEMBER-ACCESS).

**Enforcement sites:** `reader/Parser.ts`, `reader/parsing.ts`, `eval/evaluator.ts`,
`errors.ts`.

---

## 9. LOOSE-STRICT — the portability control

**`#null` and `#void` are loose-mode-only reader literals; strict mode doors them.**
`#null` reads to `nil` (the empty list — JS `null`'s Rosetta translation, so no separate
JS-null value leaks into the language), `#void` to the void singleton (the unspecified
value). Both VALUES exist under any mode; only the non-standard readable LITERAL is
gated, because a program that writes them is not portable to a stock Scheme with no
readable void/null syntax.

`strict` is the R7RS portability control, threaded through the reader and defaulting to
`false` (loose). Under loose mode the two literals read; under strict mode `strictGate`
doors them at parse time as `reader-literal` violations. The gate is the value layer's
floor for portability — the only mode difference is whether the non-portable literal is
readable, never what the resulting value is.

**Enforcement sites:** `reader/lexical-grammar.ts` (`parsable_contants`),
`reader/parsing.ts` (`parse_argument`, `strictGate`), `reader/parse.ts` (the `strict`
default).

---

## Not in scope — dialect-pack vocabulary

The dialect packs' VOCABULARY — Clojure/Racket threading macros (`->`/`->>`/`~>`),
stdlib completion (`str`, `get-in`, `mapv`, `frequencies`, …), Common Lisp's `mapcar`,
the composition family — is env-capability content, not grammar. It lives in the
`scheme/polyglot-{clojure,racket,lisp}` packs and is documented as capability material
(`docs/environments.md`, the `env-capability-authoring` skill), not here. This document
covers only the reader/evaluator grammar the packs thread through.
