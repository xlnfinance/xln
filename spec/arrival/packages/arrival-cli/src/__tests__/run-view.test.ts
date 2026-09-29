// run-view — the interactive-run nav model. `aggregateState` is a pure fold (unit-tested
// as a truth table); `runView` is exercised against REAL traces (run a program under a
// tap, assert the template nodes) so the 1:N template↔invocation reality is actually hit.
import { describe, expect, it } from "vitest";

import { execState } from "@inhuman.tools/arrival";
import { EvalTrace } from "@inhuman.tools/arrival/provenance";

import { aggregateState, runView, type TemplateNode } from "../run-view.js";

describe("aggregateState — the named aggregation rule", () => {
  it("empty is unreached (dim — no invocation yet)", () => {
    expect(aggregateState([])).toBe("unreached");
  });
  it("all resolved is done", () => {
    expect(aggregateState(["resolved", "resolved", "resolved"])).toBe("done");
  });
  it("any running (no rejection) is running", () => {
    expect(aggregateState(["resolved", "running", "resolved"])).toBe("running");
  });
  it("any rejected is error — it wins over running and done", () => {
    expect(aggregateState(["resolved", "rejected"])).toBe("error");
    expect(aggregateState(["running", "rejected", "resolved"])).toBe("error");
    expect(aggregateState(["rejected", "running"])).toBe("error");
  });
});

async function traced(src: string): Promise<EvalTrace> {
  const trace = new EvalTrace();
  await execState(src, { tap: trace, budgetMs: 30_000 });
  return trace;
}

function byHead(nodes: TemplateNode[], head: string): TemplateNode[] {
  return nodes.filter((n) => n.head === head);
}

describe("runView — real traces expose the 1:N multiplicity", () => {
  it("map over iota: the lambda body ran once per element (count 6, state done)", async () => {
    const nodes = runView(await traced("(map (lambda (n) (* n n)) (iota 6))"));
    const star = byHead(nodes, "*");
    expect(star).toHaveLength(1);
    expect(star[0]!.count).toBe(6);
    expect(star[0]!.state).toBe("done");
    // the map form itself ran once
    expect(byHead(nodes, "map")[0]!.count).toBe(1);
  });

  it("fib 10: the recursive call sites carry their real multiplicity", async () => {
    const nodes = runView(await traced("(define (fib n) (if (< n 2) n (+ (fib (- n 1)) (fib (- n 2)))))\n(fib 10)"));
    // the `if` runs 177 times — the count IS the depth-affordance
    const ifNode = byHead(nodes, "if")[0]!;
    expect(ifNode.count).toBe(177);
    expect(ifNode.state).toBe("done");
    // two distinct recursive call-site templates, each 88 — distinct scopes, not merged
    const fibCalls = byHead(nodes, "fib").filter((n) => n.count === 88);
    expect(fibCalls).toHaveLength(2);
    expect(new Set(fibCalls.map((n) => n.scope)).size).toBe(2);
  });

  it("nodes are source-ordered (line then col)", async () => {
    const nodes = runView(await traced("(define xs (list 1 2 3))\n(map (lambda (n) (* n n)) xs)"));
    for (let i = 1; i < nodes.length; i++) {
      const prev = nodes[i - 1]!;
      const cur = nodes[i]!;
      expect(prev.line < cur.line || (prev.line === cur.line && prev.col <= cur.col)).toBe(true);
    }
  });

  it("an error run marks the failing template error", async () => {
    // `(/ 1 0)` rejects the `/` invocation (car-of-nil is nil-tolerant and would NOT — the
    // kernel owns nil-tolerance; division-by-zero is a genuine fault). The run throws, but
    // the trace up to the fault is captured, and the aggregate over that template is error.
    const trace = new EvalTrace();
    await execState("(/ 1 0)", { tap: trace, budgetMs: 30_000 }).catch((err: unknown) => {
      expect(err).toBeInstanceOf(Error);
    });
    const nodes = runView(trace);
    const div = nodes.find((n) => n.head === "/");
    expect(div?.state).toBe("error");
  });
});
