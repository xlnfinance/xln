/**
 * WALKING-DRIVER SPIKE (`__experiments__/` — opt-in via `pnpm experiments`, NEVER a
 * CI gate).
 *
 * Proves the emission SEAM the walking driver rides, end-to-end, with zero
 * production edits:
 *
 *   1. SKELETON — `buildWireframe` over the parse tree yields the pre-run graph;
 *      every designated node carries `span = scopeId(surface form)`, so the driver
 *      can mark the designated Pairs before a single form executes (here: by
 *      span-string; a real driver would use a WeakSet over the shared parse
 *      instead, for identity rather than string comparison).
 *   2. WALK — a THIN `EvalTap` (O(1) invocation stubs, retains nothing) plus
 *      `ExecOptions.nodeFilter` makes the evaluator's landed tap gate
 *      (`evaluator.ts` "LOCATION in code") fire ONLY at designated nodes — the
 *      pure-residue interior `(* 2 3)` never reaches the tap.
 *   3. MEAT — the landed mint hook (`eval/provenance-hooks.ts`, whose own header
 *      names "a wireframe-walking driver" as its eventual real installer) emits a
 *      `MintRecord` into a live `ProvenanceStore` AS the run walks the source
 *      crossing, keyed by a coordinate DERIVED FROM THE SKELETON — and the record's
 *      id joins back to the skeleton node via `siteHash(templateHash, siteOf(node))`,
 *      which is exactly the skeleton⋈stream join the studio overlay renders.
 *
 * What this spike deliberately does NOT have: the coordinate ADVANCE primitive —
 * `withRecordCoordinateAsync` installs one static coordinate for the whole run, so
 * this program has exactly one mint-designated node. A multi-port program needs
 * the driver tap to advance the ambient coordinate per designated enter.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ensureInferenceEnvPopulated, execStateOverFrame, parse } from "../eval/generator-exec.js";
import { inferenceEnv } from "../env/inference-env.js";
import { type ResolvingAmbient } from "../env/AmbientRuntime.js";
import { EnvCapability } from "../common/capability.js";
import { applyCapability } from "../__tests__/_fresh-env.js";
import { toJS } from "../membrane/rosetta.js";
import type { EvalTap } from "../eval/evaluator.js";
import type { Classifier, DeclaredRole } from "../provenance/lineage.js";
import { buildWireframe } from "../provenance/wireframe/builder.js";
import { hashGraph, rootOrdinalPath, siteHash, siteOf } from "../provenance/wireframe/hash.js";
import { scopeId } from "../provenance/scope-id.js";
import { withRecordCoordinateAsync, type EmissionSink, type RecordCoordinate } from "../eval/provenance-hooks.js";
// `store/index.js` is a curated studio read-slice (type-only) — fakes/emit runtime values
// live at their own leaf modules (same shape as the sibling __benchmarks__ files).
import { setEmissionEnabled } from "../provenance/store/emit.js";
import { PayloadStoreFake, ProvenanceStoreFake } from "../provenance/store/fakes.js";
import { APair } from "../values/primitives/APair.js";
import type { AListAlike } from "../values/types.js";

const ROLES: Record<string, DeclaredRole> = { "fetch-item": "source" };
const CLASSIFIER: Classifier = { roleOf: (op) => ROLES[op] };
const BASE = new Set(["+", "*"]);
const isBaseName = (n: string): boolean => BASE.has(n);

const REGION = "region-walking-driver-spike";
const EPOCH = "spike-epoch-0";

/** The spike program: one membrane crossing `(fetch-item)` amid pure residue.
 *  Skeleton: `source` node + `port{out}`; the `(* 2 3)` interior collapses into
 *  the egress wire — it is NOT a designated node and must never reach the tap. */
const PROGRAM = "(+ (* 2 3) (fetch-item))";

async function registerSource(env: ResolvingAmbient): Promise<void> {
  await applyCapability(env, [
    EnvCapability.define("spike/fetch-item", {
      symbols: (symbol, z) => ({
        "fetch-item": symbol.rosetta`fetch-item: a zero-arg numeric source`(
          { input: [], output: [z.number] },
          () => 42,
        ),
      }),
    }),
  ]);
}

/** The THIN driver tap: mints O(1) invocation stubs (`{ id }` — the exact shape
 *  `rosetta.ts`'s mint path flips `isProvenancePoint` on) and retains NOTHING but
 *  this spike's own assertion log. No bindings array, no records map, no
 *  per-invocation value retention — the anti-EvalTrace. */
function thinDriverTap(entersLog: string[]): EvalTap {
  let nextId = 0;
  return {
    enter: (node) => {
      entersLog.push(node instanceof APair ? scopeId(node) : "<non-pair>");
      return { id: nextId++ };
    },
    exit: () => undefined,
  };
}

beforeAll(async () => {
  await ensureInferenceEnvPopulated();
});

afterEach(() => {
  setEmissionEnabled(false);
});

describe("walking-driver spike: skeleton from parse, meat from the live walk", () => {
  it("skeleton-derived coordinate → thin-tap walk → mint record lands → joins back to the skeleton node", async () => {
    // ── 1. SKELETON (parse-time, run-neutral — no run exists yet) ──────────────
    const forms = await parse(PROGRAM);
    const program = buildWireframe(forms, { classifier: CLASSIFIER, isBaseName });
    const templateHash = hashGraph(program.main);

    const sourceIdx = program.main.nodes.findIndex((n) => n.kind === "source");
    expect(sourceIdx).toBeGreaterThanOrEqual(0);
    const sourceNode = program.main.nodes[sourceIdx];

    // The designation set: span-strings of every designated node. (Production
    // uses a WeakSet over the shared parse — identical semantics, no string ops.)
    const designatedSpans = new Set(program.main.nodes.map((n) => siteOf(n)));

    // ── 2. ARM the run (run-time from here on) ─────────────────────────────────
    setEmissionEnabled(true);
    const store = new ProvenanceStoreFake();
    const payloads = new PayloadStoreFake();
    const sink: EmissionSink = { store, payloads, regionId: REGION };
    const coordinate: RecordCoordinate = {
      templateHash,
      ordinalPath: rootOrdinalPath(sourceIdx),
      regionEpoch: EPOCH,
    };

    const env = inferenceEnv.child("walking-driver-spike");
    await registerSource(env);

    const enters: string[] = [];
    const tap = thinDriverTap(enters);
    const nodeFilter = (node: AListAlike): boolean => node instanceof APair && designatedSpans.has(scopeId(node));

    // ── 3. WALK — execute the SAME parsed form the skeleton was built from ────
    const result = await withRecordCoordinateAsync(coordinate, sink, () =>
      execStateOverFrame(forms[0], { env, tap, nodeFilter }),
    );
    expect(toJS(result.values[0], {})).toBe(48); // (+ 6 42) — the run itself is undisturbed

    // Emission is a detached sidecar (fire-and-forget off settlement) — let its
    // microtasks drain before reading the store, same as emission-hooks.test.ts.
    await Promise.resolve();
    await Promise.resolve();

    // ── 4. THE WALK WAS PRUNED — only designated forms reached the tap ─────────
    // Located Pairs in the program: (+ …), (* 2 3), (fetch-item). Designated: the
    // source crossing and the egress form. The pure interior never fires.
    expect(enters).toContain(scopeId(forms[0] as APair)); // the egress form (port{out} span)
    expect(enters).toContain(sourceNode.span); // the source crossing
    expect(enters).toHaveLength(2); // and NOTHING else — (* 2 3) pruned by nodeFilter

    // ── 5. MEAT — the record landed live, keyed by the skeleton's own address ──
    const stream = await store.readStream(REGION);
    const mints = stream.filter((r) => r.kind === "mint");
    expect(mints).toHaveLength(1);
    expect(mints[0].id.templateHash).toBe(templateHash);
    expect(mints[0].id.ordinalPath).toEqual(rootOrdinalPath(sourceIdx));
    const payload = await payloads.get(mints[0].payloadHash);
    expect(payload.value).toBe(42);

    // ── 6. THE JOIN — record id → skeleton node, the overlay's render key ──────
    // `siteHash(templateHash, siteOf(node))` is the plane identity the ELK render
    // keys on; the record's (templateHash, ordinalPath) resolves to the same node
    // the skeleton drew as a bone. A pending bone becomes meat exactly here.
    const renderKey = siteHash(templateHash, siteOf(sourceNode));
    const resolvedNode = program.main.nodes[mints[0].id.ordinalPath[0]];
    expect(siteHash(mints[0].id.templateHash, siteOf(resolvedNode))).toBe(renderKey);
  });

  it("unarmed (flag off): same program, same tap — zero records, byte-identical result", async () => {
    setEmissionEnabled(false);
    const forms = await parse(PROGRAM);
    const program = buildWireframe(forms, { classifier: CLASSIFIER, isBaseName });
    const designatedSpans = new Set(program.main.nodes.map((n) => siteOf(n)));

    const store = new ProvenanceStoreFake();
    const payloads = new PayloadStoreFake();
    const sink: EmissionSink = { store, payloads, regionId: REGION };
    const coordinate: RecordCoordinate = {
      templateHash: hashGraph(program.main),
      ordinalPath: [0],
      regionEpoch: EPOCH,
    };

    const env = inferenceEnv.child("walking-driver-spike-off");
    await registerSource(env);

    const enters: string[] = [];
    const result = await withRecordCoordinateAsync(coordinate, sink, () =>
      execStateOverFrame(forms[0], {
        env,
        tap: thinDriverTap(enters),
        nodeFilter: (node) => node instanceof APair && designatedSpans.has(scopeId(node)),
      }),
    );
    expect(toJS(result.values[0], {})).toBe(48);

    await Promise.resolve();
    await Promise.resolve();
    expect(await store.readStream(REGION)).toHaveLength(0);
  });
});
