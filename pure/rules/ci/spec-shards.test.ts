// The Arrival suite runs as shards in CI (SHARD=k/n node test.mjs): together they run every case once, the heavy case alone in shard 0.
// The partition lives in spec/tools/shard.mjs, plain JS that the spec's own test.mjs imports, so it is run here through node.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const spec = `${import.meta.dir}/../../../spec`;

const node = (code: string): unknown => {
  const done = Bun.spawnSync(["node", "--input-type=module", "-e", `import { casesOfShard, parseShard, shardOf } from "./tools/shard.mjs";\n${code}`], { cwd: spec });
  if (done.exitCode !== 0) throw new Error(done.stderr.toString());
  return JSON.parse(done.stdout.toString());
};

// 40 cases; case 7 is heavy.
const CASES = "Array.from({ length: 40 }, (_, i) => ({ heavy: i === 7 }))";

describe("the partition", () => {
  test("R-GATE-SPEC-SHARDS the shards together run each case exactly once, for one shard and for three or more", () => {
    [1, 3, 4, 5, 9].forEach((shards) => {
      const all = node(`const cases = ${CASES}; console.log(JSON.stringify(Array.from({ length: ${shards} }, (_, shard) => casesOfShard(cases, { shard, shards: ${shards} }))))`) as number[][];
      expect(all.flat().sort((a, b) => a - b), `${shards} shards`).toEqual(Array.from({ length: 40 }, (_, i) => i));
    });
  });

  test("R-GATE-SPEC-SHARDS the heavy case is shard 0 alone, and every other shard has cases of its own", () => {
    const all = node(`const cases = ${CASES}; console.log(JSON.stringify(Array.from({ length: 4 }, (_, shard) => casesOfShard(cases, { shard, shards: 4 }))))`) as number[][];
    expect(all[0]).toEqual([7]);
    all.slice(1).forEach((shard) => expect(shard.length).toBeGreaterThan(10));
  });

  test("R-GATE-SPEC-SHARDS no SHARD is the whole suite, and a shard that is not k/n with 0 <= k < n, or n = 2, is refused", () => {
    expect(node('console.log(JSON.stringify(parseShard(undefined)))')).toEqual({ shard: 0, shards: 1 });
    expect(node('console.log(JSON.stringify(parseShard("2/4")))')).toEqual({ shard: 2, shards: 4 });
    ["3/3", "-1/4", "a/b", "1/2", "0/0", "1.5/4", ""].forEach((text) => {
      const done = Bun.spawnSync(["node", "--input-type=module", "-e", `import { parseShard } from "./tools/shard.mjs"; parseShard(${JSON.stringify(text)})`], { cwd: spec });
      expect(done.exitCode, text).not.toBe(0);
    });
  });

  test("R-GATE-SPEC-SHARDS the shard of a case does not move when other cases are added after it", () => {
    expect(node("console.log(JSON.stringify([shardOf(5, false, 4), shardOf(5, false, 4), shardOf(6, false, 4), shardOf(7, true, 4)]))")).toEqual([3, 3, 1, 0]);
  });
});

describe("the real suite", () => {
  const source = readFileSync(`${spec}/test.mjs`, "utf8");

  test("R-GATE-SPEC-SHARDS test.mjs runs the cases of its shard only, and has a heavy case to put in shard 0", () => {
    expect(source).toContain("casesOfShard(cases, shard)");
    expect(source).toContain("parseShard(process.env.SHARD)");
    expect(source.match(/heavy: true/g)).toHaveLength(1);
    expect(source).toContain("has no case to run");
  });
});
