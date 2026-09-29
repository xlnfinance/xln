/**
 * LAW — temporal immutability domain (inter-query coherence).
 *
 * Door only when an effect intervenes BETWEEN two overlapping queries on a
 * shared domain. Bare E→Q / E→Q→E / E→Q→Q are LEGAL. Classic priorE∩thisQ is
 * SUPERSEDED (law-identity wave). Paths from contract producers after decode,
 * never from impl return.
 *
 * Suite: docs/working-proposals/cqs-reactivity/test-suite-design/SUITE.md
 * Law-identity: docs/working-proposals/cqs-reactivity/test-suite-design/law-identity/
 */
import { describe, it, expect } from "vitest";
import { EnvCapability } from "../../common/capability.js";
import { exec } from "../../eval/generator-exec.js";
import { CONSTANT_CTX, RunContext } from "../RunContext.js";
import { MemoryRunCache } from "../run-cache.js";
import { MemoryEffectLog } from "../effect-log.js";
import { testCallCtx } from "../CallCtx.js";
import {
  MemoryResourcePathLog,
  ResourcePathConflictError,
  ResourcePathProducerError,
  applyResourcePathCqs,
  type ResourcePathLog,
} from "../resource-paths.js";
import type { ResourcePath } from "../path-algebra.js";

// ── Fake capability family (SUITE §Fake capability family) ───────────────────

type SpyMap = Record<string, number>;

function makePathCap(spies: SpyMap, opts?: { pathFnThrow?: "queries" | "effects" }) {
  const pathFnCalls: { axis: "q" | "e"; name: string }[] = [];
  const appendEvents: ResourcePath[][] = [];
  const base = new MemoryResourcePathLog();

  /** Test-only append-on-pass spy (R-HARNESS-SPY) — records only when product records. */
  const pathLog: ResourcePathLog = {
    get events() {
      return base.events;
    },
    get effectPaths() {
      return base.effectPaths;
    },
    recordQueries(paths) {
      base.recordQueries(paths);
    },
    recordEffects(paths) {
      appendEvents.push(paths.map((p) => [...p]));
      base.recordEffects(paths);
    },
  };

  const track = (name: string) => {
    spies[name] = (spies[name] ?? 0) + 1;
  };

  const q =
    (name: string, fn: (...a: string[]) => ResourcePath[]) =>
    (...a: string[]) => {
      pathFnCalls.push({ axis: "q", name });
      if (opts?.pathFnThrow === "queries") throw new Error("path-fn-queries-boom");
      return fn(...a);
    };
  const e =
    (name: string, fn: (...a: string[]) => ResourcePath[]) =>
    (...a: string[]) => {
      pathFnCalls.push({ axis: "e", name });
      if (opts?.pathFnThrow === "effects") throw new Error("path-fn-effects-boom");
      return fn(...a);
    };

  const cap = EnvCapability.define("test/resource-path-cqs", {
    symbols: (symbol, z) => ({
      read: symbol.rosetta`read: `(
        {
          input: [z.string, z.string],
          output: [z.string],
          queries: q("read", (d, id) => [["test", d, id]]),
        },
        (d: string, id: string) => {
          track("read");
          return `${d}:${id}`;
        },
      ),
      "read-all": symbol.rosetta`read-all: `(
        {
          input: [z.string],
          output: [z.string],
          queries: q("read-all", (d) => [["test", d]]),
        },
        (d: string) => {
          track("read-all");
          return `all:${d}`;
        },
      ),
      write: symbol.rosetta`write: `(
        {
          input: [z.string, z.string],
          output: [z.undefinedResult],
          effects: e("write", (d, id) => [["test", d, id]]),
        },
        (_d: string, _id: string) => {
          track("write");
          return undefined;
        },
      ),
      "write-all": symbol.rosetta`write-all: `(
        {
          input: [z.string],
          output: [z.undefinedResult],
          effects: e("write-all", (d) => [["test", d]]),
        },
        (_d: string) => {
          track("write-all");
          return undefined;
        },
      ),
      "write-many": symbol.rosetta`write-many: `(
        {
          input: [z.string, z.string, z.string],
          output: [z.undefinedResult],
          effects: e("write-many", (d, id1, id2) => [
            ["test", d, id1],
            ["test", d, id2],
          ]),
        },
        () => {
          track("write-many");
          return undefined;
        },
      ),
      "read-many": symbol.rosetta`read-many: `(
        {
          input: [z.string, z.string, z.string],
          output: [z.string],
          queries: q("read-many", (d, id1, id2) => [
            ["test", d, id1],
            ["test", d, id2],
          ]),
        },
        (d: string, id1: string, id2: string) => {
          track("read-many");
          return `${d}:${id1}+${id2}`;
        },
      ),
      upsert: symbol.rosetta`upsert: `(
        {
          input: [z.string, z.string],
          output: [z.string],
          queries: q("upsert", (d, id) => [["test", d, id]]),
          effects: e("upsert", (d, id) => [["test", d, id]]),
        },
        (d: string, id: string) => {
          track("upsert");
          return `row:${d}:${id}`;
        },
      ),
      move: symbol.rosetta`move: `(
        {
          input: [z.string, z.string],
          output: [z.undefinedResult],
          // Q = src tree, E = dst tree (disjoint hybrid)
          queries: q("move", (src) => [["test", src]]),
          effects: e("move", (_src, dst) => [["test", dst]]),
        },
        () => {
          track("move");
          return undefined;
        },
      ),
      noop: symbol.rosetta`noop: `({ input: [z.string], output: [z.string] }, (x: string) => {
        track("noop");
        return x;
      }),
      "fail-impl": symbol.rosetta`fail-impl: `(
        {
          input: [z.string],
          output: [z.undefinedResult],
          effects: e("fail-impl", (d) => [["test", d]]),
        },
        () => {
          track("fail-impl");
          throw new Error("plain-impl-boom");
        },
      ),
      // Path fns name nothing under test/D; impl "would" touch D — must not feed prior E.
      "impl-only-touch": symbol.rosetta`impl-only-touch: `(
        {
          input: [z.string],
          output: [z.undefinedResult],
          // empty contribution: declared axis present but no path (R-O6: fn called)
          effects: e("impl-only-touch", () => []),
        },
        () => {
          track("impl-only-touch");
          // would touch ["test","D"] in a real host — paths not from impl
          return undefined;
        },
      ),
      // Decode non-trivial: raw id "raw:42" → decoded segment "42"
      "read-decoded": symbol.rosetta`read-decoded: `(
        {
          input: [z.string, z.string.transform((s) => (s.startsWith("raw:") ? s.slice(4) : s))],
          output: [z.string],
          queries: q("read-decoded", (d, id) => [["test", d, id]]),
        },
        (d: string, id: string) => {
          track("read-decoded");
          return `${d}:${id}`;
        },
      ),
      "write-decoded": symbol.rosetta`write-decoded: `(
        {
          input: [z.string, z.string.transform((s) => (s.startsWith("raw:") ? s.slice(4) : s))],
          output: [z.undefinedResult],
          effects: e("write-decoded", (d, id) => [["test", d, id]]),
        },
        () => {
          track("write-decoded");
          return undefined;
        },
      ),
    }),
  });

  return { cap, pathLog, pathFnCalls, appendEvents };
}

async function run(
  code: string,
  spies: SpyMap = {},
  extra?: { pathFnThrow?: "queries" | "effects"; pathLog?: ResourcePathLog },
) {
  const { cap, pathLog, pathFnCalls, appendEvents } = makePathCap(spies, {
    pathFnThrow: extra?.pathFnThrow,
  });
  const log = extra?.pathLog ?? pathLog;
  const runCtx = new RunContext({ resourcePaths: log });
  const result = await exec(code, { capabilities: [cap], runCtx });
  return { result, spies, pathFnCalls, appendEvents, pathLog: log };
}

function expectDoor(err: unknown): asserts err is ResourcePathConflictError {
  expect(err).toBeInstanceOf(ResourcePathConflictError);
}

/** A-QUAD: discriminator; doored impl=0; doored symbol's path fns ran; prior impls unchanged. */
function aQuad(
  err: unknown,
  spies: SpyMap,
  pathFnCalls: { axis: "q" | "e"; name: string }[],
  dooredSymbol: string,
  priorSpies: SpyMap,
) {
  expectDoor(err);
  expect((err as ResourcePathConflictError)["arrival/error-category"]).toBe("domain-immutability");
  expect(spies[dooredSymbol] ?? 0).toBe(0);
  expect(pathFnCalls.some((c) => c.name === dooredSymbol)).toBe(true);
  for (const [k, v] of Object.entries(priorSpies)) {
    expect(spies[k] ?? 0).toBe(v);
  }
}

// ── S1 Core positives ────────────────────────────────────────────────────────

describe("resource-path CQS door — core positives", () => {
  it("P-I3 — effects only, repeats / overlapping E never door", async () => {
    const spies: SpyMap = {};
    await run('(write "a" "1") (write "a" "1") (write-all "a")', spies);
    expect(spies.write).toBe(2);
    expect(spies["write-all"]).toBe(1);
  });

  it("P-I4 — read then write same tree", async () => {
    const spies: SpyMap = {};
    await run('(read "a" "1") (write "a" "1")', spies);
    expect(spies.read).toBe(1);
    expect(spies.write).toBe(1);
  });

  it("P-I4b — use query result after effects (no second read)", async () => {
    const spies: SpyMap = {};
    const { result } = await run('(define r (read "a" "1")) (write "a" "1") r', spies);
    expect(spies.read).toBe(1);
    expect(spies.write).toBe(1);
    // last form is held binding from first read — value is domain:id
    expect(result.at(-1)).toBe("a:1");
  });

  it("P-I2 — sibling write then read", async () => {
    const spies: SpyMap = {};
    await run('(write "a" "1") (read "a" "2")', spies);
    expect(spies.write).toBe(1);
    expect(spies.read).toBe(1);
  });

  it("P-LANE — multi-domain interleave; A post-effect while B queries", async () => {
    const spies: SpyMap = {};
    await run('(write "A" "1") (read "B" "1") (write "B" "1") (read "C" "9") (read "B" "2")', spies);
    expect(spies.write).toBe(2);
    expect(spies.read).toBe(3);
  });

  it("P-QQ — query never doors query", async () => {
    const spies: SpyMap = {};
    await run('(read "a" "1") (read "a" "1")', spies);
    expect(spies.read).toBe(2);
  });

  it("P-I5 — dynamic ids from computed args; different ids no door", async () => {
    const spies: SpyMap = {};
    // id from string-append so path producers see runtime-computed decoded segments
    await run('(write "a" (string-append "i" "d1")) (read "a" (string-append "i" "d2"))', spies);
    expect(spies.write).toBe(1);
    expect(spies.read).toBe(1);
  });

  it("P-DECODE — path fns use decoded form only (bare E→Q legal; decode still proven)", async () => {
    // Asymmetric raw vs decoded: write "raw:42" → E=["test","d","42"] only if
    // path fns see decoded args. Bare E→Q is LEGAL under temporal immutability;
    // assert decode via appendEvents (decoded segment, not raw).
    const spies: SpyMap = {};
    const { cap, pathLog, appendEvents } = makePathCap(spies);
    await exec('(write-decoded "d" "raw:42") (read-decoded "d" "42")', {
      capabilities: [cap],
      runCtx: new RunContext({ resourcePaths: pathLog }),
    });
    expect(spies["write-decoded"]).toBe(1);
    expect(spies["read-decoded"]).toBe(1);
    expect(appendEvents.flat()).toContainEqual(["test", "d", "42"]);
    expect(appendEvents.flat()).not.toContainEqual(["test", "d", "raw:42"]);
  });

  it("P-E-THEN-Q — bare write then overlapping read is legal", async () => {
    const spies: SpyMap = {};
    await run('(write "a" "1") (read "a" "1")', spies);
    expect(spies.write).toBe(1);
    expect(spies.read).toBe(1);
  });

  it("P-E-Q-E — effect then query then effect same domain legal", async () => {
    const spies: SpyMap = {};
    await run('(write "a" "1") (read "a" "1") (write "a" "1")', spies);
    expect(spies.write).toBe(2);
    expect(spies.read).toBe(1);
  });

  it("P-E-Q-Q — effect then two queries (nothing between queries) legal", async () => {
    const spies: SpyMap = {};
    await run('(write "a" "1") (read "a" "1") (read "a" "1")', spies);
    expect(spies.write).toBe(1);
    expect(spies.read).toBe(2);
  });

  it("P-PREFIX-E-THEN-Q-↑ — write child; read parent legal (bare E→Q)", async () => {
    const spies: SpyMap = {};
    await run('(write "a" "1") (read-all "a")', spies);
    expect(spies.write).toBe(1);
    expect(spies["read-all"]).toBe(1);
  });

  it("P-PREFIX-E-THEN-Q-↓ — write parent; read child legal (bare E→Q)", async () => {
    const spies: SpyMap = {};
    await run('(write-all "a") (read "a" "1")', spies);
    expect(spies["write-all"]).toBe(1);
    expect(spies.read).toBe(1);
  });

  it("P-MOVE-DST — after move(s,d); read(d) legal (no prior Q on dst)", async () => {
    const spies: SpyMap = {};
    await run('(move "src" "dst") (read-all "dst")', spies);
    expect(spies.move).toBe(1);
    expect(spies["read-all"]).toBe(1);
  });

  it("P-FRESH — fresh run has empty prior; prior run's effects do not carry", async () => {
    const spies1: SpyMap = {};
    await run('(write "a" "1")', spies1);
    const spies2: SpyMap = {};
    await run('(read "a" "1")', spies2);
    expect(spies2.read).toBe(1);
  });

  it("P-DISJOINT — effect A then query B", async () => {
    const spies: SpyMap = {};
    await run('(write "A" "1") (read "B" "1")', spies);
    expect(spies.read).toBe(1);
  });

  it("P-PATHS-NOT-IMPL — impl does not feed prior E; subsequent read of D no door", async () => {
    const spies: SpyMap = {};
    await run('(impl-only-touch "D") (read "D" "1")', spies);
    expect(spies["impl-only-touch"]).toBe(1);
    expect(spies.read).toBe(1);
  });

  it("P-HYBRID-FIRST — empty prior; single upsert no self-door", async () => {
    const spies: SpyMap = {};
    await run('(upsert "a" "1")', spies);
    expect(spies.upsert).toBe(1);
  });

  it("P-MOVE-OK — after move(s,d); read(s) legal", async () => {
    const spies: SpyMap = {};
    await run('(move "src" "dst") (read-all "src")', spies);
    expect(spies.move).toBe(1);
    expect(spies["read-all"]).toBe(1);
  });

  it("P-UNTRACKED — noop never doors and adds no prior E", async () => {
    const spies: SpyMap = {};
    await run('(noop "x") (write "a" "1") (noop "y") (read "b" "1")', spies);
    expect(spies.noop).toBe(2);
    expect(spies.read).toBe(1);
  });

  it("P-STRING-INT — effect …/project; query …/projects — no door (segment-wise)", async () => {
    const spies: SpyMap = {};
    await run('(write "project" "1") (read "projects" "1")', spies);
    expect(spies.read).toBe(1);
  });

  it("P-EMPTY-PATH — empty path list never doors and never appends", async () => {
    const spies: SpyMap = {};
    const { cap, pathLog, appendEvents } = makePathCap(spies);
    // impl-only-touch declares effects: () => [] — empty contribution
    await exec('(impl-only-touch "D") (read "D" "1")', {
      capabilities: [cap],
      resourcePaths: pathLog,
    });
    expect(spies["impl-only-touch"]).toBe(1);
    expect(spies.read).toBe(1);
    expect(appendEvents.flat()).toEqual([]);
  });
});

// ── S1 Core negatives (true doors = intervening E between overlapping Qs) ───

describe("resource-path CQS door — core negatives (A-QUAD)", () => {
  it("N-I4c — read; write; read again — door on second read (canonical)", async () => {
    const spies: SpyMap = {};
    const { cap, pathLog, pathFnCalls } = makePathCap(spies);
    try {
      await exec('(read "a" "1") (write "a" "1") (read "a" "1")', {
        capabilities: [cap],
        runCtx: new RunContext({ resourcePaths: pathLog }),
      });
      expect.unreachable();
    } catch (err) {
      // impl counts 1/1/0 — first read and write ran; second read doored
      expectDoor(err);
      expect(spies.read).toBe(1);
      expect(spies.write).toBe(1);
      expect(pathFnCalls.filter((c) => c.name === "read" && c.axis === "q").length).toBe(2);
    }
  });

  it("N-CROSS-SYMBOL — prior Q then E then foreign-symbol overlapping Q doors", async () => {
    // Restaged: bare write-many→read is LEGAL; need intervening pattern.
    // Second read uses same symbol as first — do not use aQuad (expects impl=0 on symbol).
    const spies: SpyMap = {};
    const { cap, pathLog, pathFnCalls } = makePathCap(spies);
    try {
      await exec('(read "a" "1") (write-many "a" "1" "9") (read "a" "1")', {
        capabilities: [cap],
        runCtx: new RunContext({ resourcePaths: pathLog }),
      });
      expect.unreachable();
    } catch (err) {
      expectDoor(err);
      expect(spies["write-many"]).toBe(1);
      expect(spies.read).toBe(1); // first read only; second doored
      expect(pathFnCalls.filter((c) => c.name === "read" && c.axis === "q").length).toBe(2);
    }
  });

  it("N-PATHFN-THROW — queries() throws is not CQS door; impl=0", async () => {
    const spies: SpyMap = {};
    const { cap, pathLog } = makePathCap(spies, { pathFnThrow: "queries" });
    try {
      await exec('(read "a" "1")', {
        capabilities: [cap],
        runCtx: new RunContext({ resourcePaths: pathLog }),
      });
      expect.unreachable();
    } catch (err) {
      expect(err).not.toBeInstanceOf(ResourcePathConflictError);
      expect(err).toMatchObject({ name: "ResourcePathProducerError" });
      expect(String(err)).toMatch(/path-fn-queries-boom/);
      expect(spies.read ?? 0).toBe(0);
    }
  });

  it("N-PATHFN-THROW-E — effects() throws is not CQS door; impl=0", async () => {
    const spies: SpyMap = {};
    const { cap, pathLog } = makePathCap(spies, { pathFnThrow: "effects" });
    try {
      await exec('(write "a" "1")', {
        capabilities: [cap],
        runCtx: new RunContext({ resourcePaths: pathLog }),
      });
      expect.unreachable();
    } catch (err) {
      expect(err).not.toBeInstanceOf(ResourcePathConflictError);
      expect(err).toMatchObject({ name: "ResourcePathProducerError" });
      expect(String(err)).toMatch(/path-fn-effects-boom/);
      expect(spies.write ?? 0).toBe(0);
    }
  });

  it("N-DISCRIM-CONTROL — failImpl plain error is not door; impl ran", async () => {
    const spies: SpyMap = {};
    const { cap, pathLog, pathFnCalls } = makePathCap(spies);
    await expect(
      exec('(fail-impl "a")', {
        capabilities: [cap],
        runCtx: new RunContext({ resourcePaths: pathLog }),
      }),
    ).rejects.toThrow(/plain-impl-boom/);
    expect(spies["fail-impl"]).toBe(1);
    expect(pathFnCalls.some((c) => c.axis === "e" && c.name === "fail-impl")).toBe(true);
  });
});

// ── S1 3a-complete (door-only) ───────────────────────────────────────────────

describe("resource-path CQS door — 3a-complete", () => {
  it("P-MULTI-E-PATHS — bare multi-E then probe each path is legal", async () => {
    for (const probe of ['(read "a" "1")', '(read "a" "2")'] as const) {
      const spies: SpyMap = {};
      await run(`(write-many "a" "1" "2") ${probe}`, spies);
      expect(spies["write-many"]).toBe(1);
      expect(spies.read).toBe(1);
    }
  });

  it("P-MULTI-Q-PATHS — bare E then multi-Q with one hit is legal", async () => {
    const spies: SpyMap = {};
    await run('(write "a" "1") (read-many "a" "x" "1")', spies);
    expect(spies.write).toBe(1);
    expect(spies["read-many"]).toBe(1);
  });

  it("N-MULTI-E-PATHS — multi-path E with prior Q then probe each end doors", async () => {
    // Re-homed under intervening law: prior Q on probe path, multi-E, re-query.
    // Same symbol for both reads — manual A-QUAD (not aQuad's impl=0 on symbol).
    for (const [priorQ, probe] of [
      ['(read "a" "1")', '(read "a" "1")'],
      ['(read "a" "2")', '(read "a" "2")'],
    ] as const) {
      const spies: SpyMap = {};
      const { cap, pathLog, pathFnCalls } = makePathCap(spies);
      try {
        await exec(`${priorQ} (write-many "a" "1" "2") ${probe}`, {
          capabilities: [cap],
          runCtx: new RunContext({ resourcePaths: pathLog }),
        });
        expect.unreachable();
      } catch (err) {
        expectDoor(err);
        expect(spies["write-many"]).toBe(1);
        expect(spies.read).toBe(1);
        expect(pathFnCalls.filter((c) => c.name === "read" && c.axis === "q").length).toBe(2);
      }
    }
  });

  it("N-HYBRID-AS-E — upsert then read overlapping doors (hybrid Q≺E)", async () => {
    const spies: SpyMap = {};
    const { cap, pathLog, pathFnCalls } = makePathCap(spies);
    try {
      await exec('(upsert "a" "1") (read "a" "1")', {
        capabilities: [cap],
        runCtx: new RunContext({ resourcePaths: pathLog }),
      });
      expect.unreachable();
    } catch (err) {
      aQuad(err, spies, pathFnCalls, "read", { upsert: 1 });
    }
  });

  /**
   * N-HYBRID-TWICE: a hybrid touches its domain ONCE per run — the second
   * identical call's Q sees call 1's Q then call 1's E (Q≺E record) and doors
   * as N-I4c. The door must teach the hybrid rule, not only "hold prior
   * results" (advice that misreads an upsert's intent).
   */
  it("N-HYBRID-TWICE — same upsert twice in one run doors with hybrid teaching", async () => {
    const spies: SpyMap = {};
    const { cap, pathLog } = makePathCap(spies);
    try {
      await exec('(upsert "a" "1") (upsert "a" "1")', {
        capabilities: [cap],
        runCtx: new RunContext({ resourcePaths: pathLog }),
      });
      expect.unreachable();
    } catch (err) {
      expectDoor(err);
      expect(spies.upsert).toBe(1); // second impl never ran
      expect(err.message).toMatch(/hybrid/i);
      expect(err.message).toMatch(/once per run/i);
    }
    // A-CTRL: the pure-query door keeps the plain wording (no hybrid clause).
    const spies2: SpyMap = {};
    const { cap: cap2, pathLog: pathLog2 } = makePathCap(spies2);
    try {
      await exec('(read "a" "1") (write "a" "1") (read "a" "1")', {
        capabilities: [cap2],
        runCtx: new RunContext({ resourcePaths: pathLog2 }),
      });
      expect.unreachable();
    } catch (err) {
      expectDoor(err);
      expect(err.message).not.toMatch(/hybrid/i);
    }
  });

  it("N-DOORED-E-NOT-RECORDED — doored move's E not on append spy", async () => {
    const spies: SpyMap = {};
    const { cap, pathLog, appendEvents, pathFnCalls } = makePathCap(spies);
    try {
      // True intervening locus: Q(src) → E(src) → move Q(src) doors; E(dst) must NOT record
      await exec('(read-all "src") (write-all "src") (move "src" "dst")', {
        capabilities: [cap],
        runCtx: new RunContext({ resourcePaths: pathLog }),
      });
      expect.unreachable();
    } catch (err) {
      aQuad(err, spies, pathFnCalls, "move", { "write-all": 1, "read-all": 1 });
      const flat = appendEvents.flat();
      expect(flat).toContainEqual(["test", "src"]);
      expect(flat).not.toContainEqual(["test", "dst"]);
    }
  });

  it("P-E-IMPL-THROW-THEN-Q — effect recorded before impl throw; bare later read legal", async () => {
    const spies: SpyMap = {};
    const { cap, pathLog } = makePathCap(spies);
    const runCtx = new RunContext({ resourcePaths: pathLog });
    await expect(exec('(fail-impl "a")', { capabilities: [cap], runCtx })).rejects.toThrow(/plain-impl-boom/);
    expect(spies["fail-impl"]).toBe(1);
    expect(pathLog.effectPaths).toContainEqual(["test", "a"]);
    // bare E→Q legal under temporal immutability
    await exec('(read "a" "1")', { capabilities: [cap], runCtx });
    expect(spies.read).toBe(1);
  });

  it("N-UPSERT-TWICE — second upsert same paths doors", async () => {
    const spies: SpyMap = {};
    const { cap, pathLog, pathFnCalls } = makePathCap(spies);
    try {
      await exec('(upsert "a" "1") (upsert "a" "1")', {
        capabilities: [cap],
        runCtx: new RunContext({ resourcePaths: pathLog }),
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ResourcePathConflictError);
      expect(spies.upsert).toBe(1);
      expect(pathFnCalls.filter((c) => c.name === "upsert").length).toBeGreaterThanOrEqual(2);
    }
  });

  it("N-DOOR-LOCUS — illegal Q only on A in multi-lane (true Q→E→Q on A)", async () => {
    const spies: SpyMap = {};
    const { cap, pathLog } = makePathCap(spies);
    try {
      // Prior Q on A, effect A, legal B, illegal re-query A
      await exec('(read "A" "1") (write "A" "1") (read "B" "1") (read "A" "1")', {
        capabilities: [cap],
        runCtx: new RunContext({ resourcePaths: pathLog }),
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ResourcePathConflictError);
      expect(spies.write).toBe(1);
      // first A + B succeeded; second A doored → read impl = 2
      expect(spies.read).toBe(2);
    }
  });
});

describe("resource-path CQS — producer shape + strictCQSstrings", () => {
  it("default off — non-string segments do not throw (type-level is the law)", async () => {
    let fires = 0;
    const cap = EnvCapability.define("test/cqs-strict-off", {
      symbols: (symbol, z) => ({
        "write-num": symbol.rosetta`write-num: `(
          {
            input: [z.string],
            output: [z.undefinedResult],
            effects: ((d: string) => [["test", d, 1 as unknown as string]]) as (
              d: string,
            ) => readonly (readonly string[])[],
          },
          () => {
            fires++;
            return undefined;
          },
        ),
      }),
    });
    await exec('(write-num "a")', { capabilities: [cap] });
    expect(fires).toBe(1);
  });

  it("strictCQSstrings true — non-string segment is type-mismatch, not CQS door", async () => {
    let fires = 0;
    const cap = EnvCapability.define("test/cqs-strict-on", {
      symbols: (symbol, z) => ({
        "write-num": symbol.rosetta`write-num: `(
          {
            input: [z.string],
            output: [z.undefinedResult],
            effects: ((d: string) => [["test", d, 1 as unknown as string]]) as (
              d: string,
            ) => readonly (readonly string[])[],
          },
          () => {
            fires++;
            return undefined;
          },
        ),
      }),
    });
    await expect(exec('(write-num "a")', { capabilities: [cap], strictCQSstrings: true })).rejects.toBeInstanceOf(
      ResourcePathProducerError,
    );
    expect(fires).toBe(0);
  });

  /**
   * N-PATHS-PRODUCER-ALIASING (ruling 2026-08-13): produced Q/E are frozen
   * COPIES at production — a producer returning a cached/shared array that is
   * later mutated must not corrupt the journal or effect-log `resourcePaths`
   * stamps.
   */
  it("N-PATHS-PRODUCER-ALIASING — produced paths are frozen copies; later mutation invisible", () => {
    const shared: string[][] = [["d", "1"]];
    const log = new MemoryResourcePathLog();
    const produced = applyResourcePathCqs({
      verbName: "alias-w",
      decodedArgs: [],
      queries: () => shared as never,
      effects: () => shared as never,
      log,
    });
    shared[0].push("evil");
    shared.push(["d", "2"]);
    expect(produced.queries).toEqual([["d", "1"]]);
    expect(produced.effects).toEqual([["d", "1"]]);
    expect(Object.isFrozen(produced.effects)).toBe(true);
    expect(Object.isFrozen(produced.effects[0])).toBe(true);
    expect(log.effectPaths).toEqual([["d", "1"]]);
  });

  it("producer returns non-array top-level → ResourcePathProducerError (always)", () => {
    expect(() =>
      applyResourcePathCqs({
        verbName: "bad",
        decodedArgs: [],
        queries: (() => undefined) as any,
        log: new MemoryResourcePathLog(),
      }),
    ).toThrow(ResourcePathProducerError);
  });

  it("producer returns flat path instead of list-of-paths → ResourcePathProducerError", () => {
    expect(() =>
      applyResourcePathCqs({
        verbName: "flat",
        decodedArgs: [],
        effects: (() => ["test", "a", "1"]) as any,
        log: new MemoryResourcePathLog(),
      }),
    ).toThrow(/segment array|flat path/i);
  });
});

describe("resource-path CQS — seams (cache / burst / CONSTANT_CTX / ExecOptions)", () => {
  it("N-QEQ-CACHE — Q→E→Q through cache seam doors; first read cached once", async () => {
    let readFires = 0;
    let writeFires = 0;
    const cap = EnvCapability.define("test/cqs-cache", {
      symbols: (symbol, z) => ({
        "v-read": symbol.rosetta`v-read: `(
          {
            input: [z.string],
            output: [z.string],
            cacheClass: "view",
            queries: (id: string) => [["test", "v", id]],
          },
          (id: string) => {
            readFires++;
            return `val:${id}`;
          },
        ),
        "v-write": symbol.rosetta`v-write: `(
          {
            input: [z.string],
            output: [z.undefinedResult],
            effects: (id: string) => [["test", "v", id]],
          },
          () => {
            writeFires++;
            return undefined;
          },
        ),
      }),
    });
    const cache = new MemoryRunCache("record");
    await expect(
      exec('(v-read "1") (v-write "1") (v-read "1")', {
        capabilities: [cap],
        cache,
      }),
    ).rejects.toThrow(ResourcePathConflictError);
    expect(writeFires).toBe(1);
    expect(readFires).toBe(1); // second read doored before cache serve / re-fire
  });

  it("P-BURST-E-THEN-Q — path E recorded when gathered; bare later read legal", async () => {
    let writeFires = 0;
    let readFires = 0;
    const cap = EnvCapability.define("test/cqs-burst", {
      symbols: (symbol, z) => ({
        "b-write": symbol.rosetta`b-write: `(
          {
            input: [z.string],
            output: [z.undefinedResult],
            provenance: "sink",
            effects: (id: string) => [["test", "b", id]],
          },
          () => {
            writeFires++;
            return undefined;
          },
        ),
        "b-read": symbol.rosetta`b-read: `(
          {
            input: [z.string],
            output: [z.string],
            queries: (id: string) => [["test", "b", id]],
          },
          (id: string) => {
            readFires++;
            return `r:${id}`;
          },
        ),
      }),
    });
    const effects = new MemoryEffectLog();
    const pathLog = new MemoryResourcePathLog();
    await exec('(b-write "1") (b-read "1")', {
      capabilities: [cap],
      effects,
      resourcePaths: pathLog,
    });
    expect(writeFires).toBe(0); // burst gather skipped impl
    expect(readFires).toBe(1); // bare E→Q legal
    expect(effects.entries).toHaveLength(1);
    expect(pathLog.effectPaths).toContainEqual(["test", "b", "1"]);
  });

  it("CONSTANT_CTX — facility off: path fns run but check/record no-op", async () => {
    expect(CONSTANT_CTX.resourcePaths).toBeUndefined();
    let pathFnRan = false;
    // log undefined ⇒ no door even after "effect" path production
    applyResourcePathCqs({
      verbName: "x",
      decodedArgs: ["1"],
      effects: (id: string) => {
        pathFnRan = true;
        return [["test", "c", id]];
      },
      log: undefined,
    });
    expect(pathFnRan).toBe(true);
    // subsequent query under same undefined log also free
    applyResourcePathCqs({
      verbName: "y",
      decodedArgs: ["1"],
      queries: (id: string) => [["test", "c", id]],
      log: undefined,
    });
    // live membrane under CONSTANT_CTX (testCallCtx default)
    const { symbol } = await import("../../symbol/index.js");
    const z = await import("../../common/scheme-zod/index.js");
    const { AString } = await import("../../values/primitives/AString.js");
    let fires = 0;
    const proc = symbol.rosetta`const-write: `(
      {
        input: [z.string],
        output: [z.undefinedResult],
        effects: (id: string) => [["test", "c", id]],
      },
      () => {
        fires++;
        return undefined;
      },
    );
    await proc["arrival/tagless-final/apply"]([new AString("1")], testCallCtx());
    // write then read both succeed — facility off
    const readProc = symbol.rosetta`const-read: `(
      {
        input: [z.string],
        output: [z.string],
        queries: (id: string) => [["test", "c", id]],
      },
      (id: string) => id,
    );
    await readProc["arrival/tagless-final/apply"]([new AString("1")], testCallCtx());
    expect(fires).toBe(1);
  });

  it("ExecOptions.resourcePaths injects spy without manual RunContext", async () => {
    const spies: SpyMap = {};
    const { cap, pathLog, appendEvents } = makePathCap(spies);
    await exec('(write "a" "1")', { capabilities: [cap], resourcePaths: pathLog });
    expect(spies.write).toBe(1);
    expect(appendEvents.flat()).toContainEqual(["test", "a", "1"]);
  });
});

// ── S3 Storage / hybrid (Phase 3b — I6 / I7 / I8) ────────────────────────────
//
// Path E≠[] is a SEPARATE arm from void-sink (no dual-key). Pure path-E fires then
// logs a fired EffectLog entry with resourcePaths. Path Q≠[] is CQS journal only —
// it does not elevate to view-cache (cache is `cacheClass: "view"`, opt-in). Hybrid
// fires the impl and logs E; the return is not automatically a cache entry.

describe("resource-path CQS — S3 storage / hybrid (I6–I8)", () => {
  it("P-I6 — E≠[] + effects armed ⇒ effect-log entry carries resource paths (fired)", async () => {
    const spies: SpyMap = {};
    const { cap, pathLog } = makePathCap(spies);
    const effects = new MemoryEffectLog();
    await exec('(write "a" "1")', {
      capabilities: [cap],
      effects,
      resourcePaths: pathLog,
    });
    expect(spies.write).toBe(1); // path-E arm is post-fire, not void-sink skip
    expect(effects.entries).toHaveLength(1);
    expect(effects.entries[0]).toMatchObject({
      verbName: "write",
      decodedArgs: ["a", "1"],
      fired: true,
      resourcePaths: [["test", "a", "1"]],
    });
    // CQS prior-E still recorded (door fuel) — orthogonal channel
    expect(pathLog.effectPaths).toContainEqual(["test", "a", "1"]);
  });

  it("P-I7 — Q≠[] + cache armed + unclassified ⇒ NOT stored; replay re-fires", async () => {
    const spies: SpyMap = {};
    const { cap } = makePathCap(spies);
    const record = new MemoryRunCache("record");
    const [r1] = await exec('(read "a" "1")', {
      capabilities: [cap],
      cache: record,
    });
    expect(spies.read).toBe(1);
    expect(r1).toBe("a:1");
    // CQS query is not a cache class — interpreter does not snapshot the source.
    expect([...record.entries.values()].some((e) => e.kind === "value")).toBe(false);

    const spies2: SpyMap = {};
    const { cap: cap2 } = makePathCap(spies2);
    const replay = new MemoryRunCache("replay", record.entries);
    const [r2] = await exec('(read "a" "1")', {
      capabilities: [cap2],
      cache: replay,
    });
    expect(spies2.read).toBe(1); // re-enter impl — host cache (if any) is outside
    expect(r2).toBe("a:1");
  });

  it("P-I8 — hybrid both non-empty: impl runs, E logged, return not auto-cached", async () => {
    const spies: SpyMap = {};
    const { cap, pathLog } = makePathCap(spies);
    const effects = new MemoryEffectLog();
    const cache = new MemoryRunCache("record");
    const [row] = await exec('(upsert "a" "1")', {
      capabilities: [cap],
      effects,
      cache,
      resourcePaths: pathLog,
    });
    expect(spies.upsert).toBe(1); // impl runs (not void-sink skip)
    expect(row).toBe("row:a:1");
    expect(effects.entries).toHaveLength(1);
    expect(effects.entries[0]).toMatchObject({
      verbName: "upsert",
      fired: true,
      resourcePaths: [["test", "a", "1"]],
    });
    expect([...cache.entries.values()].some((e) => e.kind === "value")).toBe(false);
    expect(pathLog.effectPaths).toContainEqual(["test", "a", "1"]);

    // Replay: re-enters impl (no view snapshot). Path-E arm does not re-enqueue on fold.
    const spies2: SpyMap = {};
    const { cap: cap2 } = makePathCap(spies2);
    const effects2 = new MemoryEffectLog();
    const replay = new MemoryRunCache("replay", cache.entries);
    const [row2] = await exec('(upsert "a" "1")', {
      capabilities: [cap2],
      cache: replay,
      effects: effects2,
    });
    expect(spies2.upsert).toBe(1);
    expect(row2).toBe("row:a:1");
    expect(effects2.entries).toHaveLength(0);
  });

  it("N-DOOR-AFTER-HYBRID — storage does not weaken CQS: upsert then overlapping read doors", async () => {
    const spies: SpyMap = {};
    const { cap, pathLog, pathFnCalls } = makePathCap(spies);
    const effects = new MemoryEffectLog();
    const cache = new MemoryRunCache("record");
    await expect(
      exec('(upsert "a" "1") (read "a" "1")', {
        capabilities: [cap],
        effects,
        cache,
        resourcePaths: pathLog,
      }),
    ).rejects.toThrow(ResourcePathConflictError);
    expect(spies.upsert).toBe(1);
    expect(spies.read ?? 0).toBe(0);
    expect(pathFnCalls.some((c) => c.name === "read")).toBe(true);
    // Hybrid's E was logged (I6) and still feeds the door
    expect(effects.entries).toHaveLength(1);
    expect(effects.entries[0]?.fired).toBe(true);
  });

  it("N-HYBRID-NOT-VOID-SKIP — hybrid with effects armed must not classic void-sink skip-impl", async () => {
    const spies: SpyMap = {};
    const { cap } = makePathCap(spies);
    const effects = new MemoryEffectLog();
    // effects armed alone (no cache) — pure void-sink would skip; hybrid must fire
    const [row] = await exec('(upsert "a" "1")', {
      capabilities: [cap],
      effects,
    });
    expect(spies.upsert).toBe(1);
    expect(row).toBe("row:a:1");
    expect(effects.entries[0]?.fired).toBe(true);
    // Contrast: a real void-sink with effects armed skips (effect-log.law pins that separately).
  });

  it("P-I6 unarmed — E≠[] without effects log does not invent enqueue; bare later Q legal", async () => {
    const spies: SpyMap = {};
    const { cap, pathLog } = makePathCap(spies);
    // no effects channel — write fires; CQS prior-E still recorded; no EffectLog to fill
    await exec('(write "a" "1") (read "b" "1")', {
      capabilities: [cap],
      resourcePaths: pathLog,
    });
    expect(spies.write).toBe(1);
    expect(spies.read).toBe(1);
    expect(pathLog.effectPaths).toContainEqual(["test", "a", "1"]);
    // bare overlapping query is LEGAL (no prior Q before the E on a)
    await exec('(read "a" "1")', {
      capabilities: [cap],
      resourcePaths: pathLog,
    });
    expect(spies.read).toBe(2);
  });

  it("N-I4c unarmed — intervening door works without EffectLog (resourcePaths only)", async () => {
    const spies: SpyMap = {};
    const { cap, pathLog } = makePathCap(spies);
    await expect(
      exec('(read "a" "1") (write "a" "1") (read "a" "1")', {
        capabilities: [cap],
        resourcePaths: pathLog,
      }),
    ).rejects.toThrow(ResourcePathConflictError);
    expect(spies.read).toBe(1);
    expect(spies.write).toBe(1);
  });
});
