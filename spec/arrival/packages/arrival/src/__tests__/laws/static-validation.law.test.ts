/**
 * static-validation.law.test.ts — THE STATIC VALIDATION PASS (docs/design-history/
 * symbol-define-static-program-validation.md §3). Pins the law rows the
 * spec names:
 *
 *  LAW 1 (FLAGSHIP, end-to-end): a program using `(require …)` under a doors-degraded,
 *    loader-less assembly yields ONE diagnostic — cause = the missing `fs` key, EVERY
 *    reference site listed (cascade fusion: one cure, N sites, never N diagnostics),
 *    the teaching text derived from the graph path (reference → door → owner →
 *    missing key), thrown at parse phase with ZERO side effects fired.
 *
 *  LAW 2 (suggestion soundness, §3.3a — the prior-art CHOSEN row): "did you mean X"
 *    only offers names that would themselves VALIDATE — a door is NEVER suggested,
 *    even when it is the closest miss.
 *
 *  LAW 3 (all-at-once, eslint discipline): a program with 3 distinct problems yields
 *    3 diagnostics in ONE pass — never crash-on-first.
 *
 *  LAW 4 (macro firewall, §3.4 — no false positives): binder-macro formals
 *    (`receive`, `let-values`, and `and-let*` — the W4-migrated `symbol.defineSyntax`
 *    pack, the FIRST production `macroAttribute: "binder"` declaration) and
 *    placeholder tokens (`cut`'s `<>`) do NOT report; the ternary is live — an
 *    `"expression"`-attributed macro's arguments DO walk.
 *
 *  LAW 5 (SPECIAL_FORMS no-FP, §2.1/§3.5): `while`/`try` programs are clean — the
 *    KEYWORD_SYNTAX baseline + the try/catch scope arm.
 *
 *  LAW 6 (internal defines, §3.5's body-sequence pre-pass): body-
 *    sequence letrec* scoping; `(define (a) (b)) (define (b) …)` sibling references
 *    are bound in both directions, at top level and inside bodies. No warning
 *    demotion is needed.
 *
 *  LAW 7 (error-tier soundness statement, §3.5 — pinned): the error tier is SOUND
 *    modulo the EXCLUDED reachability strictness — a dead-branch reference REPORTS by
 *    design (documented divergence, opt-out on the knob); glass (`{env}`) runs are
 *    never validated (no seal ⇒ no claims). The impure-resolver → `warning` degrade
 *    this law used to also pin is RETIRED (Stage-0 dead-code removal): the
 *    capability-facing `ResolverSpec`/`EnvCapability.resolvers` contract had zero live
 *    users, `CompiledResolutionChain` is now unconditionally the flat-map form, and
 *    `hasImpureResolver` is permanently `false` — unbound-symbol is ERROR, full stop.
 *
 *  LAW 8 (Stage 3 — the auto-derived config gate, `Contract.requiresConfig`): a
 *    `symbol.rosetta` verb declaring `requiresConfig` binds a cause-carrying door,
 *    UNCONDITIONALLY (no `degradation:"doors"` opt-in needed — this is a DIFFERENT
 *    mechanism from LAW 1's builder-form `.door(...)`, closing the gap where a bare-
 *    required config key used to throw a ZodError at `lower()`'s `schema.parse` before
 *    any program graph existed to statically explain WHY). Absent the declared key: the
 *    static pass reports `missing-configuration` naming the key and the verb, without
 *    executing anything, and a direct (unvalidated) call throws the door's teaching
 *    `PurityError`. Present: the verb binds real and runs, byte-identical to a plain
 *    contract with no `requiresConfig` at all.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as sz from "../../common/scheme-zod/index.js";
import { EnvCapability } from "../../common/capability.js";
import { exec, parse } from "../../eval/generator-exec.js";
import { CompiledResolutionChain } from "../../eval/CompiledResolutionChain.js";
import { DoorProcedure } from "../../values/primitives/ACallable.js";
import { AKernelKeyword } from "../../values/AKernelKeyword.js";
import { Macro } from "../../eval/Macro.js";
import { nil } from "../../values/primitives/ANil.js";
import { StaticValidationError, validateProgram } from "../../static-validation/validate-program.js";
import { vocabularyFromChain } from "../../static-validation/vocabulary.js";
import type { AmbientValue } from "../../env/AmbientRuntime.js";
import type { DoorSymbolDef } from "../../common/symbols/_bake.js";
import { PurityError } from "../../errors.js";

// ── Fixture helpers ────────────────────────────────────────────────────────────────

/** A one-flat-map sealed chain — the CompiledResolutionChain's own (now only) form,
 *  hand-built so a law row controls the vocabulary EXACTLY. */
const chainOf = (entries: Record<string, AmbientValue>) =>
  new CompiledResolutionChain(new Map<string | symbol, AmbientValue>(Object.entries(entries)));

const door = (name: string, reason: string, cause?: DoorSymbolDef["cause"]): DoorProcedure =>
  new DoorProcedure({ kind: "door", name, reason, ...(cause !== undefined ? { cause } : {}) });

/** A loader-shaped fixture (mirrors `arrival/loader`'s `fs` posture the way
 *  degradation.law.test.ts's fixture does — no cross-package dep on the real loader):
 *  both verbs declare `requiresConfig: ["fs"]`, so a satisfied `fs` binds the no-op natives
 *  and an absent `fs` auto-mints cause-carrying doors citing `fs` — the same auto-door path
 *  the real loader rides now that the builder-form arm (manual `degradation.door(...)`) is
 *  retired. */
// Widened to `EnvCapability<any, any>` — the same declared-type idiom
// degradation.law.test.ts uses: inference from a resource-less spec otherwise
// fails variance into ExecOptions.capabilities.
function loaderLike(name: string, onProbe: () => void): EnvCapability<any, any> {
  return EnvCapability.define(name, {
    configuration: {
      fs: z.custom<{ readFile: (p: string) => Promise<string> }>((v) => v !== null && typeof v === "object").optional(),
    },
    symbols: (symbol) => ({
      "probe!": symbol.native`probe!: JS-side effect counter`({ input: [], output: [sz.schemeValue] }, () => {
        onProbe();
        return nil;
      }),
      require: symbol.native`require: no-op (satisfied fixture)`(
        { input: [sz.schemeValue], output: [sz.schemeValue], requiresConfig: ["fs"] },
        () => nil,
      ),
      "require/extension": symbol.native`require/extension: no-op (satisfied fixture)`(
        { input: [sz.schemeValue], output: [sz.schemeValue], requiresConfig: ["fs"] },
        () => nil,
      ),
    }),
  });
}

// ============================================================================
// LAW 1 — the flagship, end-to-end through exec
// ============================================================================

describe("LAW 1 — flagship: (require …) under a doors-degraded loader-less assembly", () => {
  const program = ["(probe!)", '(require "a.scm")', '(require "b.scm")', '(require/extension ".toml")'].join("\n");

  it("throws ONE StaticValidationError at parse phase: one cure (fs), ALL sites, zero side effects", async () => {
    let hits = 0;
    const cap = loaderLike("test/sv-loader", () => hits++);
    let caught: unknown;
    try {
      await exec(program, { capabilities: [cap], config: {}, staticValidation: "on" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(StaticValidationError);
    const err = caught as StaticValidationError;

    // Cascade fusion: ONE missing grant (`fs`) explains all three references —
    // ONE diagnostic, THREE sites, program order. Never three diagnostics.
    expect(err.diagnostics).toHaveLength(1);
    const [d] = err.diagnostics;
    expect(d.code).toBe("missing-configuration");
    expect(d.severity).toBe("error");
    expect(d.sites.map((s) => s.symbol)).toEqual(["require", "require", "require/extension"]);

    // The causal chain, structured: door → owner → missing key (W0's DoorCause,
    // minted by W2's degradation).
    expect(d.cause).toEqual({ owner: "test/sv-loader", needs: [{ kind: "configuration", key: "fs" }] });

    // ZERO side effects fired — (probe!) on line 1 never ran (contrast the pre-W3
    // before: the program runs until the callback, side effects already out).
    expect(hits).toBe(0);
  });

  it("a SATISFIED config validates clean and evaluates (the positive control)", async () => {
    let hits = 0;
    const cap = loaderLike("test/sv-loader-satisfied", () => hits++);
    await exec(program, { capabilities: [cap], config: { fs: { readFile: async () => "" } }, staticValidation: "on" });
    expect(hits).toBe(1);
  });

  it("the teaching text is derived from the graph path — the §5.1 flagship message, pinned", async () => {
    // Direct-vocabulary variant with the spec's own hint, so the FULL §5.1 message
    // shape (key + hint + name @ capability + sites + cure) is pinned byte-exactly.
    const vocab = vocabularyFromChain(
      chainOf({
        "run-prompt": nil,
        require: door("require", "loads a file", {
          owner: "arrival/loader",
          needs: [{ kind: "configuration", key: "fs", hint: "a filesystem" }],
        }),
      }),
    );
    const forms = await parse('(run-prompt "summarize" (lambda () (require "file.scm")))');
    const diagnostics = validateProgram(forms, vocab);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toBe(
      "Configuration key `fs` (a filesystem) was not provided in the exec configuration. " +
        "It disables `require @ arrival/loader` (referenced at 1:35) — this program would crash there. " +
        "Provide `fs` to enable it.",
    );
  });
});

// ============================================================================
// LAW 2 — suggestion soundness (§3.3a): a door is NEVER offered as a typo fix
// ============================================================================

describe("LAW 2 — suggestions come from the SATISFIED vocabulary subset only", () => {
  it("suggests the value `map`, never the equally-close door `mapp`", async () => {
    const vocab = vocabularyFromChain(chainOf({ map: nil, mapp: door("mapp", "not implemented here") }));
    const [d] = validateProgram(await parse("(mapq 1)"), vocab);
    expect(d.code).toBe("unbound-symbol");
    expect(d.suggestions).toEqual(["map"]); // `mapp` is distance 1 too — excluded, door
  });

  it("offers NO suggestion when the only close miss is a door", async () => {
    const vocab = vocabularyFromChain(chainOf({ mapp: door("mapp", "not implemented here") }));
    const [d] = validateProgram(await parse("(napp 1)"), vocab);
    expect(d.code).toBe("unbound-symbol");
    expect(d.suggestions).toBeUndefined(); // silence beats a suggestion that re-errors
  });
});

// ============================================================================
// LAW 3 — all-at-once: the eslint discipline
// ============================================================================

describe("LAW 3 — a program with 3 distinct problems yields 3 diagnostics in ONE pass", () => {
  it("collects unbound + door + unbound, in program order", async () => {
    const vocab = vocabularyFromChain(
      chainOf({
        list: nil,
        require: door("require", "loads a file", {
          owner: "arrival/loader",
          needs: [{ kind: "configuration", key: "fs" }],
        }),
      }),
    );
    const forms = await parse(["(list undefined-a)", '(require "x")', "(undefined-b)"].join("\n"));
    const diagnostics = validateProgram(forms, vocab);
    expect(diagnostics.map((d) => d.code)).toEqual(["unbound-symbol", "missing-configuration", "unbound-symbol"]);
    expect(diagnostics.map((d) => d.sites[0].symbol)).toEqual(["undefined-a", "require", "undefined-b"]);
  });
});

// ============================================================================
// LAW 4 — the §3.4 macro firewall (no-FP) + the live ternary
// ============================================================================

describe("LAW 4 — macro firewall: binder formals and placeholder tokens never report", () => {
  // receive / let-values are purity doors (multi-return ban) — binder firewall for
  // those forms is retired with the live macros. and-let* remains the live binder pin.

  it('`and-let*` claw-bound variables (srfi-2, migrated `macroAttribute: "binder"`) do not report — and the program runs', async () => {
    const [result] = await exec("(and-let* ((x 5) (y (* x 2))) (+ x y))", { staticValidation: "on" });
    expect(result).toBe(15);
    // The bare-guard claw shape (a claw whose car is itself a pair, no binding) —
    // same firewall, no reference to `x`/`y` should ever surface as unbound.
    const [guarded] = await exec("(and-let* ((x 3) ((> x 0))) (* x 10))", { staticValidation: "on" });
    expect(guarded).toBe(30);
  });

  it("`cut`'s `<>` placeholder does not report (opaque interior)", async () => {
    await expect(exec("((cut cons <> 1) 0)", { staticValidation: "on" })).resolves.toBeDefined();
  });

  it('the ternary is LIVE: an `"expression"`-attributed defineSyntax macro\'s arguments DO walk', async () => {
    // Capabilities bake through exec's OWN injected evalScheme (`buildVocabulary`, via
    // `execState`'s private `capabilityEvalScheme`) — no fixture-side evalScheme needed, unlike
    // suites that build a `Vocabulary`/apply a capability directly.
    const cap = EnvCapability.define("test/sv-ternary", {
      symbols: (symbol) => ({
        "first-of": symbol.defineSyntax`first-of: expands to its first argument form`("(lambda (a b) a)", {
          macroAttribute: "expression",
        }),
        "first-of-opaque": symbol.defineSyntax`first-of-opaque: same expander, default attribute`("(lambda (a b) a)"),
      }),
    });

    // "expression": the unbound second argument REPORTS at parse phase.
    await expect(exec("(first-of 1 never-bound-arg)", { capabilities: [cap], staticValidation: "on" })).rejects.toThrow(
      StaticValidationError,
    );
    // "opaque" (the default): the same interior is firewalled — validates clean, runs.
    const [result] = await exec("(first-of-opaque 1 never-bound-arg)", { capabilities: [cap], staticValidation: "on" });
    expect(result).toBe(1);
  });
});

// ============================================================================
// LAW 5 — SPECIAL_FORMS / keyword-syntax no-FP
// ============================================================================

describe("LAW 5 — while/try programs validate clean (KEYWORD_SYNTAX baseline + try scope arm)", () => {
  it("`while` (an unmodeled-by-freeVars head) is keyword syntax, not an unbound symbol", async () => {
    await expect(exec("(while #f #f)", { staticValidation: "on" })).resolves.toBeDefined();
  });

  it("`try`/`catch` markers are structural; the catch VARIABLE binds for its handlers", async () => {
    const [result] = await exec("(try (+ 1 2) (catch (e) e))", { staticValidation: "on" });
    expect(result).toBe(3);
  });

  it("`define-macro` at program level: the name is swept, the body is expansion space, the use site is firewalled", async () => {
    const results = await exec("(define-macro (my-id x) x) (my-id 5)", { staticValidation: "on" });
    expect(results[results.length - 1]).toBe(5);
  });
});

// ============================================================================
// LAW 6 — internal-define letrec* scoping (§3.5's body-sequence pre-pass)
// ============================================================================

describe("LAW 6 — internal define sequences have letrec* name visibility", () => {
  it("a forward sibling reference inside a lambda body does not report — and runs", async () => {
    const results = await exec("(define (f) (define (a) (b)) (define (b) 1) (a)) (f)", { staticValidation: "on" });
    expect(results[results.length - 1]).toBe(1);
  });

  it("the same shape at TOP level (the macro-aware first sweep) is clean too", async () => {
    const results = await exec("(define (top-a) (top-b)) (define (top-b) 41) (top-a)", { staticValidation: "on" });
    expect(results[results.length - 1]).toBe(41);
  });
});

// ============================================================================
// LAW 7 — the error-tier soundness statement, pinned
// ============================================================================

describe("LAW 7 — error-tier soundness: strict on dead branches (by design), warning under impurity, silent on glass", () => {
  it("a dead-branch reference REPORTS — the documented reachability divergence (§6.6)", async () => {
    await expect(exec("(if #f (never-defined-fn-xyz) 42)", { staticValidation: "on" })).rejects.toThrow(
      StaticValidationError,
    );
  });

  it("the SAME program runs under the default (validation off) — the divergence is opt-in this wave", async () => {
    const [result] = await exec("(if #f (never-defined-fn-xyz) 42)");
    expect(result).toBe(42);
  });

  it("unbound-symbol is ERROR under the (now unconditionally flat) sealed chain", async () => {
    const pure = vocabularyFromChain(chainOf({}));
    expect(pure.hasImpureResolver).toBe(false); // retired mechanism — always false now
    const forms = await parse("(totally-unknown)");
    expect(validateProgram(forms, pure)[0].severity).toBe("error");
  });

  // STAGE C CUT 3b: the "GLASS runs are never validated" row is DROPPED — the public glass
  // option (`ExecOptions.env`) it pinned is retired entirely, not merely unvalidated; there is
  // no glass path left to make a "no seal, no claims" claim about.

  it("keyword entries and cxr synth names resolve statically (no FP on `caddr`)", async () => {
    const [result] = await exec("(caddr (list 1 2 3))", { staticValidation: "on" });
    expect(result).toBe(3);
  });

  it("a hand-built chain lacking core still gets the KEYWORD_SYNTAX baseline (a `while` head never reports)", async () => {
    const vocab = vocabularyFromChain(chainOf({}));
    const diagnostics = validateProgram(await parse("(while #f #f)"), vocab);
    expect(diagnostics).toEqual([]);
    // …and an AKernelKeyword VALUE classifies as keyword, not a plain value:
    const withKw = vocabularyFromChain(chainOf({ "my-form": new AKernelKeyword("my-form") }));
    expect(withKw.lookupStatic("my-form")).toEqual({ kind: "keyword" });
  });

  it("an unaudited Macro binding reads as opaque; a stamped attribute reads back (§3.4 channel)", () => {
    const plain = new Macro("plain", () => nil);
    const stamped = new Macro("stamped", () => nil);
    stamped.macroAttribute = "expression";
    const vocab = vocabularyFromChain(chainOf({ plain, stamped }));
    expect(vocab.lookupStatic("plain")).toEqual({ kind: "macro", macroAttribute: "opaque" });
    expect(vocab.lookupStatic("stamped")).toEqual({ kind: "macro", macroAttribute: "expression" });
  });
});

// ============================================================================
// LAW 8 — Stage 3: the auto-derived config door (`Contract.requiresConfig`)
// ============================================================================

/** A `symbol.rosetta` verb declaring `requiresConfig: ["fs"]` against an OPTIONAL `fs`
 *  configuration key — a literal (non-builder) `symbols` record, deliberately: the point
 *  of Stage 3 is that `capability.ts`'s bind loop reads `def.requiresConfig` off the
 *  ALREADY-BAKED def regardless of which authoring shape produced it, so no
 *  `({configuration, degradation}) => ({...})` builder / `degradation.door(...)` call is
 *  written by hand here at all — the door mints itself. */
function requiresConfigCapability(name: string, onRun: () => void): EnvCapability<any, any> {
  return EnvCapability.define(name, {
    configuration: {
      fs: z.custom<{ readFile: (p: string) => Promise<string> }>((v) => v !== null && typeof v === "object").optional(),
    },
    symbols: (symbol) => ({
      "fs/read": symbol.rosetta`fs/read: reads a path via the configured filesystem`(
        { input: [sz.string], output: [sz.string], requiresConfig: ["fs"] },
        async (path: string) => {
          onRun();
          return path.toUpperCase();
        },
      ),
    }),
  });
}

describe("LAW 8 — Stage 3: `requiresConfig` auto-mints a cause-carrying door, unconditionally", () => {
  const program = '(fs/read "hi")';

  it("WITHOUT fs: validateProgram reports missing-configuration naming `fs` + `fs/read`, zero side effects", async () => {
    let hits = 0;
    const cap = requiresConfigCapability("test/sv-requires-config", () => hits++);
    let caught: unknown;
    try {
      await exec(program, { capabilities: [cap], config: {}, staticValidation: "on" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(StaticValidationError);
    const err = caught as StaticValidationError;
    expect(err.diagnostics).toHaveLength(1);
    const [d] = err.diagnostics;
    expect(d.code).toBe("missing-configuration");
    expect(d.severity).toBe("error");
    expect(d.sites.map((s) => s.symbol)).toEqual(["fs/read"]);
    expect(d.cause).toEqual({ owner: "test/sv-requires-config", needs: [{ kind: "configuration", key: "fs" }] });
    expect(hits).toBe(0); // never executed — parse-phase throw, exactly like LAW 1
  });

  it("WITHOUT fs: no mode opt-in needed — this fires even though NO `degradation` mode was requested", async () => {
    // `degradation` defaults to "forbid" whenever unset — LAW 1/2's builder-form `.door(...)`
    // path stays silent under it (degradation.law.test.ts LAW 2). `requiresConfig` is a
    // DIFFERENT, unconditional mechanism: the door mints regardless.
    const cap = requiresConfigCapability("test/sv-requires-config-no-mode", () => {});
    await expect(exec(program, { capabilities: [cap], config: {}, staticValidation: "on" })).rejects.toThrow(
      StaticValidationError,
    );
  });

  it("WITHOUT fs: bypassing static validation, a direct call throws the door's teaching PurityError", async () => {
    const cap = requiresConfigCapability("test/sv-requires-config-direct", () => {});
    let caught: unknown;
    try {
      await exec(program, { capabilities: [cap], config: {} }); // staticValidation left off — reaches the door at runtime
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PurityError);
    const err = caught as PurityError;
    expect(err.message).toBe(
      "fs/read @ test/sv-requires-config-direct is not available.\n" +
        "  Why: requires configuration `fs` — provide it to enable this verb. " +
        "(reads a path via the configured filesystem)",
    );
    expect(err.owner).toBe("test/sv-requires-config-direct");
  });

  it("WITH fs: the verb binds real and runs — byte-identical to a plain contract with no requiresConfig", async () => {
    let hits = 0;
    const cap = requiresConfigCapability("test/sv-requires-config-satisfied", () => hits++);
    const results = await exec(program, {
      capabilities: [cap],
      config: { fs: { readFile: async () => "" } },
      staticValidation: "on",
    });
    expect(results[results.length - 1]).toBe("HI");
    expect(hits).toBe(1);
  });
});
