# Arrival — Foundational Principles

_Each principle below is anchored to a live counter-example in the codebase: a specific place
where the code asserts the OPPOSITE of itself (a "lie" — current-broken behavior pinned green,
or two invariants that cannot both be design). The counter-example is cited under each
principle as "Revealed by:". When code and this document disagree, one of them is a bug;
decide which before writing a line._

The one-sentence version: **arrival executes every program twice at once — as computation
over values and as provenance over boxes — and everything else in this document is what it
takes to keep the two executions telling the same story.**

---

## 0. The keystone

**P0. Execution happens on two layers simultaneously — computation over values, provenance
over boxes — and the tagless algebra is the choreography that keeps the two interpretations
coherent.**

A box is NOT a monadic container. It is the execution unit of a second, higher-order
interpreter that runs the SAME program the value interpreter runs: the value layer computes
_what_, the box layer computes _where it came from_, and every `arrival/tagless-final/*` term
is one instruction with two coherent readings. This is why every item is boxed — not for
wrapping discipline, but because an unboxed value is a term the provenance interpretation
cannot execute: the second interpreter doesn't skip it, it silently ABORTS mid-program while
the first keeps running, and the trace it produces from that point on is fiction.

The two runtime layers are not the whole family. The same algebra already admits further,
STATIC interpreters of the same terms: the type lens (s/\* Curry-Howard, tsc as the checker),
the oracle's structural/Σ layers (feasibility as an interpretation), and the static lineage
classifier (the provenance reading computed without running the program). Tagless-final is
exactly the property that lets N interpreters share one program; the two runtime layers are
the ones that must run in lock-step, the static ones must AGREE with them — and that
agreement is a law, tested as one (see P15).

_The operational rider (stated so this principle and the shipped default stop
contradicting):_ the box layer is always CONSTRUCTED — every value is a term both
interpreters can execute (P1) — but it does not always RUN. A production run is
value-plane hot until the host arms observation (a `tap` trace, eager stamps, store
emission); the lock-step law binds in the test suite, not on the default hot path. The
asymmetry is sanctioned because lineage is a property of observed runs — an unarmed run
is a run nobody questions — and it has exactly one footgun, stated in the README: an
unarmed run's provenance reads `[]` while its values look correct. The forbidden states
remain the two old ones: a value the second interpreter cannot execute (unboxed), and a
trace that lies (stamps that disagree with the value plane). An empty trail is not a
lying trail — it is the absence of evidence, and hosts that audit must arm.

_Revealed by:_ (historical) every provenance lie in the audit, seen at once — append's drop,
vector-map's strip, the unstamped cdr spine. Each looked like a local style inconsistency;
together they were one bug: treating the box as decoration on the real computation instead of
the other computation. The conservation repair closed all three (see P8, P10) — kept here as
the keystone's own origin story, the audit that revealed the principle in the first place.

---

## I. The value plane

**P1. A value is a term both interpreters can execute.**
The box is the admission ticket to the second interpreter: a SchemeValue is a boxed AValue
carrying ctx + provenance (or an honest peer like the raw ES6 symbol inside ASymbol — carried
BY a box). Callables included: an ACallable is executable on both layers — apply on the value
layer, runCtx threading and mint/propagate classification on the box layer. A bare JS
function is a value-layer-only term: the moment it enters value space, the program has a
region the second interpreter cannot enter.
_Revealed by:_ the AProcedure arm, the LAMBDA brand passthrough, curry's bare-arrow leak —
every one a JS artifact living in value space without lineage. (The forbidden bare `{ fn }` `SymbolDeclaration` shape
bare-fn bind arm this used to also cite — capability.ts, wired through `AmbientRuntime.ts`'s
internal `bindRosetta` — is retired: every capability now binds first-class ANativeProcedures
instead, per capability.ts's own retirement note.)
_Forbids:_ new bare-fn producers; `typeof === "function"` as a value-space callability test;
env bindings whose stored value has no class.

**P2. Values are frozen at construction — immutability is what makes the two layers commute.**
The provenance reading is computed WITH the value but consumed later (a trace query, a
lineage cone, a studio why-panel). It stays valid at read time only because the value cannot
have changed under it: mutation desynchronizes the layers — the value layer moves on while
the box layer holds a history that is now a forgery. The only mutations are named doors:
cycle knot-tying (`__tieKnot` — construction-order-impossible structures), and phase-gated
assembly-time env binding that dies at phase close. There is no third kind.
_Revealed by:_ (fixed) the `forMutation`/`frozen` guards on `asVector`/`asBytevector` — dead
machinery for a mutation path already closed by `notImplemented` doors (`vector-set!`,
`bytevector-u8-set!`, `string-set!`/`fill!`) — was removed outright rather than kept "just in
case".
_Forbids:_ defensive freeze/guard machinery for impossible states; `set!`-shaped anything;
un-named `Object.assign`/property writes on a constructed value.

**P3. Types tell the truth, including the inconvenient one.**
The type lens is one of the static interpreters (P0) — a declaration that under-describes
runtime is that interpreter executing a different program than the runtime pair, which makes
every downstream reader either wrong or a caster. If the runtime stores `string | symbol`,
the field says `string | symbol` and every reader narrows honestly.
_Revealed by:_ (fixed) gensym's ES6 symbol once smuggled through a `__name__: string`
declaration via `as unknown as string` — the class body handled both arms for years before
the field was widened to its honest `string | symbol` (`ASymbol.ts`). The one surviving
`as unknown as string` (`values-repr.ts`) is now a documented ctor-boundary cast onto that
already-honest contract, not a declaration lying about the field it backs.
_Forbids:_ `as any`; casts not provable by an adjacent runtime guard; "it's fine, the code
handles it" as a substitute for the type saying so.

## II. The membrane

**P4. The membrane is where the second interpreter's world ends — one representation per
side, converted only there.**
Inside: boxed AValues, because both interpreters run. Outside: plain JS, because only the
value reading crosses — the provenance reading STAYS, in the run's trace, keyed by scope.
So the conversion is total and uniform in both directions for every type: boxes exist exactly
where the second interpreter runs, and a bare value inside (or a box outside) is a piece of
one world lost in the other. Two refinements: the exec
API is two-tier — the SIMPLE flow ("run, get JS") is a true exit and fully unwraps; the
COMPLEX flow ("run, get reusable state") deliberately hands boxed state to JS-side TOOLING
and is not a crossing, it is a session handle into the inside. And "plain JS" means
plain-JS-OBSERVABLE: container egress may be a lazy ref-tracking proxy that materializes on
demand — observationally plain, no AValue ever readable through it.
_Revealed by:_ strings crossing out boxed while booleans cross raw (two invariants pinning
opposite exit contracts); representation-blind `equal?` and `boolean=?`'s deliberate
`z.schemeValue` input — tolerance machinery that exists only because bare values leak inward.
_Forbids:_ representation-blind comparisons (once the bare-value purge completes, blindness
INVERTS to a strict-door throw); "accepts boxed or raw" contracts; any instanceof-chain
converter competing with the protocol (P7).

**P5. Boundaries fail loudly at the moment of crossing.**
A violation is refused where it happens — type-level `never` where expressible, runtime throw
always, message that teaches (errors-as-doors). Never tolerated inward to fail three calls
later as a weird problem: a value smuggled past the door is precisely a term one interpreter
will choke on far from the crossing that admitted it.
_Revealed by:_ `fromJS`'s old already-boxed pass-through masking which-side-am-I-on confusion;
`isLipsPair` duck-typing patching a hole the loud door would have exposed.
_Forbids:_ silent pass-throughs "for robustness"; duck-typed structural sniffing at
boundaries; catch-and-continue on a crossing violation.

**P6. Effects are region-bound to their invocation — the provenance layer needs a frame to
attribute to.**
Anything that crosses the membrane carrying the ability to re-enter (a reverse lambda, a
handle, a port) is scoped to the symbol invocation that produced it: a re-entry re-starts the
two-layer execution INSIDE that invocation's scope, so the box layer has a real frame. Call-
after-return throws, return-with-calls-in-flight throws, run abort cancels re-entries.
`CONSTANT_CTX` as the answer to "whose invocation is this?" is the provenance interpreter
executing against a fake frame. Escaping the region is not a relaxation — it is a separate,
named capability.
_Revealed by:_ (preemptively — the reverse-membrane design) callbacks with no ctx, no owner,
no abort path, working by accident through `Reflect.apply` fallbacks.
_Forbids:_ callbacks stashed for later; event-handler patterns without the named capability;
`CONSTANT_CTX` as the lazy frame.

## III. Representation authority

**P7. The class is the sole authority on its own representation — because the class is where
the choreography is implemented.**
Each `arrival/tagless-final/*` method on a value class is one instruction of the algebra
implementing BOTH readings in one place: the value work and the box work, side by side,
reviewable as a unit. That is why conversion (`arrival/toJS`), printing (`arrival/print`),
equality (`equals`), and every other term live ON the value — splitting the authority splits
the choreography, and the two readings drift apart in whichever copy forgets one of them.
Consumers — membrane, rosetta, zod codecs — dispatch the protocol; a codec is a guard + a
contract refinement + a protocol call, never a competing description of the conversion.
_Revealed by:_ (fixed) `schemeToJs`'s instanceof chain once carried a duck-typed hole where
APair should be — closed by the `arrival/toJS(exit)` collapse (every boxed shape dispatches
through `egressAValue`, one protocol, no per-carrier special case); codec encode/decode arms
re-describing what classes already know remain the live half of this citation.
_Forbids:_ external switch/instanceof conversion chains; a second place that knows how a
vector serializes; codecs with hand-written transform bodies for representation (contract
refinement — ranges, arity, element types — is the codec's real job and stays).

_Corollary — the key taxonomy._ Protocol keys come in three roles, one mechanism each, never
mixed:

- **Algebra instruction keys** (`arrival/tagless-final/*`, `arrival/toJS`, `arrival/print`,
  `arrival/class`) are STRINGS — every static interpreter (type lens, oracle, lineage
  classifier, trace, MCP harvest) consumes instruction names as data (P0's N-interpreter
  clause); symbols would privilege the runtime pair.
- **Capability brands** (INTEROP_BOUNDARY) are MODULE-LOCAL symbols, never `Symbol.for` — a
  registry symbol is forgeable from any code and a forged brand is an escape vector.
- **Metadata slots** (LOCATION, CYCLES, REF, DATA) are `Symbol.for` — enumeration-invisible
  (reader metadata never leaks into user-shaped data) and stable across duplicate module
  instances, which is what registry symbols uniquely buy.
  The string-forgery hazard (a borrowed JSON object carrying a literal `arrival/*` key) is the
  membrane's duty: a foreign value's own data key is DATA, never protocol — an F3 law row.

**Syntax dispatches by CLASS, semantics by TERM** (hermeticity audit D7). These are two
different questions at two different points, and the taxonomy above answers only the
second. Reader SHAPE is decided once, at the boundary between reader output and the
algebra, by `instanceof` on the value's class — `eval/evaluator.ts`'s `evaluate()`
destructures `ANil`/`ASymbol`/`APair` this way to decide WHICH FORM a node is (special
form vs. application vs. self-evaluating atom) before a single algebra term runs. Once
inside the algebra, every instruction dispatches by STRING KEY, per the corollary above
— never by re-inspecting class a second time. Conflating the two would either make the
algebra care about reader internals (breaking P7's one-authority claim) or make special-
form recognition pay a string-key hop it does not need.

**P8. One algebra, every carrier** _(corollary of P0)_.
A term has ONE semantics across all representations: if `map` preserves element boxes on a
Pair, it preserves them on a Vector and a borrowed AJSArray. This is not uniformity
aesthetics — a term whose box discipline varies by carrier is a term whose provenance reading
is UNDEFINED: the second interpreter executes a different program depending on which
container the data happens to sit in. Representation chooses storage and iteration, never
meaning.
_Revealed by:_ (fixed) vector-map once stripped boxes while vector-filter and pair-map
preserved them — three answers to one question on overlapping carriers, each pinned green by
its own test — until DR4 made vector-map box-preserving too (`conservation.law.test.ts`),
closing the divergence this principle names.
_Forbids:_ per-carrier semantic divergence "for interop convenience"; blessing an accident as
"deliberately softer"; goldens that freeze the divergence.

**P9. Conversions are one-way unless a round-trip is PROMISED.**
Egress is where the box layer hands off to the trace (P4) — so the value-side conversion is
a total, honest projection with no residue of the world it left: a dotted pair folds into the
array, no `{__dotted__}` escape shapes, no partial idempotence. Where a round-trip IS
promised (the studio bifunctor lens), it is exact and tested as a law. Nothing in between.
_Revealed by:_ toJS's retired dotted-pair shape — a half-promise of reversibility that
serialized structure nobody could round-trip anyway.
_Forbids:_ marker objects encoding "what the value really was"; conversion outputs that vary
by whether the input was reconstructible.

## IV. Provenance

**P10. Provenance is total or it is nothing** _(P0's conservation law)_.
Every derivation propagates lineage — the second interpreter never skips an instruction. The
ONLY shed is named, explicit, semantic: egress past the membrane (the trace keeps it; the
JS value doesn't). (`exact->inexact` looks like a second shed but is not: the conservation
suite measures it propagating lineage fully — the exactness loss is the value layer's, the
box layer keeps its history.) The shed list is egress, only. An op that "rebuilds and therefore
drops" is a bug, full stop — rebuilding is an implementation detail of the value layer, and
the value layer does not get to abort the box layer.
_Revealed by:_ (fixed) `append` once rebuilt the spine dropping every element's provenance,
and `cdr` of a proper list once returned an unstamped spine cell — both pinned GREEN as
"documented asymmetries the eager path exhibits today" until the conservation repair
(`conservation.law.test.ts`) flipped both from `it.fails` to plain `it`: the rebuilt spine and
the projected sub-spine are now stamped with the deep-collapsed union of their elements,
matching `cons`' union-onto-container convention.
_Forbids:_ green tests asserting provenance loss; "the container was fresh so the lineage is
empty" reasoning; fixing a drop by blessing it.

**P11. Mint at the edge, propagate inside** _(the second interpreter's I/O rule)_.
Provenance points are created ONLY at membrane crossings (a rosetta source, an infer call, a
borrowed value's entry) — the box layer's inputs are the boundary's events. Pure interior
computation propagates and unions; it never mints, and a pure op consuming one source twice
still carries exactly that source. `pure: true` is a provenance CONTRACT, not an optimization
hint.
_Revealed by:_ (the healthy half of the audit — golden-prov enforces this correctly; kept as
a principle because everything else leans on it.)
_Forbids:_ interior ops minting "fresh" lineage; sources declared pure to skip stamping cost.

**P12. Tracing is core, not equipment — the trace is the second interpreter's OUTPUT.**
An optional trace is an optional interpreter, which is P0 denied outright. The spine
(EvalTrace, scope-ids, snapshots) lives in the interpreter and is always available; analysis
lenses and reactivity adapters layer on top, downstream, outside. (Always-available is not
always-running — the per-run arming asymmetry and its one footgun are P0's operational
rider. What P12 forbids is the spine living somewhere a consumer can simply not wire.)
_Revealed by:_ the spine living in an opt-in package a consumer could simply not wire.
_Forbids:_ core features whose lineage story depends on an external package being installed;
observability frameworks (mobx et al.) as core dependencies — adapters wrap the seam outside.

## V. The language surface

**P13. The platform's own grain decides the surface; departures are named supersets.**
R7RS semantics faithfully; Racket/Clojure forms only where R7RS leaves undefined behavior,
each a deliberate, documented, compile-coherent choice (bracket bindings, curly dicts,
keyword accessors). No host-under-the-hood "JS is the real semantics underneath" — a hidden host
semantics is a third, undeclared interpretation the other layers never agreed to.
_Revealed by:_ the pre-arrival host-interop stratum — dotted-symbol object walks, `-->`/`set-obj!`,
JS-truthiness harnesses asserting `===` as `equal?`.
_Forbids:_ host-language semantics reachable from scheme without a membrane crossing; syntax
whose meaning is "whatever JS does".

**P14. No shadow features.**
Every capability is reachable from a production entry, or it is explicitly STAGED — an
`it.todo`/gate-spec ledger naming what lands and when. A flag no entry can set, guarded by a
meticulous test suite, is the codebase lying to itself about what it ships. (The static
lineage classifier is the model of staging done right: a whole future interpreter, present in
the tree, gated by the G1–G7 ledger, wired to nothing until its coherence laws pass.)
_Revealed by:_ ~40 curly-infix invariants enforcing a feature `ExecOptions` cannot enable.
_Forbids:_ dead flags with live test suites; "we'll wire it later" without the gate ledger.

## VI. Test discipline

**P15. Green means design — and the highest form of test is a coherence law between two
interpretations.**
The suite's truth table is uniform: green = intended behavior; `it.fails` = documented gap
(flips loudly when fixed); `it.todo` = spec'd future. Asserting current-broken behavior green
— even annotated "documented current behavior" — is a lie that will fight whoever fixes it.
And the strongest suites in this package are exactly interpretation-agreement laws: chibi
(value layer vs the spec), golden-prov (box layer vs the eager oracle), the shadow suite
(static classifier vs the runtime pair), oracle-contract (Σ vs the reference reader). When
adding coverage, prefer a coherence law over a point assertion — it tests the choreography,
not one dancer.
_Revealed by:_ exact-number JSON.stringify throwing pinned green while its inexact sibling
was honestly `[fails]`; P10's now-fixed provenance drops (append/cdr, once pinned green,
exactly the lie this principle forbids — see P10's own citation).
_Forbids:_ "documents today's behavior" as a test category; rebaselining a golden to a bug.

**P16. Pin behavior, not internals — and pin the harness on purpose.**
An invariant names observable semantics. Impl-pinning (exact error strings, private fields,
class identities) is reserved for two deliberate uses: drift alarms (pack-symbol counts,
anti-vacuity floors) and harness self-checks (chibi's registries). A test that can only be
satisfied by one implementation is a refactoring tax, not a guarantee.
_Revealed by:_ the ~220 impl-pinning invariants — concentrated exactly where refactors
hurt most (clone-identity's 14 pinned `=== nil` file:line sites), thin exactly where the
suite is strongest (provenance: 12 of 258).
_Forbids:_ asserting private state when a public observation exists; documentation-as-test
(war-story ledgers belong in docs); vacuous both-outcomes-pass assertions.

---

## Precedence

When principles collide, the order is: **P0 (two-layer coherence) > P10/P11 (provenance
truth) > P4/P5 (membrane strictness) > P8 (algebra uniformity) > P7 (representation
authority) > everything else.** Rationale: the two-layer execution IS the machine — the rest
describe how to keep it running. Provenance is the product; the membrane is what makes
provenance sound; a uniform algebra is what makes the membrane's promises statable; authority
placement is how the first three stay maintainable. Convenience never appears in this list.
