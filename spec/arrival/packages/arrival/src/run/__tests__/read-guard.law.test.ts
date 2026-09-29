/**
 * LAW — the read log + the read∩write deferral guard (W2, the plexus effect-burst
 * design §2.4). Pins two things:
 *
 *  1. `checkReadWriteGuard` (run/read-guard.ts) as a PURE function over
 *     (effect entries, read log, writeSetOf) — the fencepost clock convention
 *     (`ReadEvent.clock` 1-based, `EffectEntry.enqueuedAtReadClock` 0-based) that makes
 *     "enqueue then read" and "read then enqueue" distinguishable with no tie.
 *  2. The WIRING through `exec`/`ExecOptions.reads` (generator-exec.ts's per-form loop):
 *     each top-level form's evaluation runs inside `reads.tracker.region(...)`, and the
 *     guard runs after each form for a PRIME run gathering effects — mirroring the
 *     burst arm's own `cache?.mode !== "replay"` gate (run-cache.ts) so replay never
 *     trips it, and skipping entirely when `reads` is absent (byte-identical to pre-W2).
 *
 * Rows pinned here (per the task's gate):
 *   - read-then-enqueue-same: fine (the motivating query, §2.4's canonical shape)
 *   - enqueue-then-read-same: crashes with `ReadYourDeferredWriteError` naming the
 *     effect + the read
 *   - disjoint reads/writes: fine regardless of clock ordering
 *   - replay mode: the guard never runs (cache.mode === "replay" gates it off, even
 *     over an effect log that WOULD otherwise violate)
 *   - no tracker: byte-identical — `reads` absent means the loop never wraps a region
 *     and never calls the guard, no matter what the program does
 */
import { describe, it, expect } from "vitest";
import { EnvCapability } from "../../common/capability.js";
import { exec } from "../../eval/generator-exec.js";
import { MemoryRunCache } from "../../run/run-cache.js";
import { MemoryEffectLog, type EffectEntry } from "../../run/effect-log.js";
import {
  MemoryReadTracker,
  checkReadWriteGuard,
  writeSetOfResourcePaths,
  ReadYourDeferredWriteError,
  type WriteSetResolver,
} from "../../run/read-guard.js";
import { serializeResourcePath } from "../path-algebra.js";

// ─────────────────────────────────────────────────────────────────────────────
// 1. checkReadWriteGuard — the pure function, direct
// ─────────────────────────────────────────────────────────────────────────────

const entry = (over: Partial<EffectEntry> & { verbName: string; decodedArgs: readonly unknown[] }): EffectEntry => ({
  index: 0,
  ...over,
});

/** Effects named "write!" write the key at decodedArgs[0] — matches the `write!` verb
 *  the wired describe block below binds, so ONE resolver serves both sections. */
const writeSetOf: WriteSetResolver = (e) => (e.verbName === "write!" ? [String(e.decodedArgs[0])] : undefined);

describe("checkReadWriteGuard — the pure guard function (§2.4)", () => {
  it("a read BEFORE enqueue (read.clock <= enqueuedAtReadClock) never violates", () => {
    // One read happened (clock 1) before the effect enqueued (enqueuedAtReadClock 1).
    const entries = [entry({ verbName: "write!", decodedArgs: ["x"], enqueuedAtReadClock: 1 })];
    expect(() => checkReadWriteGuard(entries, [{ key: "x", clock: 1 }], writeSetOf)).not.toThrow();
  });

  it("a read AFTER enqueue on the SAME key throws ReadYourDeferredWriteError", () => {
    // Zero reads preceded the enqueue (enqueuedAtReadClock 0); the next read is #1.
    const entries = [entry({ verbName: "write!", decodedArgs: ["x"], enqueuedAtReadClock: 0 })];
    const reads = [{ key: "x", clock: 1 }];
    expect(() => checkReadWriteGuard(entries, reads, writeSetOf)).toThrow(ReadYourDeferredWriteError);
    try {
      checkReadWriteGuard(entries, reads, writeSetOf);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ReadYourDeferredWriteError);
      const err = e as ReadYourDeferredWriteError;
      expect(err.effect.verbName).toBe("write!");
      expect(err.readKey).toBe("x");
      expect(err.readClock).toBe(1);
      expect(err.message).toContain("write!");
      expect(err.message).toContain("x");
    }
  });

  it("disjoint keys never violate, regardless of clock ordering", () => {
    const entries = [entry({ verbName: "write!", decodedArgs: ["x"], enqueuedAtReadClock: 0 })];
    // A read of a DIFFERENT key, well after the enqueue — still fine.
    expect(() => checkReadWriteGuard(entries, [{ key: "y", clock: 5 }], writeSetOf)).not.toThrow();
  });

  it("no `writeSetOf` ⇒ no-op, even over a read/write pair that would otherwise violate", () => {
    const entries = [entry({ verbName: "write!", decodedArgs: ["x"], enqueuedAtReadClock: 0 })];
    expect(() => checkReadWriteGuard(entries, [{ key: "x", clock: 1 }], undefined)).not.toThrow();
  });

  it("an entry `writeSetOf` abstains on (returns undefined) is skipped, not treated as no-writes lie", () => {
    const abstain: WriteSetResolver = () => undefined;
    const entries = [entry({ verbName: "write!", decodedArgs: ["x"], enqueuedAtReadClock: 0 })];
    expect(() => checkReadWriteGuard(entries, [{ key: "x", clock: 1 }], abstain)).not.toThrow();
  });

  it("no `enqueuedAtReadClock` on the entry (no tracker was live at enqueue time) treats it as 0", () => {
    const entries = [entry({ verbName: "write!", decodedArgs: ["x"] })]; // no enqueuedAtReadClock at all
    expect(() => checkReadWriteGuard(entries, [{ key: "x", clock: 1 }], writeSetOf)).toThrow(
      ReadYourDeferredWriteError,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 1b. Phase 4 — path-shaped write-set keys (serializeResourcePath / writeSetOfResourcePaths)
// ─────────────────────────────────────────────────────────────────────────────

describe("Phase 4 host footprints — path-shaped writeSetOf keys", () => {
  it("writeSetOfResourcePaths serializes entry.resourcePaths; abstains without them", () => {
    expect(
      writeSetOfResourcePaths(
        entry({
          verbName: "upsert!",
          decodedArgs: ["a"],
          resourcePaths: [
            ["db", "projects", "1"],
            ["db", "projects", "2"],
          ],
        }),
      ),
    ).toEqual([serializeResourcePath(["db", "projects", "1"]), serializeResourcePath(["db", "projects", "2"])]);
    expect(writeSetOfResourcePaths(entry({ verbName: "write!", decodedArgs: ["x"] }))).toBeUndefined();
    expect(
      writeSetOfResourcePaths(entry({ verbName: "write!", decodedArgs: ["x"], resourcePaths: [] })),
    ).toBeUndefined();
  });

  it("guard trips when a post-enqueue read key matches a serialized resource path", () => {
    const path = ["test", "a", "1"] as const;
    const key = serializeResourcePath(path);
    const entries = [
      entry({
        verbName: "write!",
        decodedArgs: ["ignored-arg-key"],
        enqueuedAtReadClock: 0,
        resourcePaths: [path],
      }),
    ];
    expect(() => checkReadWriteGuard(entries, [{ key, clock: 1 }], writeSetOfResourcePaths)).toThrow(
      ReadYourDeferredWriteError,
    );
    // disjoint path key — fine
    expect(() =>
      checkReadWriteGuard(entries, [{ key: serializeResourcePath(["test", "b"]), clock: 1 }], writeSetOfResourcePaths),
    ).not.toThrow();
  });

  it("fired path-E entries are still skipped by the guard (deferral subject only)", () => {
    const path = ["test", "x"] as const;
    const key = serializeResourcePath(path);
    const entries = [
      entry({
        verbName: "upsert!",
        decodedArgs: [],
        fired: true,
        enqueuedAtReadClock: 0,
        resourcePaths: [path],
      }),
    ];
    expect(() => checkReadWriteGuard(entries, [{ key, clock: 1 }], writeSetOfResourcePaths)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Wired through exec/ExecOptions.reads — the eval-loop region + guard-check
// ─────────────────────────────────────────────────────────────────────────────

/** One capability exposing two verbs over a `MemoryReadTracker` closed over directly
 *  (a law test's stand-in for a real mobx-backed host tracker — see read-guard.ts's
 *  header): `read!` records a read at the given key (unclassified — always fires,
 *  untouched by cache/effects, mirroring effect-log.law.test's `view` row); `write!`
 *  is a `sink` (mirrors effect-log.law.test's `sinkDef`) so a burst run gathers it
 *  through the SAME chokepoint that stamps `enqueuedAtReadClock`. */
function makeCap(tracker: MemoryReadTracker) {
  let writeFires = 0;
  const cap = EnvCapability.define("test/read-guard", {
    symbols: (symbol, z) => ({
      "read!": symbol.rosetta`read!: `({ input: [z.string], output: [z.undefinedResult] }, (key: string) => {
        tracker.record(key);
        return undefined;
      }),
      "write!": symbol.rosetta`write!: `(
        { input: [z.string], output: [z.undefinedResult], provenance: "sink" },
        async (_key: string) => {
          writeFires++;
          return undefined;
        },
      ),
    }),
  });
  return { cap, writeFires: () => writeFires };
}

describe("read-guard wired through exec (W2 glue: the eval-loop region + guard-check)", () => {
  it("read-then-enqueue-same (query-then-mutate) — the canonical shape — passes clean", async () => {
    const tracker = new MemoryReadTracker();
    const { cap } = makeCap(tracker);
    const effects = new MemoryEffectLog();
    await expect(
      exec('(read! "x") (write! "x")', { capabilities: [cap], effects, reads: { tracker, writeSetOf } }),
    ).resolves.toBeDefined();
    expect(effects.entries).toHaveLength(1);
    expect(effects.entries[0].enqueuedAtReadClock).toBe(1); // one read had already happened
  });

  it("enqueue-then-read-same crashes with the teaching door, naming the effect + the read", async () => {
    const tracker = new MemoryReadTracker();
    const { cap } = makeCap(tracker);
    const effects = new MemoryEffectLog();
    await expect(
      exec('(write! "x") (read! "x")', { capabilities: [cap], effects, reads: { tracker, writeSetOf } }),
    ).rejects.toThrow(ReadYourDeferredWriteError);
    // The effect was gathered (never fired — the burst arm's own guarantee); the read
    // that violated is the SAME key, one read after a zero-read enqueue. toMatchObject
    // (not toEqual): the entry also carries `rawArgs` (§5), an additive field this law
    // doesn't pin.
    expect(effects.entries).toMatchObject([
      { index: 0, verbName: "write!", decodedArgs: ["x"], enqueuedAtReadClock: 0 },
    ]);
  });

  it("disjoint reads/writes — a write on one key, a read on another — passes clean", async () => {
    const tracker = new MemoryReadTracker();
    const { cap, writeFires } = makeCap(tracker);
    const effects = new MemoryEffectLog();
    await expect(
      exec('(write! "x") (read! "y")', { capabilities: [cap], effects, reads: { tracker, writeSetOf } }),
    ).resolves.toBeDefined();
    expect(writeFires()).toBe(0); // deferred, not fired — the burst arm still holds
    expect(tracker.log.map((r) => r.key)).toEqual(["y"]);
  });

  it("replay mode never runs the guard — even a pre-seeded violating entry is inert", async () => {
    const tracker = new MemoryReadTracker();
    const { cap } = makeCap(tracker);
    // Pre-seed the effect log as if a write on "x" had already been gathered (zero
    // reads preceded it) — the exact shape that throws under a PRIME run above. The
    // program itself only READS "x"; if the guard ran, this would violate.
    const effects = new MemoryEffectLog();
    effects.enqueue({ verbName: "write!", decodedArgs: ["x"], enqueuedAtReadClock: 0 });
    const replay = new MemoryRunCache("replay");
    await expect(
      exec('(read! "x")', { capabilities: [cap], cache: replay, effects, reads: { tracker, writeSetOf } }),
    ).resolves.toBeDefined();
  });

  it("no tracker (`reads` absent) is byte-identical — the SAME violating program runs clean", async () => {
    const tracker = new MemoryReadTracker(); // still closed over by the verbs, but never armed on ExecOptions
    const { cap } = makeCap(tracker);
    const effects = new MemoryEffectLog();
    await expect(exec('(write! "x") (read! "x")', { capabilities: [cap], effects })).resolves.toBeDefined();
    // The effect still gathered (W1 behavior, untouched); it just carries no read-clock
    // stamp (no tracker was present at enqueue) and nothing ever checked it. toMatchObject
    // (not toEqual): the entry also carries `rawArgs` (§5), an additive field this law
    // doesn't pin.
    expect(effects.entries).toMatchObject([{ index: 0, verbName: "write!", decodedArgs: ["x"] }]);
  });
});
