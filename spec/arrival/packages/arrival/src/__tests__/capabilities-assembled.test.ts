/**
 * Ejection P3 3b.3 — witness for the ASSEMBLED capability base.
 *
 * `new Capabilities(base, sealResolutionChain(base))` wraps ANY base-linked frame in its
 * ASSEMBLED (sealed) mode — the invariant it pins (and that the hygiene engine relies on at
 * `syntax-rules.ts`: `ref === capabilities.globalRoot`): a name OWNED ANYWHERE in the base
 * chain resolves, through `refFrame`, back to the SAME stable `globalRoot` sentinel.
 *
 * STAGE C CUT 3b (docs/plans/stage-c-corpse-deletion.md) retired the realm-singleton
 * `user_env`/`global_env` this file originally pinned the invariant against — re-pinned here
 * over a locally-built two-frame chain (root + child), the same SHAPE `user_env → global_env`
 * had, so the sentinel-stability claim survives unchanged. TRAILS CLEANUP (Tier 1) then retired
 * the `Capabilities.assembled(base)` convenience static itself (test-only + one unexecutable
 * bench, zero production callers) — this suite now mints the sealed chain and constructs
 * `Capabilities` directly, which is exactly what the static used to do.
 *
 * ENV T3 RESTATEMENT (environment-resolution-chain.md §2 "hygiene sentinel", Frame/
 * BakedBase type split, LANDED): the sentinel is the sealed `CompiledResolutionChain`
 * (BakedBase) itself, `sealResolutionChain(base)`'s ONE memoized artifact for this base — not
 * the base-leaf ENV. The uniqueness guarantee this test pins: one identity per baked base —
 * every base-owned name's `refFrame` resolves to the SAME `globalRoot`.
 */
import { describe, expect, it } from "vitest";
import { AmbientRuntime, type EnvWithInternals, type ResolvingAmbient } from "../env/AmbientRuntime.js";
import { AExact } from "../values/primitives/AExact.js";
import { Capabilities } from "../eval/Capabilities.js";
import { sealResolutionChain } from "../eval/CompiledResolutionChain.js";

describe("Capabilities (3b.3 — assembled base sentinel)", () => {
  it("refFrame of any base-owned builtin === globalRoot (the stable sentinel)", async () => {
    // A two-frame chain (root + child) mirroring the retired `user_env → global_env` shape:
    // one name owned on the ROOT, one owned on the CHILD (the base's own top, where the
    // sealed chain is built).
    const root = AmbientRuntime.root("test-capabilities-root") as EnvWithInternals<ResolvingAmbient>;
    root.bind("root-builtin", new AExact(1));
    const base = root.child("test-capabilities-base") as EnvWithInternals<ResolvingAmbient>;
    base.bind("leaf-builtin", new AExact(2));

    const chain = sealResolutionChain(base);
    const caps = new Capabilities(base, chain);
    // globalRoot is the stable base sentinel — ENV T3: the SEALED CHAIN artifact
    // (BakedBase), not the raw base-leaf env. `sealResolutionChain` is memoized per base,
    // so this is the SAME object minted above.
    expect(caps.globalRoot).toBe(chain);

    // refFrame probes the WHOLE base chain and points every base-owned name back to that
    // single sentinel — a name owned on the base LEAF (`base` itself) resolves:
    expect(base.has("leaf-builtin")).toBe(true);
    expect(caps.refFrame("leaf-builtin")).toBe(caps.globalRoot);

    expect(caps.refFrame("root-builtin")).toBe(caps.globalRoot);

    expect(caps.refFrame("definitely-not-a-builtin-xyz-123")).toBeUndefined();
  });
});
