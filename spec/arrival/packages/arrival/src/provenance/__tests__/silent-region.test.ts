/**
 * silent-region.test.ts — Q15's standing rows (docs/PROVENANCE.md §4 CHOSEN, round 2
 * A4 — the silent region: doors active, emission
 * off; gate: standing + silent-region rows (a replay emits ZERO records —
 * asserted)).
 *
 * Three groups:
 *   A. `withSilentRegion`/`isSilentRegion` (`membrane/region-scope.ts`) —
 *      suppression of track-open/track-close/host-schedule AND, via
 *      `eval/provenance-hooks.ts`'s own read of the SAME ambient, mint — the
 *      leak-proof placement (a nested coordinate installed INSIDE a silent region's
 *      dynamic extent still cannot emit), doors unaffected, and the two nesting shapes
 *      (silent-in-loud, loud-in-silent — "silence dominates").
 *   B. `hermeticApply` (`provenance/gamma.ts`) — γ's smoke row: the mechanism actually
 *      applies a wire correctly, and does so for its ENTIRE async extent under silence.
 *   C. The glass whole-program-replay discipline (§4 V ruling) — pinned as a targeted
 *      row: a real run mints; the SAME program re-run under a silent region mints
 *      nothing new, even though the identical rosetta crossing happens again. Full
 *      glass machinery (penetration caching / playback) is later product work — this
 *      row pins only the discipline the task brief calls out.
 *
 * Q16 proved the adjunction laws (wire-γ etc.) over `hermeticApply` — see
 * `replay.law.test.ts` (flipped) and `provenance/replay.ts`; nothing here attempts
 * those, this file stays the Q15 smoke/discipline suite.
 */
import { afterEach, describe, expect, it } from "vitest";
import { type ResolvingAmbient } from "../../env/AmbientRuntime.js";
import { execStateOverFrame } from "../../eval/generator-exec.js";
import { EvalTrace } from "../../provenance/trace.js";
import { inferenceEnv } from "../../env/inference-env.js";
import { toJS } from "../../membrane/rosetta.js";
import { withRecordCoordinateAsync, type EmissionSink, type RecordCoordinate } from "../../eval/provenance-hooks.js";
import {
  closeRegionScope,
  isSilentRegion,
  openRegionScope,
  recordHostScheduleVerdict,
  withRegionScope,
  withSilentRegion,
  withTrackCoordinate,
  type TrackCoordinate,
  type TrackEmissionSink,
} from "../../membrane/region-scope.js";
import { ANativeProcedure } from "../../values/primitives/ANativeProcedure.js";
import { CONSTANT_CTX } from "../../run/RunContext.js";
import { AExact } from "../../values/primitives/AExact.js";
import { PayloadStoreFake, ProvenanceStoreFake } from "../../provenance/store/fakes.js";
import { setEmissionEnabled } from "../../provenance/store/emit.js";
import { hermeticApply } from "../../provenance/gamma.js";
import type { EmittedWire } from "../../provenance/wireframe/types.js";
import { EnvCapability } from "../../common/capability.js";
import { applyCapability } from "../../__tests__/_fresh-env.js";

const TRACK_COORD: TrackCoordinate = { templateHash: "th-silent-track", ordinalPath: [0], regionEpoch: "e0" };
const RECORD_COORD: RecordCoordinate = { templateHash: "th-silent-mint", ordinalPath: [0], regionEpoch: "e0" };
const REGION = "region-silent";

afterEach(() => {
  setEmissionEnabled(false);
});

/** Same shape `region-events.test.ts` uses — a trivial echo, enough surface for
 *  open/close counting, indifferent to what it computes. */
function makeEcho(): ANativeProcedure {
  return new ANativeProcedure({
    name: "echo",
    arity: { min: 1, max: 1 },
    contract: undefined,
    impl: (args) => args[0],
  });
}

/** Same shape `emission-hooks.test.ts` uses — one rosetta source, a real membrane
 *  crossing `notePotentialRosettaExit` can mint against. Test-local `EnvCapability`;
 *  a plain `z.number` output (the impl returns an ordinary JS number, no pre-stamped
 *  escape hatch needed). */
async function registerSource(env: ResolvingAmbient): Promise<void> {
  await applyCapability(env, [
    EnvCapability.define("test/fetch-item", {
      symbols: (symbol, z) => ({
        "fetch-item": symbol.rosetta`fetch-item: a zero-arg numeric source`(
          { input: [], output: [z.number] },
          () => 42,
        ),
      }),
    }),
  ]);
}

describe("A. silent-region mode suppresses emission, never doors (§4 CHOSEN, round 2 A4)", () => {
  it("silent region emits ZERO records — track-open/track-close AND mint all suppressed against fakes that would otherwise capture everything", async () => {
    setEmissionEnabled(true);
    const trackStore = new ProvenanceStoreFake();
    const trackSink: TrackEmissionSink = { store: trackStore, regionId: REGION };
    const mintStore = new ProvenanceStoreFake();
    const payloads = new PayloadStoreFake();
    const mintSink: EmissionSink = { store: mintStore, payloads, regionId: REGION };

    await withSilentRegion(async () => {
      const scope = withTrackCoordinate(TRACK_COORD, trackSink, () =>
        openRegionScope({ runCtx: CONSTANT_CTX, dynSite: undefined }),
      );
      const wrapper = withRegionScope(scope, () => toJS(makeEcho()) as (...a: unknown[]) => Promise<unknown>);
      expect(await wrapper(41)).toBe(41); // the real call still works, unaffected
      closeRegionScope(scope);

      const env = inferenceEnv.child("silent-mint");
      await registerSource(env);
      const trace = new EvalTrace();
      const result = await withRecordCoordinateAsync(RECORD_COORD, mintSink, () =>
        execStateOverFrame("(fetch-item)", { env, tap: trace }),
      );
      expect(toJS(result.values[0])).toBe(42); // real program result, unaffected
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(await trackStore.readStream(REGION)).toHaveLength(0);
    expect(await mintStore.readStream(REGION)).toHaveLength(0);
  });

  it("CONTROL — the identical setup WITHOUT a silent region DOES emit (proves the suppression above is doing real work, not a vacuous empty scenario)", async () => {
    setEmissionEnabled(true);
    const trackStore = new ProvenanceStoreFake();
    const trackSink: TrackEmissionSink = { store: trackStore, regionId: REGION };
    const mintStore = new ProvenanceStoreFake();
    const payloads = new PayloadStoreFake();
    const mintSink: EmissionSink = { store: mintStore, payloads, regionId: REGION };

    const scope = withTrackCoordinate(TRACK_COORD, trackSink, () =>
      openRegionScope({ runCtx: CONSTANT_CTX, dynSite: undefined }),
    );
    const wrapper = withRegionScope(scope, () => toJS(makeEcho()) as (...a: unknown[]) => Promise<unknown>);
    await wrapper(41);
    closeRegionScope(scope);

    const env = inferenceEnv.child("loud-mint");
    await registerSource(env);
    const trace = new EvalTrace();
    await withRecordCoordinateAsync(RECORD_COORD, mintSink, () =>
      execStateOverFrame("(fetch-item)", { env, tap: trace }),
    );

    await Promise.resolve();
    await Promise.resolve();

    expect(await trackStore.readStream(REGION)).toHaveLength(2); // one open + one close
    expect(await mintStore.readStream(REGION)).toHaveLength(1); // one mint
  });

  it("a coordinate installed FRESH, INSIDE a silent region's dynamic extent, still cannot emit — the leak-proof placement (task brief: 'a mint INSIDE a silent region must be impossible to emit even if a nested coordinate is installed')", async () => {
    setEmissionEnabled(true);
    const freshTrackStore = new ProvenanceStoreFake();
    const freshTrackSink: TrackEmissionSink = { store: freshTrackStore, regionId: "region-nested" };
    const freshMintStore = new ProvenanceStoreFake();
    const freshPayloads = new PayloadStoreFake();
    const freshMintSink: EmissionSink = { store: freshMintStore, payloads: freshPayloads, regionId: "region-nested" };

    await withSilentRegion(async () => {
      // A BRAND NEW coordinate/sink pair, installed FOR THE FIRST TIME inside the
      // silent extent — not the outer test's coordinate, not reused from anywhere.
      // If silence rode on the coordinate object instead of a separate ambient, this
      // fresh install would have nothing to inherit from and would emit freely.
      const scope = withTrackCoordinate(
        { templateHash: "th-nested", ordinalPath: [9], regionEpoch: "e-nested" },
        freshTrackSink,
        () => openRegionScope({ runCtx: CONSTANT_CTX, dynSite: undefined }),
      );
      const wrapper = withRegionScope(scope, () => toJS(makeEcho()) as (...a: unknown[]) => Promise<unknown>);
      await wrapper(1);
      closeRegionScope(scope);

      const env = inferenceEnv.child("silent-nested-mint");
      await registerSource(env);
      const trace = new EvalTrace();
      await withRecordCoordinateAsync(
        { templateHash: "th-nested", ordinalPath: [9], regionEpoch: "e-nested" },
        freshMintSink,
        () => execStateOverFrame("(fetch-item)", { env, tap: trace }),
      );
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(await freshTrackStore.readStream("region-nested")).toHaveLength(0);
    expect(await freshMintStore.readStream("region-nested")).toHaveLength(0);
  });

  it("doors still fire inside silent regions — escape and incomplete doors are unaffected by silence", async () => {
    setEmissionEnabled(true);
    await withSilentRegion(async () => {
      const scope = openRegionScope({ runCtx: CONSTANT_CTX, dynSite: undefined });
      const wrapper = withRegionScope(scope, () => toJS(makeEcho()) as (...a: unknown[]) => Promise<unknown>);

      // incomplete door: a call started but never awaited before close.
      const inFlight = wrapper(1);
      expect(() => closeRegionScope(scope)).toThrow(/reverse-lambda call.*incomplete/);
      await inFlight; // let it settle, no lingering unhandled rejection

      // escape door: a call attempted AFTER the scope closed.
      await expect(wrapper(2)).rejects.toThrow(/escaped its invocation/);
    });
  });

  it("host-schedule: accumulate-then-flush is ALSO fully suppressed under silence (never accumulates, never flushes)", async () => {
    setEmissionEnabled(true);
    const store = new ProvenanceStoreFake();
    const sink: TrackEmissionSink = { store, regionId: REGION };

    await withSilentRegion(async () => {
      const scope = withTrackCoordinate(TRACK_COORD, sink, () =>
        openRegionScope({ runCtx: CONSTANT_CTX, dynSite: undefined }),
      );
      recordHostScheduleVerdict(scope, [0], [1], -1);
      expect(scope.hostSchedule).toHaveLength(0); // never accumulated under silence
      closeRegionScope(scope);
    });

    await Promise.resolve();
    expect(await store.readStream(REGION)).toHaveLength(0);
  });

  it("nested silent-in-loud: entering silence mid-run suppresses only that extent — loud calls before and after are recorded, the silent call in between is not", async () => {
    setEmissionEnabled(true);
    const store = new ProvenanceStoreFake();
    const sink: TrackEmissionSink = { store, regionId: REGION };
    const scope = withTrackCoordinate(TRACK_COORD, sink, () =>
      openRegionScope({ runCtx: CONSTANT_CTX, dynSite: undefined }),
    );
    const wrapper = withRegionScope(scope, () => toJS(makeEcho()) as (...a: unknown[]) => Promise<unknown>);

    await wrapper(1); // loud — recorded
    await withSilentRegion(() => wrapper(2)); // silent — suppressed
    await wrapper(3); // loud again — recorded
    closeRegionScope(scope);

    await Promise.resolve();
    await Promise.resolve();

    const stream = await store.readStream(REGION);
    // Exactly TWO calls recorded (1 and 3), never three — call 2 left no trace despite
    // sharing the SAME scope/coordinate as the recorded calls either side of it.
    expect(stream.filter((r) => r.kind === "track-open")).toHaveLength(2);
    expect(stream.filter((r) => r.kind === "track-close")).toHaveLength(2);
  });

  it("nested loud-in-silent / silent-in-silent: silence dominates — a silent extent cannot be un-silenced from inside, and nesting never lifts it early", async () => {
    setEmissionEnabled(true);
    const store = new ProvenanceStoreFake();
    const sink: TrackEmissionSink = { store, regionId: REGION };

    expect(isSilentRegion()).toBe(false);
    await withSilentRegion(async () => {
      expect(isSilentRegion()).toBe(true);

      // "loud-in-silent": ordinary code, no extra silence API called — there is NO
      // primitive that would lower `_silentRegion` from inside, so this stays silent
      // purely because nothing can clear it.
      const scope = withTrackCoordinate(TRACK_COORD, sink, () =>
        openRegionScope({ runCtx: CONSTANT_CTX, dynSite: undefined }),
      );
      const wrapper = withRegionScope(scope, () => toJS(makeEcho()) as (...a: unknown[]) => Promise<unknown>);
      await wrapper(1);
      closeRegionScope(scope);

      // "silent-in-silent": nesting a SECOND withSilentRegion inside the first must
      // not restore to `false` when the inner one returns — it must restore to
      // whatever the OUTER extent's value was (`true`), never past it.
      await withSilentRegion(async () => {
        expect(isSilentRegion()).toBe(true);
      });
      expect(isSilentRegion()).toBe(true); // still silent — the inner return didn't leak
    });
    expect(isSilentRegion()).toBe(false); // restored once the OUTER extent actually returns

    await Promise.resolve();
    await Promise.resolve();
    expect(await store.readStream(REGION)).toHaveLength(0); // nothing from either nesting level
  });
});

describe("B. hermeticApply — γ = apply(wire, ingress) under a silent region (Q15)", () => {
  /** `(lambda (x) (inc x))`, `inc` a pure prelude helper — the SAME shape
   *  `wireframe-agreement.law.test.ts`'s landed Q7 row already proved end-to-end
   *  (`` `(${w.source} 41)` `` against `hermeticEnv([], p.prelude.source)`), here
   *  driven through `hermeticApply` instead of a hand-rolled application string. */
  const WIRE: EmittedWire = {
    source: "(lambda (x) (inc x))",
    params: ["x"],
    paramRefs: [{ kind: "slot", name: "x" }],
    span: "silent-region-test-wire",
  };
  const PRELUDE = "(define (inc n) (+ n 1))";

  it("computes the correct γ result: apply(wire, ingress) against Q7's hermetic env", async () => {
    const result = await hermeticApply({
      wire: WIRE,
      ingress: { x: new AExact(41) },
      basePacks: [],
      prelude: PRELUDE,
    });
    expect(result).toBe(42);
  });

  it("runs under a silent region for its ENTIRE async extent — isSilentRegion() is true the instant the call starts, false again once it settles", async () => {
    expect(isSilentRegion()).toBe(false);
    const pending = hermeticApply({
      wire: WIRE,
      ingress: { x: new AExact(1) },
      basePacks: [],
      prelude: PRELUDE,
    });
    // Synchronous continuation, before the returned promise settles — `withSilentRegion`
    // sets the flag BEFORE its first await suspends, so this is already true here.
    expect(isSilentRegion()).toBe(true);
    await pending;
    expect(isSilentRegion()).toBe(false);
  });

  it("a missing ingress binding for a declared wire param throws the teaching door, before ever reaching exec", async () => {
    await expect(hermeticApply({ wire: WIRE, ingress: {}, basePacks: [], prelude: PRELUDE })).rejects.toThrow(
      /no ingress binding was supplied/,
    );
  });
});

describe("C. glass whole-program replay — the SAME silent discipline generalizes (§4 V ruling)", () => {
  it("a real run mints; the identical program re-run under a silent region emits ZERO NEW records — 'penetration stream authoritative, re-run emits zero new records'", async () => {
    setEmissionEnabled(true);
    const store = new ProvenanceStoreFake();
    const payloads = new PayloadStoreFake();
    const sink: EmissionSink = { store, payloads, regionId: "region-glass" };

    // Real run — mints one record.
    const env1 = inferenceEnv.child("glass-real-run");
    await registerSource(env1);
    const trace1 = new EvalTrace();
    const real = await withRecordCoordinateAsync(RECORD_COORD, sink, () =>
      execStateOverFrame("(fetch-item)", { env: env1, tap: trace1 }),
    );
    expect(toJS(real.values[0])).toBe(42);

    await Promise.resolve();
    await Promise.resolve();
    expect(await store.readStream("region-glass")).toHaveLength(1);

    // "Replay" — the SAME program (a stand-in for whole-program re-run with
    // penetration playback; the real penetration-cache machinery is later product
    // work per the task brief — this row pins only the discipline), run again under
    // a silent region, at the SAME coordinate a real drill-in would reuse.
    const env2 = inferenceEnv.child("glass-replay-run");
    await registerSource(env2);
    const trace2 = new EvalTrace();
    const replayed = await withSilentRegion(() =>
      withRecordCoordinateAsync(RECORD_COORD, sink, () =>
        execStateOverFrame("(fetch-item)", { env: env2, tap: trace2 }),
      ),
    );
    expect(toJS(replayed.values[0])).toBe(42); // same behavior…

    await Promise.resolve();
    await Promise.resolve();
    // …but the stream is UNCHANGED — the identical rosetta crossing happened again,
    // and emitted nothing new.
    expect(await store.readStream("region-glass")).toHaveLength(1);
  });
});
