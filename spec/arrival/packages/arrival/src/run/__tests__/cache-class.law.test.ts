/**
 * LAW — the EXPLICIT cache class on `Contract` (R1, arrival-mcp-rework-over-phases.md
 * §2.3, Rulings A + B; the D-ledger's D2-superseding declaration).
 *
 * The vocabulary is Solidity's, declared, never derived from the lineage role:
 *   - `view`  = cacheable ACROSS runs (a boundary snapshot worth persisting) — demands a
 *               SERIALIZABLE contract (the bake-time shape gate beside
 *               `assertProvenanceRoleShape`): no z.lambda arms, no z.dynamic slots.
 *   - `pure`  = regenerateable (deterministic from decoded args; recovery = re-call;
 *               never persisted) — NO shape gate.
 *   - absent  = regenerateable, the SAFE default (kills the rosetta default-`source`
 *               hole rev 2.1's role-derivation had — §1.7).
 *
 * LINEAGE ⊥ CACHE (the load-bearing independence): both `view` and `pure` stay
 * provenance `source` on the lineage axis ("we cannot not do it") — `infer` is the
 * standing proof (a provenance SOURCE that declares `cacheClass: "pure"`, Ruling B).
 * The rows here pin that a cache-class declaration NEVER moves the resolved
 * `provenance`, and vice versa.
 */
import { describe, it, expect, beforeAll } from "vitest";
import * as z from "../../common/scheme-zod/index.js";
import { symbol } from "../../symbol/index.js";
import type { CacheClass } from "../../common/symbols/_bake.js";
import { type NativeSymbolDef } from "../../values/primitives/ANativeProcedure.js";
import { type RosettaSymbolDef, type SequenceSymbolDef } from "../../common/symbols/_bake.js";
import { EnvCapability } from "../../common/capability.js";
import { CacheClassShapeError, ProvenanceRoleShapeError } from "../../errors.js";
import { applyCapability, freshEnv } from "../../__tests__/_fresh-env.js";
import type { ResolvingAmbient } from "../../env/AmbientRuntime.js";

/** Test-only cast: pull a minted value's `.contract` (typed `unknown` on the class — see
 *  ACallable.ts) back to its known CONTRACT shape, for direct introspection. Stage A2:
 *  `symbol.native`/`symbol.rosetta`/`symbol.sequence` mint the runtime A-value directly now;
 *  the def they used to RETURN rides `.contract` on it. */
function contractOf<T>(v: { contract: unknown }): T {
  return v.contract as T;
}

describe("cache class — declaration + resolution (never derived, absent = regenerateable)", () => {
  it("a declared `view` on a serializable contract resolves onto the baked def", () => {
    const def = symbol.rosetta`cc-view: a boundary snapshot`(
      { input: [z.string], output: [z.string], cacheClass: "view" },
      (s) => s.toUpperCase(),
    );
    expect(contractOf<RosettaSymbolDef>(def).cacheClass).toBe("view");
  });

  it("a declared `pure` resolves onto the baked def — ungated (z.dynamic slots allowed)", () => {
    const def = symbol.rosetta`cc-pure: contractually deterministic`(
      { input: z.array(z.dynamic), output: [z.dynamic], cacheClass: "pure" },
      (v) => v,
    );
    expect(contractOf<RosettaSymbolDef>(def).cacheClass).toBe("pure");
  });

  it("an undeclared verb carries NO cache class — regenerateable is the safe default, never a resolved kind-default", () => {
    const def = symbol.rosetta`cc-undeclared: `({ input: [z.string], output: [z.string] }, (s) => s);
    expect(contractOf<RosettaSymbolDef>(def).cacheClass).toBeUndefined();
  });

  it("native/sequence carry the same declaration channel (the field rides every Contract-bearing kind)", () => {
    expect(
      contractOf<NativeSymbolDef>(
        symbol.native`cc-native-view: `({ input: [z.string], output: [z.string], cacheClass: "view" }, (s) => s),
      ).cacheClass,
    ).toBe("view");
    expect(
      contractOf<SequenceSymbolDef>(
        symbol.sequence`cc-seq-view: `(
          { input: [z.string], output: [z.string], cacheClass: "view" },
          (args) => args[0],
        ),
      ).cacheClass,
    ).toBe("view");
  });
});

describe("the `view` shape gate — a cache entry must serialize (bake-time door, CacheClassShapeError)", () => {
  it("CacheClassShapeError is contract-shape (not other)", () => {
    try {
      symbol.rosetta`cc-view-cat: `(
        { input: [z.lambda, z.string], output: [z.string], cacheClass: "view" },
        (_f, s) => s,
      );
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(CacheClassShapeError);
      expect((err as CacheClassShapeError)["arrival/error-category"]).toBe("contract-shape");
    }
  });

  it("a `view` with a z.lambda arm throws at bake — a callable is not a boundary snapshot", () => {
    expect(() =>
      symbol.rosetta`cc-view-lambda: `(
        { input: [z.lambda, z.string], output: [z.string], cacheClass: "view" },
        (_f, s) => s,
      ),
    ).toThrow(CacheClassShapeError);
  });

  it("a `view` with a z.dynamic OUTPUT slot throws at bake — the raw escape hatch doesn't serialize", () => {
    expect(() =>
      symbol.rosetta`cc-view-value-out: `({ input: [z.string], output: [z.dynamic], cacheClass: "view" }, (): never => {
        throw new Error("unreachable — the bake-time gate throws before any impl can run");
      }),
    ).toThrow(CacheClassShapeError);
  });

  it("a `view` with a z.dynamic INPUT slot throws at bake — the cache KEY must canonicalize too", () => {
    expect(() =>
      symbol.rosetta`cc-view-value-in: `({ input: [z.dynamic], output: [z.string], cacheClass: "view" }, (v) =>
        String(v),
      ),
    ).toThrow(CacheClassShapeError);
  });

  it("a `view` kwargs contract gates PER FIELD — a z.dynamic field inside the kwargs object throws", () => {
    expect(() =>
      symbol.rosetta`cc-view-kwargs-value: `(
        { input: [], inputRest: { raw: z.dynamic }, output: [z.string], cacheClass: "view" },
        (kw: { raw: unknown }) => String(kw.raw),
      ),
    ).toThrow(CacheClassShapeError);
    // The serializable-kwargs counterpart passes.
    expect(
      contractOf<RosettaSymbolDef>(
        symbol.rosetta`cc-view-kwargs-ok: `(
          { input: [], inputRest: { name: z.string }, output: [z.string], cacheClass: "view" },
          (kw: { name: string }) => kw.name,
        ),
      ).cacheClass,
    ).toBe("view");
  });

  it("`pure` has NO shape gate — the exact contract a view is rejected for bakes fine as pure", () => {
    expect(
      contractOf<RosettaSymbolDef>(
        symbol.rosetta`cc-pure-ungated: `(
          { input: [z.lambda, z.dynamic], output: [z.dynamic], cacheClass: "pure" },
          (_f, v) => v,
        ),
      ).cacheClass,
    ).toBe("pure");
  });
});

describe("the `sink` gate — void-family output (the tombstone-skip's soundness floor)", () => {
  it("a `sink` with a real value output throws (the pre-existing egress gate, unchanged)", () => {
    expect(() =>
      symbol.rosetta`cc-sink-egress: `({ input: [z.string], output: [z.string], provenance: "sink" }, (s) => s),
    ).toThrow(ProvenanceRoleShapeError);
  });

  it("a `sink` with a void-family output passes — [] and [z.undefinedResult] both read as no-egress", () => {
    expect(
      contractOf<RosettaSymbolDef>(
        symbol.rosetta`cc-sink-void: `(
          { input: [z.string], output: [z.undefinedResult], provenance: "sink" },
          () => undefined,
        ),
      ).provenance,
    ).toBe("sink");
    expect(
      contractOf<NativeSymbolDef>(
        symbol.native`cc-sink-empty: `({ input: [z.schemeValue], output: [], provenance: "sink" }, (): [] => []),
      ).provenance,
    ).toBe("sink");
  });
});

describe("lineage ⊥ cache — the infer coexistence law (Ruling B)", () => {
  it("a `pure` cache class coexists with the `source` lineage default — neither axis moves the other", () => {
    const def = symbol.rosetta`cc-infer-shaped: source that declares pure`(
      { input: z.array(z.dynamic), output: [z.dynamic], cacheClass: "pure" },
      (v) => v,
    );
    expect(contractOf<RosettaSymbolDef>(def).provenance).toBe("source"); // lineage: mints (the result is new information)
    expect(contractOf<RosettaSymbolDef>(def).cacheClass).toBe("pure"); // cache: regenerateable by contractual determinism
  });

  it("a `view` cache class leaves a DECLARED lineage role untouched", () => {
    const def = symbol.rosetta`cc-view-pipe: `(
      { input: [z.string], output: [z.string], provenance: "pipe", cacheClass: "view" },
      (s) => s,
    );
    expect(contractOf<RosettaSymbolDef>(def).provenance).toBe("pipe");
    expect(contractOf<RosettaSymbolDef>(def).cacheClass).toBe("view");
  });

  it('the pipe-without-cacheClass row: a `provenance: "pipe"` rosetta with NO cache class stays exactly that — the new field never rewrites the `pure: true` → pipe mapping (removed API)', () => {
    const def = symbol.rosetta`cc-pipe-no-cache: `(
      { input: [z.string], output: [z.string], provenance: "pipe" },
      (s) => s,
    );
    expect(contractOf<RosettaSymbolDef>(def).provenance).toBe("pipe");
    expect(contractOf<RosettaSymbolDef>(def).cacheClass).toBeUndefined();
  });
});

describe("stamping — the resolved class rides the provenanceRole rails onto the bound callable", () => {
  let env: ResolvingAmbient;
  beforeAll(async () => {
    env = await freshEnv();
    await applyCapability(env, [
      EnvCapability.define("test/cache-class-stamp", {
        symbols: (symbol, z) => ({
          "cc/view": symbol.rosetta`cc/view: `({ input: [z.string], output: [z.string], cacheClass: "view" }, (s) => s),
          "cc/pure": symbol.rosetta`cc/pure: `({ input: [z.string], output: [z.string], cacheClass: "pure" }, (s) => s),
          "cc/plain": symbol.rosetta`cc/plain: `({ input: [z.string], output: [z.string] }, (s) => s),
        }),
      }),
    ]);
  });

  it("`cacheClass` is readable off the bound callable via env.get — data on the value, never a duck-read off the def", () => {
    expect((env.get("cc/view") as { cacheClass?: CacheClass }).cacheClass).toBe("view");
    expect((env.get("cc/pure") as { cacheClass?: CacheClass }).cacheClass).toBe("pure");
    expect((env.get("cc/plain") as { cacheClass?: CacheClass }).cacheClass).toBeUndefined();
  });

  it("the provenance stamp is unaffected — every bound verb still carries its resolved lineage role", () => {
    expect((env.get("cc/view") as { provenanceRole?: string }).provenanceRole).toBe("source");
    expect((env.get("cc/pure") as { provenanceRole?: string }).provenanceRole).toBe("source");
    expect((env.get("cc/plain") as { provenanceRole?: string }).provenanceRole).toBe("source");
  });
});
