/**
 * resolution-chain.law.test.ts — laws for the SEALED ambient artifact (ENV T2 of
 * the environment-resolution-chain design §§1–2).
 *
 * Stage-0 dead-code removal note: the capability-facing `ResolverSpec`/
 * `EnvCapability.resolvers` contract (and `CompiledResolutionChain`'s resolver-
 * interleaving machinery it justified) was retired — an audit established it had ZERO
 * live users, and the sealed chain already degenerated to the flat-Map form on every
 * real assembly (no pack ever declared `spec.resolvers`, and the kernel's own
 * `preludeOnly` bake-overlay resolver always unregisters before `assembleEnv` resolves,
 * strictly before any seal). `CompiledResolutionChain` is now UNCONDITIONALLY the
 * flat-map form; the former LAW 1 (precedence preservation across interleaved resolver
 * steps), LAW 3 (resolver memo/negative-cache soundness), and the resolver-identity arm
 * of LAW 4 tested machinery that no longer exists and are removed. `AmbientRuntime`'s
 * live resolver PRIMITIVE (`registerResolver`/`unregisterResolver`/the
 * `_lookupWithResolvers` resolver leg) is UNCHANGED and still exercised — it remains the
 * kernel's bake-overlay plumbing (`module-composition.spec.ts` is its live-walk test
 * floor).
 *
 * LAW 2 (merge-at-seal): resolver-free layers merge child-wins into ONE flat map — the
 *   bootstrapped in-repo base is this DEGENERATE (now the ONLY) form.
 * LAW 4 (content address): deterministic per topology, sensitive to vocabulary. Value
 *   hashing is deferred (design open question 1).
 * LAW 5 (bake-seal residue): assembly leaves NO resolver registered on the base — the
 *   `preludeOnly` overlay is bake-scoped and dropped at seal — and `compileResolutionChain`
 *   asserts that invariant rather than silently dropping a resolver it can no longer
 *   represent.
 */
import { describe, expect, it } from "vitest";
import { isAmbientRuntime, AmbientRuntime, ResolvingAmbient, type EnvWithInternals } from "../../env/AmbientRuntime.js";
import { compileResolutionChain, sealResolutionChain } from "../../eval/CompiledResolutionChain.js";
import { execInFrame } from "../../eval/generator-exec.js";
import { buildVocabulary } from "../../env/vocabulary.js";
import { BASE_ROSTER } from "../../env/base-roster.js";
import { AExact } from "../../values/primitives/AExact.js";

const boxed = (n: number) => new AExact(n);

describe("CompiledResolutionChain — LAW 2: merge-at-seal", () => {
  it("resolver-free layers merge child-wins into ONE flat map", () => {
    const root = AmbientRuntime.root("root", { a: boxed(1), shadowed: boxed(100) });
    const mid = root.child("mid", { b: boxed(2), shadowed: boxed(200) });
    const leaf = mid.child("leaf", { c: boxed(3), shadowed: boxed(300) });

    const chain = compileResolutionChain(leaf);
    expect(chain.steps).toHaveLength(1);
    expect(chain.steps[0]).toBeInstanceOf(Map);
    expect(chain.lookup("a")).toEqual(boxed(1));
    expect(chain.lookup("b")).toEqual(boxed(2));
    expect(chain.lookup("c")).toEqual(boxed(3));
    expect(chain.lookup("shadowed")).toEqual(boxed(300)); // child wins
    expect(chain.names.has("a")).toBe(true);
    expect(chain.names.has("shadowed")).toBe(true);
    expect(chain.names.has("nope")).toBe(false);
  });

  it("THE IN-REPO REALITY: the self-hosted BASE_ROSTER vocabulary compiles to the degenerate ONE-flat-Map form", async () => {
    // STAGE C CUT 3b: the realm bootstrap (`ensureBaseAssembled`/`user_env`/`global_env`) is
    // retired along with the ambient path entirely — a bare `exec("1")` rides the self-hosted
    // vocabulary path exclusively now. Re-pinned here over the SAME shape `generator-exec.ts`'s
    // own `execState` builds: a null-rooted scratch frame flat-bound from the memoized
    // `Vocabulary.map`, then sealed — see that module's `sealedVocabularyChain`.
    const evalScheme = (env: unknown, source: string): Promise<unknown[]> => {
      if (!isAmbientRuntime(env)) throw new Error("expected a concrete AmbientRuntime");
      return execInFrame(source, env);
    };
    const vocabulary = await buildVocabulary(BASE_ROSTER, undefined, evalScheme);
    const chainFrame = ResolvingAmbient.root("resolution-chain-law-vocabulary") as EnvWithInternals<ResolvingAmbient>;
    for (const [name, value] of vocabulary.map) chainFrame.bind(name, value);

    // Zero live resolvers: no pack declares `spec.resolvers` (the contract is retired),
    // and the kernel's preludeOnly overlay was dropped at seal (LAW 5).
    expect(chainFrame.resolverSpecs()).toHaveLength(0);

    const chain = sealResolutionChain(chainFrame);
    expect(chain.steps).toHaveLength(1);
    expect(chain.steps[0]).toBeInstanceOf(Map);
    // The merged vocabulary spans the whole self-hosted base: a native, a .scm define.
    expect(chain.lookup("+")).toBeDefined();
    expect(chain.lookup("cons")).toBeDefined();
    expect(chain.lookup("definitely-not-bound-xyz")).toBeUndefined();

    // ONE artifact per baked base — the seal registry memoizes.
    expect(sealResolutionChain(chainFrame)).toBe(chain);
  });
});

describe("CompiledResolutionChain — LAW 4: content address", () => {
  it("deterministic per topology, sensitive to vocabulary", () => {
    const build = () => {
      const root = AmbientRuntime.root("root", { a: boxed(1) });
      return root.child("leaf", { b: boxed(2) });
    };
    const h1 = compileResolutionChain(build()).hash;
    const h2 = compileResolutionChain(build()).hash;
    expect(h2).toBe(h1); // deterministic composition (realm-independent)

    const widened = build() as EnvWithInternals<ResolvingAmbient>;
    widened.bind("c", boxed(3));
    expect(compileResolutionChain(widened).hash).not.toBe(h1); // vocabulary-sensitive
  });
});

describe("CompiledResolutionChain — LAW 5: the bake seal leaves zero resolver residue", () => {
  // STAGE C CUT 4 (docs/plans/stage-c-corpse-deletion.md) retired `assembleEnv` — the kernel's
  // OWN bake-scoped `preludeOnly` resolver overlay (`ctx.preludeScope` auto-registering a
  // resolver on the base, dropped at seal) this row proved was THAT mechanism's own plumbing,
  // and it died with `assembleEnv` itself. Bootstrap's `preludeOnly` routing lives in
  // `env/vocabulary.ts` now (a plain, disjoint `Vocabulary.preludeOnly` Map — no resolver
  // registration on any base at all; see `capability-prelude-only-symbol.test.ts`), and the
  // per-run prelude pass (`env/assemble-run.ts`) mirrors both maps onto a discarded per-run
  // frame, again with no resolver involved. The row this LAW is actually about —
  // `compileResolutionChain` refusing a base with a live registered resolver — is
  // mechanism-agnostic and survives below unchanged.
  it("compileResolutionChain refuses to compile a base with a LIVE registered resolver — the sealed chain has no representation for one anymore", () => {
    const base = ResolvingAmbient.root("still-registered");
    base.registerResolver({ id: "leftover", resolve: () => undefined });
    expect(() => compileResolutionChain(base)).toThrow(/live resolver/);
  });
});
