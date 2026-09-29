# Open residue #2 — the over-ADT where-provenance location carrier

**Status:** paper-ish design note (2026-06-19), the second open-residue item from
[`minimal-provenance-prior-art-2026-06-19.md`](./minimal-provenance-prior-art-2026-06-19.md) §5.
Genre: lineage/deviation note.

**Honest verdict up front:** this is **assembly of two borrowed structures + one genuinely-novel
sub-question**. The propagation _calculus_ is borrowed verbatim (Cheney where-provenance §4); the
_addressing carrier_ is borrowed (read-only optics / lens-paths); the assembly of the two over Scheme's
value ADTs is ours but mechanical. The single sliver with no prior art is **shared / cyclic / improper
structure** — a value reachable by more than one path — which the relational model never faced.

## The problem (classes b/c — field & positional pruning)

Consuming `(:value x)` should pull only the sub-computation that produced `.value` and **prune the
`.type` sibling** from the cone; `(car (map f xs))` should pull `xs[0]` + `f`, not `xs[1..]`. To do that
the cone must **address a sub-position inside a value** and place a hole everywhere else. A flat
`Set<source-id>` cannot — it has no sub-structure (GHC's `Note [Don't optimise UProd(Used) to Used]` is
the industrial proof that a flat carrier is insufficient). So we need a _structured_ address.

## Why each adjacent field gives a piece but not the whole

- **DB where-provenance** (Cheney–Chiticariu–Tan survey §4; Buneman–Khanna–Tan ICDT'01) — provenance is
  a **location** that flows backward through select/project/join by a per-operator rule. This is exactly
  the _propagation calculus_ we need, and it transfers verbatim. **But its address is `(R, t, Attr)`** —
  a flat, fixed 3-level relational coordinate (relation, tuple, attribute). It cannot name a position
  inside an arbitrarily-nested ADT.
- **Optics / lenses** (Foster et al. TOPLAS'07; Pickering–Gibbons–Wu profunctor optics '17) — give a
  **composable address into nested data** (a lens-path `lensA ∘ lensB ∘ …`) _and_ the law that makes
  sibling-pruning sound: the lens **complement** is precisely "everything this lens does not focus." A
  `Traversal` is the fan/element axis; `Traversal ∘ Lens` is z-depth-into-field for free. **But the
  optics literature is about GET/PUT (bidirectional _update_)** — its heavy machinery (PutGet, PutPut)
  is for writing back. We only ever _walk backward_, never write, so we need **only the Getter/Fold
  half**, and we **reinterpret** the lens complement as the demand-hole on siblings. The structure is
  borrowed; the read-only-for-provenance reinterpretation is a (small, sound) repurposing.
- **Galois slicing partial-values** (Perera '12) — the hole lattice _over ADTs_ is the value model a
  lens-path places holes into. Holes-over-ADTs (Perera) + lens-addressing (Foster) is the carrier.

So the carrier = **a lens-path that places a Perera-hole at every position the focused accessor does not
reach, propagated backward by Cheney's location calculus.** Three borrowed pieces, composed.

## The design

A lineage node for a structured value is a **per-field record of sub-nodes** (not a flat Set);
field-access returns the focused sub-node and holes the siblings; a selection predicate contributes a
hole (mints nothing into the focused path). Accessors compile to read-only optics composing by ordinary
function composition, so a nested path prunes siblings via the complement. At an **opaque/membrane** op
there is no internal optic except the trivial whole-value one ⟹ the cone is the whole output —
"**lens precision stops at the membrane**" falls straight out of the taxonomy, and this is also the
answer to **B2**: the field-points the dag/seal join on are _where-provenance locations_, carried as
lens-paths, not synthetic ids minted inside `computeProvenance`.

**Test demand-as-projection first.** A per-node hole-lattice element pushed backward may _subsume_ the
explicit lens machinery (the hole-placement is itself the addressing). Prototype that before building any
StyleLens-style infrastructure — it may collapse most of this note to "compose accessors that set
un-focused fields to ⊥."

## Borrowed vs. original

- **Borrowed:** the where-provenance location _propagation_ calculus (Cheney §4) — verbatim; the
  lens-path _addressing_ + complement-as-sibling-pruning + the lens laws as the _soundness proof_
  (Foster, profunctor optics) — read-half only; holes-over-ADTs (Perera).
- **Original (mechanical):** the assembly — a lens-path over **Pair / SchemeVector / record** as the
  realization of relational `(R,t,Attr)` for a functional ADT runtime; and the read-only repurposing of
  optics-for-update into optics-for-demand.
- **Original (the one genuine sub-question, no prior art found):** **shared / cyclic / improper
  structure.** Scheme has improper lists and structure-sharing (and, absent the purity-doored
  mutation, no true cycles — a useful guarantee). When the _same_ sub-value is reachable by more than
  one lens-path, does its provenance attribute to all reaching paths, one canonical path, or the
  join? The relational model never faced this (tuples don't share cells); the optics laws assume tree
  addressing. This is the sliver worth a real design decision — and possibly the only publishable
  novelty in the whole field/positional story.

## What would close it

The demand-as-projection prototype (decide whether explicit lenses are even needed); a lens-path carrier
over the three ADT shapes with `.provenance`-inspecting G6-style tests (never `equal?`, per DR5); and a
ruling on the shared-sub-value attribution question. Until the prototype, treat the heavy lens
machinery as _not yet justified_ — match inherent complexity, don't pre-build it.
