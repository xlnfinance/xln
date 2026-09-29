---
title: Arrival language — deviation lineage
genre: reference
status: draft
tags: [arrival, architecture, scheme, language-design]
created: 2026-06-14
updated: 2026-07-08
---

# Arrival language — deviation lineage

Companion to `arrival-machine-lineage.md`. That doc names how execution _runs_
(one log, three readings). This one names what the _language_ became — and why
the six places it departs from honest R7RS are **not** six unrelated indulgences.

The worry being answered (V's words): _"despite my best efforts at an honest
R7RS sandbox-subset, I tilted toward absolute madness — catchall, envpacks with
JS resources, a seamless rosetta membrane, a teleological environment, inference
integration, and a scheme-sweet superset bifunctor that looks more like
CoffeeScript than Lisp."_

The feeling of madness is the feeling of having made N deviations and named none
of them, so each one floats free and the pile looks arbitrary. Pin the citation
on each and the pile resolves into **one recognizable path with two genuinely new
steps.**

## The spine and the direction

**Spine:** R7RS Scheme — the honest lambda-calculus core, kept.

**The direction every deviation points:** _reify what R7RS leaves ambient._ Plain
Scheme leaves the environment, the effect, the namespace, the trace, and the
surface syntax **implicit** — they "just happen." Every tilt below makes one of
those ambient levels **first-class data**.

That direction has a deep ancestor and a pragmatic one:

- **Limit point — the reflective tower** (Smith's 3-Lisp, POPL 1984;
  Friedman–Wand, _Reification: Reflection without Metaphysics_, LFP 1984): a Lisp
  that reifies its own interpreter's metalevels as values.
- **Pragmatic ancestor — Racket** (Scheme → language workbench): _selective,
  bounded_ reifications instead of the full tower — units, chaperones, `#lang`.

We are on the **Racket end**, and that is not an accident: a full reflective
tower is exactly the unbounded escape hatch the intent-over-materialization
doctrine forbids. _Selective_ reification — each level reified as a **named,
bounded, compile-erasable** construct — is the bounded-superset discipline
applied to the metalevel. Staying off the 3-Lisp asymptote is the doctrine
working, not a shortfall.

## The six deviations, traced

| The "madness"                                                     | What R7RS leaves ambient             | What we reified it as                                  | Named ancestor                                                                                                                                                                       |
| ----------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **catchall** (`mcp/server/known`, `llm/proxy`, `chat/completion`) | the **namespace** (flat `define`)    | hierarchical symbol-as-dispatch                        | Clojure **qualified keywords** (`:db/id`) + **multimethods** (CLOS / `defmulti`) — `mcp/server/known "x"`-style dispatch by leading path segment is a parametric multimethod default |
| **envpacks + JS resources**                                       | the **environment / module linking** | first-class linkable capability-modules, C3-linearized | Racket **units** (Flatt–Felleisen, PLDI'98) + **object-capability model** (Miller) + **C3/Python MRO** (Barrett et al. 1996)                                                         |
| **rosetta seamless membrane**                                     | the **FFI boundary**                 | a transparent policy membrane + auto-codec             | **membranes** (Van Cutsem–Miller, ECOOP'13) ≅ Racket **chaperones/impersonators** (OOPSLA'12); wire-safe choke = the policy                                                          |
| **teleological environment**                                      | the **execution trace** (write-only) | a backward-readable trace                              | how/why/where-provenance (Green–Tannen, PODS'07) + dynamic slicing (Agrawal–Horgan, PLDI'90) — **new axis**                                                                          |
| **inference integration**                                         | **nondeterminism** (absent in R7RS)  | a stochastic-oracle effect                             | **Church** (Goodman et al., UAI'08) — a _probabilistic Scheme_ where `(infer …)` is the primitive; LLM = the sampler — **new instantiation**                                         |
| **scheme-sugarcoat superset / bifunctor** (née "sweet")           | the **surface syntax**               | indentation surface + intent-preserving lowering       | **sweet-expressions / wisp** (SRFI-110 / SRFI-119) + **quotient lenses** (Foster–Pilkiewicz–Pierce, ICFP'08) + nanopass sugar-over-core (Dybvig)                                     |

_Aside: `infer` in the inference-integration row is Church's own primitive name, cited for the
ancestry — it is not arrival's spelling. Arrival's own effect surface for this deviation is the
`mcp/`, `llm/`, `chat/` families (`chat/completion` is the sampler-call site); the general
`infer` namespace was retired from arrival's own dispatch (a residual `infer/spent`/`infer/calls`
reflective-budget pair survives as its own thing, unrelated to this row)._

## The recognition

Five of the six are moves **Racket, Clojure, or Church already made and named.**
You re-walked the Scheme → language-workbench path under LLM pressure and arrived
at the same reifications by necessity — which is the opposite of madness; it's
**convergent design**. The "madness" was never the constructs. It was the missing
citations.

The **two genuinely new reifications** are the contribution — the "C++ on C":

1. **The backward-readable trace** (`teleological`). Provenance and slicing exist;
   reifying the trace as a _direction-invariant_ object you can read forward
   (replay) or backward (purpose).
2. **Inference as a content-addressed effect.** Church made sampling an effect;
   making the oracle an LLM, keyed by `{model, hash(input), version}` and
   deduplicated globally, is ours.

So the honest whole-system name: **a probabilistic Scheme (Church) built with a
workbench's bounded reifications (Racket), plus a direction-invariant trace.**.

## The value-algebra floor (the internal seventh)

The six above are _surface_ — the author writes catchall symbols, envpacks,
sugarcoat syntax, `infer`. There is one more deviation, and it is **internal**: nobody
writes `fantasy-land/equals`, they write `equal?`. It is not a superset of the
authored language; it is how the _values_ are built — the floor the six stand on.

- **Ambient in R7RS:** the value algebra. `equal?`/`map`/`fold` are opaque stdlib
  procedures matching type tags; nothing first-class says "Pair is a Functor,
  String is a Setoid."
- **Reified as:** the full **Fantasy Land** typeclass tower — Setoid, Ord,
  Semigroup, Monoid, Functor, Applicative, Monad, Foldable, Filterable,
  Traversable — intrinsic to every value class. `equal?` now _derives from_ the
  value's Setoid (`structuralEqual` consults `fantasy-land/equals` before `valueOf`).
- **Named ancestor:** **typeclasses** (Wadler–Blott, POPL'89; Functor→Applicative
  →Monad) via the **Fantasy Land** encoding — structural protocols, the JS sibling
  of Clojure protocols / Haskell instances.

It is a **value-level bifunctor**: each value reads as a Scheme datum _and_ a JS
algebraic structure (Ramda / host face). That is the rosetta membrane (deviation
#3) pushed _into the value representation_ — and what makes the membrane seamless:
values cross to JS without unwrapping because both sides already speak the algebra.
The internal floor (#7) is what earns the surface seam (#3).

And it obeys the **same quotient law as the sugarcoat superset, one floor down.**
Sugarcoat quotients spelling up to δ (`caar ≡ car∘car`). The value Setoid must quotient
_representation_: `boxed SchemeString ≡ plain string` (materialization → blind) but
`1 ≢ 1.0` (the exact/inexact grade is intent → strict). Same line: collapse
materialization, never intent.

This is why the **closure.scm hang has a place here.** It was this bifunctor's
round-trip law _failing_ — a representation-strict Setoid whose JS face
(`other instanceof SchemeString`) disagreed with the Scheme face (`string=?`), so
boxed ≠ unboxed, dedup never converged, and the loop doubled forever. The fix
restored the law (representation-blind equality); the numbers-stay-strict deferral
is the intent line drawn correctly, not laziness. Bug, fix, and deferral are one
law applied per-type. (See memory `reference-arrival-equal-representation-blind`.)

## The honest audit — where "madness" could be literally true

Apply the doctrine's own test to each deviation: _is it a named, bounded,
compile-erased superset with zero output residue, or an unbounded escape hatch?_

- **catchall** — bounded (three families, dispatch by leading path segment). Lowers to ordinary symbol lookup. ✓
- **envpacks** — bounded (capability DAG, C3-linearized, apply-once). Pure assembly; no runtime residue. ✓
- **membrane** — bounded (wire-safe choke is the revocation policy; only wire-safe values cross). ✓
- **teleological** — bounded (two readings of one trace; direction changes cost, never value). ✓
- **inference** — bounded (content-addressed effect; the trace records the crossing). ✓
- **sugarcoat superset / bifunctor** — **discharged, law corrected.** The honest law
  is _not_ form round-trip (`sugarcoat → s-expr → sugarcoat = id`); demanding that would
  preserve **materialization** — whether you spelled it `caar` or `(car (car ·))`
  — the opposite of the doctrine. The real structure is a **quotient lens**
  (Foster–Pilkiewicz–Pierce, ICFP'08): identity **up to δ** (definitional
  unfolding — `caar ≡ car∘car`), with a deterministic canonizer. The lens
  quotients spelling-materialization and keeps computational-intent — the
  studio↔platform bifunctor, one level down. The inability to separate the two
  spellings is the quotient working, not a leak.

All six surface tilts are principled: five by convergent citation, the sixth
because it _is_ the core doctrine applied to syntax — a quotient lens keeping
intent over materialization. The value-algebra floor beneath them (the internal
seventh) obeys the same law per-type: representation-blind where the box is
materialization, strict where the numeric grade is intent. The only standing obligation is weak, per-construct, and
self-checking: every collapse the canonizer makes must be δ (intent-irrelevant
spelling only), never a difference that crosses the intent line. Meet that and
the harness is principled top to bottom.

## Cross-references

- `arrival-machine-lineage.md` — how it runs (one log, three readings)
- CLAUDE.md "Intent over materialization" — the named-bounded-compile-erased superset test applied above
- ADR-019 (trace = open-core boundary), ADR-IN-026 (git-is-the-deploy)
