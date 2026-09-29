/**
 * Q8c — WIREFRAME STRUCT-FACT WIRES rows (docs/PROVENANCE.md
 * §2 R2 + A5, §6 demand lattice). Unit rows for `builder.ts`'s `factTagOf` (the fact TAG
 * on a value wire — A5: "ONE edge species, a tag not a second kind") and `loops.ts`'s
 * `reachableNodesForDemand` (the count-demand router). Mirrors `wireframe-builder.test.ts`'s
 * harness (same synthetic classifier/base-name shape). The formal R2 demand-monotonicity
 * LAW rows stay staged `it.todo` in `__tests__/provenance/track-cone.law.test.ts` until
 * Q17 (query maturity) — this file exercises the MACHINERY Q8c actually lands.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { parse } from "../../eval/generator-exec.js";
import { inferenceEnv } from "../../env/inference-env.js";
import type { Classifier, DeclaredRole } from "../lineage.js";
import { buildWireframe } from "../wireframe/builder.js";
import { reachableNodes, reachableNodesForDemand } from "../wireframe/loops.js";
import type { Wire, WireframeGraph, WireframeProgram } from "../wireframe/types.js";

const ROLES: Record<string, DeclaredRole> = {
  "src-a": "source",
  "fetch-item": "source",
  "fetch-list": "source",
  "emit!": "sink",
  map: "fan",
  filter: "fan",
};
const C: Classifier = { roleOf: (op) => ROLES[op] };

const BASE = new Set([
  "+",
  "-",
  "*",
  ">",
  "positive?",
  "car",
  "cdr",
  "cons",
  "list",
  "append",
  "length",
  "vector-length",
  "string-length",
]);
const isBaseName = (n: string): boolean => BASE.has(n);

async function wf(code: string): Promise<WireframeProgram> {
  const forms = await parse(code);
  return buildWireframe(forms, { classifier: C, isBaseName });
}

const wireTo = (g: WireframeGraph, slot: string): Wire | undefined => g.wires.find((w) => w.consumer.slot === slot);

beforeAll(async () => {});

describe("factTagOf — the wire fact TAG (§2 A5: one edge species, a tag not a second kind)", () => {
  it("(length (map f xs)) — the out-port's egress wire is tagged fact:length", async () => {
    const p = await wf("(length (map (lambda (v) (+ (fetch-item v) 1)) xs))");
    const w = wireTo(p.main, "out");
    expect(w?.source).toBe("(lambda (in0) (length in0))");
    expect(w?.fact).toEqual({ kind: "fact", verb: "length" });
  });

  it('vector-length and string-length tag the SAME verb ("length") — one declared TERM, P8', async () => {
    const vec = await wf("(vector-length (map f xs))");
    const str = await wf("(string-length (map f xs))");
    expect(wireTo(vec.main, "out")?.fact).toEqual({ kind: "fact", verb: "length" });
    expect(wireTo(str.main, "out")?.fact).toEqual({ kind: "fact", verb: "length" });
  });

  it("(+ 1 (length xs)) is NOT tagged — the wire computes more than the fact", async () => {
    const p = await wf("(+ 1 (length xs))");
    const w = wireTo(p.main, "out");
    expect(w?.source).toBe("(lambda (xs) (+ 1 (length xs)))");
    expect(w?.fact).toBeUndefined();
  });

  it("a LOCALLY-shadowed `length` (a let-bound name) is NOT tagged — the wire's outer form is the let itself, so it fails the single-fact-read shape too", async () => {
    const p = await wf("(let ((length (lambda (z) 42))) (length xs))");
    const w = wireTo(p.main, "out");
    expect(w?.fact).toBeUndefined();
  });

  it("a lambda-PARAMETER-shadowed `length` (inside a fan's private template) is NOT tagged — isolates the `env.subst` guard directly (no let-wrapping this time: the wire body IS exactly `(length xs)`); the source TEXT alone is byte-IDENTICAL to the genuinely-tagged plain-slot row above, proving the fact tag carries information `source` cannot (hash.ts's Q8c touch note)", async () => {
    const p = await wf("(map (lambda (length) (length xs)) container)");
    const fan = p.main.nodes.find((n) => n.kind === "fan");
    if (fan?.kind !== "fan" || !fan.template) throw new Error("expected a fan node with a template");
    const w = wireTo(fan.template, "out");
    // unevalWire's own FV computation is UNAWARE of the builder's `env.subst`
    // shadowing (it only tracks LET-family `frames`, never lambda formals) — it
    // resolves the shadowed "length" as the BASE primitive BY NAME regardless, so
    // the emitted text is indistinguishable from an unshadowed `(length xs)` wire.
    // `factTagOf` reads the BUILDER's own `env.subst` (the source of truth for
    // shadowing) and correctly declines to tag despite the identical text.
    expect(w?.source).toBe("(lambda (xs) (length xs))");
    expect(w?.fact).toBeUndefined();
  });

  it("a `length` call whose contract is a port-reaching define (wireframe MATERIAL, not the base primitive) is never tagged — it cuts to a template-ref node instead", async () => {
    const p = await wf("(define (length x) (fetch-item x))\n(length xs)");
    expect(p.membership.wireframe.has("length")).toBe(true);
    expect(p.main.nodes.map((n) => n.kind)).toContain("template-ref");
    for (const w of p.main.wires) expect(w.fact).toBeUndefined();
  });

  it("length over a plain slot (no designated node) still tags — the fact concerns the OP, not what the operand resolves to", async () => {
    const p = await wf("(length xs)");
    const w = wireTo(p.main, "out");
    expect(w?.paramRefs).toEqual([{ kind: "slot", name: "xs" }]);
    expect(w?.fact).toEqual({ kind: "fact", verb: "length" });
  });

  it("(length (append xs ys)) tags too — the whole closed body is still exactly one fact read, regardless of the operand's internal shape", async () => {
    const p = await wf("(length (append xs ys))");
    const w = wireTo(p.main, "out");
    expect(w?.source).toBe("(lambda (xs ys) (length (append xs ys)))");
    expect(w?.fact).toEqual({ kind: "fact", verb: "length" });
  });
});

describe("reachableNodesForDemand — the count-demand router (§6 demand lattice; R2)", () => {
  it('"value" demand reproduces reachableNodes exactly (byte-stable, every existing caller)', async () => {
    const p = await wf("(emit! (length (map (lambda (v) (+ (fetch-item v) 1)) xs)))");
    const sinkIdx = p.main.nodes.findIndex((n) => n.kind === "sink");
    expect(reachableNodesForDemand(p.main, sinkIdx, "value")).toEqual(reachableNodes(p.main, sinkIdx));
  });

  it("a count-demand cone touches ZERO element wires: an untagged sibling branch off the SAME sink is excluded, the fact-tagged branch's fan is included", async () => {
    // arg0 = (length (map f (fetch-list))) — a fact-tagged wire into a length-
    // preserving fan whose OWN container comes from a designated `source` node.
    // arg1 = (car (filter g xs)) — an ordinary (untagged) wire into a DIFFERENT
    // fan — a genuine "element" wire (its consumer op, `car`, reads an element,
    // not a structural fact).
    const p = await wf("(emit! (length (map f (fetch-list))) (car (filter g xs)))");
    const sinkIdx = p.main.nodes.findIndex((n) => n.kind === "sink");
    const fans = p.main.nodes.reduce<number[]>((acc, n, i) => (n.kind === "fan" ? [...acc, i] : acc), []);
    expect(fans).toHaveLength(2);
    const sourceIdx = p.main.nodes.findIndex((n) => n.kind === "source");
    expect(sourceIdx).toBeGreaterThanOrEqual(0);

    const valueCone = reachableNodesForDemand(p.main, sinkIdx, "value");
    expect(valueCone).toEqual(new Set([sinkIdx, ...fans, sourceIdx])); // every node is reachable under full value demand

    const countCone = reachableNodesForDemand(p.main, sinkIdx, "count");
    // arg0's fan (the length-preserving one, reached via the fact-tagged wire) IS
    // in the cone, and so is ITS OWN container's source (R2's "structural producer"
    // carve-out) — but arg1's fan (reached only via the untagged `car` wire) is NOT.
    const mapFanIdx = p.main.nodes.findIndex((n) => n.kind === "fan" && n.lengthPreserving === true);
    const filterFanIdx = p.main.nodes.findIndex((n) => n.kind === "fan" && n.lengthPreserving === false);
    expect(countCone.has(mapFanIdx)).toBe(true);
    expect(countCone.has(sourceIdx)).toBe(true); // the structural producer, transitively
    expect(countCone.has(filterFanIdx)).toBe(false); // the element wire's fan — pruned
    expect(countCone).toEqual(new Set([sinkIdx, mapFanIdx, sourceIdx]));
  });

  it('V4 termination holds under "count" grade too — a synthetic index-level cycle still returns', () => {
    const cyclic: WireframeGraph = {
      nodes: [
        { kind: "recur", span: "a" },
        { kind: "recur", span: "b" },
      ],
      wires: [
        {
          source: "(lambda (x) x)",
          params: ["x"],
          paramRefs: [{ kind: "node", name: "x", node: 1 }],
          span: "w0",
          consumer: { node: 0, slot: "arg0" },
          fact: { kind: "fact", verb: "length" },
        },
        {
          source: "(lambda (x) x)",
          params: ["x"],
          paramRefs: [{ kind: "node", name: "x", node: 0 }],
          span: "w1",
          consumer: { node: 1, slot: "arg0" },
        },
      ],
      egress: null,
    };
    expect(reachableNodesForDemand(cyclic, 0, "value")).toEqual(new Set([0, 1]));
    // node 1's wire (into node 0) is fact-tagged, so count demand reaches node 1 too;
    // node 0's wire (into node 1) is untagged and node 1 is not a fan — pruned, but
    // node 1 is already visited by that point regardless.
    expect(reachableNodesForDemand(cyclic, 0, "count")).toEqual(new Set([0, 1]));
  });
});
