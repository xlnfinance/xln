/**
 * LAW — dynamic symbol METADATA (exec-phases-and-dynamic-metadata.md Part II).
 * The per-FIELD static-or-dynamic union + the three §2.3 resolution rulings:
 *
 *   1. LAZY AT READ — `lower()`/`assembleAmbient()` NEVER invoke a metadata fn (not to
 *      validate, not to warm); resolution happens per describe/catalog read against the
 *      phase-2 activation. A field touching a resource spawns it on FIRST READ through
 *      the cell's normal lazy single-flight — a metadata read IS a first touch.
 *   2. PER-READ, NO MEMO — every read re-fires the fn (the shipped McpAnnotation
 *      cadence; a memo is a cache with no invalidation story).
 *   3. `undefined` RESOLUTION — the key is omitted, NOT flagged dynamic (the honest-
 *      failure contract: the consumer falls back to the static sibling).
 *
 * Plus: the factory stamping (rosetta's `opts.metadata` reaches the def — the drop this
 * design closed), the `typeof === "function"` discriminant, and the §2.1 static-subset
 * enumerability (zero assembly).
 */
import { describe, expect, it } from "vitest";

import { z as hostZod } from "zod";

import * as z from "../../common/scheme-zod/index.js";
import { symbol } from "../../symbol/index.js";
import { resolveMetadata, staticMetadata } from "../../common/symbols/metadata.js";
import type { NativeSymbolDef } from "../../values/primitives/ANativeProcedure.js";
import type { RosettaSymbolDef } from "../../common/symbols/_bake.js";
import type { Activation } from "../../common/capability.js";

const zz = { string: z.string, number: z.number };

/** Test-only cast — see symbol.test.ts's own copy of this helper for the full rationale
 *  (Stage A2: `symbol.native`/`symbol.rosetta` mint the value directly; the metadata bag
 *  rides `.contract` on it). */
function contractOf<T>(v: { contract: unknown }): T {
  return v.contract as T;
}

describe("factory stamping — the metadata bag reaches the def (the closed drop)", () => {
  it("symbol.rosetta stamps opts.metadata onto the def; dynamic fields stay UN-invoked at bake", () => {
    let fired = 0;
    const def = symbol.rosetta`law/meta: doc line`({ input: [], output: [zz.string] }, () => "v", {
      metadata: {
        description: "static text",
        dynamicDescription: function () {
          fired += 1;
          return "live";
        },
      },
    });
    expect(contractOf<RosettaSymbolDef>(def).metadata?.description).toBe("static text");
    expect(typeof contractOf<RosettaSymbolDef>(def).metadata?.dynamicDescription).toBe("function"); // the discriminant
    expect(fired).toBe(0); // bake resolved NOTHING
  });

  it("symbol.native carries the same optional bag", () => {
    const def = symbol.native`law/meta-native: doc`({ input: [zz.number], output: [zz.number] }, (n) => n, {
      metadata: { docUrl: "https://example.test" },
    });
    expect(contractOf<NativeSymbolDef>(def).metadata?.docUrl).toBe("https://example.test");
  });

  it("staticMetadata — the §2.1 enumerable static subset, total at module load (zero assembly)", () => {
    const bag = { a: 1, b: "x", live: () => "nope" };
    expect(staticMetadata(bag)).toEqual({ a: 1, b: "x" });
    expect(staticMetadata(undefined)).toEqual({});
  });
});

describe("resolveMetadata — the unit surface (fake activation, no assembly)", () => {
  const activation = { configuration: { url: "https://cfg" }, resources: {}, degradation: {} } as unknown as Activation<
    any,
    any
  >;

  it("static fields pass through verbatim; dynamic fields resolve with `this` = the activation", async () => {
    const { resolved, dynamicKeys } = await resolveMetadata(
      {
        description: "static",
        endpoint: function (this: { configuration: { url: string } }) {
          return this.configuration.url;
        },
      },
      activation,
    );
    expect(resolved).toEqual({ description: "static", endpoint: "https://cfg" });
    expect(dynamicKeys).toEqual(["endpoint"]);
  });

  it("ruling 3: an undefined resolution omits the key and is NOT flagged dynamic", async () => {
    const { resolved, dynamicKeys } = await resolveMetadata(
      { description: "the static sibling", dynamicDescription: () => undefined },
      activation,
    );
    expect(resolved).toEqual({ description: "the static sibling" });
    expect("dynamicDescription" in resolved).toBe(false);
    expect(dynamicKeys).toEqual([]);
  });
});

// STAGE C CUT 3b (docs/plans/stage-c-corpse-deletion.md) retired `AssembledAmbient` — the
// `describeSymbol`/`catalog()` READ CHANNEL this describe block pinned (exec-phases.ts's
// `rosterEntries`/`describeEntry` machinery) died with it, with no self-hosted-vocabulary-path
// equivalent built in this cut. The `resolveMetadata`/`staticMetadata` UNIT surface above (which
// this channel was itself a thin consumer of) still carries the three §2.3 rulings' full
// coverage. Re-introducing a describe/catalog read surface over the vocabulary path — if wanted
// — is Cut-4/MCP-rework territory (the same read channel `arrival-mcp`'s DiscoveryTool would
// need), not this cut's.
