# Writing capabilities

An `EnvCapability` is the one shape every arrival environment is built from: a named,
composable contribution of **symbols** (verbs), **configuration** (per-env, validated),
**resources** (external ports), **prelude** (scheme bootstrap), and **deps** (grants). The
R7RS base, every SRFI, every dialect pack, and your domain tools are all this same shape;
`buildVocabulary` C3-linearizes the dependency DAG and applies each capability once. What the
machine _is_ — the C3 assembly, the seam a baked verb crosses — is the
ontology in `environments.md`. **This file is the author's how-to: the recipe you follow,
with each law it rests on cited to its home in `environments.md`.**

The per-API mechanics (the `symbol.*` factory roster, tagged-template syntax, exact bake-gate
error texts) live in the JSDoc of the entry points: `common/symbol.ts`, `common/capability.ts`,
`rosetta.ts`, `common/scheme-zod.ts`, and `@inhuman.tools/arrival-mcp`'s `McpEnvCapability` /
`tool`.

The one law under everything below: **dependencies point down, only down** — a capability
declares a `deps` edge and uses the granted names, never reaching sideways into another
capability's internals (`environments.md` §CAPABILITY). A capability is a **module singleton**
(one `EnvCapability.define(name, spec)`, exported as a value): the five spec keys are a closed
taxonomy, configured by composition, never subclassed. The raw `new EnvCapability(name, spec)`
constructor survives only as `.define`'s own internal call — every real pack authors through
`.define`.

## Declare the honest codec

A rosetta contract's schemas are the membrane **crossing**, not documentation. `z.list(z.number)`
_is_ the transform: the scheme proper-list decodes to a real JS `number[]` before the impl runs,
and the return encodes back through the output codec. The impl reads and returns plain JS; nothing
scheme-shaped leaks in. One contract has four readers that must agree — the four-reader law is
`environments.md` §CONTRACT; the authoring rule is: **declare the codec that matches what the impl
reads and returns.** "Take the raw value and sort it out inside" is a debt, not a shortcut.

`z.dynamic` is a special kind, never a default fallback: it is legal only for a **rosetta**
(crossing) slot that is **fully generic** — ∀-quantified, the verb polymorphic in that slot,
passing the value through whole without reading its shape — where the impl does its own
`schemeToJs`/`jsToScheme` (`env/overridable/overridable.ts`'s `overridable/resolve` is the one
production case). A shape that is merely awkward or open-ended is NOT generic — it has an honest
codec (`z.union`, `z.dict`, `z.box`, `z.instance`); reaching for `z.dynamic` because the codec is
tedious desyncs the four readers the same way an undeclared codec does. A **contour** slot
(native/define/sequence/tagless) reaches instead for `z.schemeValue`, the honest top type for "any
boxed scheme value" — the two are compile-time banned from each other's slot kind. Either way the
slot is invisible to the type lens, unvalidated at the boundary, and barred from
`cacheClass: "view"` (a raw crossing doesn't serialize — the bake gate refuses it). Declare the
codec whenever one exists; `grep schemeToJsUntyped` is the audit list of every place the untyped
crossing was reached for.

## Parametric ops are tagless by construction

A zod schema is a **value**, not a type-level function — a contracted symbol
(`symbol.native`/`symbol.rosetta`) can only express a concrete, monomorphic `in → out`. A
genuinely parametric op (`car`: `Pair<A,B> → A`, `map<A,B>`) cannot declare an honest
contract, so it belongs on the **tagless** path (`symbol.tagless`/`symbol.taglessGuard`),
where dispatch goes to the operand's own term method and the contract slot is empty by law
(`environments.md` §SYMBOL-KINDS). One home per symbol: term-algebra/parametric → tagless;
authored monomorphic host fn → a contracted symbol. Reaching for `z.dynamic` to fake a
parametric contract is the tell that you wanted tagless.

## Two axes: a provenance role, optionally a cache class

Every symbol carries a **provenance role** (where results come from) and, optionally, a **cache
class** (a serialization/replay axis). They are orthogonal, and the same word `pure` names a value
on _each_ — the standing migrator trap. The axis definitions and the `pure`-naming hazard are
`environments.md` §AXES; what you declare:

- **provenance role** — `"source"` mints a fresh origin (external data), `"pipe"` forwards its
  inputs' lineage (a pure transform mints nothing), `"sink"` has no egress (an effect). Load-bearing,
  not documentation: a `"pipe"` that minted would fabricate origins — the seal-laundering bug class.
- **cache class** — `"view"` (persisted boundary snapshot, demands a serializable contract),
  `"pure"` (deterministic-from-args, recovery is re-call), or absent (the safe default, re-runs on
  replay). Both `view` and `pure` stay provenance `source` — a cacheable read still introduces
  external data (`infer` is the proof: a `source` declaring `cacheClass: "pure"`).
- **the trap** — `cacheClass: "pure"` is a cache class on a **source**, not provenance **pipe**
  (mint nothing). Different axes, same word: use `provenance: "pipe"` for pipe; never map "pure"
  onto `cacheClass` when you mean pipe.

## Effects are sinks, and danger is a property of the verb

An effect declares `provenance: "sink"` and returns **void by law** — the bake gate rejects a sink
whose contract carries a real return, and void-by-law is what makes **gather-then-burst** sound
(`environments.md` §AXES). If an "effect" must hand a result back into the program, it is not a sink
— it is a source with consequences, and must say so.

Whether an effect is _dangerous_ is a separate static fact — **danger is an attribute of the action,
not the argument set.** It is declared once at the verb (`tool.effect` for a plain mutation,
`tool.risky` for an irreversible one), on every call it will ever receive, never flipped by a caller
argument or a runtime condition.

## Dynamics belong to the rig, not to behavior

Describe-time personalization — a per-session catalog line, a live welcome screen — is sanctioned and
has a declared channel (`dynamicDescription`). A verb whose _runtime behavior_ silently depends on who
is calling is not: an actor-dependent input is a **declared argument the actor passes**, visible in the
program text, never ambient state smuggled through the environment. Configuration reaches a baked verb
through `this.configuration`/`this.resources` — `EnvCapability.define`'s injected `(symbol, z)` factory
types `symbol.native`/`symbol.rosetta`'s impl `this` as the capability's own validated config and live
resource `Ref`s, read per call. That channel carries config and resources, nothing else: per-caller
behavior still cannot hide there — it stays a declared argument the actor passes.

## Author resources lazily

A `Resource<H>` is a factory of disposable handles (the Erlang-port model over TC39
`AsyncDisposable`): lazy spawn on first verb touch, single-flight parallel acquire, reconstruction on
wind-down with stable `Ref` identity. The absolute law over them — **anything that reads a resource
defers the read to the moment it runs with a live activation** — is `environments.md` §RESOURCES; the
authoring consequences:

- Verb impls qualify automatically — the first touch of any of a capability's symbols pre-spawns _all_
  its resources before the body runs, so `.live` never races. Describe-time surfaces qualify only if
  authored lazily: an `inputSchema` resolving against a live handle must be a **getter**, a
  `dynamicDescription` a **thunk**. Reading `.live` at construction time (module top-level, spec
  literal, constructor) is always a bug — no activation exists yet, and eager reads at assembly are the
  connection storm the lazy model exists to prevent.
- **An object spread fires getters.** `{ ...def }` performs `[[Get]]` on every own enumerable property,
  firing a lazily-authored `inputSchema` getter with a receiver that has no `resources`. Machinery that
  reshapes symbol defs moves **property descriptors** (`Object.getOwnPropertyDescriptor` /
  `defineProperty`), never spreads; `McpEnvCapability`'s annotation lift is the reference implementation.

## Scheme code declares its imports too

A `symbol.define` body is FV-checked at bake: every free variable must resolve to a sibling symbol, a
dep's export, or the keyword baseline, else the failure is a door naming the fix (declare the `deps`
edge, or bind it locally). This is the point — a capability's scheme code declares its imports the
same way its JS does, so the DAG stays honest and a capability never works only because something else
happened to be assembled first. The FV locality law and the C3 assembly it keeps honest are
`environments.md` §PRELUDE and §ASSEMBLY.

## Doors, not walls

An omitted verb is a declaration, not an absence: `symbol.notImplemented` binds a **door** that throws
a teaching error carrying the reason and the alternative bound in _this_ environment. The same posture
runs through the machinery — the sink shape gate, the view serialization gate, the free-variable law,
the alias-target check all refuse at bake with the fix in the message. Never withhold a symbol by
silently omitting it from the record; if a verb is gated on an optional config key, declare that key
in the verb's `Contract.requiresConfig` — absence auto-mints a cause-carrying door, mode-independently,
so the assembly's `degraded` list enumerates it (`environments.md` §DEGRADATION).

## Exposing a capability to agents (MCP)

`@inhuman.tools/arrival-mcp` turns a capability DAG into one MCP tool whose argument is an arrival
program. MCP wraps **intent, not impact**: expose verbs an actor means (`create-widget`, `anchor-to`),
never materialization knobs — danger, cacheability, and lineage are facts the verb declares about
itself, not levers a caller holds. The catalog aggregates across the whole `deps` closure, deps-first
and self-last, matching assembly's own precedence; a plain `EnvCapability` dep still grants live verbs,
just undocumented to the catalog.

Two run-time consequences of the laws above:

- The risky axis pays off at run time: a burst of plain effects fires immediately, but **any risky row
  holds the whole burst** behind a signed manifest (fill-or-kill) — nothing fires, not even a harmless
  sibling — until the client confirms.
- Dynamic metadata obeys the resource-deferral law: getters and `dynamicDescription` thunks resolve
  against the live activation per read, never eagerly; a `dynamicDescription` resolving `undefined`
  falls back to the static `description` and is _not_ flagged session-generated — a failed live fetch
  degrades to the static truth, it doesn't fabricate.

## Testing a capability

Build a **tiny capability** inline in the test — one or two verbs closing over a local log — and drive
it through the same public entry a consumer uses (`exec`, or `DiscoveryTool.call` for MCP behavior). No
mocks of the machinery; the machinery _is_ the subject. Assert on the **observable effect ledger** (the
closed-over log, the returned values, the thrown door text), never on internals. Name behavioral
invariants as law-style rows — one `it` per clause, the clause in the test name — so a failing row names
the violated clause, not a line number. A door's _message_ is public surface: pin the teaching text,
not just the throw.

## Naming

- **Verbs by role intent, not implementation** — `stock-level`, not `query-inventory-db`. The
  materialization can change; the intent is the durable name. Kebab-case, `?` suffix for predicates.
- Capability names are `domain/thing` — the door's cause owner and the assembly's audit key, so make it
  legible. Subject-scoped packs spell the namespace directly into each verb's own record key
  (`"process/list": symbol.native\`process/list: …\`(...)`—`symbolPrefix` was retired 2026-07-22,
  test-only and never a production author).
- The doc line after `name: ` is the agent-facing catalog entry — prompt text; budget it like prompt
  text, warnings inline (`(irreversible)`).
