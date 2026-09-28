import { describe, expect, test } from "bun:test";
// The model walk over every area's draws (draws/, walk.ts), three walks per run. WALK_SEED=0x... replays one walk seed
// exactly, as the walk prints it; `bun diff/walk.ts --area <area>` walks one area.
import { drawnIn, worldIn } from "./draws/index.ts";
import { uncovered, walk, walkLine, walkSeeds } from "./walk.ts";

const WALK_SEED = process.env["WALK_SEED"];
const SEEDS = WALK_SEED === undefined ? walkSeeds(3) : [Number(WALK_SEED)];
const ROWS = drawnIn([]);
const WORLD = worldIn([]);

describe("model: every drawn Entity tx kind, og processRuntime vs the rewrite, frame by frame", () => {
  const seen = new Set<string>();
  SEEDS.forEach((seed) => {
    test(`MATCH: model walk, seed 0x${seed.toString(16)}`, async () => {
      const { coverage, diffs } = await walk(seed, ROWS, WORLD);
      coverage.entityTxs.forEach((k) => seen.add(k));
      console.log(walkLine(seed, coverage));
      expect(diffs).toEqual([]);
    }, 900_000);
  });
  test("the walks commit every drawn kind", () => {
    expect(uncovered(ROWS, seen)).toEqual([]);
  });
});
