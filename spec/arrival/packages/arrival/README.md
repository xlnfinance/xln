# @inhuman.tools/arrival

Sandboxed R7RS-subset Scheme for LLM agents. `exec` runs a string and returns
plain JS — transparent provenance, a capability sandbox, a JS membrane.

## Who this is for

You are building an LLM-agent system and you want the agent to _compute_ — filter, map, compose,
pipe one tool's result straight into the next — inside a sandboxed symbolic REPL, instead of
emitting a stream of opaque JSON tool calls. arrival gives the model an R7RS Scheme REPL with a
typed capability surface, a JS interop membrane, and value-level provenance. Pass
`staticValidation: "on"` to report every error before anything runs (the default is `"off"`). If
you'd rather the agent's reasoning and its executable program be the _same artifact_ than
translate English-reasoning into a tool-call, this is for you.

## Quick Start

```bash
npm install @inhuman.tools/arrival
```

```typescript
import { exec } from "@inhuman.tools/arrival";

// One plain JS value per top-level form; the base assembles lazily on first call.
const [result] = await exec(`(filter (lambda (x) (> x 5)) (list 1 3 7 9 2))`);
console.log(result); // [7, 9]
```

`BASE_ROSTER` (R7RS/SRFI/polyglot) is always assembled; user `capabilities` add to it.

## Tools — a typed capability in five lines

A tool is a declared symbol on an `EnvCapability`: a name, a doc line, a typed contract, an
implementation. `exec` always assembles `BASE_ROSTER` and then the caller's `capabilities`, and
returns plain JS values — one per top-level form.

```typescript
import { exec, EnvCapability } from "@inhuman.tools/arrival";

const weather = EnvCapability.define("demo/weather", {
  symbols: (symbol, z) => ({
    "forecast-for": symbol.rosetta`forecast-for: the current forecast for a city`(
      { input: [z.string], output: [z.string], provenance: "source" },
      async (city) => `cloudy in ${city}`, // any real fetch goes here
    ),
  }),
});

const [line] = await exec(`(string-append "today: " (forecast-for "berlin"))`, { capabilities: [weather] });
// "today: cloudy in berlin"
```

The contract is enforced at the boundary in both directions. `provenance: "source"` declares the
lineage role: this verb introduces external data, so its results mint a fresh origin (a pure
transform declares `"pipe"` and forwards its inputs' lineage; `"source"` is the default). Writing
your own capabilities — the contract discipline, the lineage/cache axes, resources —
is [`docs/writing-capabilities.md`](./docs/writing-capabilities.md).

## Data — a declared, typed program parameter

Data enters as a **declared, typed parameter of the program**. `define/overridable` names it,
gives it an `s/*` type and a default; the host supplies the value through the `overridable`
capability's shared config bag, validated against the declared type at the membrane.

```typescript
import { exec } from "@inhuman.tools/arrival";
import { overridableCapability } from "@inhuman.tools/arrival/capabilities/overridable";

const users = [
  { id: "alice", priority: 15 },
  { id: "bob", priority: 5 },
];

const [, highPriority] = await exec(
  `(define/overridable users
     (s/array (s/object (s/field/string "id") (s/field/number "priority")))
     '())
   (filter (lambda (u) (> (@ u :priority) 10)) users)`,
  { capabilities: [overridableCapability], config: { params: { users } } },
);
// [{ id: "alice", priority: 15 }]
```

Omit `config` (or pass `config: { params: {} }`) and the program runs on its declared defaults —
it stays self-describing. A value that doesn't match the declared type is rejected with a door
naming the binding, the expected shape, and who supplied it.

## Sessions — mint a scope, reuse it

Multi-turn agent sessions need no framework and no hidden layer: mint a scope, reuse it, and
top-level `define`s accumulate across calls.

```typescript
import { execState, toJS, LexicalScope } from "@inhuman.tools/arrival";

const scope = LexicalScope.fresh("agent-session"); // the session's mutable frame
await execState(`(define (sq x) (* x x))`, { scope }); // turn 1 — defines land on the scope
const {
  values: [v],
} = await execState(`(sq 7)`, { scope }); // turn 2 — sees turn 1's define
toJS(v); // 49
```

The run model — hermetic per-run state, budgets observed live, and the session/scope surface — is
in [`docs/execution.md`](./docs/execution.md).

## The language

Honest, faithful R7RS — a subset by subtraction (no IO, no dynamics, no mutation), not a lookalike.
The reference suite is chibi-scheme's `r7rs-tests.scm`, run against arrival form-by-form
(`src/__tests__/scheme-compliance/conformance/`); a documented gap is an `it.fails` that flips
loudly the day it's fixed, never a silent skip. Coverage:
[`docs/reference/r7rs-coverage.md`](./docs/reference/r7rs-coverage.md) and
[`docs/reference/srfi-coverage.md`](./docs/reference/srfi-coverage.md).

The subset is deep where it counts: **proper tail calls** via a flat trampoline
(Ganz–Friedman–Wand), **multiple values** inside the runtime (user-facing binders doored by design
— free multi-return packaging is the weak form of continuation arity, and a value's identity is a
single construction site), the **full R7RS exception tower**, an **exact numeric tower**
(safe-integer `AExact` — num/denom are JS safe integers; arithmetic that overflows
throws; host `bigint` is not a Scheme number — `(+ (/ 1 3) (/ 2 3))` is exactly `1`),
**datum labels**. Twelve SRFIs
assemble by default (1, 2, 8, 13, 26, 28, 43, 95, 128, 151, 189, 235 — `src/env/srfi/`); the
deliberately-absent ones (hash tables, random, time/date, …) are doored stubs naming why they're
out and what to use instead — exactly the symbols an LLM agent predictably reaches for.

The language stance — an R7RS-small sandboxed base, a forgiving superset layered _under_ strict
(never beside it), the reserved-zone rule keeping it non-conflicting with any SRFI — is the charter;
do not add a reader macro, literal, or borrowing that conflicts with that rule.

**Writing programs (agents / LLMs):** system prompt =
[`docs/llm-agent-card.md`](./docs/llm-agent-card.md) (minimal, custdev-measured). Human inventory
and preferred-vs-compat map: [`docs/llm-language-guide.md`](./docs/llm-language-guide.md).

## Membrane, provenance, uneval, seal

JS ↔ Scheme interop is a recursive wrapper membrane: every value crosses faithfully or is refused
with a teaching door. Lambdas, objects, and arrays cross by identity; a bare Promise is refused; no
ambient `console`, `process`, or `require`. A real effect is a recorded crossing. Known 0.x escapes
are bugs against that invariant ([Security Status](#security-status)).

Provenance is a second interpretation of the same program. Pass `tap: new EvalTrace()` to observe
lineage; without a tap every value's provenance reads `[]`. A crossing stamps the value, a container
threads the stamp, and a collapsing op unions origins. Each declared symbol carries a provenance
role (`source` / `pipe` / `fan` / `sink` / `transparent` / `loop` / `opaque`).
[`docs/PROVENANCE.md`](./docs/PROVENANCE.md).

```typescript
import { execState, deepProvenance, EnvCapability } from "@inhuman.tools/arrival";
import { EvalTrace } from "@inhuman.tools/arrival/provenance";

const weather = EnvCapability.define("demo/weather", {
  symbols: (symbol, z) => ({
    "forecast-for": symbol.rosetta`forecast-for: the current forecast for a city`(
      { input: [z.string], output: [z.string], provenance: "source" },
      async (city) => `cloudy in ${city}`,
    ),
  }),
});

const trace = new EvalTrace();
const {
  values: [line],
} = await execState(`(string-append "today: " (forecast-for "berlin"))`, { capabilities: [weather], tap: trace });

[...deepProvenance(line)]; // [1] — the value confesses which crossing it descends from
trace.toolNameFor(1); // "forecast-for"
```

`buildUneval` reverse-slices a traced run into a minimal re-runnable program that re-derives a
chosen value. It lives in `@inhuman.tools/arrival-provenance`. That
package also owns `groundingVerdict` and the `whyOf` / `whereOf` / `howOf` queries; this package
keeps the capture spine (`EvalTrace`, stamping) and `deepProvenance`. The `/attestation` subpath
brands values so provenance unions forward while attestation _drops on compute_.

```typescript
import { execState, EnvCapability } from "@inhuman.tools/arrival";
import { EvalTrace } from "@inhuman.tools/arrival/provenance";
import { buildUneval } from "@inhuman.tools/arrival-provenance/analysis";

const scanner = EnvCapability.define("demo/scanner", {
  symbols: (symbol, z) => ({
    "chatter-feed": symbol.rosetta`chatter-feed: unused chatter`(
      { input: [], output: [z.string], provenance: "source" },
      async () => "noise",
    ),
    "scan-output": symbol.rosetta`scan-output: a scan result`(
      { input: [], output: [z.string], provenance: "source" },
      async () => "evil.exe",
    ),
  }),
});

const t = new EvalTrace();
const src = `
  (define chatter (string-append (chatter-feed) "!"))
  (define verdict (string-append "malware: " (scan-output)))
  (list verdict "benign")
`;
const state = await execState(src, { capabilities: [scanner], tap: t });

const run = buildUneval({ scope: state.scope, result: state.values.at(-1), trace: t, source: src, forms: [] });
const head = await run.uneval("(car result)");

head.value; // "malware: evil.exe"
head.provenance; // descends from scan-output; chatter-feed never touched it
head.program; // (define verdict (string-append "malware: " (scan-output)))
// (let ((result (list verdict "benign"))) (car result))
```

A seal walks every leaf and refuses to sign one that does not trace to a real source. It is a
lineage-completeness oracle, not a truth oracle — a lying tool's answer traces perfectly. Replay
answers every crossing from the recorded payload stream and never re-invokes a source; evict the
cache and a fresh live run may diverge.

## Polyglot by observation, not by design

**The dialect roster is reverse-engineered from LLM latent space, not designed.** It is a
measurement of what models trained on all of Lisp believe Scheme is, turned into a surface: agent
sessions are recorded, and every _phantom_ (a verb the model confidently reached for that didn't
exist) is a logged feature request. It is still R7RS Scheme — only the behaviors undefined by spec
are enriched (PRINCIPLES P13).

```scheme
(->> {:versions (list {:state "draft"} {:state "live"})} :versions last :state)  ; "live"
(map (lambda (x) (* x x)) [1 2 3])                                               ; #(1 4 9)
(mapcar car (list (list 1) (list 2)))                                            ; (1 2)
```

Four dialect packs carry this (`src/env/polyglot/`): Clojure, Racket, Common Lisp, and the
shared core — `{:key value …}` dicts, `[ … ]` vectors, the `(:key obj)` accessor, the `@` / `@?` /
`@keys` member-read protocol. All of it canonicalizes at read time; the verbs that _can't_ carry
over honestly (`setf`, `loop`, …) aren't absent — they're doored, with the reason and the working
alternative.

## IO taken away — to come back with lineage

No ports, no filesystem, no clock, no `random`. Not as a security posture — as an _algebraic_ one:
an ambient read has no construction site to root a value's lineage at, so admitting it would hole
the one guarantee the language makes. Effects come back in as capability verbs that mint provenance
at the membrane — a filesystem read is a recorded crossing that stamps its result, not a stream from
nowhere.

## Errors are doors, not walls

Every deliberate omission names the fact, the reason, and the exact alternative bound in _this_
environment. The same discipline runs _before_ execution when you opt in: the default is
`staticValidation: "off"`; pass `"on"` to check the whole program against the assembled vocabulary
and report **every** problem at once, eslint-style:

```
Static validation found 1 error — nothing was evaluated:
  • Unbound symbol `forecst-for` — did you mean `forecast-for`? Referenced at 1:19 — this
    program would crash there.
```

For an agent this compounds into **zero-round-trip self-repair**: every diagnostic arrives at once,
each carrying its alternative, so the crash-read-guess-crash loop collapses into one informed
retry. One scope limit: the pass cannot see the bindings a `(require …)` spills at runtime, so
consumers skip the pass for such programs (the runtime doors remain the backstop).

## API surface

**Execution**

- `exec(code, options?) → Promise<unknown[]>` — parse + run, results unwrapped to plain JS.
- `execState(code, options?) → Promise<ExecState>` — boxed, provenance-bearing `values` plus the
  session `scope` handle for REPL-style continuation, and the run's `runCtx`.
- `ExecOptions`: `capabilities` (added to `BASE_ROSTER` per call), `config` (the shared bag
  capabilities read — also where `define/overridable` parameter values ride, alongside the
  `overridable` capability), `scope` (a `LexicalScope`; `.fresh()` mints an isolated session),
  `runCtx` (reuse an existing `RunContext` for REPL continuity), `staticValidation: "on" | "off"`
  (default `"off"`), `signal`, `budgetMs` (opt-in wall-clock bound; `signal` is the one that
  reaches into native calls), `strict` (turns off nil-tolerance,
  caller-scoped), `tap` (trace recording).
- `parse(code)` — the reader, standalone (`tokenize` lives on `/lsp-internals`).

**Declaration**

- `EnvCapability`, the `symbol` factory namespace (`symbol.native`, `symbol.rosetta`,
  `symbol.define`, `symbol.defineSyntax`, `symbol.tagless`, `symbol.notImplemented`, …), and the `z`
  scheme-zod codec namespace (`z.string`, `z.number`, `z.dynamic`, `z.schemeValue`, `z.box`,
  `z.procedure(in?, out?)`, …). Every capability — the R7RS base, each SRFI, each dialect pack,
  your tools — is an `EnvCapability`; `exec`/`execState` C3-linearize the capability set's
  dependency DAG (the same monotonic linearization Python uses for MRO) into a self-hosted,
  memoized `Vocabulary`, dedup by identity, detect cycles; a capability's resources wind down LIFO
  when the run disposes.

**Static analysis & provenance**

- `validateProgram` / `vocabularyFromChain` (from `/lsp-internals`) — the complete-diagnostic-list
  validation pass.
- `forwardCone`, `backwardCone` (from `@inhuman.tools/arrival-provenance/analysis`) — the traced
  lineage cone; `deepProvenance` (from this package) — the deep provenance read; `toJS` —
  the boxed→plain exit read.
- `EvalTrace` (from `/provenance`) — the traced-run recorder (capture spine lives in core);
  `trace.toolNameFor(id)` / `trace.invocationById(id)` resolve a `deepProvenance` ordinal to the
  verb / invocation that minted it.
- `buildUneval` (from `@inhuman.tools/arrival-provenance/analysis`) — reverse
  slicer over a finished traced run; options take `scope: state.scope` (not `env`).

**Subpath exports** — granular, tree-shaken entries (see `package.json` `exports` for the
authoritative list): `/reflect-internals`, `/lsp-internals`, `/host-internals`, `/capability`,
`/capabilities`, `/capabilities/overridable`, `/capabilities/schema`,
`/resources`, `/emit`, `/schema-tag`, `/attestation`, `/provenance`, `/provenance/store`,
`/type-layer`. `/grammar.ebnf` is the reader eBNF (raw text, not JS). `(require …)` lives in
`@inhuman.tools/arrival-modules`.

**Decomposed processing** — for cases the three declared doors (`capabilities` / `config` /
`scope`) don't cover: the self-hosted `Vocabulary` a capability tuple builds into is memoized by
(closure identity, config identity), so `exec`/`execState` already reuse an assembled capability
base across every call sharing the same tuple, with no separate assembly step to opt into. `runCtx`
reuse (above) extends that to reusing a single run's resources across REPL turns. `LexicalScope.fresh()`
mints the session's mutable frame directly; an embedder-held frame that needs the structural env
write contract types against `SchemeEnv` (`/host-internals`).

Other packages in this repository are listed in the [repo README](../../README.md).

## Security Status

⚠️ **version 0.x — use at your own risk**

arrival's base reaches nothing ambient by construction — no filesystem, no process, no network, no
host globals (`window` / `global` / `process` / `require`). But at 0.x, sandbox escape is still
feasible — at least via property access and some rosetta-layer aspects — so do not yet treat the
isolation as a hard security boundary for untrusted input.

Bare `exec` / `execState` calls (no explicit `scope`) mint a fresh scope per call —
`scope ?? LexicalScope.fresh()` — so top-level `define`s do **not** accumulate across bare calls.
Cross-call accumulation is opt-in: pass the same `LexicalScope` (minted once via
`LexicalScope.fresh()`) on every call that should share bindings, as the Sessions section shows.
Multi-tenant hosts that want isolation get it by default; multi-turn sessions opt into a shared
scope deliberately.

**Do not**: expose to untrusted user input without additional isolation; use in security-critical
contexts; deploy without containerization; trust sandbox isolation.

Responsible disclosure and collaboration on improvements: security@here.build

## Performance

Interpretation costs roughly 10–100× native JS — worth it for isolation, compositional
expressiveness, and lineage; not worth it for CPU-bound number crunching. Register
performance-critical functions as capability verbs and keep Scheme for orchestration. arrival is
simultaneously a runtime and an IR — designed to be compilable _toward_ JavaScript — so raw speed is
the _target's_ concern and interpretation cost stays an authoring-time property, not the ceiling.

## Design foundations

- [`docs/PRINCIPLES.md`](./docs/PRINCIPLES.md) — the governing principles: the two-interpreter
  keystone, the value plane, the membrane, provenance, the surface rules.
- [`docs/PROVENANCE.md`](./docs/PROVENANCE.md) — the provenance substrate in full.
- [`docs/writing-capabilities.md`](./docs/writing-capabilities.md) — authoring your own capabilities.

## Why Scheme for AI Agents?

Scheme matches how compositional reasoning works: an agent exploring data ("find all items where
priority > threshold") thinks in filter/map/compose, and Scheme is the notation for that.
Sandboxing prevents exploration from accidentally executing actions.

### Prior art

The stance — _symbolic programming as the reasoning medium, not static tool-calling_ — is argued
independently in Jordi de la Torre, [_From Tool Calling to Symbolic Thinking: LLMs in a Persistent
Lisp Metaprogramming Loop_](https://arxiv.org/abs/2506.10021) (arXiv:2506.10021, 2025): embed Lisp
in generation, intercept it through a **middleware layer**, give the model a **persistent REPL** in
which it defines, invokes, and evolves its own tools. That paper offers _design principles_; arrival
is the built system. Its middleware layer is our membrane (`@`); its persistent REPL is the per-run
capability environment; its "evolve your own tools" is the capability DAG. Where it leaves the
environment open, arrival's base is sandboxed, no-IO, and R7RS-faithful — the boundary that makes a
self-evolving symbolic loop safe to run.

## Contributing

Early-stage and moving fast. We're interested in: **security review** (audit sandbox isolation),
**performance benchmarks**, **conformance** (grow the Chibi-suite pass set; every flipped `it.fails`
is a gift), and **doors** (find a dead-end error, turn it into a teaching door).

## License

[MIT](./LICENSE.md). ESM-only; Node >= 22.
