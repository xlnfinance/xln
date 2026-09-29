/**
 * LAW — the host-function INBOUND reverse-membrane lens.
 *
 * V's ruling (2026-07-24, verbatim, stage-c-corpse-deletion.md §"V rulings batch"):
 * "Host fn — reverse membrane, yes. And we should also support function returns
 * inside symbol.rosetta with same logic — we pass fn into scheme, args gets
 * scheme→js when passed, result goes js→scheme when returned." A bare host function
 * crossing js→scheme (jsToScheme's FOREIGN_LENS_CLAIMS function row, boxing.ts's
 * `fromJs` function arm, and a `symbol.rosetta` impl RETURNING a function — one
 * mechanism, three entry points) becomes a genuine scheme-callable
 * `ARosettaProcedure` (`ACallable.ts`'s `hostFnToCallable`): when scheme applies it,
 * args cross scheme→js (default-options `toJS`), the host fn runs, and its
 * result crosses js→scheme (under the CALLING invocation's run) — promise-tolerant.
 *
 * This completes the callable bifunctor `ACallable.ts`'s `hostProjectionOf` already
 * gives the OTHER direction (scheme callable → host fn — see
 * `values/primitives/__tests__/callable-tojs-membrane.test.ts`, which owns that half).
 *
 * Four laws pinned here:
 *  1. MARSHAL — applying the minted callable crosses scheme args→js, calls the host
 *     fn, crosses its result (sync or Promise) back js→scheme.
 *  2. IDENTITY — the SAME host fn crossing IN twice within one run answers the SAME
 *     callable (`eq?`); a DIFFERENT run mints its own; `jsToScheme` and `fromJs`
 *     share the one cache (one mechanism, two entry points).
 *  3. REVERSE-THEN-FORWARD — a callable's own `hostProjectionOf` wrapper crossing
 *     back IN re-admits as the ORIGINAL callable (`eq?`), never re-wrapped — the
 *     function-shaped sibling of R9's container re-admission.
 *  4. ROSETTA-RETURN — a `symbol.rosetta` verb with a `z.dynamic` output slot
 *     returning a bare host fn lands automatically through the SAME lens; no
 *     dedicated codec was needed (the escape-hatch slot skips `z.encode` entirely,
 *     handing the raw function straight to `jsToScheme`).
 */
import { describe, expect, it } from "vitest";
import { CONSTANT_CTX, RunContext } from "../../run/RunContext.js";
import { jsToScheme } from "../rosetta.js";
import { fromJs } from "../boxing.js";
import { ALambda, applyCallback } from "../../values/primitives/ACallable.js";
import { ARosettaProcedure } from "../../values/primitives/ARosettaProcedure.js";
import { testCallCtx } from "../../run/CallCtx.js";
import { AExact } from "../../values/primitives/AExact.js";
import { AString } from "../../values/primitives/AString.js";
import { APair } from "../../values/primitives/APair.js";
import { EnvCapability } from "../../common/capability.js";
import { execState } from "../../eval/generator-exec.js";

async function lastValue(src: string, opts?: Parameters<typeof execState>[1]): Promise<unknown> {
  const { values } = await execState(src, opts as never);
  return values.at(-1);
}

describe("LAW — host-function inbound reverse-membrane lens", () => {
  describe("marshal: scheme args cross scheme→js, the result crosses js→scheme", () => {
    it("a number/string/list arg reaches the host fn as plain JS; the returned number boxes back", async () => {
      let seenArgs: unknown[] = [];
      const hostFn = (...args: unknown[]) => {
        seenArgs = args;
        return (args[0] as number) + 1;
      };
      const proc = jsToScheme(CONSTANT_CTX, hostFn);
      expect(proc).toBeInstanceOf(ARosettaProcedure);

      const schemeArgs = [
        new AExact(41),
        new AString("hi"),
        APair.fromArray(CONSTANT_CTX, [new AExact(1), new AExact(2)]),
      ];
      const result = await applyCallback(proc, schemeArgs, testCallCtx());

      expect(seenArgs[0]).toBe(41);
      expect(seenArgs[1]).toBe("hi");
      // R9 lazy array face — the standard outbound shape a list takes at the membrane,
      // same as any other scheme→JS list crossing (crossing.law.test.ts's own law).
      expect(Array.isArray(seenArgs[2])).toBe(true);
      expect(seenArgs[2]).toEqual([1, 2]);

      expect(result).toBeInstanceOf(AExact);
      expect((result as AExact).num).toBe(42);
    });

    it("promise-tolerant: an async host fn's result crosses through the SAME lens", async () => {
      const hostFn = async (n: unknown) => (n as number) * 2;
      const proc = jsToScheme(CONSTANT_CTX, hostFn);
      const result = await applyCallback(proc, [new AExact(21)], testCallCtx());
      expect(result).toBeInstanceOf(AExact);
      expect((result as AExact).num).toBe(42);
    });

    it("arity is honestly unbounded ({min:0, max:null}) — an arbitrary host fn's real arity is not introspectable", () => {
      const proc = jsToScheme(CONSTANT_CTX, (a: unknown, b: unknown) => a === b);
      expect(proc.arity).toEqual({ min: 0, max: null });
    });

    it("prints honestly: #<procedure:name>, falling back for an anonymous closure", () => {
      function namedHostFn() {
        return 1;
      }
      const named = jsToScheme(new RunContext({}), namedHostFn);
      expect(named["arrival/print"]()).toBe("#<procedure:namedHostFn>");

      const anon = jsToScheme(new RunContext({}), () => 1);
      expect(anon["arrival/print"]()).toBe("#<procedure:host-function>");
    });
  });

  describe("identity: mint-or-reuse per (RunContext, host fn)", () => {
    it("the SAME host fn crossing IN twice within one run answers the SAME callable (eq?)", () => {
      const hostFn = () => 1;
      const a = jsToScheme(CONSTANT_CTX, hostFn);
      const b = jsToScheme(CONSTANT_CTX, hostFn);
      expect(a).toBe(b);
    });

    it("a DIFFERENT run wrapping the SAME host fn mints its OWN callable", () => {
      const hostFn = () => 1;
      const runA = new RunContext({});
      const runB = new RunContext({});
      const a = jsToScheme(runA, hostFn);
      const b = jsToScheme(runB, hostFn);
      expect(a).not.toBe(b);
    });

    it("fromJs's function arm and jsToScheme's function row share the ONE run-scoped cache", () => {
      const hostFn = () => 1;
      const viaJsToScheme = jsToScheme(CONSTANT_CTX, hostFn);
      const viaFromJs = fromJs(CONSTANT_CTX, hostFn);
      expect(viaFromJs).toBe(viaJsToScheme);
    });

    it("provenance stamps ONLY at first mint — a procedure's identity is load-bearing, so a later crossing with different provenance does not fork it", () => {
      const hostFn = () => 1;
      const prov = new Set<number>([99]);
      const first = jsToScheme(CONSTANT_CTX, hostFn, {}, prov);
      expect([...first.provenance]).toEqual([99]);
      const second = jsToScheme(CONSTANT_CTX, hostFn, {}, new Set<number>([123]));
      expect(second).toBe(first);
      expect([...second.provenance]).toEqual([99]); // unchanged — no-op withProvenance, like every ACallable sibling
    });
  });

  describe("reverse-then-forward: a callable's own host projection re-admits by identity", () => {
    it("hostProjectionOf's wrapper crossing back IN via jsToScheme re-admits as the ORIGINAL callable (eq?), never re-wrapped", async () => {
      const lam = (await lastValue("(lambda (x) x)")) as ALambda;
      const wrapper = lam["arrival/toJS"]() as (...args: unknown[]) => unknown;
      expect(jsToScheme(CONSTANT_CTX, wrapper)).toBe(lam);
    });

    it("the SAME re-admission holds crossing back IN via fromJs", async () => {
      const lam = (await lastValue("(lambda (x) x)")) as ALambda;
      const wrapper = lam["arrival/toJS"]() as (...args: unknown[]) => unknown;
      expect(fromJs(CONSTANT_CTX, wrapper)).toBe(lam);
    });

    it("an ARosettaProcedure minted BY the inbound lens itself round-trips the same way once exported", async () => {
      const hostFn = () => 1;
      const proc = jsToScheme(CONSTANT_CTX, hostFn);
      const wrapper = proc["arrival/toJS"]() as (...args: unknown[]) => unknown;
      expect(wrapper).not.toBe(hostFn); // a genuine marshal wrapper, not the raw fn
      expect(jsToScheme(CONSTANT_CTX, wrapper)).toBe(proc); // but IT re-admits by identity
    });
  });

  describe("rosetta-return: a symbol.rosetta z.dynamic output returning a bare host fn lands as a callable, no dedicated codec needed", () => {
    it("scheme receives a callable and applying it marshals both legs correctly", async () => {
      const cap = EnvCapability.define("law/host-fn-lens-rosetta-return", {
        symbols: (symbol, sz) => ({
          "make-adder": symbol.rosetta`make-adder: returns a bare host fn`({ input: [], output: [sz.dynamic] }, () => {
            const adder = (n: unknown) => (n as number) + 1;
            // reverse-membrane: host fn is a legal dynamic payload at runtime
            return adder as unknown as import("../../values/types.js").SchemeValue;
          }),
        }),
      });
      const result = await lastValue("((make-adder) 41)", { capabilities: [cap], config: {} });
      expect(result).toBeInstanceOf(AExact);
      expect((result as AExact).num).toBe(42);
    });
  });
});
