/**
 * LAW — the first-class RUN CACHE (R2, arrival-mcp-rework-over-phases.md §2.2,
 * Q1/Q2 + Rulings A/B/D1). A run's durable twin is `(program, cache)`; these rows pin
 * the mode law at the ONE interception chokepoint (the baked rosetta `run` wrapper,
 * gated on the R1 cache class + the `sink` lineage role) plus the normative
 * `canonicalJson`/`runCacheKey` content-keying algorithm.
 *
 * The doc's R2 gate rows, one `it` each:
 *   - record-then-replay answers a `view` without re-firing (spy)
 *   - record mode ALWAYS fires and a live `view` overwrites its slot
 *   - concurrent identical view/pure penetrations share ONE impl call (D1's
 *     single-flight); two identical sink calls fire TWICE
 *   - sink tombstone skips on replay; sink miss fires
 *   - `pure` and unclassified nodes always fire
 *   - a rejected promise evicts its pending entry (retry allowed, never a pinned error)
 *   - key stability under arg-object key order
 *   (epoch/roster/configDigest identity is R3's — the SESSION layer validates a cache
 *   before handing it to a run; deliberately no rows here.)
 */
import { describe, it, expect } from "vitest";
import * as z from "../../common/scheme-zod/index.js";
import { symbol } from "../../symbol/index.js";
import { testCallCtx } from "../CallCtx.js";

import { EnvCapability } from "../../common/capability.js";
import { exec } from "../../eval/generator-exec.js";
import { RunContext, CONSTANT_CTX } from "../../run/RunContext.js";
import { MemoryRunCache, canonicalJson, runCacheKey } from "../../run/run-cache.js";
import { AExact } from "../../values/primitives/AExact.js";

const num = (n: number) => new AExact(n);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Invoke a baked rosetta procedure via its apply term (the sole membrane spine). */
function fire(proc: { ["arrival/tagless-final/apply"](args: any[], callCtx: any): any }, callCtx: any, ...args: any[]) {
  return proc["arrival/tagless-final/apply"](args, callCtx);
}

describe("canonicalJson — the normative algorithm (§2.2)", () => {
  it("object keys recursively sorted; arrays order-preserving; numbers as plain JSON", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1])); // arrays are ORDERED — never sorted
    expect(canonicalJson([1.5, -0.25, 42])).toBe("[1.5,-0.25,42]");
    expect(canonicalJson("x")).toBe('"x"');
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(true)).toBe("true");
  });

  it("refuses what JSON cannot represent — the caller owns the fallback, never a silent lossy key", () => {
    expect(() => canonicalJson(undefined)).toThrow(TypeError); // "undefined cannot occur (zod output)"
    expect(() => canonicalJson(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalJson(() => 1)).toThrow(TypeError);
    expect(() => canonicalJson(new Map())).toThrow(TypeError); // non-plain object
    expect(() => canonicalJson({ a: undefined })).toThrow(TypeError);
  });
});

describe("runCacheKey — content addressing (node, args), never position", () => {
  it("is stable under arg-object key order", () => {
    expect(runCacheKey("op", [{ b: 1, a: [1, 2] }])).toBe(runCacheKey("op", [{ a: [1, 2], b: 1 }]));
  });

  it("separates by symbol name and by args content", () => {
    expect(runCacheKey("op-a", [1])).not.toBe(runCacheKey("op-b", [1]));
    expect(runCacheKey("op", [1])).not.toBe(runCacheKey("op", [2]));
  });
});

// ── wrapper-level rows: the REAL chokepoint (def.run), driven directly ─────────

/** Bake a fresh view/pure/sink def around a spy impl; return { def, fires() }. */
function viewDef(name: string, impl?: (n: number) => Promise<number> | number) {
  let fires = 0;
  const def = symbol.rosetta`${name}: `(
    { input: [z.number], output: [z.number], cacheClass: "view" },
    async (n: number) => {
      fires++;
      return impl ? impl(n) : n * 2;
    },
  );
  return { def, fires: () => fires };
}

const ctxWith = (cache: MemoryRunCache) => testCallCtx({ runCtx: new RunContext({ cache }) });

describe("single-flight (D1) + eviction — at the wrapper", () => {
  it("concurrent identical `view` penetrations share ONE impl call", async () => {
    const { def, fires } = viewDef("rc-view-concurrent", async (n) => {
      await sleep(10);
      return n * 2;
    });
    const cache = new MemoryRunCache("record");
    const ctx = ctxWith(cache);
    const [a, b] = await Promise.all([fire(def, ctx, num(21)), fire(def, ctx, num(21))]);
    expect(fires()).toBe(1); // ONE rosetta call, two consumers
    expect(Number(a)).toBe(42);
    expect(Number(b)).toBe(42);
    expect(cache.entries.size).toBe(1); // the settled {value} entry
  });

  it("concurrent identical `pure` penetrations share ONE impl call — and NOTHING serializes", async () => {
    let fires = 0;
    const def = symbol.rosetta`rc-pure-concurrent: `(
      { input: [z.number], output: [z.number], cacheClass: "pure" },
      async (n: number) => {
        fires++;
        await sleep(10);
        return n + 1;
      },
    );
    const cache = new MemoryRunCache("record");
    const ctx = ctxWith(cache);
    await Promise.all([fire(def, ctx, num(1)), fire(def, ctx, num(1))]);
    expect(fires).toBe(1);
    expect(cache.entries.size).toBe(0); // pure is NEVER persisted — recovery = re-call
  });

  it("two identical `sink` calls fire TWICE — a live effect is never deduped", async () => {
    let fires = 0;
    const def = symbol.rosetta`rc-sink-twice: `(
      { input: [z.number], output: [z.undefinedResult], provenance: "sink" },
      async (_n: number) => {
        fires++;
        await sleep(5);
        return undefined;
      },
    );
    const cache = new MemoryRunCache("record");
    const ctx = ctxWith(cache);
    await Promise.all([fire(def, ctx, num(7)), fire(def, ctx, num(7))]);
    expect(fires).toBe(2); // two effects, always — no single-flight for sinks
    expect(cache.entries.size).toBe(1); // one tombstone (single-slot LWW)
  });

  it("a rejected promise EVICTS its pending entry — retries allowed, a transient failure never pins", async () => {
    let calls = 0;
    const { def, fires } = viewDef("rc-view-evict", (n) => {
      if (++calls === 1) throw new Error("transient");
      return n * 2;
    });
    const cache = new MemoryRunCache("record");
    const ctx = ctxWith(cache);
    await expect(fire(def, ctx, num(21))).rejects.toThrow("transient");
    expect(cache.entries.size).toBe(0); // rejections are NEVER cached
    await fire(def, ctx, num(21)); // the retry fires fresh
    expect(fires()).toBe(2);
    expect(cache.entries.size).toBe(1); // only the SETTLED entry serialized
  });

  it("record mode ALWAYS fires — a live `view` overwrites its slot (fresh truth, never suppressed)", async () => {
    let stamp = 0;
    const { def, fires } = viewDef("rc-view-overwrite", () => ++stamp);
    const cache = new MemoryRunCache("record");
    const ctx = ctxWith(cache);
    await fire(def, ctx, num(21));
    await fire(def, ctx, num(21)); // identical penetration, SEQUENTIAL — a settled entry never suppresses a live fire
    expect(fires()).toBe(2);
    const [entry] = [...cache.entries.values()];
    expect(entry).toEqual({ kind: "value", value: 2 }); // last write won the slot
  });
});

// ── e2e rows: record-then-replay through the real exec seam ────────────────────

/** One capability with all four classes, each around its own spy. */
function fixture() {
  const counts = { view: 0, pure: 0, sink: 0, plain: 0 };
  const cap = EnvCapability.define("test/run-cache", {
    symbols: (symbol, z) => ({
      peek: symbol.rosetta`peek: a boundary snapshot`(
        { input: [z.number], output: [z.number], cacheClass: "view" },
        (n: number) => {
          counts.view++;
          return n * 2;
        },
      ),
      calc: symbol.rosetta`calc: contractually deterministic`(
        { input: [z.number], output: [z.number], cacheClass: "pure" },
        (n: number) => {
          counts.pure++;
          return n + 100;
        },
      ),
      "fire!": symbol.rosetta`fire!: an effect`(
        { input: [z.number], output: [z.undefinedResult], provenance: "sink" },
        (_n: number) => {
          counts.sink++;
          return undefined;
        },
      ),
      plain: symbol.rosetta`plain: unclassified`({ input: [z.number], output: [z.number] }, (n: number) => {
        counts.plain++;
        return n - 1;
      }),
    }),
  });
  return { cap, counts };
}

describe("record → replay through exec (the session fold's substrate)", () => {
  it("record-then-replay answers a `view` without re-firing — and lands on the recorded value", async () => {
    const { cap, counts } = fixture();
    const record = new MemoryRunCache("record");
    const [recorded] = await exec("(peek 21)", { capabilities: [cap], cache: record });
    expect(recorded).toBe(42);
    expect(counts.view).toBe(1);

    const replay = new MemoryRunCache("replay", record.entries);
    const [replayed] = await exec("(peek 21)", { capabilities: [cap], cache: replay });
    expect(replayed).toBe(42); // served from the cache, re-encoded through the live membrane
    expect(counts.view).toBe(1); // NOT re-fired
  });

  it("a replay `view` MISS fires and writes — a NEW program's novel call penetrates fresh (Q2)", async () => {
    const { cap, counts } = fixture();
    const replay = new MemoryRunCache("replay");
    const [v] = await exec("(peek 5)", { capabilities: [cap], cache: replay });
    expect(v).toBe(10);
    expect(counts.view).toBe(1);
    expect(replay.entries.size).toBe(1); // the miss recorded itself
  });

  it("a `sink` tombstone skips on replay (void, zero effects); a sink MISS fires (new intent)", async () => {
    const { cap, counts } = fixture();
    const record = new MemoryRunCache("record");
    await exec("(fire! 1)", { capabilities: [cap], cache: record });
    expect(counts.sink).toBe(1);

    const replay = new MemoryRunCache("replay", record.entries);
    await exec("(fire! 1)", { capabilities: [cap], cache: replay }); // tombstone hit
    expect(counts.sink).toBe(1); // skipped — the effect already happened in the recorded run
    await exec("(fire! 2)", { capabilities: [cap], cache: replay }); // novel effect statement
    expect(counts.sink).toBe(2); // a miss is new intent, not a repeat
  });

  it("`pure` fires in BOTH modes — determinism from args is the CONTRACT (Ruling B), never a stored entry", async () => {
    const { cap, counts } = fixture();
    const record = new MemoryRunCache("record");
    await exec("(calc 1)", { capabilities: [cap], cache: record });
    const replay = new MemoryRunCache("replay", record.entries);
    const [v] = await exec("(calc 1)", { capabilities: [cap], cache: replay });
    expect(v).toBe(101);
    expect(counts.pure).toBe(2); // re-fired on replay — safe and cheap by the worker's promise
    expect([...record.entries.values()].every((e) => e.kind === "effect" || e.kind === "value")).toBe(true);
    expect(record.entries.size).toBe(0); // pure never serialized
  });

  it("an UNCLASSIFIED verb always fires and never touches the serialized cache — the safe default", async () => {
    const { cap, counts } = fixture();
    const record = new MemoryRunCache("record");
    await exec("(plain 1)", { capabilities: [cap], cache: record });
    expect(record.entries.size).toBe(0);
    const replay = new MemoryRunCache("replay", record.entries);
    const [v] = await exec("(plain 1)", { capabilities: [cap], cache: replay });
    expect(v).toBe(0);
    expect(counts.plain).toBe(2); // regenerateable: re-runs on replay
  });

  it("a run with NO cache is byte-identical to today — the membrane is untouched", async () => {
    const { cap, counts } = fixture();
    const [v] = await exec("(peek 3)", { capabilities: [cap] });
    expect(v).toBe(6);
    expect(counts.view).toBe(1);
  });
});
