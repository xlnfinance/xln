# The Env-Capability & Assembly Machine

> The mental model, stated once, ahead of the code. Every environment arrival runs is
> **assembled** — built from `EnvCapability` contributions linearized over a dependency
> DAG. This document says what a capability _is_, what it lowers to, and why the laws the
> code enforces (`preludeOnly` is assembly-time-only; a `pipe` that mints is a bug; `require`
> is bundled but inert without `fs`) _fall out of_ the machine's shape rather than being
> bolted onto it. `writing-capabilities.md` is the author's HOW-TO — "here is the law you
> obey"; this is the ontology under it — "here is what the machine IS, so the law is the
> only shape it could take."

Section anchors are CAPS so code comments can cite `docs/environments.md §<ANCHOR>`. Each
section closes with its enforcement sites (files, no line numbers — those rot). Every claim
here is grounded in those files; when code and this document disagree, one is a bug — decide
which before writing a line.

Constitutional ground: PRINCIPLES.md (P0 two-layer coherence, P1 no bare-fn value-space
terms, P7 the class is the representation authority, P11 mint-at-the-edge), RULINGS.md
(R2 container facts, R9 projection-keyed proxies), PROVENANCE.md (the provenance role
vocabulary and the wire/prelude/ingress layering assembly serves).

---

## 1. CAPABILITY — what a capability is, and the shape it lowers to

**A capability is one shape: a named, composable contribution of five things — symbols,
configuration, resources, prelude, deps — and _everything_ an arrival environment contains
is built from it.** The R7RS base, every SRFI, every dialect pack, the loader, and a domain
tool catalog are all `EnvCapability` instances. There is no second registration mechanism:
if the stdlib is expressible as capabilities, a consumer's tools are too.

**A capability is a MODULE SINGLETON.** `export default new EnvCapability(name, spec)`, one
`new` per package. It is **inheritance-free** — the contribution surface is a _closed
taxonomy_ of five spec keys (`configuration`, `resources`, `prelude`, `symbols`, `deps`),
configured by composition, never subclassed. A capability is a value, not a class hierarchy.

**The lowering chain is: module singleton → `Vocabulary` → `RunContext`.** `spec` is the
authoring form. `env/vocabulary.ts`'s `buildVocabulary` walks a capability set deps-first
(C3), validates each capability's config slice against its `configuration` schemas, turns
each resource declaration into a ref-counted `ResourceCell`, reads the (always literal — the
builder arm is retired) `symbols` record, and mints every symbol (membrane-wrapped) straight
into a frozen `Vocabulary` map — never producing an `EnvPack` (`EnvCapability.lower()` /
`LoweredPack` are retired, Stage C Cut 4). `env/assemble-run.ts`'s `assembleRun` then mints
the per-run `RunContext` off that Vocabulary and runs the per-run prelude pass (§7a). The DAG
is the authoring form; the Vocabulary is the flat, run-agnostic static form; the `RunContext`
is the per-run instantiation. `EnvPack` itself survives only as the mid-run extension-pack
shape `(require/extension …)` applies onto an already-live env (§ASSEMBLY, the mid-run path).

**The one law under all of it: dependencies point down, only down.** Verbs depend on the
capability machinery; the machinery lowers to a `Vocabulary` entry at bootstrap or an
`EnvPack` mid-run; neither interprets anything above itself. A capability never reaches
sideways into another capability's
internals — it declares a `deps` edge and uses the granted names. A capability's _scheme_
code obeys the same rule as its JS: a `symbol.define` body is free-variable-checked at bake,
so a capability never works merely because something else happened to assemble first
(§ASSEMBLY, § the FV locality law).

**A capability owns its whole contribution; a consumer configures it, never rewires it.**
The five keys are the entire surface:

- `configuration` — zod schemas for per-env config; supplied and validated at `lower()`.
- `resources` — the external ports this capability OWNS (§RESOURCES), static or a provider
  reading the parsed config.
- `prelude` — scheme bootstrap (`define-macro` + `define`s) evaluated into the env on apply
  (§PRELUDE). Shrinking as capabilities migrate their text blob to declared `symbol.define`s.
- `symbols` — the verbs, as baked `symbol.*` declarations (§SYMBOL-KINDS), always a plain
  record (the `EnvCapability.define` callback evaluates eagerly to one; the old _builder_
  `(activation) => record` arm is retired — impls read `this.configuration`/`this.resources`
  at dispatch instead of closing over an activation).
- `deps` — the DAG edges; a dep edge IS the grant.

**Enforcement sites:** `common/capability.ts`, `common/kernel.ts`, `common/scheme-env.ts`,
`env/vocabulary.ts`.

---

## 2. ASSEMBLY — C3 over the dependency DAG

**Assembly is C3 linearization — the same algorithm Python uses for method-resolution order
(Barrett, Cassels, Haahr et al., OOPSLA 1996; cited, not invented) — run over the dependency
DAG, applying each capability exactly once.** This is the single authoritative statement of
the mechanism; the kernel implements closure + 3-color cycle detection, identity dedup, the
C3 merge, and the apply loop, and every consumer inherits this one linearization.

**The dep edge IS the grant.** A capability lists another in `deps` to gain its exported
names; there is no separate "import" or "grant" verb. The DAG is authored as object edges
(a capability holds references to its deps), and C3 flattens it to a total order.

**Precedence, stated once to end the vocabulary drift:** in the linearization, **a dependency
is ranked BELOW its dependent** (dependents lead, dependencies trail — C3's monotonicity).
The apply loop then walks the order _in reverse_ — **least-precedence (deepest dependency)
first** — so a doubly-bound name ends up written by the **nearest** capability
(last-write-wins). "Dep precedes dependent" (linearization order) and "least-precedence-first
apply" (walk order) are the _same fact_ seen from the two ends: deps are applied first,
dependents overwrite. Disposal is the reverse: **LIFO**, dependents torn down before the
dependencies they stood on.

**A capability applies once, even in a diamond.** Closure dedups by capability _identity_;
the shared `config` bag is reference-equal across a capability's root and every dep
appearance, so a diamond-shaped graph dedups instead of tripping the config-conflict door.
Two same-name packs carrying _non-equal_ config in one assembly is a genuine conflict and
throws (`AssembleConfigConflictError`); functions compare by reference only, plain data
deep-equal.

**Array position is precedence the moment a member declares `deps`.** `BASE_PACKS` is an
ordered array; `buildVocabulary` (env/vocabulary.ts) feeds its own order into the C3 merge as
part of the roots list, so the array gives the total order. While every base pack's
cross-capability reference is late-bound at _call_ time (so prelude evaluation order is
behaviorally immaterial), the instant a member declares a `deps` edge the array must place
that member _ahead_ of its dependency — dependents lead, dependencies trail — or the merge
has no valid "good head" and throws (`AssembleLinearizationError`). The `BASE_PACKS` tail
block (racket → clojure → lisp → polyglot → srfi1 → binding → exceptions → lists) is exactly
this constraint resolved by hand. `env/base-roster.ts`'s `BASE_ROSTER` (`[...BASE_PACKS,
bytevectors, errorObjects]`) is the array actually folded into a run's tuple — the two extras
are the only former `NATIVE_PACKS` members with no `BASE_PACKS`-side `deps` reaching them
already (see next).

**Bootstrap is a SINGLE self-hosting fold, not a two-root sequence — the retired split is
retired.** The pre-Stage-C bootstrap assembled `NATIVE_PACKS` (the JS-implemented R7RS
domains — numeric, strings, vectors, equality, …) onto a `global_env` root and `BASE_PACKS`
(the `.scm`-defined stdlib — core, macros, polyglot, r7rs, srfi preludes) onto a child
`user_env`, because a base prelude calling `+`/`string-length` had to resolve child→parent
into an already-live native root. `BASE_ROSTER` dissolves the split instead: every base
symbol — `+`, `map`, `car`, the whole scheme surface — becomes an ordinary member of ONE
tuple's own C3 closure (`buildVocabulary([...capabilities, ...BASE_ROSTER], config)`,
`generator-exec.ts`'s `execStateViaVocabulary`), baked deps-first in the SAME loop as every
user capability, never via a parent-chain fallback. `global_env`/`user_env` name no live
binding anywhere in the package today — they survive only as the retired mechanism's own
name, kept in comments for lineage.

**Mid-run assembly is a distinct, single-flight path.** Bootstrap (`buildVocabulary`) builds a
_fresh_ Vocabulary once per capability-set tuple (memoized by identity — a repeat call
sharing the same capability/config objects reuses it rather than re-assembling; the retired
`assembleEnv` played this one-shot role pre Stage C Cut 4). `RuntimeAssembler.require` applies
registered packs onto an
_already-live_ env mid-run — idempotently and single-flight: a second `require` of the same
pack, or a concurrent one from a parallel HOF arm, awaits the one in-flight apply and never
re-applies. Deps apply first in C3 order; a pack reached two ways applies once; a rejecting
apply drops its single-flight entry so a later `require` may retry. This is the machine
behind `(require/extension …)` (§LOADER).

**Enforcement sites:** `common/kernel.ts`, `env/base-packs.ts`, `env/base-roster.ts`,
`env/vocabulary.ts`, `env/assemble-run.ts`, `common/symbols/define-bake.ts`.

---

## 3. SYMBOL-KINDS — the baked `AEntity` taxonomy

**A verb is authored through the `symbol.*` tagged-template factories, one file per kind,
and bakes to a discriminated `AEntity` union whose `kind` tells `apply()` exactly what
runtime value to bind.** The factories are re-assembled into the `symbol` namespace by
`common/symbols/index.ts`; the shared contract/decode types live in `common/symbols/_bake.ts`.
The cut is acyclic — factories import from `_bake`, nothing imports back up through the
namespace — and one-file-per-kind lets the bundler tree-shake to only the accessed tags
(ESM + `sideEffects:false`).

**Twelve authoring kinds; what each binds to at runtime:**

| kind             | authored as                                       | runtime bound value                                                            | notes                                                                                                                                                                                                                                                                                                   |
| ---------------- | ------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `native`         | impl over SCHEME VALUES, no validation            | first-class `ANativeProcedure`                                                 | contour primitive; contract is type-only (`.d.ts` harvest), zero runtime validation. Adopts `z.listAlike` spine slots before the impl runs (§CONTRACT).                                                                                                                                                 |
| `rosetta`        | impl in JS-land behind a codec membrane           | first-class `ARosettaProcedure`                                                | decode → validate → impl → encode → mint. The one membrane chokepoint (§MEMBRANE-SEAM).                                                                                                                                                                                                                 |
| `tagless`        | no impl — dispatch to the operand's own term      | `ANativeProcedure` wrapping a term dispatcher                                  | receiver is the last scheme arg; a missing method THROWS.                                                                                                                                                                                                                                               |
| `tagless-guard`  | tagless dispatch, graceful                        | `ANativeProcedure` wrapping a guard dispatcher                                 | a receiver with no method answers `#f` (predicate form: `vector?`, `pair?`), never an `instanceof` reach-around. Mints its verdict here (R8).                                                                                                                                                           |
| `sequence`       | ctx-aware op: `(schemeArgs, runCtx)`              | `ANativeProcedure`                                                             | dual of ctx-free native: threads the live run (callback apply / strict / signal), then dispatches to the term algebra — map/filter/reduce.                                                                                                                                                              |
| `notImplemented` | a teaching reason, no impl                        | `DoorProcedure`                                                                | errors-as-doors: an OMITTED verb throws a `PurityError` carrying the reason and the alternative bound in _this_ env.                                                                                                                                                                                    |
| `keyword`        | `name: doc`, no impl                              | a `Keyword` marker value                                                       | a special form made first-class: the evaluator resolves a call head through the env and dispatches `SPECIAL_FORMS[name]` on the marker — aliasable + lexically shadowable.                                                                                                                              |
| `macro`          | a raw JS `Macro`/`Syntax` transformer             | the `Macro` itself, bound as-is                                                | not arg-evaluating (native/rosetta) nor evaluator-dispatched (keyword); the generic `is_macro` hook expands it.                                                                                                                                                                                         |
| `define`         | a scheme-bodied value/procedure + a real contract | a validating `ANativeProcedure` (procedure) or the bare boxed value (constant) | decomposes a prelude blob into individually-declared, contract-bearing, FV-checked defines.                                                                                                                                                                                                             |
| `defineSyntax`   | a scheme-bodied macro/expander                    | a `Macro` fexpr transformer                                                    | `define`'s sibling; contract-free, carries a `macroAttribute` walk hint.                                                                                                                                                                                                                                |
| `value`          | `name: doc`, a host-supplied constant             | the boxed data value itself, never callable                                    | a raw DATA binding made first-class — the discriminated successor of the retired untagged `{ value }` `SymbolDeclaration` arm. Host sentinels (`mcp/break`'s `MCP_BREAK`), pre-marshalled data roots. `require`/`require/extension` are NOT this kind — they bind `symbol.native` procedures (§LOADER). |
| `alias`          | a template head naming a sibling verb             | _the target's own baked def_, re-bound                                         | dissolution: the alias binds byte-identically under its own name, never a wrapper. A fourth arm, outside `AEntity`'s discriminant, resolved before per-kind dispatch.                                                                                                                                   |

**Every run-kind is a first-class callable, never a bare JS function** (P1: a bare function
is a value the provenance interpreter cannot enter). `native`/`rosetta`/`tagless`/
`tagless-guard`/`sequence` all bind `ANativeProcedure`/`ARosettaProcedure` subclasses invoked
through the `arrival/tagless-final/apply` term; `door`/`keyword`/`macro` bind their own plain
objects. The one exception is `symbol.value` — a raw DATA binding (never callable), the
discriminated successor of the retired untagged `{ value }` `SymbolDeclaration` arm. `require`/
`require/extension` are NOT this kind — they bind `symbol.native` procedures whose call resolves
the module payload (§LOADER).

**`apply()` dispatches by `kind` and stamps three static facts onto the bound value:** the
resolved `provenanceRole`, the optional `cacheClass`, and the resolved `callbackRoles`
(§AXES). Every static interpreter — the lineage classifier, the wireframe builder — reads
these _off the bound value_ via `env.get(op)`, never a duck-read of an ad-hoc property (P7:
the declaration is data in string-key space, not a sniffed shape).

**Enforcement sites:** `common/symbols/index.ts`, `common/symbols/_bake.ts`,
`common/symbols/{native,rosetta,tagless,taglessGuard,sequence,notImplemented,keyword,macro,define,value,alias}.ts`,
`common/capability.ts`.

---

## 4. CONTRACT — one contract, four readers, two faces

**A symbol's zod contract is not annotation — it is the membrane crossing, and it has four
readers that must all agree.** `z.list(z.number)` _is_ the transform: the scheme proper-list
decodes to a real JS `number[]` before the impl runs, and the return encodes back. Declaring
the honest codec is the single act that keeps all four readers in agreement:

1. **runtime validation** — `z.decode`/`z.parse` at the boundary;
2. **the impl's inferred static types** — `z.infer` via the factory generics, so a
   wrong-typed impl is a _compile_ error;
3. **the harvested `.d.ts`** — the type-lens printer (`type-layer/schema-to-ts.ts`) reads the
   same schema;
4. **the crossing itself** — the JS↔Scheme membrane, each schema a per-arg codec.

"Take the raw value and sort it out inside" desyncs the four; it is a debt, not a shortcut.
(A _fifth_ reader exists but reads a different thing: the compiler's harvest consumes the
declaration record's `emit`/`narrows`/`refPolicy` fields, which describe idiomatic residual
rewriting, not the codec. It is a reader of the _record_, not of the _contract's schemas_ —
hence four codec-readers, one record-reader, never "five readers of the codec".)

**One vocabulary, two faces.** A codec's `z.input` is its SCHEME face (`AString`, `APair`,
`ACallable`); its `z.output` is its JS face (`string`, `array`, a callable). `symbol.native`
is a _contour_ — it stays in value algebra, so it projects the SCHEME face (a `z.string` slot
types the native impl's arg as `AString`, never the JS image). `symbol.rosetta` is the
_membrane_ — decode-in/encode-out — so it projects the JS face. A non-codec schema's two
faces coincide (`input ≡ output`), so pre-codec contracts type identically under either face;
the face split is strictly additive.

**The contract picks the chart.** A slot marked `z.listAlike` takes the _spine_ reading of
its argument: a borrowed JS array is projected onto an `AJSArrayList` view — O(1), same
backing store, same provenance — _before_ the impl sees it, and an empty array becomes `nil`.
This is spine adoption, and it runs where it must — in the bind path, before the impl —
because a native's contract is type-only with no runtime validation, and several impls
field-read their list argument (`.car`). The mark is _data_ (a `WeakSet` in
`common/spine-adoption.ts`, a zero-import leaf keyed by schema identity); the _adoption_ is
behavior (`membrane/adopt-spine.ts`, which needs the value classes). The same split, one
layer down, as the governing law: **the chart is chosen by the contract; the contract is not
the thing that performs the crossing.**

**`z.value` is retired, split by structural brand into `z.schemeValue` (the contour top type)
and `z.dynamic` (the crossing's fully-generic slot kind).** Both are a bare `instanceof AValue`
predicate, never a transform — but each is legal on only one side of the membrane, enforced at
COMPILE TIME: a `symbol.rosetta` contract slot's bound (`CrossingSlot`) rejects `z.schemeValue`,
and a native/sequence/tagless/define contract slot's bound (`ContourSlot`) symmetrically rejects
`z.dynamic`. `z.dynamic` is a special kind, never a default fallback: legal only for a slot
that is fully generic — ∀-quantified, the verb polymorphic in the slot, the value passed
through whole, keeping its scheme identity. A shape that is merely awkward or open-ended is
not generic — it has an honest codec (`z.union`/`z.dict`/`z.box`/`z.instance`). Every
`z.dynamic` slot is invisible to the type lens, unvalidated at the boundary, and barred from
`cacheClass: "view"` (a raw crossing does not serialize — the bake gate refuses it). Declare
the codec whenever one exists; `grep schemeToJsUntyped` is the audit list of every place the
untyped crossing was reached for.

**Enforcement sites:** `common/symbols/_bake.ts`, `common/scheme-zod.ts`,
`common/spine-adoption.ts`, `membrane/adopt-spine.ts`, `common/schema-tag.ts`.

---

## 5. MEMBRANE-SEAM — the bake-side crossing

_(Pointer-level only. The full membrane — proxies, region discipline, egress projection —
has its own document. This section states only the seam a baked verb crosses; §CONTRACT and
§AXES supply the vocabulary.)_

**The codec IS the crossing, stated once to end the double-framing.** There is one crossing
spine described from two sides: the `symbol.rosetta` bake wrapper (`common/symbols/rosetta.ts`)
and the inbound host-fn lens (`hostFnToCallable`) share `schemeToJs → fn →
jsToScheme`, with the contract codecs standing in for the generic conversions. A rosetta
verb's `run` decodes the scheme args to JS (the input codecs), calls the ctx-free impl,
awaits, encodes the return (the output codecs), then deep-stamps provenance. A _callable_
argument crosses through one of two families — `z.procedure` (typed, per-argument marshaling)
or `callableToHostFn` (untyped, honest passthrough) — and the two are **not competing
mechanisms**: they share one region-scope wrapper cache (keyed `(callable, scope, mode)`), so
a callable is wrapped exactly once. `jsToScheme` totalizes the inbound crossing through an
ordered, law-pinned claim registry: a recognized value boxes, an exotic object borrows
_loudly_ (never a silent raw pass-through), and a bare promise doors — there is no fall-through
that leaks internal representation three calls later (P5).

**Source mints, pipe forwards — at the crossing.** A `source`-role rosetta mints a fresh
provenance point off the invocation (`mintsPoint` when the op is not a pure pipe; historical `pure !== true` path;
`provenance !== "pipe"` in the baked path); a `pipe`-role rosetta forwards the input-provenance
union instead and mints nothing. With no invocation in ctx (a direct-JS call, no evaluator
frame) a source falls back to the input union. This is P11 (mint at the edge) made mechanical:
the boundary event is where the box layer's inputs are created.

**A declared crossing wraps; an undeclared one voids or doors — reconciled explicitly.** A
`z.procedure` slot is a _declared_ callable crossing: its decode marshals the scheme callable
into a host fn **synchronously, at decode time**, bound to the live region scope, so a reverse
call re-enters under the run's real context. A callable arriving through a `z.dynamic` slot is
_undeclared_: `z.dynamic` does no transform, so the raw scheme callable would be marshaled by
the impl itself — possibly _after_ an `await`, by which point the synchronous region-scope
window has closed and the reverse call would bind the detached scope. The machine forbids the
unsafe shape rather than trying to marshal it safely: a callable crossing a `z.dynamic` slot is a
teaching throw (`assertNotBareCallableInDynamicSlot`) steering the author to declare
`z.procedure`. The _outbound_ direction is barred
too, but by two distinct rules, not one: a rosetta returning a bare JS function is banned
outright ("a rosetta result is never a bare JS function — provenance untraceable"), and a bare
JS function surfacing as loader _data_ (a `kind: "value"` module result) is voided to `#void`
(the loader's callable rule). All of it is one principle — a bare fn is a value-layer-only term
the provenance interpreter cannot enter (P1) — worn as: declared callable in → host-fn wrapper
bound to the live scope; undeclared callable in → door; bare fn out → banned or `#void`.

**The region-scope gate is one gate, stated once.** A rosetta `run` opens a region scope
around a call **only** when the contract's input vector carries a slot that can hand the impl
a live callable (`z.procedure` or `z.dynamic` — `contractMayCarryCallable`). A lambda-free verb
(`+`, `string-append`, every plain data-in/data-out rosetta — the overwhelming majority) mints
no scope, touches no wrapper cache, pays zero cost. The scope's `runCtx` is the invocation's
live context, so a reverse-lambda minted under it re-enters via `scope.runCtx` — a lambda
calling a sink verb hits the effect-burst arm instead of firing inline. Binding to the shared
`DETACHED_SCOPE` (`CONSTANT_CTX`) is precisely the burst-bypass hole the gate exists to close;
it is the fallback when _no_ real scope is open, never a target.

**Enforcement sites:** `membrane/rosetta.ts`, `common/symbols/rosetta.ts`,
`membrane/region-scope.ts`.

---

## 6. AXES — independent declaration channels, bounded by named doors

\*\*A symbol can carry a provenance role (the lineage axis — where results come from), a cache
class (a serialization/replay axis), and — rosetta only — path producers (the CQS axis: which
resource domains a penetration reads/writes, `queries`/`effects`). These are independent
DECLARATION channels, not a single combined enum: declaring one never implies or forbids
declaring another. What keeps the product of all three from being "anything goes" is that
every legal REGION is bounded by a named door — six pairwise-axis gates plus the slot-kind
walls (contour/crossing brand bans), consolidated behind one call site per factory,
`assertContractAxes` (`common/symbols/_bake.ts`; hermeticity audit E1, 2026-08-13). The
legal-region table is below, after the axes are introduced individually. The word `pure` is
also overloaded across axes with different meanings — the standing trap for migrators, named
explicitly further down (§ "the `pure` naming hazard").

**The lineage axis — provenance role.** One declared role per symbol, data in string-key
space (P7), from the vocabulary `pipe · fan · source · sink · transparent · loop · opaque`
(the full PROVENANCE.md set; `pipe`/`fan`/`source` are live declaration defaults today, the
rest are graph-layer targets no declaration marks yet). The three live meanings:

- **`source`** mints a fresh origin — external data crosses in (a rosetta reading the world).
- **`pipe`** forwards its inputs' lineage — a pure transform that mints nothing.
- **`sink`** has no egress at all — an effect (§ below).

The declaration is load-bearing, not documentation: a `pipe` that minted would fabricate an
origin (the seal-laundering class of bug), and the provenance seal and reverse slicer read this
declaration directly off the bound value.

**Per-kind default, stated once as a table** (the definition lives at
`Contract.provenance`, the resolved value on each baked def, the stamp in `capability.ts`):

| kind            | default role            | override channel      |
| --------------- | ----------------------- | --------------------- |
| `native`        | `pipe`                  | `Contract.provenance` |
| `sequence`      | `pipe`                  | `Contract.provenance` |
| `tagless`       | `pipe` (always)         | none — contract-less  |
| `tagless-guard` | `pipe` (always)         | none — contract-less  |
| `rosetta`       | `source`                | `Contract.provenance` |
| `define`        | **derived** (see below) | drift-door only       |

**`define`'s role is the one exception: it is DERIVED by a fixpoint, not defaulted.** At
bake, `classifyProgramPrelude` runs over the capability's _whole_ `symbol.define` set: a body
that is fixpoint-closed (reaches no port, directly or transitively) resolves `pipe`; one that
reaches a port resolves `opaque` (the conservative collapse — the full per-body lineage tree
stays re-derivable from the body for a finer-grained future consumer). An authored
`Contract.provenance` on a define is legal _only_ as a drift door: a declared role
contradicting the derived classification throws `ProvenanceRoleShapeError` at bake; it is never
itself the resolved value.

**The drift alarm catches contradictions, not lies.** Two contradictions are shape-decidable
and door at bake (`assertProvenanceRoleShape`): a `sink`/`transparent` whose output vector
carries a real return, and a `fan` whose input vector has no `z.lambda` arm to apply. A JS body
that fans while declared `pipe` is consistent-but-wrong and invisible to shape — its mitigation
is the agreement gate plus the generator corpus, never a shape guess bolted on here.

**Effects are sinks, and void-by-law is what makes gather-then-burst sound.** A `sink` returns
void by law — the bake gate rejects a sink whose contract carries a real return. Because a
sink's contract _proves_ it returns nothing, a host running in deferred mode can collect sink
penetrations instead of firing them without changing any value the program computes; the run
proceeds identically and the effects fire as one reviewed burst. If an "effect" must hand a
result back, it is not a sink — it is a source with consequences and must say so.

**The cache axis — cache class.** An explicit declaration (Solidity's vocabulary, Ruling A),
_never_ derived from the lineage role:

- **`view`** — a persisted boundary snapshot, cacheable across runs; demands a serializable
  contract (the bake gate `assertCacheClassShape` rejects `z.lambda`/`z.schemeValue`/`z.dynamic`
  slots on either vector — a cache entry must serialize).
- **`pure`** — regenerateable, deterministic from decoded args; recovery is re-call, nothing
  persisted; no shape gate.
- **absent** — the safe default: regenerateable, re-runs on replay.

Both `view` and `pure` stay provenance `source` on the lineage axis — a cacheable read still
introduces external data. `infer` is the standing proof: a `source` declaring
`cacheClass: "pure"`.

**The `pure` naming hazard, stated once.** `cacheClass: "pure"` is a cache class **on a
source** (mint still happens). It is not provenance **pipe** (mints nothing). Different axes,
same word — do not map "pure" from one axis onto the other. `native`/`sequence` carry a
`cacheClass` channel but the run-cache interception lives on the rosetta membrane only (a native
is a contour, not a penetration); the resolved field still rides every def uniformly for
downstream readers.

**Callback roles ride alongside, one per `z.lambda` arm in lambda order** (`element-transformer`,
`control`, `effect`, `accumulator`), shape-extracted where shape decides, declared where it
underdetermines, drift-doored where a declaration contradicts a shape-decided arm. The
`accumulator` arm declares the acc-chain — the one sanctioned inter-track edge.

**The legal-region table.** Every named door that bounds the axis product, one row per
constrained pair, plus the slot-kind walls (the contour/crossing brand runtime twin — not an
axis pair, but the same enforcement shape):

| constrained pair                                           | rule                                                                                                                                          | gate function                     | error class                     |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ------------------------------- |
| provenance `sink`/`transparent` × output vector            | output must be void-family (no real return)                                                                                                   | `assertProvenanceRoleShape`       | `ProvenanceRoleShapeError`      |
| provenance `fan` × input vector                            | input must carry a `z.lambda` arm to apply                                                                                                    | `assertProvenanceRoleShape`       | `ProvenanceRoleShapeError`      |
| cacheClass `view` × both vectors                           | must serialize — no `z.lambda`/`z.schemeValue`/`z.dynamic` slot                                                                               | `assertCacheClassShape`           | `CacheClassShapeError`          |
| `queries` × both vectors (rosetta-only)                    | must serialize — same slot rule as `view`                                                                                                     | `assertResourcePathContractShape` | `ResourcePathShapeError`        |
| provenance `sink` × `queries` (rosetta-only)               | banned together — under gather a sink's impl is SKIPPED, so a declared Q would journal a read for a body that never ran                       | `assertResourcePathRoles`         | `ResourcePathRoleConflictError` |
| `effects` without `queries` × output vector (rosetta-only) | output must be void-family — an effects-only return is unlicensed (the Q half licenses a real return; upsert-with-return is the hybrid shape) | `assertResourcePathRoles`         | `ResourcePathRoleConflictError` |
| contour/crossing brand × both vectors (all kinds)          | rosetta bans `z.schemeValue`; native/sequence/define ban `z.dynamic`/`z.instance`                                                             | `assertSlotKinds`                 | `ContractSlotKindError`         |

One call site per factory: `assertContractAxes(name, kind, opts)` (`common/symbols/_bake.ts`)
sequences the gates a `kind` needs — rosetta calls all six pairwise doors plus the slot-kind
wall; native/sequence call the role-shape, cache-shape, and slot-kind gates (no path axis —
`queries`/`effects` are rosetta-only fields); define calls the slot-kind wall alone
(provenance is DERIVED later, by fixpoint over the whole define set, in `define-bake.ts` —
see above). Each individual gate function stays exported; law tests pin them directly, not
just the aggregator.

**Enforcement sites:** `common/symbols/_bake.ts`, `common/symbols/rosetta.ts`,
`common/symbols/native.ts`, `common/symbols/sequence.ts`, `common/symbols/define-bake.ts`,
`run/run-cache.ts`.

---

## 7. PRELUDE — assembly-time scope and phase gating

**A `preludeOnly` symbol is assembly-time-only, and this is a structural fact of the bake, not
a policy layered on it.** Assembly IS the bake — the one-time phase that evaluates capability
preambles against the chain-so-far. A `preludeOnly` native/rosetta/macro binds not into the
runtime env but into a per-assembly overlay: a `Map` behind `ctx.preludeScope`, answered by a
resolver registered _on the base env_ for the duration of the C3 loop only. Because resolvers
are consulted at every layer of a chain walk, a prelude evaluated against the base resolves the
symbol exactly as a real binding would.

**The seal is what makes `preludeOnly` mean what it says.** At the end of the C3 loop (success
_or_ failure), the overlay is dropped — the resolver unregistered where the host supports it
(zero residue), silenced by a sealed flag where it does not. Post-seal the name is a plain
unbound variable _everywhere_, **including from closures a prelude defined** — a closure walks
the live chain at call time, and the overlay is gone. `preludeOnly` therefore means
assembly-time-only, not run-within-prelude-scope. This is the contract, not a gap: **a prelude
that must carry a `preludeOnly` value into runtime captures the VALUE at assembly time
(`(define x (the-prelude-verb …))`), never the verb.** The bridge captures the result of the
call, not the callable.

**Bootstrap and mid-run gate the prelude at _different_ scopes — a deliberate asymmetry.** In
bootstrap (`assembleEnv`), a capability's prelude TEXT evaluates against the base env (so its
`define`s land in the runtime env `R`), while `preludeOnly` bindings ride the phase-gated
overlay. Mid-run (`RuntimeAssembler.require`, the `(require/extension …)` path), the live env is
concurrently evaluating the user program and cannot be handed to the phase-gated machinery; so
each call seeds a fresh **discarded child scope `C'`** and evaluates the prelude against it —
lookups miss `C'`, fall through to the live env, and `C'` (with any prelude `define`s) is simply
dropped when the call returns. The consequence is load-bearing, not a bug: **a mid-run pack's
own prelude `define`s are lost; only its declared `symbols` reach the live env.**

**`symbol.define`/`symbol.defineSyntax` bind in Pass 2, after every other kind and the prelude.**
Within a capability, the two-phase apply binds all non-define kinds first (Pass 1), evaluates
the prelude, then evaluates and binds the defines sequentially in declaration order (Pass 2) —
so a define's body may always assume its capability's own native/rosetta/door siblings are
already bound. The FV locality law runs here: every free variable in a define body must resolve
to a sibling symbol, a dep's export, the keyword baseline, or the `c[ad]+r` resolver family,
else bake doors naming the fix. This is the point — a capability's scheme code declares its
imports the same way its JS does.

**Only two production producer classes ever register a resolver**, and they are the assembly
machinery itself: the kernel's phase-gated bake overlay (transient, dropped at seal) and a
capability's declared `resolvers` (`CapabilitySpec.resolvers`, e.g. the `:key` accessor and the
`c[ad]+r` family). Both land on a `ResolvingAmbient` root (§HERMETIC); a plain lexical frame
carries no resolver leg.

**Enforcement sites:** `common/kernel.ts`, `common/capability.ts`, `common/symbols/define-bake.ts`,
`common/scheme-env.ts`, `env/AmbientRuntime.ts`.

### 7a. PRELUDE — the VOCABULARY PATH contract (Stage B2)

Everything above this subsection describes the retired `lower()`/`assembleEnv` path (bootstrap's
`ctx.preludeScope` overlay, mid-run `require`'s discarded child scope `C'`). The vocabulary path
(`env/vocabulary.ts` + `env/assemble-run.ts`) — the internal `ExecOptions.vocabularyPath` routing
flag that once selected it at Stage B1 is itself retired; it is the ONLY bootstrap path today —
realizes the SAME contract — prelude is assembly-time-only, a closure survives by lexical
capture not by a leaked binding — through a DIFFERENT mechanism, worth stating on its own terms
rather than as a diff against the retired prose.

**Prelude is PER-RUN SYSTEM CODE — its defines are per-run bindings, never vocabulary
members.** `env/vocabulary.ts`'s
`buildVocabulary` COLLECTS every `.spec.prelude` in the tuple's C3 closure into
`Vocabulary.preludes` — deps-first, deduped by capability IDENTITY — but never executes it: the
Vocabulary is a shared, memoized, run-agnostic artifact, and a prelude's whole purpose (this
stage's ruling) is programmatic inter-capability wiring THROUGH RESOURCES, which only exist
per-run. Execution is `env/assemble-run.ts`'s `assembleRun` job: mint the RunContext (vocabulary
attached, resource store empty), THEN walk `Vocabulary.preludes` — C3 order, already
identity-deduped — evaluating each capability's prelude text against a fresh, DISCARDED prelude
scope, THIS run's `runCtx` threaded through every form (`AssembleRunOptions.evalPrelude`, an
`EvalPreludeInto` callback distinct from the build-time, runCtx-less `evalScheme` that feeds
`symbol.define`'s Pass-2 bake). A prelude touching a resource-reading verb spawns that resource
into THIS run's bag — the loader's extension registry, for instance, comes alive on the first
run that actually registers something, never at vocabulary-build time.

**Single execution per run is a hard law, and it falls out of the collection-side dedup, not a
separate mechanism.** A capability reachable through two DAG edges (a diamond) contributes
exactly ONE entry to `Vocabulary.preludes` (B1's identity dedup); `assembleRun`'s single pass
over that array is what makes execution single-per-run. Two SEPARATE `assembleRun` calls over
the same tuple each run their own single pass — the Vocabulary is shared, but prelude EFFECTS
are not: each run gets a fresh resource bag, so a prelude-incremented counter reads 1 in every
run, never accumulating. A registration-conflict door (`"cannot register X twice"`-shaped) is
the built-in regression DETECTOR for this law: manually re-running a capability's prelude text
against an ALREADY-assembled run's `runCtx` must hit the door, because the run's registry
already holds that entry.

**The prelude pass runs over TWO frames: a discarded NULL-ROOTED seed, and an eval child
whose defines persist** (ruling 2026-08-13, audit B4). The SEED — a fresh
`ResolvingAmbient.root("assemble-run-prelude-seed")`, no parent at all (Stage C Cut 2's
self-contained posture, matching `vocabulary.ts`'s own `bakeEnv`), never reused, never
returned, discarded once the pass completes — holds the main map (`Vocabulary.map`) THEN the
preludeOnly overlay (`Vocabulary.preludeOnly`). On a cross-capability name collision between
the two maps, **preludeOnly SHADOWS the main symbol DURING the prelude pass** — the defined
rule (P-PRELUDE-PHASE-SHADOW), not an accident; main-phase code sees only the main symbol.
A prelude can still call a base-pack primitive (`+`, `string-length`, …) because `BASE_ROSTER`
is an ordinary member of THIS tuple's own `Vocabulary.map` (the caller folds it in —
`generator-exec.ts`'s `execStateViaVocabulary`), bound directly into the seed — never via a
parent-chain fallback onto a `user_env` realm, which this path never mints. The prelude TEXT
evaluates against the EVAL child, so its `(define …)`s land apart from the seed bindings.

**Prelude `(define …)` PERSISTS into the main phase — "invocation survives, reference does
not"** (ruling 2026-08-13, superseding the earlier discard contract). After the pass, the eval
child's own defines are copied into the run's PER-RUN PRELUDE-DEFINE FRAME
(`assemble-run.ts`'s `preludeDefinesOf`), and the exec entry roots each fresh user scope at
it: session frame → prelude defines → the shared Vocabulary chain. Consequences, all
law-pinned (`env/__tests__/prelude-persistence.law.test.ts`):

- `(define (something) (prelude-symbol prelude-arg))` written in a prelude is CALLABLE from
  user code, and its body still reaches the preludeOnly verb through ordinary lexical capture
  into the discarded seed — while `prelude-symbol` itself stays a plain `UnboundVariableError`
  from user code. This is the require-extension surface: a pack's prelude is its channel for
  contributing scheme-defined wrappers.
- A prelude define SHADOWS a same-named vocabulary symbol in the main phase (it sits above the
  chain); a user top-level define shadows both (it sits above the define frame).
- Defines are PER-RUN — two runs of one tuple never share them; a REPL-reused runCtx keeps
  them without re-preluding.
- MID-RUN `(require/extension …)` appends the extension pack's prelude defines to the SAME
  frame (loader-capability.ts: seed child `C'` carries register-extension + preludeOnly binds
  and dies; eval child `D'`'s own defines are copied after apply) — the live session-scope
  walk sees them immediately. The retired "mid-run pack preludes cannot contribute runtime
  bindings" asymmetry is gone.
- STATIC VALIDATION stays deliberately BLIND to prelude defines (a prelude is arbitrary
  scheme — its defines are not statically knowable): `staticValidation: "on"` may flag a
  program that would resolve at runtime through a prelude define.

**A closure a prelude mints keeps its lexical captures — pure scope math, not a temporal gate.**
`(lambda () (some-prelude-only-symbol))`, minted while the prelude frames are live, keeps
resolving `some-prelude-only-symbol` when CALLED later from user code, because a closure's
captured scope is a reference, not a re-resolved lookup — the seed being discarded afterward
doesn't touch a reference already held. The RESOURCE bridge remains for values that must cross
runs or reach a verb body: a preludeOnly registration verb stashes a prelude-minted closure
into this run's resource bag; a public verb retrieves and applies it via `applyCallback` with
the CURRENT dispatch's own `CallCtx` (the same seam every HOF — `map`/`filter`/`fold` — uses),
never through a `symbol.define`-baked body: a baked define's body evaluates against its
DEFINITION-TIME `ctx.runCtx` (captured once, at vocabulary-build time, shared across every run
of the tuple), not the call-time one — a pre-existing, documented, orthogonal limitation
(`common/symbols/define-bake.ts`) that makes `symbol.define` the wrong tool for a body that
must read PER-RUN resource state.

**Enforcement sites:** `env/vocabulary.ts`, `env/assemble-run.ts` (`preludeDefinesOf` /
`ensurePreludeDefineFrame`), `eval/generator-exec.ts` (`runRootedScope`, the
`preludeEvalScheme` callback), `@inhuman.tools/arrival-modules` (`require/extension`),
`common/scheme-env.ts` (`EvalPreludeInto`), `env/__tests__/assemble-run.test.ts` +
`env/__tests__/prelude-persistence.law.test.ts` (the law suites).

---

## 8. HERMETIC — the runtime and its storage

**The environment is hermetic: from JS it can only be BORN (assembled) and READ — never
mutated, never extended. This is the HERMETIC-ENVIRONMENT ruling** (the same ruling appears in
older comments as "hermetic-AmbientRuntime"; that alias is dead — one name). The structural
`SchemeEnv` contract cross-package consumers type against carries `get`/`registerResolver`/
`list`/`allBoundNames` and **deliberately no `set`, no `inherit`, no `merge`**. Values enter the
interpreter only as capabilities or overrides; a pack contributes bindings _declaratively_, it
does not write.

**Privilege is the concrete internals type, not a secret function.** `SchemeEnv` is the
hermetic JS face — read-only. Frame _birth_ is `AmbientRuntime.child` / `.root` (and the
`ResolvingAmbient` overrides): subtype-preserving, so a `ResolvingAmbient` parent mints a
resolver-capable child, and a capability base built on `inferenceEnv` — or
`env/vocabulary.ts`'s own null-rooted `bakeEnv` — stays resolver-capable with no ceremony.
Null-parent birth is `AmbientRuntime.root` / `ResolvingAmbient.root` (there is no parent
instance). Binding is `bind` on the frame prototype, **absent from `AmbientRuntime`'s
type** — a public `LexicalScope.env` does not type `.bind`. Writers _extend_ the
declaration at the definition that intends to write (`scope as LexicalScopeWithInternals`,
`resolver as LexicalScopeWithInternals<Resolver>`, `env as EnvWithInternals`); every such
annotation is an access site. After that, `.env.bind` / `.bind` is ordinary method use.
The types are on `/host-internals`, not the public barrel. A new public bind API on
`SchemeEnv` is a regression.

**Storage is inside the membrane, and the read face doors on a raw scalar.** Every writer boxes
at its own boundary before `.bind`; so a raw JS scalar (string/number/bigint/boolean)
surfacing on a read means a writer bypassed the membrane — the read face teaches and refuses
(`RawCrossingError`), never silently re-boxes. The same predicate guards the resolver boundary:
a fallback resolver must hand back a boxed scheme value or a membrane primitive, never a raw
scalar for the evaluator to consume contract-free.

**The env carries no name tables — an absent name is a capability door, not a curated list.**
There are no well-known-but-absent name tables in the environment. Teaching about a missing R7RS
feature (`set!`, `call/cc`, the mutators) is _declared capability data_: a `symbol.notImplemented`
door bound like any other symbol, which the ordinary lookup walk resolves and fires. The unbound
wall's typo suggestions come from _this chain's actual vocabulary_ (`allBoundNames`), never a
hardcoded roster. Absence is meaningful: a name the env did not bind is a door the capability
chose not to open (a `preludeOnly` symbol at runtime; §LOADER's `require` itself stays BOUND
and doors on missing config instead — §DEGRADATION-D2).

**The retired `global_env`/`user_env` pair is now a SINGLE null-rooted frame per Vocabulary,
sealed once.** `generator-exec.ts`'s `sealedVocabularyChain` mints one NULL-ROOTED
`AmbientRuntime.root("exec-vocabulary")` per `Vocabulary` object (memoized in a `WeakMap`, so it is
built once no matter how many runs share the tuple), binds every `Vocabulary.map` entry onto
it, then seals it via `sealResolutionChain` into a frozen `CompiledResolutionChain` — the
sealed artifact has no write surface, so the write window (mint the frame, bind it, seal it)
is a structural fact, not a convention: nothing a run does afterward (a `define`, a `require`)
ever writes into it. Top-level user defines accumulate on a mutable session frame _above_ the
sealed chain (REPL semantics, `Capabilities`/`LexicalScope`), never on the shared chain.

**The public caller face is now ONE glass, not two.** The retired `exec({ env })` option ran
against an existing environment — the session's accumulated frame chain, shared state visible;
today every barrel-exported entry point (`exec`/`execState`/`execExpr`, `ExecOptions`) only
takes `{ capabilities }` — `buildVocabulary`/`assembleRun` mints a FRESH tuple for that run,
nothing leaks in, nothing leaks out but the return value. The `{ env }` shape survives as
`ExecOptionsOverFrame` — an internal, non-barrel-exported seam (`execStateOverFrame` et al.,
`eval/generator-exec.ts`) for the one class of caller that still legitimately needs a live frame
to bind bespoke rosettas/resolvers onto by hand (test harnesses only; production code never uses
it). The hermetic ruling's caller face is therefore: "a new one born for you" is the only public
door; there is no third door that mutates someone else's.

**Security is by non-existence, not by fencing.** The inference plane inherits user→global and
is total: no host-reaching verb EXISTS in the language to block, so there is no per-env
blocklist to maintain or bypass. The polyglot membrane is the only language-crossing door.
A fence guards a verb that exists; arrival removes the verb.

**Enforcement sites:** `env/AmbientRuntime.ts`, `common/scheme-env.ts`, `env/vocabulary.ts`,
`eval/generator-exec.ts` (`sealedVocabularyChain`), `eval/CompiledResolutionChain.ts`,
`env/inference-env.ts`.

---

## 9. RESOURCES — capability-owned ports

**A capability owns its external ports, and every read of one is deferred to the moment the verb
runs.** A `Resource<H>` is a factory of disposable handles — the Erlang-port model over TC39
`AsyncDisposable`. `ResourceCell` wraps the factory with the one thing the TC39 spec omits: the
**re-acquirable cycle**. One operation, `get()` (acquire-if-needed, single-flight), yields three
behaviours:

- **lazy spawn** — the port opens on first verb touch, never at spin-up;
- **single-flight parallel acquire** — N concurrent `get()`s share ONE in-flight acquire (a
  group warms together via `Promise.all`);
- **reconstruction** — wind-down disposes the handle; the next `get()` opens a FRESH one, and the
  `Ref` identity is stable throughout.

Disposal is never reinvented — the handle's release IS its `Symbol.asyncDispose`; the cell only
adds the cycle around it.

**First touch of any of a capability's symbols pre-spawns ALL its resources before the body
runs**, so a verb reads `this.resources.x.live` synchronously and `.live` never races. The
capability dictates the entity set; the env accessor makes presence a precondition. Reading
`.live` at construction time (module top-level, spec literal, constructor) is always a bug — no
activation exists yet, and eager reads at assembly are the connection storm the lazy model exists
to prevent.

**Wind-down is pause, resume is re-spawn, teardown is reverse.** `common/resources.ts`'s
`windDownAll` releases every resource (keeping the wiring) — wired to `RunContext` disposal via
`capability.ts`'s `onRunContextDispose(runCtx, () => windDownAll(...))`, the retired
`LoweredPack.windDown()`'s successor; the next touch re-acquires. A set winds down in reverse
order — dependents before dependencies, LIFO — matching the assembly's own disposal order.

**Enforcement sites:** `common/resources.ts`, `common/capability.ts`.

---

## 10. DEGRADATION — doors, not silent absence

**Withholding a verb is a declaration, and its default form is informational.** The kernel and
every host/provisioning path assemble under `degradation: "forbid"` (the default): an absent
optional-enabling config key is purely informational — `Activation.degradation.active` stays
false, no capability's behavior changes unless it explicitly consults `.door(...)`. This is the
one fact restated at five sites in the code, stated authoritatively once here: **`forbid` mode
changes nothing; it only records what is missing.**

**Absence becomes a teaching door through `Contract.requiresConfig` — mode-independently (D2).**
A verb declaring its enabling keys in `requiresConfig` binds a _cause-carrying_ door when they
are absent: instead of the symbol being missing, it binds a `DoorSymbolDef` naming its owner and
the missing config key that would satisfy it — under either mode (the builder-form path that
made this a `"doors"`-only, hand-minted trade is retired). The assembly's `degraded` list then
enumerates every capability that lowered degraded — a host reads it instead of probing symbols
one by one.

**Withhold-by-absence is retired; the door IS the posture.** The builder-form capability that
could withhold a verb when its config was absent is gone with the builder arm — a config-gated
verb is always enumerated and doors on its missing keys via `Contract.requiresConfig` (D2 —
mode-independent: loader's `require` doors on its `[["fs", "loader"]]` any-of group under EITHER
mode). **Never withhold by silently omitting a symbol from the record when a cause could be
carried; declare the gate as the verb's `requiresConfig` so the absence names its own cause.**

**Permanent omission and degradation are distinct causes on the same door type.** A
`notImplemented` door is a _permanent design omission_ (`set!`, `call/cc`, the mutators — R7RS
features the purity invariant omits): its `DoorCause` names the owning capability with an empty
`needs`. A degradation door names a _non-empty_ `needs` — a config key that was absent. The
`needs` scope is deliberately configuration-only today (a dependency need would name an unrooted
capability, a policy not yet designed); `dependency`/`resource` needs are strictly additive
extensions, never a retrofit.

**"Optional" is a structural declaration fact.** The degradable set is computed by a structural
check (`instanceof z.ZodOptional | z.ZodDefault`), not zod's `.isOptional()` — which a
`z.custom()` schema answers `true` for regardless. A genuinely-required-but-permissive key stays
fail-closed, invisible to degradation; only a declared-optional key can degrade.

**Enforcement sites:** `common/degradation.ts`, `common/capability.ts`, `common/symbols/_bake.ts`,
`common/kernel.ts`, `@inhuman.tools/arrival-modules`.

---

## 11. LOADER — the worked exemplar, end to end

**`arrivalLoaderCapability` is the module system as a plain `EnvCapability`, and it demonstrates
every axis of the machine at once.** `(require …)`, `(require/extension …)`, and
`(require/register-extension …)` are declared here; all their per-run state lives on the
capability's own axes, so nothing is wired imperatively and nothing is pushed out through
callbacks.

**`fs` IS configuration, and `require` is ALWAYS ENUMERATED — gated by a disjunctive
`requiresConfig` door.** The primary surface is `configuration.fs` — a raw read-capable
filesystem; the capability derives its own `Loader` internally (`makeFsLoader`). A pre-built
`configuration.loader` is accepted and _wins_ over `fs`, for the one thing `fs` cannot express: a
caller injecting custom resolvers (the `.yaml`/`.toml` handlers `@inhuman.tools/arrival-modules/yaml` /
`@inhuman.tools/arrival-modules/toml` thread).
**`require` is callable when a loader is derivable** (from `fs` or `loader`); with neither armed
it binds a cause-carrying `DoorProcedure` via the auto-derived `requiresConfig: [["fs",
"loader"]]` gate (§DEGRADATION-D2 — the any-of GROUP form: satisfied while at least one key is
present), so a loaderless program's `(require …)` is a STATIC "missing-configuration" diagnostic
teaching "provide `fs` or `loader`", not an unbound variable. (This supersedes the earlier
withholding-by-absence posture: the verb's _presence_ is now static — the `.define` symbol record
is config-independent — and only its _callability_ is config-derived. The door mints under either
degradation mode; `Vocabulary.degraded` (mirrored onto `RunContext.degraded`) enumerates the
same misses.) "Bundled but inert without
`fs`" stays structural — the door IS the inertness, made legible.

**Run state IS resources, not stashed callbacks.** The lifecycle-bearing per-run state is the
capability's per-`RunContext` resources bag (§RESOURCES, the `.define` factory form): the
single-flight require session (module cache + cycle bookkeeping — a FRESH bag is minted per
`RunContext`, so run teardown _is_ "clear the cache between runs") and the per-live-env
`RuntimeAssembler` backing `(require/extension …)` — the bag's `[Symbol.asyncDispose]` is
`assembler.dispose()`, so winding the run down tears every runtime-applied extension back out.

**`require` and `require/extension` are RAW-BOUND `symbol.native` procedures, deliberately not
rosetta-wrapped.** `require` returns a callable for `(define run-x (require "x.prompt"))` — the
data is born when the proc is _invoked_, not when required, so a provenance mint here would
surface `require` as a spurious chain node, and a return marshal would void an `eval` module's
scheme lambda. The single-flight `inflight` cache is exactly the mid-run assembly discipline
(§ASSEMBLY) at the module grain: a `(map (require …) …)` fan-out shares one session; genuine
`.scm` cycles throw; value/eval modules are require-graph leaves that cannot cycle.

**`require/register-extension` is a `preludeOnly: true` MACRO** (§PRELUDE): a macro so the
resolver name is _unevaluated_ (a bare symbol, not a string forced by evaluating a function
binding, whose `String(fn)` would poison the registry key). It is callable from every
later-applied capability's prelude during assembly and a plain unbound variable at runtime — so
the loader capability must apply _before_ the capabilities whose preludes call it (listed last in
the root set, lowest precedence, applied first).

**`(require/extension …)` builds a mid-run child `C'`.** It resolves the named pack, applies it
(and its deps, C3 order) to the _live_ env through the per-env `RuntimeAssembler`, and returns
void — the pack's symbols are now live. Because bootstrap's phase-gated machinery cannot touch a
live env, each call seeds a fresh discarded child `C' = liveEnv.child("prelude/<name>")`
seeded with `register-extension`, passed as both the bind target and the eval scope; `C'` is
never linked into the live env and is dropped when the call resolves (§PRELUDE's mid-run
asymmetry: the applied pack's own prelude defines are lost with `C'`; only its declared symbols
reach the env).

**Enforcement sites:** `@inhuman.tools/arrival-modules` (`loader-capability.ts`,
`loader.ts`, `loader-extensions.ts`).

---

## 12. DESCRIBE-TIME — the MCP / metadata read channel

**Describe-time is a distinct read channel; this section is a pointer, not a duplication.** A
symbol's `metadata` extension bag carries per-field static-or-dynamic data (MCP annotations,
catalog text, dashboard fields). A _dynamic_ field resolves lazily at describe/catalog read time
against the assembly's phase-2 activation — never at bake — through `resolveMetadata`
(`common/symbols/metadata.ts`, the canonical home and its three rulings: lazily-at-read against
the phase-2 activation; per-read, no memo; `undefined` resolution falls back to the static
sibling and is _not_ flagged session-generated). `resolveMetadata` takes a per-capability
`Activation` (`common/capability.ts` — the same `this.configuration`/`this.resources` context
§7's Pass-2 dispatch uses) directly; the retired `assembleEnv`'s own `AssembledEnv.activations`
fold that used to collect and expose these across a whole assembled env is gone with it (Stage
C Cut 4), and no production caller wires `resolveMetadata` yet (test-only today) — the phase-2
read surface this channel targets is a design target, not shipped wiring.

**How to _author_ for this channel — the resource-deferral law, the object-spread hazard, the
intent-not-impact rule for MCP exposure — lives in `writing-capabilities.md` and the
`env-capability-authoring` skill.** This document says only what the channel _is_: metadata reads
are describe-time host-side IO outside every wire — no provenance node, nothing enters a record
stream, and scheme programs never see metadata (there is no `(symbol-metadata …)` verb, the same
law as no `(configuration :key)`).

**Enforcement sites:** `common/symbols/metadata.ts`, `common/capability.ts`,
`eval/exec-phases.ts`; authoring HOW-TO in `writing-capabilities.md`.
