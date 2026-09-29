# Strata — the bottom-up dependency-order registry

> This is the intended dependency order — not crossing mechanics (those live per-subsystem,
> see the pointer at the bottom). Without it, wall-crispness has to be judged against
> topology _measured_ from imports.

Method: every claim below was checked by grepping actual `import`/`export … from` edges
between `src/` top-level directories (and, inside `common/`, its two knot sub-packages) —
not by trusting header comments. Re-verify with the same method before editing this file;
a stale stratum map is exactly the failure this document exists to close.

## 1. Leaves

- **`errors.ts`** — the error root, type-only leaf. `ErrorClass` taxonomy, no imports out of
  the leaf tier.
- **`well-known/`** — `Symbol.for` registry (`DATA`, `LOCATION`, `INTEROP_BOUNDARY`, …). Zero imports.
- **`types/`** — type-only TypeScript plumbing (`MaybePromise`, `IsAny`). Zero imports.
  Distinct from `utils/` (runtime: `maybeThen`). Importable from anywhere, including the knot.

All three are importable from anywhere without creating a stratum violation, by construction.

## 2. THE KNOT — the two-interpreter core (closed member list)

```
values ⇄ eval ⇄ membrane ⇄ run ⇄ common/symbols ⇄ common/scheme-zod ⇄ env ⇄ provenance
```

Eight buckets, one SCC. **Closed member list — a directory joins this list only by a
ruling recorded here, never by accretion.** Current members:

| Bucket            | Source                   |
| ----------------- | ------------------------ |
| values            | `src/values/`            |
| eval              | `src/eval/`              |
| membrane          | `src/membrane/`          |
| run               | `src/run/`               |
| common/symbols    | `src/common/symbols/`    |
| common/scheme-zod | `src/common/scheme-zod/` |
| env               | `src/env/`               |
| provenance        | `src/provenance/`        |

**Why it is real, not emergent-by-accident:** tagless-final (`PRINCIPLES.md` P0/P7) means a
value class implements both interpreters' terms in one place, so `values` must see `eval`
(dispatch) and `membrane` (crossing) at the type level, and every other bucket closes the
same loop for its own reason — `env` stores values, `run` carries the channels values are
minted against, `provenance` collapses/wire-emits over value structure, `common/symbols`
bakes contracts that constrain values _and_ membrane slots, `common/scheme-zod` codecs
decode straight into `CallCtx` (`run`) and `InvocationLike` (`membrane`). Big is fine here;
what would not be fine is leaving it undeclared — which is what S6 flagged.

**Verified edges** (one concrete citation per direction; the audit's full grep is not
reproduced here — the point is that every pair below is checked, not narrated):

- `values → eval`: `values/primitives/ACallable.ts` — `import { withDynamicCallSite } from "../../eval/dynamic-call-site.js"`
  (NOT `is_promise` — that edge is gone: P3 already landed on `main`, `values/values-repr.ts`
  now imports `is_promise` from the sibling `values/value-guards.js`, and `eval/guards.ts`
  re-exports it from there for compatibility. `values → eval` still holds on this edge.)
- `eval → values`: `eval/evaluator.ts` — `import { theVoid } from "../values/primitives/AVoid.js"`
- `values → membrane`: `values/types.ts` — `import type { AJSArray } from "../membrane/AJSArray.js"`
- `membrane → values`: `membrane/AJSArray.ts` — `import { attestDeep, freshIfSingleton, isAttested } from "../values/attestation.js"`
- `values → run`: `values/values-repr.ts` — `import { CONSTANT_CTX, type RunContext } from "../run/RunContext.js"`
- `run → membrane`: `run/CallCtx.ts` — `import { type InvocationLike } from "../membrane/rosetta.js"` (type-only — see the RULES below)
- `env → common/symbols`: `env/vocabulary.ts` — `import { bindCapabilityDefines } from "../common/symbols/define-bake.js"`
- `common/symbols → env`: `common/symbols/value.ts` — `import type { AmbientValue } from "../../env/AmbientRuntime.js"`
- `common/scheme-zod → membrane`: `common/scheme-zod/index.ts` — `import type { InvocationLike } from "../../membrane/rosetta.js"`
- `run → common/scheme-zod`: none directly (`common/symbols/_bake.ts`'s own header notes
  `CallCtx`/`makeCallCtx` are imported from `run/CallCtx.ts` directly rather than housed in
  `_bake` _because_ `_bake` imports `scheme-zod`, and `scheme-zod` imports `ACallable` back —
  closing the cycle through `common/scheme-zod` would TDZ a `z.instanceof` capture). The
  member still belongs in the knot: it is pulled in by `common/symbols ⇄ common/scheme-zod`
  (both directions, both packages under `common/`) plus `common/scheme-zod → membrane/values`.
- `env → membrane`: `env/AmbientRuntime.ts` — `import { isSchemeValue } from "../membrane/membrane.js"`
- `membrane → env`: `membrane/membrane.ts` — `import { AmbientRuntime, isAmbientRuntime } from "../env/AmbientRuntime.js"` (see D4 below for _why_)
- `env → provenance`: `env/srfi/srfi-28.ts` (and `srfi-13.ts`, `polyglot/polyglot.ts`) — `import { collapseProvenance, taintString } from "../../provenance/provenance-collapse.js"`
- `provenance → env`: `provenance/hermetic-env.ts` — `import { isAmbientRuntime, type AmbientValue } from "../env/AmbientRuntime.js"`
- `values → provenance`: `values/primitives/APair.ts` — `import { collapseProvenance } from "../../provenance/provenance-collapse.js"`
- `provenance → values`: `provenance/gamma.ts` — `import type { SchemeValue } from "../values/types.js"`
- `common/symbols → provenance`: `common/symbols/define-bake.ts` — `import { freeVars } from "../../provenance/wireframe/free-vars.js"`
- `eval → common/scheme-zod`: `eval/generator-exec.ts` — `import type { output as ZodOutputOf, ZodType } from "../common/scheme-zod/index.js"`

**Practiced direction inside the knot, for the `run` stratum specifically** (not a hard
wall, a norm the audit measured): `run/` (base) ← `membrane`/`common/symbols` ← `eval` ←
`env`.

## 3. One-directional layers above the knot

Everything else in `src/` depends on the knot (directly or transitively) and is never
depended on BY the knot:

`reader`, `symbol`, `emit`, `static-validation`, `oracle`, `type-layer`, `loader`,
`capabilities`, `utils`, `lsp-internals`, `host-internals`, `reflect-internals`, `index.ts`.

**Named individual leak edges** — a one-directional layer having ONE upward edge that
shouldn't exist is a placement bug (Wave B of the audit), not a knot-membership question;
tracked here so this map stays the single place a reader checks "is this layer really
clean":

- **reader** — **P4 is fixed on `main`**: `reader/extract-defines.ts` now imports `parse`
  directly from the sibling `reader/parse.ts`, closing the gratuitous round trip through
  `eval/generator-exec.ts` that used to make reader non-leaf. The LEGITIMATE `eval → reader`
  edge (e.g. `generator-exec.ts` parsing program text) is the knot depending on a leaf,
  which remains fine and unaffected by this fix.
- **static-validation** — mutual with `eval` BY DESIGN, not a leak: `static-validation/vocabulary.ts`
  type-imports `eval/CompiledResolutionChain.ts` and value-imports `eval/Macro.ts`; `eval/exec-phases.ts`
  and `eval/generator-exec.ts` import `validateProgram`/`vocabularyFromChain`/`StaticValidationError`
  back. Declared at `static-validation/validate-program.ts`'s header (D6, see below) — the
  validator judges the sealed chain the evaluator produces, and the evaluator calls it at
  parse phase before the first form evaluates. This is a _declared_ two-file mutual, not a
  second knot.
- **utils** — **P5 is fixed on `main`**: `utils/typecheck.ts` moved to `membrane/typecheck.ts`
  (its own edge dissolves — it's inside the knot now, not a leak from above it), and
  `utils/promises.ts` now imports `is_promise` from `values/value-guards.ts` (post-P3), not
  `eval/guards.ts` — its own header states the constraint by name: "moving it into eval/ …
  would reintroduce exactly the values→eval edge P3 closed." `utils/` is now `promises.ts`
  only, genuinely leaf.

## 4. Rules

1. **New directories may depend ON the knot; they may never join it.** Joining the knot
   means adding a NEW closed-loop member — that is a ruling on this document, not a side
   effect of an import.
2. **Type-only upward imports are sanctioned when declared in the importing file's header.**
   This legitimizes the one case load-bearing enough to name: `run/CallCtx.ts:8` —
   `import { type InvocationLike } from "../membrane/rosetta.js"` — a type-only reach from
   `run` into `membrane` so `CallCtx.invocation` can be typed without a value import (audit
   P7). Both buckets are already knot members, so this is a within-knot type import, not an
   escape from the knot upward — cited here because P7 asked for the sanction to be stated
   ONCE rather than re-litigated per occurrence.
3. **`CONSTANT_CTX` (`run/RunContext.ts`) is the sanctioned any-stratum ctx import.** It is
   the one `RunContext` value that carries no run-state (§CTX-SPECIES, `execution.md` §2)
   and is therefore safe to import from a leaf that needs _some_ ctx to satisfy a signature
   with no live run behind it (audit P8's example: `reader/specials.ts:8`). A file reaching
   for `CONSTANT_CTX` is not thereby joining the knot — it is consuming the one constant the
   knot exports for exactly this purpose.

## 5. Declared exceptions, with charters

**`env ⇄ provenance` mutual — the model for a _declared_ big exception** (audit §8: "copy
this shape"). Both directions carry their own charter comment, not a shared one:

- **env-side**: `env/srfi/srfi-13.ts`, `env/srfi/srfi-28.ts`, `env/polyglot/polyglot.ts`
  import `collapseProvenance`/`taintString` from `provenance/provenance-collapse.ts` — the
  file's own header states why: collapsing ops (`string-append`, `join`) fold a structure of
  inference-stamped values into one flat carrier, and without re-stamping the provenance
  graph loses the edge back to every folded member (see `provenance-collapse.ts`'s header
  for the full argument).
- **provenance-side**: `provenance/hermetic-env.ts` (the hermetic assembler for replay)
  imports `env/AmbientRuntime.ts` (`isAmbientRuntime`, `AmbientValue`) and
  `env/assemble-run.ts` (`assembleRun`); `provenance/gamma.ts` (γ = `hermeticApply`)
  imports `env/base-roster.ts` — both files' headers state the composition:
  γ-replay is "not a second env stack", it is `assembleRun`/`execState`/`LexicalScope`
  reused verbatim under region discipline (`docs/PROVENANCE.md` §4 owns the "replay" word
  for this half; `execution.md` §11 TWO-REPLAYS cross-links, does not duplicate).

**Bake↔runtime `_install*` seams** — the injected-dependency door that lets the BOTTOM of
the knot (`values/primitives/ARosettaProcedure.ts`) defer its membrane-crossing body to
`common/symbols/rosetta.ts` without a static value-import cycle at module-init time:

- `values/primitives/ARosettaProcedure.ts`'s `_installRosettaMembraneApply` — installed from
  `common/symbols/rosetta.ts`. The file's own header: a static import of scheme-zod/membrane
  here would TDZ on `ACallable`'s live `jsToScheme`/`toJS` imports.

Both are documented, single-purpose doors — not a general escape hatch. A THIRD `_install*`
door is not sanctioned by this entry; it needs its own charter.

## 6. Where crossing mechanics live

This document states dependency ORDER only. The mechanical doors, gates, and runtime twins
that enforce each individual crossing live in the subsystem doc that owns that crossing:
`execution.md` (run model, channels, CallCtx), `membrane.md` (FFI crossing, region scope),
`environments.md` (storage membrane, capability assembly, `§AXES`), `PROVENANCE.md` (the
five-subpath package wall, γ-replay), `static-plane.md` (the validator/oracle/type-layer
one-directional consumers). This file is the registry those docs' cycle notes should cite
INTO, not a replacement for any of them.
