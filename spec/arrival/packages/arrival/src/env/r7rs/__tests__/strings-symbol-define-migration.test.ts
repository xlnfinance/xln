// strings-symbol-define-migration.test.ts — W4-H2 pack-migration audit row for
// `scheme/strings` (docs/design-history/symbol-define-static-program-validation.md §1/§2/§4).
//
// THE FINDING (structural, verified against HEAD and the pack's entire git
// history via `git log --all -p --follow -- src/env/r7rs/strings.ts`): this
// pack has NEVER carried a `prelude` field and contains ZERO `define-macro`
// forms. Every symbol is `symbol.native` or `symbol.notImplemented` (purity
// doors for string-set!/string-fill!/string-copy!). §4.1's census (23 production
// `EnvCapability` preludes, script-regeneratable) does NOT list `scheme/
// strings` — this pack was never prelude-carrying, so there is no Pass 1
// (mechanical decomposition) and no Pass 2 (contract authoring, §4.2) surface
// for it. `symbol.define`/`symbol.defineSyntax` are new declaration KINDS for
// SCHEME-BODIED code (§1.1); a native pack's ops are already typed, contracted
// JS impls — migrating them to scheme-bodied defines is not what W4 asks for
// and would in fact WORSEN the harvest fidelity (native contracts are already
// checked at TS compile time against `Impl<I,O>`; a scheme body gets no such
// check, §1.2's own (a)).
//
// This file pins that finding as a live, re-checked fact (not a comment that
// can silently rot) plus the one coupling check the wave's assignment calls
// out explicitly: `scheme/srfi-13` is the OTHER string pack (SRFI-13 + SRFI-
// 152's `string-split`) — confirm ZERO symbol-name overlap between the two,
// so there is no undeclared cross-capability reference of the §2.1 FV-law
// shape (the srfi-235→polyglot `compose` catch) hiding in this pair. Four
// rows:
//
//   ROW 1 — structural: no `prelude` field; every symbol's baked `kind` is
//     one of native/door/rosetta — zero `define`/`define-syntax` entries.
//   ROW 2 — coupling: `scheme/strings` and `scheme/srfi-13` export disjoint
//     name sets (verified at both authoring time here and against the two
//     packs' own `symbols` records) — no dep to declare, flagged as checked
//     rather than silently assumed.
//   ROW 3 — bake sanity: the pack still lowers cleanly (the one gate that DOES
//     apply universally, migrated or not) and a representative op runs
//     end-to-end, unregressed.
//   ROW 4 — FV law / macro firewall: N/A, asserted structurally. §2.1's bake
//     FV law and §3.4's macro-firewall ternary are properties of
//     `symbol.define`/`symbol.defineSyntax` bodies (`define-bake.ts` skips
//     both for every other kind, exactly as the binding-pack migration's own
//     ROW 2 note observes) — with zero such entries in this pack, both are
//     vacuously satisfied, not merely untested.
import { describe, expect, it } from "vitest";
import { execStateOverFrame as execState } from "../../../eval/generator-exec.js";
import { freshEnv } from "../../../__tests__/_fresh-env.js";
import type { AEntity } from "../../../common/symbols/_bake.js";
import stringsPack from "../strings.js";
import srfi13Pack from "../../srfi/srfi-13.js";
import { harvestContracts } from "../../../__tests__/_symbols-harvest.js";

const stringsSymbols = harvestContracts(stringsPack.spec.symbols);
const srfi13Symbols = harvestContracts(srfi13Pack.spec.symbols);

describe("ROW 1 — structural: scheme/strings was never prelude-carrying, and stays that way", () => {
  it("the capability declares no prelude field", () => {
    expect(stringsPack.spec.prelude).toBeUndefined();
  });

  it("every symbol's baked kind is native, door, or rosetta — zero define/define-syntax entries", () => {
    const kinds = new Set(Object.values(stringsSymbols).map((def) => def.kind));
    expect(kinds).toEqual(new Set(["native", "door"]));
    expect(Object.values(stringsSymbols).some((def) => def.kind === "define" || def.kind === "define-syntax")).toBe(
      false,
    );
  });

  it("R7RS §6.7 string names are present — no residual extensions (concat/join/string-contains live elsewhere)", () => {
    expect(Object.keys(stringsSymbols).sort()).toEqual(
      [
        "make-string",
        "string",
        "string-length",
        "string-ref",
        "string-set!",
        "string-fill!",
        "string=?",
        "string<?",
        "string>?",
        "string<=?",
        "string>=?",
        "string-ci=?",
        "string-ci<?",
        "string-ci>?",
        "string-ci<=?",
        "string-ci>=?",
        "string-append",
        "string->list",
        "list->string",
        "string-copy",
        "string-copy!",
        "string-upcase",
        "string-downcase",
        "string-foldcase",
        "string-map",
        "string-for-each",
        "substring",
        "string->number",
      ].sort(),
    );
  });
});

describe("ROW 2 — coupling: scheme/strings ⊥ scheme/srfi-13, no undeclared cross-reference", () => {
  it("the two string packs export disjoint symbol-name sets (zero overlap ⇒ nothing to declare as a dep)", () => {
    const stringsNames = new Set(Object.keys(stringsSymbols));
    const srfi13Names = new Set(Object.keys(srfi13Symbols));
    const overlap = [...stringsNames].filter((name) => srfi13Names.has(name));
    expect(overlap).toEqual([]);
  });

  it("scheme/strings declares no deps (nothing to declare — the disjointness above is the reason)", () => {
    expect(stringsPack.spec.deps).toBeUndefined();
  });
});

describe("ROW 3 — bake sanity: the pack lowers cleanly and behaves unregressed", () => {
  it("assembles in the shared base env without throwing (freshEnv assembles every BASE_PACKS capability, this one included)", async () => {
    await expect(freshEnv()).resolves.toBeDefined();
  });

  it("a representative op (string-append, R7RS §6.7) runs end-to-end", async () => {
    const env = await freshEnv();
    const { values } = await execState('(string-append "foo" "bar")', { env });
    expect(String(values[values.length - 1])).toBe("foobar");
  });

  it("a representative door (string-set!, the purity omission) still teaches rather than mutating", async () => {
    const env = await freshEnv();
    await expect(execState("(string-set! (make-string 3 #\\a) 0 #\\b)", { env })).rejects.toThrow();
  });
});

describe("ROW 4 — FV law / macro firewall: N/A, vacuously satisfied", () => {
  it("no symbol.define entries ⇒ §2.1's bake FV law has no body to check in this pack", () => {
    expect(Object.values(stringsSymbols).filter((def) => def.kind === "define")).toEqual([]);
  });

  it("no symbol.defineSyntax entries ⇒ §3.4's macroAttribute ternary has nothing to classify in this pack", () => {
    expect(Object.values(stringsSymbols).filter((def) => def.kind === "define-syntax")).toEqual([]);
  });
});
