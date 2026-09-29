# Arrival Provenance — Specification

> _"The physical universe was a language with a perfectly ambiguous grammar. Every
> physical event was an utterance that could be parsed in two entirely different ways,
> one causal and the other teleological, both valid, neither one disqualifiable no
> matter how much context was available."_ — Ted Chiang, Story of Your Life
>
> That sentence is P0. This document is its execution semantics.

_Normative labels used below: **CHOSEN** · **EXCLUDED (because …)** (a rejected
alternative named with its failure) · **DEFERRED (until …)** · **LIMIT** (accepted,
documented)._

**Deployment target (normative):** provenance cheap enough that a ~1000-SLOC arrival
program runs WITH full provenance inside one Cloudflare Durable Object (128MB isolate,
CPU caps, eviction/hibernation possible mid-run, DO storage with per-value size limits).
Every storage/replay ruling below is stated against this target; Appendix A carries the
budget arithmetic and break order that the budget gate enforces.

Constitutional ground: PRINCIPLES.md P0 (two simultaneous interpretations), P10 (egress
is the only shed), and the language invariants — total immutability (the mutator family
is teaching-doored) and no continuations (call/cc/dynamic-wind deliberately absent).
Both absences are **load-bearing**: continuations are the classical region-escape
channel and mutation the classical isolation-escape channel. Adding either re-opens
those isolation-escape channels.

## 1. Model

**CHOSEN — two layers, named by the field's vocabulary:** the **prospective** layer (the
wireframe: the program statically evaluated into a template graph) and the
**retrospective** layer (the port-record stream: what actually crossed at runtime).
EXCLUDED: per-reduction Invocation accumulation (the 186MB failure mode; superseded —
its prune/forwarding machinery was a hand-built approximation of segment collapse).

**CHOSEN — designated nodes** are exactly: ports (membrane crossings — source, sink,
rosetta), **port-coupled muxes** (a mux whose selector cone reaches a port), fan
instantiation points, binders. Nodes are where P0's two interpretations must agree;
everything between nodes is wire. Ports are defined by MEANING (where the world touches
the program), which is why the storage optimum and the user's ontology coincide (§8).

- CHOSEN: a **pure-selector mux collapses INTO its wire** — its decision is a
  deterministic function of frozen ingress and is rederived by γ; recording it buys
  nothing replay cannot reconstruct. Only port-coupled muxes carry decision records.
  Corollary: pure-data conditionals no longer fragment segments — the wireframe shrinks
  and the record stream sheds 10⁴–10⁵ derivable decisions per loop-heavy program.
  Precision trade: the RECORD-FREE abstract backward cone of a wire containing a pure
  mux includes BOTH arms' ingress (the wire's params are its full FV set); exact arm
  attribution is one γ-step away (the pure-mux-derivation law, §7, is its soundness).
  Do not "fix" this by re-recording — the trade is the design.
- CHOSEN: top-level program order (`begin`/`define` sequencing) is owned by the root
  binder chain — prospective-only; pure sequencing emits no runtime records.

**CHOSEN — a wire is a closed arrival lambda.** `uneval` emits it lambda-lifted:
parameters = ingress, `FV(body) ⊆ params ∪ prelude-names` (checked at emission —
wire-locality law). Locality is thereby syntactic; declared-vs-actual consumption drift
is unrepresentable.

- EXCLUDED: stamp-set-only edges (lose replay — the wire must carry the relation).
- EXCLUDED: a storage-format choice between reader AST and tagless terms (false
  dichotomy — an arrival lambda IS Pairs-with-spans as data and the tagless algebra
  under evaluation; the evaluator is the isomorphism and is already law-tested).
- EXCLUDED: JS closures as wire carriers (not serializable, not content-addressable,
  retain ambient references).

**CHOSEN — the program prelude is the third static layer, and membership is
PURE-ONLY**: the prelude holds exactly those top-level defines whose bodies
transitively reach NO port — checked at wireframe build by the same classifier that
finds ports. A define that reaches a port (a helper wrapping a fetch) is NOT
prelude-eligible: it is wireframe material — its ports are designated nodes and its
call sites reference its template subgraph. `wire-locality`'s `prelude-names` means
PURE-prelude names. A wire body calling a pure helper references it BY NAME; captures
that resolve to prelude or native names are REFERENCES, never payloads.

- EXCLUDED: inlining helpers into wire bodies (breaks per-template sharing; code blowup
  for shared helpers).
- EXCLUDED: helpers-as-ingress (turns closures into retained payloads, and a captured
  native would smuggle a JS function into the persisted wire — the carrier exclusion
  above through the back door).
- EXCLUDED: port-reaching defines in the prelude (name indirection would smuggle sources
  into "pure" wire bodies — γ would re-invoke them on replay, reopening the gap the
  frozen-payload rule (§4) closes).

**CHOSEN — the frame is abstract interpretation.** Wireframe = α(program); replay = γ =
`apply` of the wire lambda to recorded ingress in a hermetic env (**base packs + program
prelude + ingress bindings** via the env-capability assembler), executed under region
discipline (§4) — replay is a track; no separate replay machinery exists.

- EXCLUDED: the trace-slicing Galois adjunction as the general foundation (widening
  makes loop cones non-least). It holds and is claimed for LOOP-FREE wires (wire-γ law);
  loops get the abstract (widened) cone plus exact reconstruction via aggregation count
  - quoted body, one γ-step away.

**CHOSEN — collapse rule:** maximal pure connected subgraphs fold to one wire. Ports
break segments by definition, so a wire body structurally contains no source, sink,
gensym, or port-coupled mux — wire purity is by construction, not by audit.
Pure-selector muxes live INSIDE wires (mux-collapse rule above); γ rederives their
decisions.

- LIMIT: segment granularity is phrasing-sensitive (`(+ (src-a) (src-b))` vs
  `(if f (src-a) (src-b))` collapse differently) — true of every PDG; accepted.

## 2. Declaration vocabulary

**CHOSEN — one declared `provenance` role per symbol declaration**, data in string key
space (P7): `pipe` (default for native/sequence/tagless kinds) · `fan` · `source`
(default for rosetta) · `sink` · `transparent` · `loop` · `opaque`.

- EXCLUDED: the two ad-hoc booleans `fanout?`/`pure?` (degenerate two-word fragment of
  this vocabulary; each had exactly two readers).
- EXCLUDED: heuristic classification (`isRosettaIn`, `.fanout` stamped on bound
  functions for duck-reading) — the key-taxonomy violation the P7 corollary exists to
  kill; every static interpreter reads the declared field.
- EXCLUDED: `opaque` as a citizen — it is a quarantined escape hatch; corpus count is a
  shrink-only drift alarm baselined after span propagation (span propagation changes what
  counts as opaque).

**CHOSEN — declaration kinds LOWER 1:1 to graph node kinds** (one vocabulary, two
layers): `loop` lowers to `binder{cycles}`; `sink`/`transparent` are declaration-layer
facts lowering to graph shapes (a sink is a port with no egress wire; a transparent is a
membrane crossing that neither mints nor stamps — dedent).

- EXCLUDED: two parallel vocabularies (vocabulary-v2 kinds vs wireframe node kinds were
  two design passes over one graph).

**CHOSEN — callback roles extracted from the contract** (z.lambda position + return
shape), with declaration override only where the contract underdetermines:
**element-transformer** · **control** · **effect** · **accumulator**.

- EXCLUDED (for now): the selector/decision split inside `control` and the second cone
  color it implies — one control role and ONE cone color until a product query needs
  "why sorted this way" separately from "where did element k come from". DEFERRED, not
  dead: the wires are distinct in the graph; splitting later is additive. Scope bound
  when it lands: a runtime trace only has the taken path, so any second cone color is
  typed edges on the taken path — the full semiring `how` (the branch NOT taken, the
  `+` alternatives) is unrecoverable in principle, an approximation by construction.
- Clarification: struct-fact wires are value wires carrying a fact TAG, not a second
  edge species; "color" names the query traversal, of which there is one.
- LIMIT — the drift alarm catches CONTRADICTIONS, not lies: a JS body that fans while
  declared `pipe` is consistent-but-wrong; contract shape cannot see JS bodies, and
  arrange-vs-membership is semantic. Mitigation is the agreement law (§7) plus the
  extended generator corpus, not the alarm.

**CHOSEN — container structural facts**: per TERM, once (P8 — a per-carrier matrix
would re-legalize divergence): `{groupingFact, lengthFact}` with verbs **PROXIED**
(length-preserving: map/sort) · **PROVENANCED** (length-changing: filter — union with
the decision's cone) · **MINTED** (constructors). `length` and count-shaped consumers
read the container's own facts, never the elements' deep union. DEFERRED: dict keyset
fact (until a consumer demands it).

## 3. Tracks

**CHOSEN — a track IS a wire whose expression is a first-class lambda** (captures =
ingress); track invariants are wire laws at a membrane boundary. One concept.

**CHOSEN — composition operator comes from the host role:**
parallel (element/control) · chained (accumulator — `egress(Tᵢ) → ingress(Tᵢ₊₁)` is the
ONLY sanctioned inter-track edge) · terminal (effect — no egress).

**Invariants (normative statements):**

- **I1 — value-egress provenance confinement**: for interior `n` of `Tᵢ`,
  `cone⁺(n) ∩ G ⊆ cone⁺(egress(Tᵢ))`; `= ∅` for effect tracks. EXCLUDED: the
  world-noninterference reading (sink events are real observations; I1 confines
  provenance ids, not behavior). Corollary: the forward cone of any value CAPTURED by
  an effect track includes the region port — under-reporting forbidden.
- **I2 — sealed ingress**: everything a track reads is fixed at region open (the main
  program is a completed preamble) or host-supplied per iteration.
- **I3 — separation**: no spontaneous inter-track edges; order is a structural fact of
  the host port, not a dataflow edge. LIMIT: order-dependent selector hosts (sort's
  comparator schedule is data-dependent) — modeled by the host-schedule record (§5),
  without which drill-in on a sort is honestly non-replayable-in-order.
- **I4 — completion**: started = completed at region close, throwing door. A promise
  egress keeps its track PENDING until settled; region close with unsettled egress
  throws the incomplete door.
- **I5 — exterior collapse**: a region is ONE node from `G`. LIMIT: structured egress
  (one value, several interior cones) — field-demand at a region boundary answers by
  replay, not by records; region field-ports DEFERRED until a workload demands them.
- **I6 — bridges**: opaque symbols are the only inter-world identity carriers; identity
  crosses, cones do not. DEFERRED until the ASymbol crossing design.

## 4. Regions and replay

**CHOSEN — region discipline is the enforcement AND the replay container**: scope
token `{open, pending, signal}`, per-(callable, scope) wrapper identity, escape and
incomplete teaching doors. Replay of any wire executes as a track under a fresh region.

**CHOSEN — frozen-payload replay is stable, stated precisely**: replay from **frozen
port payloads** is stable. Replay NEVER re-invokes a source; retrospective mint records
are authoritative. Replay AVAILABILITY is tier-governed (§5): a payload at the stub
tier makes replay unavailable for demands that need it and the answer degrades under
the tier-honesty law — stability is claimed for whatever the tiers still hold, never
past them.

- EXCLUDED: re-execution stability (a live `infer` re-fetch is a different run — never
  claimed).
- CHOSEN: gensym is a mint; its identity is a recorded payload.
- CHOSEN: effect tracks replay in the second mode — replay-between-records (pure
  stretches applied, recorded port events interleaved verbatim).

**CHOSEN — γ runs in a SILENT region**: doors and discipline fully active, stream
emission OFF; the replay trace is ephemeral (walked, never stored). A silent region is
exempt from the event-sourced-regions rule (§5) — it is a pure QUERY whose durable
state is the (template-hash, ingress) pair that spawned it; eviction mid-drill-in
aborts the query and retry re-replays. EXCLUDED: recording replays into the production
stream (observer effect — drill-in would pollute the provenance it inspects, and pay a
DO write per click).

**CHOSEN — GLASS envs replay by cached membrane behavior + whole-program re-run**: a
glass (live host-provided) env's reads are membrane penetrations — recorded with
payloads like any source, under PROMISED-BEHAVIOR semantics: the recorded answer is
authoritative even where live glass would answer differently now (the frozen-payload
rule, uniformly applied). Drill-in on a live studio run is IN SCOPE, served by the
time-space trade at whole-program scale: re-run the ENTIRE program with penetration
playback, materializing only the demanded provenanced lens outputs — no
partial-segment machinery for glass runs, no snapshot-bake artifact (the penetration
stream IS the lazy snapshot of exactly what was read).

- EXCLUDED: recorded-only LIMIT for glass runs (would gut drill-in exactly where the
  product lives); eager glass-env snapshotting (violates the storage thesis; reads
  capture lazily by occurring).

**CHOSEN — γ is offloadable**: a wire (template hash) + frozen ingress payloads are
serializable by construction, so replay MAY execute in a stateless Worker outside the
DO — the DO serves records, workers serve drill-ins. The drill-in request CARRIES the
stream's semantics epoch; the worker refuses a mismatch (or runs the sampled
verification). This is the CPU relief homoiconicity buys; interactive drill-in never
blocks the DO event loop.

**CHOSEN — semantics-epoch pinning**: the stream header records the interpreter
version (semantics epoch). Replay requires a matching epoch, or a sampled wire-γ
verification pass against recorded egresses before answers are trusted. EXCLUDED:
silent cross-version replay (a newer evaluator can lie politely).

**CHOSEN — identity is TELEOLOGICAL, not logged**: replay fidelity rests on the STATIC
nature of the environment plus COMPLETE membrane-penetration capture — if every
membrane penetration is stored, the behavior itself is identical; behavioral identity,
never node-pointer identity. The chain/env hash is therefore coarse (program +
semantics epoch) — an addressing convenience, not a soundness mechanism.

- EXCLUDED: per-pack impl hashing / BEAM-style hot-reload version arbitration (arrival
  is not BEAM; the env is static within a deployment and the epoch pins the
  interpreter; penetration completeness carries the rest).
- Corollary: `require` is a membrane penetration too (VFS reads recorded like
  fetch/db) — the same doctrine generalizes to ALL identity questions.

**CHOSEN — replay memo**: a size-capped LRU keyed (template-hash, ingress-hash) →
egress, living in the replay worker (ephemeral, never persisted — purity makes it
trivially sound). SCOPE: the memo serves egress/cone queries only. Step-WALKS are not
memoized — they stream lazily off the generator-based interpreter (a single wire's
walk is small and paged; the 1–10s worst case was whole-segment cone computation,
which the memo covers). A memo entry MAY outlive its evicted payload: the cached
egress remains correct (purity), but its answers carry the `replayed-cached` evidence
tier, and any demand outside the memo key degrades per tier honesty. Justification:
interactive z-drills need <100ms; the memo amortizes repeat inspection, the dominant UI
pattern.

**CHOSEN — the eager stamp path is a TEST-ONLY oracle** (agreement corpus, sampled),
compiled out of production hot paths. EXCLUDED: permanent production dual-run (two
provenance mechanisms in tension forever is the fragmentation P0 forbids).

**CHOSEN — replay-level cones include port-coupled CONTROL dependencies**: a
port-coupled mux's result carries the SELECTOR's provenance, not only the taken arm's
— the eager oracle always stamped this, the wireframe's backward walk traverses the
selector wire, and the replay driver must union it too (`replay.ts`
`withUnionedProvenance`). All three interpretations agree by law
(`pure-mux-nested-inside-port-coupled-arm`); a driver that drops control dependencies
diverges from BOTH other readings — this is a P0 agreement fact, not an implementation
choice.

**CHOSEN — record kinds and their aggregation applicability**, stated per kind so the
cheapness story doesn't quietly assume pure loop bodies:

| Kind                                                               | Aggregates (RLE/ring)?                            |
| ------------------------------------------------------------------ | ------------------------------------------------- |
| mint (WITH payload)                                                | **never** — every payload is distinct information |
| mux decision (port-coupled muxes only, per §1's mux-collapse rule) | never — each is information                       |
| fan instantiation                                                  | YES — ordinal runs under stable wiring            |
| ingress binding                                                    | YES — stable wiring stores O(1)+count             |
| track open/close                                                   | YES — counter deltas                              |
| host-schedule                                                      | never — the sequence IS the record                |

Aggregation runs are PATH-SCOPED: a run is `(parent ordinal-path, start, count)` —
inner-loop/fan ordinals restart per outer element, so runs never span parents.

A pure-bodied loop's T iterations of stable binder ingress-bindings store O(1)+count;
an agent loop with a rosetta per iteration stores T mint payloads — irreducible,
governed by tiering below.

**CHOSEN — host-schedule record shape**: the sequence of
`(left-ordinal, right-ordinal, verdict)` triples. Inlined verdicts make schedule
reconstruction replay-free, and pair ordinals derive the participating track ids;
recording track ids instead would double size for information already derivable.

**CHOSEN — payload shape**: a persisted payload is the VALUE plus its STAMP IDS, both
under the write/read round-trip law — containment laws at replay need the stamps; a
bare value would silently sever them.

**CHOSEN — deterministic record identity**: record id = (template hash,
**instance-ordinal PATH**, region epoch). Ordinals are paths, not flat integers —
nested fans collide otherwise. Persistence is IDEMPOTENT UPSERT keyed by record id; CF
request retries and multi-request programs re-emit safely. The port-completeness law
(§7) is exactly-once PER ID, not per write attempt.

**CHOSEN — two named hashes**: `template-hash` (spans STRIPPED — dedup and store
identity; the same expression at two program sites shares storage) and `site-hash`
(spans KEPT — plane identity; the two sites render as two wires). Conflating them
either breaks dedup or merges distinct plane locations.

**CHOSEN — stream order**: the stream's total order is EMISSION order (settlement
order for async), keyed by a per-region monotonic sequence + region epoch. Counter
folds are order-insensitive by construction; anything order-sensitive must cite a
host-schedule record. EXCLUDED: a fictional program-order guarantee under concurrency;
EXCLUDED: a global cross-region sequence (nothing needs it; regions interleave freely).

**CHOSEN — PRODUCTION regions are event-sourced**: the stream IS the durable region
state. On DO wake after eviction/hibernation, scope tokens, pending counters, and
wrapper caches are RECONSTRUCTED by folding the region's records — the stream-fold law
(§7) is not just a test invariant, it is the recovery mechanism. In-memory region state
is a cache of the stream, never the source of truth. EXCLUDED: production regions that
exist only in memory (a DO WILL evict mid-await — that is the normal agent state, not a
corner case). Silent replay regions are exempt (§4 — pure queries, reconstructible from
their spawning pair).

**CHOSEN — flush policy**: the in-memory ring flushes to DO storage AT PORTS (every
await is a port — durability boundaries coincide with meaning boundaries, the same
alignment as §6's ontology argument), with a size/time backstop and a forced flush on
the pre-hibernation hook. Port completion BARRIERS on the durable write — this is
exactly what DO output gates provide natively; a failed write kills the request and the
idempotent record ids make the retry's re-emission safe. Records within one pure
stretch may be lost on crash only if their port never completed — which the incomplete
door reports anyway.

**CHOSEN — payload tiering** (against the 128MB target this is core design, not a
footnote):

1. in-memory ring (hot, bounded);
2. DO storage (bounded by per-value size limits — chunk batches; verify current
   SQLite-DO row caps at implementation);
3. R2 for oversize payloads (long LLM outputs, files) by hash reference — the payload
   record lands in DO storage as `pending → R2-ref` and settles by idempotent upsert;
   the R2 write is async I/O (no CPU-cap burn), and on R2 failure the payload degrades
   to stub under tier honesty;
4. hash-only stub after eviction (value dropped, identity + stamps retained).
   Drill-in degrades PER TIER, deterministically, and NEVER silently: an answer states its
   evidence tier from the enum `replayed | replayed-cached | recorded | stub` ("value
   evicted, lineage intact"). EXCLUDED: unbounded retention (Appendix A.1: retained
   payloads are what broke 128MB first, pre-tiering); EXCLUDED: silent degradation (a stub
   answering as if replayed is a lie).

**CHOSEN — the template store is shared and immutable**: wire templates + prelude
live in a cross-DO store (KV/R2) keyed by template-hash, cached forever; per-DO
streams store hashes only. Program version = wireframe hash — the deploy story falls
out. EXCLUDED: per-DO template copies (identical across every DO running the program
version).

**CHOSEN — storage bound as a HARD GATE, not a benchmark**: the motivating workload
class must demonstrably die inside the budget. Expressions O(program) per template,
content-addressed; bindings O(ports); aggregated loops O(1)+count; budget arithmetic
and break order in Appendix A.

- LIMIT: ports are still Θ(data) for genuine fans — value-grain provenance cannot be
  cheaper than the data whose lineage it keeps; the gate is against ACCUMULATION
  overhead, not information.
- LIMIT: persisted payloads persist SECRETS (API responses, user data) — the tiering
  policy doubles as a privacy/retention surface; flagged for product review.

## 5. Package boundary (§WALL)

Two artifacts share the word "provenance" and must not be conflated:

- **core** (this package, `@inhuman.tools/arrival`) owns the PROSPECTIVE half: the capture
  spine (§1–§3 above), the wireframe builder (`provenance/wireframe/`, incl.
  `unevalWire`/`WireEmission` in `provenance/uneval.ts` — a wireframe-BUILD-time production
  dependency, not analysis), and γ-replay (`gamma.ts`/`hermetic-env.ts`, `strata.md` §5's
  `env ⇄ provenance` charter).
- **`@inhuman.tools/arrival-provenance`** (a separate package) owns the RETROSPECTIVE half:
  analysis of a FINISHED trace — `ObservableEvalTrace`, `buildUneval`/`Uneval`/
  `UnevalContainer` (`analysis/uneval.ts`), and the rest of `analysis/*` (flow graphs, region
  folding, statecharts, lineage).

**The door is exactly four subpaths**, verified by grepping every `@inhuman.tools/arrival*`
import in `arrival-provenance/src/`: the package root (`ANil`/`ArrivalError`/`deepProvenance`/
`toJS`/`execState`/`parse`/`LexicalScope`/`SchemeValue`), `/provenance` (`scopeId`,
`snapshotTrace`, `headOf`, `userCallSite`, `EvalTrace`/`PlainInv`/`PlainTrace`
types), `/reflect-internals` (the value-class hierarchy: `AValue`/`APair`/`AVoid`/`ABool`/
`AString`/`AVector`/`ADict`/`ASymbol`), and `/attestation` — one import, `isAttested`.
`buildUneval` binds the run's output through `scope.env.bind("result", …)` on the live
`LexicalScope` already imported from the package root — no `/host-internals` writer door.
No other subpath and no reach-in past a barrel is
used anywhere in the package. `arrival-provenance/src/analysis/uneval.ts`'s own header names
the split with core's `provenance/uneval.ts` explicitly: "the two halves shared a file only
because both start from 'a closed re-derivation of a value'; they have zero code in common …
and this relocation is the first point they needed genuinely different homes" — the disclaimer
this section formalizes at the package level (hermeticity audit D5).

## 6. Queries — the three surfaces

**CHOSEN — the product trinity over one graph**:

1. **Backward cone** — "where did this come from" (minimal witness; why-provenance).
2. **Forward/sealing cone** — "what does adjusting this impact."
3. **The plane at large** — the prospective graph rendered whole: plane (x,y) = template
   graph, O(program), renderable pre-run; **z-axis = instance-ordinal space** (fan
   tracks and loop iterations stack behind their template edge; aggregation count =
   z-depth without materialization); level-of-detail = the demand lattice; zooming into
   a z-layer = γ. Live materialization = the plane animated by the retrospective
   stream — overview, provenance map, and progress are ONE surface. Scope split: the
   RENDERING is DEFERRED (P11, product track); the DATA MODEL the render reads —
   template graph + ordinal z-space + RLE depth — is what this spec covers.

**CHOSEN — demand lattice**: value / count / field-k. Cone(count) ⊆ cone(value);
struct-fact wires answer count-demand without touching elements.
EXCLUDED (for now): further grades (cardinality intervals, keysets) — further grades
are scope creep that recreates a special carrier every egress path must know how to force.

- LIMIT: the live plane's latency is flush-coupled — records emitted mid-CPU-burst
  reach the view at the next port/flush, not instantly; the "live" animation model is
  a product-side note, not a real-time guarantee.

**Why the collapse is the product**: nobody needs the math and string operations;
everyone needs "where from" and "what impacted." Ports = the user's ontology; wire
interiors were materialization, not provenance. Intent-over-materialization applied:
ports = intent (stored, foregrounded) · wires = glass (one γ-step away) · reduction
steps = plumbing (hidden with guarantees). Store-everything predecessors answer a
stratum-1 question with stratum-3 material; that is why they go unused.

## 7. Laws (the test spec)

| Law                                 | Statement                                                                                                                                                                                                                |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| wire-locality                       | FV(wire body) ⊆ params ∪ prelude-names, at emission                                                                                                                                                                      |
| wire-γ                              | apply(wire, recorded ingress) = recorded egress; subsumes segment losslessness, loop-free scope                                                                                                                          |
| replay-nondeterminism               | frozen-payload replay stable under a deliberately mutated external world; interior gensym/source/clock programs generated                                                                                                |
| agreement                           | eager-oracle cone == wireframe cone, generated corpus — SCOPED per the pure-mux precision trade (§1): exact on port-coupled decisions + non-mux segments; abstract both-arms on pure-mux wires                           |
| port completeness                   | every mint/decision/instantiation/ingress exactly once PER RECORD ID, idempotent under request retry/re-emission                                                                                                         |
| track containment (stamp)           | I1 over stamp sets vs oracle                                                                                                                                                                                             |
| track containment (replay)          | I1 under replay                                                                                                                                                                                                          |
| track separation                    | zero inter-track edges except declared acc chain                                                                                                                                                                         |
| stream fold + monotonicity          | fold(events) = final region state; completed ≤ started monotone, over emission orders; the SAME fold reconstructs region state on DO wake — the law is the recovery mechanism                                            |
| pure-mux derivation                 | γ over frozen ingress rederives every collapsed mux decision; ground truth = the eager oracle's recorded arm choices on the agreement corpus (the mux-collapse rule's soundness, §1)                                     |
| effect-track replay-between-records | pure stretches applied, recorded port events interleaved verbatim (§4 CHOSEN)                                                                                                                                            |
| tier honesty                        | every drill-in answer carries its evidence tier from the envelope enum `replayed \| replayed-cached \| recorded \| stub`; a stub or cached answer never presents as freshly replayed                                     |
| demand monotonicity                 | cone(count) ⊆ cone(value); cone(field-k) ⊆ cone(whole); count-demand traverses fact wires only (§6 lattice)                                                                                                              |
| I5 exterior collapse                | a region is ONE wireframe node from G                                                                                                                                                                                    |
| loop-unroll                         | widened vs exact-via-count cones — DEFERRED until a widened-vs-exact-cone consumer exists (both sides' machinery already present: widened loop cones refuse per-wire γ and reconstruct via aggregation count + playback) |
| memory retention                    | sealed-value growth measured against the Appendix A budget                                                                                                                                                               |

**CHOSEN — generator corpus classes**: interior sources · nested regions (map-in-map,
map-in-fold) · first-class HOFs · structured multi-field egress · macro-expanded
bodies (post span-propagation) · deep mux nesting.

## 8. Prior art (normative positioning)

Adopted terms: prospective/retrospective provenance (workflow lineage) ·
backward/forward slice (Weiser; FOW PDG) · confinement/declassification (I1's frame —
Denning→Myers) · coeffect-shaped ingress (Petricek–Orchard). Measuring bar: noWorkflow
(the two-layer twin, no purity keystone) and Perera–Acar–Cheney (functional-trace
explanation; their Galois framing imported, scoped per §1). Novelty claim: the RECIPE —
purity-licensed collapse + demand-lattice value cones + construction-enforced track
isolation + progress as a pure monotone fold over the same minimal stream that answers
post-hoc "why" — no single line has the compound.

## Appendix A — the 1000-SLOC budget (normative numbers for the budget gate)

Reference workload: ~1000 SLOC agent-shaped program — 30 rosetta calls, 5 fans over
100/500/1k/5k/10k elements (Σ≈16.6k), 3 loops to 10⁴, one nested map (10k×10).

### A.1 — Pre-tiering arithmetic (the motivation for why tiering and the mux-collapse rule are core design)

| Component                                     | Estimate                                                                                                    | Verdict                             |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Wireframe (templates + expressions + prelude) | ~200–600 templates ≈ 60–180KB + expressions ≤ program text ~50KB                                            | never the problem                   |
| Fan/track records                             | Σ16.6k × ~3 records × ~64B ≈ 2.5MB; nested map +10⁵ tracks ≈ +15MB worst case                               | pressure                            |
| Loop records (no RLE)                         | 3×10⁴ × ~200B ≈ 6MB                                                                                         | fixed by aggregation                |
| Mux decisions (all recorded)                  | 10⁴–10⁵ × ~48B ≈ 1–5MB, pure noise                                                                          | fixed by the mux-collapse rule (§1) |
| Mint payloads                                 | source-per-element fan @1–10KB ≈ 1–10MB; 10⁴-iteration agent loop @2KB ≈ 20MB — **irreducible information** | governed by tiering                 |
| Retained ingress, in-heap                     | pinned live set of crossed values: 10k×2KB docs = 20MB floor; 60–100MB plausible                            | **broke 128MB FIRST**               |
| Replay CPU per drill-in                       | large collapsed segment 10⁵ applies ≈ 1–10s                                                                 | memo + γ-offload                    |

### A.2 — Budget with mitigations applied (the numbers the budget gate enforces)

With the mux-collapse rule (pure-mux collapse), RLE aggregation, and tiering active,
sealed values live in STORAGE, not heap — the two columns separate:

| Component           | In-memory (128MB budget)                                      | Storage (DO SQLite / R2)                         |
| ------------------- | ------------------------------------------------------------- | ------------------------------------------------ |
| Wireframe + prelude | ~0.2MB                                                        | shared template store (cross-DO, ~0.25MB once)   |
| Record ring         | ring cap (~4–8MB, configurable)                               | full stream ~5–20MB per run                      |
| Payloads            | ring-resident recent only (inside ring cap)                   | 20–30MB per run (mints + ingress), oversize → R2 |
| Region state        | KBs (cache of the stream)                                     | reconstruction = the fold, no extra storage      |
| Program live set    | ~20MB (workload's own data — what a non-provenanced run uses) | —                                                |
| **Total**           | **~30–40MB of 128 — ≥3× headroom**                            | ~30–60MB per run                                 |

Provenance's IN-MEMORY overhead ≈ ring caps + wireframe ≈ ~10MB — the program's own
live set dominates, as it should.

**Break order (what the budget gate tests, in order):**

1. **DO-storage write volume/cost** — the stream + payloads per run (~30–60MB writes);
2. **R2 settle latency** on oversize payloads (async, but bounded by request lifetime);
3. **ring misconfiguration** (a ring cap larger than headroom re-imports the A.1 break);
4. **drill-in CPU** (bounded by memo + γ-offload).

**Pass condition:** the reference workload completes with full provenance inside 128MB
with tiering active; the recorded stream reconstructs regions (the stream-fold law)
after a FORCED mid-run eviction; and every drill-in answer carries an honest evidence
tier.
