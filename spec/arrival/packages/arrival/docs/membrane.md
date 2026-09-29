# The Scheme ↔ JS Membrane

> The mental model, stated once, ahead of the code. The membrane is the single seam
> where the second interpreter's world ends: **inside it every value is a boxed
> `AValue` both interpreters can execute; outside it only plain, observationally-JS
> values exist, and the provenance reading stays behind in the run's trace.** This
> document says what the crossing IS in each direction — how a host value boxes or
> borrows on the way in, how a boxed value projects on the way out, how a callable
> re-enters under region discipline, and where the crossing fails loudly. The laws the
> code enforces (a borrowed function voids, a store holds one world, a crossing adds
> its origin but never erases) _fall out of_ the crossing's shape rather than being
> bolted onto it.

Section anchors are CAPS so code comments can cite `docs/membrane.md §<ANCHOR>`. Each
section closes with its enforcement sites (files, no line numbers — those rot). Every
claim here is grounded in those files; when code and this document disagree, one is a
bug — decide which before writing a line.

Constitutional ground: `PRINCIPLES.md` §II — **P4** (one representation per side,
converted only at the membrane), **P5** (boundaries fail loudly at the crossing),
**P6** (effects are region-bound to their invocation), **P7** (the class is the
representation authority), **P9** (conversions are one-way unless a round-trip is
promised), **P11** (mint at the edge). This document is the _map of the machine that
implements those laws_; it links each and elaborates the mechanism, never restating
the law text. Also `RULINGS.md` **R1** (uniform plain-JS exit, two-tier API) and
**R9** (lazy egress proxies); `PROVENANCE.md` (the provenance-role vocabulary a
crossing stamps with); and `environments.md §MEMBRANE-SEAM`, whose pointer-level summary
of the bake-side seam this document is the destination for — the bake contract
(§CONTRACT) and the provenance/cache axes (§AXES) stay there; the membrane internals
they defer to (proxies, region discipline, egress projection) are here.

**The guest-language frame (why a membrane at all).** Arrival is a **guest language**;
JS is merely its _current host_ — the relationship is GraalVM polyglot, not
language-on-top-of-JS. Host and guest are peer worlds meeting only through this uniform
interop surface, the way a Truffle foreign value answers `InteropLibrary` messages
instead of exposing raw host mechanics (§HYGIENE, §MEMBER-READ). The operational
criterion is **portability**: arrival stays architecturally re-hostable onto Python,
Rust, or Go with no program breaking — re-hosting re-implements the host-side protocol
translations while the reader, the base stdlib, and every Scheme program move intact.
The membrane therefore _translates concepts_ (application, sequence, member-access,
absence), never hands off opaque pointers: `rosetta` is named for Apple's Rosetta —
binary translation, runs as-if-native — not the Stone.

---

## THE CALLABLE LENS — the reverse membrane completes the bifunctor

**A borrowed JS function crosses into Scheme as a genuine callable (V's ruling,
2026-07-24, verbatim): "host fn crosses into scheme as a callable; when scheme calls
it, args cross scheme→js, result crosses js→scheme. SAME logic for functions RETURNED
from symbol.rosetta impls."** This retired the void-and-warn tolerance the function
row carried through the 2026-07-23 binary-membrane restructure (§INBOUND) — that
ruling settled every OTHER shape but left the bare-function row a documented,
unresolved fork (lens-to-callable vs door); this is the fork resolved. A host function
reaching the generic membrane (`jsToScheme`, `boxing.ts`'s `fromJs`) mints
(or reuses, per-run) an `ARosettaProcedure` whose apply term IS the reverse membrane:
scheme args cross scheme→js (default-options `schemeToJs`), the host fn runs, and its
result — awaited first if it's a `Promise` — crosses js→scheme under the CALLING
invocation's run (`ACallable.ts`'s `hostFnToCallable`). This is the _inbound_ mirror of
`hostProjectionOf` (§REGION), which already gives the _outbound_ leg (a scheme callable
→ a host-callable wrapper) — the callable bifunctor is now complete in both
directions, not just one.

**Identity, run-scoped.** The SAME host fn crossing in twice within one run answers
the SAME callable (`eq?`) — a `(RunContext, fn)`-keyed mint-or-reuse cache, same
run-locality reasoning as `AOpaqueHandle.for`'s own cache (provenance is minted from
one run's own invocation numbering; a global cache would let a wrapper minted under
run A accumulate ids from run B that mean nothing under run A's numbering).
Provenance stamps ONLY the first mint: a procedure's identity is load-bearing (the
same reason `ALambda`/`ANativeProcedure`'s `withProvenance` is a no-op), so a later
crossing of the SAME fn with different provenance answers the cached value unchanged
rather than forking identity — unlike `AOpaqueHandle` (a DATA value, which remints and
merges on every crossing).

**Reverse-then-forward re-admits by identity.** A callable's own `hostProjectionOf`
wrapper crossing back IN does NOT mint a fresh `ARosettaProcedure` wrapping the
wrapper — it re-admits as the ORIGINAL callable (`eq?`), the function-shaped sibling
of R9's container re-admission (§INBOUND phase 1): `ACallable.ts` keeps a reverse
`WRAPPER_ORIGIN` map (wrapper → original callable), registered at mint time, read by
`originalCallableOf` as an OWNED_ARTIFACT_CLAIMS row checked before the generic
function lens. The OTHER direction is honestly asymmetric, not a gap: a bare host fn
crossing IN, then its minted callable crossing back OUT, does NOT return the identical
raw fn object — a genuine marshal wrapper must exist to cross args/result at call
time. `crossing.law.test.ts`'s "function (borrowed)" row states this precisely.

**`symbol.rosetta` returns land for free.** A rosetta verb whose OUTPUT slot is
`z.dynamic` (the declared no-transform escape hatch) skips `z.encode` entirely and
hands the impl's raw return straight to `jsToScheme` — so an impl returning a bare
function needed no new codec: it crosses through the SAME lens above, automatically.
A TYPED output slot (a real codec, not `z.dynamic`) has no function codec and stays
out of scope — a fn-returning verb declares `z.dynamic` output (or a future
`z.callback` codec, not yet built).

**`undefined` is a LENS, not a warn (V's ruling, 2026-07-23).** It has no faithful
Scheme representation any more than `null` does, but it IS a familiar host concept —
the other host bottom, alongside `null → nil` (§HYGIENE/§INBOUND never collapse the
two). It materializes to `#void` silently, same as any other declared crossing.

**A unique (non-registered) symbol has NO LENS — it doors.** It carries no portable
cross-realm key and no identity a Scheme program could reconstruct across a crossing,
so `jsToScheme` refuses it loudly (`NoLensError`) instead of degrading to
`#void`: register it (`Symbol.for(name)`) to cross as a `:keyword`, or pass a
string/keyword directly.

**A DECLARED `z.procedure` slot is a MORE SPECIFIC lens, not a separate rule.** When a
symbol's contract declares a slot `z.procedure`, that slot's codec supplies its own
faithful representation and per-argument marshaling discipline: a host function
crossing it `encode`s into an `ANativeProcedure` under that codec's own types, re-
entering under region discipline (§REGION) exactly like the generic lens above — the
two differ in how MUCH the marshal knows about each argument's shape (typed
per-parameter vs default-options), never in whether a function crosses at all.

**Enforcement sites:** `membrane/boxing.ts`, `membrane/rosetta.ts` (`INBOUND_CLAIMS`
function row), `membrane/membrane.ts`, `values/primitives/ACallable.ts`
(`hostFnToCallable`, `originalCallableOf`), `common/scheme-zod.ts` (`procedure`),
`common/symbols/rosetta.ts`.

---

## BIFUNCTOR — total conversion, round-trip on owned values

**`schemeToJs` and `jsToScheme` are the two total conversions of one bifunctor:
`schemeToJs ∘ jsToScheme = id` and `jsToScheme ∘ schemeToJs = id`, each on the values
its own side owns.** This is the mechanical form of P4's "one representation per side":
because the conversion is total and uniform in both directions for every type, a boxed
value inside and a plain value outside are the same datum read by the two interpreters,
never two representations competing.

Totality is carried at the type level, not just at runtime. `jsToScheme<T>` returns
`AWrap<T>` and `schemeToJs<T>` returns `AUnwrap<T>` (`values/types.ts`) — conditional
types that mirror the runtime routers arm-for-arm, so a new crossing arm that the type
forgets stops the type from telling the truth (P3), a compile-time debt not a silent
one. The two public wrappers each perform the _one_ sanctioned narrowing in the
package: the cast target is exactly the conditional the contract promises, never
`as any`.

The identity holds on **owned** values, and the qualifier is load-bearing. A native
container (`AVector`/`APair`/`ADict`) round-trips exactly. A **borrowed** carrier
(`AJSArray`/`AJSObject`) round-trips to its _source identity_ — it crosses back out as
the very JS object it wrapped, not a copy (§EGRESS, borrowed-carrier lane) — which is
the identity the bifunctor promises for a value the JS side already owned. Where P9
_refuses_ a round-trip (a dotted pair folds one-way into an array), the bifunctor does
not claim one; the studio's separate lens is where an exact round-trip is promised and
tested as a law.

**Enforcement sites:** `membrane/rosetta.ts`, `values/types.ts`.

---

## BOXING vs BORROWING — two inbound outcomes and a raw third lane

An inbound host value resolves to exactly one of three outcomes, decided by the
single `typeof`-tag switch in `boxing.ts` (the primitive boxer) and the ordered claim
registry in `rosetta.ts` (§INBOUND):

1. **BOXED** — a primitive constructs its owned `AValue` subtype: `string → AString`,
   a safe-integer `number → AExact` (else `AInexact`), `boolean →` the shared `#t`/`#f`
   flyweight (or a fresh `ABool` when stamped). The sandbox holds boxed values only;
   nothing raw survives inbound past this switch.
2. **BORROWED** — a container is re-presented, not copied: an array becomes an
   `AJSArray` (a JS array **is** an R7RS vector — the faithful Rosetta mapping), a
   plain object becomes an `AJSObject`. Both are thin, read-only views that keep the
   `source` by reference and box elements lazily on access (§HYGIENE, §MEMBER-READ).
3. **RAW (the third lane)** — two carriers cross by identity, unboxed, because they
   are not value-intent and have no faithful Scheme form: binary FFI
   (`Uint8Array`/`ArrayBuffer`/`DataView`/`Buffer`, identity-preserving for the
   polymorphic bytevector ops). A bare `Promise` into `jsToScheme` doors (the
   evaluator trampoline awaits before any inbound crossing). Host
   `bigint` is **not** raw — it DOORS (`NoLensError` kind `"bigint"`, same spirit as
   unique-symbol): exact numbers are safe-integer ratios; convert with
   `Number`/`bigintToNumber` in the safe range (or pass an inexact/string) before
   re-crossing. Codecs that speak `bigint` on the host face (`z.bigint`) encode to
   `AExact` BEFORE the membrane.

**Two host bottoms map to two Scheme absences, never collapsing to one:** JS `null` →
`nil` (the empty list — the list-end bottom), JS `undefined` → `#void` (the
no-value bottom, silently — a lens, not a warn; see §CALLABLE-LENS above). A membrane
that folded them together would make `(null? x)` and a void check indistinguishable
at the boundary.

`undefined` takes the plain `#void` lens; a bare function takes the CALLABLE lens
(§CALLABLE-LENS, mints/reuses an `ARosettaProcedure`); a registered symbol
(`Symbol.for("x")`) has a portable key and boxes to the keyword `:x`; a UNIQUE
symbol and a host `bigint` have no lens at all and door (§INBOUND).

**The freeze contract, stated once.** A borrowed source is frozen
(`Object.freeze`) on the _first Scheme read_ of its wrapper, so a `pure` rosetta — one
that declares it only transforms its inputs and forwards their provenance — _physically
cannot_ mutate what it borrowed: prevention by construction. The freeze is idempotent
and lazy (a borrowed array's whole contract is that `.length` and `schemeToJs` never
touch elements, so an eager scan would pay the cost the class exists to avoid), and
unconditional — there is no per-run opt-out. The contract has one home here; its code
sites are pointers: `AJSArray.freezeSource`, `AJSObject.freezeSource`, and
the baked `symbol.rosetta` provenance-role gate (`provenance === "pipe"`).

**Enforcement sites:** `membrane/boxing.ts`, `membrane/rosetta.ts`,
`membrane/AJSArray.ts`, `membrane/AJSObject.ts`.

---

## HYGIENE — one store, one world, every penetration tracked

This is the most-restated invariant in the package; this section is its single home.

**THE HYGIENE LAW.** A borrowed store (`AJSArray.source`, `AJSObject.source`) holds
**JS-world values only** — primitives, plain objects/arrays, and reverse-membraned
egress proxies — never a boxed `AValue`. Every flip between a Scheme entity and a
native JS entity is TRACKED and EXPLICIT: no site accepts both a monadic `AValue` and a
primitive JS value for the same slot. This is the only way to keep hygiene when the
host is simultaneously the interpreter's _runner_ and a Graal-style _parallel world_ —
the JS side is not below the Scheme side, it is a peer world reached only across a
tracked seam.

Why it corrupts if violated, concretely: `jsToScheme` deep-re-stamps an `AValue` with
the provenance it is handed (§INBOUND). So a Scheme value buried in a JS store does not
merely sit there — the next time the container crosses one of its elements, that
element's own lineage is silently overwritten with the container's. An unobserved flip
that CORRUPTS, not merely one that is untidy.

The law is enforced on **two** faces so no violator escapes:

- **At the type level** — `AJSArray.source` is typed `JSWorldArray<S>` and the object
  sibling the same way. A caller that statically holds Scheme values (`SchemeValue[]`,
  `AValue[]`) collapses to `never` and _fails to compile_; a bare `unknown[]` still
  passes, because `unknown` genuinely might be a JS value — nothing better is knowable
  there. A type catches every violator at once, in `tsc`, including the ones no test
  covers. The breakage IS the audit.
- **At the penetration point** — `AJSArray.boxElement` (the single `invariant`
  guarding the crossing) throws if a raw slot ever holds an `AValue`. The check lives
  _at the crossing_, O(1), not in the constructor: an O(n) constructor scan would pay
  the cost the lazy borrow exists to avoid, and the crossing is the exact moment the
  flip happens.

**`AJSArray.elementAt` / `boxElement` is THE declared penetration** for a borrowed
array's elements — the one place an element crosses into the Scheme world, owned by the
class that owns the store (P7). The spine chart `AJSArrayList` (§MEMBER-READ) calls
_this_ rather than owning a second boxing policy: one store, one crossing. A view
carrying its own boxing is exactly how an earlier cut came to project over an _owned_
`AVector` (whose elements are already boxed) and silently re-stamp every one — caught
only by the term-carrier law.

**Adoption is not a crossing** (see §NOT-A-CROSSING): projecting a borrowed array onto
its list spine (`adoptSpine`) is an in-plane representation choice, `AValue` in and
`AValue` out — it must never be routed through `z.decode`, the plane crossing.

**Enforcement sites:** `values/types.ts` (`JSWorldValue`/`JSWorldArray`),
`membrane/AJSArray.ts`, `membrane/AJSObject.ts`, `membrane/adopt-spine.ts`.

---

## INBOUND — the ordered claim registry and the additive law

**`jsToScheme` totalizes the JS→Scheme crossing through `INBOUND_CLAIMS`: one DECLARED,
ORDERED table of `(shape-predicate, boxer)` claims, folded first-claiming-row-wins.**
The order is semantic law, not import accident, and a registry law test pins it. Where
outbound dispatch lands on _our_ classes (the term lives on the receiver, P7), inbound
dispatch faces JS shapes with no receiver yet — so each claim pairs a predicate with a
constructor, and the router is the fold.

**THE BINARY MEMBRANE (V's ruling, 2026-07-23, verbatim): "the js > scheme membrane is
pretty simple — it's always either having the proper lens or not, all the concepts are
either familiar or explicitly incompatible."** `INBOUND_CLAIMS` is the concatenation of
three phases — `OWNED_ARTIFACT_CLAIMS` then `FOREIGN_LENS_CLAIMS` then
`INCOMPATIBILITY_DOOR_CLAIMS` — and the phase boundary is itself semantic (phase 1 runs
to completion before phase 2, phase 2 before phase 3's catch-all doors):

1. **PHASE 1 — owned-artifact recognition.** A thing already MARKED as ours: an
   already-`AValue` (passes by identity on the same/empty-provenance fast path, else
   re-stamps through ITS OWN protocol — deep on spine carriers via
   `arrival/withProvenanceDeep`, shallow elsewhere); a re-admitted R9 egress proxy
   (re-dispatches with the ORIGINAL box, not a fresh borrow — checked before phase 2's
   array row, since a proxy over a vector is `Array.isArray`-true); a re-admitted
   REVERSE-MEMBRANE WRAPPER — the function-shaped sibling of the R9 row, checked
   before phase 2's function row since a wrapper is `typeof === "function"`-true —
   re-dispatches to the ORIGINAL callable it projects (`ACallable.ts`'s
   `originalCallableOf`, §CALLABLE-LENS); a reader-internal EOF token (identity —
   not a SchemeValue; `eof-object` is an IO door); a non-`AValue` scheme orphan
   (`R7RSError`, by identity); a branded `@arrival.private` host
   instance (mints/reuses a run-scoped `AOpaqueHandle`, the whiteroom opaque-crossing
   contract). Those owned non-AValue rows MUST precede the branded-instance row:
   `isMarkedInteropPrivate` reads the same `INTEROP_BOUNDARY` stamp they carry
   for the read-policy walk _on their own class_, so checking brand-first would
   mis-mint them as a handle. An ancestor-only stamp is not this row — it is the
   phase-2 inherited-boundary borrow.
2. **PHASE 2 — the foreign lens table.** Every remaining row is a declared LENS, keyed
   by a distinct `typeof` tag: `null → nil`; `undefined → #void` (a lens now, no warn —
   the other host bottom, never collapsed with `null`); the array/plain-object
   containment ladder (one row, Array.isArray checked first — not two order-dependent
   siblings); a host `Error` (borrowed `AJSObject`, `stack` hidden by the interop
   policy — its own declared lens, not a Date/Map-style exotic); a class whose
   _ancestor_ (not its own class) carries an explicit `INTEROP_BOUNDARY` stamp
   (borrowed `AJSObject` — the stamp is a read-policy stop, not `@arrival.private`;
   own-class stamp stays phase 1's opaque handle); scalars to the
   `boxing.ts` boxer table (`bigint` deliberately excluded — it is phase 3's door,
   not a silent AExact mint); a REGISTERED symbol to the keyword `:x`; the DECLARED
   raw-identity lane (binary FFI); and — the row the 2026-07-23 ruling left open,
   RESOLVED 2026-07-24 (§CALLABLE-LENS) — a bare host function mints/reuses a genuine
   scheme-callable `ARosettaProcedure` (the reverse-membrane lens), completing the
   callable bifunctor `hostProjectionOf` already gave the other direction.
3. **PHASE 3 — the incompatibility door.** Reached only when phases 1-2 both miss.
   Every remaining shape is EXPLICITLY INCOMPATIBLE, never a silent degrade: a bare
   `Promise` doors (settle first; a Promise INSIDE a structure never reaches here —
   the holding container settles it lazily on entry read); a UNIQUE (unregistered)
   symbol doors (no portable cross-realm key); a host `bigint` doors (exact numbers
   are safe-integer ratios — convert with `Number`/`bigintToNumber` in range, or
   pass inexact/string; codecs encode to `AExact` before the membrane); an
   unbranded/exotic object (`Date`, `Map`, `Set`, `RegExp`, a plain class instance,
   …) doors, naming its two cures (brand the class `@arrival.private`, or hand plain
   data instead) — the flip from the old warn-and-borrow tolerance tier, which this
   ruling retires.

The fold is total by construction; a miss is a programmer error (`invariant`, not a
silent leak). A `seen: WeakSet` shortcut is router infrastructure, not a claim: a
**JS-side cycle** (or shared substructure re-met during a deep re-stamp) returns as-is,
because the caller's outer wrapper already carries the stamp — terminating the
recursion at the cycle instead of spinning an infinite spine.

**THE ADDITIVE LAW.** When a crossing re-stamps an already-provenanced value, it
_merges_ — ADD its origin, NEVER ERASE the value's. A rosetta promises HOLISTIC
causation (input-as-a-whole causes output-as-a-whole, because a JS impl is opaque and
we cannot prove it did not mix its inputs): that is an EDGE we are entitled to add, not
a licence to overwrite what the value already knew about itself.

Overwriting fails silently and structurally. A value's origin set must stay a SUPERSET
of its true dependency set — the exact precondition `uneval`'s Galois slicing rests on
(`origin ⊇ dependencies`). Replace instead of union and the slice omits the form that
produced the dropped id, so the re-run cannot reproduce the value. Over-approximation
is safe (a bigger sound slice still derives); under-approximation is fatal. Union makes
`origin ⊇ dependencies` hold by construction, and even covers a source handing back an
already-provenanced value — both the "explicitly chosen by the source" edge and the
value's own history are real. This is the **deep-restamp**: `arrival/withProvenanceDeep`
walks the whole spine + leaves in one pass, so downstream extractors (`car`, `cdr`,
`dict-ref`, `@`) see element-level lineage carrying the crossing's origin id without a
per-builtin re-stamp.

**Enforcement sites:** `membrane/rosetta.ts` (`INBOUND_CLAIMS`, `jsToScheme`),
`membrane/boxing.ts`, `values/primitives/AValue.ts` (`withProvenanceDeep`),
`provenance/uneval.ts` (the Galois-slice soundness the additive law protects).

---

## EGRESS — projection on the way out

Egress is where the box layer hands off to the trace (P4): the value-side conversion is
a total, honest projection with no residue of the world it left, and the provenance
reading STAYS in the run's trace. Two named projection _modes_ exist, and a container
never eagerly copies (R9):

- **BARE** — serialization (`arrival/toJS`, no options): a nested callable stringifies
  (that IS the serialization contract). Identity = **(box)**, forever — one
  module-level `WeakMap`.
- **MEM (membrane)** — the crossing (`arrival/toJS(exit)`, every rosetta/`exec`
  exit): options honored at every depth, nested callables become host functions.
  Identity = **(box, mode, exporting-SCOPE)** — the cache lives on the exporting
  `RegionScope` (§REGION).

A third, **GATED** mode (identity **(gate, box)**) serves payload-tier state; its gate
is snapshot-scoped, so its proxies are too. Gated is bare-mode by design (payload
serialization wants print strings) and is never combined with a membrane exit today.

**THE PROJECTION-KEYED IDENTITY LAW.** A single container box has _different_
observable projections under bare vs membrane vs gated egress, so proxy identity is
**per projection, not one global slot**. The singleton/aliasing guarantee (two
references to one list stay one array) holds WITHIN a slot; cross-slot identity is
incoherent by construction once the projection depends on options and scope. The
_types_ declaring this law live in `values/types.ts` (`EgressMode`, `WrapperKey`,
`MembraneExit`); the law is _keyed and enforced_ across four sites, named once here so
no reader hunts them:

- `membrane/region-scope.ts` **owns** the two scope-bound caches
  (`RegionScope.egressProxies` for container proxies, `RegionScope.cache` for callable
  wrappers);
- `membrane/egress-proxy.ts` **keys the container proxy** by `(box, mode)` inside the
  scope's cache (`membraneSlot`);
- `membrane/rosetta.ts` **hands the pinned scope's cache in** (`egressAValue`) and keys
  the callable wrapper (`callableToHostFn`, by `EgressMode`);
- `common/scheme-zod.ts` keys the _typed_ callable wrapper (`z.procedure`, by
  `"typed"`) into the same scope cache.

Why scope-bound and not (box, mode)-forever: a forever cache would resurrect a proxy
pinned to a CLOSED (or DETACHED) scope for a _later_ invocation — a spurious escape door
— or serve a DETACHED-pinned proxy into a live crossing's slots — discipline bypass by
cache pollution.

**BORROWED carriers egress source identity — the fourth egress class.** An
`AJSArray`/`AJSObject` never routes through the proxy machinery: it egresses
`return this.source` — the very JS object it borrowed. That IS its membrane contract
(the bifunctor's owned-value round-trip), and adding a proxy or a membrane walk would
break it.

**The projection is one-way and read-only.** An egressed container is a projection of
an immutable Scheme value, not a mailbox back into it — the write family
(`set`/`delete`/`defineProperty`/`setPrototypeOf`) throws a teaching door whose fix is
literally _"build the changed value on the Scheme side and egress that."_

**Two mechanics keep the lazy proxy observationally plain:**

- **register-before-materialize** — the proxy is placed in its cache slot _before_ any
  trap can run (built, set, returned; traps fire only on reads after return), so a
  cyclic reach-back resolves to the already-registered slot structurally, with no
  recursion. `JSON.stringify` on such a value then throws the same `TypeError` a
  genuinely cyclic plain object does — plain JS, exactly.
- **pending cells never leak raw Promises** — a Promise-valued element/entry surfaces
  as a lazy pending cell (`pending-entry.ts`): the first read mints one settle chain
  (cached, so concurrent readers share it), settlement replaces the slot with the
  settled box, later reads are synchronous. A raw `Promise` never enters Scheme space
  through a container read; only a _bare_ Promise crossing `jsToScheme` directly doors
  (§DOORS).

**Register-before-materialize before the crossing runs:** every rosetta encode
registers the value's provenance before `jsToScheme` materializes it, so the trace
records what crossed even as the value projects lazily.

**Enforcement sites:** `values/types.ts`, `membrane/egress-proxy.ts`,
`membrane/region-scope.ts`, `membrane/rosetta.ts`, `common/scheme-zod.ts`,
`values/primitives/pending-entry.ts`.

---

## MEMBER-READ — reads live on the values, the membrane has no member face

**Polyglot member access (`@` / `@?` / `@keys`, the `:key` accessor) is a term ON the
value, never a face on the membrane.** Each value implements
`arrival/tagless-final/get|has|keys` (an `ADict` structurally; `AJSObject`/`AJSArray`
through the interop read policy over their borrowed `source`), and
`env/polyglot/polyglot.ts`'s verbs — the only production consumer — normalize the key
and invoke those terms directly. There is no `membrane.readMember`, no dotted-path
side-door. This mirrors GraalVM Truffle's `InteropLibrary.readMember`: a foreign object
exposes its members, not its language's internals.

**The boundary is where the prototype walk STOPS.** "Boundary" here is the membrane
sense, not a sandbox fence: a member read exposes OWN data members only and walks the
prototype chain until it hits a boundary, at which point access throws (or collapses to
`nil`/`not-has` for the borrowed-wrapper terms). Built-in prototypes are boundaries; so
is any global constructor's prototype (identity-checked, so a spoofed
`constructor.name` still fails); so is any arrival value class — the family rule keys
off the own `[CLASS]` brand, so no primitive carries a per-class boundary stamp.

**The capability brand is module-local, never `Symbol.for` (P7 key taxonomy).**
`INTEROP_BOUNDARY` and the `NOT_FOUND` sentinel are `Symbol(...)`, unreachable from
outside the module's closure. A registry-global symbol (`Symbol.for(...)`) is forgeable
from sandbox code, which could stamp its own boundary markers, strip ours, or spoof the
not-found signal — forgeability is escape. `@arrival.private` seals a host class
through this same module-private symbol; branding with the registry symbol silently
seals nothing.

**Enforcement sites:** `membrane/interop-access.ts`, `membrane/AJSObject.ts`,
`membrane/AJSArray.ts`, `values/primitives/ADict.ts`, `env/polyglot/polyglot.ts`.

---

## REGION — reverse-crossed callables are bound to their exporting invocation

A reverse lambda — a Scheme callable handed to host JS via `schemeToJs`'s `ACallable`
branch or `z.procedure`'s typed decode — carries the ability to _re-enter_ the two-layer
execution. P6 requires it to re-enter inside a real frame; the mechanism is the
`RegionScope` token.

**The token, and its four operations.** A `RegionScope` is minted for ONE symbol
invocation and every reverse wrapper closes over it (never re-reading the ambient
holder, so a call arriving after the invocation returned still sees the by-then-closed
scope it was minted against). Four functions operate it:

- `openRegionScope` — mint a fresh, open scope for one invocation;
- `withRegionCall` — run one reverse-lambda call under the scope's discipline
  (rules 1/3/4);
- `withRegionScope` — install the scope as ambient for the synchronous window in which
  wrappers are minted;
- `closeRegionScope` — called when the exporting invocation settles (rule 2).

They enforce **two teaching doors** and two non-door rules: `RegionEscapeError` (rule 1
— a call _after_ the exporting invocation returned; the wrapper closed over a scope now
flagged `open: false`), `RegionIncompleteError` (rule 2 — the invocation returns with
reverse calls still in flight), plus in-flight `pending` tracking (rule 3) and an
abort-signal race derived from the run (rule 4). `reconstructRegionScope` is the
recovery twin: on a DO wake it re-derives `pending` and the next track ordinal by
folding the durable stream, so a crash that left a track open honestly throws the
incomplete door rather than reporting a clean close.

**Args mint under the enclosing runCtx, never `CONSTANT_CTX`.** A reverse call's
arguments box under `scope.runCtx` — the invocation's LIVE context, the same handle
carrying the run's cache/effects/reads. A lambda calling a sink verb therefore hits the
effect-burst arm (`this.runCtx.effects`) instead of firing inline. `CONSTANT_CTX` as
the answer to "whose invocation is this?" is the provenance interpreter executing
against a fake frame — the `DETACHED_SCOPE` degradation exists precisely for the
_absence_ of a real scope (a trace/display projection, or a unit test calling
`.parse()` directly), never as a target.

**Why an ambient holder.** `z.procedure`'s decode is a plain zod-codec transform with
no side channel for "which invocation is this a reverse crossing of." Rather than invent
two plumbing conventions, both the codec path and `schemeToJs` read the SAME
module-local "current region scope" — the module-holder idiom `dynamic-call-site.ts`
already uses, safe under single-threaded JS with save/restore around the owning call. A
second evaluation of `membrane/region-scope.ts` in the same isolate throws
`DuplicateModuleLoadError` rather than silently degrading discipline to `DETACHED_SCOPE`.

**Wrapper identity = (callable, scope, FAMILY).** The same callable exported twice
through the same scope under the same family gets back the same host function
(`eq?`-stability); a fresh scope starts with a fresh cache, so two invocations of one
symbol never share a wrapper. The cache is two-level (`WrapperKey`): two independent
factories build over it — `callableToHostFn` (the untyped passthrough, keyed by
`EgressMode` since its projection varies with `RosettaOptions`) and `z.procedure`'s
typed decode (keyed `"typed"`). The pre-split single key let whichever family crossed a
callable _first_ serve its wrapper to the other — the same defect class the
(box, mode, scope) container law fixes, one level down.

**The `z.dynamic`-after-await burst-bypass hazard, and the bake-side gate.** A callable
arriving through a `z.dynamic` slot is _undeclared_: `z.dynamic` performs no transform, so
the raw callable is marshaled by the impl itself — possibly _after_ the impl's first
`await`, by which point `withRegionScope`'s synchronous save/restore has already
reverted the ambient scope. A reverse call minted from that stale marshal binds
`DETACHED_SCOPE`/`CONSTANT_CTX`, reopening exactly the burst-bypass hole region
discipline exists to close. The fix is not to marshal a `z.dynamic` callable safely — it
is to never let one land there: a bake-time door
(`assertNotBareCallableInDynamicSlot`) makes the unsafe shape UNAUTHORED, steering the
author to declare `z.procedure` (whose decode marshals synchronously, at decode time,
under the live scope). The gate is computed once at bake off the same normalized input
vector every other bake gate reads; a lambda-free verb — the overwhelming majority —
mints no scope, touches no wrapper cache, pays zero cost. (`environments.md §MEMBRANE-SEAM`
carries the bake-side framing; the runtime discipline is here.)

**The shallow-container gap.** `assertNotBareCallableInDynamicSlot`'s slot scan
(`common/symbols/rosetta.ts`'s `dynamicSlotPositions`) is SHALLOW ONLY: a bare `z.dynamic`
nested inside a container schema (`z.list(z.dynamic)`) is not slot-checked, because a
container carrying a REAL element codec unwraps at its OWN decode and a bare
`z.dynamic`-of-container never reaches this scan at all. This is a known gap, not a silent
one — the scan's own comment names it — pending recursion into `dynamicSlotPositions` to
walk container element schemas; until then, a `z.dynamic` callable arriving inside a
container is undetected by this door (audit D2).

**Enforcement sites:** `membrane/region-scope.ts`, `membrane/rosetta.ts`,
`common/scheme-zod.ts`, `common/symbols/rosetta.ts`.

---

## DOORS — where the crossing fails loudly

Every membrane door refuses a violation at the moment of crossing (P5), with a message
that teaches — never tolerated inward to fail three calls later as a weird problem. The
doors, by crossing:

| Door                                            | Fires when                                                                                                                                                                                         | Class                                         |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Redundant crossing (strict one-way)             | a raw JS value reaches `toJS` — the caller is confused about which side it stands on                                                                                                               | `RedundantCrossingError`                      |
| Unrecognized (P5 terminal)                      | `schemeToJs` reaches a boxed shape with no `arrival/toJS` branch — a silent return would leak internal representation                                                                              | `UnrecognizedCrossingError`                   |
| Async                                           | a _bare_ `Promise` reaches `jsToScheme` directly (every sanctioned path settles first; a Promise inside a structure settles lazily)                                                                | `AsyncCrossingError`                          |
| No lens (the binary membrane, §INBOUND phase 3) | a unique JS symbol, or an unbranded/exotic class instance, has no defined crossing into the algebra — names its cure (register the symbol; brand the class `@arrival.private`, or hand plain data) | `NoLensError`                                 |
| Region escape / incomplete                      | a reverse lambda outlives its invocation, or an invocation returns with calls in flight (§REGION)                                                                                                  | `RegionEscapeError` / `RegionIncompleteError` |
| Raw crossing                                    | a raw JS scalar surfaces on an env read — a writer bypassed the storage membrane (`environments.md §HERMETIC`)                                                                                     | `RawCrossingError`                            |
| `z.dynamic` callable                            | a callable crosses a `z.dynamic` slot (§REGION)                                                                                                                                                    | teaching throw                                |

**Error-to-host is a crossing, not a door.** An `R7RSError` produced _as a value_
(a guard's `else` returning it, `raise-continuable` resuming with it) exits as a
same-class host `Error`: message preserved, original stack carried over, **irritants
crossed elementwise** through the caller's own exit fn. `R7RSError` is deliberately a
host `Error` subclass, NOT an `AValue` box, so the strict-exit gate cannot carry it —
this arm is its crossing, shared by `schemeToJsImpl` and `membrane.toJS` so the two
exits cannot drift. A _raised_ error never reaches this arm; it takes the throw path.

**Membrane-warn is bounded, per-crossing not per-value.** A non-portable host value
materializing to `#void` emits a teaching warning — but only the first few times per
_distinct shape_, then one suppression line, then silence. The fact belongs to the
RUN, not to each value that crosses: a large payload whose values all trip the same
warning would otherwise emit hundreds of thousands of identical lines and OOM the
process, turning an O(1) diagnostic into an O(n) one on the hot path. Bounded by the
handful of distinct warning shapes, never by the size of the data crossing — the
same reasoning the note-sink exists for. The 2026-07-23/24 rulings retired every LIVE
producer on the `jsToScheme` inbound path itself (`undefined` is a plain
lens, a unique symbol doors, a bare function is now §CALLABLE-LENS's callable — none
warn); the mechanism survives for ONE remaining caller, unrelated to a fresh inbound
crossing: `values/primitives/deep-restamp.ts`'s re-stamp of a bare host-fn
`AProcedure` already living in a scheme spine (`SchemeValue`'s pre-`ACallable`
survivor arm) — a shape this document's §CALLABLE-LENS does not cover, since it is
never a JS→scheme crossing, only a re-stamp of something already inside the algebra.

**Enforcement sites:** `errors.ts`, `membrane/membrane.ts`, `membrane/rosetta.ts`,
`membrane/membrane-warn.ts`.

---

## SPINES — two families, one crossing skeleton

**There are two rosetta spines and one crossing skeleton
(`schemeToJs → fn → jsToScheme`).** The inbound host-fn lens (`hostFnToCallable`
in `ACallable.ts`) uses the generic conversions directly; the codec-driven baked
`run` (`common/symbols/rosetta.ts`) substitutes the contract's per-argument codecs for
those generic conversions and lets zod do the gated validation. Both collect input
provenance before the crossing strips `AValue` identity, both mint-or-forward the same
way at the end, both open the region scope only when the contract can hand the impl a
live callable. Replay playback (`provenance/replay.ts`) mints an `ARosettaProcedure`
at the bind site with the same `jsToScheme` restamp.

The two families share **one** wrapper cache (§REGION) and **one** boxing idiom. The
single-boxing-idiom law: the baked `run` re-stamps its encoded output with
`jsToScheme(ctx, encoded, {}, resultProvenance)` — the canonical deep re-stamp — rather
than growing a second boxing path; and replay's `boxPayload` (`provenance/replay.ts`)
boxes a frozen payload with the SAME `jsToScheme`, so a value materialized at replay is
built by the identical membrane, not a divergent one. One idiom, not a second.

**Source mints, pipe forwards — at the crossing** (P11, elaborated in
`environments.md §MEMBRANE-SEAM` for the bake side): a `source`-role rosetta mints a fresh
provenance point off the invocation; a `pipe`-role rosetta forwards the input-provenance
union and mints nothing. With no invocation in ctx (a direct-JS call, no evaluator
frame) a source falls back to the input union. The forward-vs-mint choice is the
load-bearing one — a `pipe` that minted would fabricate an origin (the seal-laundering
class of bug).

**Enforcement sites:** `membrane/rosetta.ts`, `common/symbols/rosetta.ts`,
`provenance/replay.ts`.

---

## NOT-A-CROSSING — three things that look like the membrane but are not

Three mechanisms sit near the membrane and must be kept off it:

1. **Spine adoption is an in-plane representation choice.** Projecting a borrowed
   `AJSArray` onto its list spine (`AJSArrayList` via `adoptSpine`) is `AValue` in,
   `AValue` out — the SAME backing store, the SAME provenance, O(1). It honors a
   `z.listAlike` contract slot by handing the impl a real `APair` subclass _before_ the
   impl runs (several native impls field-read `.car`/`.cdr` directly). It must never be
   routed through `z.decode`, the _plane_ crossing (scheme → JS): three earlier attempts
   died on exactly that confusion — a `z.codec` on the list schema computed an eager
   `APair` copy on every call and discarded it while the raw array sailed through and
   hung the body. Adoption is a chart choice on the Scheme plane, not a crossing.

2. **`transparent` is a provenance-transparent role, not a stamped crossing.** In the
   provenance-role vocabulary (`PROVENANCE.md §2`), `transparent` names a membrane
   crossing that neither MINTS nor STAMPS — cone-identical to `pipe`, "dedented" so the
   box layer treats it as pass-through. No declaration marks it today (a graph-layer
   target, unreachable in the live classifier); it is listed here so a reader does not
   mistake the _word_ "crossing" in its definition for a provenance-bearing event.

3. **The terminology fence: "egress" means two unrelated things.** In _this_ document
   "egress" is the membrane's Scheme → JS exit. In `provenance/*` "egress" is the
   provenance-GRAPH concept — a region/track/wire's _output port_ (`egress(Tᵢ)`,
   `graph.egress`, "a sink is a port with no egress wire", `cone(egress)`). They are
   unrelated: one is a value leaving the interpreter's world, the other is a node in the
   lineage plane. Named explicitly so a reader or a search tool never conflates the
   membrane exit with a region port.

**Enforcement sites:** `membrane/adopt-spine.ts`, `values/primitives/APair.ts`
(`AJSArrayList`), `provenance/lineage.ts` / `provenance/prelude.ts` (the `transparent`
role), `provenance/gamma.ts` / `provenance/replay.ts` (the graph-`egress` concept).
