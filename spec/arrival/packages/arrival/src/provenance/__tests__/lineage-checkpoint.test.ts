import { CONSTANT_CTX } from "../../run/RunContext.js";
import type { EnvWithInternals, ResolvingAmbient } from "../../env/AmbientRuntime.js";
/**
 * CHECKPOINT for build-step 1 (design note §10) — the go/no-go for the IR.
 *
 * Two claims, measured against the REAL interpreter:
 *  1. Correctness — the static lineage skeleton + runtime leaf provenances
 *     derives the SAME cone the eager interpreter computes today (no loss).
 *  2. Memory — the lineage representation is O(program), not O(data): the static
 *     skeleton's node count is constant in the collection size, while the eager
 *     retained provenance scales O(N) (the pruneChildProvenance / 500k-cap pain).
 *
 * If (2) failed — if lineage didn't shrink the representation — the design says
 * STOP before building the IR. It doesn't fail.
 */
import { describe, it, expect } from "vitest";
import { parse, execStateOverFrame as execState } from "../../eval/generator-exec.js";
import { inferenceEnv } from "../../env/inference-env.js";
import { APair } from "../../values/primitives/APair.js";
import { classify, fullCone, type Classifier, type LineageNode, provOf } from "../../provenance/lineage.js";
import { sStr } from "../../__tests__/_lineage-test-helpers.js";
import { requireEagerOracle } from "../../__tests__/_require-eager-oracle.js";

// this helper/execState needs the eager oracle ON
requireEagerOracle();

const C: Classifier = {
  roleOf: (op) =>
    ["infer", "fetch", "db-read"].includes(op)
      ? "source"
      : ["map", "filter"].includes(op)
        ? "fan"
        : ["ext-call"].includes(op)
          ? "opaque"
          : undefined,
};

function countNodes(n: LineageNode): number {
  switch (n.kind) {
    case "literal":
    case "leaf":
    case "source":
      return 1;
    case "pipe":
      return 1 + countNodes(n.child);
    case "field":
      return 1 + countNodes(n.child);
    case "fan":
      return 1 + countNodes(n.source);
    case "mux":
      return 1 + countNodes(n.selector) + n.arms.reduce((a, arm) => a + countNodes(arm), 0);
    case "transparent":
      return 1 + countNodes(n.child);
    case "merge":
    case "opaque":
    case "sink":
    case "binder":
      return 1 + n.children.reduce((a, ch) => a + countNodes(ch), 0);
  }
}

describe("lineage checkpoint — runtime stamping derives the SAME cone (correctness)", () => {
  it("lineage full-cone == the eager interpreter's provenance, for (length (list a b c))", async () => {
    const env = inferenceEnv.child("lin-correct") as EnvWithInternals<ResolvingAmbient>;
    env.bind("a", sStr("a", 100));
    env.bind("b", sStr("b", 101));
    env.bind("c", sStr("c", 102));

    // execState (COMPLEX tier): `provOf` reads BOXED provenance (RULINGS.md R1).
    const [r] = (await execState(`(length (list a b c))`, { env })).values;
    const eager = provOf(r);

    // Static skeleton (no eval) + leaf provenances read from the env = "runtime stamping".
    const [ast] = await parse(`(length (list a b c))`);
    const skel = classify(ast, C);
    const bindings = { a: provOf(env.get("a")), b: provOf(env.get("b")), c: provOf(env.get("c")) };

    expect(eager).toEqual([100, 101, 102]);
    expect(fullCone(skel, bindings)).toEqual(eager);
  });
});

describe("lineage checkpoint — the static skeleton is constant in N (eager retained set is O(N) for a MINTED container)", () => {
  // `length` reads the CONTAINER's own flat grouping-fact stamp. For a MINTED
  // container (`list`), that stamp is the union of all N args' own provenance —
  // the eager retained set is genuinely O(N). Only a symbolic fact-wire makes
  // the general case O(1). The unminted fan-over-source case below is already O(1).
  async function eagerProvSize(n: number): Promise<number> {
    const env = inferenceEnv.child(`lin-scale-${n}`) as EnvWithInternals<ResolvingAmbient>;
    const names: string[] = [];
    for (let i = 0; i < n; i++) {
      const name = `e${i}`;
      env.bind(name, sStr(name, 1000 + i));
      names.push(name);
    }
    // MINTED (R2's constructor verb): `list` unions all N args' own provenance onto the
    // produced head (env/r7rs/lists.ts) — genuinely O(N) container-level provenance.
    const [r] = (await execState(`(length (list ${names.join(" ")}))`, { env })).values;
    return provOf(r).length; // the count's retained provenance set size
  }

  it("eager retained provenance scales O(N) with a MINTED collection's size — the remaining pain", async () => {
    expect(await eagerProvSize(3)).toBe(3);
    expect(await eagerProvSize(50)).toBe(50);
  });

  it("the static lineage skeleton node-count is CONSTANT — independent of N", async () => {
    const [ast] = await parse(`(length (map f xs))`);
    const nodes = countNodes(classify(ast, C)); // Pipe(length) -> Fan(f) -> Leaf(xs)
    expect(nodes).toBeLessThanOrEqual(4);
  });
});

describe("lineage checkpoint — C4 ALREADY achieves O(1) for the UNMINTED fan-over-source case", () => {
  // unminted fan: `length` over length-preserving `map` reads the container's own
  // (empty) stamp — O(1), not a deep union of N element ids
  async function unmintedFanProvSize(n: number): Promise<number> {
    const env = inferenceEnv.child(`lin-scale-unminted-${n}`) as EnvWithInternals<ResolvingAmbient>;
    const xs = APair.fromArray(
      CONSTANT_CTX,
      Array.from({ length: n }, (_, i) => sStr(`e${i}`, 1000 + i)),
      false,
    );
    env.bind("xs", xs);
    const [r] = (await execState(`(length (map (lambda (e) e) xs))`, { env })).values;
    return provOf(r).length;
  }

  it("eager retained provenance stays O(1) — ZERO — over an unminted fan source, independent of N", async () => {
    expect(await unmintedFanProvSize(3)).toBe(0);
    expect(await unmintedFanProvSize(50)).toBe(0);
  });
});
