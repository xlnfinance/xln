# Open residue #1 — cardinality observation through a length-changing pipeline

**Status:** paper-ish design note (2026-06-19), the first of the two open-residue items named in
[`minimal-provenance-prior-art-2026-06-19.md`](./minimal-provenance-prior-art-2026-06-19.md) §5.
Genre: lineage/deviation note — _what's borrowed, what's the one sliver that's frontier, and why the
adjacent fields stop short._

**Honest verdict up front:** this is **adapt + a narrow derivation**, not novel theory. The framework is
entirely borrowed (Galois slicing + chain-rule composition of per-op adjoints). The frontier is small
and specific: the backward adjoint for a **cardinality observation composed through a length-changing
fan** — and the only genuinely-novel claim is that _no single surveyed source works exactly this
composition_. We are deriving within known theory, not inventing it.

## The shape

```scheme
(length (map f (filter p xs)))
```

The minimal-for-this-run cone of the `length`:

- depends on the **grouping of `xs`** and on **`p` + the elements `p` inspected** (filter's cardinality
  is value-dependent),
- does **not** depend on **`f`** at all (map is length-preserving; the count never forces the elements'
  mapped values).

Eager over-attributes: it runs `f` on every surviving element and carries all of it. The correct cone
excludes `f` entirely. The question: what mechanism yields that cone, and is it ours to invent?

## Why each adjacent field stops short (the anti-reinvention spine)

- **Database aggregate provenance** (Amsterdamer–Deutch–Tannen, PODS'11; ProvSQL) — solves provenance of
  `COUNT`/`SUM` via a semiring-semimodule tensor, but **assumes aggregation is the _terminal_ operator**
  over a flat relation (the "simple queries" case). It does not compose an aggregate _through_ an
  upstream functional `map`/`filter` pipeline, and ProvSQL treats aggregation as its one expensive
  non-constant case (its nested-aggregation handling is a documented limitation — the exact "explicitly
  out of scope" phrasing is _not independently re-verified here_; the load-bearing, verified claim is
  "aggregation is the non-constant case, assumed applied last"). So the DB cookbook, which otherwise owns "provenance of a count," does not cover
  aggregation-not-last.
- **GHC cardinality analysis** (Sergey–Vytiniotis–PJ) — would correctly conclude `f` is used zero times
  for a `length`, but it produces a **static, typed demand _signature_ for optimization**, not a per-run
  data-provenance _witness_ (the source-id cone). Right intuition, wrong output type, and it needs types
  we don't have.
- **Galois slicing** (Perera–Acar–Cheney–Levy '12) — works `length` (§2.1) and `map` (§2.2) _as separate
  examples_. It is the right framework, and its per-op adjoints **compose** (Atkey–Perera '25,
  chain rule). But the paper does not work _this specific composition_, and the load-bearing step is the
  one it leaves implicit.

## The design (within the borrowed framework)

Compose the backward adjoints right-to-left (`filter* ∘ map* ∘ length*`) over the partial-value-with-⊥
lattice:

1. `length*` : demanded count → **spine demanded, every element `⊥`**. (Perera §2.1 verbatim.)
2. `map*` (length-preserving fan) : receives _spine-demanded, elements-⊥_. Because the elements are `⊥`,
   `f` is never demanded → `f`'s inputs go `⊥`. **`f` correctly drops out.** Map passes the spine demand
   through unchanged.
3. `filter*` (**length-changing fan — the load-bearing step**) : receives _spine-demanded_. But the
   output _spine length_ is value-dependent — to know which elements survived, `p` must have run on them.
   So `filter*` must translate "output spine demanded" into "**input elements demanded _for the
   predicate `p`_ (not for any downstream value)**." Its cone = `p` + the inspected elements + the
   grouping. This is the adjoint that is **not explicitly derived in any surveyed source**: a cardinality
   demand entering a length-changing fan must expand to a _predicate-only_ element demand.

Result cone = `{ grouping(xs), p, elements-inspected-by-p }`, `f` and the mapped values absent — the
correct minimal-for-this-run cone, by pure composition.

## Borrowed vs. original

- **Borrowed (the framework):** holes-over-values lattice + meet-preserving forward + lower-adjoint slice
  (Perera '12); per-op adjoints composed by the chain rule (Atkey–Perera '25); `length*`, `map*` as the
  paper's own examples.
- **Original (small, and only this):** the explicit `filter*` adjoint **under a cardinality/spine
  demand** — "spine-demanded ⟹ elements-demanded-for-the-predicate-only" — and the observation that the
  _cardinality-through-length-changing-fan composition_ is worked by no single surveyed source (DBs
  assume terminal aggregation; Perera works the pieces). It is a derivation we can _check_, not a
  conjecture: the round-trip law `eval(uneval(demand)) ⊒ demand` (Perera Cor 1) is the proof obligation.

## What would close it

A `filter*` rule in the v0.2 per-op adjoint table + a test that `(length (map f (filter p xs)))` runs
`f` zero times and yields cone `{grouping, p, inspected}` — and that the round-trip law holds. If that
derivation lands cleanly (likely), this item collapses from "open" to "adapted," and the only residue is
the bibliographic note that we worked a composition the literature left implicit.
