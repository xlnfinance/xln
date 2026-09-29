# Explanation-Based Learning over the Galois slice

_2026-06-13 — design proposal. Turn ONE signed forensic finding into a reusable, **sound** detector by generalizing its reverse-chain slice._

**Lineage:** builds directly on `project-sift-reverse-chain-codegen-2026-06-12` (the `buildSlice` / `uneval` Galois slicer, today re-exported through `arrival/packages/arrival-provenance/src/analysis.ts`) and `discovery.ts`'s `attestationFor` → `reverseChain`. Refinement-by-negative-example couples to `docs/working-proposals/forensic-fixpoint-atms-over-provenance.md` (the nogood pool). Hole substrate considered against the `define/overridable` chain family (`overridable.ts`).

---

## 0. The one-paragraph thesis

Classical EBL takes a single worked example plus a complete domain theory, builds the **proof** of why the example worked, then **generalizes the proof** — replacing the example's constants with variables — to yield a reusable rule from one case. EBL died for two reasons: (1) you needed a complete, formal domain theory (the program _is_ one now), and (2) the _utility problem_ — learned rules cost more to match than they save.

The arrival insight: **the Galois reverse-chain slice IS the EBL explanation.** It is already (a) a proof tree of why the value was derived and (b) re-executable. So EBL collapses to a syntactic rewrite on `slice.program`: lift the evidence-grounded _constants_ to _holes_, keep the _structure_ (filter predicate, externality test, field reads). The result is a **detector** — "any process owning a globally-reachable beacon" — provable by re-execution on any image. The two historical blockers evaporate: the domain theory is the running program, and the operationality criterion (EBL's hardest sub-problem — _where to stop generalizing_) is **structurally fixed by the membrane**: stop lifting at the grounded reads. Soundness is inherited from purity: a generalized detector, re-executed, still grounds — it cannot hallucinate. **This is the part no one without the slice can do.** An LLM "generalizing a rule" gives you an ungrounded guess; we give you a re-runnable certificate.

---

## 1. What exactly is lifted vs kept — the provenance rule

The slice is a `Pair` tree (`slice.program` re-serialized from `slice.formNodes`). Every leaf datum in that tree falls into exactly one of three classes, decided by _provenance_ (`trace.ts`), not by reading the source:

| Class                       | How identified (via `trace.ts`)                                                                                                                                                                                                                                           | EBL action                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Membrane-grounded value** | The datum is the value of an invocation whose provenance set is **authoritative AND minted at a provenance point** (`inv.isProvenancePoint`, `markAuthoritativeProvenance`) — i.e. an evidence read, or a `(:field read)` projection (a field-point in `fieldPointMeta`). | **LIFT** its specific value → a HOLE. Its _structure_ (the read call, the field accessor) is **KEPT**; only the concrete result it produced (the IP `"203.78.103.109"`, the pid `3644`) becomes the detector's quantified input.                                                                                                                                                                                                 |
| **Pure-derived structure**  | A combinator node (`filter`, `if`, `external-c2-candidate?`, `string-append`, `list`, `car`) — provenance is a _union/forward_ of children, **never** authoritative-at-a-point.                                                                                           | **KEEP verbatim.** This is the explanation's skeleton — the predicate that did the selecting, the field reads, the externality test. It is exactly what makes the detector a detector and not a constant.                                                                                                                                                                                                                        |
| **Model-typed literal**     | A literal in source that `typedLiteralLeaves(value, scheme)` flags — a verdict string the model _wrote_, not read.                                                                                                                                                        | **SUSPECT — do not lift, do not keep as a detector decision.** A sound detector must never contain a value the model typed: lifting it makes a knob that defaults to a guess; keeping it bakes the guess in. The honest move is to **reject** generalization of any slice whose decision rests on a typed literal (the §2b gate already refuses such a finding a `reverseChain`, so in practice these never reach EBL — see §4). |

**The precise rule, in terms of `trace.ts`:** for each leaf `Pair`/atom `n` in `slice.formNodes`, find the invocation `inv` whose `node === n` (or whose `value` produced `n`). Then:

```
lift(n)  ⇔  inv.isProvenancePoint                      (a real evidence read)
            OR  resolveReadIds(trace,[origin]) names a read   (a (:field read) projection)
keep(n)  ⇔  inv exists, provenance non-authoritative   (pure combinator / structure)
reject   ⇔  n ∈ typedLiteralLeaves(value, program)     (model-typed)
```

The crucial asymmetry: a `(:ForeignAddr row)` accessor is **kept** (it's the structural pluck), but the _resulting_ IP string is **lifted** (it's the grounded value). The accessor stays; the answer it produced becomes a hole. This is the EBL "operationality" cut made structural — see §3.

**One honesty flag.** A grounded read with no field accessor and no downstream predicate (a bare `(netscan)` whose whole table is the value) lifts to a hole over a _table_ — a vacuous detector ("any table"). We require at least one **kept predicate** between a lifted read and the output, or the generalization is degenerate (refuse it; door the user toward filtering). This is the EBL "the example must actually use the structure" condition.

---

## 2. The generalization operation on the AST

Given `slice.program` (a `Pair` tree) + `trace`, produce a generalized program in three passes:

**Pass A — classify.** Walk `slice.formNodes`. For each leaf, compute `lift`/`keep`/`reject` (§1). Collect the lifted nodes `L = [(node, value, provenance-meta)]`. If any `reject`, abort with a door.

**Pass B — abstract.** For each lifted node, mint a fresh variable name from its field-point key if it has one (`:ForeignAddr` → `foreign-addr`, deduped), else positional (`hole-0`). Rewrite the `Pair` tree: replace the lifted _value-producing read_ with the variable **reference**, NOT the read call itself. Concretely — the slice contains `(netscan)` producing rows and `(:ForeignAddr row)` plucking the IP; we do **not** delete `(netscan)` (that read is the detector's _input source_ on the new image). Instead we lift the **specific value that was compared against** — the constant `"203.78.103.109"` if it appears as a literal in a predicate, OR, in the common case where the finding _is_ the read result with no comparison constant, we lift by **parameterizing the source**: the read `(netscan)` becomes a hole bound to the new image's evidence. (See the type-hazard flag below.)

**Pass C — bind.** Wrap the kept structure in a binder over the holes. **The substrate decision is the binder** — see §2.1.

### 2.1 Hole substrate: `lambda` vs `define/overridable` — decision

**Chosen: `lambda` for the detector body; `define/exposed` for the published detector; `define/overridable` ONLY for tunable thresholds.** Reasoning:

- `define/overridable` (`overridable.ts`) is a _host-overridable binding with a validated default_. Its semantics are "this value can be swapped by the deployment env, else falls back to the default." That is **exactly wrong for the primary lifted constant**: a detector's input (the image / the evidence source) is not a _defaulted, optional override_ — it is a **required quantifier**. A detector with a default IP `"203.78.103.109"` that "fires" on its own example unless overridden is a footgun: it would self-confirm. The required-argument semantics of a `lambda` parameter (or `define/exposed`'s _derived_ input contract) are the honest shape.
- **`lambda` is the right body.** The generalized detector is `(lambda (evidence) <kept-structure-over-evidence>)` — a closed, re-runnable function of the new image's evidence env. Re-execution is application. This is the minimal, sound substrate and re-uses nothing new.
- **`define/exposed` is the right _publication_.** The chain family (`define/exposed` derives its input contract from reachable `define/overridable` holes, no `:input`) is exactly "a public callable whose inputs are the lifted holes." So a _published_ marketplace detector lowers to:
  ```scheme
  (define/overridable beacon-min-port 1024 (s/number))   ; a tunable THRESHOLD — defaulted, legit
  (define/exposed detect-external-beacon                  ; the detector, input contract DERIVED
    (lambda (evidence)
      (first? (filter (lambda (sock)
                        (and (external-c2-candidate? sock)
                             (>= (:LocalPort sock) beacon-min-port)))
                      (netscan evidence)))))
  ```
  Here the _threshold_ `beacon-min-port` is a genuine `define/overridable` (defaulted, validated, caller-settable — its semantics fit); the _evidence_ is a plain `lambda` parameter (required); and `define/exposed` makes it a callable identity. This is the clean split: **`define/overridable` for lifted constants that are genuinely tunable thresholds with a sound default; `lambda` parameter for the required evidence input; `define/exposed` to publish.**

The discriminator: _does the lifted constant have a sound default such that the detector is meaningful when run with the default?_ A port floor, a time window, a fan-out count — yes → `define/overridable`. The specific IP / pid / filename — no (the default would be the example, self-confirming) → it is **eliminated entirely** (it was only ever the _answer_, not an input) and the predicate that selected it is what remains.

**This reframes the lift:** most "lifted constants" in a forensic slice are not detector _inputs_ at all — they are the **output**. The IP is what the detector _finds_, not what it's _given_. So the generalization rarely produces a hole over the IP; it produces a `lambda (evidence)` whose body re-runs the _selection_ and returns whatever IP the new image yields. The holes that survive as real inputs are the **thresholds inside the kept predicates** — and those are exactly the `define/overridable` cases. Clean.

---

## 3. Operationality = the membrane boundary

EBL's 1986 hardest sub-problem: the _operationality criterion_ — how far to generalize. Generalize too little and you've memorized the example; too much and the rule is unsound or vacuous. McDermott/Mitchell had to supply this by hand per domain ("stop when the leaf predicates are efficiently evaluable").

**Here it is a structural fact, not a heuristic.** Stop lifting **at the grounded reads** — the membrane crossings. Below the membrane (inside `external-c2-candidate?`, `filter`, the field accessors) is _pure structure_: it generalizes by being kept verbatim, and re-runs identically on any image. At the membrane (`netscan`, `pslist`, `(:field read)`) is the _grounded input_: it generalizes by being re-bound to the new image's evidence. There is **nothing to decide** — `trace.ts`'s `isProvenancePoint` / authoritative-provenance flag _is_ the operationality boundary. The criterion that was a research question is `inv.isProvenancePoint`.

Why this is exactly right (not merely convenient): the membrane is, by construction (`createDiscoveryEnv` rosetta wrapping), the only place external reality enters the pure dataflow. Everything above it is image-independent computation; everything at it is image-dependent fact. A detector is precisely "image-independent computation applied to a new image's facts" — which is the slice with the membrane reads re-pointed. The membrane _is_ the lift/keep frontier.

---

## 4. Soundness

**Theorem (generalized-detector soundness).** Let `D = generalize(slice)` be the lambda produced by §2 from a signable finding's slice. For any evidence image `E`, `D(E)` either (a) returns a value `v` whose attestation is `signable`/`scoped` — `v` is fully grounded in `E`'s reads and re-derived by `D` over them — or (b) returns nothing (no row satisfies the kept predicate). It can **never** return an ungrounded or hallucinated value.

**Proof sketch (one line).** `D` is built only from KEPT pure structure + membrane reads re-pointed to `E`. Purity ⇒ every value `D` produces has provenance = union/forward of its membrane reads on `E` (the same `computeProvenance` algebra, §`trace.ts` line 88), and the membrane reads on `E` are authoritative-grounded by construction. No typed literal survives generalization (Pass A rejects `typedLiteralLeaves`). Therefore every leaf of `D(E)`'s output is membrane-grounded or the output is empty. ∎ — this is the _same_ property as `project-sift-reverse-chain-codegen`'s slice-soundness: purity makes the lower adjoint exist; generalization is a structure-preserving (lift-only) rewrite, so it preserves the property.

This is the moat. An LLM can emit `(lambda (evidence) (filter external-c2-candidate? (netscan evidence)))` as a _guess_. Only with the slice + the soundness theorem can you **certify** that re-running it on image B yields a result that is grounded-or-empty — never a fabricated IP. The certificate re-executes.

---

## 5. The utility problem

EBL's second death cause: a library of learned rules where matching a rule costs more than re-solving from scratch (Minton's "utility problem"). Does it bite here?

**Largely dodged, for a structural reason:** our "matching" is not unification against a growing rule base on every query — it is **direct re-execution of one chosen detector** against one image. There is no expensive antecedent-matching phase: `D(E)` is a function application that runs the _same_ forensic reads the original investigation ran, once. Cost(detector) ≈ cost(the original sub-query), which was cheap (forensic leaves bottom out in shallow first-order reads + filters — already noted in `project-sift-reverse-chain-codegen`). So per-detector cost is bounded by the original finding's cost, and detectors don't compose into a combinatorial match phase.

**Where it does NOT fully dodge (honest flag):** a _library_ of N detectors run speculatively against a fresh image is N re-executions — the classic "too many rules" cost reappears at the _portfolio_ level, not the per-rule level. Two mitigations, both deferred: (a) detectors are **cluster-tagged** (a `netscan`-based detector only runs when the `ip-ops`/`memory` cluster is granted — `discovery.ts` already gates clusters), pruning the portfolio by applicability before execution; (b) detectors are **cheap to skip** — a detector whose membrane reads return empty on `E` short-circuits. The honest residual: choosing _which_ detectors to run on a new image is a ranking problem we are not solving here (it's the marketplace's recommendation layer, out of scope). Within "run this one detector," utility is a non-problem.

---

## 6. Over-generalization and the nogood refinement (EBL → ILP bridge)

One example **over-generalizes**: "any process owning a globally-reachable beacon" will fire on the legitimate `chrome.exe` talking to a CDN. Classical EBL has no defense (one positive example). The fix is the EBL→ILP bridge: **negative examples refine a too-broad rule** by specializing its antecedent.

We already have a negative-example store: the **nogood pool** from `forensic-fixpoint-atms-over-provenance-2026-06-13.md`. A nogood is `nogood(H, evidence-set, axis)` — a hypothesis that _died_ under specific evidence, with the failing axis. That is exactly an ILP negative example for a detector:

- A detector `D` over-fires iff `∃` a nogood whose evidence-set `D(E_neg)` _selects_ (the detector flags a row a prior investigation proved benign).
- **Refinement = specialize the kept predicate** so the nogood is excluded: add a conjunct to `D`'s filter that the positive example satisfies and the nogood violates. The axis recorded in the nogood (`forensic-fixpoint` §`nogood`) _names the discriminating dimension_ — e.g. "the destination is a known-CDN AS" — which becomes the new conjunct `(not (known-cdn? (:ForeignAddr sock)))`.
- This is **specialization under a negative example** = the ILP downward-refinement operator, run over the detector's `lambda` body. The membrane keeps it sound: the added conjunct is itself a kept-structure predicate over grounded reads, so refinement preserves the §4 theorem.

**Sketch of the loop:** publish `D` from one positive. On each later investigation, if a nogood's evidence is selected by `D`, surface "`D` over-fires here" + the nogood's axis; offer to specialize `D` by the axis predicate. The refined `D'` is re-certified (re-run on the original positive — must still fire — and on the nogood — must now not). This is precisely EBL's explanation generalized, then ILP's specialization tightened — and the nogood pool is the negative-example feed for free. **Deferred** (Phase 4); flagged here because the substrate (nogood pool + sound conjunction) already exists.

---

## 7. The genuinely-hard AST-rewrite cases (honest flags)

1. **Lifted constant changes the program's TYPE.** If a lifted value is used both as a _number_ (a port compared `>=`) and re-emitted as part of the output, lifting it to a hole bound by `define/overridable (s/number)` is fine — but if the SAME constant appears in two positions demanding _different_ types (a pid used as int and as a string key), one hole cannot satisfy both. **Flag:** detect multi-position lifts with conflicting schema and refuse (door: "this constant is used in two incompatible ways; not a clean detector input"). This is real and not papered over.

2. **A predicate secretly depends on the specific value.** `external-c2-candidate?` is image-independent (good). But a predicate like `(= ip "203.78.103.109")` _IS_ the constant — lifting the constant turns the predicate into `(= ip hole)`, which with `hole` defaulted to the example self-confirms. Per §2.1 these are **not inputs, they're the output** — the right move is to _eliminate_ the equality predicate entirely (it was only checking we found the thing we already found) and keep the _upstream_ selection predicate that genuinely discriminates. **Hazard:** if the ONLY predicate in the slice is the equality-to-the-answer, there is no genuine detector to extract — the finding was a lookup, not a derivation. Refuse with a door. (This is the §1 "at least one kept predicate" condition, sharpened.)

3. **Recursion / closures in the slice.** `project-sift-reverse-chain-codegen` notes forensic leaves are shallow first-order — so this is mild — but a slice containing a recursive helper generalizes only if the recursion is image-independent (kept verbatim) and only its base reads lift. We **keep recursive helpers verbatim** (they're pure structure) and lift only their grounded reads; no new theory needed, but flag any helper that closes over a lifted constant (rare; refuse if encountered).

---

## 8. Build plan — smallest first

**Phase 1 — thin demonstrable slice (the whole point).** One new file `arrival-chain/src/ebl.ts`:

- `generalizeSlice(slice: Slice, trace: EvalTrace): { program: string; holes: Hole[] } | { reject: string }`.
- Pass A classify (re-uses `resolveReadIds`, the authoritative-provenance check, and `typedLiteralLeaves`-equivalent — note `typedLiteralLeaves` currently lives in sift's `discovery.ts`; Phase 1 takes the rejection predicate as a passed-in callback to avoid a dependency inversion).
- Pass B/C: rewrite `slice.formNodes` `Pair` trees (constant → variable; wrap kept body in `(lambda (evidence) …)`). Re-use `writeForm` to re-serialize — **`writeForm` already total over the datum algebra**, so emission is free.
- **Demo test** (`__tests__/ebl.test.ts`): take ONE real signed finding's `slice.program` (the `(first? (filter external-c2-candidate? (netscan)))` shape), generalize it, re-run the generalized `lambda` against a SECOND mock image (`sift/src/mock/` — the multi-family `ScenarioSpec` already gives a second image), assert it grounds soundly (or grounds nothing) — never hallucinates.

Files touched: **new** `foundations/arrival/arrival-chain/src/ebl.ts`, `arrival-chain/src/__tests__/ebl.test.ts`; **export** from `arrival-chain/src/index.ts`. _No change to `slice.ts`/`uneval.ts`/`trace.ts`_ — Phase 1 is a pure consumer of `Slice` + `trace`. This is a **small extension**, not new core.

**Phase 2 — publication substrate.** Lower the generalized body to `define/exposed` + `define/overridable` thresholds (§2.1), using the existing `overridable.ts` / `expose.ts` rosettas. Genuinely-new code is small (the threshold-vs-input classifier).

**Phase 3 — plug into `attestationFor`.** In `discovery.ts`, beside `reverseChain`, optionally attach `detector?: { program; holes }` on a signable finding — a generalized, re-runnable detector born at the same place the slice is. New: a `detector` field on `ProvenanceAttestation`; small.

**Phase 4 — nogood refinement (§6).** The ILP specialization loop over the forensic-fixpoint nogood pool. Genuinely new; deferred.

---

## 9. The marketplace demo (the wow)

One investigation on **image A** produces a signed finding (`external-beacon` over `netscan`). Its slice generalizes (Phase 1) to `detect-external-beacon`. Published as a `define/exposed` detector with a re-runnable certificate. A second analyst, on **image B**, runs the detector — it **fires** (or doesn't), and the result carries its OWN attestation: a fresh reverse-chain proving image B's flagged socket is grounded in image B's reads. The certificate **re-executes on the auditor's machine**.

Why only possible with the soundness theorem (§4): anyone can ship a regex or an LLM-emitted "rule." Only the slice-derived detector ships with the guarantee that _every value it ever produces is grounded-or-empty_ — the detector cannot be a vector for a planted false positive, because it is incapable of emitting a value it didn't read. That is a **Daubert-grade reusable artifact**, and it is born for free from one investigation's slice. The marketplace sells _certified generalizations of real investigations_, not heuristics.

---

## Open questions

1. **Threshold extraction (§2.1):** auto-classifying "lifted constant is a tunable threshold (→ `define/overridable`)" vs "lifted constant is the answer (→ eliminate)" — Phase 1 punts (treats all non-input lifts as eliminate); Phase 2 needs the discriminator. Heuristic: a constant inside a comparison op (`>=`/`<`/`within`) is a threshold; a constant in an equality-to-output is the answer.
2. **Detector identity / versioning** when refined (§6) — a refined `D'` is a breaking change to a published `D`? Lean on `define/exposed`'s "rename = breaking by design" posture.
3. **Portfolio ranking (§5 residual):** which detectors to speculatively run on a new image. Out of scope; marketplace layer.
