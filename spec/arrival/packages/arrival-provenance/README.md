# @inhuman.tools/arrival-provenance

After an `@inhuman.tools/arrival` eval, this package turns a finished `EvalTrace` into a forest, graph, or slice. It **never drives the evaluator**. Core `@inhuman.tools/arrival/provenance` is capture only (`EvalTrace`, stamping at the membrane); this package re-exports that capture and owns the analysis stack — forest, statechart, region tree, flow graph, reverse-chain slicer (`buildUneval`), grounding seal.

## Install

```bash
pnpm add @inhuman.tools/arrival-provenance
```

## Usage

Hand the evaluator a tap; analysis runs on the finished trace:

```ts
import { exec } from "@inhuman.tools/arrival";
import { EvalTrace, traceToForest } from "@inhuman.tools/arrival-provenance";

const trace = new EvalTrace();
await exec(`(filter (lambda (x) (> x 5)) (list 1 3 7 9 2))`, { tap: trace });

const forest = traceToForest(trace);
```

The heavier analysis stack lives at the `./analysis` subpath:

```ts
import { traceToStatechart, buildSlice, buildUneval } from "@inhuman.tools/arrival-provenance/analysis";

const statechart = traceToStatechart(trace);
```

The surface, in four subpaths:

- **`.`** — capture + region-model primitives: `EvalTrace` (this package's export is the mobx-reactive `ObservableEvalTrace`; core stays mobx-free), `Invocation` (each carries its own computed `.provenance`; dataflow minted at boundaries), `traceToForest`, `traceToRegions` with an incremental `TraceRegionFold`. Plus `trace-snapshot` / `trace-artifact` serialization.
- **`./analysis`** — turn a finished trace into render-models: a statechart, a flow graph, forest-collapse (`collapseMDL`), and the reverse-chain slicer (`buildSlice` / `buildUneval`).
- **`./verdict`** — `groundingVerdict`, the whole-result grounding seal: a lineage-completeness oracle over a finished traced run (not a truth oracle — it signs a provably-traced fabrication from a lying tool just as readily as a fact).
- **`./reflect`** — the query layer over a finished run: `ResultHandle` (causal value now, teleological provenance on demand), `why`/`where`/`how`/`dag`/`blast` (named projections of `/analysis`), the wire-safe choke, and the `arrival/reflect` Scheme capability. Not re-exported from `.`.

## License

[MIT](./LICENSE.md)
