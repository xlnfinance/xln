/**
 * LAW — track containment (I1), track separation (I3), R2 demand-monotonicity
 * (docs/PROVENANCE.md §3 "Tracks" + §6 "Queries", §7 law table — one of the stub
 * files the law table's "stubs land before machinery" discipline maps).
 *
 * Per the grounded-audit-corrected mapping, track-containment is TWO SEPARATE describe
 * blocks (not one law flipping at one gate) because its two arms genuinely flip at
 * different Q-nodes: the STAMP arm (checked against the eager oracle's stamp sets)
 * belongs to Q9's oracle infrastructure; the REPLAY arm is checked against γ's
 * replayed cone (`provenance/replay.ts`, `q16-harness.ts` — record a real run with
 * emission ON, then γ each track against its own frozen ingress).
 *
 * Q8c ADDENDUM: the R2 demand-monotonicity describe block below gained ONE live `it()`
 * (not `it.todo`) alongside its three untouched Q17-ledgered stubs — the MACHINERY
 * (`wireframe/loops.ts`'s `reachableNodesForDemand`, `wireframe/builder.ts`'s
 * `factTagOf`) lands at Q8c per the plan's own gate text ("a count-demand cone touches
 * ZERO element wires — asserted"), while the full LAW (checked against the eager
 * oracle / replay, once those exist for R2 specifically) still flips at Q17. The
 * concrete corpus lives in `provenance/__tests__/wireframe-fact-wires.test.ts`; the row
 * here is a SHORT confirming assertion, not a duplicate of that corpus.
 *
 * Q16 TRACK-LAW MECHANISM (shared by the flipped rows below): a fan's element track
 * IS a wire whose expression is the fan's private `template` interior (§3 CHOSEN: "a
 * track IS a wire whose expression is a first-class lambda") — so "replay track Tᵢ"
 * = `replayGraphEgress` over `fan.template` with ONLY Tᵢ's own recorded payloads
 * frozen in. cone⁺ at replay level = the stamp set the boxed γ egress carries
 * (payloads round-trip value + stamp ids, §5 D2 — the containment laws are WHY).
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { parse, execStateOverFrame as execState } from "../../eval/generator-exec.js";
import { inferenceEnv } from "../../env/inference-env.js";
import { collapseProvenance } from "../../provenance/provenance-collapse.js";
import {
  classify,
  fieldCone,
  fullCone,
  type Bindings,
  type Classifier,
  type DeclaredRole,
  type PathStep,
} from "../../provenance/lineage.js";
import { buildWireframe } from "../../provenance/wireframe/builder.js";
import { reachableNodesForDemand } from "../../provenance/wireframe/loops.js";
import { FrozenMints, boxPayload, replayBetweenRecords, replayGraphEgress } from "../../provenance/replay.js";
import { setEmissionEnabled } from "../../provenance/store/emit.js";
import { ProvenanceStoreFake } from "../../provenance/store/fakes.js";
import { foldRegionStream } from "../../provenance/store/fold.js";
import {
  closeRegionScope,
  openRegionScope,
  recordHostScheduleVerdict,
  withTrackCoordinate,
  type TrackCoordinate,
  type TrackEmissionSink,
} from "../../membrane/region-scope.js";
import { CONSTANT_CTX } from "../../run/RunContext.js";
import type { EmittedWire, WireframeGraph } from "../../provenance/wireframe/types.js";
import type { SchemeValue } from "../../values/types.js";
import { recordRun, replayedCone, type RecordedRun } from "../../__tests__/provenance/q16-harness.js";
import { SourceRegistry } from "../../__tests__/provenance/w1-harness.js";
import { requireEagerOracle } from "../../__tests__/_require-eager-oracle.js";

// this helper/execState needs the eager oracle ON
requireEagerOracle();

const ROLES: Record<string, DeclaredRole> = {
  "fetch-list": "source",
  "fetch-item": "source",
  "src-a": "source",
  "src-b": "source",
  "emit!": "sink",
  map: "fan",
  filter: "fan",
};
const CLASSIFIER: Classifier = { roleOf: (op) => ROLES[op] };
const BASE = new Set(["car", "length", "list", "*", "+", "begin"]);
const isBaseName = (n: string): boolean => BASE.has(n);

async function wf(code: string) {
  const forms = await parse(code);
  return buildWireframe(forms, { classifier: CLASSIFIER, isBaseName });
}

/** The shared element-track corpus program: a map whose per-element track crosses
 *  an interior source, then applies a pure stretch — three tracks, three mints. */
const MAP_CODE = `(map (lambda (v) (* (fetch-item v) 2)) (list 1 2 3))`;

/** Replay ONE element track: γ over the fan's private template interior with ONLY
 *  this track's own recorded payload frozen in (I2 sealed ingress: the element value
 *  is host-supplied per iteration — bound as the template's formal). */
async function replayTrack(run: RecordedRun, template: WireframeGraph, i: number) {
  const frozen = new FrozenMints();
  frozen.push(run.mints[i].op, run.mints[i].payload);
  const program = await wf(MAP_CODE);
  return replayGraphEgress({
    program,
    graph: template,
    frozen,
    slots: { v: boxPayload({ value: i + 1, stampIds: [] }) },
  });
}

async function fanTemplateOf(code: string): Promise<WireframeGraph> {
  const program = await wf(code);
  const fan = program.main.nodes.find((n) => n.kind === "fan");
  expect(fan?.kind === "fan" && fan.template !== undefined).toBe(true);
  if (fan?.kind !== "fan" || fan.template === undefined) throw new Error("no fan template");
  return fan.template;
}

beforeAll(async () => {});

afterEach(() => {
  setEmissionEnabled(false);
});

describe("track containment — STAMP arm (§3 I1 vs the eager oracle)", () => {
  const elements = [1, 2, 3];
  let tracks: { v: number; egress: SchemeValue; portStamp: number }[];

  beforeAll(async () => {
    const registry = new SourceRegistry();
    tracks = [];
    for (const v of elements) {
      const env = inferenceEnv.child(`i1-stamp-track-${v}`);
      await registry.register(env, "fetch-item", "num");
      const { values } = await execState(`(* (fetch-item ${v}) 2)`, { env });
      const egress = values[values.length - 1];
      const cone = collapseProvenance(egress);
      expect(cone.size).toBe(1); // exactly ONE interior mint per track (fetch-item)
      tracks.push({ v, egress, portStamp: [...cone][0] });
    }
  });

  it.each(elements)(
    "I1 holds over the eager oracle's stamp sets for element %i: cone+(n) ∩ G ⊆ cone+(egress(Ti)), " +
      "checked against SourceRegistry's minted stamps (the agreement corpus, reusing " +
      "w1-harness/q16-harness's shared source-mint idiom)",
    (v) => {
      const track = tracks.find((t) => t.v === v)!;
      const egressCone = collapseProvenance(track.egress);
      // interior n (the track's own fetch-item mint): cone+(n) ⊆ cone+(egress(Ti)).
      expect(
        egressCone.has(track.portStamp),
        `interior stamp ${track.portStamp} escaped its own track's egress cone`,
      ).toBe(true);
      // confinement: nothing beyond this track's own stamp reaches the egress.
      expect([...egressCone]).toEqual([track.portStamp]);
    },
  );

  it("distinct crossings mint distinct ids — tracks stay pairwise-disjoint under the eager oracle too", () => {
    const allStamps = tracks.map((t) => t.portStamp);
    expect(new Set(allStamps).size).toBe(allStamps.length);
  });
});

describe("track containment — REPLAY arm (§3 I1 under γ)", () => {
  let run: RecordedRun;
  let template: WireframeGraph;

  beforeAll(async () => {
    run = await recordRun(inferenceEnv, MAP_CODE, { "fetch-item": "num" });
    template = await fanTemplateOf(MAP_CODE);
  });

  it("the recorded run mints 3 payloads with egress [2,4,6]", () => {
    expect(run.mints).toHaveLength(3);
    expect(run.egress).toEqual([2, 4, 6]);
  });

  it.each([0, 1, 2])("element track %i replays: value matches, interior stamp is contained AND confined", async (i) => {
    const track = await replayTrack(run, template, i);
    // the track's value replays: element i of the recorded egress
    expect(track.value).toBe((run.egress as number[])[i]);
    const egressCone = replayedCone(track.boxed);
    // interior n #1 — the track's own port (its recorded mint): cone ⊆ egress cone
    for (const id of run.mints[i].payload.stampIds) {
      expect(egressCone.has(id), `interior port stamp ${id} escaped track ${i}'s egress cone`).toBe(true);
    }
    // interior n #2 — the pure element ingress (an unstamped literal): ∅ ⊆ egress, trivially inside
    // …and CONFINEMENT: the egress cone holds nothing beyond this track's own ingress
    const own = new Set(run.mints[i].payload.stampIds);
    for (const id of egressCone) {
      expect(own.has(id), `track ${i}'s replayed cone carries foreign stamp ${id}`).toBe(true);
    }
  });
});

describe("effect-track empty cone (§3 I1 corollary: = ∅ for effect tracks)", () => {
  // The begin-sink program deliberately EXERCISES Q9's documented finding 3 (the
  // wireframe's egress wire keeps a sequencing reference to the sink node, over-
  // including src-a in the ABSTRACT cone). At REPLAY level the story is exactly the
  // spec's: γ discards the sequencing residue (the sink binds a D2 sentinel that
  // `begin` drops), so the replayed cone is MORE precise than the abstract one —
  // the finding is named here, not silently depended on.
  const EFFECT_CODE = `(begin (emit! (src-a)) (src-b))`;

  it("for an EFFECT track, cone+(n) ∩ G = ∅ — no interior stamp reaches the replayed value cone", async () => {
    const run = await recordRun(inferenceEnv, EFFECT_CODE, { "src-a": "num", "emit!": "echo", "src-b": "num" });
    // the record run observed all three crossings (sink events are REAL observations
    // — the world-noninterference reading is EXCLUDED, §3 panel C3)…
    expect(run.mints.map((m) => m.op)).toEqual(["src-a", "emit!", "src-b"]);

    const program = await wf(EFFECT_CODE);
    const replayed = await replayGraphEgress({ program, frozen: run.frozen });
    expect(replayed.value).toBe(run.egress);

    const cone = replayedCone(replayed.boxed);
    const effectInteriorStamps = [...run.mints[0].payload.stampIds, ...run.mints[1].payload.stampIds];
    for (const id of effectInteriorStamps) {
      expect(cone.has(id), `effect-track interior stamp ${id} leaked into G's value cone`).toBe(false);
    }
    // the value cone is exactly src-b's — matching the eager oracle's own egress cone
    expect([...cone].sort()).toEqual([...run.eagerCone].sort());
    expect([...cone]).toEqual([...run.mints[2].payload.stampIds]);
  });

  it("the forward cone of a value CAPTURED by an effect track still includes the region port", async () => {
    const run = await recordRun(inferenceEnv, EFFECT_CODE, { "src-a": "num", "emit!": "echo", "src-b": "num" });
    const program = await wf(EFFECT_CODE);

    const sinkIdx = program.main.nodes.findIndex((n) => n.kind === "sink");
    const srcAIdx = program.main.nodes.findIndex((n) => n.kind === "source" && n.op === "src-a");
    expect(sinkIdx).toBeGreaterThanOrEqual(0);
    expect(srcAIdx).toBeGreaterThanOrEqual(0);

    // prospective: the wire feeding the sink port consumes src-a's egress — the
    // forward walk from src-a reaches the region port through a REAL edge of G.
    const sinkIngress = program.main.wires.filter((w) => w.consumer.node === sinkIdx);
    expect(sinkIngress.length).toBeGreaterThan(0);
    expect(
      sinkIngress.some((w) => w.paramRefs.some((r) => r.kind === "node" && r.node === srcAIdx)),
      "src-a's forward cone must include the effect port",
    ).toBe(true);

    // retrospective: the crossing is a recorded observation — the port event exists
    // in the stream (its payload echoes exactly the captured value).
    const emitMintRecord = run.mints.find((m) => m.op === "emit!");
    expect(emitMintRecord).toBeDefined();
    expect(emitMintRecord?.payload.value).toBe(run.mints[0].payload.value);
  });
});

describe("track separation (§3 I3: no spontaneous inter-track edges)", () => {
  it("zero spontaneous inter-track edges except the sanctioned accumulator chain", async () => {
    // parallel (element role): three tracks, pairwise-disjoint replayed cones
    const run = await recordRun(inferenceEnv, MAP_CODE, { "fetch-item": "num" });
    const template = await fanTemplateOf(MAP_CODE);
    const cones: Set<number>[] = [];
    for (let i = 0; i < 3; i++) cones.push(replayedCone((await replayTrack(run, template, i)).boxed));
    for (let i = 0; i < 3; i++) {
      for (let j = i + 1; j < 3; j++) {
        for (const id of cones[i]) expect(cones[j].has(id), `tracks ${i}/${j} share stamp ${id}`).toBe(false);
      }
    }

    // no cross-contamination: MUTATE track 1's frozen payload — track 0's replay is
    // bit-identical (value AND cone); the mutation had no edge to travel.
    const t0Before = await replayTrack(run, template, 0);
    const mutatedRun: RecordedRun = {
      ...run,
      mints: run.mints.map((m, k) => (k === 1 ? { ...m, payload: { ...m.payload, value: 999 } } : m)),
    };
    const t0After = await replayTrack(mutatedRun, template, 0);
    const t1After = await replayTrack(mutatedRun, template, 1);
    expect(t0After.value).toBe(t0Before.value);
    expect([...replayedCone(t0After.boxed)].sort()).toEqual([...replayedCone(t0Before.boxed)].sort());
    expect(t1After.value).toBe(999 * 2); // the mutation DID land where it was aimed

    // chained (accumulator role): the sanctioned edge, and only it — each pure
    // stretch's ingress is exactly (previous egress, own recorded event); the
    // replayed chain reproduces the recorded fold.
    const foldCode = `(let loop ((xs (list 5 6 7)) (acc 0)) (if (null? xs) acc (loop (cdr xs) (+ acc (emit-step! (car xs))))))`;
    const foldRun = await recordRun(inferenceEnv, foldCode, { "emit-step!": "echo" });
    const stretch: EmittedWire = {
      source: "(lambda (acc ev) (+ acc ev))",
      params: ["acc", "ev"],
      paramRefs: [
        { kind: "slot", name: "acc" },
        { kind: "slot", name: "ev" },
      ],
      span: "i3-acc-stretch",
    };
    const { steps, egress } = await replayBetweenRecords({
      store: foldRun.store,
      payloads: foldRun.payloads,
      regionId: foldRun.regionId,
      stretch: { wire: stretch, accParam: "acc", eventParam: "ev" },
      initial: boxPayload({ value: 0, stampIds: [] }),
    });
    expect(egress).toBe(foldRun.egress);
    // the chain: pure value k = pure value k-1 + event k — state flows ONLY through acc
    const pures = steps.flatMap((s) => (s.kind === "pure" ? [s.value as number] : []));
    const events = steps.flatMap((s) => (s.kind === "port-event" ? [s.payload.value as number] : []));
    for (let k = 0; k < pures.length; k++) {
      expect(pures[k]).toBe((k === 0 ? 0 : pures[k - 1]) + events[k]);
    }
  });

  it("order rides the host-schedule record, never a fabricated inter-track edge (§3 I3 LIMIT)", async () => {
    // ONE host invocation's comparator schedule, accumulated on the region scope and
    // flushed as ONE record at close — region-scope.ts's real Q11b machinery.
    setEmissionEnabled(true);
    const store = new ProvenanceStoreFake();
    const REGION = "i3-host-schedule";
    const sink: TrackEmissionSink = { store, regionId: REGION };
    const COORD: TrackCoordinate = { templateHash: "th-i3-sort", ordinalPath: [0], regionEpoch: "e0" };
    const verdicts: readonly (readonly [number, number, number])[] = [
      [0, 1, 1], // track 0 vs track 1 → right first
      [1, 2, -1], // track 1 vs track 2 → left first
      [0, 2, 1], // track 0 vs track 2 → right first
    ];
    const scope = withTrackCoordinate(COORD, sink, () => openRegionScope({ runCtx: CONSTANT_CTX, dynSite: undefined }));
    for (const [l, r, v] of verdicts) recordHostScheduleVerdict(scope, [l], [r], v);
    closeRegionScope(scope);
    setEmissionEnabled(false);
    await Promise.resolve();
    await Promise.resolve();

    // the fold exposes the schedule; reconstruction is PURE triple-reading — the
    // verdicts are inlined (§5 D5: "inlined verdicts make schedule reconstruction
    // replay-free"), no γ call, no fabricated edge.
    const fold = foldRegionStream(await store.readStream(REGION));
    expect(fold.hostSchedules).toHaveLength(1);
    const triples = fold.hostSchedules[0].triples;
    expect(triples.map((t) => [t.left[0], t.right[0], t.verdict])).toEqual(verdicts.map((v) => [...v]));
    // derived order (1 < 2 < 0 under the verdicts above: 1 sorts before 0, 1 before
    // 2, 2 before 0) — from triples alone:
    const order = [0, 1, 2].sort((a, b) => {
      const t = triples.find((x) => (x.left[0] === a && x.right[0] === b) || (x.left[0] === b && x.right[0] === a));
      if (t === undefined) return 0;
      return t.left[0] === a ? t.verdict : -t.verdict;
    });
    expect(order).toEqual([1, 2, 0]);

    // …and the schedule record adds NO dataflow: the compared tracks (the MAP_CODE
    // element tracks) replay IDENTICALLY whether or not the schedule exists — their
    // cones and values depend only on their own frozen ingress.
    const run = await recordRun(inferenceEnv, MAP_CODE, { "fetch-item": "num" });
    const template = await fanTemplateOf(MAP_CODE);
    const t0 = await replayTrack(run, template, 0);
    expect(t0.value).toBe((run.egress as number[])[0]);
    for (const id of replayedCone(t0.boxed)) {
      expect(run.mints[0].payload.stampIds).toContain(id);
    }
  });
});

describe("R2 demand monotonicity (§6 demand lattice: value / count / field-k)", () => {
  const MONOTONICITY_CORPUS = [
    "(emit! (length (map f (fetch-list))) (car (filter g xs)))",
    "(length (map (lambda (v) (+ (fetch-item v) 1)) xs))",
    "(emit! (length (append (map f (fetch-list)) ys)))",
  ];
  it.each(MONOTONICITY_CORPUS)(
    "cone(count) ⊆ cone(value) for %j — a count-demand cone is never wider than the value-demand cone it's derived from",
    async (code) => {
      const p = await wf(code);
      const sinkIdx = p.main.nodes.findIndex((n) => n.kind === "sink");
      const from = p.main.egress ?? sinkIdx;
      expect(from).toBeGreaterThanOrEqual(0);
      const valueCone = reachableNodesForDemand(p.main, from, "value");
      const countCone = reachableNodesForDemand(p.main, from, "count");
      for (const id of countCone) {
        expect(valueCone.has(id), `count-cone node ${id} escaped the value cone (${code})`).toBe(true);
      }
    },
  );

  // field-k has no separate wireframe demand grade; this row uses lineage.ts fieldCone/fullCone
  const FIELD_CLASSIFIER: Classifier = { roleOf: () => undefined };
  const FIELD_CORPUS: ReadonlyArray<{ code: string; bindings: Bindings; step: PathStep; note: string }> = [
    { code: "(:foo x)", bindings: { x: [42] }, step: { field: "foo" }, note: "matched field" },
    { code: "(:foo x)", bindings: { x: [42] }, step: { field: "bar" }, note: "pruned sibling — [] ⊆ whole trivially" },
    { code: "(cons (:foo a) (:bar b))", bindings: { a: [1], b: [2] }, step: { field: "foo" }, note: "merge barrier" },
    {
      code: "(if p (:foo a) (:foo b))",
      bindings: { p: [9], a: [1], b: [2] },
      step: { field: "foo" },
      note: "mux, matches both arms",
    },
    {
      code: "(if p (:foo a) (:foo b))",
      bindings: { p: [9], a: [1], b: [2] },
      step: { field: "zzz" },
      note: "mux, prunes both arms",
    },
  ];
  it.each(FIELD_CORPUS)(
    "cone(field-k) ⊆ cone(whole) for $code / field $step.field ($note)",
    async ({ code, bindings, step }) => {
      const [ast] = await parse(code);
      const n = classify(ast, FIELD_CLASSIFIER);
      const whole = new Set(fullCone(n, bindings));
      const field = new Set(fieldCone(n, bindings, step));
      for (const id of field) {
        expect(whole.has(id), `field-cone id ${id} escaped the whole cone (${code}, ${JSON.stringify(step)})`).toBe(
          true,
        );
      }
    },
  );

  // roles swapped vs fact-wires corpus: filter is fact-tagged/included, map is untagged/excluded — carve-out is symmetric in lengthPreserving
  it(
    "count-demand traverses fact wires ONLY — touches ZERO element wires (§6: " +
      '"struct-fact wires answer count-demand without touching elements"; the routing ' +
      "machinery lands at Q8c, this law itself flips at Q17 once query maturity lands)",
    async () => {
      const p = await wf("(emit! (length (filter g (fetch-list))) (car (map f xs)))");
      const sinkIdx = p.main.nodes.findIndex((n) => n.kind === "sink");
      const filterFanIdx = p.main.nodes.findIndex((n) => n.kind === "fan" && n.lengthPreserving === false);
      const mapFanIdx = p.main.nodes.findIndex((n) => n.kind === "fan" && n.lengthPreserving === true);
      expect(sinkIdx).toBeGreaterThanOrEqual(0);
      expect(filterFanIdx).toBeGreaterThanOrEqual(0);
      expect(mapFanIdx).toBeGreaterThanOrEqual(0);
      const countCone = reachableNodesForDemand(p.main, sinkIdx, "count");
      expect(countCone.has(filterFanIdx)).toBe(true); // the fact-tagged branch's fan — included
      expect(countCone.has(mapFanIdx)).toBe(false); // the untagged "element" branch's fan — excluded
    },
  );

  it("Q8c machinery gate: a count-demand cone touches zero element wires", async () => {
    const forms = await parse("(emit! (length (map f (fetch-list))) (car (filter g xs)))");
    const p = buildWireframe(forms, { classifier: CLASSIFIER, isBaseName });
    const sinkIdx = p.main.nodes.findIndex((n) => n.kind === "sink");
    const elementFanIdx = p.main.nodes.findIndex((n) => n.kind === "fan" && n.lengthPreserving === false);
    expect(sinkIdx).toBeGreaterThanOrEqual(0);
    expect(elementFanIdx).toBeGreaterThanOrEqual(0);
    const countCone = reachableNodesForDemand(p.main, sinkIdx, "count");
    expect(countCone.has(elementFanIdx)).toBe(false); // the ONLY node reachable through
    // an element wire (the sink's OTHER arg, `(car (filter …))`) — excluded.
  });
});
