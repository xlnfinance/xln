/**
 * LAW (V0→V5) — the environment-privatization design.
 * Pinned surface, updated at the V5 atomic cut (D5 hard delete executed); re-pinned at
 * STAGE C CUT 3b (docs/plans/stage-c-corpse-deletion.md, "the massacre"), which retired the
 * PUBLIC glass option (`ExecOptions.env`) and the `override` sugar ENTIRELY; re-pinned AGAIN
 * at the STAGE C EXPORT RESTRUCTURE (same doc, §"Export restructure" — V's minimal-surface
 * ruling), which is the SANCTIONED place this restructure records itself: the pin below IS the
 * root barrel's contract documentation now, not just a regression check.
 *
 *   1. Barrel surface pin — `global_env`/`env` are GONE (V1's zero-consumer cut);
 *      `sandboxedEnv` is GONE (V5's atomic cut). `LexicalScope.fresh` exists (V1's one new
 *      API); `SessionScope` names the refinement it mints (root frame carries the structural
 *      SchemeEnv contract — the V4 session products type against it). The barrel exports ZERO
 *      AmbientRuntime instances. `rosettaTypesOf` DOES NOT survive the export restructure —
 *      unlike the V1-era cuts above (a zero-consumer removal), this one is a DELIBERATE
 *      relocation: it moved to `/lsp-internals` (a sibling-contract subpath, not this tier) as
 *      part of shrinking the root barrel to the three-concern surface (eval + capability
 *      authoring + provenance-as-data) V's minimal-surface ruling calls for. Root is the
 *      enumerated set in the full-set pin below (that list IS the contract).
 *   2. Glass byte-identity — DROPPED (Cut 3b): `ExecOptions.env` no longer exists at all, so
 *      there is nothing left to pin byte-identity against. The internal live-frame seam
 *      (`execStateOverFrame`/`execOverFrame`, generator-exec.ts) is the narrow, non-public
 *      replacement the internal `inference-env.ts` test harnesses use; it is not part of the
 *      environment-privatization census this file pins.
 *   3. write-into-scope + override VALUE-INJECTION parity — the census's original claim
 *      (§II.1's table: `env.set(name, jsToScheme(ctx, dataValue))` → `override`) is re-pinned
 *      against the surviving mechanisms: a direct `env.bind` onto a `LexicalScope.fresh()`
 *      root (the privileged write on the concrete internals class) vs `define/overridable` +
 *      a plain `{ capabilities: [overridableCapability], config: { params } }` run (the
 *      `override` sugar's own underlying capability, still fully present — only the
 *      `ExecOptions.override` CONVENIENCE wrapper died). Both paths must produce identical
 *      values AND identical provenance (both fold through `jsToScheme(CONSTANT_CTX, …)` —
 *      `overridable/resolve`'s own implementation, env/overridable/overridable.ts — so a
 *      divergence here would mean the two "run-neutral value" doors disagree).
 */
import { describe, expect, it } from "vitest";
import * as arrival from "../../index.js";
import { exec, execState } from "../../eval/generator-exec.js";
import { LexicalScope, type LexicalScopeWithInternals, type SessionScope } from "../../eval/LexicalScope.js";
import { inferenceEnv as sandboxedEnv } from "../../env/inference-env.js";
import { jsToScheme } from "../../membrane/rosetta.js";
import { CONSTANT_CTX } from "../../run/RunContext.js";
import { AValue } from "../../values/primitives/AValue.js";
import { overridableCapability } from "../../env/overridable/overridable.js";
// In-package test: internal-module access (AmbientRuntime is not barrel-exported).
import { AmbientRuntime } from "../../env/AmbientRuntime.js";

describe("V0 pin — barrel surface", () => {
  it("global_env / env are no longer barrel-exported (V1 zero-consumer cut)", () => {
    const names = Object.keys(arrival);
    expect(names).not.toContain("global_env");
    expect(names).not.toContain("env");
  });

  it("sandboxedEnv is no longer barrel-exported (V5 atomic cut, D5 hard delete)", () => {
    expect(Object.keys(arrival)).not.toContain("sandboxedEnv");
  });

  it("rosettaTypesOf is OFF the root barrel (export restructure — relocated to /lsp-internals, not a zero-consumer cut)", () => {
    expect(Object.keys(arrival)).not.toContain("rosettaTypesOf");
  });

  it("LexicalScope.fresh exists (V1's one new public API, D6) and mints a SchemeEnv-contract root frame (V4)", () => {
    expect(typeof arrival.LexicalScope.fresh).toBe("function");
    const scope = arrival.LexicalScope.fresh("pin-fresh");
    // The V4 refinement: the fresh root frame carries the structural pack-write contract
    // (registerResolver is the discriminating member — a plain lexical frame lacks it).
    expect(typeof (scope.env as { registerResolver?: unknown }).registerResolver).toBe("function");
  });

  it("the root barrel is EXACTLY the minimal runtime surface (export restructure pin — this enumeration IS the contract; update deliberately, on purpose, never by accident)", () => {
    // Three concerns only: EVAL, CAPABILITY AUTHORING, PROVENANCE AS DATA — plus the
    // error root and the structural types/helpers a capability author's signatures name.
    // Type-only exports erase at emit and never appear in `Object.keys`.
    // Symbol keep-set on root (post-./symbol retirement): CallCtx helpers + withContractFields.
    const names = Object.keys(arrival).sort();
    expect(names).toEqual(
      [
        "ANil",
        "ArrivalError",
        "EMPTY_PROVENANCE",
        "EnvCapability",
        "LexicalScope",
        "RunContext",
        "deepProvenance",
        "disposeRunContext",
        "exec",
        "execExpr",
        "execState",
        // Host run-error rendering (scheme stack + require chain) — errors.ts.
        "formatRunError",
        // Membrane: public outbound exit + double-wrap predicate (see index.ts).
        "isSchemeValue",
        "jsToScheme",
        "makeCallCtx",
        "parse",
        "symbol",
        "testCallCtx",
        "toJS",
        "withContractFields",
        "z",
      ].sort(),
    );
  });
});

describe("write-into-scope + override VALUE-INJECTION parity", () => {
  it("the internal write (env.bind + jsToScheme) and define/overridable + a capability config produce IDENTICAL values", async () => {
    const users = [
      { id: "alice", priority: 15 },
      { id: "bob", priority: 5 },
    ];

    // The manual membrane path — reachable only through `AmbientRuntime.bind` (V7:
    // the public `env.set` is hard-deleted) onto a plain `LexicalScope.fresh()` root — no glass
    // needed at all, since `.bind` writes onto ANY concrete frame the vocabulary path's
    // `scope` option accepts.
    const manualScope = LexicalScope.fresh("parity-manual") as LexicalScopeWithInternals<SessionScope>;
    manualScope.env.bind("users", jsToScheme(CONSTANT_CTX, users, {}));
    const { values: manualValues } = await execState(`(map (lambda (u) (:id u)) users)`, { scope: manualScope });

    // The declared-parameter path — `define/overridable` + the overridable capability's OWN
    // config bag (the `ExecOptions.override` sugar's underlying mechanism, unaffected by that
    // sugar's retirement).
    const { values: declaredValues } = await execState(
      `(define/overridable users (s/array (s/object (s/field/string "id") (s/field/number "priority"))) '())
       (map (lambda (u) (:id u)) users)`,
      { capabilities: [overridableCapability], config: { params: { users } } },
    );
    const declaredResult = declaredValues.at(-1);
    const manualResult = manualValues.at(-1);
    expect(declaredResult).toBeDefined();
    expect(manualResult).toBeDefined();

    // Same shape, same order — the map result over the same source list.
    expect(JSON.stringify(declaredResult)).toBe(JSON.stringify(manualResult));
  });

  it("...and IDENTICAL provenance — both paths mint through jsToScheme(CONSTANT_CTX, …), so both are provenance-empty (run-neutral)", async () => {
    const priority = 15;

    const manualScope = LexicalScope.fresh("parity-provenance-manual") as LexicalScopeWithInternals<SessionScope>;
    manualScope.env.bind("priority", jsToScheme(CONSTANT_CTX, priority, {}));
    const { values: manualValues } = await execState(`(* priority 2)`, { scope: manualScope });

    const { values: declaredValues } = await execState(
      `(define/overridable priority (s/number) 0)
       (* priority 2)`,
      { capabilities: [overridableCapability], config: { params: { priority } } },
    );

    const manualResult = manualValues.at(-1);
    const declaredResult = declaredValues.at(-1);
    expect(manualResult).toBeInstanceOf(AValue);
    expect(declaredResult).toBeInstanceOf(AValue);
    expect([...(declaredResult as AValue).provenance].sort()).toEqual([...(manualResult as AValue).provenance].sort());
    // Both empty — neither path mints a fresh point (CONSTANT_CTX, both sides).
    expect((manualResult as AValue).provenance.size).toBe(0);
  });
});

describe("V6 pin — no public host-fn registration method on AmbientRuntime / SchemeEnv", () => {
  // Public defineRosetta is gone on the class and the SchemeEnv contract (compile error
  // everywhere). Playback-frame registration binds an ARosettaProcedure through
  // `env.bind` — never a public defineRosetta / barrel export.
  it("AmbientRuntime.prototype.defineRosetta no longer exists", () => {
    expect("defineRosetta" in AmbientRuntime.prototype).toBe(false);
  });

  it("a live env instance answers to `get` but not `defineRosetta` (nor `set`/`inherit`/`merge` — the V7/V8 rows)", () => {
    const env = sandboxedEnv.child("pin-host-fn-reg-gone");
    expect(typeof env.get).toBe("function");
    expect("defineRosetta" in env).toBe(false);
  });
});

describe("V7 pin — the MONADIC contract (hermetic-Environment ruling, 2026-07-11)", () => {
  // V, verbatim: "AmbientRuntime should be something fully opaque on the outside, its value is
  // only in cross-run preservation; it is not designed to be operatable from the JS side at
  // all. from JS perspective, it's fully monadic." Values enter the interpreter ONLY as
  // capabilities or overrides. Concretely pinned:
  //   1. the JS side cannot `set` — the method is gone from the concrete class (so no
  //      instance, however obtained — `LexicalScope.fresh().env`, minted children,
  //      the run resolver's env frame — answers it) and from the `SchemeEnv` contract;
  //   2. a raw JS scalar found IN storage is a teaching door on read, never a silent
  //      re-box (the read-path `box()` fallback is deleted — the constant-ctx audit's
  //      #1 provenance drop);
  //   3. a resolver answering a raw JS scalar doors at the probe — resolvers box at
  //      their own boundary, under the resolving read's ctx.
  it("no env instance answers `set` — not a fresh session root, not a base child", () => {
    expect("set" in sandboxedEnv.child("pin-monadic")).toBe(false);
    expect("set" in LexicalScope.fresh("pin-monadic-fresh").env).toBe(false);
    expect("set" in AmbientRuntime.prototype).toBe(false);
  });

  it("raw JS in storage doors on read (a writer bypassed the membrane) — box() re-boxing is dead", () => {
    const env = sandboxedEnv.child("pin-raw-storage");
    // The only way raw JS can still land in storage is a direct record poke — the exact
    // bypass the door exists to catch.
    env.__env__["smuggled"] = 42 as never;
    expect(() => env.get("smuggled")).toThrowError(/bypassed the storage membrane/);
  });

  it("a resolver answering a raw JS scalar doors at the probe (box at the resolver's own boundary)", async () => {
    const root = LexicalScope.fresh("pin-resolver-door");
    root.env.registerResolver({ id: "raw-answerer", resolve: (n) => (n === "leaky" ? ("raw" as never) : undefined) });
    expect(() => root.env.get("leaky")).toThrowError(/resolver "raw-answerer"/);
    // And through a real run's composed resolution (the evaluator path, ctx threaded).
    await expect(exec("leaky", { scope: root })).rejects.toThrowError(/resolver "raw-answerer"/);
  });

  it("a resolver answering a BOXED value flows through, ctx-threaded read included", async () => {
    const root = LexicalScope.fresh("pin-resolver-boxed");
    root.env.registerResolver({
      id: "boxed-answerer",
      resolve: (n, ctx) => (n === "greeting" ? jsToScheme(ctx ?? CONSTANT_CTX, "hello", {}) : undefined),
    });
    const [v] = await exec('(string-append greeting "!")', { scope: root });
    expect(v).toBe("hello!");
  });
});

describe("V8 pin — MONADIC BIRTH (public inheritance dissolved, 2026-07-11)", () => {
  // The ruling's second half: an env can only be BORN (assembled) and READ — never
  // EXTENDED from JS. Doctrine: every production inherit was capability composition in
  // disguise. Concretely pinned:
  //   1. `inherit` and `merge` are gone from the concrete class (no instance answers
  //      them) — frame birth is `AmbientRuntime.child` / `.root` (and the
  //      `ResolvingAmbient` overrides), reached only by holding the concrete internals
  //      class: assembly machinery, the evaluator, and the replay ingress;
  //   2. no bindings-record ingestion from JS — the constructor arm left the public
  //      type (protected ctor), and the one public frame-birth door,
  //      `LexicalScope.child`, takes NO bindings record;
  //   3. `LexicalScope.define` / `Resolver.define` are gone (ruling A on the
  //      session-owner question — no convenience carve-out): the evaluator's
  //      frame-binds go through `env.bind` directly.
  it("no env instance answers `inherit` or `merge` — not a session root, not a base child", () => {
    const child = sandboxedEnv.child("pin-birth");
    expect("inherit" in child).toBe(false);
    expect("merge" in child).toBe(false);
    expect("inherit" in AmbientRuntime.prototype).toBe(false);
    expect("merge" in AmbientRuntime.prototype).toBe(false);
    expect("inherit" in LexicalScope.fresh("pin-birth-fresh").env).toBe(false);
  });

  it("LexicalScope no longer answers `define` (ruling A — no convenience carve-out)", () => {
    expect("define" in LexicalScope.fresh("pin-no-define")).toBe(false);
    expect("define" in LexicalScope.prototype).toBe(false);
  });

  it("LexicalScope.child is the one public frame-birth door — empty child, subtype-preserving (SchemeEnv contract kept)", async () => {
    const session = LexicalScope.fresh("pin-child-session");
    const run = session.child("pin-child-run");
    // Born EMPTY: no bindings-record parameter exists; the child frame owns nothing yet.
    expect(run.env.list()).toEqual([]);
    // Subtype-preserving: a SessionScope's child keeps the structural pack-write contract
    // (the per-run capability re-lower consumer, inhuman run-traced, targets child.env).
    expect(typeof (run.env as { registerResolver?: unknown }).registerResolver).toBe("function");
    // And it chains: a define landing in the SESSION frame resolves from the child scope.
    await exec("(define session-bound 41)", { scope: session });
    const [v] = await exec("(+ session-bound 1)", { scope: run });
    expect(v).toBe(42);
  });
});
