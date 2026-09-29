/**
 * LAW — the z.dynamic-callable door (Ruling A; retargeted off `z.value` at the Q1 split —
 * docs/plans/stage-c-corpse-deletion.md §"z.value retirement campaign").
 *
 * The hole this closes: a `z.dynamic` slot is the declared raw escape hatch — its decode
 * performs NO transform, so an impl receiving a raw callable through it does its OWN
 * toJS/applyCallback marshaling, possibly AFTER its own first `await`. By then
 * `withRegionScope`'s synchronous save/restore (region-scope.ts) has already reverted the
 * ambient scope, so a reverse call minted from that stale marshal binds `DETACHED_SCOPE`/
 * `CONSTANT_CTX` instead of the live run — reopening the burst-bypass hole the region-scope
 * gate (see `region.law.test.ts`'s "BURST-BYPASS CLOSED" row) exists to close. `z.procedure`
 * is safe because its wrapper is minted SYNCHRONOUSLY at decode, under the live scope.
 *
 * The fix (common/symbols/rosetta.ts's `buildDynamicSlotCheck`): make the unsafe shape
 * UNAUTHORED — a callable landing in a bare top-level `z.dynamic` slot throws a teaching door
 * instead of silently marshaling under a scope that may already be gone. Enforced as one
 * `invariant(slots.every(...), () => msg)` per position family (kwargs keys / all-positional /
 * selected indices), not a per-slot forEach throw.
 *
 * SCOPE, named (the Q1 retarget): this door is keyed on `"dynamic"` ONLY — neither the banned
 * `z.schemeValue` (structurally excluded from a rosetta contract at COMPILE time now, see
 * `_bake.ts`'s `CrossingResult`/`ContourResult` + `common/__tests__/scheme-zod.test-d.ts`) nor the
 * deprecated `z.value` alias, now DELETED (Phase B, this campaign) — a not-yet-migrated downstream
 * declaration was this door's own documented non-concern until the alias was retired — see
 * `rosetta.ts`'s own z.dynamic-callable door doc.
 */
import { describe, expect, it } from "vitest";
import { EnvCapability } from "../../common/capability.js";
import { exec } from "../../eval/generator-exec.js";
import { toJS } from "../rosetta.js";
import { AValue } from "../../values/primitives/AValue.js";

describe("the z.dynamic-callable door", () => {
  it("a bare z.dynamic slot receiving a lambda throws the teaching door, steering to z.procedure", async () => {
    const cap = EnvCapability.define("test/dynamic-slot-callable-door", {
      symbols: (symbol, z) => ({
        "echo-dynamic": symbol.rosetta`echo-dynamic: hands its raw z.dynamic arg back untouched`(
          { input: [z.dynamic], output: [z.dynamic] },
          function (v) {
            return v;
          },
        ),
      }),
    });

    await expect(exec("(echo-dynamic (lambda (x) x))", { capabilities: [cap] })).rejects.toThrow(
      /a callable argument crossed a z\.dynamic slot/,
    );
    await expect(exec("(echo-dynamic (lambda (x) x))", { capabilities: [cap] })).rejects.toThrow(/z\.procedure/);
  });

  it("the SAME verb called with a non-callable value works — the door is callable-specific, not a value ban", async () => {
    // World-flip rebaseline (ruling 2026-08-13): the impl receives the raw boxed value
    // (decode identity) but returns RAW JS — an AValue return doors (WorldFlipError).
    const cap = EnvCapability.define("test/dynamic-slot-non-callable-ok", {
      symbols: (symbol, z) => ({
        "echo-dynamic": symbol.rosetta`echo-dynamic: echoes its raw z.dynamic arg as plain JS`(
          { input: [z.dynamic], output: [z.dynamic] },
          function (v) {
            return toJS(v as never);
          },
        ),
      }),
    });

    const [result] = await exec("(echo-dynamic 42)", { capabilities: [cap] });
    expect(Number(result)).toBe(42);
  });

  it("a z.procedure slot with a lambda works — the correct door is unaffected", async () => {
    let called = false;
    const cap = EnvCapability.define("test/procedure-slot-lambda-ok", {
      symbols: (symbol, z) => ({
        "call-it": symbol.rosetta`call-it: invokes the procedure arg once`(
          { input: [z.procedure()], output: [z.undefinedResult] },
          async function (fn: (...args: unknown[]) => unknown) {
            await fn(41);
            called = true;
            return undefined;
          },
        ),
      }),
    });

    await exec("(call-it (lambda (x) (+ x 1)))", { capabilities: [cap] });
    expect(called).toBe(true);
  });

  it("a kwargs z.dynamic field receiving a lambda also throws the door, naming the keyword", async () => {
    const cap = EnvCapability.define("test/dynamic-slot-kwargs-door", {
      symbols: (symbol, z) => ({
        "echo-kwargs": symbol.rosetta`echo-kwargs: hands its raw kwargs value back untouched`(
          { input: [], inputRest: { v: z.dynamic }, output: [z.dynamic] },
          function (args) {
            return args.v;
          },
        ),
      }),
    });

    await expect(exec("(echo-kwargs :v (lambda (x) x))", { capabilities: [cap] })).rejects.toThrow(
      /a callable argument crossed a z\.dynamic slot \(keyword argument :v\)/,
    );
  });

  it("a kwargs z.dynamic field receiving a non-callable value still works", async () => {
    const cap = EnvCapability.define("test/dynamic-slot-kwargs-ok", {
      symbols: (symbol, z) => ({
        "echo-kwargs": symbol.rosetta`echo-kwargs: echoes its raw kwargs value as plain JS`(
          { input: [], inputRest: { v: z.dynamic }, output: [z.dynamic] },
          function (args) {
            // World-flip rebaseline: raw JS out; the membrane boxes.
            return toJS(args.v as never);
          },
        ),
      }),
    });

    const [result] = await exec('(echo-kwargs :v "hello")', { capabilities: [cap] });
    expect(result).toBe("hello");
  });

  // LAW (c) — z.dynamic decode is IDENTITY: the impl receives the raw boxed scheme value,
  // no transform (the door rows above pin the callable half). WORLD-FLIP REBASELINE
  // (ruling 2026-08-13): identity holds for the INBOUND face only — the impl's RETURN is
  // JS-world, so the fixture proves receipt of the raw AValue and hands back plain JS.
  it("LAW (c): z.dynamic is identity-crossing — a dict/list/whatever raw scheme value arrives untouched", async () => {
    let receivedBoxed = false;
    const cap = EnvCapability.define("test/dynamic-identity-crossing", {
      symbols: (symbol, z) => ({
        "echo-dynamic": symbol.rosetta`echo-dynamic: identity crossing`(
          { input: [z.dynamic], output: [z.dynamic] },
          function (v) {
            receivedBoxed = v instanceof AValue;
            return toJS(v as never);
          },
        ),
      }),
    });

    const [result] = await exec('(echo-dynamic (list 1 2 "three"))', { capabilities: [cap] });
    expect(receivedBoxed).toBe(true);
    expect(result).toBeTruthy();
  });
});
