# RULINGS — design rules R1–R12 + key taxonomy

Numbered design rules for arrival's value, provenance, and membrane layers. Code and
tests cite them by ID ("RULINGS.md R2"); the IDs are stable anchors.

## R1 — Exit convention: uniform plain-JS, two-tier API

Egress (`toJS`/`schemeToJs`/`exec`) always fully unwraps — outside the membrane only
plain JS exists; provenance stays in the trace. The API splits into two tiers:

- **SIMPLE tier** (`exec`): "run, get JS" — the default surface, plain-JS values only;
- **COMPLEX tier** (`execState`): "run, get reusable state" — raw boxed outputs,
  lexical scope, provenance metadata (session continuation, tooling, law tests).

Simple wraps complex (simple = complex + final unwrap), so there is exactly one exit
point to audit. The unwrap is a **strict door**: a raw, unboxed value reaching the
exit is refused, never silently passed through — an unrecognized value at the
boundary is a boxing bug upstream, and passing it along would hide it.

Rejected alternative: per-type exit shortcuts (e.g. boolean op-helpers returning raw
booleans while other types stay boxed). Two representations of "outside" force every
caller to branch on type, and provenance leaks inconsistently depending on which
shortcut fired.

## R2 — Container provenance: grouping fact + private structural facts

A container's own provenance is the collection-level **grouping fact** (the
minimal-cone design). Additionally, each container kind carries private
**structural facts**:

- arrays/vectors/lists: **length** — PROXIED through length-preserving ops (map/sort
  thread it unchanged), PROVENANCED in length-changing ops (filter mints it as a
  fresh derived fact);
- dicts: **keyset** (same scheme, independently adoptable).

This enables shortcut evaluation — `(< (length (sort …)) 5)` is decidable without
provenancing the sorted elements. The strategy is **naive but explicit**: structural
facts live in named fields, not emergent behavior, so the shortcut path is a later
optimization rather than a redesign.

Rejected alternative: deriving the container fact as the union of element provenance.
A length query then drags whole-collection lineage — O(n) unions for an O(1) fact —
and early decisions over aggregates become impossible without materializing the data.

## R3 — Recognition: `instanceof AValue` + sub-union stratification

The concrete value union stays (it is what type narrowing consumes); recognition is
`instanceof AValue` plus the few explicit non-AValue arms. One base-class check
cannot be forged by structural coincidence and cannot rot the way an enumerated
per-class list does.

Open design note: SchemeValue is too broad — the honest shape is lifecycle
**sub-unions** with their own admissibility (Keyword has positions
where it is and is not legal). EOF is no longer a member — it is a
reader-internal sentinel, same category as DatumReference. The remaining
sub-union lattice is a design problem to be solved as a whole; mechanically
tightening `isSchemeValue` call-site by call-site just moves the imprecision around.

## R4 — AHalfBaked: removed (VERDICT KILL)

There is no half-baked value primitive and no `{__halfBaked__}` marker shape.
Speculative half-evaluation as a _value_ had zero production reachability, and
container structural facts (R2) plus the execution-plan wireframe (R5) are the
principled form of the same idea: deciding `(if (>= (length (filter pred items)) 2) …)`
early belongs to structural-fact wires, not to a special carrier that every egress
path must know how to force.

## R5 — Cones: two queries, one execution-plan wireframe

Both provenance reads are required — "why is this an input" (minimal cone) and "what
changes if I adjust this output" (full/sealing cone) — as **two queries over one
representation**, not two stores. The representation is a **generalized execution
plan**: the AST statically evaluated into a base wireframe holding every
mux/bifurcation, with static wires COLLAPSED into procedural nodes
(`(+ (* x x) 5)` is ONE provenance edge, not four); runtime provenance wires into
that abstract flow.

Rejected alternative: per-op provenance accumulation. Its log grows with executed
operations, not with program shape — unbounded memory that no constrained runtime
(e.g. an edge worker) can hold, and both cone queries still have to reconstruct the
plan the wireframe stores directly.

## R6 — Curly-infix: dict literal wins the brace, infix is a banned door

`{:key value}` (dict literal) is the brace grammar. `{a * b}` infix is **explicitly
detected and BANNED** with an educational door pointing to the prefix form — never
silently misparsed as a dict. Neoteric/n-expressions live in the sugarcoat syntax
layer ONLY; the core reader has no curly-infix mode.

Rejected alternative: SRFI-105 curly-infix in the core reader. Braces then carry two
grammars at once, and an infix expression that happens to be dict-shaped (or vice
versa) misparses silently — the worst failure mode a reader can have. A ban door
keeps the error loud and teaches the correct form.

## R7 — letrec lowering: fix at root

letrec lowers to a shape where the binding is in scope for its own initializer (the
`s.letrec` combinator; function-declaration style carries the circularity). The
drops-only law holds absolutely: a lowering either produces the correct scope or is
rejected — no advisory-false-positive carve-out. A carve-out turns a scope bug into
an accepted lint, and every consumer downstream inherits the wrong binding silently.

## R8 — Boolean provenance: conditional mint

A verdict derived from lineage carries it: stamped operands mint a fresh ABool with
the union of their provenance. A verdict derived from constants does not:
provenance-free operands share a flyweight, so hot comparison paths stay
allocation-free.

Rejected alternatives, one per direction: always mint fresh — an allocation on every
comparison for provenance that is empty; never stamp — provenance conservation
breaks at every branch, because the branch verdict is exactly where lineage must
survive to explain a downstream value.

## R9 — Container toJS: deep unwrap via lazy ref-tracking proxies

Containers deep-unwrap everywhere — through **lazy-materializing recursive proxies**
with a ref-tracker, so multi-referenced values stay singletons. No full
materialization at egress; the proxy lenses in depth on demand. Deep field access
can preserve provenance reach-back (non-primitive reads re-enter the boxed world).
Cost: one proxy plus on-demand generation instead of a full copy.

Proxy identity is per PROJECTION, not one global slot:

- **bare** (serialization, `arrival/toJS()` — no `exit`) — keyed by (box), forever;
- **membrane** (`arrival/toJS(exit)` — rosetta/exec crossings — options honored at
  every depth, nested callables become host fns) — keyed by (box, mode, exporting
  RegionScope);
- **gated** (tier-state) — keyed by (gate, box).

Formerly two methods (a bare `toJS` and a sibling `arrival/toJSMembrane`); collapsed
into the one `arrival/toJS(exit?)` method, keyed on `exit` presence.

The singleton/aliasing law holds WITHIN a slot; cross-slot identity is incoherent by
construction once the projection depends on options and scope. Mechanism (the living
home — proxy keying, scope-bound caches, the four enforcement sites): membrane.md
§EGRESS.

Rejected alternative: eager full materialization at egress — pays the whole copy up
front, loses aliasing (two references to one list become two arrays), and forecloses
provenance reach-back on deep reads.

## R10 — World flip: a rosetta impl's return is JS-world, always

(2026-08-13, hermeticity audit B2b.) The scheme<>js membrane flips worlds exactly once
per direction. A rosetta impl returning an already-boxed `AValue` — bare or nested in the
plain arrays/objects `jsToScheme` recurses — is an ILLEGAL MOVE: it would ride the
owned-artifact pass-through and skip the membrane's mint/attest. The `assertNoWorldFlip`
door (`common/symbols/rosetta.ts`) crashes with `WorldFlipError`, BEFORE `z.encode` so
coded slots teach the same cure as `z.dynamic` escape slots. Direction asymmetry: a
`z.dynamic` INPUT still hands the impl the raw boxed SchemeValue; the OUTPUT face is
`unknown` (raw JS — the type system agrees via `DynamicHatch`). A verb that hands back
scheme values belongs on the contour (`symbol.native` + `z.schemeValue`).

Rejected alternative: keeping the v2 "impl boxes its own return via jsToScheme" contract —
it let JS-world code smuggle scheme values past provenance minting, and made the boxing
site (and its ctx) the impl author's problem instead of the membrane's.

## R11 — Contract seal: frozen at symbol instantiation

(2026-08-13, hermeticity audit B3.) A contract is the declaration of record; it freezes
the moment it gets inside the symbol instance (`ANativeProcedure`/`ARosettaProcedure`
ctors). The only post-factory declaration channels — `withContractFields`
(type/emit/narrows/refPolicy) and `withCallbackRoles` (role vocabulary) — RE-MINT a new
instance around the same impl with a new frozen contract, with runtime whitelists
(`ContractSealError`). The slot-kind walls also gained their runtime twin
(`assertSlotKinds`/`ContractSlotKindError` in every factory — audit B2a): rosetta refuses
`z.schemeValue`; native/sequence/define refuse `z.dynamic`/`z.instance`.

## R12 — Prelude persistence: invocation survives, reference does not

(2026-08-13, hermeticity audit B4.) A prelude `(define …)` PERSISTS into the main phase —
per-run, in the prelude-define frame between the user scope and the vocabulary chain —
while preludeOnly NAMES stay unresolvable (their seed frame is never in a main-phase
walk; closures reach them by lexical capture). Holds for bootstrap preludes AND mid-run
`(require/extension …)` packs — the require-extension surface. Full contract:
docs/environments.md §7a; laws: `env/__tests__/prelude-persistence.law.test.ts`.

## Key taxonomy — PRINCIPLES P7 corollary

Three key roles, one mechanism each:

- **algebra instruction keys** → strings (`arrival/...`) — every static interpreter
  consumes instruction names as data (P0's N-interpreter argument);
- **capability brands** → module-local symbols, never `Symbol.for` — a
  globally-reachable brand is forgeable, and forgeability is escape;
- **metadata slots** → `Symbol.for` — enumeration-invisible, and survives dual
  module instances.

Forgery-guard corollary: a borrowed object's own `arrival/*`-named data key is DATA,
never protocol. Protocol recognition must never key off a string a foreign object
can simply carry.
