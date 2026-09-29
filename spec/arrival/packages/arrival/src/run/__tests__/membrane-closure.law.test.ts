/**
 * LAW — RunContext.membraneClosure wraps every membrane interaction.
 *
 * The wrap is the host's observation seam (docs/execution.md §REACTIVITY): borrowed-
 * store reads, host-fn fire, reverse-membrane re-entry, result egress. Unset ⇒
 * identity. Reverse wrappers close over scope.runCtx at mint so a late JS→Scheme
 * call after exec returns still sees this run's wrap.
 */
import { describe, expect, it } from "vitest";
import { EnvCapability } from "../../common/capability.js";
import { exec, execState } from "../../eval/generator-exec.js";
import { applyMembraneClosure, CONSTANT_CTX, RunContext } from "../RunContext.js";
import { jsToScheme, toJS } from "../../membrane/rosetta.js";
import { openRegionScope, withRegionScope } from "../../membrane/region-scope.js";
import { testCallCtx } from "../CallCtx.js";
import { ALambda, applyCallback } from "../../values/primitives/ACallable.js";
import { AExact } from "../../values/primitives/AExact.js";
import { AJSObject } from "../../membrane/AJSObject.js";
import { tf } from "../../values/tagless-final.js";

function countingWrap(): { wrap: <T>(work: () => T) => T; count: () => number } {
  let n = 0;
  return {
    wrap: <T>(work: () => T): T => {
      n++;
      return work();
    },
    count: () => n,
  };
}

describe("applyMembraneClosure — identity when unset", () => {
  it("runs work unchanged on undefined runCtx / CONSTANT_CTX / an unarmed live ctx", () => {
    let ran = 0;
    const work = (): number => {
      ran++;
      return 7;
    };
    expect(applyMembraneClosure(undefined, work)).toBe(7);
    expect(applyMembraneClosure(CONSTANT_CTX, work)).toBe(7);
    expect(applyMembraneClosure(new RunContext({}), work)).toBe(7);
    expect(ran).toBe(3);
  });

  it("invokes the wrap and returns work's value", () => {
    const { wrap, count } = countingWrap();
    const runCtx = new RunContext({ membraneClosure: wrap });
    expect(applyMembraneClosure(runCtx, () => "ok")).toBe("ok");
    expect(count()).toBe(1);
  });
});

describe("ExecOptions.membraneClosure — arming", () => {
  it("rides onto the minted RunContext", async () => {
    const { wrap, count } = countingWrap();
    const state = await execState("1", { membraneClosure: wrap });
    expect(state.runCtx.membraneClosure).toBe(wrap);
    // result egress through exec's toJS wrap
    const [value] = await exec("1", { membraneClosure: wrap });
    expect(value).toBe(1);
    expect(count()).toBeGreaterThan(0);
  });
});

describe("borrowed-store terms", () => {
  it("(@ obj :x) / (:x obj) / @? / @keys fire the wrap", async () => {
    const { wrap, count } = countingWrap();
    const obj = { x: 1, y: 2 };
    const cap = EnvCapability.define("test/membrane-closure-obj", {
      symbols: (symbol, z) => ({
        obj: symbol.rosetta`obj: the host object`({ input: [], output: [z.dynamic] }, () => obj),
      }),
    });
    const before = count();
    const [got] = (await exec(`(list (@ (obj) :x) (:x (obj)) (@? (obj) :y) (vector-length (@keys (obj))))`, {
      capabilities: [cap],
      membraneClosure: wrap,
    })) as [unknown[]];
    expect(got).toEqual([1, 1, true, 2]);
    expect(count()).toBeGreaterThan(before);
  });

  it("vector-ref / length on a borrowed array fire the wrap", async () => {
    const { wrap, count } = countingWrap();
    const cap = EnvCapability.define("test/membrane-closure-arr", {
      symbols: (symbol, z) => ({
        arr: symbol.rosetta`arr: the host array`({ input: [], output: [z.dynamic] }, () => [10, 20, 30]),
      }),
    });
    const before = count();
    const [got] = (await exec(`(list (vector-ref (arr) 1) (length (arr)))`, {
      capabilities: [cap],
      membraneClosure: wrap,
    })) as [unknown[]];
    expect(got).toEqual([20, 3]);
    expect(count()).toBeGreaterThan(before);
  });

  it("direct TF get with a live runCtx fires; CONSTANT_CTX does not", () => {
    const { wrap, count } = countingWrap();
    const runCtx = new RunContext({ membraneClosure: wrap });
    const boxed = jsToScheme(runCtx, { a: 1 }) as AJSObject;
    expect(boxed[tf("get")]("a", runCtx)).toBeInstanceOf(Object);
    const afterLive = count();
    expect(afterLive).toBeGreaterThan(0);
    boxed[tf("get")]("a", CONSTANT_CTX);
    expect(count()).toBe(afterLive);
  });
});

describe("host-fn fire + reverse-membrane re-entry", () => {
  it("applying a borrowed host fn fires the wrap", async () => {
    const { wrap, count } = countingWrap();
    const cap = EnvCapability.define("test/membrane-closure-fn", {
      symbols: (symbol, z) => ({
        "host-add": symbol.rosetta`host-add: a host fn`(
          { input: [], output: [z.dynamic] },
          () => (a: number, b: number) => a + b,
        ),
      }),
    });
    const before = count();
    const [sum] = await exec(`((host-add) 2 3)`, { capabilities: [cap], membraneClosure: wrap });
    expect(sum).toBe(5);
    expect(count()).toBeGreaterThan(before);
  });

  it("a reverse-membrane wrapper invocation fires the wrap, including after exec returns", async () => {
    const { wrap, count } = countingWrap();
    const runCtx = new RunContext({ membraneClosure: wrap });
    const scope = openRegionScope({ runCtx, dynSite: undefined });
    const lam = new ALambda({
      name: "id",
      arity: { min: 1, max: 1 },
      scope: undefined,
      runner: (args) => args[0]!,
    });
    const wrapper = withRegionScope(scope, () => toJS(lam)) as (...a: unknown[]) => Promise<unknown>;
    const before = count();
    expect(await wrapper(1)).toBe(1);
    expect(count()).toBeGreaterThan(before);
    // Late call — exec is not on the stack; wrap is closed over scope.runCtx.
    const mid = count();
    expect(await wrapper(2)).toBe(2);
    expect(count()).toBeGreaterThan(mid);
  });

  it("a baked rosetta hostImpl fires the wrap", async () => {
    const { wrap, count } = countingWrap();
    let impls = 0;
    const cap = EnvCapability.define("test/membrane-closure-rosetta", {
      symbols: (symbol, z) => ({
        inc: symbol.rosetta`inc: add one`({ input: [z.number], output: [z.number] }, (n: number) => {
          impls++;
          return n + 1;
        }),
      }),
    });
    const before = count();
    const [n] = await exec("(inc 4)", { capabilities: [cap], membraneClosure: wrap });
    expect(n).toBe(5);
    expect(impls).toBe(1);
    expect(count()).toBeGreaterThan(before);
  });
});

describe("applyCallback of a host-fn lens under a live CallCtx", () => {
  it("hostFnToCallable apply goes through the wrap", async () => {
    const { wrap, count } = countingWrap();
    const runCtx = new RunContext({ membraneClosure: wrap });
    const proc = jsToScheme(runCtx, (x: number) => x * 2);
    const before = count();
    const result = await applyCallback(proc as never, [new AExact(6)], testCallCtx({ runCtx }));
    expect((result as AExact).valueOf()).toBe(12);
    expect(count()).toBeGreaterThan(before);
  });
});
