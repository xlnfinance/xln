# The Static-Analysis Plane

> The mental model, stated once, ahead of the code. Arrival runs every program twice at
> once — computation over values, provenance over boxes (P0). The SAME tagless program
> admits a third family: **static interpreters that read the program without running it.**
> Four of them ship. The type lens reads the TYPE at a cursor slot; the oracle's S/Σ
> layers read the STRUCTURE and the bound-symbol set of a prefix; the static validator
> reads the REFERENCE GRAPH and reports what will not resolve; the static lineage
> classifier reads the PROVENANCE SHAPE off the AST. This document says what each reader
> answers, the single law they all obey, and why each must AGREE with a runtime layer
> rather than merely coexist with it.

Section anchors are CAPS so code comments can cite `docs/static-plane.md §<ANCHOR>`. Each
section closes with its enforcement sites (files, no line numbers — those rot). Every
claim here is grounded in those files; when code and this document disagree, one is a
bug — decide which before writing a line.

Constitutional ground: `PRINCIPLES.md` — **P0** (the static-interpreter family: the type
lens, the oracle's structural/Σ layers, the static lineage classifier are named there as
interpreters of the same terms that must AGREE with the runtime pair), **P3** (types tell
the truth — the type lens's charter), **P14** (staging done right: the lineage classifier
is a whole future interpreter, present in the tree, gated), **P15** (the agreement law —
the strongest suites are interpretation-agreement laws). `PROVENANCE.md` OWNS runtime
lineage (§2 the declaration-role vocabulary the classifier reads, §7 the laws); this
document owns only the pre-execution lens FACE of it. `environments.md §CONTRACT` (the type
lens is the harvested-`.d.ts` reader — one of the contract's four codec-readers that must
agree) and `§AXES` (the provenance role the classifier reads off each bound value, P7).
`grammar.md` (the reader surface the oracle scans). The constraint-kernel contract the
oracle implements is CROSS-PACKAGE — `sift/docs/CONSTRAINT-KERNEL-SPEC.md`, its interfaces
`sift/src/sampler/oracle-contract.ts`, its reference reader `sift/src/sampler/prefix-oracle.ts`;
this document points at that spec, it does not fork the model.

---

## 1. THE PLANE — four static readers over one program

**The plane is four interpreters that read the tagless program WITHOUT executing it, each
answering a different static question, each bound by law to AGREE with a runtime layer.**
The two runtime interpreters (value plane, box plane) run in lock-step; the static plane
is the third family P0 admits — tagless-final is exactly the property that lets N
interpreters share one program, and the static ones must not contradict the runtime pair
they shadow.

| Reader                        | Reads                              | Answers                                                                                        | Runtime layer it must AGREE with                                                |
| ----------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| **type lens**                 | the TS lowering of a scheme prefix | the type at the cursor's argument slot; which candidates are type-valid there                  | the membrane's zod contract (`§CONTRACT`'s four codec-readers)                  |
| **oracle S/Σ**                | the raw prefix, single-pass        | structural parse state (depth, position, closeable) + the bound-symbol set legal at the cursor | the reader/evaluator (structure) and the assembled env (Σ = the grant boundary) |
| **static validator**          | the parsed program × a vocabulary  | the complete diagnostic list — what will not resolve, and why                                  | the resolution chain at runtime (an `error` promises a real crash)              |
| **static lineage classifier** | the parsed AST                     | the lineage SHAPE (pipe/merge/fan/mux) + its full/demand cone                                  | the eager per-op provenance stamp (the untapped box plane)                      |

**Agreement is a law, not an aspiration — and it is per-pair, with an executable gate for
each (§AGREEMENT-GATES).** What "agree" means differs by pair because each reader shadows
a different runtime fact: the oracle-S structural verdict must equal the reference reader's
byte-for-byte over a conformance corpus; the classifier's `fullCone` must equal the eager
stamp on the programs where the static cone coincides with the taken run; the validator's
`error` tier must raise no diagnostic a runtime resolution would have answered; the type
lens reads the same zod schema the runtime membrane decodes, so a divergence is a printer
bug, not a policy choice. The direction of safe disagreement is the subject of §2.

**Enforcement sites:** `arrival-lsp` `getTypeValidCandidates` / `typed-scanner.ts`, `oracle/scanner.ts`, `oracle/sigma.ts`,
`static-validation/validate-program.ts`, `provenance/lineage.ts`.

---

## 2. CONSERVATIVE NARROWING — one law, four voices

**Every static reader OVER-APPROXIMATES toward the side that cannot falsely reject a valid
program, and DEGRADES to the unconstrained answer on any uncertainty — a wrongly-tightened
verdict is a DEFECT, never a tradeoff.** This is the single home for a law the code
currently states in four voices; here it is stated once, and the four instantiations are
named. The law is P15's agreement discipline made operational: a static interpreter that
must AGREE with runtime may be LESS restrictive than the runtime, never MORE — the exact
`origin ⊇ dependencies` shape the membrane's additive law rests on (`membrane.md §INBOUND`:
over-approximation is safe, under-approximation is fatal), transposed to four planes. Which
answer is "the safe side" is fixed by what the reader would break if it tightened wrongly:

1. **Type lens — DROPS-ONLY.** An axis narrows ONLY when it can PROVE the constraint (a
   candidate PROVABLY ill-typed at a slot that is provably not `any`/`unknown`/`never`/
   out-of-range). On ANY uncertainty it returns the unresolved value — the candidate list
   unchanged, or `null`. Stated in `arrival-lsp` `typed-scanner.ts` as conservative by
   construction: `getTypeValidCandidates` keeps any candidate it can't prove ill-typed.
   A false drop would forbid a token the runtime would have accepted.
2. **Oracle Σ — NEVER DROP A LEGAL SYMBOL.** The scope walk is a decoder-sound
   over-approximation: a binder joins scope the instant its atom completes and stays for
   the whole frame; with no env, Σ returns `null` (graceful degradation — "Σ not modelled,
   do not constrain symbols"). A false drop would mask a symbol the sandbox actually bound.
3. **Static validator — DEGRADE TO WARNING, NEVER A FALSE POSITIVE.** The `error` tier
   advertises no spurious `unbound-symbol` (modulo the one documented dead-branch
   reachability divergence, opt-out on the exec knob). Anything the pass cannot prove
   degrades to `warning` (the impure-resolver downgrade) or is not emitted (the macro
   firewall — a binder-macro formal stays opaque-equivalent until a binding-aware walker
   exists). A false error would abort a program that would have run.
4. **Static lineage classifier — OVER-ATTRIBUTE THE CONE.** The `mux` cone is the
   conservative `selector ∪ arms` (the taken arm is a runtime fact); a `fan` over-attributes
   cardinality; an undeclared op falls to `pipe`; a body that reaches a port collapses to
   `opaque`. Every widening keeps the reported origin a SUPERSET of the true one — the
   precondition `uneval`'s Galois slicing rests on. A cone that UNDER-attributed would omit
   the form that produced a value, and the re-run could not reproduce it.

**The four voices are one rule seen from four planes: err toward the answer a sound
runtime would also accept.** Keep-the-candidate, keep-the-symbol, suppress-the-error, and
widen-the-cone are the same move — refuse to tighten past the proof — because each reader's
untightened answer is the one that stays TRUE when the runtime finally executes.

**Enforcement sites:** `arrival-lsp` `typed-scanner.ts` (drops-only), `oracle/sigma.ts` (Σ never
drops), `static-validation/validate-program.ts` (degrade-to-warning soundness contract),
`provenance/lineage.ts` (conservative cone).

---

## 3. THE Σ∩T NARROW — structure ∩ type

**Constrained decoding narrows the next token by intersecting Σ (the bound-symbol set the
oracle proves legal by SCOPE and STRUCTURE) with T (the subset the type lens proves
TYPE-VALID at the slot).** The two halves compose drops-only from both sides: Σ never
drops a legal symbol (§2.2), T never drops a valid candidate (§2.1), so the intersection is
itself a sound over-approximation — it forbids a token only when BOTH readers would.

**The thesis that makes T tractable: "Scheme is a TS subset except lists and pairs."** The
language service emits a scheme prefix to TypeScript (`arrival-types-bridge` `emitTypes`),
compiles it against the harvested prelude, and reads the type at the cursor's argument
slot back off the checker. Because scheme code (minus its list/pair spine) maps onto a TS
expression, `Parameters<typeof callee>[i]` IS the slot's expected type, and TS's own
assignability answers "does this candidate fit here." The half that handles the exception —
lists and pairs — is the carrier vocabulary (`List<T>`, `ElemOf`, `SlotKind`,
`AcceptsBareWord`) the lens compiles alongside the prelude.

**Where each half lives.** Σ is `oracle/sigma.ts` — `scanScope` (the pure lexical-binder
walk) plus `computeValidSymbols` (position-filtered union of the discovery env's
`boundSymbols()` and the prefix's own lexical locals). T is `arrival-lsp`
`getTypeValidCandidates` — it takes the sampler's Σ candidates and returns the type-valid
subset, plus the slot-shape probes (`getSlotIsArray`, `getSlotElementType`,
`getSlotAcceptsBareWord`). `typed-scanner.ts` intersects them. Neither half is complete
alone — Σ knows the symbol is BOUND, T knows it FITS.

**Enforcement sites:** `oracle/sigma.ts` (Σ), `arrival-lsp` `service-core.ts` /
`typed-scanner.ts` (T), `type-layer/schema-to-ts.ts`, `type-layer/prelude.ts`,
`type-layer/carriers.ts`.

---

## 4. THE FOUR READERS

### 4.1 TYPE LENS — harvested prelude + language service

**One compile per probe: insert a sentinel at the cursor, balance the mid-edit prefix,
emit to TS, walk to the enclosing call, then read the slot type and each candidate off ONE
`TypeChecker`.** Never a compile-per-candidate. Constrained-decode T lives on the language
service (`arrival-lsp` `getTypeValidCandidates`); an unresolved slot returns the
superset-safe no-op. A candidate is kept when its value OR (used as a sub-call head) its
awaited RETURN type is assignable, so a list-returning symbol survives at a list slot.

**The type lens is the ONE static reader that carries a real `typescript` dependency, and
that dependency is quarantined by the emit/index.ts layering rule.** T and the LanguageService
live in `arrival-lsp`; diagnose and the harvest printer stay in `type-layer`. The
compiler-facing `emit` subpath stays `typescript`-free so a Contract can carry emit rules
without dragging the checker into arrival core — the "type-layer anti-pattern" that barrel
names and refuses. The `.d.ts` printer (`type-layer/schema-to-ts.ts`) is the harvest reader of
`§CONTRACT`'s four-reader agreement: it reads the SAME zod schema the runtime membrane
decodes, so the type it prints and the type the membrane enforces cannot diverge without a
printer bug.

**Enforcement sites:** `arrival-lsp` `service-core.ts` / `typed-scanner.ts`,
`type-layer/schema-to-ts.ts`, `type-layer/diagnose.ts`, `type-layer/prelude.ts`,
`type-layer/index.ts`, `emit/index.ts` (the layering rule).

### 4.2 ORACLE S/Σ — the constrained-decoding structural + scope walk

**Every method is a PURE FUNCTION OF THE ACCEPTED PREFIX — no lookahead, no backtracking —
so the constraint aligns with autoregressive generation** (the model emits token t from
1..t−1 and never revises). Layer S (`oracle/scanner.ts`) is a single-pass structural reader,
NOT the Lexer FSM: the oracle is defined on TRUNCATED input where the Lexer throws
`Unterminated`, so S reports `{ inString }`/`{ inComment }` gracefully where the Lexer
crashes. It ports the proven single-pass semantics of the constraint-kernel reference reader.
Σ (`oracle/sigma.ts`) refines the structural `atom` class into the position-filtered set of
bound identifiers: operator position ⇒ callables only; argument ⇒ any bound symbol; top /
quote ⇒ unconstrained. Σ is live only when given an env — the grant boundary the sandbox's
binding set enforces for free.

**The contract is a DRIFT-ALARM mirror of a cross-package canonical, not a local invention
— SATELLITE POINTER.** `oracle/contract.ts` re-declares `sift/src/sampler/oracle-contract.ts`
verbatim rather than importing it, because arrival-scheme is a foundation package sift
depends on; importing sift types would invert the dependency arrow. The two copies must stay
type-identical, and the **O0 conformance corpus** is the executable proof they do (§5). Do
not fork the constraint-kernel model here; the spec lives in
`sift/docs/CONSTRAINT-KERNEL-SPEC.md`.

**Enforcement sites:** `oracle/scanner.ts`, `oracle/sigma.ts`, `oracle/contract.ts`,
`oracle/env.ts`, `oracle/index.ts`.

### 4.3 STATIC VALIDATOR — the reference graph and its doors

**The compiler's front door: parsed forms × a vocabulary → the COMPLETE diagnostic list,
one eslint-style pass, never crash-on-first — only the caller (`exec`) throws.** Missing
things are FIRST-CLASS GRAPH NODES (`static-validation/reference-graph.ts`), so every
diagnostic is a graph QUERY, not encounter-order reporting, and cascade fusion falls out
structurally: one absent `fs` key disabling `require` + `require/extension` across 7
references is ONE diagnostic with 7 sites, keyed by the CURE. The three live buckets —
`unbound-symbol`, `missing-configuration`, `bound-to-door` — each read a node population.
Doors are the errors-as-doors surface here: a referenced `notImplemented` or degradation
door reports with its owner and teaching reason, and a suggestion is offered only from the
SATISFIED subset (a door is never proposed as a typo fix — a suggestion that re-errors on
the next round-trip destroys agent trust).

The soundness contract (§2.3) closes four leak sources by construction — keyword/special-form
heads, binder-macro formals, program-level macro names, internal-define sequences — and the
one deliberate divergence from runtime semantics (a dead-branch reference reports by design)
is opt-out on the exec knob. Vocabulary assembly and the reference walk are the composed
machinery.

**Enforcement sites:** `static-validation/validate-program.ts`,
`static-validation/reference-graph.ts`, `static-validation/collect-references.ts`,
`static-validation/vocabulary.ts`, `unbound-variable.ts`.

### 4.4 STATIC LINEAGE CLASSIFIER — the pre-execution cone

**`classify()` reads a lineage SKELETON off surface reader Pairs BEFORE execution
(operand-arity over non-literal operands); runtime only stamps Rosetta leaf-ids into the
skeleton's slots.** One tree answers both the teleological `fullCone` (walk to every leaf —
the seal's "provenance everything") and the minimal demand cones (`countCone`, `fieldCone`).
The op's role is READ FROM THE DECLARATION — `roleOf` reads `.provenanceRole` off the
env-bound callable (`provenance/lineage-classifier-from-env.ts`), never guessed from the name
or duck-read off an ad-hoc property (P7). Special forms `classify` models by shape
(`if`/`cond`/`let`/`begin`/`and`/`or`/`lambda`/`do`) are kept in lock-step with
`CLASSIFIED_SPECIAL_FORMS`; forms it does not model fall through and are safe only because
the shadow skips them as macro-heads.

**This section owns only the pre-execution LENS FACE. `PROVENANCE.md` owns runtime
lineage** — the eager stamp, the trace-tap, the region/track/wire graph, γ-replay. The
classifier is a whole future interpreter, present in the tree and gated (P14) by the G1–G7
ledger: its `fullCone` is proven directly against the eager stamp (the old shadow-mode
`irLineage` flag and `provenance/lineage-shadow.ts` are retired, Stage C Cut 3b — `provOf`
now lives in `provenance/lineage.ts` itself and the golden-prov/checkpoint/conservation law
suites read it straight), the graph-layer node kinds (`sink`, `transparent`, `binder`) are
reachable by `classify` but wired to no live declaration yet. Cross-link, don't
duplicate: the runtime provenance machinery is `PROVENANCE.md`'s.

**Enforcement sites:** `provenance/lineage.ts`, `provenance/lineage-classifier-from-env.ts`,
`provenance/__tests__/lineage-checkpoint.test.ts`.

---

## 5. AGREEMENT GATES — the executable proof per reader

**Each reader's agreement with its runtime layer is pinned by a committed, continuously-run
test; the drift story is that a divergence outside the reader's declared safe direction is a
THROW, never a silent pass.** These are P15's interpretation-agreement laws — a coherence law
between two interpretations, not a point assertion.

| Reader                 | Gate                                                                                                              | What it proves                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **oracle S/Σ**         | O0 conformance corpus (`src/__tests__/oracle-contract.spec.ts`)                                                   | arrival's structural reader AGREES with the inlined canonical reference reader on every shared structural field, over every prefix of a scout-program corpus (valid / truncated / misnested / mid-token); `feasible()` matches; the resumable session and from-scratch `analyze` agree                                                                                                       |
| **lineage classifier** | checkpoint law (`provenance/__tests__/lineage-checkpoint.test.ts`)                                                | `fullCone(skeleton, bindings)` equals the eager interpreter's `provOf` stamp (both now read straight off `provenance/lineage.ts`); the golden-prov and conservation law suites read the same `provOf` reader independently. A new `LineageNode` kind without a walker arm is a COMPILE error (`assertNever` exhaustiveness in `walk()`), converting a silent under-cone into a build failure |
| **static validator**   | the static-validation law suite (`src/__tests__/laws/static-validation.law.test.ts`, `oracle-optout.law.test.ts`) | the six named laws — cascade fusion, suggestion soundness (no door suggested), all-at-once (no crash-on-first), the macro firewall (no false positives), SPECIAL_FORMS no-FP, internal-define letrec\* scoping — plus the dead-branch reachability opt-out knob                                                                                                                              |
| **type lens**          | the drops-only law (`arrival-lsp` `typed-scanner.test.ts`) + the printer suites (`schema-to-ts.test.ts`)          | across a list / string / number / top slot, NO valid-or-uncertain candidate is ever dropped; the `.d.ts` printer reproduces the contract codec (`§CONTRACT`'s four-reader agreement)                                                                                                                                                                                                         |

**The corpus is the single-sourced bridge, and the drift protocol is explicit.** The oracle
contract and its reference reader are re-declared, not imported (the dependency arrow
forbids the import); if the sift reference and the inlined copy ever drift, the fix is to
re-sync the copy from `prefix-oracle.ts` — the corpus is what makes the drift LOUD. The
lineage classifier's node union is guarded by `assertNever` exhaustiveness, so a new node
kind without a walker arm is a COMPILE error before it can under-collect a cone silently.

**Enforcement sites:** `src/__tests__/oracle-contract.spec.ts`,
`provenance/__tests__/lineage-checkpoint.test.ts`, `src/__tests__/laws/static-validation.law.test.ts`,
`src/__tests__/laws/oracle-optout.law.test.ts`, `arrival-lsp` `typed-scanner.test.ts`,
`type-layer/__tests__/schema-to-ts.test.ts`.
