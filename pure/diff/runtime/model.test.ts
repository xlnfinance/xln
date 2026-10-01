import { describe, expect, test } from "bun:test";
// The model walk over every area's draws (draws/, walk.ts), three walks per run. WALK_SEED=0x... replays one walk seed
// exactly, as the walk prints it; `bun diff/walk.ts --area <area>` walks one area.
import { drawnIn, worldIn } from "../draws/index.ts";
import { KNOWN_FINDINGS } from "../findings/known.ts";
import { unfired } from "../rig/properties/fired.ts";
import { uncovered, walk, walkLine, walkSeeds } from "../walk.ts";

const WALK_SEED = process.env["WALK_SEED"];
/** Walks that found what the default seeds never drew: og reads a finalization's evidence back from the chain's calldata, and the shim must show it the batch the chain ran
 *  (rebound signatures), not the one og sealed (0x21284588, 0x2128458a: a finalization with a co-signed proof; review of #54 at c0b8dfb). */
const PINNED = [0x21284588, 0x2128458a];
/** The walks a registered finding sits on (findings/known.ts): a walk seed is not shifted by SEEDX, so each reproduces its finding under every SEEDX, and a finding that stops reproducing turns this red whichever sample the run draws. */
const REGISTERED = KNOWN_FINDINGS.flatMap((finding) => finding.sites.filter((site) => site.area === "model").map((site) => site.seed));
// A set: under SEEDX=12345 the default draw already contains 0x21284588 and 0x2128458a, and a walk run twice in one process meets its own persisted storage (same namespace).
const SEEDS = WALK_SEED === undefined ? [...new Set([...walkSeeds(3), ...PINNED, ...REGISTERED])] : [Number(WALK_SEED)];
const ROWS = drawnIn("all");
const WORLD = worldIn("all");

describe("model: every drawn Entity tx kind, og processRuntime vs the rewrite, frame by frame", () => {
  const seen = new Set<string>();
  const raised: Record<string, number>[] = [];
  SEEDS.forEach((seed) => {
    test(`MATCH: model walk, seed 0x${seed.toString(16)}`, async () => {
      const { coverage, diffs, known } = await walk(seed, ROWS, WORLD);
      coverage.entityTxs.forEach((k) => seen.add(k));
      raised.push(coverage.actions);
      console.log(walkLine(seed, coverage));
      known.forEach((k) => console.log(`KNOWN ${k}`));
      expect(diffs).toEqual([]);
    }, 900_000);
  });
  test("the walks commit every drawn kind", () => {
    expect(uncovered(ROWS, seen)).toEqual([]);
  });
  // a single replayed seed (WALK_SEED) need not fire every property
  test("every property that applies fires in the walks", () => {
    expect(WALK_SEED === undefined ? unfired("model", raised) : []).toEqual([]);
  });
});
