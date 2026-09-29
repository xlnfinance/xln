/**
 * degradation.law.test.ts — door-set degradation (docs/design-history/
 * symbol-define-static-program-validation.md §3.7). The introspectable
 * `DoorProcedure` + `DoorCause` shape (§3.3) stamps `needs: []` everywhere;
 * this law suite pins the MECHANISM that actually mints non-empty `needs` — the
 * `Contract.requiresConfig` auto-door, `Activation.degradation` (common/degradation.ts),
 * and `Vocabulary.degraded` (env/vocabulary.ts).
 *
 * STAGE C CUT 4 (docs/plans/stage-c-corpse-deletion.md) retired `lower()`/`assembleEnv`
 * (and with them, the `degradation: "doors" | "forbid"` KNOB this suite used to pass
 * per-call): `env/vocabulary.ts`'s `processCapability` hardcodes the mode-independent
 * `"forbid"` posture unconditionally now. This is not a loss of coverage — D2 (the auto-door
 * ruling this file already documented) says the `requiresConfig` auto-door mints REGARDLESS
 * of mode; the "doors" rows below were always pinning "same outcome as forbid," so with no
 * mode knob left to vary, those rows collapse into the single mode-independent assertion they
 * were already proving. TRAILS CLEANUP (Tier 1, docs/plans/stage-c-corpse-deletion.md) went
 * one step further: `DegradationInfo.mode`/`.missingKeys`/`.active` had zero readers anywhere
 * (internal or external) once mode-independent, so they were retired outright — `DegradationInfo`
 * is now just its `.door(...)` minter, and `buildDegradationInfo` takes only `owner`.
 *
 * LAW 1 ("forbid" default preserved): a genuinely REQUIRED config key (no `.optional()`/
 *   `.default()`) absent from the supplied config throws (now: rejects — `buildVocabulary` is
 *   async) at vocabulary-build time — §3.7's "required config stays fail-closed" row.
 *
 *   Deviation from the ticket's literal fixture, recorded honestly: `arrival/infer`'s own
 *   `configuration: { infer: z.custom<InferFn>() }` was named as "the non-optional key"
 *   fixture, but verified against the installed zod (4.3.6): `z.custom()` with NO predicate
 *   answers `.isOptional()` `true` and `schema.parse({})` SUCCEEDS — infer's config is a
 *   known no-op validator (design doc §3.7's required-config note, explicitly out of this
 *   suite's scope), so it does not actually throw today. This suite instead (a) proves a REAL
 *   required key throws, and (b) proves `missingOptionalKeys` correctly refuses to classify
 *   infer's shape as "optional" — the structural check (`instanceof ZodOptional | ZodDefault`)
 *   that keeps this module from silently degrading a key the author never marked `.optional()`.
 *
 * LAW 2 (an absent optional enabling key lowers to a cause-carrying door): a verb declaring
 *   the key in its `Contract.requiresConfig` binds a `DoorProcedure` whose firing message
 *   teaches "provide X to enable it" — never a silent withhold.
 *
 * LAW 3 (degraded list surfaced): `Vocabulary.degraded` enumerates every capability that
 *   lowered degraded (capability name + the missing `needs`).
 *
 * LAW 4 (invalid config still throws/rejects): present-but-wrong-shaped config is a
 *   `schema.parse` throw unconditionally — degradation only ever narrows ABSENCE.
 *
 * LAW 5 (doors are typo-suggestible + carry the causal chain): a degradation-minted door is
 *   an ordinary bound value — present in `env.allBoundNames()` (the exact iterable
 *   `suggestFromVocabulary`'s callers feed it, per unbound-variable.ts's own doc), so it
 *   participates in typo suggestion for free. Firing it reconstructs the full causal
 *   chain: reference → door (`.door`) → owner (`.cause.owner`) → missing key (`.cause.needs`).
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
// The SCHEME-facing contract vocabulary (`sz.schemeValue`, the `symbol.native` input/output
// vectors) is a DIFFERENT module than JS `zod` (config schemas use real `zod`) — aliased
// so both are usable in the same file without shadowing, matching every other test that
// declares both a capability's `configuration` (JS zod) and a native's contract (scheme-zod).
import * as sz from "../../common/scheme-zod/index.js";
import { EnvCapability } from "../../common/capability.js";
import { buildVocabulary } from "../../env/vocabulary.js";
import { missingOptionalKeys } from "../../common/degradation.js";
import { DoorProcedure } from "../../values/primitives/ACallable.js";
import { PurityError } from "../../errors.js";
import { nil } from "../../values/primitives/ANil.js";
import { ResolvingAmbient, type EnvWithInternals } from "../../env/AmbientRuntime.js";
import { execInFrame } from "../../eval/generator-exec.js";

const evalScheme = (env: unknown, src: unknown): unknown => execInFrame(src as string, env as ResolvingAmbient);

/** A REAL recording env — same shape as door-cause.test.ts's, local here so this law
 *  suite has no cross-file coupling to another test's fixture. (Hermetic-AmbientRuntime
 *  ruling: capability apply narrows to the concrete `AmbientRuntime`, so a synthetic
 *  `{ set }` mock can no longer receive bindings; `bound` is a read facade over the
 *  frame's own storage record.) */
function recordingEnv(): { env: ResolvingAmbient; bound: { get(name: string): unknown; has(name: string): boolean } } {
  const env = ResolvingAmbient.root("degradation-recording") as EnvWithInternals<ResolvingAmbient>;
  return {
    env,
    bound: { get: (name) => env.__env__[name], has: (name) => Object.hasOwn(env.__env__, name) },
  };
}

/** Bind `cap`'s own `Vocabulary` onto `env` — the replacement for the retired
 *  `cap.lower({config}).apply(env, undefined as never)` idiom. */
async function applyOnto(env: ResolvingAmbient, cap: EnvCapability, config?: object): Promise<void> {
  const vocabulary = await buildVocabulary([cap], config, evalScheme);
  const writable = env as EnvWithInternals<ResolvingAmbient>;
  for (const [name, value] of vocabulary.map) writable.bind(name, value);
}

// ============================================================================
// LAW 1 + LAW 4 — throw paths stay throw (now reject) paths, unconditionally
// ============================================================================

describe("LAW 1 — required-and-absent config rejects at vocabulary build", () => {
  const requiredCap = () =>
    EnvCapability.define("test/degradation-required", {
      configuration: { must: z.string() },
      symbols: (symbol) => ({ stub: symbol.notImplemented`stub: unreachable — config validation throws first` }),
    });

  it("rejects — a genuinely required key is never mode-gated", async () => {
    const { env } = recordingEnv();
    await expect(applyOnto(env, requiredCap(), {})).rejects.toThrow();
  });

  it("missingOptionalKeys correctly EXCLUDES a bare z.custom() key (arrival/infer's shape) — structural, not behavioral", () => {
    // Mirrors arrival/infer's `configuration: { infer: z.custom<InferFn>() }` exactly: no
    // `.optional()` call. Verified: zod's OWN `.isOptional()` answers `true` for this shape
    // regardless (a permissive-validator artifact, not a declared-optional fact) — this
    // module's structural check must NOT be fooled by that into treating a required-looking
    // key as degradable.
    const shape = { infer: z.custom<() => unknown>() };
    expect(shape.infer.isOptional()).toBe(true); // the zod quirk, pinned so a zod upgrade that changes it is caught here
    expect(missingOptionalKeys(shape, {})).toEqual([]); // NOT reported — this module isn't fooled
  });
});

describe("LAW 4 — present-but-invalid config rejects (degradation only narrows ABSENCE)", () => {
  // Widened to `EnvCapability<any, any>` (the same declared-type idiom
  // `@inhuman.tools/arrival-modules` uses) so the WRONG-SHAPED config this
  // test deliberately supplies type-checks without a cast — the runtime `schema.parse`
  // rejection is the thing under test, not TS's own config-shape guard.
  const invalidCap = (): EnvCapability<any, any> =>
    EnvCapability.define("test/degradation-invalid", {
      configuration: { n: z.number() },
      symbols: (symbol) => ({ stub: symbol.notImplemented`stub: unreachable — config validation throws first` }),
    });

  it("rejects", async () => {
    const { env } = recordingEnv();
    await expect(applyOnto(env, invalidCap(), { n: "not-a-number" })).rejects.toThrow();
  });
});

// ============================================================================
// LAW 2 + LAW 3 — the degradation mechanism itself
// ============================================================================

/** A small fixture with ONE optional-enabling key, mirroring `arrival/loader`'s `fs` shape
 *  (a real predicate + `.optional()`) closely enough to exercise the mechanism without
 *  depending on the (downstream, cross-package) real loader capability. The verb declares
 *  `requiresConfig: ["fs"]` — the auto-door path, the ONE way an absent key gates a verb. */
function fixtureCapability(name: string): EnvCapability<any, any> {
  return EnvCapability.define(name, {
    configuration: {
      fs: z
        .custom<{
          readFile: (p: string) => Promise<string>;
        }>(
          (v): v is { readFile: (p: string) => Promise<string> } =>
            v !== null && typeof v === "object" && typeof (v as { readFile?: unknown }).readFile === "function",
          "fs must expose readFile(path)",
        )
        .optional(),
    },
    symbols: (symbol) => ({
      "fixture/verb": symbol.native`fixture/verb: reads via the fs`(
        { input: [], output: [sz.schemeValue], requiresConfig: ["fs"] },
        () => nil,
      ),
    }),
  });
}

describe("LAW 2 — an absent optional-enabling key lowers to a cause-carrying door", () => {
  it("the auto-door binds all the same — requiresConfig is not mode-gated", async () => {
    const { env, bound } = recordingEnv();
    await applyOnto(env, fixtureCapability("test/degradation-fixture-forbid"), {});
    expect(bound.get("fixture/verb")).toBeInstanceOf(DoorProcedure);
  });

  it("the symbol BINDS as a door whose firing message teaches 'provide fs to enable it'", async () => {
    const { env, bound } = recordingEnv();
    await applyOnto(env, fixtureCapability("test/degradation-fixture-doors"), {});
    const proc = bound.get("fixture/verb");
    expect(proc).toBeInstanceOf(DoorProcedure);
    let caught: unknown;
    try {
      (proc as DoorProcedure)["arrival/tagless-final/apply"]();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PurityError);
    const err = caught as PurityError;
    expect(err.message).toBe(
      "fixture/verb @ test/degradation-fixture-doors is not available.\n  Why: requires configuration `fs` — provide it to enable this verb. (reads via the fs)",
    );
    expect(err.owner).toBe("test/degradation-fixture-doors");
  });

  it("a SATISFIED config binds the real verb, not a door", async () => {
    const { env, bound } = recordingEnv();
    await applyOnto(env, fixtureCapability("test/degradation-fixture-satisfied"), {
      fs: { readFile: async () => "" },
    });
    expect(bound.get("fixture/verb")).not.toBeInstanceOf(DoorProcedure);
  });
});

describe("LAW 3 — Vocabulary.degraded enumerates every degraded capability", () => {
  it("enumerates the auto-door's misses", async () => {
    const cap = fixtureCapability("test/degradation-assembled-forbid");
    const vocabulary = await buildVocabulary([cap], {}, evalScheme);
    expect(vocabulary.degraded).toEqual([
      { capability: "test/degradation-assembled-forbid", needs: [{ kind: "configuration", key: "fs" }] },
    ]);
  });

  it("stays empty when the config is satisfied (nothing degraded)", async () => {
    const cap = fixtureCapability("test/degradation-assembled-satisfied");
    const vocabulary = await buildVocabulary([cap], { fs: { readFile: async () => "" } }, evalScheme);
    expect(vocabulary.degraded).toEqual([]);
  });
});

// ============================================================================
// LAW 5 — the causal chain end-to-end, and typo-suggestibility
// ============================================================================

describe("LAW 5 — a degradation-minted door is bound (typo-suggestible) and carries the full causal chain", () => {
  it("appears in allBoundNames() — the exact vocabulary suggestFromVocabulary's callers feed it (unbound-variable.ts)", async () => {
    const { env, bound } = recordingEnv();
    await applyOnto(env, fixtureCapability("test/degradation-suggestible"), {});
    expect(env.allBoundNames()).toContain("fixture/verb");
    expect(bound.get("fixture/verb")).toBeInstanceOf(DoorProcedure);
  });

  it("reference → door → owner → missing key: the whole chain reads off the bound value", async () => {
    const { env, bound } = recordingEnv();
    await applyOnto(env, fixtureCapability("test/degradation-causal-chain"), {});
    // "reference": a lookup by name, exactly what a program's free-variable reference resolves to.
    const referenced = env.get("fixture/verb");
    expect(referenced).toBe(bound.get("fixture/verb"));
    // "door": the introspectable DoorSymbolDef.
    const door = (referenced as DoorProcedure).door;
    expect(door.kind).toBe("door");
    // "owner": the capability that minted it.
    expect(door.cause?.owner).toBe("test/degradation-causal-chain");
    // "missing key": the configuration entry that would satisfy it.
    expect(door.cause?.needs).toEqual([{ kind: "configuration", key: "fs" }]);
  });
});
