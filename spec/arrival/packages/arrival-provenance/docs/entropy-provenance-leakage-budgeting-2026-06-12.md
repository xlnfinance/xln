# Entropy provenance — provenance-carried leakage budgeting (research note)

_2026-06-12. Status: RESEARCH / not built. Captures a design discussion + a literature sweep.
The downstream system this enables ("blind orchestration over sealed, provenance-typed handles")
is the bigger prize; this note focuses on the quantity that makes it enforceable._

## The idea (the vision behind the math)

An MCP membrane with **opaque pointers + provenance**: the AI/agent is shown that it operates over
data, but is structurally **unable to read it** unless the data has been **diluted properly**
(aggregated / redacted / transformed enough that revealing it leaks little). The AI composes a
computation over sealed handles; only sanctioned (declassified) results cross back to the _user_.
"AI that operates **pen-and-paper ZK**" — zero-knowledge by information-flow discipline, not crypto.

Two payoffs:

1. **Prompt-injection immunity, structurally.** If the orchestrator never reads data — only handles
   and sanctioned verdicts — a malicious payload in the data cannot reach its context. Stronger than
   "we filter the data": the data was never in scope.
2. **Operate over what you're not cleared to read.** Produce a sanctioned answer over PHI / classified
   / privileged data while provably never having read it. Not "we trust it didn't memorize" — "it
   structurally couldn't."

This generalises the sift L0/L2 membrane: L0 (the scout/orchestrator) already writes queries blind;
today L2 leaks the **rows** back. The full version returns only handles + structural verdicts, and
only _diluted_ results materialise.

## Is "entropy provenance" a named concept? — No (verified)

A 3-angle literature sweep (2026-06-12) found **no established named concept** for "entropy
provenance" / "information-dilution provenance" / "leakage provenance" / "quantitative provenance".
The pieces exist as three mature fields that define themselves _against_ each other:

- **Quantitative Information Flow (QIF)** — _how much_ leaks: min-entropy leakage (Smith, FoSSaCS'09),
  **g-leakage / gain functions** (Alvim–Chatzikokolakis–Palamidessi–Smith), channel capacity /
  min-capacity, dynamic leakage. The book: _The Science of Quantitative Information Flow_ (Springer
  2020). QIF papers explicitly note taint/provenance "ignores the _amount_ → overstates leakage."
- **Declassification** (IFC) — the "reveal up to N bits" policy: Sabelfeld & Sands _Dimensions and
  Principles_ (what/who/where/when); delimited release; **gradual release** (Askarov–Sabelfeld —
  knowledge constant except at release points = budget-spent-at-the-exit).
- **Leakage budget under composition** — DP's **ε budget + composition theorems** (Dwork–Roth;
  Kairouz et al. ICML'15); QIF compositionality; **online query auditing** (Kenthapadi–Mishra–Nissim;
  _Bits Leaked per Query_ 2025) — incl. the subtlety that **refusals themselves leak**.

**Closest prior art** (touches but doesn't build it):

- Deutch, Frankenthal, Gilad, Moskovitch 2021, _Optimizing Privacy/Utility in Data Provenance_
  (arXiv 2103.00288) — "**entropy of a provenance abstraction**" (literal entropy-of-provenance), but
  one-shot, not a per-handle spendable budget.
- **DProvDB** (arXiv 2309.10240) — "**privacy provenance**" tracking cumulative DP ε-spend, but
  **per-analyst**, not on the value's lineage handle.

**The unfilled gap = carrying the leakage budget as a first-class provenance label that propagates
with the value along the derivation graph** (each value knows its own remaining safe-reveal margin),
rather than a separate global accountant. Field name for it: _provenance-carried (lineage-propagated)
leakage budgeting_ — "QIF's leakage measures, carried on provenance handles, accounted like a DP
budget." Three established legs, no name for the composite.

**System side** ("blind orchestration over sealed handles"): also unnamed as a whole, with direct
ancestors — **CaMeL** (DeepMind 2025, _Defeating Prompt Injections by Design_: "opaque references +
capabilities"), Willison's **dual-LLM / quarantined-LLM**, Mark Miller's ocap **membrane** +
**sealer/unsealer** (references cross, interiors never do), **LIO** / **faceted values** ("compute
with, can't read"), and _Securing AI Agents with IFC_ (arXiv 2505.23643, CHERI-style capability tags
on agent dataflow). Rigorous property name: **noninterference enforced by IFC, declassification the
only exit**. Pitch as **capability-typed / provenance-typed blind orchestration**.

URLs: link.springer.com/book/10.1007/978-3-319-96131-6 · arxiv.org/abs/2103.00288 ·
arxiv.org/pdf/2309.10240 · arxiv.org/abs/2503.18813 (CaMeL) · erights.org (ocap membrane) ·
arxiv.org/pdf/2505.23643 · proceedings.mlr.press/v37/kairouz15.pdf · arxiv.org/abs/2510.17000.

## The calculus — how to compute entropy reshaping & dilution

### Founding identity (purity earns it)

A value `V = f(X)` is a deterministic function of the source. For a deterministic channel,
`I(X; V) = H(V) − H(V|X) = H(V)`. **Leakage = output entropy.** Clean _only_ because the language is
pure (randomness/state would make `H(V|X) > 0`). Same purity theorem as the sound slice & custody.

Corollary — **data-processing inequality**: `W = g(V) ⟹ H(W) ≤ H(V)`. **Every pure unary op can
only dilute or preserve, never increase, source-information.** Dilution is the default gradient.

### Unifying sound bound

Both Shannon `H(V)` and min-capacity `log|image(f)|` are bounded by
`ℓ(V) ≤ log₂(number of distinct values V can take as X ranges)` — "how many things could this value
be?" Sound for both average-case and worst-case-guessing adversaries; composes by counting.

### The carried object

Refine provenance `Set<OriginId>` → `Map<OriginId, bits>`:
`r(V): origin ↦ rᵢ ∈ [0, Hᵢ]`, where `Hᵢ = H(Xᵢ)` is the atom's prior entropy.

- `support(r)` = the qualitative provenance (the **reshaping** — _which_ atoms).
- magnitudes = the **dilution** (_how much_ about each).
- scalar leakage `ℓ(V) = Σᵢ rᵢ` (sound upper bound by sub-additivity).
- prior `Hᵢ` = **worst-case max-entropy** = `log|domain of field i|` (IPv4 = 32 bits, PID ≈ 16, …).
  No distributional assumptions; the sound (over-charging) direction for a budget.

### Operation rules

| Operation                           | Rule on `r`                                                                         | Why                                                                  |
| ----------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| read atom `i` (mint)                | `rᵢ = Hᵢ`, rest 0                                                                   | full disclosure — quantitative origin-mint                           |
| literal / constant                  | `r = ∅`                                                                             | no source dependence → 0 leakage (why a typed answer is un-signable) |
| injective unary                     | `r` unchanged                                                                       | bijection preserves entropy — pure reshape, no dilution              |
| lossy unary (truncate/round/bucket) | `rᵢ ← min(rᵢ, log\|range(g)\|)`                                                     | DPI + range cap                                                      |
| predicate `p(V)→bool`               | `ℓ ≤ 1 bit`; `rᵢ ← min(rᵢ, 1)`                                                      | one-bit output ⇒ ≤1 bit leaks _regardless of input_                  |
| field projection `(:F row)`         | keep `r` for `F`'s atom, drop rest                                                  | today's field-point refinement, quantitative                         |
| combine `g(V₁,V₂)`                  | union supports; shared `i`: `rᵢ ← min(Hᵢ, r₁ᵢ+r₂ᵢ)`; cap total by `log\|range(g)\|` | **the quantitative `unionProvenance`**                               |
| aggregate `count/sum/max` over n    | `ℓ ≤ log(range)`, smeared over n origins                                            | n atoms → 1 scalar; per-atom → ~0 (k-anon/DP)                        |

Notes:

- **The only entropy-increasing direction is combination**, bounded by sum-then-cap — literally
  `unionProvenance` with dedup promoted from "drop shared origin" to "cap shared reveal at `Hᵢ`."
- **The predicate row is load-bearing for blind orchestration**: `(ip/external-c2-candidate? e)`
  dilutes a 32-bit IP to ≤1 bit _by construction_ — the formal reason predicates are safe to expose
  to the AI and raw field-reads are not. Falls straight out of the range cap.

### The separate channel: selection / control dependence

`(filter p rows)`, `(car (filter …))`, `sort` don't just pass surviving atoms — the
**membership/ordering pattern leaks**: each predicate eval over an atom leaks ≤1 bit (did it match),
_even for rows not in the output_. `ℓ(filter) = ℓ(surviving atoms) + Σ_{tested rows}(≤1 bit)`. This
is the covert-channel-through-which-queries-sign, made precise — it rides the **data-vs-control edge
distinction we already stamp for the slicer**, now carrying a bit-count. Same place the
"refusals leak" subtlety from online query auditing lives.

### The interaction budget

Per-reveal cost = `ℓ` of what crossed (declassified output) + selection leakage of queries that ran.
Interaction-wide budget = **composition** of these (inherit DP's sequential / advanced composition).
Membrane rule: _refuse to declassify a value (or run a query) that pushes running `Σ ℓ` over the
source budget._ **The sift focus-gate ("≤N leaves signs, a whole table doesn't") is already a crude
scalar instance** — `N` is a bit-budget in disguise.

### Honest hard edges (all err toward over-charging = safe for a budget)

1. **Priors** → worst-case max-entropy. Over-estimates. Safe.
2. **Atom correlation** → model atoms independent and _sum_ per-origin reveals; real correlation makes
   the true joint _less_ → summing over-charges. Under-counting the joint would be unsafe; independence
   avoids it.
3. **Shannon vs min-entropy** → propagate the **additive Shannon / range-cap** bound on the handle
   (cheap, composes); compute the sharper **min-entropy** number only at declassification exits.

### The real fork (UNRESOLVED — needs V)

The range cap `log|range(g)|` is static for most builtins (bool = 2, count over n = n+1, a field =
field domain). For a **user-composed lambda** the image isn't known statically:

- **static-conservative**: bound by the joint of inputs (trivial) → lambdas are leak-opaque,
  over-charged; cheap.
- **runtime-measured**: measure the realized image over the actual source → tighter, but the
  measurement is itself a read that costs budget.
  Same shape as the static-vs-dynamic slice fork. **Open question:** is the steering signal
  rate-limitable to a provable leakage budget, or does useful orchestration inherently require more
  channel than confidentiality can afford?

## Connection to Arrival (why we're well-positioned)

The propagation skeleton already exists: `unionProvenance` propagates origin _sets_ compositionally;
the slice proves what flowed where; field-points refine to a field; authoritative-forwarding
preserves identity; `markProvenancePoint` mints at the boundary. **Carrying a scalar instead of just
an ID set is a small extension of machinery we have** — `Set<OriginId>` → `Map<OriginId, bits>`, each
builtin gets a per-op rule, DPI guarantees unary ops contract, combine is sum-cap, a control-edge
counter handles selection, the membrane spends a composed budget at exits. And the same theorem keeps
paying out: **sound declassification IS provenance soundness pointed at confidentiality instead of
integrity** — purity buys all three (sound slice, sound custody, sound leakage budget).

## Next steps (when revisited)

- Resolve the static-vs-runtime-image fork.
- Decide the propagated measure (Shannon additive label + min-entropy at exits).
- Prototype `Map<OriginId, bits>` over a handful of builtins (read/project/predicate/combine/count)
  and the focus-gate as a real bit-budget.
- The system layer (sealed handles, blind L0) is the larger build — provenance-typed blind
  orchestration, CaMeL + ocap membrane as the cited ancestors.
