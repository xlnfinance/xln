# arrival-sugarcoat — extension-design ideation (grammar · lexer · risks · alternates)

**Status:** ideation only · **Date:** 2026-06-15 · zero execution, zero interpreter detail.
Companion to the method-dot spec, since absorbed into [`../GRAMMAR.md`](../GRAMMAR.md). The governing question: **how do we add
surface to arrival-sugarcoat (dicts now, more later) without the edit-stability knife-edge** — grounded
in how grammars/lexers are actually built and what sweet-expressions learned the hard way. This
deliberately ignores "alist vs map" and every execution concern; those are solved one layer down.

---

## 0. The one principle (the spine the whole field converged on)

Across PEG theory, the JS spec, sweet-expressions, Clojure, Elixir, Julia, and Rhombus, every
**survivor** of "rich surface over a homoiconic core" shares one structural move:

> **A frozen, universal base + a bounded extension layer that lowers to a canonical AST with
> round-trip identity, where each construct's category is fixed by a leading marker and decided
> locally.**

Every **graveyard** case (M-expressions, Dylan-as-fork, CGOL, IACL2, sweet's own stalled adoption)
violated one clause — extended the reader itself, forked surface from core, inferred category from
content/context, or shipped no print side. V already re-derived the load-bearing half ("the type
lives in the delimiter, not the contents"). The research says: that is _exactly_ the rule, and there
are three more clauses bolted to it.

---

## The trimorphism — `scheme ⟷ sweet ⟷ sugarcoat`

The design is **not** "a sweet variant." It is **three named, stable representations** of one program,
connected by **two bifunctors** that compose to round-trip identity. The rungs:

- **scheme** — R7RS s-expr. The frozen homoiconic core: fully explicit, fully parenthesized, zero
  sugar. The AI's native rung; the git/replay/deploy artifact; the ground truth.
- **sweet** — the **structural** rung. Pure δ-quotient sugar over scheme: curly-infix,
  precedence-elision, accessor `[]`, colon-pairs, `%{}` dicts. Every construct here is _mechanically
  derived_ — a quotient lens to scheme, **no human-cognitive opinion**. _Notation for a model R7RS
  already has_ (same mental model, different glyphs). SRFI-105 lineage. The neutral middle ground.
- **sugarcoat** — the **ergonomic** rung. The human-pleasing top: dot-method pipelines, `it`,
  trailing lambdas — notations that _import a reading model R7RS lacks_ (pipeline, anaphora). This is
  where human-cognitive opinion **legitimately** enters, and it is **quarantined here, named**, never
  smeared into sweet.

**The two bifunctors, and the faithfulness gradient:**

- **scheme ⟷ sweet** — _mechanical, opinion-free._ Pure δ-equivalences (precedence elision, accessor
  folding, brace-canonicalization). "No editorial layer over the platform" lives **below** sweet —
  this half is platform-faithful by construction.
- **sweet ⟷ sugarcoat** — _human-cognitive._ Opinion enters (pipeline reading, anaphoric `it`), but
  it remains a **stable bifunctor** — it round-trips. The "studio glass" half.

Opinion increases as you ascend; reversibility holds at every rung. The composition
`scheme ⟷ sugarcoat` is the full two-face bifunctor — and the intermediate rung makes the **boundary
between mechanical and cognitive explicit.** (This resolves the earlier "is the dot-method
sugarcoat?" tangle: yes — _literally_ sugarcoat, the named top rung. Not a forbidden mirror; a
legitimate cognitive projection, separated from the platform-faithful rung.)

**Who reads which rung:** AI → scheme (native) or sweet (also fine, it's opinion-free); human →
sugarcoat (pleasing) or sweet (neutral) or scheme (the metal). **sweet is the shared neutral ground**
both can read without anyone's opinion.

**Every feature gets a home:**

| rung pair                         | features                                                                     |
| --------------------------------- | ---------------------------------------------------------------------------- |
| **scheme ⟷ sweet** (mechanical δ) | curly-infix · precedence-elision · accessor `[]` · colon-pairs · `%{}` dicts |
| **sweet ⟷ sugarcoat** (cognitive) | dot-method pipelines · `it` / anaphora · trailing lambdas                    |

**Why three, not two** (the Rhombus lesson): separating _mechanical-structural_ (sweet) from
_cognitive-ergonomic_ (sugarcoat) is the frozen-grouping / extensible-operator split. It keeps the
scheme↔sweet bifunctor **pure and total**, and confines all cognitive opinion to a **bounded, named**
place. Tangling them into one "our sweet" layer is exactly what smears editorial opinion into the
platform-faithful layer and breeds the quote-interaction / faithfulness confusion. Each bifunctor
stays a clean quotient lens _because_ the rungs are named.

---

## Standards offload vs owned delta

Directive: **offload every rung onto a named standard; own only what no standard covers and we need
badly.** Each cited standard is cognitive load we don't carry.

**scheme — 100% R7RS, own nothing.** `<datum>` (§7.1.2), the reader, quote/quasiquote/unquote, the
numeric tower, identifier syntax. Zero delta.

**sweet — SRFI-105 base + a small owned delta.**

| feature                  | offload to                                                                              | owned delta                                                                     |
| ------------------------ | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| curly-infix `{a + b}`    | **SRFI-105** (the reader)                                                               | only the precedence-elision licenses                                            |
| neoteric `f(x)`          | SRFI-105 tier-2                                                                         | **REJECT** — collides with `[]` / trailing-lambda (zero-maintenance divergence) |
| precedence               | shape: Swift/Fortress · **declaration: Haskell fixity `infixl/r N`** (or Prolog `op/3`) | the elision-canonizer hook + which ops get a license (arithmetic)               |
| `%{}` dict               | glyph: **Elixir**                                                                       | the reader rule (needed badly)                                                  |
| colon-pairs `name:`      | —                                                                                       | own (the kv/kwarg notation; ties to dicts)                                      |
| accessor `[a][b]`→`caar` | —                                                                                       | own — **MARGINAL**: `(caar x)` already works; cut candidate                     |

**sugarcoat — the cognitive layer; concepts borrowed, no reusable standard.**

| feature             | concept from               | owned delta                                                                                 |
| ------------------- | -------------------------- | ------------------------------------------------------------------------------------------- |
| `it` anaphora       | Graham `aif` / Kotlin `it` | reader form only — forced-by-anaphora, minimal                                              |
| trailing lambda     | Ruby/Kotlin/Swift blocks   | reader form only                                                                            |
| dot-method pipeline | (none)                     | **OWN — the heaviest delta**; sugarcoat's reason to exist; confirm it earns its maintenance |

**Meta-level offloads (the spec and the machinery itself):**

- grammar notation → **PEG** (Ford 2004) + **EBNF** (ISO 14977)
- correctness criteria → **Foster–Pierce lens laws** (GetPut/PutGet) + **quotient-lens laws** — we don't _define_ round-trip, we cite it
- lexer discipline → **Lisp reader macro-char algebra** (CLHS 2.4, non-terminating TIGHT prefixes) + maximal munch
- render/unparse algorithm → a standard **pretty-printer** (Wadler, _A prettier printer_); we own only the brace-elision _decisions_ (the license table), not the layout engine

**The owned delta, minimized — five things; everything else is offloaded:**

1. **precedence-elision licenses** — needed badly (arithmetic ergonomics); minimal (arithmetic + type-lens; shape _and_ declaration both borrowed).
2. **`%{}` dict reader** — needed badly (dicts ubiquitous; edit-stable sigil decided).
3. **colon-pairs** — needed (kv/kwarg notation).
4. **accessor `[]`** — KEEP (how people think about indexing; pure δ to c[ad]r). [V, 2026-06-15]
5. **dot-pipeline + `it` + trailing-lambda** — KEEP; the sugarcoat core (how people think). [V, 2026-06-15]

Both kept (2026-06-15): the discipline was never "cut human-ergonomics" — it's "don't _own_ what a
standard covers." Accessor and the pipeline are owned precisely because no standard covers _how people
think_, which is sugarcoat's job. Everything mechanical/standard offloads: R7RS · SRFI-105 ·
PEG/EBNF · lens-laws · the Lisp reader · a pretty-printer.

---

## The canonizer registry — read-normalize ⊕ render-emit in one bidirectional table

The deferred render half (`scheme → sweet` emit) and read-normalization are **one structure**: a table
of bidirectional rules — the canonizer of the quotient lens. This is **assembly of four named designs,
not invention** (the whole point: reuse).

**1. A row IS an _invertible syntax description_** (Rendel–Ostermann, Haskell 2010). Each row is a
_partial isomorphism_ `surface ⇌ canonical` carrying its own inverse; one description drives _both_
parse and print, and the per-row round-trip law `reads(emit(c)) = c` is their partial-iso law. (**Coq
`Notation`** is the same shipped: one declaration = parse + print, with `only parsing`/`only printing`
as the escape hatches. **Lean 4 `notation`** auto-derives the printer/delaborator.) We author one
description per row — never parse and print separately.

**2. "Preferred representation" IS _egg-style cost extraction_** (equality saturation, POPL 2021).
Keep _membership_ (which spellings are equivalent) **separate** from _which representative wins_ — the
latter is a tunable **cost/preference policy**, not forced by the rewrite. egg's exact discipline:
e-class = the equivalence; `extract`-by-cost = the representative. Our policy column: **prefer the
readable verb, except where a glyph is the better universal name (`=>` → glyph), and prefer the
brace-minimal form (precedence).** Because it's policy, not structure, it lives in one reviewable place.

**3. The anti-pattern we refuse = _two uncoupled tables_** (Common Lisp `readtable` vs
`*print-pprint-dispatch*` — no round-trip law, `read`/`print` free to drift). That drift is _literally_
what killed sweet-expressions (read, but no canonical `sweet-write`). One table + a per-row law is the
cure — and our moat (DV2).

**4. The working full-system precedent = _proof assistants_** (Lean / Coq / Isabelle): a **notation
layer** (bidirectional spelling table) over a **normalizer** (equality), kept as two separate
mechanisms over the same terms. We mirror it: the registry is the notation layer; the scheme rung is
the normal form.

**Row shape:**

```ts
interface Rule {
  canonical: Form;
  reads: (surface) => Form | null; // forward partial-iso  (parse / normalize): many → one
  emit: (Form, rung) => Surface | null; // backward partial-iso (print, per rung): one → preferred
  // law (Rendel–Ostermann):  reads(emit(c, rung)) === c   ∀ rung
}
```

The registry is a list of `Rule`s — two kinds, one interface:

- **Spelling rows** (atom-level, pure data — Coq-`Notation` style): `&&`⇌`and`, `==`⇌`equal?`,
  `??`⇌`or/maybe`, `=>` (alias). The §5.2b glyph map _is_ these rows.
- **Structural rows** (tree-level, `reads`/`emit` are functions — egg/normalization style):
  precedence-elision, accessor-folding, comma-optionality. The §5.2 elision-license table _is_ these
  rows' policy.

**This unifies the deferred render half with the read side.** `emit(canonical, sweet)` is exactly the
`scheme → sweet` render-elision we postponed; `reads` generalizes the ad-hoc normalization curly-infix
Phase 1 already does. The prior art (Rendel–Ostermann, Coq) shows the single structure _is_ the right
shape — and it shrinks the owned surface to **one registry + one loop**, every feature a row.

**Verification reuses the law.** Each row's round-trip (`reads(emit(c)) === c`) is unit-testable in
isolation — the way invertible-syntax combinators and Coq notations are; the suite runs every row both
ways over a corpus. (Same as the DV2 bifunctor coherence, checked per row.)

**Status:** render-half _spec_. Curly-infix Phase 1 (read) shipped; the registry generalizes its read
side and adds emit. Open: whether structural rows reuse a real e-graph or a hand-rolled matcher
(likely hand-rolled — our classes are tiny and known; egg is the conceptual reference, not a dependency).

---

## 1. Isomorphism to sweet — what we inherit, where we diverge

arrival-sugarcoat : SRFI-105/110 :: a _named extension_ : its _named base_ (the C++/C framing). The
mapping is tight, and the divergences are the design surface.

**Inherited (must honor, or we inherit sweet's failures):**

- **Pure pre-macro reader transform.** SRFI-105's strongest argument: `{…}`/`f(x)`/indentation
  desugar to ordinary lists _before_ macros run, so the rest of the language never knows. The moment
  a surface form needs semantic knowledge to parse, it stops being generic and re-derives the
  M-expression death. ([SRFI-105 rationale](https://srfi.schemers.org/srfi-105/srfi-105.html))
- **Generic, not per-operator.** The reader must not know `+` from `compose`. Spec-derived,
  construct-blind rules self-correct in unseen cases; per-construct special-casing drifts (our own
  "spec decides the cuts, never taste" line).
- **Backwards-compat with s-expressions** — any `(…)` is a fixed point; we _add_ surface, never
  reinterpret existing forms. (Auto-infix turning `(Jack and Jill)` into `(and Jack Jill)` is the
  canonical silent-reinterpretation bug.)

**Diverged (each a live decision, not an accident):**

| #       | sweet                                                                                  | arrival-sugarcoat                                               | status                                                                                                                                   |
| ------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **DV1** | curly-infix is **precedence-FREE**; mixed ops → undefined `$nfx$`, deferred to the app | precedence = **elision licenses** in the δ-canonizer            | ✅ decided 2026-06-15 — Swift's partial-order shape via our quotient lens; arithmetic + type-lens license, boolean licenseless; see §5.2 |
| **DV2** | **no `sweet-write`** — read-only, can't canonically print (the adoption killer)        | the **bifunctor render** (`render∘⟦⟧ = id`) is the whole thesis | ✅ our structural advantage — _we are the sweet that round-trips_                                                                        |
| **DV3** | stops at infix + neoteric + indentation                                                | adds **method-dot, colon-pairs, dict-sigil**                    | the net-new surface this doc scopes                                                                                                      |
| **DV4** | targets **human** adoption (stalled on cultural inertia)                               | targets an internal **two-face (human ⇄ AI)** bifunctor         | ✅ adoption is moot; payoff = machine-verifiable wins (purity, round-trip, replay)                                                       |

**The isomorphism's punchline:** the _constraints_ are identical (generic · homoiconic · pre-macro ·
backwards-compatible); only the _targets_ differ. DV2 is the one that matters most — sweet died in
part because it could be read but not canonically re-emitted ("`sweet-write` is essentially
pretty-printing, left to quality-of-implementation"). Our bifunctor is precisely that missing print
side. **Never trade it away for a surface convenience** — a form we can't render is a form that
breaks the two-face contract.

---

## 2. Grammar design — edit-stability is the gate

**The canonical failure is the JS block-vs-object knife-edge.** `{…}` is a _block_ at statement
position and an _object_ in expression position — same characters, category decided by _what
precedes it_, no interior marker. A trivially small edit (delete a leading `(`, paste at line start)
**silently re-categorizes** with no error. The same family recurs: arrow body-vs-object (`() => {}`
vs `() => ({})`), `}` `/` regex-vs-division, `async`/`yield` contextual keywords.
([V8 cover grammars](https://v8.dev/blog/understanding-ecmascript-part-4) ·
[jsparagus js-quirks](https://github.com/mozilla/gecko-dev/blob/master/third_party/rust/jsparagus/js-quirks.md))

This is exactly V's parity catch generalized: **valid curly-infix is an odd element count
(operand·op·operand…); a kv-set is even (pairs); a single-token edit flips parity by one, so the
category boundary sits one keystroke away in every body.** Content/position discrimination is
_unstable by construction_ — any content-based binary classification has a boundary in content-space
that edits cross. The fix is not a smarter rule; it is moving the discriminator **out of the body
into a fixed leading marker** (sigil/keyword/delimiter), so the decision is _local and bounded_ and
an interior edit cannot reach it.

**The deferral discipline (when a fixed marker is impossible).** ECMAScript's
`CoverParenthesizedExpressionAndArrowParameterList`: parse a permissive _cover_, then decide on a
single _trailing discriminator_ (`=>`) plus an **early-error** backstop. This restores locality
without unbounded lookahead. Keep it in the toolbox for any case where the leading marker genuinely
can't fix the category.

**Parity grammars are doubly fragile** (precedence + associativity + V's operand/operator parity).
Never write naive `E ::= E op E`; use **Pratt / precedence-climbing**. Structure editors counter the
parity-edit by inserting an _operator hole_ to preserve alternation across the edit. **Our analogue
is deeper and free:** in the two-face model the _AI edits the canonical s-expr_ (structure, no
parity), and only the _human_ edits surface text. So surface parity-fragility is a human-face-only
concern, fully mitigated by render-from-canonical — the editor that's most exposed to the knife-edge
isn't holding the knife. ([Pratt parsing, matklad](https://matklad.github.io/2020/04/13/simple-but-powerful-pratt-parsing.html) ·
[Material Obligations, arXiv 2508.16848](https://arxiv.org/pdf/2508.16848))

**The operational test — adopt as a hard design gate:** _for every surface form, ask "does any
single-token textual edit (add/remove a delimiter, paste at a different position) silently flip its
grammatical category?" If yes, add a fixed marker or required discriminator until the answer is no._
That sentence is the formalization of "bare `{}` is broken," and it should sit at the top of the
arrival-sugarcoat spec as the acceptance criterion for any new form.

---

## 3. Lexer design — sigils, adjacency, context-freedom

**Maximal munch is greedy and non-backtracking**, so multi-char openers that share a prefix can
silently mis-cut (`a+++++b` → `a ++ ++ + b`; `/*` swallowing a division). **Audit prefix overlap
before minting any sigil.** Our luck: `%` is unused as an operator (modulo is spelled `modulo`), so
`%{` shares no prefix and a paired delimiter sidesteps the operator-stacking class entirely —
bracket nesting is matched by pairing, not by munch. ([Maximal munch](https://en.wikipedia.org/wiki/Maximal_munch))

**Adjacency (TIGHT) is the mechanism, not a convention.** Lisp's `#`, `'`, `,@` are _non-terminating_
reader prefixes: they don't end the current token and bind to the immediately-following form with no
whitespace. That is _why_ `#(`, `'x`, `,@x` read as one unit — and it's the same TIGHT rule
arrival-sugarcoat already uses for trailing-lambda/args. A dict opener rides it directly: `%{` tight =
dict-open; decide up front whether `% {` (spaced) is two tokens or an error, and _document it_.
([CLHS 2.4.8 sharpsign](http://www.lispworks.com/documentation/lw51/CLHS/Body/02_dh.htm))

**Dispatch namespaces the extension point.** Clojure/CL funnel _all_ new reader syntax through one
dispatch char (`#{}` set, `#"…"` regex, `#uuid …`) so the base table stays small and new sigils
can't collide with existing macro chars. The conservative move, if we expect _many_ literal types,
is `#…{…}`-style dispatch rather than minting fresh terminating chars. For a _single_ paired-delimiter
literal, a bare `%{` is acceptable; the dispatch route is the hedge against sigil sprawl. (Note the
collision to avoid: `#{}` is _set_ in Clojure — don't borrow it for dict; `%{}` is _map_ in Elixir,
which is the better-aligned prior art.) ([Clojure reader](https://clojure.org/reference/reader))

**Keep the reader context-free.** No lexer-hack, no semantic feedback into tokenization. Resolve
`%{…}` purely from the character stream; defer any role/type classification to a later pass (the
Clang model). This is the same discipline as "pure pre-macro reader transform."

**Indentation, if ever:** layer it as a _pre-reader token rewrite_ (INDENT/DEDENT over Python's
indent-stack), never touch the s-expr reader; suspend it inside explicit brackets; make it
tab-width-independent-or-reject; keep it optional and erasable (`indent → parens → identity`).
But weigh §5.4 first — significant whitespace buys readability and _sells_ fragility.

---

## 4. The dict decision, grounded

The research converges hard on V's landing: **a paired-delimiter sigil that fixes the category at the
opener.** Elixir's `%{name: "x", age: y}` is the exact prior art — map literal, category in the
delimiter (`%{` vs `{`), values evaluated (no quote/inert baggage), edit-invariant by construction.
It beats both rejected options for _named_ reasons:

- **beats content-discrimination** (bare `{}` disambiguated by colon-keys): that's the parity
  knife-edge of §2 — unstable by construction, a single-token edit flips executable↔dict silently.
- **beats `'{}`** (quote-marker): quote is the right _instinct_ (marker in the delimiter) but the
  wrong _glyph_ — it drags in inert, recursive, unevaluated semantics, so it can only ever be the
  _literal-data_ dict, and an evaluated `'{}` would make the human-face (evaluated) and AI-face
  (`(quote …)` = inert) disagree on what quote means — a stability violation at the syntax level.

**The quote-family is deferred, not dead.** `'{…}` (inert data) and `` `{…} `` (template with `,`
holes) remain the homoiconically-correct pair _mirroring_ `'()`/`` `() ``/`(list …)` — but only once
their interaction with quote/quasiquote/unquote is specified up front (§5.1). They are a _later,
separate_ superset, not this one. The everyday evaluated dict is `%{…}` (and `(dict name: v …)`
via colon-pairs stays the constructor workhorse).

**Which meaning gets bare `{}` is the one real frequency call** (correctness is settled either way,
because both put the category in the delimiter): keep `{}` = infix (built, non-breaking) with dict =
`%{}`, **or** honor "braces are a kv-set" and move infix onto a sigil (breaks the built "piped
triplets," but marks the rarer thing). Decide by which you write more and what you're willing to
migrate — not by correctness.

---

## 5. Risks to hold (the catalog, mapped to us)

**5.1 — Quote/quasiquote/macro interaction is the deepest hazard.** Both sweet layers' worst
surprises cluster at `'`/`` ` ``/`,`/`,@`: a leading quote followed by whitespace swallows the
_entire_ sweet-expression including indented children, "fundamentally changing macro behavior."
Rhombus's load-bearing mitigation is **quote-invariance** — the notation parses identically inside
and outside quoted forms. **Rule:** every new surface form must define its quote/quasiquote/unquote
interaction _before_ it ships. This is the concrete reason `'{}`/`` `{} `` wait.

**5.2 — Precedence-ambiguity creep (our DV1, the sharpest open question).** Wheeler's taxonomy gives
three bad options: global fixed table ("limits extensibility"), per-expression declarations
(verbose), fixed rules. SRFI-105 _rejected precedence entirely_ on **empirical** grounds —
experienced programmers get precedence right only 66.7% of the time, and 71% of real curly-infix
expressions nest no braces, so precedence is mostly irrelevant — deferring mixed-ops to an undefined,
app-bound `$nfx$`. Rhombus chose the sophisticated middle: **relative per-operator precedence +
hygiene via binding spaces**, no global table. Our 6-level ladder was the global-fixed-table option —
the one both sources flag as riskiest.

**Decided (2026-06-15): precedence = elision licenses in the scheme↔sweet δ-canonizer.** Precedence
is _not_ a grammar feature we add (Swift bakes a partial order into the parser) — it is the
**quotient-lens canonizer we already have**, pointed at braces. The canonical form (scheme) is always
fully parenthesized; precedence only governs which braces the **sweet** rung may _elide_ and
_recover_. A precedence relation = an **elision license**: "render may drop this child's braces; read
may restore them." Same δ-machine as `caar ≡ car∘car` and comma-as-whitespace — braces are
materialization, the tree is intent, the license table quotients the intent-irrelevant braces. Swift
gives the partial-order _shape_; the quotient lens gives the _mechanism_, with two consequences Swift
can't reach.

**License sources:**

- **arithmetic** — `* / modulo quotient remainder` over `+ -` (left-assoc), unary minus,
  right-assoc exponent if added. Licensed because PEMDAS is overlearned to automaticity.
- **the type lens** — for cross-type mixes (`+`/`<`: different result types ⇒ a unique well-typed
  parse), the oracle grants the license _dynamically_. Swift has no oracle and cannot do this.

**Licenseless by default = braces stay.** Boolean mixing (`&&`×`||`, anything with `??`), comparison
chains — no license, braces never elided. Crucially **not an error path** (Swift errors on "unordered
groups"): render just emits the explicit form (`(|| a (&& b c) d)` → `{a || {b && c} || d}`),
unambiguous and total. The _only_ error surface is a human **typing** a bare ambiguous form
(`{a || b && c}`), which read turns into an **errors-as-door** ("brace it") — never a grammar-category
failure, because the canonical form is never ambiguous; only input can be. Same-operator runs always
fold (`{a && b && c}` → `(and a b c)`), licensed trivially; the glyph map (`==`→`equal?`, `&&`→`and`,
`||`→`or`) survives.

Prior art for _forbid-don't-lint_: **Pony** (no infix precedence; mixed ⇒ compile error), **Fortress**
(partial order; parens where intuition is unreliable), **JS `??`** (the one mainstream
grammar-mandated-parens case). We get their outcome _minus the machinery_, because the elision frame
makes "licenseless" the harmless default, not a special prohibition. `render∘⟦·⟧ = id` holds by
construction (render mirrors read over the same license table).

**5.2b — Glyph map: every glyph lowers to a readable verb (deferred sweet feature).** Decided
(2026-06-15): the canonical s-expr (scheme rung) uses **readable words, never C-glyphs** — glyphs are
a human-face shorthand that lower to verbs on read and render back on emit (a `scheme ⟷ sweet`
δ-quotient). The map covers exactly the glyphs that differ from a readable Scheme name:

| glyph  | verb       | note                                                                                                                                                                 |
| ------ | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `==`   | `equal?`   | structural equality                                                                                                                                                  |
| `&&`   | `and`      |                                                                                                                                                                      |
| `\|\|` | `or`       | coalesce on `#f`                                                                                                                                                     |
| `??`   | `or/maybe` | coalesce on **`Nothing`** — a one-line alias of the existing `maybe-ref/default` (Maybe `Just`/`Nothing` lives in `bootstrap.ts`); `or`:`#f` :: `or/maybe`:`Nothing` |

Operators that are _already_ readable Scheme names stay verbatim (`+ - * / < > <= >= = eq? eqv?
equal? modulo quotient remainder`) — the map only rewrites the four glyphs above. Owned cost ≈ zero:
three lower to existing special forms; `or/maybe` is a single alias line.

**Lexer caveat (found in curly-infix Phase 1):** `||` is R7RS pipe-symbol syntax (`|sym|`), so the
glyph layer must recognize `||` as a glyph **before** the pipe-symbol reader. `&&`/`==`/`??` lex as
ordinary symbols and are simply rewritten in operator position — only `||` needs special lexing.
**Status:** not in curly-infix Phase 1 — until the glyph layer lands, `{a && b}` reads to `(&& a b)`
literally.

**5.3 — Round-trip print is the adoption-killer, and it's our moat — don't lose it.** sweet could be
read but not canonically printed; that broke the data↔code symmetry homoiconicity exists for. Our
bifunctor _is_ the print side. So the constraint is non-negotiable: **`surface→core→surface = id` for
every form, or the form doesn't ship.** A one-way authoring convenience is the "lens lies" trap.

**5.4 — Significant whitespace buys readability, sells fragility — price it explicitly.** Neoteric's
no-space rule and sweet's indentation each manufacture _invisible_ wrong-parse bugs (stray space
before `(`, accidental indent after a blank line). Mitigations are external and real: an `!`-style
transport-survival hatch, tab/space error, editor highlighting. For an AI-primary editor the calculus
shifts further against indentation — the AI reads structure, gaining nothing from layout, while
inheriting all the invisibility risk on the human face. Lean toward _visible delimiters_; treat
indentation as a high-bar, separate decision.

**5.5 — Refuse reader-extensibility (Clojure's key move).** The most important risk decision may be
_what you refuse to make extensible._ User-defined reader macros make a file's _parse_
config-dependent (the CL fragmentation). arrival-sugarcoat should stay a **closed, enumerated set of
departures** (it already is — the registry discipline). Surface _richness_ (more literal types) is
fine; surface _extensibility at the reader_ is not. Bounded tagged-literals / sigils are the escape
hatch if we ever need user types.

**5.6 — The two-languages cognitive split** (Steele & Gabriel: "reinvent Algol for Lisp, then reject
it"). Mitigated structurally by our model: the canonical s-expr stays authoritative; the surface is a
faithful, _reversible projection per reader_, not a fork. The bifunctor is the anti-fork guarantee —
as long as DV2/5.3 hold.

**5.7 — Adoption is the "tool that fails when you need it most."** Historically (IACL2, BitC, RLisp)
supersets that cover the easy 90% and break at the edges get abandoned, because users can't trust a
notation that _sometimes silently doesn't mean what it looks like_. **Predictability > ergonomics of
the common case.** This is the same value as §2's edit-stability gate, restated as adoption physics —
and it's why the parity knife-edge was correctly fatal, not a nitpick.

---

## 6. Alternates to keep in mind

- **Rhombus / shrubbery notation (the deepest model).** A **two-layer split**: shrubbery is a
  _frozen, universal_ notation doing only **partial grouping** (groups by indentation, blocks via a
  trailing `:`, alternatives via `|`, explicit parens that _don't_ disable indentation), defined once
  and **applying identically inside and outside quotes**; on top sits **enforestation** — a
  Pratt-style, _expansion-time_ operator parser where precedence/associativity are **relative per
  operator** (not a global table) and resolution is hygienic via binding spaces. This cleanly
  separates _fixed grouping_ from _extensible operator parsing_, which is how it gets human infix
  **and** full macros without forking (Dylan) or making the reader config-dependent (CL). **The
  question it poses to us:** is arrival-sugarcoat's grouping vs operator-parsing cleanly two-layered, or
  tangled in one reader pass? Two-layering is what makes quote-invariance (5.1) and precedence
  flexibility (5.2) tractable at once.
  ([shrubbery README](https://github.com/mflatt/rhombus-prototype/blob/shrubbery/shrubbery/0000-shrubbery.md) ·
  [Rhombus OOPSLA'23](https://users.cs.utah.edu/plt/publications/oopsla23-faadffggkkmppst.pdf))
- **Clojure** — rich reader _data_ literals (`[]` `{}` `#{}`, commas-as-whitespace) but a deliberate
  **refusal** of user reader-macros; bounded tagged literals instead. Teaches §5.5 and the
  comma-as-whitespace move directly. ([reader](https://clojure.org/reference/reader))
- **Elixir** — `%{}` maps, `%Struct{}`, user **sigils** (`~r//`, `sigil_X`): _user-extensible
  literals without user-extensible grammar_, over a stable AST with a `quote` boundary. The direct
  prior art for `%{}` and for "bounded literal extension." ([quote/unquote](https://hexdocs.pm/elixir/quote-and-unquote.html))
- **Julia** — surface → canonical `Expr` AST → macros-over-AST (never macros-over-surface). Proof that
  rich human surface and Lisp-style macros coexist _iff_ macros operate on the canonical form.
- **Wisp (SRFI-119)** — the cheapest viable point: a reversible indentation→parens reader layer with
  **zero new semantics**. The floor to beat for any feature's complexity budget.
  ([SRFI-119](https://srfi.schemers.org/srfi-119/srfi-119.html))
- **Dylan / the graveyard** — infix bolted on either _forks_ the language or _breaks_ the
  metaprogramming the homoiconic core existed for. Survivors fully committed to surface→canonical-AST;
  straddlers died. The cautionary baseline.

---

## 7. Open design questions (for V — decisions, not defaults)

1. **Bare `{}`: infix or dict?** Frequency + migration call. Both edit-stable (category in delimiter).
2. ~~**The precedence ladder (DV1)**~~ — **RESOLVED 2026-06-15: precedence = elision licenses** (§5.2).
   Not a grammar feature — the δ-canonizer's brace-elision table. License sources: arithmetic
   (overlearned) + the type lens (cross-type). Boolean mixing licenseless ⇒ braces stay (no error on
   render; bare ambiguous input on read = errors-as-door). Same-op runs fold; glyph map survives.
3. **`%{}` bare sigil vs `#…{}` dispatch:** bare is fine for one literal; dispatch hedges against
   sigil sprawl if more literal types are coming. How many literal types do we foresee?
4. ~~**Two-layer structure**~~ — **RESOLVED 2026-06-15: the trimorphism** (`scheme ⟷ sweet ⟷
sugarcoat`, see the trimorphism section). The two named bifunctors _are_ the layer separation:
   scheme↔sweet (mechanical, frozen, opinion-free) and sweet↔sugarcoat (cognitive, bounded). The rungs
   make the mechanical/cognitive boundary explicit instead of fuzzy.
5. **Indentation: in or out?** §5.4 says the AI-primary editor tilts against it. Default to _out_
   unless a concrete human-readability win justifies the invisibility tax.
6. **Adopt the §2 operational edit-stability test as the spec's acceptance gate?** (Recommended: yes —
   it's the formal statement of why bare `{}` was broken, and it auto-rejects the next knife-edge
   before it's built.)
