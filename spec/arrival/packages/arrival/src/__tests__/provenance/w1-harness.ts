/**
 * Q9 (docs/PROVENANCE.md §7 W1 agreement) — the AGREEMENT
 * HARNESS shared by `wireframe-agreement.law.test.ts`'s W1 describe block and its
 * corpus (`w1-corpus.ts`). Two independent halves:
 *
 *  1. THE EAGER ORACLE SIDE — register synthetic Rosetta-IN sources via test-local
 *     `symbol.rosetta` fixtures (deterministic fakes that return ALREADY-STAMPED
 *     values — a direct `execState` run has no live `currentInvocation` to auto-mint
 *     against; see rosetta.ts's `mintsPoint && inv` guard). Each call mints a FRESH
 *     id via a shared counter and records id→op in a registry, so the eager run's
 *     deep-collapsed provenance (numeric ids) can be projected back to the SET OF
 *     SOURCE OP NAMES that actually fired — the only vocabulary the two layers
 *     (retrospective ids vs prospective declared roles) share.
 *
 *  2. THE PROSPECTIVE SIDE — `prospectiveSourceCone` walks a built `WireframeProgram`
 *     BACKWARD from a graph's egress (`reachableNodes`, wireframe/loops.ts's V4-
 *     guarded walk) and collects every reachable `source` node's declared op name,
 *     recursing into `fan.template` / `binder.interior` / a `template-ref`'s
 *     `WireframeProgram.templates` entry — the THREE places a designated node's
 *     private subgraph lives that `reachableNodes` (scoped to ONE `WireframeGraph`)
 *     cannot see across on its own.
 *
 * SCOPE (the m3 precision trade, restated verbatim in wireframe-agreement.law.test.ts
 * and docs/PROVENANCE.md §1 A2): a mux's ARMS are ALWAYS both wired into the graph
 * structurally (every `if`/`cond` arm gets its own wire regardless of which one a
 * concrete run takes — `builder.ts`'s `buildMux`/`buildCondMux`), so
 * `prospectiveSourceCone` is UNCONDITIONALLY a "both arms" cone for any mux node it
 * reaches, PORT-COUPLED OR NOT. The two cones (eager vs prospective) therefore agree
 * EXACTLY only when every mux the egress reaches has arms that don't disagree on
 * which sources they touch (the corpus's "exact" rows are built that way on purpose:
 * a port-coupled selector plus PURE arms, or arms sharing the same outer-bound
 * sources) — this is NOT a relaxation of the law, it is the corpus honoring "do not
 * fix this by re-recording" by choosing programs where the trade is invisible, and
 * separately asserting the trade IS visible (a proper superset, not vacuously equal)
 * on the pure-mux rows where the arms deliberately diverge.
 */
import type { AmbientRuntime, ResolvingAmbient } from "../../env/AmbientRuntime.js";
import { execStateOverFrame } from "../../eval/generator-exec.js";
import { collapseProvenance } from "../../provenance/provenance-collapse.js";
import { AString } from "../../values/primitives/AString.js";
import { AValue } from "../../values/primitives/AValue.js";
import * as z from "../../common/scheme-zod/index.js";
import { EnvCapability } from "../../common/capability.js";
import { reachableNodes } from "../../provenance/wireframe/loops.js";
import type { WireframeGraph, WireframeProgram } from "../../provenance/wireframe/types.js";
import { isEagerProvenanceOracleEnabled, setEagerProvenanceOracleEnabled } from "../../values/op-helpers.js";
import { jsToScheme } from "../../membrane/rosetta.js";
import type { CallCtx } from "../../run/CallCtx.js";
import type { SchemeValue } from "../../values/types.js";
import { applyCapability } from "../_fresh-env.js";

// ── stamped-value constructors (mirrors _lineage-test-helpers.ts's sStr/sNum — a
// local copy so this harness has no test-file-to-test-file import; same shapes). ──
const stampedStr = (s: string, p: number): AString => z.string.encode(s).withProvenance(new Set([p]));
const stampedNum = (n: number, p: number): AValue => z.number.encode(n).withProvenance(new Set([p]));

/** A registered source's mint SHAPE — what kind of stamped value it returns. `dict`
 *  mints ONE fresh id PER FIELD (so a field-projection corpus row has distinct ids to
 *  narrow between), all attributed to the SAME op name in `idToOp` (op-name is the
 *  comparison's shared vocabulary; per-field id granularity is this harness's, not
 *  the wireframe's — no per-field source node kind exists, §3 I5 LIMIT). */
export type SourceShape = "num" | "str" | { readonly dict: readonly string[] };

/** The eager-oracle side: a shared mint counter + id→op registry (so a deep-
 *  collapsed provenance id can be projected back to "which declared source op fired"),
 *  plus the env registration helper. One instance per test file (module-level ids
 *  never collide across corpus rows run in the same process). */
export class SourceRegistry {
  private nextId = 1;
  private readonly idToOp = new Map<number, string>();

  private mint(op: string): number {
    const id = this.nextId++;
    this.idToOp.set(id, op);
    return id;
  }

  /** Register one source op on `env` per its shape. Every call MINTS a fresh id
   *  (or one per dict field) — this is deliberate: a source is a Rosetta-IN
   *  crossing, and the real membrane mints once per crossing regardless of how many
   *  times a fan/loop calls it (golden-prov-infer.test.ts's rationale, restated).
   *
   *  Uses a test-local `EnvCapability` with a `symbol.native` verb declared
   *  `provenance: "source"`. WORLD-FLIP REBASELINE (ruling 2026-08-13): the earlier
   *  `symbol.rosetta` + `z.dynamic` shape is now an illegal move — a rosetta impl's
   *  return is a JS-world value, and an ALREADY-STAMPED `AValue` there doors
   *  (`WorldFlipError`). A fake source that mints its OWN stamps genuinely works over
   *  scheme values, which is exactly the native contour: `z.schemeValue` slots, no
   *  membrane, no auto-mint — the custom stamp survives by construction, and the
   *  declared `"source"` role keeps the lineage classifier reading it as a source. */
  async register(env: AmbientRuntime, op: string, shape: SourceShape): Promise<void> {
    const mint = this.mint.bind(this);
    await applyCapability(env, [
      EnvCapability.define(`test/w1-source-${op}`, {
        symbols: (symbol) => ({
          [op]: symbol.native`${op}: W1 harness fake source`(
            { input: [], inputRest: z.schemeValue, output: [z.schemeValue], provenance: "source" },
            function (this: CallCtx, ..._args: unknown[]): SchemeValue {
              if (shape === "num") {
                const id = mint(op);
                return stampedNum(id, id) as SchemeValue;
              }
              if (shape === "str") {
                const id = mint(op);
                return stampedStr(`${op}#${id}`, id) as SchemeValue;
              }
              const out: Record<string, unknown> = {};
              for (const field of shape.dict) {
                const id = mint(op);
                out[field] = stampedStr(`${op}.${field}#${id}`, id);
              }
              // Dict payload: box under THIS call's runCtx (a native may construct
              // scheme values; stamped leaves ride jsToScheme's owned pass-through).
              return jsToScheme(this.runCtx, out) as unknown as SchemeValue;
            },
          ),
        }),
      }),
    ]);
  }

  /** Project a set of numeric provenance ids back to the set of declared source op
   *  names that minted them — the shared vocabulary the eager/prospective cones
   *  compare over. */
  opsOf(ids: ReadonlySet<number>): Set<string> {
    const out = new Set<string>();
    for (const id of ids) {
      const op = this.idToOp.get(id);
      if (op !== undefined) out.add(op);
    }
    return out;
  }
}

/** Run `code` in a fresh env (inheriting the shared bootstrap `inferenceEnv`'s base —
 *  passed by the caller so this harness has no bootstrap-ordering opinion) with the
 *  given SOURCE bindings registered, and return the EAGER-ORACLE cone: the set of
 *  declared source op names reachable in the deep-collapsed provenance of the run's
 *  LAST top-level form (the egress value — mirrors the wireframe's own "main forms;
 *  the last one's value flows to the out-port" convention, builder.ts's
 *  `buildWireframe`). */
export async function runEagerCone(
  baseEnv: ResolvingAmbient,
  code: string,
  sources: Record<string, SourceShape>,
  registry: SourceRegistry,
): Promise<Set<string>> {
  const env = baseEnv.child(`w1-agreement-${Math.random().toString(36).slice(2)}`);
  for (const [op, shape] of Object.entries(sources)) await registry.register(env, op, shape);
  // this helper/execState needs the eager oracle ON
  const savedOracle = isEagerProvenanceOracleEnabled();
  setEagerProvenanceOracleEnabled(true);
  let values: readonly SchemeValue[];
  try {
    ({ values } = await execStateOverFrame(code, { env }));
  } finally {
    setEagerProvenanceOracleEnabled(savedOracle);
  }
  const last = values[values.length - 1];
  const ids = collapseProvenance(last);
  return registry.opsOf(ids);
}

// ── the prospective side ────────────────────────────────────────────────────────

/** Backward-walk one `WireframeGraph` from `fromNode`, collecting every reachable
 *  `source` node's op name, recursing into the THREE private-subgraph shapes a
 *  single-graph `reachableNodes` call cannot see across: a fan's `template`, a
 *  binder's `interior`, and a `template-ref`'s named entry in
 *  `WireframeProgram.templates`. `seen` guards a graph object being re-walked (not a
 *  cycle guard — `reachableNodes` itself owns cycle safety per graph; this is just
 *  memoization across repeated template-ref call sites to the same define). */
function graphSourceNames(
  program: WireframeProgram,
  graph: WireframeGraph,
  fromNode: number,
  seen: Set<WireframeGraph>,
): Set<string> {
  const names = new Set<string>();
  if (seen.has(graph)) return names;
  seen.add(graph);
  const reachable = reachableNodes(graph, fromNode);
  for (const idx of reachable) {
    const node = graph.nodes[idx];
    switch (node.kind) {
      case "source":
        names.add(node.op);
        break;
      case "fan":
        // GATED ON `lengthPreserving` (a DESIGN DECISION this harness makes, not a
        // production query — none exists yet, which is exactly why Q9 builds one to
        // validate). A map-shaped fan's per-element TRANSFORM genuinely produces the
        // fan's own output elements, so its template's sources flow forward — descend.
        // A filter-shaped fan's callback produces only a MEMBERSHIP BOOLEAN; per the
        // conservation-law container-box convention (PROXIED/PROVENANCED,
        // conservation.law.test.ts §3), filter's OUTPUT carries the SURVIVING
        // elements' OWN pre-existing provenance — never anything computed INSIDE the
        // predicate. Descending into a non-length-preserving fan's template would
        // over-include sources that only ever fed a discarded boolean (empirically
        // confirmed: `(filter (lambda (row) (positive? (car (map (lambda (v)
        // (fetch-item v)) row)))) …)` — eager cone is EMPTY, fetch-item's ids never
        // reach the kept rows' own values).
        if (node.lengthPreserving && node.template !== undefined && node.template.egress !== null) {
          for (const n of graphSourceNames(program, node.template, node.template.egress, seen)) names.add(n);
        }
        break;
      case "binder":
        if (node.interior.egress !== null) {
          for (const n of graphSourceNames(program, node.interior, node.interior.egress, seen)) names.add(n);
        }
        break;
      case "template-ref": {
        const tpl = program.templates.get(node.name);
        if (tpl !== undefined && tpl.graph.egress !== null) {
          for (const n of graphSourceNames(program, tpl.graph, tpl.graph.egress, seen)) names.add(n);
        }
        break;
      }
      case "sink":
      case "transparent":
      case "mux":
      case "recur":
      case "opaque":
      case "port":
        break; // no source name of their own; their own ingress wires are already
      // covered generically by `reachableNodes`'s per-node wire scan above.
      default:
        break;
    }
  }
  return names;
}

/** The whole-program prospective cone: the set of declared source op names reachable
 *  from `program.main`'s egress. Empty (not an error) for an all-defines/all-sink
 *  program (`main.egress === null` — §2: a sink has no egress wire). */
export function prospectiveSourceCone(program: WireframeProgram): Set<string> {
  if (program.main.egress === null) return new Set();
  return graphSourceNames(program, program.main, program.main.egress, new Set());
}
