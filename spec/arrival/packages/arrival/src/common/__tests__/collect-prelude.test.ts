// collectPrelude — every capability's `.spec.prelude`, DAG order (deps before dependents,
// matching lower()'s own apply order), deduplicated by capability identity. Exists so an
// editor/type-lens's ambient scheme vocabulary can be derived from the REAL assembled
// capability set instead of a hand-picked subset that silently drifts (the class of bug
// this fixes: `define/overridable`'s macro read as unresolved in studio's live editor
// because the caller named two capabilities' preludes by hand instead of walking the set).
import { describe, expect, it } from "vitest";
import { EnvCapability } from "../capability.js";
import { collectPrelude, collectSymbolDefines } from "../capability-internals.js";
import polyglot from "../../env/polyglot/polyglot.js";
import { BASE_ROSTER } from "../../env/base-roster.js";

describe("collectPrelude", () => {
  it("returns a single capability's own prelude", () => {
    const a = EnvCapability.define("a", { prelude: "(define a 1)", symbols: () => ({}) });
    expect(collectPrelude([a])).toBe("(define a 1)");
  });

  it("includes a dep's prelude BEFORE the dependent's own (matches apply order)", () => {
    const base = EnvCapability.define("base", { prelude: "(define base 1)", symbols: () => ({}) });
    const dependent = EnvCapability.define("dependent", {
      prelude: "(define dependent 2)",
      deps: [base],
      symbols: () => ({}),
    });
    expect(collectPrelude([dependent])).toBe("(define base 1)\n(define dependent 2)");
  });

  it("deduplicates a diamond-shaped dep graph — the shared dep's prelude appears ONCE", () => {
    const shared = EnvCapability.define("shared", { prelude: "(define shared 0)", symbols: () => ({}) });
    const left = EnvCapability.define("left", { prelude: "(define left 1)", deps: [shared], symbols: () => ({}) });
    const right = EnvCapability.define("right", { prelude: "(define right 2)", deps: [shared], symbols: () => ({}) });
    const result = collectPrelude([left, right]);
    expect(result.match(/define shared/g)?.length).toBe(1);
    expect(result).toBe("(define shared 0)\n(define left 1)\n(define right 2)");
  });

  it("skips a capability with no prelude — no stray blank entries", () => {
    const noPrelude = EnvCapability.define("no-prelude", { symbols: () => ({}) });
    const withPrelude = EnvCapability.define("with-prelude", { prelude: "(define x 1)", symbols: () => ({}) });
    expect(collectPrelude([noPrelude, withPrelude])).toBe("(define x 1)");
  });

  it("empty input yields an empty string", () => {
    expect(collectPrelude([])).toBe("");
  });
});

describe("collectSymbolDefines — polyglot natives with authored `type`", () => {
  it("emits a type-lens stub for polyglot `str` (native, no scheme body)", () => {
    expect(collectSymbolDefines([polyglot])).toMatch(/\(define str \(lambda args ""\)\)/);
  });

  it("emits `join` the same way; does not emit R7RS natives from other packs", () => {
    const harvested = collectSymbolDefines([polyglot]);
    expect(harvested).toMatch(/\(define join \(lambda args ""\)\)/);
    expect(harvested).not.toMatch(/\(define car\b/);
    expect(harvested).not.toMatch(/\(define \+\b/);
  });

  it("BASE_ROSTER harvest includes polyglot `str`", () => {
    expect(collectSymbolDefines(BASE_ROSTER)).toMatch(/\(define str \(lambda args ""\)\)/);
  });
});
