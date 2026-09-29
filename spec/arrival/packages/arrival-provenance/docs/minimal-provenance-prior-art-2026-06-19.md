# Minimal provenance across non-strict observations — prior art & v0.2 cookbook

**Status:** research findings (2026-06-19). Produced by an 11-agent web-research run (7 survey lenses →
3 verifiers: citation-integrity, applicability-to-arrival, cookbook-extraction → synthesis), all Opus.
Load-bearing citations were fetched from primary PDFs by ≥2 independent verifiers; the headline new
citation (Atkey & Perera 2025) was additionally re-confirmed by hand against `arxiv.org/abs/2511.09203`.

**Why this exists:** to answer "is minimal (neededness-respecting) dynamic provenance across non-strict
observations a solved problem, or are we inventing?" — so we **assemble named recipes** rather than
reinvent. Verdict: **almost entirely assembly.** The residue is named in §5.

---

## 1. The named answer: Galois slicing

Minimal neededness-respecting provenance across non-strict observations **is the lower adjoint of a
Galois connection** over a lattice of **partial values with holes (⊥)** — Perera, Acar, Cheney & Levy,
_Functional Programs That Explain Their Work_, ICFP 2012 (`mpi-sws.org/tr/2012-003`). Forward `eval`
(extended to propagate holes) is total, monotone, meet-preserving (Thm 1); every meet-preserving map
has a unique lower adjoint `uneval(u) = ⊓{ a | eval(a) ⊒ u }` = the **least input slice producing the
demanded partial output** (Cor 1). **demand ⊣ provenance is literally that adjunction.**

**Our `length` case is §2.1 — the first worked example** — printing `length Cons(⊞,Cons(⊞,Cons(⊞,Nil)))`:
"the elements of input are all replaced by a hole, because they do not contribute to the output." The
criterion is **neededness/projection** (Wadler–Hughes), explicitly **not output-entropy**.

**Our live code already is the backward pass.** `values/lineage.ts`: `walk()` = the backward demand
walk; `fullCone` = the upper adjoint (no holes / eager); `countCone` = a lower-adjoint query. The
migration is **"add the lower adjoint," not "replace a hack."** The fan-prune comment (`lineage.ts:126`)
is verbatim Perera's length example.

---

## 2. The three bins

### STEAL — transfers as-is (all primary-source-verified)

| Recipe                                                                                              | Source                                                                                 | Use                                                                                                          |
| --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Galois slicing framework (holes lattice, meet-preserving fwd, lower-adjoint slice)                  | Perera–Acar–Cheney–Levy, ICFP 2012                                                     | the whole model; our walk/fullCone/countCone instantiate it                                                  |
| **Per-op adjoints composed by the chain rule** (reverse-mode AD; no monolithic replay)              | **Atkey & Perera, arXiv:2511.09203, 2025** (CHAD-based)                                | **the v0.2 minimal-cone engine** — fits our tagless-final/ligature per-op grain                              |
| `Const`-applicative dependency extraction; Applicative\|Monad = static-shape\|staging-hole boundary | Mokhov–Mitchell–PJ, _Build Systems à la Carte_, ICFP 2018                              | rebuild `classify()` as a record-only FL interpretation — may fix the W1 `if`/`let`/`cond`+HOF gaps for free |
| Absence analysis (dead-arg) / lub-of-branches (short-circuit)                                       | Mycroft 1980; GHC absence; Graf–PJ–Keidel (arXiv:2403.02778, POPL'25 pub. unconfirmed) | classes (e) and (d) — cheapest rules                                                                         |
| Static projection-based slicing of first-order functional programs                                  | Reps–Turnidge, LNCS 1110, 1996                                                         | near-exact prior of our v0.1; the positional/field cookbook                                                  |

### ADAPT — exists, needs our-setting work

| Technique                                                                          | Source                                                              | Adaptation                                                                                                                            |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| where-provenance = source **locations**; field/positional pruning                  | Cheney–Chiticariu–Tan survey §4; Buneman–Khanna–Tan ICDT'01         | generalize relational `location=(R,t,Attr)` → a **lens-path over Pair/SchemeVector/record**                                           |
| read-only optics (Getter/Fold) compose by `∘`; Traversal∘Lens = z-depth-into-field | profunctor optics (Pickering–Gibbons–Wu); Foster lens laws          | **only the read half** — never write back; lens laws are the _soundness proof of sibling-pruning, not runtime code_                   |
| structured demand carrier (`Card :* SubDemand`, Prod/Call/Poly)                    | GHC demand analysis; Sergey–Vytiniotis–PJ(–Breitner) POPL'14/JFP'17 | collapse cardinality → {Absent,Present}; flip direction (their contravariant "how consumed" is adjoint to our covariant "where from") |

**Simplification to test first:** demand-as-projection (a per-node hole-lattice element pushed backward)
may **subsume** the heavy "tree + lens" machinery of confluent-IR §5. Prototype it before building
StyleLens-style infra.

### GENUINELY OPEN — the residue (small, as hoped) → paper-ish notes forthcoming

1. **Nested-aggregate-over-a-pipeline.** `(length (map f (filter p xs)))` — aggregation _not last_. No
   surveyed source covers it (DBs assume aggregation terminal; ProvSQL puts nested aggregation
   explicitly out of scope). Our pipeline composition over the cardinality axis is genuinely
   unaddressed.
2. **Over-ADT "location" carrier.** The where-provenance propagation calculus transfers verbatim, but
   the addressing carrier — a lens-path over Pair / SchemeVector / **improper lists / shared structure**
   — is implemented nowhere found. The calculus is borrowed; the carrier is ours.
3. **The integration claim** (confluent-IR §11 item 1/2): one substrate = fusion target + abort
   scheduler + provenance + replay, in an LLM-agent runtime. Lemmas all prior art; "they are the same
   object, operationalized here" is the contribution.

---

## 3. Theory constraints (sharpen the plan)

- **Minimal provenance is UNCOMPUTABLE in general** — Cheney–Ahmed–Acar, _Provenance as Dependency
  Analysis_, MSCS 21(6) 2011 (reduces to query-equivalence). Only the **per-run slice over a fixed
  trace** is computable-and-minimal. ⟹ everywhere "minimal" must read **"minimal _for this run_,"**
  never "minimal static cone." Our conservative "a static merge may collapse to a pipe at runtime" is
  the **theoretically correct** stance, not a compromise.
- **A flat Set is provably insufficient** — GHC `Note [Don't optimise UProd(Used) to Used]`: it refuses
  to flatten a product demand because the flat form "doesn't convey any clue there is a product
  involved." Our "flat Set can't address sub-structure" was _mathematically forced_.
- **Auto-abort must stay SEQUENTIAL short-circuit** — Berry: parallel-OR is not stable ⇒ ambiguous
  backward slice (Atkey–Perera 2025: parallel-OR is not conditionally-multiplicative / not sliceable).
  `or`/`find`/`any` abort is fine; never a true parallel-or.

---

## 4. Impact on v0.1 / B1 — total vindication, zero change

- v0.1 faithful eager cones **are the named upper adjoint** — proven technique, not a band-aid → keep
  `length`→`fullCone` (G2 byte-identical) with confidence.
- **Industry-standard:** even shipped DBs (ProvSQL) over-attribute aggregate provenance and treat it as
  the one expensive non-constant case. B1 (i) is the norm, not under-scoping.
- B1 (ii) — the full Pair-cardinality minimal cone — is best **earned by fusion** (lazy-element erasure
  dissolves the element ids). **(ii) and v0.2's fusion step are the same fix** ⟹ pulling (ii) into v0.1
  is the larger build the finalization doc already flags.
- **B2 answered:** field-points are **where-provenance locations** (Cheney §4) — preserve them as the
  v0.2 structured (lens-path) carrier, not synthetic ids inside `computeProvenance`.

---

## 5. Verified bibliography (additions to confluent-IR §12)

**Primary-source-confirmed this run (cite freely):** Perera–Acar–Cheney–Levy ICFP 2012; **Atkey &
Perera, arXiv:2511.09203, 2025** (NEW — post-dates §12; headline v0.2 engine); Cheney–Ahmed–Acar MSCS
2011 (uncomputability); GHC `Note [Don't optimise UProd(Used) to Used]`; Sergey–Vytiniotis–PJ POPL'14 /
+Breitner JFP'17 (cardinality); Green–Karvounarakis–Tannen PODS 2007; Buneman–Khanna–Tan ICDT'01;
Cheney–Chiticariu–Tan FnT-DB 2009 (where-provenance §4, §5.4 "semiring model cannot express
where-provenance"); Amsterdamer–Deutch–Tannen PODS 2011; Ikeda–Park–Widom CIDR 2011; ProvSQL
(Senellart et al. 2018 / Sen–Maniu–Senellart 2026); Wadler–Hughes FPCA 1987; Gill–Launchbury–PJ FPCA
1993; Acar–Blelloch–Harper TOPLAS 2006; Hammer et al. Adapton PLDI 2014; Stolarek–Cheney MPC 2019
(Coq, fwd/bwd Galois); **Reps–Turnidge LNCS 1110 1996** (NEW); Graf–PJ–Keidel (arXiv:2403.02778, POPL'25 pub. unconfirmed); Korel–Laski
1988; Agrawal–Horgan PLDI 1990; Coutts et al. ICFP 2007; Kiselyov et al. POPL 2017; **Fluid (Perera et
al. 2025, `explorable-viz/fluid`)** (NEW — v0.2 viz prior art: backward-slicing-as-live-viz).

**Demoted / flag-on-use (real but not fully verified this run):** Reps–Turnidge _tree-grammar
projection mechanism_ detail (cite as "static projection-based slicing of first-order functional
programs," don't assert the representation); ProvSQL exact "45.71M gates" figure (cite the qualitative
"aggregation is the non-constant case" only); standard works not primary-fetched (Wadler Deforestation
TCS'90, transducers, Differential Dataflow, DBSP, ILC, Mokhov BSàlC full text, Foster lens TOPLAS'07,
profunctor optics, Bancilhon–Spyratos) — well-known, content matches, just not re-checked here.

**Citation hazard caught:** two survey agents mis-attributed arXiv:2511.09203 ("Cheney/McKinna",
"Perera/Wang") — both WRONG. Correct authors: **Robert Atkey & Roly Perera** (verified primary +
independent fetch).
