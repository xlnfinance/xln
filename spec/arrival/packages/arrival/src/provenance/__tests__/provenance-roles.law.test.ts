/**
 * LAW (staged) — V1/V2/V4 role-vocabulary rows (docs/PROVENANCE.md §2 "Declaration
 * vocabulary"; docs/PROVENANCE-PLAN.md Cluster V).
 *
 * V3 (opaque quarantine drift alarm) is DELIBERATELY NOT duplicated here — its
 * counted-walk machinery lives in the sibling `opaque-quarantine.law.test.ts`.
 *
 * V1 — the declared `provenance` role field + its drift-alarm door.
 * V2 — the classifier consumes declared roles ONLY (heuristics deleted).
 * V2-Q4 — callback roles extracted from the contract (z.lambda position + return
 *   shape), declaration override where shape underdetermines, the drift-door
 *   extension, and the fold acc-chain marker.
 * V4 — cone-traversal termination over cyclic `binder{cycles}` (loop) nodes.
 * Q7 — program-prelude PURE-only membership: a fetch-wrapping helper, direct AND
 *   transitive, is refused with a teaching door. The positive half lives in
 *   `wireframe-agreement.law.test.ts`.
 *
 * The older per-env `pure` registry is gone: `RosettaSpec.pure` remains a type-level
 * field, not a queryable registry; live mint/forward is `Contract.provenance` at bake
 * time. A rosetta fn defaults to `"source"`; declare `"pipe"` when it genuinely
 * propagates input provenance.
 */
import { describe, it, expect } from "vitest";
import { parse } from "../../eval/generator-exec.js";
import { inferenceEnv } from "../../env/inference-env.js";
import {
  classify,
  fullCone,
  countCone,
  fieldCone,
  type Classifier,
  type DeclaredRole,
} from "../../provenance/lineage.js";
import { classifierFromEnv } from "../../provenance/lineage-classifier-from-env.js";
import { buildWireframe } from "../../provenance/wireframe/builder.js";
import * as z from "../../common/scheme-zod/index.js";
import { symbol } from "../../symbol/index.js";
import type { AEntity, ProvenanceRole } from "../../common/symbols/_bake.js";
import { EnvCapability } from "../../common/capability.js";
import { declaresAccChain, withCallbackRoles, type CallbackRoles } from "../../common/symbols/_bake.js";
import type { NativeSymbolDef } from "../../values/primitives/ANativeProcedure.js";
import type {
  RosettaSymbolDef,
  SequenceSymbolDef,
  TaglessGuardSymbolDef,
  TaglessSymbolDef,
} from "../../common/symbols/_bake.js";

/** Test-only cast: pull a minted value's `.contract` (typed `unknown` on the class — see
 *  ACallable.ts) back to its known CONTRACT shape. Stage A2: the factories mint the
 *  runtime A-value directly now; the def they used to RETURN rides `.contract` on it. */
function contractOf<T>(v: { contract: unknown }): T {
  return v.contract as T;
}
import { ProvenanceRoleShapeError, PreludeMembershipError } from "../../errors.js";
import { classifyProgramPrelude, assertPreludeEligible } from "../../provenance/prelude.js";
import { applyCapability, freshEnv } from "../../__tests__/_fresh-env.js";
import { theVoid } from "../../values/primitives/AVoid.js";
import srfi1 from "../../env/srfi/srfi-1.js";
import srfi95 from "../../env/srfi/srfi-95.js";
import lists from "../../env/r7rs/lists.js";
import strings from "../../env/r7rs/strings.js";
import vectors from "../../env/r7rs/vectors.js";
import binding from "../../env/r7rs/binding.js";
import equality from "../../env/r7rs/equality.js";
import { harvestContracts } from "../../__tests__/_symbols-harvest.js";

/** Resolved callback roles off a pack's REAL exported def (the data plane Q3/Q8a read) —
 *  same `.spec.symbols` access idiom as the `*-contract-precision.test.ts` files. */
function rolesOf(pack: { spec: { symbols?: unknown } }, name: string): CallbackRoles | undefined {
  const d = harvestContracts(pack.spec.symbols)[name];
  if (d === undefined) throw new Error(`pack has no symbol named ${name}`);
  return "callbackRoles" in d ? d.callbackRoles : undefined;
}

describe("V1 — declared provenance role (§2 CHOSEN: one role per symbol declaration)", () => {
  it(
    "every symbol declaration carries exactly one `provenance` role from " +
      "{pipe, fan, source, sink, transparent, loop, opaque} — pipe default for " +
      "native/sequence/tagless kinds, source default for rosetta",
    async () => {
      // KIND DEFAULTS — no `provenance` in the contract; the factory resolves the
      // kind's default before the def is returned (`contract.provenance ?? "pipe"` /
      // `?? "source"` in native.ts/rosetta.ts/sequence.ts; tagless.ts/taglessGuard.ts
      // hardcode "pipe" — no `Contract` channel exists to override it at all).
      // Stage A2: `contractOf` pulls the baked CONTRACT (`.provenance: ProvenanceRole`)
      // off the minted value — reading `.provenance` DIRECTLY on the value would instead
      // hit `AValue`'s OWN `provenance: ReadonlySet<number>` field (the lineage-marker
      // set every scheme value carries), a same-named but semantically unrelated field.
      expect(
        contractOf<NativeSymbolDef>(
          symbol.native`v1-default-native: `({ input: [z.schemeValue], output: [z.schemeValue] }, (v) => v),
        ).provenance,
      ).toBe("pipe");
      expect(
        contractOf<RosettaSymbolDef>(
          symbol.rosetta`v1-default-rosetta: `({ input: [z.string], output: [z.string] }, (s) => s),
        ).provenance,
      ).toBe("source");
      expect(
        contractOf<SequenceSymbolDef>(
          symbol.sequence`v1-default-sequence: `(
            { input: [z.schemeValue], output: [z.schemeValue] },
            (args) => args[0],
          ),
        ).provenance,
      ).toBe("pipe");
      expect(contractOf<TaglessSymbolDef>(symbol.tagless`v1-default-tagless: `).provenance).toBe("pipe");
      expect(contractOf<TaglessGuardSymbolDef>(symbol.taglessGuard`v1-default-taglessguard: `).provenance).toBe("pipe");

      // THE SEVEN-ROLE VOCABULARY — every member is a real, declarable role;
      // exercised where `assertProvenanceRoleShape` (_bake.ts) constrains the shape
      // (sink/transparent need a truly zero-item output vector; fan needs a
      // z.lambda input arm — the two SHAPE-decidable checks) and freely where it
      // doesn't (pipe/source/loop/opaque carry no shape constraint at all).
      expect(
        contractOf<NativeSymbolDef>(
          symbol.native`v1-role-pipe: `(
            { input: [z.schemeValue], output: [z.schemeValue], provenance: "pipe" },
            (v) => v,
          ),
        ).provenance,
      ).toBe("pipe");
      expect(
        contractOf<NativeSymbolDef>(
          symbol.native`v1-role-fan: `(
            { input: [z.lambda, z.schemeValue], output: [z.schemeValue], provenance: "fan" },
            (f, v) => v,
          ),
        ).provenance,
      ).toBe("fan");
      expect(
        contractOf<RosettaSymbolDef>(
          symbol.rosetta`v1-role-source: `({ input: [z.string], output: [z.string], provenance: "source" }, (s) => s),
        ).provenance,
      ).toBe("source");
      expect(
        contractOf<NativeSymbolDef>(
          symbol.native`v1-role-loop: `(
            { input: [z.schemeValue], output: [z.schemeValue], provenance: "loop" },
            (v) => v,
          ),
        ).provenance,
      ).toBe("loop");
      expect(
        contractOf<NativeSymbolDef>(
          symbol.native`v1-role-opaque: `(
            { input: [z.schemeValue], output: [z.schemeValue], provenance: "opaque" },
            (v) => v,
          ),
        ).provenance,
      ).toBe("opaque");
      expect(
        contractOf<NativeSymbolDef>(
          symbol.native`v1-role-sink: `({ input: [z.schemeValue], output: [], provenance: "sink" }, (): [] => []),
        ).provenance,
      ).toBe("sink");
      expect(
        contractOf<NativeSymbolDef>(
          symbol.native`v1-role-transparent: `(
            { input: [z.schemeValue], output: [], provenance: "transparent" },
            (): [] => [],
          ),
        ).provenance,
      ).toBe("transparent");

      // TYPE-LEVEL: `Contract.provenance` types as `ProvenanceRole | undefined` — a
      // string outside the seven-member union is a COMPILE error, never a runtime
      // guess. Left commented (a live `@ts-expect-error` line would itself need to
      // stay a type error forever to keep passing, which is more fragile than the
      // comment) — the type declaration below is the load-bearing proof:
      // symbol.native`v1-role-bogus: `({ input: [z.schemeValue], output: [z.schemeValue], provenance: "bogus" }, (v) => v);
      //                                                                        ^ not assignable to ProvenanceRole
      const _exhaustive: ProvenanceRole[] = ["pipe", "fan", "source", "sink", "transparent", "loop", "opaque"];
      expect(_exhaustive).toHaveLength(7);
    },
  );

  it.todo(
    "the two ad-hoc booleans `fanout?`/`pure?` are GONE, not merely deprecated — " +
      'no declaration surface accepts them any more (§2 EXCLUDED: "degenerate two-word ' +
      'fragment of this vocabulary; each had exactly two readers")',
    // RESIDUAL FINDING (do not flip without either (a) retiring the retired surface
    // below, or (b) narrowing this row's title to the `symbol.*` declaration surface
    // it actually verifies):
    //
    // `fanout?` is fully gone — no live type anywhere carries that field.
    //
    // `pure?` is NOT gone. `RosettaSpec.pure` (src/common/scheme-env.ts) is still
    // a LIVE type-level field on the cross-package spec. Live mint/forward is
    // `Contract.provenance` at bake time (`mintsPoint` when not `"pipe"`).
    // (The static-side `rosettaPureOf` per-env registry is DELETED — write-only
    // after Q2/Q3, see docs/working-proposals/rosetta-registry-dissolution.md.)
    // `common/capability.ts`'s
    // own `SymbolDeclaration` doc names this explicitly as a permanent (not
    // migration-remnant) arm: "Gone from `foundations/arrival/**` itself, but
    // load-bearing OUTSIDE it: McpEnvCapability's whole inline-annotation design …
    // and every downstream capability (here.build's saas/server/{arrival,mcp}",
    // inhuman's saas/mcp, the sift-submission forensics catalog) still authors verbs
    // this way." `provenance/lineage-classifier-from-env.ts`'s own header independently
    // confirms: "The pure-flag
    // runtime API is a SEPARATE, not-yet-migrated registration path outside Q2/Q3's
    // declared-role vocabulary — ops registered that way carry no `.provenanceRole`."
    //
    // So the row is TRUE for the `symbol.*` (Q2) baked-declaration surface within
    // this package's own env packs, and FALSE as a whole-codebase claim ("no
    // declaration surface accepts them any more"). Writing a test against the
    // narrower, actually-landed claim would silently launder the wider claim the
    // title makes — reported instead per the task's residual-finding instruction.
  );

  it(
    "declaration-completeness: every bound symbol that reaches the classifier has a " +
      "declared role — an undeclared symbol is a build-time error, never a silent " +
      "default-to-opaque",
    async () => {
      // The baked TYPE makes omission impossible: every callable-kind def
      // (`NativeSymbolDef`/`RosettaSymbolDef`/`SequenceSymbolDef`/`TaglessSymbolDef`/
      // `TaglessGuardSymbolDef`) declares `readonly provenance: ProvenanceRole` —
      // non-optional — and every factory resolves the kind default BEFORE returning
      // the def (see the previous row). There is no path to a baked value with a
      // missing role: "build-time error" cashes out as "the type does not admit the
      // omission," never a runtime silent default — and never, in particular, a
      // silent default TO `"opaque"` (which is its own explicit role, reached only
      // when actually declared).
      // Stage A2: each factory now mints the runtime A-value directly — `contractOf`
      // pulls the baked CONTRACT (still non-optional `provenance`) back off it.
      const defs: { provenance: ProvenanceRole }[] = [
        contractOf(symbol.native`v1-complete-native: `({ input: [z.schemeValue], output: [z.schemeValue] }, (v) => v)),
        contractOf(symbol.rosetta`v1-complete-rosetta: `({ input: [z.string], output: [z.string] }, (s) => s)),
        contractOf(
          symbol.sequence`v1-complete-sequence: `(
            { input: [z.schemeValue], output: [z.schemeValue] },
            (args) => args[0],
          ),
        ),
        contractOf(symbol.tagless`v1-complete-tagless: `),
        contractOf(symbol.taglessGuard`v1-complete-taglessguard: `),
      ];
      for (const def of defs) {
        expect(typeof def.provenance).toBe("string");
        expect(def.provenance).not.toBe("opaque");
      }

      // Live classifier read: an UNDECLARED op (`roleOf` answers `undefined` — an
      // unbound name, or a plain user-defined Scheme lambda) resolves through
      // `classify()` to the exact SAME node KIND as an explicitly declared `pipe`
      // role — `lineage.ts`'s `classifyWith` shares ONE arm for "role === pipe or
      // undefined" (see its own comment there). Never a silent fall to `opaque`,
      // which is its own separate branch reached only when `roleOf` explicitly
      // answers `"opaque"`.
      const C: Classifier = { roleOf: (op) => (op === "declared-pipe" ? "pipe" : undefined) };
      const [undeclaredAst] = await parse(`(totally-undeclared-op x)`);
      const [declaredPipeAst] = await parse(`(declared-pipe x)`);
      const undeclaredNode = classify(undeclaredAst, C);
      const declaredNode = classify(declaredPipeAst, C);
      expect(undeclaredNode.kind).not.toBe("opaque");
      expect(undeclaredNode.kind).toBe(declaredNode.kind);
    },
  );

  it(
    "drift-alarm door (assembly-time): a declared role inconsistent with its contract " +
      "shape (e.g. declared `pipe` but the z.lambda position/return shape implies `fan`) " +
      "trips the door at assembly time — CONTRADICTIONS only, never silent (§2 LIMIT: " +
      '"catches CONTRADICTIONS, not lies: a JS body that fans while declared pipe is ' +
      'consistent-but-wrong; contract shape cannot see JS bodies")',
    () => {
      // The TWO shape-decidable contradictions `assertProvenanceRoleShape` actually
      // checks (_bake.ts) — both fire at BAKE (assembly) time, before any call site
      // exists:
      //
      // 1. sink/transparent claim "no egress wire" — a contract whose normalized
      //    output vector carries a real return schema contradicts that.
      expect(() =>
        symbol.native`v1-drift-sink-egress: sink declaring a real return`(
          { input: [z.schemeValue], output: [z.schemeValue], provenance: "sink" },
          (v) => v,
        ),
      ).toThrow(ProvenanceRoleShapeError);
      expect(() =>
        symbol.native`v1-drift-transparent-egress: transparent declaring a real return`(
          { input: [z.schemeValue], output: [z.schemeValue], provenance: "transparent" },
          (v) => v,
        ),
      ).toThrow(ProvenanceRoleShapeError);
      // Consistent counterpart — a truly zero-item output vector passes.
      expect(
        contractOf<NativeSymbolDef>(
          symbol.native`v1-drift-sink-ok: sink with no egress wire`(
            { input: [z.schemeValue], output: [], provenance: "sink" },
            (): [] => [],
          ),
        ).provenance,
      ).toBe("sink");

      // 2. `fan` claims "apply this proc across elements" — a contract whose input
      //    vector has no z.lambda arm has no proc to apply.
      expect(() =>
        symbol.native`v1-drift-fan-no-lambda: fan with no proc to apply`(
          { input: [z.schemeValue], output: [z.schemeValue], provenance: "fan" },
          (v) => v,
        ),
      ).toThrow(ProvenanceRoleShapeError);
      // Consistent counterpart — a lambda arm present passes.
      expect(
        contractOf<NativeSymbolDef>(
          symbol.native`v1-drift-fan-ok: fan with a proc to apply`(
            { input: [z.lambda, z.schemeValue], output: [z.schemeValue], provenance: "fan" },
            (f, v) => v,
          ),
        ).provenance,
      ).toBe("fan");

      // The row's own parenthetical example — "declared `pipe` but the z.lambda
      // position … shape implies `fan`" — is EXACTLY the case the cited §2 LIMIT
      // rules out: a contract carrying a z.lambda arm declared `pipe` (sort/find/
      // member-shaped — a real callback present, host role legitimately pipe) does
      // NOT trip the door. The alarm has only the two checks above; there is no
      // third "shape looks fan-ish" guess for a `pipe` declaration to contradict.
      // Verified below as a NON-throw — the machinery is not bent to make it throw.
      expect(() =>
        symbol.native`v1-drift-pipe-with-lambda: pipe host, real lambda arg — not a contradiction`(
          { input: [z.lambda, z.schemeValue], output: [z.schemeValue], provenance: "pipe" },
          (f, v) => v,
        ),
      ).not.toThrow();
    },
  );

  it(
    "declaration kinds LOWER 1:1 to graph node kinds (one vocabulary, two layers): " +
      "`loop` → `binder{cycles}`; `sink`/`transparent` are declaration-layer facts " +
      "lowering to graph shapes, never a second parallel vocabulary (§2 EXCLUDED, panel C11)",
    async () => {
      const C: Classifier = {
        roleOf: (op) =>
          op === "declared-loop"
            ? "loop"
            : op === "declared-sink"
              ? "sink"
              : op === "declared-transparent"
                ? "transparent"
                : undefined,
      };

      const [loopAst] = await parse(`(declared-loop x)`);
      const loopNode = classify(loopAst, C);
      expect(loopNode.kind).toBe("binder");
      if (loopNode.kind === "binder") expect(loopNode.cycles).toBe(true);

      const [sinkAst] = await parse(`(declared-sink x)`);
      expect(classify(sinkAst, C).kind).toBe("sink");

      const [transparentAst] = await parse(`(declared-transparent x)`);
      expect(classify(transparentAst, C).kind).toBe("transparent");

      // ONE vocabulary, not two: `DeclaredRole` (lineage.ts) and `ProvenanceRole`
      // (_bake.ts) are the SAME seven-member string union, declared independently
      // (lineage.ts stays dependency-light — no `common/` coupling) but required by
      // both files' own header comments to stay in lock-step. This line compiles
      // iff the two unions have identical membership — a drift would be a `tsc`
      // error here, not a runtime surprise.
      const roles: readonly (DeclaredRole & ProvenanceRole)[] = [
        "pipe",
        "fan",
        "source",
        "sink",
        "transparent",
        "loop",
        "opaque",
      ];
      expect(roles).toHaveLength(7);
    },
  );
});

describe("V2 — declaration-driven classifier (§2; PROVENANCE-PLAN.md Q3)", () => {
  it(
    "the classifier reads ONLY the declared `provenance` role — the `isRosettaIn` " +
      "heuristic and the `.fanout` duck-read off a bound function are DELETED, not " +
      'merely bypassed (§2 EXCLUDED: "the key-taxonomy violation the P7 corollary ' +
      'exists to kill; every static interpreter reads the declared field")',
    async () => {
      // Names picked to defeat any residual name-based guess — a "pure"-sounding name
      // declared `source`, and a name with no source-y hint declared `pipe`. If
      // classify() still consulted a name list (the retired heuristic) rather than
      // the declared role alone, one of these would misclassify.
      const C: Classifier = {
        roleOf: (op) => (op === "totally-pure-sounding" ? "source" : op === "clearly-a-mint" ? "pipe" : undefined),
      };
      const [mintAst] = await parse(`(totally-pure-sounding p)`);
      expect(classify(mintAst, C).kind).toBe("source");
      const [pipeAst] = await parse(`(clearly-a-mint p)`);
      expect(classify(pipeAst, C).kind).toBe("pipe");

      // The retired seam, structurally: `classifierFromEnv` used to accept a
      // caller-supplied `sources: ReadonlySet<string>` second parameter (the
      // heuristic this row retires) — it is now arity-1, reading the bound value's
      // declared `.provenanceRole` alone (`provenance/lineage-classifier-from-env.ts`).
      expect(classifierFromEnv.length).toBe(1);
    },
  );

  it(
    "named-let and `do` loops classify as `loop` (lowering to `binder{cycles}`), " +
      "not `opaque` — this is the exact corpus row `laws/opaque-quarantine.law.test.ts` " +
      'used to mark "opaque today (pending Q3\'s binder rewrite)": `(let loop ((a v1)) a)` ' +
      "flipped off that corpus's opaque count when this landed",
    async () => {
      const C: Classifier = { roleOf: () => undefined };

      const [namedLetAst] = await parse(`(let loop ((a v1)) a)`);
      const namedLet = classify(namedLetAst, C);
      expect(namedLet.kind).toBe("binder");
      if (namedLet.kind === "binder") {
        expect(namedLet.cycles).toBe(true);
        expect(namedLet.op).toBe("named-let");
      }

      const [doAst] = await parse(`(do ((i 0 (+ i 1))) ((= i 3) i))`);
      const doNode = classify(doAst, C);
      expect(doNode.kind).toBe("binder");
      if (doNode.kind === "binder") {
        expect(doNode.cycles).toBe(true);
        expect(doNode.op).toBe("do");
      }
    },
  );

  it(
    "callback roles are extracted from the contract (z.lambda position + return shape) " +
      "into element-transformer / control / effect / accumulator, with declaration " +
      "override only where the contract underdetermines (§2 CHOSEN)",
    () => {
      // SHAPE-EXTRACTED (no declaration on either def):
      // map/vector-map — fan host + value egress ⇒ element-transformer (the fan default).
      expect(rolesOf(lists, "map")).toEqual(["element-transformer"]);
      expect(rolesOf(vectors, "vector-map")).toEqual(["element-transformer"]);
      // the for-each family — void-family host egress ⇒ effect (shape-DECIDED: the
      // callback's product has no egress wire to ride).
      expect(rolesOf(lists, "for-each")).toEqual(["effect"]);
      expect(rolesOf(strings, "string-for-each")).toEqual(["effect"]);
      expect(rolesOf(vectors, "vector-for-each")).toEqual(["effect"]);

      // DECLARED where shape underdetermines (or merely defaults):
      // filter — shape-identical to map (fan + value egress ⇒ the element-transformer
      // DEFAULT), overridden to `control`: the pred is the length-changing selector
      // (§2 R2's PROVENANCED verb; the merged selector+decision one-color ruling).
      expect(rolesOf(srfi1, "filter")).toEqual(["control"]);
      // find/member/assoc — pipe hosts, value egress: underdetermined ⇒ declared
      // `control` (boolean selectors deciding WHICH element egresses). member/assoc's
      // compare is lambda arm 0 despite sitting at input position 2 — roles align with
      // LAMBDA arms, not input positions.
      expect(rolesOf(srfi1, "find")).toEqual(["control"]);
      expect(rolesOf(lists, "member")).toEqual(["control"]);
      expect(rolesOf(lists, "assoc")).toEqual(["control"]);
      // sort — pipe host, value egress, `z.lambda.optional()` at input position 1:
      // the optional wrapper still counts as a lambda arm, and the ordering comparator
      // is declared `control` (the host-schedule op of spec §5).
      expect(rolesOf(srfi95, "sort")).toEqual(["control"]);
      // string-map — pipe host (never a declared fan), value egress: underdetermined ⇒
      // declared element-transformer (proc's return BECOMES the output character).
      expect(rolesOf(strings, "string-map")).toEqual(["element-transformer"]);

      // UNDERDETERMINED + UNDECLARED = honest holes, never guesses:
      // call-with-values was the classic two-lambda underdetermined host — multi-return
      // is now a purity door (no contract/callbackRoles). procedure?'s subject arg is
      // z.schemeValue (the callable question rides the type-guard `type:` override, not the
      // schema) — no z.lambda arm in the contract ⇒ no callbackRoles field content,
      // exactly the cons rule below.
      expect(rolesOf(binding, "call-with-values")).toBeUndefined(); // door — no arms
      expect(rolesOf(equality, "procedure?")).toBeUndefined();

      // No z.lambda arm at all ⇒ no callbackRoles field content (undefined, not []).
      expect(rolesOf(lists, "cons")).toBeUndefined();
    },
  );
});

describe("V2-Q4 — callback-role drift door + acc chain + stamp path (§2/§3; PROVENANCE-PLAN.md Q4)", () => {
  it(
    "drift-door extension: a declaration CONTRADICTING decidable shape throws " +
      "ProvenanceRoleShapeError at bake (void-egress arms are DECIDED `effect`; a role " +
      "for a phantom callback is a decidable contradiction) — while overriding a mere " +
      "DEFAULT passes (under-trigger, never guess)",
    () => {
      // Contradicting a DECIDED arm: void-family egress decides `effect`; declaring the
      // arm an element-transformer is a shape-visible lie → door.
      expect(() =>
        symbol.native`q4-bad-effect: declared transformer under void egress`(
          { input: [z.lambda], output: [z.undefinedResult], callbackRoles: ["element-transformer"] },
          () => theVoid,
        ),
      ).toThrow(ProvenanceRoleShapeError);
      // Agreeing with the DECIDED arm passes — declaration may restate shape.
      expect(
        contractOf<NativeSymbolDef>(
          symbol.native`q4-ok-effect: declared effect under void egress`(
            { input: [z.lambda], output: [z.undefinedResult], callbackRoles: ["effect"] },
            () => theVoid,
          ),
        ).callbackRoles,
      ).toEqual(["effect"]);
      // Phantom callback: roles declared with NO z.lambda arm to carry them → door.
      expect(() =>
        symbol.native`q4-phantom: roles with no lambda arm`(
          { input: [z.string], output: [z.string], callbackRoles: ["control"] },
          (s) => s,
        ),
      ).toThrow(ProvenanceRoleShapeError);
      // MORE roles than lambda arms → door (same phantom-callback contradiction).
      expect(() =>
        symbol.native`q4-excess: two roles, one lambda arm`(
          { input: [z.lambda, z.schemeValue], output: [z.schemeValue], callbackRoles: ["control", "control"] },
          (f, v) => v,
        ),
      ).toThrow(ProvenanceRoleShapeError);
      // Overriding the fan DEFAULT (element-transformer) to control does NOT door —
      // filter's exact shape; the default yields to declaration.
      expect(
        contractOf<NativeSymbolDef>(
          symbol.native`q4-fan-override: fan default overridden to control`(
            {
              input: [z.lambda, z.schemeValue],
              output: [z.schemeValue],
              provenance: "fan",
              callbackRoles: ["control"],
            },
            (f, v) => v,
          ),
        ).callbackRoles,
      ).toEqual(["control"]);
    },
  );

  it(
    "fold declares the acc chain: srfi-1 `reduce` carries the DECLARED `accumulator` arm " +
      "(via `withCallbackRoles` — a tagless def's contract is shapeless by construction, " +
      "so declaration is the ONLY channel), and `declaresAccChain` reads it as data — the " +
      "chained track-composition source (§3: `egress(Tᵢ) → ingress(Tᵢ₊₁)` is the only " +
      "sanctioned inter-track edge)",
    () => {
      expect(rolesOf(srfi1, "reduce")).toEqual(["accumulator"]);
      expect(declaresAccChain(rolesOf(srfi1, "reduce"))).toBe(true);
      // Parallel-composition hosts do NOT declare an acc chain.
      expect(declaresAccChain(rolesOf(lists, "map"))).toBe(false);
      expect(declaresAccChain(rolesOf(srfi1, "filter"))).toBe(false);
      expect(declaresAccChain(undefined)).toBe(false);
      // withCallbackRoles stamps the roles onto the minted value (+ its `.contract`) in
      // place — Stage A2's mutate-in-place sugar (the shapeless tagless contract has no
      // Contract param to thread a declaration through).
      const marked = withCallbackRoles(symbol.tagless`q4-fold: synthetic fold`, ["accumulator"]);
      expect(contractOf<TaglessSymbolDef>(marked).callbackRoles).toEqual(["accumulator"]);
      expect(declaresAccChain(contractOf<TaglessSymbolDef>(marked).callbackRoles)).toBe(true);
    },
  );

  it(
    "the resolved CallbackRole[] rides the BOUND callable via the same stamp path as the " +
      "top-level role (capability.ts) — Q3/Q8a read `.callbackRoles` off `env.get(op)` as " +
      "data, uniformly across native/sequence/tagless/rosetta kinds",
    async () => {
      const env = await freshEnv();
      const read = (op: string): CallbackRoles | undefined =>
        (env.get(op) as { callbackRoles?: CallbackRoles }).callbackRoles;
      // sequence kind (filter — declared override), tagless kind (reduce — withCallbackRoles),
      // native kind (for-each — shape-decided effect).
      expect(read("filter")).toEqual(["control"]);
      expect(read("reduce")).toEqual(["accumulator"]);
      expect(read("for-each")).toEqual(["effect"]);
      expect(read("sort")).toEqual(["control"]);
      // A def with no lambda arms binds with NO callbackRoles stamped.
      expect(read("cons")).toBeUndefined();
      // The stamp seam is the REAL EnvCapability binder end-to-end for a fresh synthetic
      // def too (the kwargs-runtime fixture convention) — fan default rides the binding.
      await applyCapability(env, [
        EnvCapability.define("test/q4-stamp", {
          symbols: (symbol, z) => ({
            "q4-stamp": symbol.native`q4-stamp: synthetic fan`(
              { input: [z.lambda, z.schemeValue], output: [z.schemeValue], provenance: "fan" },
              (f, v) => v,
            ),
          }),
        }),
      ]);
      expect(read("q4-stamp")).toEqual(["element-transformer"]);
    },
  );
});

describe("V4 — cone-traversal termination over cyclic binder nodes (§1; PROVENANCE-PLAN.md Q8a′)", () => {
  it(
    "fullCone/countCone/fieldCone over a `binder{cycles: true}` node TERMINATES — a " +
      "cyclic loop-carried dependency never sends the walker into unbounded recursion " +
      "(the widening interplay Q8a′'s risk register names explicitly)",
    async () => {
      const C: Classifier = { roleOf: (op) => (op === "src" ? "source" : undefined) };
      // A nested named-let (loop-in-loop, the outer's recur called from inside the
      // inner's arm) — deep and finite, but exactly the shape the risk register
      // worries about. `walk()`'s own header already argues WHY this terminates:
      // classify() never expands a call site into its callee's body, so no
      // `LineageNode` object can reach itself through `.children`/`.child` — a
      // `binder` is exactly as acyclic as `merge`/`opaque`'s children array. This
      // row exercises that argument against a REAL nested-loop tree rather than
      // taking the file's own reasoning on faith.
      const [ast] = await parse(
        `(let outer ((i 0))
           (if (> i 3)
               i
               (let inner ((j 0))
                 (if (> j 3)
                     (outer (+ i 1))
                     (inner (+ j (src)))))))`,
      );
      const node = classify(ast, C);
      expect(node.kind).toBe("binder");
      const bindings = { src: [1, 2, 3] };
      // Returning AT ALL (rather than hanging / stack-overflowing) is the
      // termination assertion; the concrete ids pin it's not a vacuous no-op walk.
      expect(fullCone(node, bindings)).toEqual([1, 2, 3]);
      expect(countCone(node, bindings)).toEqual([1, 2, 3]);
      // A field demand crossing a `binder` is a DEMAND BARRIER (walk()'s shared
      // merge/opaque/sink/binder case) — the full cone, same as fullCone above,
      // not an empty prune.
      expect(fieldCone(node, bindings, { field: "whatever" })).toEqual([1, 2, 3]);
    },
  );

  it(
    "loop wireframing lands template referents BEFORE emission can key records against " +
      "them — a loop-heavy program never emits a record with no template (Q8a′ is a " +
      "HARD gate before Q11a for exactly this reason)",
    async () => {
      const forms = await parse("(emit! (let loop ((i 0)) (if (> i 3) i (loop (+ i 1)))))");
      const C: Classifier = { roleOf: (op) => (op === "emit!" ? "sink" : undefined) };
      const p = buildWireframe(forms, { classifier: C, isBaseName: (n) => ["+", ">"].includes(n) });
      const binder = p.main.nodes.find((n) => n.kind === "binder");
      expect(binder).toBeDefined();
      if (binder?.kind !== "binder") throw new Error("expected a binder node");
      // The TEMPLATE REFERENT exists — a private interior graph with real nodes,
      // never a deferred stub — at BUILD time, before any record (Q11a, not yet
      // landed) could key against it.
      expect(binder.interior.nodes.length).toBeGreaterThan(0);
      expect(binder.params).toEqual(["i"]);
    },
  );
});

describe("Q7 — program prelude: PURE-only membership, the REJECTED direction (§1 CHOSEN round 2 A3, narrowed round 3 M1; PROVENANCE-PLAN.md Q7)", () => {
  it(
    "a define wrapping a fetch-role (source) rosetta is refused prelude membership — " +
      "directly (its own body crosses the port) AND transitively (a caller that never " +
      "touches the port itself, but REFERENCES the port-reaching helper by name, is " +
      "itself port-reaching — §1's fixpoint over the top-level call graph) — " +
      "`assertPreludeEligible` throws a teaching door naming the port (errors-as-doors; " +
      '§1 EXCLUDED "port-reaching defines in the prelude — name indirection would ' +
      "smuggle sources into 'pure' wire bodies\")",
    async () => {
      const C: Classifier = { roleOf: (op) => (op === "fetch-thing" ? "source" : undefined) };
      const forms = await parse(
        `(define (helper) (fetch-thing "https://example.invalid"))
         (define (caller) (helper))
         (define (uninvolved) 42)`,
      );
      const membership = classifyProgramPrelude(forms, C);

      // Direct: helper's own body crosses the declared source port.
      expect(membership.wireframe.has("helper")).toBe(true);
      expect(membership.pure.has("helper")).toBe(false);
      // Transitive: caller's body only references `helper` by name (classify() alone
      // cannot see through the call — the gap this module's fixpoint closes).
      expect(membership.wireframe.has("caller")).toBe(true);
      expect(membership.pure.has("caller")).toBe(false);
      // A genuinely unrelated define stays pure — the rejection doesn't over-taint.
      expect(membership.pure.has("uninvolved")).toBe(true);
      expect(membership.wireframe.has("uninvolved")).toBe(false);

      for (const name of ["helper", "caller"]) {
        let caught: unknown;
        try {
          assertPreludeEligible(name, membership);
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(PreludeMembershipError);
        expect((caught as PreludeMembershipError).message).toMatch(/port/i);
      }
      // The eligible one throws nothing.
      expect(() => assertPreludeEligible("uninvolved", membership)).not.toThrow();
    },
  );
});
