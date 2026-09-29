---
title: Arrival machine — architecture lineage
genre: reference
status: draft
tags: [arrival, architecture, interpreter, provenance]
created: 2026-06-14
updated: 2026-07-24
---

# Arrival machine — architecture lineage

This doc exists so no choice in the interpreter is arbitrary. Each load-bearing
decision cites a **named base** (an established, published architecture) and the
review can trace it back — the way C++, Objective-C, and C# are each a _named_
extension of a _named_ C, so "why is it this way" is always answerable by
pointing at a spec rather than at taste.

We are not novel at the base. We are novel at exactly **one** join (the wedge,
below). Everything else is faithful instantiation of work that already has a
name. Naming it is the whole point: a reviewer who knows the base spec can audit
our fidelity to it; a reviewer who doesn't can go read the citation.

## The base stack (the "C")

| Stratum                    | Named base                                                                                                                                                                                                                                                                 | Our instantiation                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The machine**            | **CEK** abstract machine (Felleisen–Friedman 1986) + **step-indexing / fuel** (Appel; "gas" in EVM)                                                                                                                                                                        | The generator trampoline (`evaluator.ts`) _is_ the CEK transition function. `RunHandle` (`arrival-run/src/run-program.ts:143`, in the sibling package `inhuman/foundations/arrival-run` — not core) is a **reified machine state** — that's why it's resumable and returned synchronously. `budgetMs` (tick-checked) is the fuel.                                                                                                                 |
| **Effects as data**        | **Interaction Trees** (Xia et al., POPL 2020) + **algebraic effects & handlers** (Plotkin–Pretnar 2013; OCaml 5 one-shot)                                                                                                                                                  | The rosetta families `mcp/*` `llm/*` `chat/*` (arrival's LLM/MCP capability plane) emit effect **requests** — the `Vis` (visible) nodes / membrane crossings. Pure reductions are the `Tau` (silent) steps. The host capability is the handler. The core never performs an effect; it _asks_.                                                                                                                                                     |
| **The persisted log**      | **Event sourcing / durable execution** (Fowler; Temporal `SideEffect`)                                                                                                                                                                                                     | `effect-log.ts` record/replay (`inhuman/foundations/arrival-effects/src/effect-log.ts` — a same-named file in core, `arrival/packages/arrival/src/run/effect-log.ts`, documents the opposite discipline: append-only, never dedupes, the "two effects, always" poison rule). Content-addressed inference (`{model+config, hash(input), version}`) is the `SideEffect` memo: a non-deterministic crossing recorded once, never re-fired on replay. |
| **Incremental re-reading** | **Build Systems à la Carte** (Mokhov–Mitchell–Peyton Jones, ICFP 2018 / JFP 2020): constructive traces, minimality, early cutoff, dynamic deps + **Adapton** (Hammer et al., PLDI 2014): demand-driven self-adjusting computation (`miniAdapton` = a Scheme instantiation) | The effect-log _is_ the constructive trace. Re-run = replay the pure core (free, referentially transparent) + replay the recorded crossings. Same key ⇒ same Promise ⇒ early cutoff for free.                                                                                                                                                                                                                                                     |
| **Backward re-reading**    | **how/why/where-provenance** (Green–Karvounarakis–Tannen, PODS 2007; Buneman et al. for why/where) + **dynamic program slicing** (Weiser 1981; Agrawal–Horgan 1990)                                                                                                        | The per-invocation `Set<call-id>` is the provenance carrier — exact, recorded, not substring-derived. `whyOf`/`whereOf`/`howOf`/`dagOf` (`arrival/packages/arrival-provenance/src/reflect/handle-provenance.ts`) are projections of one `buildSlice` over the trace.                                                                                                                                                                              |

## The delta (the "C++"): Arrival — one log, three readings

In the literature each reading owns a **separate system** with a **separate log**:
a build tool's trace ≠ an event-sourcing journal ≠ a provenance database. Our
single departure is to **collapse all three onto one append-only effect-log** over
a pure, fuel-bounded Scheme core:

- **Forward** — replay inputs → output. Deterministic durable execution.
- **Backward** — from an output, reason to its evidence and its purpose. Provenance + slice.
- **Incremental** — diff the trace, recompute only the minimal residual. À-la-carte / Adapton.

The collapse is **sound** because the core is referentially transparent: the only
things in the log are membrane crossings, so re-running the pure remainder costs
nothing and can never disagree with itself. One log carries all three meanings
because the meaning is _in the trace_, not in three bookkeeping layers.

```ts
readonly value: unknown;                                                  // causal — eager, always present
async teleological(signal?: AbortSignal): Promise<{ trace, outputNode }>  // teleological — lazy, memoized once
```

- **causal** — forward: inputs → value, eager. The replay reading.
- **teleological** — backward: from the end (the output) to its purpose/evidence, built lazily on first ask and memoized thereafter. _Teleological_ literally = explained-by-its-end. The provenance reading, pre-warmed once asked.
- **incremental** — the third reading: the same trace diffed against current state.

Reading direction changes **cost**, never **value**.

## Citation table — code choice → named base → the review test

Each row is a falsifiable fidelity claim. If the property fails, we've drifted from the base.

| Code choice                                                                                                                         | Named base                                  | Faithfulness property (what review/tests check)                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RunHandle implements PromiseLike` returned synchronously (`arrival-run/src/run-program.ts:143`, `inhuman/foundations/arrival-run`) | CEK reified machine-state                   | The handle _is_ a suspended machine; `await` resumes it; a second `await` yields the same value (idempotent resume).                                                                            |
| `budgetMs` tick (`evaluator.ts`)                                                                                                    | step-indexing / fuel                        | An unbounded _interpretive_ loop is **contained**, not hung. A single native collection walk is not interrupted — `signal` is the bound that reaches into native calls. (`run-crasher.test.ts`) |
| `mcp/`/`llm/`/`chat/` rosettas, `withContext`                                                                                       | Interaction Trees `Vis` + algebraic handler | The core emits a request; the host is the handler. No effect runs without crossing the membrane.                                                                                                |
| `effect-log.ts` record/replay (`arrival-effects`'s file — not core's same-named one)                                                | event sourcing / Temporal `SideEffect`      | Replaying the log reproduces the value bit-identically; non-deterministic crossings are memoized, not re-fired.                                                                                 |
| content-addressed inference                                                                                                         | à-la-carte early-cutoff + durable memo      | Same key ⇒ same Promise (cross-invocation, cross-user dedup); the trace is the constructive trace.                                                                                              |
| `Set<call-id>` per invocation                                                                                                       | how/why-provenance semiring (Green–Tannen)  | The dataflow graph is **exact** (recorded), not derived by substring tricks.                                                                                                                    |
| `whyOf`/`whereOf`/`howOf` over `buildSlice` (`arrival-provenance/src/reflect/handle-provenance.ts`)                                 | why/where-provenance + dynamic slicing      | `how` returns a **runnable** re-derivation slice; running it reproduces the output (re-derivable provenance).                                                                                   |
| `ResultHandle.value` (eager) / `.teleological()` (lazy, memoized) (`arrival-provenance/src/reflect/result-handle.ts`)               | the two directional readings of one trace   | Same trace; `teleological()` pre-warms backward on first ask, causal `value` stays forward-eager. Direction changes cost, never value.                                                          |

## Cross-references

- ADR-019 — trace-protocol-is-the-open-core-boundary (the log _is_ the boundary)
- ADR-025 — resumable-pause-is-a-pending-membrane-penetration (`approve!` ≅ a `chat`/`mcp` human-in-the-loop crossing — a high-latency `Vis` node)
- ADR-IN-026 — git-is-the-deploy (membrane-resolver swap; replay over a frozen pure core)
