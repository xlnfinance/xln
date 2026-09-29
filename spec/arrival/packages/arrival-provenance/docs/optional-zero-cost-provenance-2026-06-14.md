# Optional, zero-cost-when-off provenance in the arrival run plane

2026-06-14 · design recommendation (no code changes) · author: Claude

## The ask

Every isolated run today goes through `Project.runTraced(source, {trace})` with an
`EvalTrace` tap attached. The tap mints an `Invocation` per reduction, runs a MobX
`action` on `enter`, computes provenance on `exit`, and retains nodes forever
(`records` / `bindings` / `#invocationLog`). The recently-added value-GC + entry cap
bound _memory_, but the per-reduction **CPU + allocation** cost is paid on every run —
even when the caller only wants the result.

We want two run modes:

- **casual / value-only** — zero tracing overhead (no `Invocation`, no MobX, no tap
  calls). The common case: caller wants the result.
- **provenance / teleological** — full trace, for `why` / `where` / `how` / `dag`.

V's working names: `.runCasual` vs `.runTeleological`. Naming treated as open below.

---

## 1. Current cost — what the tap actually pays

### `run` is already a tap-free fast path

`Project.run` (`arrival-chain/src/project.ts:251`) threads `tap: opts.trace` into
`buildArrivalEnv` (`:446`) and into `exec` (`:455-459`). When no `trace` is passed,
`tap` is `undefined`. The evaluator's tap block is **guarded**:

> `arrival-scheme/src/evaluator.ts:2480-2505`
>
> ```ts
> const tap = ctx.tap;
> if (tap && __location__ in code && (!ctx.nodeFilter || ctx.nodeFilter(code))) {
>   const inv = tap.enter(code, ctx.currentInvocation ?? null, ctx.tail === true);
>   const childCtx: EvalContext = { ...ctx, currentInvocation: inv };
>   return yield { call: evaluatePair(code, childCtx), tail: true, onResolve: …, onReject: … };
> }
> return yield* evaluatePair(code, ctx);
> ```

When `tap` is `undefined` the whole block is skipped and control falls to
`return yield* evaluatePair(code, ctx)` — **no `Invocation` allocation, no childCtx
spread, no onResolve/onReject closures, no extra trampoline slot.** The `&&`
short-circuits on the first operand, so the `__location__ in code` membership test and
the `nodeFilter` call don't even run.

The one residual cost on the no-tap path is the symbol-resolution probe at
`evaluator.ts:2557`: `ctx.tap?.onSymbolResolved?.(…)`. That is a single optional-chain
that resolves to `undefined?.()` ⇒ a cheap no-op; the args (`ctx.currentInvocation ?? null`,
`first`, `fn`) are evaluated but already in hand. Negligible, and elidable (see §5).

**Conclusion: `run` already gives us the casual/zero-cost path for free.** The
zero-cost mode is not new machinery — it is `run` without a `trace`. The work is
plumbing it into the run plane and the MCP surface, not building a new evaluator path.

### What `runTraced` pays that `run` doesn't

Per **reduction that carries `__location__`** (i.e. every parsed user-program Pair —
not atoms, not macro-built pairs):

1. **`Invocation` allocation** — `new Invocation(id, node, parent)`
   (`arrival-provenance/src/trace.ts:440`), plus `children: []` array per node
   (`trace.ts:158`). One object + one array per reduction.
2. **A MobX `action`** — `enter` is wrapped `action(...)` (`trace.ts:432`) **solely**
   because it bumps the `#entries` observable box (`trace.ts:450`,
   `this.#entries.set(...)`), and strict-mode (`enforceActions: "observed"`, enabled by
   the studio) rejects a bare observed write. The action wrapper has per-call overhead
   (transaction begin/end, reaction scheduling) on _every_ reduction. `exit` and
   `markProvenancePoint` are deliberately bare (plain-field writes) — see the comment
   at `trace.ts:419-423`.
3. **`records` Map upkeep** — find-or-create `NodeRecord`, `rec.bindings.add(inv)`,
   `#invocationLog.push(inv)`, `rec.entered += 1` (`trace.ts:442-449`). Three
   collection writes per reduction.
4. **A childCtx object spread** — `{ ...ctx, currentInvocation: inv }`
   (`evaluator.ts:2483`) per traced node, plus the extra trampoline slot with two
   closures (`onResolve` / `onReject`, `evaluator.ts:2496-2503`).
5. **Provenance computation on `exit`** — `computeProvenance(inv, this)`
   (`trace.ts:462,471`) unions children's provenance sets; `#pruneChildProvenance`
   walks children (`trace.ts:472`); on a provenance point the value is cloned with
   `withProvenance` (`trace.ts:488-489`). The clone is load-bearing for the value-carry
   channel.
6. **Retention** — even with the GC, the trace retains an `Invocation` per
   _provenance-point_ + each point's direct children, plus the `#invocationLog` pointer
   array (`trace.ts:311`). Monotonic for the trace's lifetime; the handle store
   (`discovery-backing.ts:35`) pins the whole trace per stashed handle until session end.

**Is this a per-reduction hot-path cost even for a tiny program?** Yes — items 1–4
fire on _every_ located reduction unconditionally once a tap is present; there is no
"small program" discount. A trivial `(+ 1 2)` still allocates Invocations for each
located sub-form and runs the MobX action on each `enter`. The MobX action (item 2) is
the single most expensive per-step item, and it exists only to feed one observable box
that pure-CLI/MCP runs never observe.

### The infer resolver duplicates trace plumbing too

Note: `run`'s `inferAndWait` (`project.ts:348`) is already trace-aware — it guards every
trace touch with `if (inv && opts.trace)` (`project.ts:388`). `runTraced`'s near-identical
resolver (`project.ts:922`) assumes `opts.trace` always present (`if (inv)` at `:948`).
This is the duplication the redesign should collapse (§5).

---

## 2. The evaluator seam — is no-tap truly zero?

Yes, with one trivial caveat.

- `enter` / `exit` are **not** called unconditionally — they are inside the
  `if (tap && …)` guard (`evaluator.ts:2481`). No `tap` ⇒ neither fires.
- The childCtx spread (`evaluator.ts:2483`) and the closures (`:2496-2503`) are inside
  the same guard. No allocation when off.
- The trampoline's pop-side hook handling (`evaluator.ts:~808`) is a no-op when slots
  carry no `onResolve`/`onReject` (the comment at the trampoline notes "in the common
  no-tap case every popped slot's hooks are [absent]").
- **Residual:** `ctx.tap?.onSymbolResolved?.(…)` at `evaluator.ts:2557` and
  `:2469`. Optional-chain ⇒ no-op when off, but the argument expressions still evaluate.
  Cost is sub-nanosecond; listed only for completeness.

So the casual path's per-step overhead vs. a hypothetical zero-instrumentation
interpreter is **one resolved optional-chain per symbol head**. Effectively zero.

---

## 3. The run plane — where the trace is forced

`run-isolated.ts:runBounded` (`:63`) **always** constructs `new EvalTrace(traceMax())`
(`:69`) and calls `project.runTraced(...)` (`:78`). Both `runNamed` (`:115`) and
`runNamedCall` (`:123`) funnel through `runBounded`, so **every** `(require/eval …)` /
`(require/call …)` from the discovery plane builds a full trace.

`ResultHandle` (`result-handle.ts:18`) carries `value`, `outputNode`, and the live
`trace`. `discovery-backing.ts` stashes the handle in a session-scoped `Map`
(`:35`), returns `{ value, handleId }` to the caller (`:38-42`), and answers
`why/where/how/dag` later by recalling the stashed handle and projecting
`whyOf/whereOf/howOf/dagOf` over its trace (`:61-72`).

**This is the cost center.** The handle store means the trace must be retained
indefinitely (until session end / handle eviction) so a _later, separate_ MCP call can
ask `why`. That is the architectural reason the trace is built eagerly: provenance is
requested **out-of-band**, after the value is already returned.

---

## 4. The re-run option — is a run replayable?

**Yes, and this is the load-bearing fact.** Per `effect-log.ts:1-40` and ADR-025
(`inhuman/docs/decisions/IN-025-resumable-pause-is-a-pending-membrane-penetration.md`):

> "Everything else in a run is **pure** (a fold over the program's files), so the set
> of effects is the run's ENTIRE contact with non-determinism. Capture them all and a
> re-execution becomes a pure function — the warrant behind replay."

The effect-log captures every external effect (`infer` / `http` / `sql` / `mcp`) by
kind-tagged key. Binding a FULL log via `effectLog` (`project.ts:293`) makes every
effect short-circuit to its recorded value with **zero external hits**
(`project.ts:364-377` for infer; `#wrapDataResolver` `:483` for data; `wrapMcpResolver`
`:434` for mcp). Replay is byte-identical: a replayed infer still records the same value
(`project.ts:407`) and marks the same provenance points (`:373-374`).

So: **a casual run that _also_ captured an effect-log can be re-run with a trace
attached, and the trace-time re-execution will reproduce the same value and the same
provenance graph** — because every non-deterministic input is pinned by the log. The
re-run does pure work + log lookups; it fires no LLM/http/sql/mcp calls.

**What breaks without the log:** a naive re-run (no effect-log) re-fires every effect.
Non-determinism (LLM sampling, clock, network) means the second run can produce a
_different_ value and a _different_ graph — and pays full external cost again. So
re-run-traced is only sound **if** the casual run captured an effect-log. That capture
is cheap: `onEffect` / `onEffectResult` are plain callbacks (`project.ts:266-272`), fire
only at the (already-rare) external-effect boundary, and `run` already accepts them
without a trace. **Capturing the effect-log is orthogonal to tracing** — it rides the
effect membrane, not the per-reduction tap.

ADR-IN-026 (git-is-the-deploy) adds: a run pins its `ProgramVersion`; re-running the same
version + same effect-log is referentially transparent by construction. The pieces for
sound re-run already exist.

---

## 5. The three designs

### (a) Two explicit entry points — casual elides the tap entirely

`runCasual(source, …)` ⇒ `project.run` with `trace: undefined` + effect-log capture
(`onEffect`/`onEffectResult` wired to an `effectLogCollector`). `runTeleological(…)` ⇒
today's `runTraced`. The run plane (`runBounded`) takes a `mode` and constructs the
trace only in teleological mode.

- **Zero-cost-when-off:** ✔ Perfect — casual is `run`, which is already tap-free (§1–2).
- **API ergonomics (MCP):** The discovery tool must decide _up front_ whether the
  caller will want `why`. If it guesses casual and the caller later asks `why`, there is
  no trace to answer from — error, or silent no-provenance.
- **Soundness:** N/A (no re-execution).
- **Memory:** Casual retains nothing (no trace). Teleological retains the trace as today.

### (b) Casual-by-default + on-demand re-run-traced (uses replay for soundness)

Default to casual. Capture the effect-log on every casual run, stash it (+ source +
version + dirname/imports) under the handle id instead of a trace. When `why/where/how/
dag` is first called for a handle, **re-run the same source with a trace attached and
the stashed effect-log bound** (`effectLog`) — the re-run replays all effects (zero
external hits, §4), reproduces the value + graph, and answers from the fresh trace.
Cache the re-run's trace on the handle so repeated `why` calls are free.

- **Zero-cost-when-off:** ✔ The hot path (running) never traces. Only callers who
  actually ask `why` pay — and they pay a pure, external-call-free re-execution.
- **API ergonomics (MCP):** Best. The MCP surface is unchanged — `(require/eval …)`
  returns a handle; `why` triggers the traced re-run transparently. The caller never
  chooses a mode. Provenance is genuinely on-demand.
- **Soundness:** ✔ Sound _iff_ effect-log capture is complete (all four effect kinds).
  Reproduces the same value (effects pinned) and the same provenance graph (replay marks
  identical points, `project.ts:373-374`). Pure folds are deterministic; ADR-025's
  purity invariant is the warrant.
- **Memory:** Casual run retains only the effect-log (small — one entry per _external_
  effect, not per reduction) + source/version metadata. The full trace materializes only
  for handles whose `why` was asked, and only then. Strictly less memory than today for
  the common (never-interrogated) handle.
- **Cost asymmetry:** `why` now pays a full re-execution (pure, but real CPU — re-folds
  the program). For typical inhuman programs (a handful of infers over modest data) this
  is milliseconds. For a 46k-deep TCO loop it is the same CPU as the original run. This
  is the one real tradeoff: it moves cost from _every run_ to _interrogated runs_, which
  is the correct direction (interrogation is rare).

### (c) Hybrid — cheap always-on skeleton + opt-in full trace

Always attach a _stripped_ tap that records only the structural skeleton (output node +
external-effect bindings + effect-log) but skips per-reduction `Invocation` allocation,
the MobX action, and provenance computation. Full `why/how` upgrades by re-running
traced (as in (b)) seeded from the skeleton.

- **Zero-cost-when-off:** ✗ Not truly zero — still pays a per-reduction guard + some
  bookkeeping. The whole point (§1) is that the _only_ zero is "no tap at all."
- **Verdict:** Strictly dominated. The skeleton it wants (effect-log + output node) is
  exactly what (b) captures _off the effect membrane, not the per-reduction tap_ — so
  (b) gets the skeleton at zero per-step cost. (c) reintroduces per-step cost for no
  gain.

---

## 6. Recommendation

**Adopt (b): casual-by-default with on-demand re-run-traced, built on the existing
effect-log replay.** Fall back to (a)'s explicit `runTeleological` only as the _internal
mechanism_ (b)'s `why` calls — i.e. (b) is the public posture, (a)'s traced path is the
private re-run engine.

Rationale, in the project's own terms:

- It is the **honest-middleman** of instrumentation: you pay for provenance exactly when
  you consume it, nowhere else. The common case (run for value) is mathematically free.
- It **reuses a load-bearing primitive** (the effect-log / replay membrane) instead of
  building a second instrumentation path. Replay already guarantees a re-run reproduces
  the value; provenance reproduction falls out for free (replay re-marks the same
  points). This is "reveal the relationship, don't add an abstraction."
- It is **wrong-state-impossible** for the MCP surface: there is no "I asked `why` but
  the run wasn't traced" failure mode — every handle can always answer `why`, because
  every casual run captured the (cheap) effect-log that makes the traced re-run sound.

### Naming + MCP surface

- **Public API:** keep `(require/eval …)` / `(require/call …)` as-is — they default to
  casual. **No new verb at the discovery surface.** This matches "expose intent, hide
  materialization": the caller's intent is "run this and give me the value"; tracing is
  plumbing.
- **`why` / `where` / `how` / `dag` transparently trigger the traced re-run** on first
  call for a handle, then cache. The caller cannot tell whether the trace was built
  eagerly or on demand.
- **Project methods:** `Project.run` stays the casual primitive (no rename needed — it
  already is casual). Add a thin `Project.runTeleological(source, {effectLog, …})` that
  is today's `runTraced` re-pointed to _consume a bound effect-log_ (already supported,
  `project.ts:913`). Avoid `runCasual` as a new name — `run` already occupies that
  semantic slot; minting `runCasual` would be a redundant alias. If a clearer pairing is
  wanted, rename `runTraced` → `runTeleological` (one call site: `run-isolated.ts:78`)
  and leave `run` alone. Recommended: **`run` (casual) + `runTeleological` (replay-traced)**.

### Concrete seam changes (cited)

1. **`run-isolated.ts:runBounded` (`:63`)** — split into a casual path and a re-run path.
   - Casual: call `project.run(source, { …, onEffect, onEffectResult })` with an
     `effectLogCollector` (no `EvalTrace`). Drop `new EvalTrace(traceMax())` (`:69`) from
     the hot path.
   - Stash on the handle: `{ value, outputNode: lastForm, source, dirname, imports,
versionSet: project.captureVersionSet(), effectLog: collector.log() }` instead of
     the live trace.
2. **`result-handle.ts:ResultHandle` (`:18`)** — replace the eager `trace: EvalTrace`
   field with a **lazy provenance source**: either an already-built trace (back-compat /
   teleological) or the re-run recipe `{ source, dirname, imports, versionSet, effectLog }`.
   Keep the non-wire-safe brand (`:20`) — the choke is unchanged.
3. **`discovery-backing.ts` (`:61-72`)** — `whyOf/whereOf/howOf/dagOf` gain a step:
   if the handle has no trace yet, call `project.runTeleological(recipe.source, {
trace: new EvalTrace(traceMax()), effectLog: recipe.effectLog, dirname, imports, … })`,
   memoize the resulting trace onto the handle, then project as today.
4. **`project.ts` resolver dedup (`:922` vs `:348`)** — fold `runTraced`'s `inferAndWait`
   into `run`'s trace-guarded version (`if (inv && opts.trace)`, `:388`). `runTraced`'s
   variant is byte-identical except it drops the `opts.trace` guard; once `run` carries
   the guard, `runTraced` can call through `run`'s resolver. Removes ~40 duplicated lines.
5. **(optional) `evaluator.ts:2557` / `:2469`** — the `onSymbolResolved` optional-chains
   are already no-ops when off; no change required. Listed only to confirm nothing else
   leaks cost.

---

## 7. Risks

| #   | Risk                                                                                                                                                                               | Mitigation                                                                                                                                                                                                                                                                                                                                 |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R1  | **Effect-log incompleteness** — a non-deterministic input not captured (clock, RNG, an untracked host capability) makes the re-run diverge from the original value/graph.          | Audit: the four membrane seams (infer/http/sql/mcp) are the _entire_ contact with non-determinism per `effect-log.ts:1-15` + ADR-025 purity invariant. Add a test that a casual run + traced re-run produce byte-identical values across all four kinds. Any new host capability MUST cross the effect membrane (already the design rule). |
| R2  | **Re-run cost on interrogation** — `why` on a huge run re-folds the whole program.                                                                                                 | Acceptable by design (cost moves to the rare path). Cap re-run with the same `budgetMs`/`traceMax` as the original (`run-isolated.ts:37,72`). If the original hit the trace cap, the re-run hits it identically (deterministic) ⇒ same partial trace, same `why` answer as eager would have given.                                         |
| R3  | **Timeout/partial runs** — the original casual run may have timed out (`run-isolated.ts:107`). Re-running with the effect-log replays settled effects but the program still loops. | The effect-log pins settled effects; the pure loop re-executes to the same point under the same budget ⇒ same partial trace. The timeout marker (`timeoutValue`, `:57`) is reconstructable. Verify partial-trace parity in the test matrix.                                                                                                |
| R4  | **Source/version drift** — between casual run and `why`, the project's files change, so the re-run reads different code.                                                           | Pin `versionSet` (`project.captureVersionSet`, `project.ts:225`) on the handle and bind it to the re-run loader (the same pinning a hypothesis replay uses). The re-run sees the exact bytes the original saw.                                                                                                                             |
| R5  | **Effect-log retention vs. trace retention** — we trade trace memory for effect-log memory.                                                                                        | The effect-log is O(external effects), the trace is O(reductions) — strictly smaller for any non-trivial program. Net memory win. The session handle store (`discovery-backing.ts:35`) already needs an eviction policy regardless; unchanged.                                                                                             |
| R6  | **MobX action removal temptation** — one might think "just drop the action from `enter`."                                                                                          | Out of scope and unsafe: the action exists for the studio's live `TraceGraph` reaction (`trace.ts:40-44`). The teleological path keeps it. Casual simply never builds a trace, so the action never runs — the right fix.                                                                                                                   |

## 8. Test matrix

| Test                            | Mode(s)                                      | Asserts                                                                                |
| ------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------- |
| T1 value parity                 | casual vs teleological-fresh                 | same JS value for a pure program                                                       |
| T2 replay value parity          | casual+log → traced re-run (effectLog bound) | byte-identical value across infer/http/sql/mcp                                         |
| T3 provenance parity            | eager-trace vs re-run-trace                  | `whyOf/whereOf/howOf/dagOf` identical outputs                                          |
| T4 zero external hits on re-run | re-run with full log                         | infer/http/sql/mcp resolvers fire 0 times (assert via `onEffect` count / mock backend) |
| T5 zero-cost-when-off           | casual run, instrumented evaluator           | `EvalTrace.enter` never called; 0 `Invocation` allocations (spy/heap)                  |
| T6 partial/timeout parity       | casual timeout → re-run                      | same partial trace, same `why` answer, same `timeoutValue` shape                       |
| T7 version pinning              | casual run, mutate file, then `why`          | re-run reads pinned bytes, not latest (R4)                                             |
| T8 handle memoization           | two `why` calls on one handle                | second call builds no new trace                                                        |
| T9 unknown-handle door          | `why` on evicted/never-minted id             | same error as today (`discovery-backing.ts:45`)                                        |
| T10 resolver dedup              | run + runTeleological share `inferAndWait`   | identical record/replay behavior pre/post §6.4 refactor                                |

These belong in `arrival-chain/src/__tests__/` (verdicts) except T2/T3 which, if they
drive a live mock backend, may warrant `__research__/` per the test-org rule.

---

## Appendix — one-paragraph summary

`Project.run` is _already_ the zero-cost casual path: the evaluator's tap is guarded by
`if (tap && …)` (`evaluator.ts:2481`), so with no trace there is no `Invocation`, no MobX
action, no provenance compute. The only reason `runTraced` is forced today is that the
MCP discovery plane requests `why` **out-of-band**, after the value is returned, and needs
a retained trace to answer. The effect-log/replay membrane (`effect-log.ts`, ADR-025)
makes a run a pure function of its captured effects — so we can run casual-by-default,
capture the cheap effect-log, and **re-run with a trace on demand** when (and only when)
`why/where/how/dag` is called. Same value, same graph, zero external hits on the re-run,
zero tracing cost on every run that is never interrogated.
