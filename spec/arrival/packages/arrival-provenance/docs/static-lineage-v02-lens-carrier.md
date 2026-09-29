# Static-lineage provenance — v0.2: the lens / field-point carrier

> **Read §1 first.** This doc is OUTCOME-FIRST: §1–§4 carry the current state and the design that
> shipped; §5 the decisions; §6 the assemble-vs-novel ledger; §7 the historical narrative (the
> deliberation that produced §1–§4 — archived, not load-bearing). A resumer gets the full state from §1
> alone.

Built in the v0.1 playbook shape (landscape → gates/DAG → oracle/red → shadow before irreversible).
Phase-1 survey (5 Opus lenses) converged. Prior context:
the superseded v0.1 finalization doc (removed; see git history),
[`...prior-art...`](./minimal-provenance-prior-art-2026-06-19.md),
[`...open-2...`](./minimal-provenance-open-2-over-adt-location-carrier-2026-06-19.md).

---

## §1 — Status & plan

**v0.2 carrier built. G0 leaf-stamp PROVEN LIVE. L1 carrier-extension COMPLETE. Next = L2 consumer
migration.**

- **Carrier built** — the `field` LineageNode + the single folded walk + the demand-as-projection +
  fan×lens (2a `353fcc7f6e`); the tapped consumer-equivalence shadow (2b `59f02083d5`); Stage A's
  walk-fold (M1) + `merge` demand-barrier (M2) + keyword-priority absorption (`0b44df80c8`).
- **G0 — the runtime leaf-stamp — PROVEN LIVE** (`eebb1f50f7`). The carrier reproduces the dag `:fields`
  query with **auto-bound** producer-ids on the two-infer gepa edge — no manual `bindingsForSkeleton`.
  Default-off (`trace.withAutoBindings()`), byte-identical when unattached.
- **L1 — carrier-extension — COMPLETE.** `fieldResolve` is now a total field-point source over the
  field families: **E1** decided + built (NAMED-pin / POSITIONAL-forward, `a66f33fce8`), **E2** done (the
  multi-field edge SET, `3cd459d174`), **E3** is a stays-live non-perturbation proof (regions
  value-presence is irreducibly live, not migrated), **E4** dissolved (positions forward → no numeric key
  reaches `:fields`), **E5** dissolved (the rosetta points-by-default flip, `14739d70c3`, makes http/sql
  sources automatically). Nothing left to build before consumers migrate.

**The reframe (the one canonical statement).** Keep `AValue.provenance` (the eager per-value Set — the
per-leaf grounding the sift seal, the trace tap, the serializer cache key, and ~64 stamp sites all
depend on); **retire only the field-point _mint_**, replacing `computeProvenance`'s field-point half with
the carrier's `fieldResolve` for the (base, key) edge queries. **The `AValue` flip and the eager-Set
"memory win" are OFF THE TABLE** — the Stage-B pre-mortem (§7) found the flip a security regression (it
breaks the seal's per-leaf grounding → would sign laundered literals) _and_ the memory win illusory (the
Set is already shared-by-reference; a per-value tree-ref allocates _more_). They unlock only behind a
genesis-labelled per-value carrier (v02-G6), not in this arc. Everywhere this doc weighs "the single
unlock" / "delete the Set" / "flip `AValue`", **this paragraph supersedes it.**

**The flag.** `--ir-lineage` is the eventual public flag name; **gated today by `trace.withAutoBindings()`.**
The live field-point mint dies **dead-last**, after the last consumer migrates.

**Next = L2 consumer migration** (§3 contract): land the G4 golden `it.todo`/`c` rows on the live mint
(the diff baseline), then migrate each core consumer one at a time, dual-run behind the flag, gated on
its own byte-identity — dag `:fields` → seal `resolveReadIds` base → regions (E3 non-perturbation) →
`trace-to-chain` → the incremental `TraceRegionFold` — then delete the mint.

---

## §2 — Live DAG + gate ledger

Everything below G0 is **additive + reversible**, gated `withAutoBindings()` / (eventually)
`--ir-lineage`; the live mint dies **dead-last**.

**Done:** v0.1 foundation (shadow-proven) · 2a field node (`353fcc7f6e`) · 2b tapped shadow
(`59f02083d5`) · Stage A walk-fold + M2 barrier + keyword-priority absorption (`0b44df80c8`) · Stage-B
pre-mortem + reframe · **G0 runtime leaf-stamp PROVEN LIVE (`eebb1f50f7`)** · **L1 carrier-extension
COMPLETE** (E1 `a66f33fce8`, E2 `3cd459d174`, E5 dissolved `14739d70c3`).

```
L0 audit cleanup ──┐
                   ├─→ L1 G1′ carrier extension ──→ L2 G4′ consumer migration ──→ (mint dies last)
   Gsec invariant ─┘      [✅ COMPLETE]               (dual-run, 1-at-a-time)
                                                                                   │
   L4 deferred: G6 viz ──→ G3/G1 memory win (off the table until G6)              │
                G2/G5 sharing (when shared structure bites) ──────────────────────┘
```

**Critical path:** L0 (cleanup) → **L1 [done]** → L2 (golden todos first, then migrate, mint last). G6 is
the gate that someday unlocks the deferred memory win; everything before it is reversible and the Set
stays.

### Gate status

| Gate           | What                                                                                   | Status                                                                                          |
| -------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **G0**         | runtime leaf-stamp (per-value carrier at `tap.exit`, auto-bound)                       | ✅ PROVEN LIVE (`eebb1f50f7`)                                                                   |
| **Gsec**       | seal per-leaf grounding stays on `AValue.provenance`; `merge` barrier never reaches it | INVARIANT — continuous, re-run after every L1/L2 change; P1 hermetic gate LANDED (`a6039bcf05`) |
| **L1 / G1′**   | `fieldResolve` = total field-point source (mint-only retirement scope)                 | ✅ COMPLETE                                                                                     |
| — E1           | NAMED-pin / POSITIONAL-forward (normalized provenance)                                 | ✅ DECIDED + BUILT (`a66f33fce8`)                                                               |
| — E2           | multi-field edge SET (per-edge `fieldResolve` union == live)                           | ✅ DONE (`3cd459d174`)                                                                          |
| — E3           | regions value-presence `field`                                                         | STAYS LIVE — non-perturbation proof, not reproduced                                             |
| — E4           | type reconcile (`stepKey:number` vs consumer `field?:string`)                          | DISSOLVED by E1                                                                                 |
| — E5           | `fetch`/`db` provenancePoint upgrade                                                   | DISSOLVED by the rosetta-default flip (`14739d70c3`)                                            |
| **L2 / G4′**   | per-consumer byte-identity off the carrier, dual-run, mint dies last                   | ACTIVE — golden `it.todo`s land first                                                           |
| **L4 — G6**    | chunk-uneval viz; genesis-labelled per-value carrier; fan×lens single wire             | DEFERRED                                                                                        |
| **L4 — G3/G1** | `AValue.provenance` flip + eager-Set deletion (the memory win)                         | OFF THE TABLE until G6 (illusory cost + Gsec)                                                   |
| **L4 — G2/G5** | JOIN / shared-sibling-complement proof                                                 | DEFERRED (until shared structure bites)                                                         |

### Corpus prerequisites (P) — closed

- **P1 — core grounding invariant** ✅ LANDED: `arrival/src/__tests__/lineage-grounding.test.ts`
  (`a6039bcf05`) — 8 tests, hermetic, partial-fab per-leaf in both orders (two-sided falsifier), default
  CI. (The reason to keep `AValue.provenance` is **core**, not a sift concern — the tap reads it at
  `trace.ts:105`, the serializer's `size===0` gate feeds the content-addressed cache key, ~64 stamp sites.)
- **P2 — corpus gap-closers** ✅ LANDED (`a75b0e15a1`): MULTI-FIELD (a consumer-infer two-key edge) + the
  `:loopback` field-pin shadow. (lower-priority residue — whereOf-per-shape, regions mux-arm,
  `trace-to-chain` merge-only — tracked but not blocking.)

---

## §3 — Gate contracts (strict)

Every gate is a falsifiable contract: a **named green test** over a **defined corpus**, a **falsifier**
that _can_ fail, the **invariant** it guards, **reversibility**.

> ★ **`sift` is an APPLIED consumer — a real-world proof of the architecture (the DFIR seal + its
> tools), to be EJECTED, NOT core arrival.** The seal is validated **downstream in sift's own lane**,
> never wired into core arrival CI. The migration's **core consumers** are `dagOf` / `regions` /
> `trace-to-chain` / the incremental fold (all in `arrival-provenance`/`arrival-chain`) — those gate the
> core migration. The seal is the marquee downstream proof that the kept-Set invariant matters in the
> real world, not a core PR gate.

### Gsec — the grounding invariant [continuous, criterion #0 — re-run after EVERY L1/L2 change]

- **Green (CORE, hermetic — the actual gate):** a core-arrival test that per-value grounding holds — a
  partial-fabrication value `(list (:k (some-source)) "literal")` built in **pure arrival** (no sift) has
  a detectably-ungrounded leaf; mechanism-1 (`AValue.provenance` per-value Set) stays intact (the tap
  reads it at `trace.ts:105`; the serializer `size===0` feeds the content-addressed cache key; ~64 stamp
  sites). Runs in default CI.
- **Green (APPLIED, downstream proof):** sift's seal suite (`provenance.test.ts:54` partial-fab →
  unsignable + pinpoints the literal; `red-team-laundering.test.ts`) stays green in sift's **ejected
  lane** — the real-world demonstration that the invariant matters, NOT a core PR gate.
- **Falsifier:** a core change that empties/flips per-value grounding (the `merge` barrier corrupting a
  leaf's `.provenance`, or an `AValue` flip) — caught hermetically in core. The laundered-verdict signing
  is its _downstream consequence_ (caught in sift's lane, after the fact).
- **Invariant:** per-value grounding stays on `AValue.provenance` (the Set); the `merge` barrier never
  reaches the per-value grounding path. **Reversibility:** mechanism-1 is never retired in this arc; the
  seal (applied) never migrates to the carrier.

### E1 — non-keyword `@`/`car`/index edges [DECIDED + BUILT 2026-06-20: NAMED-pin / POSITIONAL-forward]

- **DECISION:** the carrier tracks NORMALIZED PROVENANCE (producer + _named_ location), collapsing the
  access mechanism AND the exact position. The cut is **named-location vs positional-access**, not
  keyword-_syntax_:
  - **named** (`:k` / `(@ x :k)` / `(@ x "k")`) → normalize to field-name + **PIN** (the access syntax
    collapses; one normalized fact "came from the `k` field of P"). **ADOPT** the `@`-keyword/`@`-string
    recovery — the same named field the live mint dropped only via its head-position artifact
    (`accessorField` is head-only, `trace.ts:65-70`; it pins `(:verdict x)` but drops `(@ x :verdict)`,
    the same pluck).
  - **positional** (`car` / `(vector-ref x N)` / `(list-ref x N)` / `(@ x N)`) → **FORWARD** to the
    producer, no pin. The exact index is specific-access, not provenance; positionally it is the **z-stack
    / fan axis** (`[number]`), not a lens step (fan×lens). The index node STAYS in the tree for the
    viz/z-stack — only `fieldResolve`'s consumer-key forwards it.
- **Characterization:** `arrival-chain/src/__research__/e1-nonkeyword-divergence.test.ts` (`c60d7de6c8`) —
  divergence is uniform "carrier more correct," `base` corresponds on every row, divergence is key-axis
  only.
- **Build ✅ DONE (`a66f33fce8`):** `stepKey` forwards `{index}` like `{car}` (returns null, not the
  number; `FieldResolution.key` tightened to `string | null` — E4 dissolved at the type level); named
  fields keep pinning. The `{index}` node stays for the viz/z-stack (`.step`), only the consumer-key
  forwards. Verified: the characterization now shows index **AGREE** (DIVERGE 2 = named-`@` only, AGREE
  6); no golden re-baseline (index now matches live); the named-`@` recovery re-baselines only when an
  `@`-named program's golden is recorded off the carrier (L2).
- **Falsifier:** a positional edge that surfaces a key (regression — must forward); a named edge
  (`:k`/`@:k`/`@"k"`) that drops its field-name pin; an undocumented named-`@` golden diff.

### E2 — multi-field edge SET [✅ DONE (`3cd459d174`)]

- **Green:** the carrier's per-pluck `fieldResolve`, UNIONED per `(producer,consumer)` edge, equals the
  live dag edge's `:fields`. Proven by `lineage-field-shadow-multifield.test.ts` on the P2 program (one
  producer, consumer plucking `(:field (car p))` + `(:other (car p))`): both plucks auto-resolve to the
  same `base=[1]` → unioned to `{field, other}` == live `["field","other"]`.
- **Architectural call:** the per-edge union STAYS in the consumer/statechart layer (`fieldsByPointEdge`);
  the carrier's boundary is per-pluck `{base, key}` only — **no `lineage.ts` helper** (pulling the union
  into the carrier would be wrong-layer). The shadow plays the statechart's per-edge fold.
- **Falsifier:** carrier gives `{a}` where live gives `{a,b}`; or the two plucks' bases diverge (they
  don't).

### E3 — regions value-presence `field` [STAYS LIVE — non-perturbation proof, NOT reproduction]

- **Green:** with `--ir-lineage` ON + the mint retired, `attributeFieldEdges` produces **byte-identical**
  `RegionEdge.field` across the regions corpus — regions keeps computing `field` from **live**
  `meta.inputs` + `valuePresent`, sourcing at most the `inputsProvenance` id-set from the carrier.
- **Corpus:** `trace-to-regions.test.ts:162-290` (embed / multi-slot / pluck / **Where-vs-Why**) +
  `golden-regions-prov-edges.test.ts`.
- **Falsifier:** `trace-to-regions.test.ts:262-290` — `(:note (if (eq? s s) "literal" …))` gains a
  field-qualified edge (any value-blind derivation fails this; provenance is on the slot but the VALUE is
  absent → zero field edges).
- **Invariant:** `field` is value-dependent, NOT AST-derivable; the carrier supplies at most the id-set
  operand, never the `valuePresent` operand. **Reversibility:** regions never fully migrates — the
  value-presence half is irreducibly live.

### E4 — type reconcile [DISSOLVED by the E1 decision]

- The E1 named/positional normalization FORWARDS all positional access, so **no numeric key ever reaches
  `:fields`** — the `stepKey: number` vs consumer `field?: string` seam never arises. `fieldResolve`'s
  consumer-key is always a string field-name or forwarded. _(If a future gate ever needs the raw index as
  a position, it lives on the z-stack/fan axis — v02-G6 — not the `:fields` key.)_

### E5 — `fetch`/`db` provenancePoint upgrade [✅ DISSOLVED by the rosetta-default flip, `14739d70c3`]

- The flip (D-v02-5: provenance points are the DEFAULT for every rosetta, `pure` is the opt-out) makes
  `http/get`/`http/post`/`sql/query` (`data-effects.ts:416-419`) provenance points **automatically** — no
  opt-in. G0's leaf-stamp covers them via the eager stamp. Verified: data-effect tests green; Gsec holds.
  The E5 build dissolved into the default flip — there is nothing left to register.

### L1 done = combined shadow

`fieldResolve` reproduces the FULL field-point query set — base + (base,key) + multi-field + the
E1-chosen non-keyword behavior — on the corpus, dual-run diff empty. (regions `field` excluded — E3 stays
live.) **✅ MET.** Next: L2.

### L2 — per-consumer migration + mint death [ACTIVE]

- **Precondition green (core):** the enumerated golden `it.todo`/`c` rows (`golden-handle-provenance`
  whyOf/whereOf/dagOf static===eager on multi-source-noise + map-infer-fan; `golden-prov-*`) flip to `it`
  and pass on the **live mint** — the diff baseline. (Sift's `seal-lineage-golden:200-208` is the
  downstream-lane twin, not a core gate.)
- **Per consumer** — all **core** (`arrival-provenance`/`arrival-chain`): dag `:fields` → slice base
  (`resolveReadIds`) → [regions: E3 non-perturbation] → `trace-to-chain` → incremental fold. (Sift's seal
  _signing_ rides on `resolveReadIds` and is re-validated DOWNSTREAM in its ejected lane, not here.) Each:
  (a) reads the carrier behind `--ir-lineage`; (b) **dual-run diff empty on the corpus**; (c) its golden
  green off the carrier; (d) flag flips. **Falsifier:** any corpus input where carrier ≠ live for that
  consumer.
- **L2 done / MINT DEATH:** all core consumers carrier-primary + dual-run-clean + `computeProvenance`'s
  field-point half deleted with **ZERO core tests red** + the **core Gsec test** green + **sift's
  downstream suite re-validated** (the applied proof) — the one irreversible act. Strength caveat:
  byte-identity is only as strong as the corpus; strict only after P2's MULTI-FIELD + `:loopback`.

---

## §4 — The design that shipped

### The carrier — ONE new node, ONE walk case

A `LineageNode` kind (`values/lineage.ts`): `{ kind: "field"; op; step: PathStep; child }`,
`PathStep = {field}|{car}|{index}` (`cdr`/rest stay **pipes**, not a `PathStep` arm). It is the **static**
form of the runtime field-point (`FieldPointMeta = {origin,key}`, `trace.ts:57-60`), an exact
correspondence: relational where-provenance `(R,t,A)` (Cheney §4) collapses to `(producerPoint, key)`
because in a value-graph the `(R,t)` pair is already one node.

- **classify()** recognizes the member-read **across all its surface syntaxes** — `(:foo x)` (keyword
  head, `accessorField`/`trace.ts:65-70`), `(@ x :foo)` (`@` head, `membrane.readMember`), `(car x)`,
  `(vector-ref x i)` — and **normalizes to a CANONICAL field node** carrying a canonical `step`. A lineage
  chunk's `uneval` targets **minimal scheme with no polyglot** (arrival's `@`/`:key`/pluck sugars compile
  away), so the chunk must be one canonical primitive shape; "prettify" (re-sugar `(@ obj :foo)` →
  `obj.foo`) is an optional later display layer, not the carrier's concern. The no-lookahead property the
  sampler relies on lives at the _canonical_ level (head determines the op) — recognition handles the many
  syntaxes; the emitted node is uniform. `cdr`/rest stay **pipes** (sound over-approximation — consumers
  only ever pin keyword/`car`/index fields).
- **walk()** — the single folded walk (M1, Stage A) takes `opts: {countOnly?, demand?}`. The field case
  descends the focused child only; **siblings are pruned STRUCTURALLY** (never built as branches, so there
  is no ⊥ to propagate — hole-placement and addressing are the same act). M1 is DONE: `walk` / `walkField`
  / `collectSlots` are folded into the one `opts` recursion (no longer three drifting `switch(n.kind)`
  recursions).
- **M2 — the `merge` demand-barrier.** A field demand must not blindly distribute through a `merge`: a
  `merge` is a fan-in to a _fresh_ value (genesis / `(+ a b)`), so a `:foo` demand selects the labeled
  child (genesis-labeling, v02-G6) or falls back to the full cone. Sound-as-provenance (conservative).
  Couples to the genesis field-labeling. (Stage A landed this barrier — it is _correct for the cone query_
  but is exactly the thing Gsec must keep off the seal's per-leaf grounding path; see §7.)
- The carrier **IS a read-only Getter**; its losslessness is the Bancilhon–Spyratos complement (an
  _offline_ soundness proof, never a runtime obligation — there is **no "GetGet" law**, a Getter is
  lawless in isolation); its backward interpretation is one Atkey–Perera per-op adjoint among many,
  composing by the chain rule. Three borrowed structures, the same arrow read backward.

### Absorption + canonical step

`trace.ts`'s base+innermost-key absorption is kept for the carrier's provenance queries; the viz
reconstructs the path from the tree's _nesting structure_, not a stored path. The field node's `step` is
the **canonical** member-read (normalized from the surface accessors), so the chunk's `uneval` is valid
minimal-scheme. **Positional steps forward through to the innermost keyword above them** — `fieldResolve`
resolves to the innermost _keyword_ (`(:verdict (car (infer)))` pins `verdict`, not `car`), matching the
live minter (the seal/dag only ever pin keywords). The `car`/`index` field nodes stay (the viz/z-stack
needs them); only the consumer-key resolution forwards.

### Normalized provenance — NAMED-pin / POSITIONAL-forward

The carrier tracks **producer + _named_ location**, not access-type or invocation. Named fields
(`:k`/`(@ x :k)`/`(@ x "k")`) normalize to the field-name and **pin** (the access syntax collapses);
positional access (`car`/`vector-ref`/`list-ref`/`@`-int) **forwards** to the producer (the exact index
is the z-stack/fan axis, not a lens pin). Grounded in the positional/keyed prior-art (Buneman–Cheney;
Clojure `Indexed` vs `Associative`) + the fan×lens viz model. This is the where-provenance resolution
re-derived, not invented (Buneman–Khanna–Tan "Why & Where" ICDT'01: a value is copied-from a unique path
of edge labels; nested/NRC flattening demotes the array index to an ordinary key/ordinality). The carrier
_syntax_ keeps two step-kinds (JSONPath `[i]` vs `.field`; Clojure's `Indexed` vs `Associative`); the
_cone_ uses one unified path with positional transparent.

### The consumer-equivalence contract

The field-node walk serves EXACTLY the two queries the JOIN consumers run today:

- **`basePoint(carrier)`** = producer invocation id, **key discarded** — the sift seal's `resolveReadIds`
  (`slice.ts:169-181`).
- **`(basePoint, key)`** = producer + innermost-projected key, **key kept** as edge `:fields` — the dag's
  `resolvePoint` (`statechart.ts:126-138`) + `FlowGraphEdge.fields`.

What survives the reframe: field-points become tree-carried where-provenance lens-paths (via
`fieldResolve`), the carrier riding **alongside** the synthetic-id mint, not replacing the Set.

### The runtime leaf-stamp (G0)

The static carrier's slot space (source _names_ / AST Pairs) is **one-to-MANY** with the runtime
producer-id space (`inv.id`, minted per `enter`, `trace.ts:469`). A per-program `name → ids` map
**collapses** the distinct invocations the dag's Lamport ordering depends on — `(map infer xs)` over 3
elements mints 3 producer-ids but the static tree has one `infer` node. **So the feasible unit is a
PER-VALUE carrier**: each produced `AValue` carries `{tree-ref, bindings}` assembled at `tap.exit` (the
auto-bind hook is `trace.ts:509`), where `inv.id` is in scope and the bindings resolve against _this_
invocation's children — the aliasing dissolves because each value's bindings are scoped to its own
producing invocation. The dag does the name-collapse itself, _last_ (`statechart.ts:197`), after building
the causal graph from distinct ids.

**Key simplification the spike surfaced: the producer-ids ALREADY FLOW** — the eager stamp already places
`inv.id` on every source value at the source hook (`rosetta.ts:453-459`, where source-op-fired + `inv.id`

- the value coincide), generalizing the already-shipped `argProvenance → buildInputsProvenance`
  `slot→producer-id[]` map. So the leaf-stamp does **not** mint runtime ids; it is a per-value _binding
  assembler_ that captures what's already flowing, scoped per consumer-invocation. The 4 hard tap behaviors
  (authoritative-mark/forward, size-1-forward, `symbolContributions`) are **not reproduced** — they are tap
  workarounds for having no static tree; `fullCone`/`fieldResolve` encode pipe/merge/fan/mux structurally.
  Consumers read through `fieldResolve` for the `(base,key)` edge query.

**Scope shipped: dag `:fields` only**, proven live on the two-infer react/reflect gepa edge
(`lineage-field-shadow-autobound.test.ts`). Deferred to later gates: the regions `field` (value-presence
on `.prompt` metadata — a genuinely different mechanism), the incremental `TraceRegionFold` (append-only +
id-monotonic — strictly harder), and the looped/HOF z-axis (fan×lens).

### The viz constraint — fan × lens = a single parametric wire (z-stack × lens)

V's load-bearing requirement: the inhuman flowchart renders a projection _through_ an iteration as ONE
wire over the generalized shape, not N unrolled wires. For
`another = provenanced.map{ (dict :foo it[:bar]) }`, the wire from `provenanced` to `another` is the
parametric path **`source[number][:bar] → result[number][:foo]`** — `[number]` is the **z-stack** (the
fan/iteration axis: the generalized `[number]["foo"]` TS pattern, NOT a specific element), `[:bar]`/
`[:foo]` are the lens steps. So the **field node must COMPOSE with the fan node**: a field projection
_inside_ a fan template produces a _parametric_ lens-path (the z-binder shared across the fan, the field
step applied per-element), carried once and rendered as a single wire. This is confluent-IR §5's
"parametric provenance composed with a lens" made concrete. It is a **carrier-shaping constraint** (the
field node nests inside the fan template; the path is `[z-axis][field]`), not a rendering detail. v02-G6
owns it; the carrier must not collapse the fan axis away when a field is projected through it.

### Genesis vs projection

There is **no "write"** — dicts are read-only; `(dict :foo X)` is a **genesis** that _reveals immutable
structure previously unknown_, not a mutation. So the carrier has two **dual** field operations on
immutable values, neither a put:

- **projection** (`(:bar x)` — _read_ a sub-position; the `field` node; this is what the seal/dag
  field-points are — reads only).
- **genesis** (`(dict :foo X)` — _construct_, labeling a result field). For provenance, genesis is a
  **merge** (union the placed values' cones); the `:foo` is a constructor **label**, not a target.

The single viz wire connects a _genesis_-field (`result[:foo]`) to a _projection_-field (`source[:bar]`)
through the fan — two structure-revelations, dual, no mutation. **The genesis field-labeling is a v02-G6
(viz) refinement** (so `result[:foo]` is addressable for the wire); the built 2a projection already
covers the provenance / v02-G1 side.

### The rosetta points-by-default flip (D-v02-5, `14739d70c3`)

A rosetta mints a provenance point **by default** (data is born at the membrane crossing); `pure: true` is
the opt-out (a transform/pipe that forwards/unions, mints nothing). The runtime now honors the
already-documented + already-static default — `mintsPoint = pure !== true` (`rosetta.ts:363`), the mint at
`rosetta.ts:436-442`, deep-stamped onto every constructed AValue via `jsToScheme` (`rosetta.ts:445`).
Replaces the legacy `provenancePoint` opt-in. The failure mode is now SAFE: a forgotten `pure` = an extra
point (sound over-approximation), where a forgotten source was a silent provenance HOLE (the laundering
risk). Dissolves E5 (http/sql are sources automatically).

**★ The flip was not flawless — it required marking five effectful, non-source control forms `pure: true`,
or they would spuriously mint points** (an adversarial audit, this session, surfaced them; the fix lands
as a sibling commit, possibly alongside this doc):

- `declare/expose` (`expose.ts`), `mcp/declare` (`mcp-declare.ts`), `require/extension`
  (`require-extension.ts`), `require/register-extension` (`loader-extensions.ts`) — each REGISTERS a
  handler / applies a pack **for effect** and returns a callable or `undefined`; no external DATA is born,
  so a default mint would surface a spurious chain node carrying its invocation id.
- **`approval/await` (`approval.ts`) — security-relevant.** Without `pure`, the post-flip runtime would
  MINT a fresh point over the approved result, **REPLACING the approved value's upstream provenance** — a
  seal-laundering vector (the approved value's origin would be erased and re-attributed to the approval
  gate). `pure: true` makes it PRESERVE (forward) the approved value's lineage. This is the same
  laundering shape the Stage-B pre-mortem flagged for the seal; here it is closed at the source.

`require` is marked `pure` for a different reason (it returns a callable — data is born at _invoke_, not
require; conservative, preserves its pre-flip non-point behavior).

### Shared / improper structure — RESOLVED policy + the one genuine novelty

A sub-value reachable by >1 lens-path (Scheme shares structure; no true cycles, mutation is
purity-doored → a **DAG**, not a cycle). **Verdict (a settled transfer):** attribute a shared sub-value's
provenance to the **JOIN (lub)** of demands from _all_ reaching paths, same-origin paths collapsing by
**producer-identity** — never one canonical path. Three reasons: (1) **soundness requires it** —
Atkey–Perera's backward map is a _least_ input slice; the minimal slice reconstructing both paths is
`demand(p1) ⊔ demand(p2)`; canonical-path under-approximates → unsound round-trip. (2) It **matches
`unionProvenance`** (already joins distinct-by-reference, collapses same-reference). (3) Precedented
(demand-slicing access-path sets; partial-value join). **The attribution policy stays ISOLATED +
swappable** (one strategy function at the resolution boundary, not spread through the carrier) so
canonical-path or another policy can replace it without touching the node or `walk`.

**The genuine novelty** (the publishable sliver): location-provenance over a **confluently-persistent
sharing DAG** of untyped functional ADTs — where "same sub-value" is value-identity at runtime but
by-slot-name in the static tree — and proving the lens-complement sibling-prune stays sound **when a
sibling is shared with the focused path** (the complement is set-difference on _reaching-path-sets_, not on
positions). No prior art **found** (to our knowledge: where-prov can't share cells; optics assume tree
foci; Galois-slicing-as-AD does not address aliasing). It is a **carrier-shaping constraint** (store
reaching-path sets; key same-origin collapse on producer-identity), not a blocker. (G2/G5 — deferred until
shared structure actually bites a consumer.)

### Author-time surfacing (the Volar layer, `arrival/packages/arrival-lsp`)

The honest crash (`car`-of-dict = type error — unanimous in the cons tradition: CL/R7RS/Racket/Elisp all
make the hash-table type disjoint) should fire at _author-time_, not just runtime, and it keys off the
**core accessor forms** (`car`/`cdr`/`@`/`:key`/`vector-ref`), **independent of which surface renders
them**. (Per the `scheme ⟷ sweet ⟷ sugarcoat` trimorphism: vanilla sweet = SRFI-105 curly-infix `{…}`
only — SRFI-110 indentation intentionally omitted from the grammar; sugarcoat = the readability dialect on
top — `it`, `=>`, `.symbol`, `[n]`/`[:k]` accessors, python-indents leveraging 110 as a transpiled display
lens. The `[…]` subscripts are sugarcoat and a surface _in flux_ — NOT the lowering basis.) The `.d.ts`
prelude (`src/prelude/`) gives the core ops **branded** signatures — `car<C extends Cons<any,any>>(c: C):
Car<C>`; `@`/`:key` over the membrane's `readMember` domain; `vector-ref` over vectors — so **TS's own
checker is the positional/keyed enforcer**: `(car aDict)` → `SchemeMap` not assignable to `Cons` →
`Mapper` remaps to the source span. **Nominal brands, not structural `dict[0]`** (we own the prelude). No
bespoke checker (no editorial layer over the platform); the static reject set = the runtime's typecheck
domains (bifunctor faithfulness). **Keep the type level SHALLOW** — branded predicates
(`IsPositional`/`IsKeyed`) + one-step extractors (`Car<C>`); type-CHECKING, never type-EVALUATION (a
type-level evaluator is a second source of truth that drifts and hits TS instantiation limits;
_Turing-completeness is the warning, not the invitation_). The one branded category feeds **both** the
lens (author-time honest crash) and the lineage (runtime provenance: positional transparent, keyed pin) so
they can't drift — one cut, two readings.

---

## §5 — Decisions ledger

- **D-v02-1 = ABSORPTION.** Keep `trace.ts`'s base+innermost-key absorption for the carrier; the viz
  reconstructs the path from tree nesting, not a stored path. The `step` is the canonical member-read.
- **D-v02-2 = demand-as-projection prototype first**, before any explicit optic/lens infra. (A per-node
  hole-lattice element pushed backward subsumes explicit optics — profunctor polymorphism is unjustified
  weight with one interpreter.)
- **D-v02-3 = JOIN** (lub of all reaching paths; same-origin collapse by producer-identity) — but the
  attribution policy stays ISOLATED + swappable (one strategy function at the resolution boundary), so it
  is rollback-able.
- **D-v02-4 = NAMED-pin / POSITIONAL-forward (E1).** The carrier tracks normalized provenance (producer +
  _named_ location), not access-type or invocation. Named fields pin; positional forwards (the index is
  the z-stack/fan axis). Resolves E1, dissolves E4. Built: `fieldResolve` forwards `{index}` like `{car}`;
  the index node stays for the viz/z-stack.
- **D-v02-5 = ROSETTA POINTS BY DEFAULT (the flip, `14739d70c3`).** A rosetta mints by default (`pure` is
  the opt-out); `mintsPoint = pure !== true`. Dissolves E5 (http/sql sources automatically). **Required
  marking five effectful control forms `pure: true`** (`declare/expose`, `mcp/declare`,
  `require/extension`, `require/register-extension`, `approval/await`) so they don't spuriously mint —
  **`approval/await`'s was security-relevant** (a non-pure approval would launder the approved value's
  upstream origin; `pure` preserves it). The fix lands as a sibling commit.

---

## §6 — Assemble vs novel

**Borrowed — primary-source-verified this run:** where-provenance location calculus (Cheney–Chiticariu–Tan
§4, Buneman–Khanna–Tan ICDT'01); Galois-slicing holes + per-op adjoints (Perera–Acar–Cheney–Levy ICFP'12;
Atkey & Perera arXiv:2511.09203). **Borrowed — attribution correct but confirmed only from secondary
sources (the optics/complement PDFs failed the WebFetch pass; do not assert as primary-verified, per
[prior-art §5](./minimal-provenance-prior-art-2026-06-19.md)):** read-only optics Getter/Fold +
the lens complement as the sibling-prune proof (Foster TOPLAS'07, Pickering–Gibbons–Wu, Bancilhon–Spyratos
'81) — including the "no GetGet law / Getter is lawless in isolation" point, which inherits the same tier.
**Novel (paper-ish notes):** location-provenance over a sharing-DAG + the shared-sibling complement proof
(open-2 #3); the `filter*` cardinality adjoint (open-1). The carrier itself is **original-but-mechanical
assembly**, not frontier — exactly the "you're assembling, not inventing" outcome we wanted.

---

## §7 — Archive

> **Historical narrative — the deliberation that produced §1–§4. Conclusions live in §1–§4; the line-cites
> below predate Stage A's walk-fold + the G0 insert and have drifted. Kept for the _reasoning trail_, not as
> current state.** Where any passage below says "the single unlock," "flip `AValue`," "delete the Set," or
> "the memory win," §1's reframe supersedes it.

### A. The original "v0.2 gates" list (SUPERSEDED — see §2 table)

- **v02-G1 (consumer-equivalence):** the field-node walk reproduces `basePoint` + `(basePoint,key)` on
  the field families, shadow-proven against the live `computeProvenance` field-points.
- **v02-G2 (sharing):** shared → JOIN; same-origin → producer-identity collapse; reproduces
  `unionProvenance`'s reference-equality structurally.
- **v02-G3 (the win):** `fieldPoint`/`fieldPointMeta`/`computeProvenance`/`pruneChildProvenance`/caps
  deleted; `AValue.provenance` → `(tree-ref, Bindings)`; provenance memory O(program), not O(history).
  **[OFF THE TABLE — §1.]**
- **v02-G4 (consumers):** seal / dag / regions green off the carrier, byte-identical to the field-point
  output. **[REFRAMED → G4′, §3.]**
- **v02-G5 (sharing-soundness):** the shared-sibling complement proof — pruning a shared sibling does NOT
  prune the shared sub-node.
- **v02-G6 (viz):** chunk-uneval reads the carrier → the readable infer-call/transform decomposition.

### B. The original DAG (SUPERSEDED — see §2)

1. field node + classify branch + walk case (additive; demand-as-projection prototype first).
2. SHADOW (v02-G1 oracle): walk reproduces `basePoint` + `(basePoint,key)` vs live `computeProvenance`.
3. JOIN/sharing (v02-G2) on the carrier.
4. **[serial core, only after shadow green]** retire `fieldPoint`/`computeProvenance` + flip `AValue`
   (v02-G3) + migrate consumers (v02-G4) — the irreversible step, pre-mortem'd. **[REPLACED by the staged
   mint-retirement — §1, §2.]**
5. shared-sibling proof (v02-G5).
6. chunk-uneval viz (v02-G6) — parallel-ish; reads the tree.

### C. The serial-core design call (the convergent finding — now FOLDED INTO §4 absorption)

Phases 2a (`353fcc7f6e`) and 2b (`59f02083d5`) committed green (1308 + 4). 2b PROVED consumer-equivalence
on the clean scope (keyword projections on the producer) and **surfaced one divergence on paper, before
any deletion** — the point of shadowing. The static `kind:"field"` node **conflated two operations the
runtime keeps distinct** — keyword projection `(:verdict x)` (the live minter mints a field-point, the
seal/dag pin) vs positional `car`/`index` (the runtime treats as a transparent forwarder, mints nothing).
2a's absorption kept the innermost _any_ member-read, so `(:verdict (car (infer)))` absorbed to `car`
(key=null) while live pinned `verdict`. **The fix (now shipped, §4 absorption): make `car`/`index`
transparent to a keyword above them** — `fieldResolve` resolves to the innermost _keyword_, matching the
live minter; the `car`/`index` field nodes stay (the viz/z-stack needs them); only the consumer-key
resolution changed.

**Prior-art grounding (3-lens cross-runtime research, 2026-06-20 — the fix is not arbitrary).** The
positional/keyed split, and "positional → transparent / keyed → pin," is the settled consensus:

- **`car`-of-dict = type error, unanimously** in the cons tradition (CL `type-error`; R7RS/SRFI-69/125
  mandate the hash-table type disjoint; Racket `exn:fail:contract`; Elisp `wrong-type-argument`). **No
  opaque node** — opaque would fabricate a representation for what the type system already makes
  impossible. Arrival's `car` (typecheck `pair`) + dict-as-`SchemeJSObject` + `@`/`:key` (a generic keyed
  accessor) is **exactly Racket's model**: structural `car` + a separate generic keyed accessor.
- **The provenance _semantics_ unify index+field into one path-step** (Buneman–Khanna–Tan ICDT'01:
  nested/NRC flattening demotes the array index to an ordinary key/ordinality). So "positional forwards,
  keyed pins" _is_ the where-provenance resolution — re-derived, not invented.
- **The carrier _syntax_ keeps two step-kinds** (JSONPath `[i]` vs `.field`; Clojure's `Indexed` vs
  `Associative`). So `PathStep = {field}|{car}|{index}` straddles both layers: two kinds in the node
  (viz), one unified path with positional transparent (cone).
- **"Honest crash > unstable lie"** (V) = Clojure's own rationale: `(first a-map)` → an _entry_ is honest;
  `(nth a-map 0)` _throws_ because a position the map lacks would be a lie — and a _sorted_ map still isn't
  `Indexed` (Python `OrderedDict` refuses `od[0]` for the same reason). Arrival stays in this camp
  _because it has cons_. The runtimes that dropped `car`/`cdr` (Hy #909, Janet, Fennel) did so _because_
  their substrate is indexed/iterable, not cons — the opposite of arrival.

**Audit must-fix backlog (DONE — Stage A folded these into the one walk):**

- **M1 — one traversal, not three.** `walk` / `walkField` / `collectSlots` (+ `fieldResolve`) were
  separate `switch(n.kind)` recursions. **DONE:** folded to one parameterized fold (`walk` + optional
  `demand?`).
- **M2 — a field demand must not blindly distribute through a `merge`.** **DONE:** Stage A added the
  demand-barrier (a `:foo` demand selects the labeled child or falls back to the full cone). Couples to
  the genesis field-labeling (v02-G6).
- **Test gap — fan-template cone-neutrality through the cone.** Assert the additive promise (`walk` never
  descends `template`) via `fullCone`/`countCone` on a template-present
  `(map (lambda (it) (:bar it)) xs)` — a regression that descended `template` passes all current tests.
  (Tracked in L0 cleanup.)

**Shoulds (cheap):** mirror `membrane.readMember`'s colon-strip on the `(@ x ":foo")` string-key path;
cite the `golden-prov-special-forms.test.ts` block by name (the line citation drifted); qualify
cross-package `trace.ts` cites as `arrival-provenance/trace.ts`.

### D. Stage B pre-mortem — VERDICT: NOT YET, and the reframe (15-agent max-fanout audit, 2026-06-20)

Before the **irreversible** Stage B (delete `computeProvenance` + flip `AValue.provenance` + migrate
consumers), a 15-agent pre-mortem (10 blast-radius lenses + 5 adversarial refuters). **All 5 refuters
REFUTED the flip; all 10 lenses said DO NOT FLIP.** The big-bang Stage B as framed is **unsafe**. It
independently re-derives the v0.1 doc's own recorded verdict ("Path B is not a clean flip; G1 is
v0.2-gated") — and sharpens it with concrete witnesses. This produced §1's reframe.

**Why it's not a 3-consumer migration — the three core findings:**

1. **The security gap (sharpest).** Stage A's `merge` demand-barrier — _correct_ for the cone query —
   **breaks the sift seal's per-leaf grounding**, and the seal is a SECURITY gate. `leafGrounded`
   (`discovery.ts:114`) walks the _runtime value tree_ and checks `l.provenance.size > 0` **per leaf**;
   the carrier answers _whole-output over the AST_ and, at a `merge`, unions all children with the demand
   dropped. So `(list (:PID (car (psscan))) "model-typed-literal")` — today rejected as a partial
   fabrication — would yield one non-empty cone, and a carrier-based seal **would sign the laundered
   literal.** The carrier _structurally cannot_ express "leaf B is ungrounded." → **Gsec invariant (§3).**
2. **Two carriers, not one.** `AValue.provenance` is the **eager, untapped per-op stamp** (mechanism 1,
   ~64 sites, on _every_ value — what `exec(src).provenance` returns, what golden-prov tests read, what
   the seal reads per-leaf, _and what the trace tap itself reads_, `trace.ts:105`). Both shadows only ever
   proved the **tapped field-points** (mechanism 2). Flipping `AValue.provenance` severs mechanism 1
   _silently_ — under the tap that depends on it, the serializer's `instanceof Set && size===0` gate (it
   feeds the **content-addressed cache key**), and ~64 stamp sites. → **keep mechanism 1 (§1).**
3. **The runtime wiring didn't exist (at pre-mortem time).** How a `(tree-ref, Bindings)` attaches to a
   value and binds producer-ids _as values flow mid-eval_ existed nowhere in the repo. Both shadows
   correlated the _static_ carrier against **manually-assembled** bindings (`bindingsForSkeleton`). → **G0
   built the runtime leaf-stamp (§4); now PROVEN LIVE.**

**Quieter landmines:** `pruneChildProvenance` nulls a value the regions consumer **structurally recovers
because** it was nulled; the trace cap is the **runaway-loop OOM guard**; there are **5+ consumers, not 3**
(add `trace-to-chain.ts`, `infer-content.ts`, and the live incremental `TraceRegionFold` reading
`fieldPointMeta` across ticks — outside any shadow); the dag/regions read _non-keyword_ `@`/`car`/index
edges and a _value-presence_ field-derivation (`attributeFieldEdges` from `inputsProvenance`) the carrier
didn't model — and the carrier _alters_ non-keyword edges (more correct, but a behavior change requiring a
deliberate re-baseline). All folded into L1/L2 (§2, §3).

**Net:** the divergence the 2b shadow was built to surface is closed, but its green is _necessary, nowhere
near sufficient_. What's reachable now is a narrow, staged, reversible **field-point-mint** retirement —
not the AValue flip. The pre-mortem prevented an irreversible mistake (a laundered-verdict security
regression + a silently-severed eager plane + a changed cache key); that is exactly what it was for.

### E. v02-G0 — the 6-agent scout narrative (the leaf-stamp feasibility study, 2026-06-20)

A 6-agent scout confirmed the runtime leaf-stamp **buildable + reversible**, as a **per-value carrier
minted at `tap.exit`** (not a per-program name-map, which collapses invocations). The crux it resolved:
the static slot space (source names) is one-to-MANY with `inv.id`; a per-program `name → ids` map collapses
the distinct invocations the dag's Lamport ordering depends on. The feasible unit is per-value. The spike
then shipped it (`values/lineage-auto-bindings.ts` + a flag-gated exit hook + a live shadow, 3 tests),
confirming the design in §4.

**The memory-win is confirmed illusory (4 corroborations).** The flat `Set<number>` is already
shared-by-reference in the common cases (`EMPTY_PROVENANCE` singleton; size-1 forward; authoritative
forward-by-ref — the fix for two heap-dump war stories). A per-value `{tree-ref, bindings}` is a _new_
allocation where the Set is a shared reference; the "O(program) shared tree" win holds only for the
_classifier skeleton_, not the per-value bindings the dag needs. So the AValue flip is off the table on
**cost** as well as safety — and the G0 carrier is justified as the **field-point source riding alongside
the Set** (additive, `--ir-lineage`-gated for the dual-run proof), not as a replacement.

**One precondition (now dissolved by D-v02-5):** `fetch`/`db-read` were registered _without_
`provenancePoint`, so they minted no runtime id — `classify` called them sources but there was nothing to
bind. The rosetta points-by-default flip (`14739d70c3`) closed this; infer/`.prompt`/MCP were already 1:1.
