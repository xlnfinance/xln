// overridable-symbol-define.test.ts — W4-H2b pack migration rows for `arrival/overridable`
// (docs/design-history/symbol-define-static-program-validation.md §1/§2/§4). Companion to
// the pre-existing `overridable.test.ts`, which stays the behavioral baseline (define, override,
// default, structured s/* forms, teaching-door messages) — this file pins ONLY the migration-
// specific facts:
//
//   ROW 1 — structural: no `prelude` field survives; `define/overridable` is now a
//     `kind: "define-syntax"` entry, contract-free, `macroAttribute: "binder"`; the sibling
//     `overridable/resolve` rosetta entry is BYTE-UNTOUCHED (still `kind: "rosetta"`, still
//     carries its `in`/`out` contract) — the rosetta arm was never prelude text to begin with.
//   ROW 2 — the §2.1 bake FV law is categorically out of scope for this pack's ONE
//     `defineSyntax` entry (`define-bake.ts` limits that check to `def.kind === "define"`,
//     same fact srfi-8/26 and H1's binder/opaque siblings pin) — lowering standalone, with the
//     existing `deps: [schemaCapability]` unchanged, never throws a bake/role door. Regression
//     pin, not a new capability.
//   ROW 3 — end-to-end through the ONE consumer door (`exec(src, { capabilities, config })`):
//     define/override/resolve still behaves identically post-migration — the baseline's own
//     coverage, re-run here as the migration's own gate rather than duplicated in full.
//   ROW 4 — a teaching-door message survives the migration byte-for-byte (the macro's expansion
//     into `overridable/resolve` is unchanged, so the "expected X, got Y (from …)" shape must be
//     unchanged too).
//   ROW 5 — the §3.4 macro firewall: `name`'s FORMALS position (the reasoning pinned in
//     overridable.ts's own migration-note comment — `name` binds, it is never read back as a
//     value reference in the expansion, unlike `type`/`default` which ARE ordinary expression
//     space) never false-positives as `unbound-symbol` under `staticValidation: "on"` — the
//     exact false positive the doc's `receive`/`and-let*` worked cases motivate the ternary
//     over. A genuinely unbound name used as the `default` expression still reports (the
//     firewall covers the formal, not the whole call — today's honest, whole-call-firewalled
//     interim per §3.4's DEFERRED per-position walker note).
import { describe, expect, it } from "vitest";

import { exec, execState, type ExecOptions, execInFrame } from "../../../eval/generator-exec.js";
import { LexicalScope } from "../../../eval/LexicalScope.js";
import { AString } from "../../../values/primitives/AString.js";
import { buildVocabulary } from "../../vocabulary.js";
import { DefineForwardReferenceError, DefineLocalityError, ProvenanceRoleShapeError } from "../../../errors.js";
import { overridableCapability } from "../../overridable/overridable.js";
import type { AEntity, DefineSyntaxSymbolDef } from "../../../common/symbols/_bake.js";
import type { SymbolDeclaration } from "../../../common/capability.js";
import { contractOf } from "../../../common/capability-internals.js";
import type { ResolvingAmbient } from "../../AmbientRuntime.js";

const capabilities = [overridableCapability];

// Local evalScheme, mirroring `_fresh-env.ts`'s own — used only by the standalone
// bake rows below (the FV-law regression pin), never by the exec() rows. The
// internal bake seam, never the public exec surface.
const evalScheme = (env: unknown, src: unknown): unknown => execInFrame(src as string, env as ResolvingAmbient);

// `spec.symbols` IS the record (a define-form spec carries the eagerly-evaluated
// literal), so reading it needs no activation.
function resolveSymbols(): Record<string, SymbolDeclaration> {
  return overridableCapability.spec.symbols ?? {};
}

describe("arrival/overridable — structural: no prelude field, define-syntax kind, rosetta untouched", () => {
  it("`define/overridable` is a `define-syntax` entry — contract-free, macroAttribute binder", () => {
    const def = resolveSymbols()["define/overridable"] as DefineSyntaxSymbolDef;
    expect(def).toBeDefined();
    expect(def.kind).toBe("define-syntax");
    expect(def).not.toHaveProperty("in");
    expect(def).not.toHaveProperty("out");
    expect(def.macroAttribute).toBe("binder");
  });

  it("`overridable/resolve` stays a `rosetta` entry with its `in`/`out` contract intact (never migrated)", () => {
    // `overridable/resolve` mints an ARosettaProcedure directly — its contract
    // (still `kind: "rosetta"`, still carrying `in`/`out`) rides `.contract`.
    const def = contractOf(resolveSymbols()["overridable/resolve"]) as
      | (AEntity & { in?: unknown; out?: unknown })
      | undefined;
    expect(def).toBeDefined();
    expect(def!.kind).toBe("rosetta");
    expect(def!.in).toBeDefined();
    expect(def!.out).toBeDefined();
  });

  it("the capability declares no `prelude` field", () => {
    expect(overridableCapability.spec.prelude).toBeUndefined();
  });
});

describe("arrival/overridable — the §2.1 bake FV law is out of scope for defineSyntax (regression pin)", () => {
  it("bakes standalone (existing deps unchanged), never throws a bake FV/role door", async () => {
    await expect(buildVocabulary([overridableCapability], { params: {} }, evalScheme)).resolves.not.toThrow();
  });

  it("never throws DefineLocalityError/DefineForwardReferenceError/ProvenanceRoleShapeError", async () => {
    try {
      await buildVocabulary([overridableCapability], { params: {} }, evalScheme);
    } catch (error) {
      expect(error).not.toBeInstanceOf(DefineLocalityError);
      expect(error).not.toBeInstanceOf(DefineForwardReferenceError);
      expect(error).not.toBeInstanceOf(ProvenanceRoleShapeError);
      throw error; // any OTHER failure is a real regression — surface it
    }
  });
});

describe("arrival/overridable — end-to-end through the ONE consumer door, post-migration", () => {
  it("a host-supplied override still wins over the in-form default, and validates", async () => {
    const result = (
      await exec(`(define/overridable city (s/string) "Berlin") city`, {
        capabilities,
        config: { params: { city: "Paris" } },
      })
    ).at(-1);
    expect(result).toBe("Paris");
  });

  it("default fallback still fires (and validates) when no override is supplied", async () => {
    const result = (
      await exec(`(define/overridable city (s/string) "Berlin") city`, {
        capabilities,
        config: { params: {} },
      })
    ).at(-1);
    expect(result).toBe("Berlin");
  });

  it("`overridable/resolve` remains callable directly — the macro is pure ergonomics over it", async () => {
    const [result] = await exec(`(overridable/resolve 'city (s/string) "Berlin")`, {
      capabilities,
      config: { params: { city: "Paris" } },
    });
    expect(result).toBe("Paris");
  });
});

describe("arrival/overridable — a teaching-door message survives the migration byte-for-byte", () => {
  it("a bad OVERRIDE still names the binding, the declared type, and the source", async () => {
    await expect(
      exec(`(define/overridable age (s/number) 30) age`, {
        capabilities,
        config: { params: { age: "not-a-number" } },
      }),
    ).rejects.toThrow(/define\/overridable age: expected number, got "not-a-number" \(from an environment override\)/);
  });
});

describe("arrival/overridable — the §3.4 macro firewall: `name`'s formal position never false-positives", () => {
  // The vocabulary path's default scope is a FRESH, per-call root (`LexicalScope.fresh()`,
  // no cross-call leakage). Sweep 1 only recognizes literal `define`/`define-macro`/
  // `define-syntax` heads as program-level definitions — a `"binder"`-attributed macro
  // like `define/overridable` is not one of them, so a same-parse-pass reference to the
  // name it introduces does not resolve. Use `ExecOptions.scope`: define first (ordinary
  // run), then validate a later reference against the SAME scope, where `city` is an
  // already-bound scope name.
  it('`define/overridable`\'s binding NAME validates clean under staticValidation: "on" (the false positive the ternary closes)', async () => {
    const scope = LexicalScope.fresh();
    await exec(`(define/overridable city (s/string) "Berlin")`, { capabilities, config: { params: {} }, scope });
    const result = (await exec(`city`, { capabilities, config: { params: {} }, scope, staticValidation: "on" })).at(-1);
    expect(result).toBe("Berlin");
  });

  it('an override still resolves clean under staticValidation: "on"', async () => {
    const scope = LexicalScope.fresh();
    const config = { params: { city: "Paris" } };
    await exec(`(define/overridable city (s/string) "Berlin")`, { capabilities, config, scope });
    const result = (await exec(`city`, { capabilities, config, scope, staticValidation: "on" })).at(-1);
    expect(result).toBe("Paris");
  });

  it("a genuinely unbound name used elsewhere in the program still reports (the firewall covers the call, not the whole program)", async () => {
    await expect(
      exec(`(define/overridable city (s/string) "Berlin") (totally-unbound-name city)`, {
        capabilities,
        config: { params: {} },
        staticValidation: "on",
      }),
    ).rejects.toThrow(/unbound/i);
  });
});

// Sanity: the boxed-state door (`execState`) still round-trips through this pack post-migration —
// mirrors `overridable.test.ts`'s own access pattern (R1), one row, not the full suite.
describe("arrival/overridable — boxed-state access still round-trips (R1 sanity, not a re-test of the baseline)", () => {
  it("execState().values still carries the resolved AString post-migration", async () => {
    async function boxedExec(code: string, options?: ExecOptions) {
      return (await execState(code, options)).values.slice();
    }
    const result = await boxedExec(`(define/overridable city (s/string) "Berlin") city`, {
      capabilities,
      config: { params: { city: "Paris" } },
    });
    expect((result.at(-1) as AString)["arrival/toJS"]()).toBe("Paris");
  });
});
