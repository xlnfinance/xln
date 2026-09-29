// DoorCause + DoorProcedure — door metadata (docs/design-history/symbol-define-static-program-validation.md §3.3). Pins the causal-chain UX's FIRST
// link: a bound door is not an anonymous throwing closure
// (`env.set(verb, () => { throw … })`) — it's an introspectable `DoorProcedure` carrying
// its baked `DoorSymbolDef` (`.door`), whose `cause` (owning capability + `needs`, both
// additive) travels into the thrown `PurityError`'s `.owner` + message. Two unit planes:
//   1. `DoorProcedure` in isolation (no capability/env involved) — `.door` exposure, the
//      byte-compatible cause-less throw, the `name @ owner` caused throw.
//   2. `common/capability.ts`'s door bind arm — every door it binds gets a cause DERIVED
//      from the owning capability's own `name`, `needs: []` (a `notImplemented` door is a
//      permanent design omission, never conditional on an absent config/dep).
//
// The DECLARATION-DRIVEN law over the ~100 production doors (every BASE_PACKS door gets
// `cause.owner` = its pack) is pinned in the sibling `declared-doors.law.test.ts`.
import { describe, expect, it } from "vitest";
import { symbol } from "../../symbol/index.js";
import { DoorProcedure } from "../../values/primitives/ACallable.js";
import { is_callable_value } from "../../values/value-guards.js";
import { PurityError } from "../../errors.js";
import { EnvCapability } from "../../common/capability.js";
import { ResolvingAmbient } from "../../env/AmbientRuntime.js";
import { applyCapability } from "../_fresh-env.js";

describe("DoorProcedure — the introspectable door binding (unit, no capability/env)", () => {
  it("exposes `.door` — the baked DoorSymbolDef — for static readers", () => {
    // Stage A2: `symbol.notImplemented` mints the DoorProcedure directly now; extract the
    // baked DoorSymbolDef off `.door` to exercise the CLASS in isolation (this suite's own
    // point — constructing a fresh DoorProcedure from a raw DoorSymbolDef).
    const def = symbol.notImplemented`stub: a teaching stub`.door;
    const proc = new DoorProcedure(def);
    expect(proc.door).toBe(def);
    // A door is a genuine callable value (it has an apply term) — is_callable_value
    // must recognize it too, or `=>`/z.lambda-typed call sites would mis-dispatch it.
    expect(is_callable_value(proc)).toBe(true);
  });

  it("resolves like any other value — constructing/holding a DoorProcedure never throws (only APPLY does)", () => {
    const def = symbol.notImplemented`stub: a teaching stub`.door;
    expect(() => new DoorProcedure(def)).not.toThrow();
  });

  it("PurityError is BYTE-COMPATIBLE for a cause-less door: same message/owner as pre-W0", () => {
    const def = symbol.notImplemented`stub: a teaching stub`.door;
    expect(def.cause).toBeUndefined();
    const proc = new DoorProcedure(def);
    let caught: unknown;
    try {
      proc["arrival/tagless-final/apply"]();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PurityError);
    const err = caught as PurityError;
    // Byte-identical to the pre-W0 template (`${def.name} is not available.\n  Why: ${def.reason}`)
    expect(err.message).toBe("stub is not available.\n  Why: a teaching stub");
    expect(err.feature).toBe("stub");
    expect(err.owner).toBe("owned-by/purity-invariant");
  });

  it("a CAUSED door leads its message with `name @ owner` (never a raw hash) and carries cause.owner as `.owner`", () => {
    const raw = symbol.notImplemented`stub: a teaching stub`.door;
    const def = { ...raw, cause: { owner: "test/pack", needs: [] } };
    const proc = new DoorProcedure(def);
    let caught: unknown;
    try {
      proc["arrival/tagless-final/apply"]();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PurityError);
    const err = caught as PurityError;
    expect(err.message).toBe("stub @ test/pack is not available.\n  Why: a teaching stub");
    expect(err.owner).toBe("test/pack");
  });

  it("fires UNCONDITIONALLY — no args needed, matches the pre-DoorProcedure closure's 0-arg call shape", () => {
    const def = symbol.notImplemented`stub: a teaching stub`.door;
    const proc = new DoorProcedure(def);
    expect(() => proc["arrival/tagless-final/apply"]()).toThrow(PurityError);
  });
});

/** A REAL recording env (hermetic-Environment ruling: capability apply narrows to the
 *  concrete `AmbientRuntime` — a synthetic `{ set }` mock can no longer receive bindings).
 *  `bound` is a read facade over the frame's own storage record, keeping this suite's
 *  `bound.get(name)` idiom without the retired write surface. */
function recordingEnv(): { env: ResolvingAmbient; bound: { get(name: string): unknown } } {
  const env = ResolvingAmbient.root("door-cause-recording");
  return { env, bound: { get: (name) => env.__env__[name] } };
}

describe("common/capability.ts's door bind arm — cause DERIVED from the owning capability", () => {
  it("stamps cause = { owner: <capability name>, needs: [] } for a notImplemented door with no cause of its own", async () => {
    const cap = EnvCapability.define("test/door-cap", {
      symbols: (symbol) => ({
        stub: symbol.notImplemented`stub: a teaching stub`,
      }),
    });
    const { env, bound } = recordingEnv();
    await applyCapability(env, [cap]);

    const proc = bound.get("stub");
    expect(proc).toBeInstanceOf(DoorProcedure);
    const door = (proc as DoorProcedure).door;
    expect(door.cause).toEqual({ owner: "test/door-cap", needs: [] });
  });

  it("firing the bound door throws PurityError naming `name @ capability`", async () => {
    const cap = EnvCapability.define("test/door-cap-2", {
      symbols: (symbol) => ({
        stub: symbol.notImplemented`stub: a teaching stub`,
      }),
    });
    const { env, bound } = recordingEnv();
    await applyCapability(env, [cap]);

    const proc = bound.get("stub") as DoorProcedure;
    let caught: unknown;
    try {
      proc["arrival/tagless-final/apply"]();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PurityError);
    expect((caught as PurityError).message).toBe("stub @ test/door-cap-2 is not available.\n  Why: a teaching stub");
    expect((caught as PurityError).owner).toBe("test/door-cap-2");
  });

  it("a door constructed with its OWN cause already set passes through unchanged (the degradation-minted door path, not touched here)", async () => {
    const cap = EnvCapability.define("test/door-cap-3", {
      symbols: (symbol) => {
        // A door minted with its OWN cause already set — construct a fresh DoorProcedure
        // over a pre-caused DoorSymbolDef (mirrors a degradation-minted door, which also
        // arrives at the bind loop already carrying a cause).
        const preCaused = new DoorProcedure({
          ...symbol.notImplemented`stub: a teaching stub`.door,
          cause: { owner: "elsewhere/pack", needs: [] },
        });
        return { stub: preCaused };
      },
    });
    const { env, bound } = recordingEnv();
    await applyCapability(env, [cap]);

    const door = (bound.get("stub") as DoorProcedure).door;
    // NOT overwritten with "test/door-cap-3" — the capability trusts an already-stamped cause.
    expect(door.cause).toEqual({ owner: "elsewhere/pack", needs: [] });
  });
});
