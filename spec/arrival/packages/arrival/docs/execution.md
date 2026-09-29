# The Run Model

> The mental model, stated once, ahead of the code. One `exec()` is a **run**: a hermetic
> unit of interpretation whose per-run state is minted once and threaded explicitly through
> the ops that need it, never reached for ambiently. This document says what that state IS, where it
> lives (data-local, not global), and how the per-run seams — cache, effects, reads, notes,
> display, resourcePaths — arm the interception facilities that turn a bare
> interpreter into a cacheable, burstable, read-guarded, temporally-zoned one.
> §14 SESSIONS is the CONSUMER view (sessions, scopes, budgets as a host wires them); the
> sections before it are the ontology under it — what the machine IS, so the wiring is the
> only shape it could take.

Section anchors are CAPS so code comments can cite `docs/execution.md §<ANCHOR>`. Each
section closes with its enforcement sites (files, no line numbers — those rot). Every claim
here is grounded in those files; when code and this document disagree, one is a bug — decide
which before writing a line.

Constitutional ground: PRINCIPLES.md (P0 two-layer coherence, P11 mint-at-the-edge),
environments.md (§HERMETIC the runtime/storage split, §MEMBRANE-SEAM the bake-side crossing this
model's chokepoint spins, §AXES provenance-role ⊥ cache-class), membrane.md (§REGION the
reverse-crossing discipline that closes the burst-bypass hole), PROVENANCE.md (§4, which owns
the SECOND meaning of "replay" — γ over frozen ingress).

---

## 1. HERMETIC — run-state is data-local

**One isolate runs concurrent runs; run-state that bled through a module-level holder would
cross between them.** A Cloudflare Durable Object shares one JS isolate across every request
it serves. Two `exec()` calls interleaved on that isolate must not see each other's strict
mode, cache, or effect log. The charter: **run-state is DATA-LOCAL** —
minted once per `exec()` by `new RunContext(...)`, threaded explicitly as the `runCtx` parameter
through every op that needs it (no value carries it — `AValue` dropped its per-value `.ctx`
field; `run/RunContext.ts`'s own header names the removal), read off the threaded context at the
one hermetic point, never off an ambient singleton.

Four homes, by lifetime:

- **RunContext** — state CONSTANT for one run yet DIFFERING between concurrent runs: strict
  mode, the abort signal, the channels (§3). This is the run's identity.
- **Global singletons** — state constant across ALL runs: `nil`/`#t`/`#f`/`eof`. These bear
  no run-state, so they can be shared by reference. `car`-of-nil reads its strict projection
  from the THREADED context, not from the constant `nil`, so a constant carries nothing
  run-specific.
- **Dynamic-extent holders** — state varying by CALL DEPTH within one run: the
  exception-handler stack, the current call-site (`eval/dynamic-call-site.ts`), the current
  region scope (membrane.md §REGION), and the provenance emission pair `_coordinate`/`_sink`
  (`eval/provenance-hooks.ts`). Four holders total — the extent guarantee the last one
  carries is stated at its own definition site, cited just below. These cannot ride a
  constant-per-run handle and stay the holder family (the `dynamic-call-site.ts`
  module-holder idiom, save/restore around the owning call, safe under single-threaded JS).
  Each holder is module-local; a second evaluation of its file in the same isolate throws
  `DuplicateModuleLoadError` (`src/single-load.ts`) instead of silently splitting or
  merging onto `globalThis`. The composed resolver is **not** a holder: it rides
  `CallCtx.resolver` (§CALLCTX).
- **Keyed residency** — a module-housed `WeakMap`/`WeakSet` keyed by a run-scoped object
  (typically `RunContext` itself); lifetime = the KEY's, not the module's. Used when a leaf
  must hold run-associated state without importing the owning layer (a `WeakMap<RunContext,
X>` needs no `RunContext` write access, only identity). Four sites, all independently
  audit-found: `inFlight` (`run/penetration.ts` — the single-flight in-progress-promise table;
  moved here from `run/run-cache.ts` when `penetrateThroughCache` did, audit P2 — cite
  `penetration.ts`, not `run-cache.ts`),
  `lifecycles` (`run/run-lifecycle.ts` — the disposal-callback table
  `onRunContextDispose` reads and writes), `vocabularyByRunCtx` (`env/assemble-run.ts` — the
  per-run `Vocabulary` a `CallCtx` dispatch looks up), `preludeDefinesByRunCtx`
  (`env/assemble-run.ts` — the per-run prelude-define frame, R12's persistence mechanism).
  A `WeakMap` entry dies with its key exactly like a `RunContext`-held field would; the
  difference is WHERE the map lives, not how long an entry survives.

The test for where a fact belongs: does it vary between concurrent runs (→ RunContext), never
(→ global singleton), within one run by depth (→ holder), or does a leaf need it without an
import edge to the owning layer (→ keyed residency)?

**The extent guarantee, stated where the holder lives (audit S1):**
`_coordinate`/`_sink` (`eval/provenance-hooks.ts`) are per-isolate, not per-run — their own
comment states the "at most one recording run per isolate" guarantee and names
keyed-by-runCtx as the upgrade path if that ever stops holding.

_Enforcement sites: `run/RunContext.ts`, `eval/generator-exec.ts`._

## 2. CTX-SPECIES — live, constant

Two `RunContext` species exist; only the first bears run-state, and the charter (§1) rests
on the other being run-NEUTRAL.

- **Live-run** — minted by `new RunContext(...)` per `exec()`. Carries strict/signal and any
  armed subset of the channels (§3, plus the default-armed `resourcePaths`). This is the only
  species whose channels are non-`undefined`.
- **`CONSTANT_CTX`** — the frozen, run-neutral context carried by values that OUTLIVE any run:
  the singletons, quoted-literal AST nodes (`evalQuote` returns them by reference across runs),
  everything constructed at bootstrap before a run exists. `strict=false`, **every
  channel `undefined`** (`resourcePaths` included — the one default-armed channel, §12, stays
  off here) — and that is correct, not a gap: a note or effect is addressed to ONE run, so a
  context outliving every run has nowhere to put one. **Nobody is listening.**

Because the constant species is run-neutral by charter, a value minted before or outside a run
drops the channels — never a leak.

**Parse-time source identity is not a ctx species.** It used to be (a retired `ParseContext`
subclass / `PARSE_CTX` / `makeParseCtx`): a one-hop envelope the Parser minted per datum purely
to hand a `SourceLocation` to the leaf minter one call later, which unwrapped `.location` and
stamped it on the value — the ctx itself was discarded immediately after and nothing else ever
read `origin` or a ctx's `.location`. It is now a plain `loc?: SourceLocation` argument threaded
directly from the Parser through `parse_argument`/`ADict.fromLiteralForms` to the leaf mints,
landing on the VALUE's own `.location` field (AValue) — no ctx involved, and no third species.

_Enforcement sites: `run/RunContext.ts`._

## 3. CHANNELS — six independent seams, armed subset-wise

**`X | undefined ⇒ facility off.`** Each channel on `RunContext` is an independent per-run
seam; `undefined` means that facility is off. A run may carry any subset — they are siblings,
none a field of another. Five default off; **`resourcePaths` alone defaults ON** (see below).

| Channel         | Facility when armed                                                | Off (`undefined`)        |
| --------------- | ------------------------------------------------------------------ | ------------------------ |
| `cache`         | membrane record/replay interception, per the mode law (§6)         | no interception          |
| `effects`       | effect-burst gather arm — a `sink` enqueues instead of firing (§7) | a sink fires immediately |
| `reads`         | read-tracking + the read∩write deferral guard (§8)                 | no tracking, no guard    |
| `notes`         | model-facing bookkeeping sink (§9)                                 | notes dropped            |
| `display`       | host `(display …)` affordance sink (§9)                            | no display verb bound    |
| `resourcePaths` | per-run Q/E journal + the temporal-immutability door (§12)         | no journal, no door      |

**The one inverted default.** `resourcePaths` is a LAW channel, not an observability channel:
an ordinary `new RunContext(...)` always mints a fresh `MemoryResourcePathLog`, so the CQS door
(§12) is on by default for every live run. It cannot be disabled on an ordinary mint —
facility-off is `CONSTANT_CTX` territory. `ExecOptions.resourcePaths` injects a harness spy or
custom log, never an off-switch. Everything else keeps the opt-in default.

**The sanctioned readers — exactly two, named here so the claim stays grep-checkable.** All
six channels are read off `this.runCtx.<channel>` at the baked rosetta `run` wrapper — the
chokepoint (§10, `common/symbols/rosetta.ts`) — PER PENETRATION:
`cache`/`effects`/`reads`/`resourcePaths`/`notes` are all read there. The eval loop
(`eval/generator-exec.ts`) is the second, narrower reader: the per-form
`reads.tracker.region(...)` wrap plus the post-form `checkReadWriteGuard` call (§8). Nothing
else consults a channel — a facility's whole armed/off behavior is decided by whether the
host passed a non-`undefined` value into `new RunContext(...)` (plus the `resourcePaths`
default above), read only at these two named sites.

**One arming surface, stated once.** `ExecOptions`
(`cache`/`effects`/`reads`/`notes`/`display`/`resourcePaths`/`strictCQSstrings`/`membraneClosure`)
is the public door: a field set rides `new RunContext(...)` onto the matching `RunContext` field;
a field omitted leaves it `undefined`. The per-channel `ExecOptions` field docs and the
`run/*` file headers describe the SAME wiring from two ends — the option is the entry, the
channel is the landing. There is no third landing and no transformation between them.
`membraneClosure` is the observation wrap (§REACTIVITY), not a CQS channel — same arming
door, different readers (the membrane sites, not the rosetta/eval-loop pair above).

**`execExpr` deliberately drops the model-facing channels.** The single-form entry
(`require`, prelude eval) mints its `RunContext` with `{ signal, cache, effects,
reads }` — **`notes` and `display` are absent by construction.** Those two are the
model-facing channels (§9); `execExpr`'s callers are sub-program plumbing (a required module,
a bootstrap prelude), not a top-level model turn, so there is no renderer to drain a note into
and no `(display …)` a model authored. The drop is correct, but it is currently SILENT — the
`execExpr` doc names `cache`/`effects`/`reads` riding the handle and does not state that
`notes`/`display` are omitted. Stated here explicitly: **a note or display pushed from inside a
`require`d module is dropped, because `execExpr` binds no such sink.**

_Enforcement sites: `run/RunContext.ts`, `eval/generator-exec.ts` (`ExecOptions`, `execState`,
`execExpr`), `env/assemble-run.ts` (`assembleRun`)._

## 4. CALLCTX — the fused dispatch `this`

**`CallCtx` is the ONE `this` every callable body sees**, fusing the dispatch-level receiver
(`runCtx`) with the per-call-site provenance carrier (`invocation`), the opt-in per-arg deep
provenance vector (`argProvenance`), and the apply's composed `resolver`. Flat, not nested —
every field is a cheap carrier, nothing to defer.

**`resolver` is the composed name-resolution + frame object of the apply that minted this
`CallCtx`.** It is call-varying (a new lexical frame is a new `Resolver.child`), so it cannot
live on `RunContext`. Evaluator dispatch (`evaluatePair`, `applyArrowProc`) passes
`ctx.resolver` into `makeCallCtx`. HOF / host-projection / `testCallCtx()` sites omit it.
`(require …)` and `require/extension` read it off `this` via `runResolverOf` — a missing field
is `RunResolverUnreachableError` (the verb was invoked outside evaluator dispatch). A
required module's forms must evaluate through this same composition: under the cut the
lexical frame is null-rooted and builtins live on the capability base; an env-only rebuild
loses `string-append`.

**`runCtx` is NEVER optional.** `makeCallCtx` takes it as a required argument with no default.
A `= CONSTANT_CTX` default would be a LATENT HAZARD — the easiest landing spot for the next
errant fallback — not a convenience: every real dispatch site passes an explicit live `runCtx`,
so a default would only ever mask a wiring bug. The null-`this` case is uninhabited too: the
`this: CallCtx` annotation on the wrapper signatures makes an unbound call a COMPILE error, so
no runtime door guards a statically-excluded state (that would be dishonest-types theater).

**`testCallCtx()` is the sole sanctioned door to `CONSTANT_CTX`.** Tests and host code invoking
a verb impl outside a real dispatch build a REAL `CallCtx` over `CONSTANT_CTX` through this thin
wrapper. `CONSTANT_CTX` survives ONLY inside this explicit constructor — never as an implicit
`this?.` fallback threaded through a verb body. The consequence, load-bearing: a value minted
by a verb called through `testCallCtx()` carries no run-state, exactly as intended for a test
harness, and the moment production code reaches for `CONSTANT_CTX` at a dispatch site, that is
the bug this door's existence localizes.

**`configuration`/`resources` resolve RUN-SIDE, off a value's owning capability — never off the
bind-time association.** `common/capability.ts`'s bind loop calls `associateCapability(value,
capability, readsResources)` once per bound native/rosetta/sequence/tagless(-guard) proc — the
association answers ONLY "who owns this value, and does it read resources at all" (both define-
time constants), never "under which assembly". At dispatch, `makeCallCtx` (`run/CallCtx.ts`)
looks the owning capability up in TWO run-scoped tables:

- `runCtx.capabilityConfigurations` — the validated per-assembly configuration, a plain
  `ReadonlyMap<object, unknown>` filled ONCE, eagerly, when a RunContext is minted through
  `env/assemble-run.ts`'s `assembleRun`, copied straight off the tuple's memoized
  `Vocabulary.configsByCapability` (deps included, deduped by capability identity).
  `this.configuration` is that lookup, verbatim.
- `runCtx.capabilityResources` — unchanged in spirit (§1d's per-run resource store), except its
  configuration feed is now the SAME table lookup instead of a parameter carried on the
  association.

**Why this axis moved off the value-keyed association.** A symbol factory that mints ONE value
at `define()` time to serve EVERY assembly of a capability cannot carry per-assembly
configuration on a `WeakMap<value, config>` — a second assembly's `lower()` would silently
clobber the first's entry for the SAME shared value. Keying by the RUN instead — the thing that
genuinely differs per assembly, one RunContext per `exec()` — cannot collide: two concurrent
runs against the same shared value each carry their own table.

**The consequence, deliberate.** Every public path now runs through `assembleRun` — directly, or
via `execExpr`'s own standalone-default `assembleRun({ capabilities: BASE_ROSTER, ... })` — so
`this.configuration` is populated on every sanctioned dispatch, `execExpr` included. Only a
RunContext minted with NO vocabulary at all — `CONSTANT_CTX`, and the internal over-frame family
(`execExprOverFrame`/`execOverFrame`, the `ExecOptionsOverFrame` test-harness seam that mints
`new RunContext(...)` directly over a caller-held live frame instead of going through
`assembleRun`) — carries no `capabilityConfigurations` table, so a dispatch there sees
`this.configuration === undefined`, the SAME posture a capability with no configuration schema
at all already has (and the SAME posture `capabilityResources` already documents for that path).
A REUSED `runCtx` (`ExecOptions.runCtx`, REPL continuity) carries whatever table its OWN
originating `assembleRun` call built — checked by vocabulary IDENTITY on reuse, never re-filled
(a mismatch throws `RunContextVocabularyMismatchError`) — while a fresh `new RunContext(...)` a
caller mints by hand outside `assembleRun` (the over-frame seam above) carries none.

_Enforcement sites: `run/CallCtx.ts`, `run/RunContext.ts` (`capabilityConfigurations`),
`env/assemble-run.ts` (`assembleRun`)._

## 5. BUDGETS — two bounds, first to fire wins

Two independent bounds cap a run; they compose, and whichever fires first ends the
**call** (never the session — the scope and its definitions survive, so a REPL loop catches and
continues). The CONSUMER view — how a host arms them per call — is §14 SESSIONS; this section
states the mechanism they share.

- **`budgetMs`** (wall-clock). An INTERNAL bound — the trampoline itself throws once the deadline
  elapses, no external controller needed. Checked at TICK boundaries (loop-step / tail-call), so
  it bounds interpretation time and cannot interrupt a run parked inside one native call (a 50ms
  budget over a native 200ms sleep returns at 200ms). A native collection walk (`map` / `append`
  / macro expansion) is one such parked call: it emits no TICK, so `budgetMs` fires only after
  that walk returns. Reach for `signal` when a bound must also cover a slow native call.
- **`signal`** (`AbortSignal`). The one bound that reaches into native calls, and the SAME
  reference the trampoline reads — so every consumer observes abort state off one handle that
  cannot drift.

**Span differs by entry, deliberately.** In `execState`/`exec` the deadline spans the WHOLE
call — all top-level forms share one budget, so a sandbox program that splits a hang across
several forms is still bounded. In `execExpr` the deadline is PER-FORM (one expression, one
budget) — a cumulative multi-form bound there would need a shared `RunContext` no `execExpr`
caller can inject yet.

_Enforcement sites: `eval/evaluator.ts` (TICK check), `eval/generator-exec.ts` (the per-form
loop, `execExpr`). Consumer view: §14 SESSIONS._

## 6. MODE-LAW — record × replay × class

**THE single home for the record/replay table.** The mode law governs the membrane, not
storage: `mode: "record"` is a live run (the impl fires, its result is written);
`mode: "replay"` is a fold (a hit answers WITHOUT firing). The behavior per stamped cache class:

| class      | record mode                                                                                  | replay mode                                                                           |
| ---------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `view`     | fire, write/OVERWRITE `{value}` (a settled entry never suppresses a live fire — fresh truth) | hit → serve, never re-fire; miss → fire + write (a NEW program's novel call is fresh) |
| `sink`     | fire, write `{effect}` tombstone (two identical live sinks = TWO effects, always)            | tombstone hit → skip (void); miss → fire (new intent, not a repeat)                   |
| `pure`     | fire                                                                                         | fire — determinism from args is the CONTRACT; recovery = re-call, never stored        |
| undeclared | fire                                                                                         | fire — regenerateable, the SAFE default                                               |

The cache class is an EXPLICIT declaration on the contract, never derived from the lineage role
(environments.md §AXES: the two axes are orthogonal — `infer` is a provenance SOURCE declaring
`cacheClass "pure"`, the standing proof). An undeclared, non-`sink` def never touches the
serialized cache.

**SINGLE-FLIGHT — `view`/`pure` only, rejection evicts.** Concurrent identical penetrations
WITHIN one run share ONE rosetta call (each invocation lives in an immutable world, so the
second gains nothing by re-firing). The in-flight promise registers at call start, scoped to
`view`/`pure` and NEVER `sink` (two live effects are two effects). A REJECTED promise is never
cached — rejection evicts the pending entry, so retries are allowed and a transient failure
never pins as a stored error. Only SETTLED entries serialize.

**The cache is RUN-level.** `RunCache` deliberately carries NO session plumbing — no epoch,
roster, or configDigest identity, no TTL. The SESSION layer checks cache validity BEFORE handing
a cache to a run: on mismatch it drops the cache and keeps the log. A rehydration builds a NEW
`replay` cache OVER a recorded one's entries; mode is fixed at construction and a live cache is
never flipped.

_Enforcement sites: `run/run-cache.ts` (`penetrateThroughCache`, the table), `common/symbols/_bake.ts`
(`assertCacheClassShape` — the class gate), `common/symbols/rosetta.ts` (the chokepoint that
applies it)._

## 7. BURST — the ordered, non-deduplicating effect arm

**`EffectLog` is the ORDERED sibling of `RunCache`.** Where the cache is a content-keyed,
deduplicating `Map`, the effect log is a plain append-only sequence: two identical sink calls
are two entries, ALWAYS — the mode law's "two effects, always" (§6) holds for the burst arm
exactly as for the tombstone arm. The log remembers WHAT was gathered, in WHAT order, and at
what read-clock; it does not judge whether replaying against a moved world is safe (that is the
read guard, §8).

**The gather condition, named ONCE here** (three files repeat the predicate): a `sink`
penetration gathers instead of firing when it is a PRIME run —

```
sink && effects !== undefined && cache?.mode !== "replay"
```

The `cache?.mode !== "replay"` clause excludes a fold: a fold re-executes settled history
through the tombstone-skip path (§6) and must never gather twice. When the condition holds, the
penetration enqueues `{verbName, decodedArgs}` (plus the read-clock, §8, and the raw pre-decode
args for a confirmation manifest) and **returns `undefined`** — a third interception mode
alongside plain-fire and record/replay-tombstone.

**Sound because the program structurally cannot observe the deferral.** The sink's return is
`undefined`; the void-family bake gate guarantees a `sink` verb's contract yields nothing a
program can read, so deferring the fire past the statement changes no observable value. That is
the bake-time proof the runtime law stands on (§10).

**POISON RULE.** A failed burst leaves the log AS-IS — the log never drops an entry and never
self-polices. The CALLER decides whether a poisoned log is drained again; the entity carries no
retry policy.

**Drain: strict order, no retry.** `burst` fires each entry through a caller-supplied executor
in strict index order, one pass, no reordering. A mid-entry throw stops the drain IMMEDIATELY
and rethrows `BurstDrainError` carrying the failing entry's position and the entries that never
ran. **The caller owns rollback** — `burst` has no side effects beyond the executor; the real
burst (plexus region, atomicity, conflict handling) is HOST territory, and arrival only wires
the gather.

**The burst-bypass hole, and its closure.** A reverse lambda (a Scheme callable handed to host
JS) that calls a sink verb must hit the burst arm, not fire inline — otherwise a deferred effect
escapes gathering. This is closed by REGION SCOPE: the callable's arguments box under
`scope.runCtx` (the invocation's LIVE context carrying `effects`), so a lambda calling a sink
re-enters through `this.runCtx.effects` and gathers. The hazard shape and the bake-side gate
that steers `z.value` slots to `z.procedure` (so no callable marshals under a stale scope after
an `await`) live in membrane.md §REGION — cross-linked, not duplicated.

_Enforcement sites: `run/effect-log.ts` (the log, `burst`, `BurstDrainError`), `run/run-cache.ts`
(`penetrateThroughCache` — the gather condition), `common/symbols/rosetta.ts` (the chokepoint +
the region-scope re-entry). Cross-link: `docs/membrane.md §REGION`._

## 8. READ-GUARD — a burst must not read its own deferred write

**The one rule that makes gather-then-burst sound:** a program that enqueues a sink and THEN
reads something that sink will write cannot run as a deferred burst — the read would observe
PRE-write state where sequential execution observes POST-write state. That shape is detected and
doored; everything else (query-then-mutate, mutate-disjoint-then-read) runs untouched.

**The fencepost — 1-based read clock vs 0-based enqueue clock — is load-bearing.**
`ReadEvent.clock` is 1-BASED (the Nth read has `clock === N`, the read counts itself).
`EffectEntry.enqueuedAtReadClock` is 0-BASED ("how many reads completed before this enqueue" =
`reads.log.length` at enqueue time). Pairing them makes `read.clock > enqueuedAtReadClock` a
TIE-FREE test: if zero reads preceded an enqueue (`enqueuedAtReadClock === 0`) and the very next
read is the first observed (`clock === 1`), then `1 > 0` correctly flags it as after. A
same-basis comparison would tie exactly this case — the canonical enqueue-then-read violation,
the one case the guard exists to catch.

**SEAM, not a mobx integration.** Arrival core has ZERO runtime dependency on mobx or plexus.
`ReadTracker` is an INJECTABLE interface arrival only calls through; the real mechanism (a mobx
tracking context over plexus-observable reads) lives with the plexus-facing HOST and is armed
onto `RunContext.reads` the same way `cache`/`effects` are. A run with no tracker pays nothing.

**`writeSetOf` abstains honestly.** The write-set is PREDICTED at enqueue (there is no live burst
region to observe), via a host-supplied resolver answering "which read-keys will this effect's
write touch." A resolver that cannot derive a footprint for an entry returns `undefined` — the
entry is SKIPPED, not treated as "no writes." A host that cannot predict footprints at all does
not arm `writeSetOf`, and the guard degrades to a no-op — never a false negative dressed as fact,
never a crash on incomplete information.

**Guard region = EXECUTION only; one top-level form = the region unit.** The eval loop wraps each
top-level form in `reads.tracker.region(...)` (async-shaped, because form evaluation awaits at
budget boundaries — a mobx `Reaction` does not survive an `await`, so the host owns a scope that
does). After each form, for a PRIME run gathering effects (mirroring the burst arm's own
`cache?.mode !== "replay"` gate — a fold never gathers, so it never needs a guard),
`checkReadWriteGuard` runs over the log so far. The guard is NEVER re-checked at a post-burst
serializer walk — the eval loop performs no such walk. First violation throws
`ReadYourDeferredWriteError`, the teaching door naming both halves (which effect, which later
read) and routing the caller: put the read in a follow-up call (the effect will be committed by
then), or drop it.

_Enforcement sites: `run/read-guard.ts` (`ReadEvent`, `checkReadWriteGuard`, the error door),
`eval/generator-exec.ts` (the per-form region wrap + the post-form check)._

## 9. SINKS — the return channel must never lie

Both model-facing channels are leaf sinks (zero imports) riding `RunContext`, scoped to ONE run
so nothing leaks across concurrent sessions, and both drain once at end of call.

**LAW — the return channel must never lie.** When the kwargs tolerance drops a far-unknown
argument key and lets the call proceed (dropping `:limit 10` against a tool with no `:limit`
beats crashing over an argument that changes nothing), a SILENT drop would be a lie of omission
— the model still believes `:limit` was honored. So the dropped key is surfaced as a **note**.
Every "nothing happened" must name WHICH nothing it is.

- **`NoteSink`** carries SESSION BOOKKEEPING — facts ABOUT the call, not results OF it —
  rendered into a `#| ── environment notes ── |#` reader-comment footer that parses to zero
  forms, so the model tells bookkeeping from answer at a glance. It dedups (one tolerance can
  fire on several calls to the same tool; the model needs the fact once). NOT for per-statement
  teaching (a door explaining a mistake belongs on that statement's own error) and NOT part of
  the answer. The note belongs to the RUN, not to any value inside it — a WeakMap keyed on the
  decoded argument object would be undrainable, because the renderer never sees that object.
- **`DisplaySink`** backs `(display …)`, which arrival itself does NOT and will not provide:
  ports and IO are omitted by design (a pure inference plane has no value-construction site to
  give an ambient write provenance). A model reaches for `(display x)` as the natural "show me
  this" idiom, so the MCP runner binds it as a HOST AFFORDANCE — identity plus a side effect into
  this sink, the value flowing on untouched so composition is unaffected. Intent honored without
  the language acquiring an IO surface.

_Enforcement sites: `run/note-sink.ts`, `common/symbols/rosetta.ts` (the tolerance-note drain),
`eval/generator-exec.ts` / `eval/exec-phases.ts` (channel arming — and the §3 `execExpr` drop)._

## 10. CHOKEPOINT — where the run model attaches

**One site carries the whole run model at runtime: the baked rosetta `run` wrapper.** It is the
single point where args are decoded and the impl has NOT yet fired — so the mode law (§6), the
burst arm (§7), and the read-clock stamp (§8) all attach there, reading `cache`/`effects`/`reads`
off `this.runCtx`. The interception is `penetrateThroughCache`; provenance mint, encode, and
attestation then run over the result exactly as over a fresh impl return (values are never
restored AROUND the membrane, only THROUGH it).

**Fast-path bypass.** A run with neither a cache nor an effect log skips
`penetrateThroughCache` entirely (`runCache === undefined && runEffects === undefined` → bare
`fire()`) — byte-identical to a pre-cache interpreter. A run with an effect log but no cache
must still reach the chokepoint (the burst arm lives inside it), which is why the bypass gates
on BOTH being absent, not just the cache.

**The bake-time gates the runtime law stands on.** Two properties the wrapper's runtime behavior
assumes are PROVEN at bake, once, off the same normalized schemas:

- **Sink-void** — a `sink` verb's contract yields nothing a program can read, so deferring its
  fire (§7) is unobservable. The void-family bake gate makes the unreadable-return shape a
  declaration fact, not a runtime hope.
- **View serializability** — a `view` cache entry MUST serialize, so `assertCacheClassShape`
  rejects at bake any `view` contract carrying a `z.lambda` arm (a callable is not a boundary
  snapshot) or a `z.value` slot (the raw escape hatch, by definition not serializable) — on
  BOTH vectors, because an input escape hatch breaks the cache KEY (`canonicalJson` over decoded
  args) and an output one breaks the ENTRY. The author's way out is declaring `pure` (recovery =
  re-call, nothing persists) or nothing.

_Enforcement sites: `common/symbols/rosetta.ts` (the `run` wrapper), `common/symbols/_bake.ts`
(`assertCacheClassShape`, the void-family / callable gates), `run/run-cache.ts`
(`penetrateThroughCache`)._

## 11. TWO-REPLAYS — one word, two mechanisms

The word "replay" names two different things in this package; conflating them is a category
error.

- **Run-model replay** (this document, §6) — re-execution of the statement log with a
  `RunCache` in `mode: "replay"` ANSWERING THE MEMBRANE. A `view` hit serves a stored decoded
  value; a `sink` tombstone skips; `pure`/undeclared re-fire. The durable twin of a run is
  `(program, cache)`, and a cache can outlive its program to answer a full re-run of a NEW
  program over the SAME cache (content-keyed, so only `(node, args)` survives a program edit).
- **Provenance γ-replay** (PROVENANCE.md §4, which OWNS it) — `apply` of a wire lambda to
  RECORDED INGRESS in a hermetic env under region discipline. γ **never re-invokes a source**;
  the frozen retrospective mint records are authoritative. It runs in a SILENT region (doors
  active, stream emission off) and is a pure query over a `(template-hash, ingress)` pair.

**The shared seam, stated once:** for a `pure` symbol both mechanisms recover the same way — by
RE-CALL, because determinism-from-args is the contract. Run-model replay stores nothing for
`pure` (recovery = re-call); γ re-derives a pure-selector mux's decision rather than recording
it (purity re-derives). One principle, two layers: what is deterministic from its inputs is
never stored, only recomputed.

_Enforcement sites: `run/run-cache.ts` (run-model replay). γ-replay: `provenance/replay.ts`,
specified in `docs/PROVENANCE.md §4` — cited, not absorbed._

## 12. RESOURCE-PATHS — domain lanes, temporal immutability

**A resource path is a segment tuple naming a world location** (`["db","projects",id]`); its
first segment is the domain root. Overlap is **segment-wise prefix in either direction** —
never string-join (`["db","project"]` vs `["db","projects"]` are siblings). A rosetta contract
may declare two dynamic **path producers**, `queries?` / `effects?`, called with DECODED args
on every penetration — rosetta-only (natives/tagless/sequence bake-door via
`assertNoResourcePathProducers`), and never derived from the impl's return: footprints must
exist BEFORE the world moves.

**LAW — temporal immutability (inter-query coherence).** The door is **intervening-E**, not
classic write-then-read: a new query genesis on a domain is illegal only when an effect
intervened BETWEEN two overlapping queries on it —

```
door on Q_b ⇔ ∃ prior Q_a, intervening E:
  time(Q_a) < time(E) < time(Q_b),  Q_a ∩ Q_b,  E ∩ Q_b     (prefix overlap)
```

Bare E→Q is LEGAL (an effect then a first read), as are Q→E (query motivates the mutate),
E→Q→E and E→Q→Q. What is doored is re-querying a domain this run already queried and then
mutated — hold the first result instead. Each domain is its own lane; lanes interleave freely.

**Order per penetration, load-bearing:** decode → path producers → intervening-door scan
against the PRIOR journal only → record Q then E (hybrid Q≺E) → cache/effects arms → impl.
Recording after the check means no self-door on a single call; the Q≺E record means a hybrid
(upsert) **touches its domain once per run** — a second identical hybrid call is its own
Q→E→Q and doors with the hybrid teaching clause (`ResourcePathConflictError`).

**Storage cut, derived from produced paths** (never a free-form declaration for this axis):
`E≠[]` → an effect-log entry when `effects` armed (a FIRED manifest row — separate arm from
void-sink gather, never dual-keyed with `sink`); `Q≠[]` → CQS journal only (temporal
immutability). Interpreter value-cache is **`cacheClass: "view"`**, opt-in, orthogonal —
a query does not become a snapshot. Host planes (LLM InferStore, disk pins) sit under the
provider, never in Scheme. Hybrid → impl fires, E logged, return not auto-cached. Neither
→ untracked. `serializeResourcePath` is the ONE key encoding — door messages,
`writeSetOfResourcePaths` host footprints, and confirm-manifest rows share it.

**Segment typing:** `ResourcePath = readonly string[]` is the type-level law;
`strictCQSstrings` (default false) adds the runtime
assert. Producer SHAPE (array of segment-arrays) is always enforced
(`ResourcePathProducerError`), and produced paths are frozen COPIES — a producer's own array
mutated later never corrupts the journal or effect-log stamps.

**Three bake doors on the axis pairing (2026-08-13):** a **queries-declaring contract must
serialize on both vectors** (`ResourcePathShapeError` — no `z.lambda`/`z.schemeValue`/
`z.dynamic` slots; resources are pointed at by serializable id, and path producers read
decoded args); **sink ∧ queries is a contradiction** (`ResourcePathRoleConflictError`,
type-level twin on `CrossingContract`) — under gather a sink's impl is skipped, so a declared
Q would journal a read for a body that never ran (sink+effects stays legal — a sink IS an
effect); and **effects-only must be void-family** — the return of an effectful verb is
licensed by its Q half (upsert-with-return is the hybrid shape), so a returning writer
declares the query path or voids its output (`"effects-only-return"`, type-level twin).

_Enforcement sites: `run/resource-paths.ts` (algebra, journal, door, `applyResourcePathCqs`),
`common/symbols/rosetta.ts` (the chokepoint call), `run/run-cache.ts` (storage arms),
`common/symbols/native.ts` / `sequence.ts` (bake door)._

## 13. REACTIVITY — Arrival does not own a reactive runtime

`queries` / `effects` are the CQS door (§12): same-run temporal immutability, not
subscription. A path-atom bus keyed on those footprints, a `createReactionHub` that re-ran
`exec` when they overlapped, and `this.reactiveAtoms` as a manual bridge were a second
catalog next to any live graph the program actually walked. Observation of live handles is
a host concern: `RunContext.membraneClosure` wraps every membrane interaction
(borrowed-store read, host-fn fire, reverse-membrane re-entry, result egress). The wrap
is reentrant — `work()` may itself cross. Reverse-membrane wrappers close over
`scope.runCtx` at mint, so a late JS→Scheme call after `exec` returns still sees this
run's wrap. `undefined` ⇒ identity. Re-adding a path-keyed subscribe API inside Arrival
recreates the catalog.

_Enforcement sites: `run/RunContext.ts` (`applyMembraneClosure`), `values/primitives/ACallable.ts`
(host-fn fire + reverse wrap), `common/symbols/rosetta.ts` (baked hostImpl),
`common/scheme-zod/index.ts` (`z.procedure` both directions), `membrane/AJSObject.ts` /
`membrane/AJSArray.ts` / `values/primitives/APair.ts` (`AJSArrayList`) (borrowed-store
terms), `eval/generator-exec.ts` (result egress)._

---

## 14. SESSIONS — the consumer surface: sessions, scopes, budgets, the CLI

_(The consumer view of §1–§11: how a host wires sessions, scopes, and budgets over the run
model. The ontology is above; this is the surface a host holds.)_

**`exec` is one-shot; `execState` is session-shaped.** `exec` runs a program and returns plain
JS values. Everything session-shaped — a REPL, a long agent conversation, a multi-step pipeline
— is `execState`, which returns `{ values, scope, runCtx }`: the run's `scope` (where `define`s
landed) and its `runCtx` (the per-run hermetic knobs, §1).

**Definitions accumulate through the scope; the returned `scope` IS the object you passed in.**
Thread `s1.scope` into the next call and the session continues — nothing is resent, and identity
holds (`s1.scope === s2.scope`). To name a session up front, mint one with `LexicalScope.fresh(name)`
and pass it to every call.

```typescript
const session = LexicalScope.fresh("agent-session");
await execState(`(define greeting "hello")`, { scope: session });
await execState(`(string-append greeting " world")`, { scope: session }); // "hello world"
```

`LexicalScope.fresh()` is an isolated lexical root — a second `fresh()` scope does not see the
first's names. Isolation is exactly _lexical_, never a crippled stdlib: builtins are not part of the
scope, they resolve through the run's capability base.

**Vocabulary and memory are orthogonal: `capabilities` are per call, `scope` carries.** A session
can gain or lose tools mid-way without losing its state — `capabilities` decide what verbs _this
call_ may use, `scope` decides what definitions persist.

**Budgets are per call and compose, first to fire wins.** A budget error ends the _call_, not the
session — the scope and its definitions survive, so a REPL loop catches, reports, and continues. The
two bounds (`budgetMs`, `signal`) and their edges are §5 BUDGETS.

**The CLI over this surface.** `@inhuman.tools/arrival-cli` is a REPL over exactly this
scope/capability surface — one `LexicalScope` per session, budgets per form, capabilities armed per
call. It is this library API's first consumer, not a different model.

**Disposal is capability-owned, deliberately unexported.** `onRunContextDispose`
(`run/run-lifecycle.ts`) registers a teardown to fire when a `RunContext` disposes; it sits
on no public or `-internals` tier — `common/capability.ts` is its only caller, registering
capability-cell wind-down (readable resources, resource pools). A host never calls it
directly: `disposeRunContext` (exported at the package root, §1) is the host-facing door, and
running its registered teardowns is what "dispose" means (audit W11).

_Enforcement sites: `eval/generator-exec.ts` (`exec`, `execState`), `eval/LexicalScope.ts`
(`LexicalScope`), `run/run-lifecycle.ts` (`onRunContextDispose`, `disposeRunContext`)._
