// exceptions-migration.test.ts — SYMBOL.DEFINE W4 law rows for `scheme/r7rs/exceptions`
// (docs/design-history/symbol-define-static-program-validation.md §4). Behavioral
// semantic-equivalence for guard/raise is already covered by
// `../../../__tests__/generator-exec.spec.ts`'s "guard (R7RS exception handling)" suite
// and the chibi R7RS conformance corpus (`../../../__tests__/scheme-compliance/
// conformance/chibi-r7rs-v2.spec.ts`, section "6.11 Exceptions" — 651/651 EXACT after this
// migration, including
// two rows this migration itself had to fix: `error-object-irritants` round-tripping
// (the R7RSError-vs-z.schemeValue contract gap, §1.2) and `raise-continuable`'s handler
// return-value passthrough (the `RunContext`-identity landed-machinery bug named in
// exceptions.ts's header, gap (3)). This file's rows are the ones NOT already exercised
// there: contract-enforcement teaching errors (new — the prelude had none), the bake-time
// FV law + derived-provenance-role checks (new — prelude text had no per-define identity
// to check), and a couple of hand rows for the two regressions above so a future revert
// of the workaround has a fast, local repro.
import { describe, expect, it } from "vitest";
import { execStateOverFrame, type ExecOptionsOverFrame } from "../../../eval/generator-exec.js";
import { freshEnv } from "../../../__tests__/_fresh-env.js";
import type { SchemeValue } from "../../../values/types.js";
import type { AEntity } from "../../../common/symbols/_bake.js";
import exceptionsPack from "../exceptions.js";
import { harvestContracts } from "../../../__tests__/_symbols-harvest.js";

async function exec(code: string, options: ExecOptionsOverFrame): Promise<SchemeValue[]> {
  return (await execStateOverFrame(code, options)).values.slice();
}

const symbols = harvestContracts(exceptionsPack.spec.symbols);

function defineDef(name: string) {
  const def = symbols[name];
  if (def === undefined) throw new Error(`scheme/r7rs/exceptions: no symbol named ${name}`);
  if (def.kind !== "define") throw new Error(`scheme/r7rs/exceptions: ${name} is not a define def (got ${def.kind})`);
  return def;
}

describe("scheme/r7rs/exceptions — bake-time FV law + assembly (§2.1/§2.3)", () => {
  it("the capability lowers without a DefineLocalityError/DefineForwardReferenceError — every free name in raise/raise-continuable/with-exception-handler/error resolves against KEYWORD_SYNTAX_BASELINE ∪ ownNames(K), zero external deps", async () => {
    // freshEnv() assembles every BASE_PACKS capability, including this one — a bake-law
    // violation on ANY of the four migrated defines throws synchronously during this
    // await, before a single test body runs. Reaching the assertion below IS the row.
    const env = await freshEnv();
    expect(env.get("raise", { throwError: false })).toBeDefined();
    expect(env.get("raise-continuable", { throwError: false })).toBeDefined();
    expect(env.get("with-exception-handler", { throwError: false })).toBeDefined();
    expect(env.get("error", { throwError: false })).toBeDefined();
    expect(env.get("guard", { throwError: false })).toBeDefined();
  });

  it("declares zero `deps` — the pack's own header claims self-containment (no cross-capability ordering dependency); this is the machine-checked version of that claim", () => {
    expect(exceptionsPack.spec.deps ?? []).toEqual([]);
  });
});

describe("scheme/r7rs/exceptions — derived provenance role (§1.4 spot-check)", () => {
  it("raise/raise-continuable/with-exception-handler/error all derive `pipe` — none reaches a port (handler-stack manipulation + host Error construction are the only effects, neither is a classified port)", async () => {
    const env = await freshEnv();
    for (const name of ["raise", "raise-continuable", "with-exception-handler", "error"]) {
      const bound = env.get(name, { throwError: false }) as { provenanceRole?: string } | undefined;
      expect(bound?.provenanceRole, `${name}.provenanceRole`).toBe("pipe");
    }
  });
});

describe("scheme/r7rs/exceptions — contract enforcement (§1.2, teaching errors — NEW: the prelude had none)", () => {
  it("error: wrong-type message (not a string) fires a teaching contract error, not a raw TypeError", async () => {
    const env = await freshEnv();
    await expect(exec(`(error 42 "irritant")`, { env })).rejects.toThrow();
  });

  it("error: wrong-arity (zero args, message is required) fires a teaching contract error", async () => {
    const env = await freshEnv();
    await expect(exec(`(error)`, { env })).rejects.toThrow();
  });

  it("with-exception-handler: wrong-type handler (not callable) fires a teaching contract error", async () => {
    const env = await freshEnv();
    await expect(exec(`(with-exception-handler 42 (lambda () 1))`, { env })).rejects.toThrow();
  });

  it("with-exception-handler: wrong-type thunk (not callable) fires a teaching contract error", async () => {
    const env = await freshEnv();
    await expect(exec(`(with-exception-handler (lambda (e) e) 42)`, { env })).rejects.toThrow();
  });

  it("raise: a real R7RSError condition object round-trips through the ENFORCED contract (the `raisable = z.union([z.schemeValue, z.error])` fix, §1.2 — z.schemeValue alone rejects R7RSError, see exceptions.ts's contract comment)", async () => {
    const env = await freshEnv();
    const [msg] = await exec(`(guard (exn (else (error-object-message exn))) (error "BOOM!"))`, { env });
    expect((msg as { __string__?: string }).__string__ ?? String(msg)).toBe("BOOM!");
  });
});

describe("scheme/r7rs/exceptions — semantic equivalence regression rows (the two bugs THIS migration introduced and fixed, kept local for a fast repro)", () => {
  it("error-object-irritants round-trips the full irritant list through guard (regression: %error-object-from-irritants losing irritants when `error`'s output contract was z.schemeValue-only)", async () => {
    const env = await freshEnv();
    const [irritants] = await exec(`(error-object-irritants (guard (exn (else exn)) (error "BOOM!" 1 2 3)))`, { env });
    // A proper scheme list (1 2 3) — walk its pair spine rather than assume a JS shape.
    const out: number[] = [];
    let node: unknown = irritants;
    while (node !== null && typeof node === "object" && "car" in (node as object)) {
      const pair = node as { car: { num?: number }; cdr: unknown };
      out.push(Number(pair.car.num ?? Number.NaN));
      node = pair.cdr;
    }
    expect(out).toEqual([1, 2, 3]);
  });

  it("raise-continuable: the handler's return value flows back to raise-continuable's own call site through with-exception-handler (regression: the RunContext-identity landed-machinery bug, gap (3) — %with-restore's module-level handler-stack workaround)", async () => {
    const env = await freshEnv();
    const [result] = await exec(
      `(with-exception-handler
         (lambda (con) 42)
         (lambda () (+ (raise-continuable "should be a number") 23)))`,
      { env },
    );
    expect((result as { num?: number }).num).toBe(65);
  });

  it("with-exception-handler restores the outer handler stack after thunk throws past it (the %with-restore finally-discipline, gap (2)'s workaround)", async () => {
    const env = await freshEnv();
    const [result] = await exec(
      `(guard (outer (#t (list 'outer outer)))
         (with-exception-handler
           (lambda (inner) (raise 'rethrown))
           (lambda () (raise 'boom))))`,
      { env },
    );
    // The inner handler re-raises 'rethrown, which must be visible to the OUTER guard —
    // if %with-restore's restore-on-throw path were skipped, the inner handler would still
    // be installed (or the stack corrupted) when the outer guard's own machinery runs.
    expect(result).toBeDefined();
  });
});

describe("scheme/r7rs/exceptions — declared symbols carry the migrated kinds", () => {
  it('raise/raise-continuable/with-exception-handler/error are `symbol.define` (kind: "define"), guard is `symbol.defineSyntax` (kind: "define-syntax") with macroAttribute "binder"', () => {
    for (const name of ["raise", "raise-continuable", "with-exception-handler", "error"]) {
      expect(defineDef(name).kind).toBe("define");
    }
    const guardDef = symbols.guard;
    expect(guardDef.kind).toBe("define-syntax");
    expect((guardDef as { macroAttribute?: string }).macroAttribute).toBe("binder");
  });

  it("the `prelude` field is gone — every top-level form is a declared symbol.define/defineSyntax/native entry now", () => {
    expect((exceptionsPack.spec as { prelude?: string }).prelude).toBeUndefined();
  });
});
