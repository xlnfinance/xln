/**
 * LAW — a callable's `arrival/toJS` IS the membrane, not display (ACallable.ts preamble).
 *
 * The protocol returns a HOST-CALLABLE function — the reverse-membrane projection: JS args
 * cross IN through jsToScheme, the apply term runs, the result crosses OUT through
 * toJS. Display is `arrival/print`'s job and stays a `#<procedure:…>` string. The
 * previous behavior (toJS answering the print string) made the protocol lie and forced
 * every crossing to special-case callables before dispatch.
 *
 * REGION-DISCIPLINED (toJS-protocol collapse, ACallable.ts's `hostProjectionOf`): the former
 * CONSTANT_CTX-only, sync-when-possible bare path is GONE — every host projection, reached
 * through this same protocol whether bare or under a real membrane exit, closes over
 * `currentRegionScope() ?? DETACHED_SCOPE` and resolves through `withRegionCall`, so calling
 * the returned host fn always answers a Promise (never a bare synchronous value or throw).
 * Identity is stable per (callable, scope): toJS twice under the SAME scope answers the same
 * host fn (mirroring the callable's own load-bearing reference identity) — never across scopes.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { EnvCapability } from "../../../common/capability.js";
import { execState } from "../../../eval/generator-exec.js";
import { PurityError } from "../../../errors.js";
import { DoorProcedure, ALambda } from "../ACallable.js";
import { ANativeProcedure } from "../ANativeProcedure.js";
import { ARosettaProcedure } from "../ARosettaProcedure.js";
import { is_callable_value } from "../../value-guards.js";

async function lastValue(src: string, opts?: Parameters<typeof execState>[1]): Promise<unknown> {
  const { values } = await execState(src, opts as never);
  return values.at(-1);
}

describe("LAW — callable arrival/toJS is the reverse membrane", () => {
  it("ALambda: toJS returns a host fn; JS args cross in, result crosses out", async () => {
    const lam = (await lastValue("(lambda (x) (+ x 1))")) as ALambda;
    expect(lam).toBeInstanceOf(ALambda);
    const fn = lam["arrival/toJS"]() as (...args: unknown[]) => unknown;
    expect(typeof fn).toBe("function");
    expect(await fn(41)).toBe(42);
  });

  it("ANativeProcedure: toJS round-trips a stdlib verb through both crossings", async () => {
    const plus = (await lastValue("+")) as ANativeProcedure;
    expect(plus).toBeInstanceOf(ANativeProcedure);
    const fn = plus["arrival/toJS"]() as (...args: unknown[]) => unknown;
    expect(await fn(1, 2, 3)).toBe(6);
  });

  it("ARosettaProcedure: toJS crosses through the FULL rosetta marshal (contract stays live)", async () => {
    const cap = EnvCapability.define("law/tojs-rosetta", {
      symbols: (symbol, sz) => ({
        shout: symbol.rosetta`shout: upper-case a string`({ input: [sz.string], output: [sz.string] }, (s) =>
          (s as string).toUpperCase(),
        ),
      }),
    });
    const proc = (await lastValue("shout", { capabilities: [cap], config: {} })) as ARosettaProcedure;
    expect(proc).toBeInstanceOf(ARosettaProcedure);
    const fn = proc["arrival/toJS"]() as (...args: unknown[]) => unknown;
    expect(await fn("quiet")).toBe("QUIET");
    // The contract's rejection grammar survives the projection — a host caller handing a
    // wrong-typed arg gets the humanized positional rejection, not a naked-impl crash.
    await expect(Promise.resolve().then(() => fn(7))).rejects.toThrow(/shout/);
  });

  it("DoorProcedure: crossing a door does not disarm it — the host fn throws the teaching error", async () => {
    const cap = EnvCapability.define("law/tojs-door", {
      configuration: { key: z.string().optional() },
      symbols: (symbol, sz) => ({
        gated: symbol.rosetta`gated: needs config`(
          { input: [], output: [sz.string], requiresConfig: ["key"] },
          function (this: { configuration?: { key?: string } }) {
            return this.configuration?.key ?? "?";
          },
        ),
      }),
    });
    // No config ⇒ the bind chooses a door.
    const door = (await lastValue("gated", { capabilities: [cap], config: {} })) as DoorProcedure;
    expect(door).toBeInstanceOf(DoorProcedure);
    const fn = door["arrival/toJS"]() as (...args: unknown[]) => unknown;
    expect(typeof fn).toBe("function");
    // The door's teaching throw surfaces as a Promise rejection, not a synchronous throw.
    await expect(fn()).rejects.toThrow(PurityError);
  });

  it("identity: toJS twice on the same callable answers the SAME host fn", async () => {
    const lam = (await lastValue("(lambda () 1)")) as ALambda;
    expect(lam["arrival/toJS"]()).toBe(lam["arrival/toJS"]());
  });

  it("display stays print's job: arrival/print still answers #<procedure:…>", async () => {
    const lam = (await lastValue("(lambda (x) x)")) as ALambda;
    expect(is_callable_value(lam)).toBe(true);
    expect(lam["arrival/print"]()).toMatch(/^#<procedure:/);
  });

  it("a scheme→scheme round trip through the host fn preserves values (bifunctor law, scalar leg)", async () => {
    const identity = (await lastValue("(lambda (x) x)")) as ALambda;
    const fn = identity["arrival/toJS"]() as (...args: unknown[]) => unknown;
    expect(await fn("s")).toBe("s");
    expect(await fn(2.5)).toBe(2.5);
    expect(await fn(true)).toBe(true);
  });
});
