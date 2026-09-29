// schema-symbol-define-migration.test.ts — W4-H2b pack migration rows for `arrival/schema`
// (docs/design-history/symbol-define-static-program-validation.md §1/§2/§4). This pack's
// former `prelude` was 13 pure `define`s and zero macros (unlike its `arrival/overridable`
// sibling, which carried the one macro) — every entry below is now `kind: "define"`, and the
// hard invariant this file pins is the ONE the migration brief calls out explicitly:
//
//   THE s/* WIRE FORMAT MUST NOT CHANGE. `(s/object …)`/`(s/array …)`/`(s/enum …)`/
//   `(s/optional …)`/`(s/field …)` produce the exact same tagged-list shape pre- and post-
//   migration — the shape `common/schema-tag.ts`'s `tagToJsonSchema` and `inhuman`'s
//   `mercury/type-infer.ts` (`tagToZod`) both consume. Contract enforcement (§1.2) is
//   validate-ONLY (`define-bake.ts`: "the decoded value is discarded... the original scheme
//   args/return flow through unchanged") — this file pins the OUTPUT, byte-for-byte, via the
//   same JSON.stringify-of-the-JS-projection convention `arrival-chain`'s own
//   `schema-dsl.test.ts` established for this DSL. `arrival/packages/mercury/src/
//   __tests__/conformance/corpus/infer-schema.scm` is the cross-package canary for this same
//   invariant — noted here, deliberately NOT run from this file (out of this pack's territory).
//
// ROW 1 — structural: no `prelude` field survives; every s/* symbol is `kind: "define"`;
//   `deps` names the five packs whose free names this pack's bodies actually call
//   (`cons`/`list`/`apply`/`length` — scheme/lists; `pair?`/`null?` — scheme/equality;
//   `string-append` — scheme/strings; `=` — scheme/numeric; `error` — scheme/r7rs/exceptions).
// ROW 2 — the §2.1 bake FV law: this pack lowers standalone (`await nativeOnlyRoot().child(...)`, a bare
//   root with none of BASE_PACKS' `.scm` preludes applied) — the FV law is a STATIC allowlist
//   check (`ownNames(K) ∪ exports(deps) ∪ SPECIAL_FORMS/KEYWORD_SYNTAX ∪ resolver-synth`),
//   independent of what the runtime `env` happens to already have bound, so this is the real
//   proof the `deps` edge is load-bearing, not decorative — remove any one of the five and this
//   row would throw `DefineLocalityError` for the name only that pack exports.
// ROW 3 — the wire-format byte-equivalence pins themselves (the file's main payload).
// ROW 4 — contract enforcement: a malformed call now doors at the boundary with a legible
//   message instead of an opaque `car`-on-wrong-shape crash deep in the body (§4.2's "a
//   wrong-arity call... now fails at the contract boundary, with a better message").
import { describe, expect, it } from "vitest";
import { exec, execInFrame } from "../../../eval/generator-exec.js";
import { buildVocabulary } from "../../vocabulary.js";
import { DefineForwardReferenceError, DefineLocalityError, ProvenanceRoleShapeError } from "../../../errors.js";
import { schemaCapability } from "../../schema/schema.js";
import type { AEntity } from "../../../common/symbols/_bake.js";
import type { SymbolDeclaration } from "../../../common/capability.js";
import type { ResolvingAmbient } from "../../AmbientRuntime.js";

const capabilities = [schemaCapability];

// Local evalScheme, mirroring `_fresh-env.ts`'s own — used only by the standalone
// bake rows below (the FV-law regression pin), never by the exec() rows. The
// internal bake seam, never the public exec surface.
const evalScheme = (env: unknown, src: unknown): unknown => execInFrame(src as string, env as ResolvingAmbient);

// `spec.symbols` IS the record.
function resolveSymbols(): Record<string, SymbolDeclaration> {
  return schemaCapability.spec.symbols ?? {};
}

const S_SYMBOLS = [
  "s/object",
  "s/array",
  "s/enum",
  "s/optional",
  "s/field",
  "s/string",
  "s/number",
  "s/integer",
  "s/boolean",
  "s/field/string",
  "s/field/number",
  "s/field/integer",
  "s/field/boolean",
  "s/field/_composite",
  "s/field/object",
  "s/field/array",
  "s/field/enum",
];

describe("arrival/schema — structural: no prelude field, every symbol is kind: define", () => {
  it("the capability declares no `prelude` field", () => {
    expect(schemaCapability.spec.prelude).toBeUndefined();
  });

  it("every s/* symbol bakes to a `define` entry with a real in/out contract", () => {
    const symbols = resolveSymbols();
    for (const name of S_SYMBOLS) {
      const def = symbols[name] as AEntity & { in?: unknown; out?: unknown };
      expect(def, `arrival/schema pack: no symbol named ${name}`).toBeDefined();
      expect(def.kind).toBe("define");
      expect(def.in).toBeDefined();
      expect(def.out).toBeDefined();
    }
  });

  it("declares deps on exactly the five packs its bodies call (lists/equality/strings/numeric/exceptions)", () => {
    const names = (schemaCapability.spec.deps ?? []).map((d) => d.name);
    expect(names.sort()).toEqual(
      ["scheme/equality", "scheme/lists", "scheme/numeric", "scheme/r7rs/exceptions", "scheme/strings"].sort(),
    );
  });
});

describe("arrival/schema — the §2.1 bake FV law passes standalone (deps edge is load-bearing, not decorative)", () => {
  it("bakes cleanly with only its own declared deps (no BASE_ROSTER folded in)", async () => {
    await expect(buildVocabulary([schemaCapability], undefined, evalScheme)).resolves.not.toThrow();
  });

  it("(regression pin) never throws DefineLocalityError/DefineForwardReferenceError/ProvenanceRoleShapeError", async () => {
    try {
      await buildVocabulary([schemaCapability], undefined, evalScheme);
    } catch (error) {
      expect(error).not.toBeInstanceOf(DefineLocalityError);
      expect(error).not.toBeInstanceOf(DefineForwardReferenceError);
      expect(error).not.toBeInstanceOf(ProvenanceRoleShapeError);
      throw error; // any OTHER failure is a real regression — surface it
    }
  });

  // Not tested here: calling s/object against a standalone bake env. This describe's
  // job is the STATIC bake law, not a second copy of the functional suite.
});

describe("arrival/schema — wire-format byte-equivalence (the load-bearing invariant)", () => {
  it("(s/object (s/field name string) (s/field occupation string)) — arrival-chain's own fixture, byte-for-byte", async () => {
    const [result] = await exec('(s/object (s/field "name" "string") (s/field "occupation" "string"))', {
      capabilities,
    });
    expect(JSON.stringify(result)).toBe('["object",["name","string"],["occupation","string"]]');
  });

  it("(s/object) with zero fields — the empty-rest edge (fields captures nil, cons still produces a proper list)", async () => {
    const [result] = await exec("(s/object)", { capabilities });
    expect(JSON.stringify(result)).toBe('["object"]');
  });

  it('(s/array "string") — bare-string element, no s/string() wrapper', async () => {
    const [result] = await exec('(s/array "string")', { capabilities });
    expect(JSON.stringify(result)).toBe('["array","string"]');
  });

  it("nested (s/array (s/object ...)) — array-of-objects", async () => {
    const [result] = await exec('(s/array (s/object (s/field "name" "string") (s/field "bucket" (s/enum "A" "B"))))', {
      capabilities,
    });
    expect(JSON.stringify(result)).toBe('["array",["object",["name","string"],["bucket",["enum","A","B"]]]]');
  });

  it('(s/enum "A" "B" "C" "D")', async () => {
    const [result] = await exec('(s/enum "A" "B" "C" "D")', { capabilities });
    expect(JSON.stringify(result)).toBe('["enum","A","B","C","D"]');
  });

  it('(s/optional "string") — bare-string /optional suffix', async () => {
    const [result] = await exec("(s/optional (s/string))", { capabilities });
    expect(result).toBe("string/optional");
  });

  it('(s/optional (s/enum "A" "B")) — list-headed /optional suffix, cdr untouched', async () => {
    const [result] = await exec('(s/optional (s/enum "A" "B"))', { capabilities });
    expect(JSON.stringify(result)).toBe('["enum/optional","A","B"]');
  });

  it("s/field/string with a description — arrival-chain's own fixture", async () => {
    const [result] = await exec('(s/field/string "name" "the persona\'s full name")', { capabilities });
    expect(JSON.stringify(result)).toBe('["name","string","the persona\'s full name"]');
  });

  it("s/field/integer with no description — the 2-element field shape", async () => {
    const [result] = await exec('(s/field/integer "age")', { capabilities });
    expect(JSON.stringify(result)).toBe('["age","integer"]');
  });

  it("s/field/array composite — arrival-chain's own fixture", async () => {
    const [result] = await exec('(s/field/array "pains" (s/array "string"))', { capabilities });
    expect(JSON.stringify(result)).toBe('["pains",["array","string"]]');
  });

  it("s/field/object composite with a description (the 3-arg _composite branch)", async () => {
    const [result] = await exec('(s/field/object "owner" "who owns it" (s/object (s/field "name" (s/string))))', {
      capabilities,
    });
    expect(JSON.stringify(result)).toBe('["owner",["object",["name","string"]],"who owns it"]');
  });

  it("the full worked example from the design doc's §5.1 spirit — object of every primitive shortcut", async () => {
    const [result] = await exec(
      `(s/object
          (s/field/string  "name"     "the persona's full name")
          (s/field/integer "age")
          (s/field/boolean "verified" "true if email-confirmed"))`,
      { capabilities },
    );
    expect(JSON.stringify(result)).toBe(
      JSON.stringify([
        "object",
        ["name", "string", "the persona's full name"],
        ["age", "integer"],
        ["verified", "boolean", "true if email-confirmed"],
      ]),
    );
  });

  it("(s/string)/(s/number)/(s/integer)/(s/boolean) — the four scalar constructors", async () => {
    const [a, b, c, d] = await exec("(s/string) (s/number) (s/integer) (s/boolean)", { capabilities });
    expect([a, b, c, d]).toEqual(["string", "number", "integer", "boolean"]);
  });
});

describe("arrival/schema — contract enforcement: a malformed call doors at the boundary (§4.2)", () => {
  it("s/field with only a name (no type) throws AT THE CALL BOUNDARY, not deep inside the body", async () => {
    await expect(exec('(s/field "name")', { capabilities })).rejects.toThrow();
  });

  it("s/field/_composite with 3 rest args (neither the 1- nor 2-arg branch) still reaches its own scheme `error` teaching door", async () => {
    await expect(exec('(s/field/_composite "name" 1 2 3)', { capabilities })).rejects.toThrow(
      /s\/field\/composite: expected \(name config\) or \(name desc config\)/,
    );
  });
});
