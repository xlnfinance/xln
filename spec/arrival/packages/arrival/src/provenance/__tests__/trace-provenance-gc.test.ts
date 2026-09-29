/**
 * `EvalTrace.clear()` / `.points()` / `.stats()` — explicit provenance GC.
 *
 * A static audit found the OOM driver in benchmark use: a provenance-POINT invocation
 * retains the FULL post-jsToScheme-boxed tool result forever (`#pruneChildProvenance`
 * deliberately exempts point values — `invocationById`/`toolNameFor` need to walk back
 * to a point's own resolved value). Entry cap was the only bound (`DEFAULT_TRACE_CAP`),
 * with zero byte accounting. A 100-call task with multi-MB text responses pins hundreds
 * of MB until the isolate dies.
 *
 * This pins the mechanism-only fix: `points()` (enumerate before you lose the graph),
 * `clear()` (drop the graph, keep the id counter monotonic forever), `stats()` (an
 * honest memory estimate so a caller can decide WHEN to call `clear()`), and a
 * constructor `startId` floor for the process-restart seam. Ledger-building and
 * value-prefix capping are consumer POLICY — that lives in arrival-manifold, not here.
 */
import { describe, expect, it } from "vitest";

import { EnvCapability } from "../../common/capability.js";
import { execState } from "../../eval/generator-exec.js";
import { toJS } from "../../membrane/rosetta.js";
import { EvalTrace } from "../trace.js";

/** One provenance-source tool that mints a large string — the retained-value shape a
 *  multi-MB tool response actually takes. */
function bigTextCapability(size: number) {
  return EnvCapability.define("test/big-text", {
    symbols: (symbol, z) => ({
      "big-text": symbol.rosetta`big-text: a tool response big enough to matter for byte accounting`(
        { input: [], output: [z.string], provenance: "source" },
        async () => "x".repeat(size),
      ),
    }),
  });
}

describe("EvalTrace.stats() / .points() / .clear() — explicit provenance GC", () => {
  it("a provenance point retains its full value until clear() drops it", async () => {
    const trace = new EvalTrace();
    const cap = bigTextCapability(1_000_000);
    const { values } = await execState(`(big-text)`, { capabilities: [cap], tap: trace });
    expect(toJS(values[0])).toHaveLength(1_000_000);

    const before = trace.stats();
    expect(before.points).toBe(1);
    expect(before.entries).toBeGreaterThanOrEqual(1);
    // 1_000_000 UTF-16 code units × 2 bytes/unit, plus flat overhead — comfortably over 1.5MB.
    expect(before.retainedValueBytes).toBeGreaterThan(1_900_000);

    // Extract what a consumer needs BEFORE the graph is dropped.
    const points = [...trace.points()];
    expect(points).toHaveLength(1);
    expect(points[0]!.toolName).toBe("big-text");
    expect(points[0]!.invocation.value).toBeDefined();

    trace.clear();

    const after = trace.stats();
    expect(after).toEqual({ entries: 0, points: 0, retainedValueBytes: 0 });
    // Enumerating after clear() finds nothing — the graph is gone.
    expect([...trace.points()]).toHaveLength(0);
  });

  it("id monotonicity across a clear(): mint → clear → mint, ids strictly increasing", async () => {
    const trace = new EvalTrace();
    const cap = bigTextCapability(10);

    const { values: first } = await execState(`(big-text)`, { capabilities: [cap], tap: trace });
    const firstId = [...trace.points()][0]!.id;
    expect(toJS(first[0])).toBe("xxxxxxxxxx");

    trace.clear();
    // Old id is gone — the invocation that minted it no longer exists in this trace.
    expect(trace.invocationById(firstId)).toBeUndefined();

    const { values: second } = await execState(`(big-text)`, { capabilities: [cap], tap: trace });
    const secondId = [...trace.points()][0]!.id;
    expect(toJS(second[0])).toBe("xxxxxxxxxx");

    expect(secondId).toBeGreaterThan(firstId);
    // New id resolves fine post-clear.
    expect(trace.invocationById(secondId)?.value).toBeDefined();
    expect(trace.toolNameFor(secondId)).toBe("big-text");
  });

  it("clear() is guarded — throws if called while an invocation is still running", async () => {
    const trace = new EvalTrace();
    let threw = false;
    const guarded = EnvCapability.define("test/guarded", {
      symbols: (symbol, z) => ({
        "mid-run": symbol.rosetta`mid-run: calls clear() on its OWN still-open trace mid-call`(
          { input: [], output: [z.string], provenance: "source" },
          async () => {
            try {
              trace.clear();
            } catch {
              threw = true;
            }
            return "ok";
          },
        ),
      }),
    });
    const { values } = await execState(`(mid-run)`, { capabilities: [guarded], tap: trace });
    expect(toJS(values[0])).toBe("ok");
    expect(threw).toBe(true);
    // Once the run has actually finished (no invocation open), clear() is legal.
    expect(() => trace.clear()).not.toThrow();
  });

  it("startId floors the id counter for a fresh trace continuing a prior instance", async () => {
    const trace = new EvalTrace(500_000, 1_000);
    expect(trace.invocationById(999)).toBeUndefined();

    const cap = bigTextCapability(5);
    const { values } = await execState(`(big-text)`, { capabilities: [cap], tap: trace });
    expect(toJS(values[0])).toBe("xxxxx");

    const [point] = [...trace.points()];
    expect(point!.id).toBeGreaterThanOrEqual(1_000);
    expect(trace.invocationById(point!.id)?.value).toBeDefined();
    // Ids below the floor are never resolvable — this instance never minted them.
    expect(trace.invocationById(0)).toBeUndefined();
  });

  it("an id the trace never minted resolves undefined, never a throw", () => {
    const trace = new EvalTrace();
    expect(trace.invocationById(999)).toBeUndefined();
    expect(trace.toolNameFor(999)).toBeUndefined();
    expect(trace.stats()).toEqual({ entries: 0, points: 0, retainedValueBytes: 0 });
  });
});
