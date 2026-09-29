/**
 * LAW — the effect log + the burst arm (W1, the plexus effect-burst design
 * §2.3/§2.5). Pins the third mode of the run-cache
 * interception chokepoint (run/run-cache.ts's `penetrateThroughCache`): a `sink`
 * penetration during a PRIME run gathers onto `EffectLog` instead of firing; a
 * replay (fold) is untouched.
 *
 * Rows pinned here (per the task's gate):
 *   - a sink enqueues + returns void during a prime run (spy proves NOTHING fires)
 *   - program order is preserved, including two identical sinks (no dedup — contrast
 *     `RunCache`'s content-keyed Map)
 *   - `burst` drains entries in order via the caller-supplied executor
 *   - a mid-drain throw stops the drain and reports position
 *   - replay mode does NOT enqueue — the tombstone-skip path is unchanged
 *   - non-sink classes (`view`/`pure`/unclassified) are unaffected by an effect log
 *   - no `effects` ⇒ byte-identical to landed (pre-W1) behavior
 */
import { describe, it, expect } from "vitest";
import * as z from "../../common/scheme-zod/index.js";
import { symbol } from "../../symbol/index.js";
import { testCallCtx } from "../CallCtx.js";

import { exec } from "../../eval/generator-exec.js";
import { RunContext, CONSTANT_CTX } from "../../run/RunContext.js";
import { MemoryRunCache } from "../../run/run-cache.js";
import { MemoryEffectLog, burst, BurstDrainError, type EffectEntry } from "../../run/effect-log.js";
import { AExact } from "../../values/primitives/AExact.js";
import { AVoid } from "../../values/primitives/AVoid.js";

const num = (n: number) => new AExact(n);

/** A sink def around a spy impl — mirrors run-cache.law.test.ts's `viewDef` shape. */
function sinkDef(name: string) {
  let fires = 0;
  const def = symbol.rosetta`${name}: `(
    { input: [z.number], output: [z.undefinedResult], provenance: "sink" },
    async (_n: number) => {
      fires++;
      return undefined;
    },
  );
  return { def, fires: () => fires };
}

const ctxWithEffects = (effects: MemoryEffectLog, cache?: MemoryRunCache) =>
  testCallCtx({ runCtx: new RunContext({ effects, cache }) });

/** Invoke a baked rosetta procedure via its apply term (the sole membrane spine). */
function fire(proc: { ["arrival/tagless-final/apply"](args: any[], callCtx: any): any }, callCtx: any, ...args: any[]) {
  return proc["arrival/tagless-final/apply"](args, callCtx);
}

describe("EffectLog — the burst arm at the wrapper (W1)", () => {
  it("a sink enqueues and returns void during a prime run — the impl NEVER fires", async () => {
    const { def, fires } = sinkDef("effect-log-enqueue");
    const effects = new MemoryEffectLog();
    const result = await fire(def, ctxWithEffects(effects), num(7));
    expect(result).toBeInstanceOf(AVoid); // boxed unspecified — the wrapper's own membrane, not raw JS
    expect(fires()).toBe(0); // deferred, not fired
    // toMatchObject (not toEqual): the entry also carries `rawArgs` (§5), an additive
    // field this law doesn't pin.
    expect(effects.entries).toMatchObject([{ index: 0, verbName: "effect-log-enqueue", decodedArgs: [7] }]);
  });

  it("program order is preserved, including two identical sinks — no dedup (contrast RunCache)", async () => {
    const { def } = sinkDef("effect-log-order");
    const effects = new MemoryEffectLog();
    const ctx = ctxWithEffects(effects);
    await fire(def, ctx, num(1));
    await fire(def, ctx, num(1)); // identical penetration — still a SECOND entry
    await fire(def, ctx, num(2));
    expect(effects.entries.map((e) => e.decodedArgs)).toEqual([[1], [1], [2]]);
    expect(effects.entries.map((e) => e.index)).toEqual([0, 1, 2]);
  });

  it("non-sink classes (view/pure/unclassified) are unaffected by an effect log", async () => {
    let viewFires = 0;
    const viewDef = symbol.rosetta`effect-log-view: `(
      { input: [z.number], output: [z.number], cacheClass: "view" },
      (n: number) => {
        viewFires++;
        return n * 2;
      },
    );
    const effects = new MemoryEffectLog();
    const result = await fire(viewDef, ctxWithEffects(effects), num(21));
    expect(result).toBeDefined();
    expect(viewFires).toBe(1); // fired normally — burst arm is sink-only
    expect(effects.entries).toHaveLength(0);
  });

  it("replay mode does NOT enqueue — the tombstone-skip path is unchanged", async () => {
    const { def, fires } = sinkDef("effect-log-replay");
    // Record a tombstone the ordinary way (no effects log — today's landed path).
    const record = new MemoryRunCache("record");
    await fire(def, testCallCtx({ runCtx: new RunContext({ cache: record }) }), num(3));
    expect(fires()).toBe(1);

    // Replay with an effect log ALSO present: burst arm must be skipped because
    // cache.mode === "replay" — tombstone hit skips exactly as without an effects log.
    const replay = new MemoryRunCache("replay", record.entries);
    const effects = new MemoryEffectLog();
    const result = await fire(def, ctxWithEffects(effects, replay), num(3));
    expect(result).toBeInstanceOf(AVoid); // tombstone-skip void, not burst-enqueue void
    expect(fires()).toBe(1); // NOT re-fired
    expect(effects.entries).toHaveLength(0); // NOT enqueued — a fold never gathers
  });

  it("a run with no `effects` is byte-identical to landed (pre-W1) behavior", async () => {
    const { def, fires } = sinkDef("effect-log-absent");
    const result = await fire(def, testCallCtx(), num(9));
    expect(result).toBeInstanceOf(AVoid); // boxed unspecified — the wrapper's own membrane, not raw JS
    expect(fires()).toBe(1); // fires immediately — no burst arm without an effects log
  });

  it("wires through exec/ExecOptions.effects the same way ExecOptions.cache does", async () => {
    let fires = 0;
    const { EnvCapability } = await import("../../common/capability.js");
    const cap = EnvCapability.define("test/effect-log", {
      symbols: (symbol, z) => ({
        "fire!": symbol.rosetta`fire!: an effect`(
          { input: [z.number], output: [z.undefinedResult], provenance: "sink" },
          (_n: number) => {
            fires++;
            return undefined;
          },
        ),
      }),
    });
    const effects = new MemoryEffectLog();
    const [result] = await exec("(fire! 1)", { capabilities: [cap], effects });
    expect(result).toBeUndefined(); // exec() unwraps through toJS — void ↔ JS undefined
    expect(fires).toBe(0);
    // toMatchObject (not toEqual): the entry also carries `rawArgs` (the pre-decode boxed args,
    // arrival-provenance-confirmation.md §5) — an additive field this law doesn't pin.
    expect(effects.entries).toMatchObject([{ index: 0, verbName: "fire!", decodedArgs: [1] }]);
  });
});

describe("burst — the drain (§2.5, minus everything W3+ owns)", () => {
  it("executes entries in order via the caller-supplied executor", async () => {
    const effects = new MemoryEffectLog();
    effects.enqueue({ verbName: "a", decodedArgs: [1] });
    effects.enqueue({ verbName: "b", decodedArgs: [2] });
    effects.enqueue({ verbName: "c", decodedArgs: [3] });
    const seen: EffectEntry[] = [];
    await burst(effects, (entry) => {
      seen.push(entry);
    });
    expect(seen.map((e) => e.verbName)).toEqual(["a", "b", "c"]);
  });

  it("a mid-drain throw stops the drain and reports position", async () => {
    const effects = new MemoryEffectLog();
    effects.enqueue({ verbName: "a", decodedArgs: [] });
    effects.enqueue({ verbName: "b", decodedArgs: [] });
    effects.enqueue({ verbName: "c", decodedArgs: [] });
    const ran: string[] = [];
    const failure = new Error("boom");
    await expect(
      burst(effects, (entry) => {
        ran.push(entry.verbName);
        if (entry.verbName === "b") throw failure;
      }),
    ).rejects.toThrow(BurstDrainError);
    expect(ran).toEqual(["a", "b"]); // "c" never fired
    try {
      await burst(effects, (entry) => {
        if (entry.verbName === "b") throw failure;
      });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(BurstDrainError);
      const err = e as BurstDrainError;
      expect(err.failure.entry.verbName).toBe("b");
      expect(err.failure.error).toBe(failure);
      expect(err.failure.remaining.map((r) => r.verbName)).toEqual(["c"]);
    }
  });

  it("an empty log drains trivially", async () => {
    const effects = new MemoryEffectLog();
    let called = false;
    await burst(effects, () => {
      called = true;
    });
    expect(called).toBe(false);
  });

  it("fired (path-E manifest) entries are skipped by the drain — already applied in-run", async () => {
    const effects = new MemoryEffectLog();
    effects.enqueue({ verbName: "deferred", decodedArgs: [1] });
    effects.enqueue({
      verbName: "already-fired",
      decodedArgs: [2],
      fired: true,
      resourcePaths: [["test", "x"]],
    });
    effects.enqueue({ verbName: "deferred-2", decodedArgs: [3] });
    const ran: string[] = [];
    await burst(effects, (entry) => {
      ran.push(entry.verbName);
    });
    expect(ran).toEqual(["deferred", "deferred-2"]);
    // fired entry remains in the manifest
    expect(effects.entries.map((e) => e.verbName)).toEqual(["deferred", "already-fired", "deferred-2"]);
  });
});
