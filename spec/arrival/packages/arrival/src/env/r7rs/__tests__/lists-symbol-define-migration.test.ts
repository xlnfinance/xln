// lists-symbol-define-migration.test.ts — W4-H2 pack-migration law rows for
// `scheme/lists` (docs/design-history/symbol-define-static-program-validation.md §1/§2.1/§3.3b/§4.2).
//
// Unlike control.ts's H2 sibling (ALL doors) this pack is ALREADY the shape §4.2's
// Pass 2 exists to migrate a pack TOWARD: 17 `symbol.native` + 1 `symbol.sequence`
// (`map`), every callable/constant contract-authored per-define (never a shapeless
// default except the two genuinely-variadic-any ops, `list`/`append`, which are an
// authored judgment call per §1.2's own carve-out — not migration debt), plus 4
// `symbol.notImplemented` purity doors on the mutator family. (`nth` lives on
// scheme/polyglot-clojure — Clojure index-first.) It never carried a
// `prelude` field (the census's "23 production preludes", §4.1, does not include
// it — grep-verified: `grep -rln "prelude:" src/env/` does not return this file).
// Pass 1 (mechanical decomposition) has NOTHING to run over: zero `symbol.define`,
// zero `symbol.defineSyntax`. What DOES apply, one row each:
//
//   ROW 1 — structural: no prelude field; the exact 22-symbol population and its
//     kind split (17 native / 1 sequence / 4 door); every native/sequence def
//     carries a real `in`/`out` contract (never `undefined`); every door carries
//     no contract surface (§1.1/§1.2 apply only to `symbol.define`).
//   ROW 2 — bake: `.lower({})` succeeds with zero deps/config (this pack
//     references nothing outside itself and declares none); natives/sequence bind
//     directly (not doors); the 4 mutator doors bind as `DoorProcedure` with
//     `cause = {owner: "scheme/lists", needs: []}` (permanent design omission,
//     never a door-set-degradation door, §3.7).
//   ROW 3 — contract teaching: firing a door throws the teaching `PurityError`,
//     `name @ owner` display discipline (§3.1) — untouched by this wave (this
//     pack was never migrated in the byte sense).
//   ROW 4 — FV law: N/A structurally (mirrors control's ROW 4, binding's ROW 2,
//     srfi-26's ROW 3): `define-bake.ts`'s §2.1 FV/locality/forward-reference/
//     role-shape checks only walk `kind === "define"` bodies; this pack has none,
//     so `lower({})` cannot throw any of them — structurally unreachable, not
//     merely unexercised. `exports()` (§2.2) derives the 22-name surface purely
//     from `spec.symbols` keys (the `macroAwareDefineNames(spec.prelude)` half of
//     the union is vacuous — no prelude to parse).
//   ROW 5 — the R7RS §6.4 domain boundary the task names explicitly: this pack
//     owns constructors/accessors/search/copy over pairs-and-lists; the c[ad]+r
//     accessor family is explicitly NOT declared here (the header's own claim) —
//     it resolves via a resolver step, never as a bound symbol from this pack's
//     own `spec.symbols`.
//   ROW 6 — chibi conformance cross-check: the 4 mutator doors are covered by the
//     shared purity-invariant `ExpectedFailure` row (registries.ts) alongside the
//     string/vector/bytevector writing methods — an anti-drift pin so a door
//     added/removed here without a matching registry update fails LOUDLY here
//     rather than silently under/over-covering the conformance ledger's
//     651-EXACT gate. (Unlike control.ts's doors, this group is an
//     `ExpectedFailure` — `reason`/`gate` — not an `Exclusion` — `feature` — row;
//     the two registries are typed separately, §11.2, and this pack's doors live
//     in the former.)
//   ROW 7 — base-packs.ts positioning: `lists` is the FIRST of the two BASE_PACKS
//     members any `deps` edge names (`scheme/srfi-235`, W4-H1) — pinned here as a
//     structural fact this migration must not disturb (the task's own DISCIPLINE
//     line): `lists` sits LAST in the assembled array, after every consumer.
import { describe, expect, it } from "vitest";
import listsPack from "../lists.js";
import { EXPECTED_FAILURES } from "../../../__tests__/scheme-compliance/chibi/registries.js";
import {
  PurityError,
  DefineForwardReferenceError,
  DefineLocalityError,
  ProvenanceRoleShapeError,
} from "../../../errors.js";
import { DoorProcedure } from "../../../values/primitives/ACallable.js";
import { freshEnv } from "../../../__tests__/_fresh-env.js";
import { BASE_PACKS } from "../../base-packs.js";
import { execOverFrame as exec, execInFrame } from "../../../eval/generator-exec.js";
import { buildVocabulary } from "../../vocabulary.js";
import type { AEntity, DoorSymbolDef } from "../../../common/symbols/_bake.js";
import type { ResolvingAmbient } from "../../AmbientRuntime.js";
import { harvestContracts } from "../../../__tests__/_symbols-harvest.js";

const evalScheme = (env: unknown, src: unknown): unknown => execInFrame(src as string, env as ResolvingAmbient);

const symbols = harvestContracts(listsPack.spec.symbols);

const DOOR_NAMES = ["set-car!", "set-cdr!", "append!", "list-set!"] as const;

const NATIVE_NAMES = [
  "for-each",
  "cons",
  "list",
  "length",
  "apply",
  "make-list",
  "list-tail",
  "list-ref",
  "list-copy",
  "memq",
  "memv",
  "assq",
  "assv",
  "member",
  "assoc",
  "append",
  "reverse",
] as const;

const SEQUENCE_NAMES = ["map"] as const;

const ALL_NAMES = [...NATIVE_NAMES, ...SEQUENCE_NAMES, ...DOOR_NAMES];

function doorDef(name: string): DoorSymbolDef {
  const def = symbols[name];
  if (def === undefined) throw new Error(`lists pack: no symbol named ${name}`);
  if (def.kind !== "door") throw new Error(`lists pack: ${name} is not a door def (got ${def.kind})`);
  return def;
}

describe("ROW 1 — structural: no prelude, the 22-symbol population is exactly native/sequence/door", () => {
  it("the capability declares no prelude field", () => {
    expect(listsPack.spec.prelude).toBeUndefined();
  });

  it("the capability's symbol population is EXACTLY the documented 22 names (nth lives on polyglot-clojure)", () => {
    expect(Object.keys(symbols).sort()).toEqual([...ALL_NAMES].sort());
  });

  it("every documented native is kind: native", () => {
    for (const name of NATIVE_NAMES) {
      expect(symbols[name]?.kind).toBe("native");
    }
  });

  it("every documented sequence op is kind: sequence", () => {
    for (const name of SEQUENCE_NAMES) {
      expect(symbols[name]?.kind).toBe("sequence");
    }
  });

  it("every documented door is kind: door", () => {
    for (const name of DOOR_NAMES) {
      expect(symbols[name]?.kind).toBe("door");
    }
  });

  it("every native/sequence def carries a real in/out contract (never shapeless-by-omission)", () => {
    for (const name of [...NATIVE_NAMES, ...SEQUENCE_NAMES]) {
      const def = symbols[name] as AEntity & { in?: unknown; out?: unknown };
      expect(def.in, `${name}.in`).toBeDefined();
      expect(def.out, `${name}.out`).toBeDefined();
    }
  });

  it("a door carries no contract surface (§1.1/§1.2 are symbol.define-only)", () => {
    for (const name of DOOR_NAMES) {
      const def = doorDef(name);
      expect("in" in def).toBe(false);
      expect("out" in def).toBe(false);
      expect("body" in def).toBe(false);
    }
  });

  it("every door has a non-empty teaching reason", () => {
    for (const name of DOOR_NAMES) {
      expect(doorDef(name).reason.length).toBeGreaterThan(20);
    }
  });
});

describe("ROW 2 — bake / cause stamping: the vocabulary builds, doors bind with a stamped owner", () => {
  it("a bare vocabulary build — zero deps, zero config — does not throw", async () => {
    await expect(buildVocabulary([listsPack], undefined, evalScheme)).resolves.not.toThrow();
  });

  it("every bound door value is a DoorProcedure carrying cause {owner: 'scheme/lists', needs: []}", async () => {
    const env = await freshEnv();
    for (const name of DOOR_NAMES) {
      const bound = env.get(name);
      expect(bound).toBeInstanceOf(DoorProcedure);
      const proc = bound as DoorProcedure;
      expect(proc.door.cause?.owner).toBe("scheme/lists");
      expect(proc.door.cause?.needs).toEqual([]);
    }
  });

  it("every native/sequence binds to a live, callable value — never a DoorProcedure", async () => {
    const env = await freshEnv();
    for (const name of [...NATIVE_NAMES, ...SEQUENCE_NAMES]) {
      const bound = env.get(name);
      expect(bound, name).toBeDefined();
      expect(bound, name).not.toBeInstanceOf(DoorProcedure);
    }
  });
});

describe("ROW 3 — contract teaching: firing a door throws the name@owner PurityError", () => {
  it.each(DOOR_NAMES)("%s throws PurityError naming itself and its owning capability", async (name) => {
    const env = await freshEnv();
    const bound = env.get(name) as DoorProcedure;
    let caught: unknown;
    try {
      bound["arrival/tagless-final/apply"]();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PurityError);
    const err = caught as PurityError;
    expect(err.owner).toBe("scheme/lists");
    expect(err.feature).toBe(name);
    // §3.1 display discipline: `name @ owner`, never a bare/hash identity.
    expect(err.message).toContain(`${name} @ scheme/lists`);
  });
});

describe("ROW 4 — FV law: N/A structurally (no symbol.define body exists to walk)", () => {
  it("the vocabulary build never throws the §2.1 bake FV errors — nothing here is FV-checked", async () => {
    let caught: unknown;
    try {
      await buildVocabulary([listsPack], undefined, evalScheme);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeUndefined();
    expect(caught).not.toBeInstanceOf(DefineLocalityError);
    expect(caught).not.toBeInstanceOf(DefineForwardReferenceError);
    expect(caught).not.toBeInstanceOf(ProvenanceRoleShapeError);
  });

  it("exports() derives exactly the 22-name surface from spec.symbols alone (the prelude half of the union is vacuous)", async () => {
    const exported = await listsPack.exports();
    expect([...exported].sort()).toEqual([...ALL_NAMES].sort());
  });

  it("no deps are declared — this pack is a deps TARGET, never a deps DECLARER", () => {
    expect(listsPack.spec.deps ?? []).toEqual([]);
  });
});

describe("ROW 5 — R7RS §6.4 domain boundary: the c[ad]+r accessor family lives OUTSIDE this pack", () => {
  it("this pack does not declare car/cdr/caar/cddr/… as bound symbols", () => {
    for (const name of ["car", "cdr", "caar", "cadr", "cdar", "cddr"]) {
      expect(symbols[name]).toBeUndefined();
    }
  });

  it("car/cdr still evaluate in the assembled base env — via the kernel cxr unfold, not this pack's own symbol table", async () => {
    const env = await freshEnv();
    // Kernel-synthesized (eval/Resolver.ts#cxrUnfold, see __tests__/cxr-accessor.test.ts): not a
    // bound symbol at all, so this exercises evaluation (exec), not a raw env.get() lookup.
    expect((await exec("(car '(10 20 30))", { env }))[0]).toBeDefined();
    expect((await exec("(cdr '(10 20 30))", { env }))[0]).toBeDefined();
  });
});

describe("ROW 6 — chibi conformance cross-check: the 4 mutator doors are covered by the shared purity ExpectedFailure row", () => {
  function coveredBySomeRule(name: string): boolean {
    return EXPECTED_FAILURES.some(
      (rule) =>
        rule.match.kind === "symbols" && rule.match.anyOf.includes(name) && rule.reason.includes("purity invariant"),
    );
  }

  it.each(DOOR_NAMES)("%s is named in a purity-invariant ExpectedFailure symbols rule", (name) => {
    expect(coveredBySomeRule(name)).toBe(true);
  });
});

describe("ROW 7 — base-packs.ts positioning: lists stays LAST (C3-safe for every deps edge naming it)", () => {
  // Polyglot declares deps of its own (incl. `lists` and `srfi-1`), so it leads
  // the C3 tail and `lists` is last — still after every consumer. See
  // base-packs.ts's header for the full tail-order story.
  it("lists is present in BASE_PACKS exactly once, at the LAST position — after every deps-declaring consumer (polyglot leads the tail)", () => {
    const names = BASE_PACKS.map((pack) => pack.name);
    const listsIndex = names.indexOf("scheme/lists");
    expect(listsIndex).toBeGreaterThan(-1);
    expect(listsIndex).toBe(names.length - 1);
    // polyglot precedes lists (it depends on it now) — and srfi-1 sits between
    // (polyglot → srfi-1 → … → lists is the declared dep chain's tail order).
    const polyglotIndex = names.indexOf("scheme/polyglot");
    const srfi1Index = names.indexOf("scheme/srfi-1");
    expect(polyglotIndex).toBeGreaterThan(-1);
    expect(polyglotIndex).toBeLessThan(srfi1Index);
    expect(srfi1Index).toBeLessThan(listsIndex);
  });
});
