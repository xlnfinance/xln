/**
 * Q8b — the TEMPLATE STORE (docs/PROVENANCE.md §5 C4). `TemplateStoreFake` (`../fakes.js`) is the
 * fake-backed interface Q8b lands: put/get a template's graph by hash, plus the
 * reverse index — "records key on template-hash + ordinal-path, the plane keys on
 * site-hash... the template-store interface must expose ordinal-path → site-hash
 * resolution (a DERIVABLE index, not new stored state)."
 *
 * "Derivable, not new stored state" is exercised here as: every `siteHash` this test
 * registers is computed by `wireframe/hash.ts`'s `siteHash(templateHash, site)` — a
 * PURE function of the template's own hash plus a span — never invented ad hoc; the
 * store only remembers what a caller (standing in for the wireframe builder, which
 * still holds live spans before `hashGraph` strips them) already derived.
 */
import { describe, expect, it, beforeAll } from "vitest";
import { parse } from "../../../eval/generator-exec.js";
import { inferenceEnv } from "../../../env/inference-env.js";
import type { Classifier, DeclaredRole } from "../../lineage.js";
import { buildWireframe } from "../../wireframe/builder.js";
import { hashGraph, siteHash, siteOf, MAIN_PROGRAM_SITE } from "../../wireframe/hash.js";
import type { WireframeProgram } from "../../wireframe/types.js";
import { appendOrdinal, ROOT_ORDINAL_PATH } from "../ids.js";
import { TemplateNotFound, TemplateStoreFake } from "../fakes.js";

const ROLES: Record<string, DeclaredRole> = { "src-a": "source", map: "fan" };
const CLASSIFIER: Classifier = { roleOf: (op) => ROLES[op] };
const isBaseName = (n: string): boolean => n === "+";

async function wf(code: string): Promise<WireframeProgram> {
  const forms = await parse(code);
  return buildWireframe(forms, { classifier: CLASSIFIER, isBaseName });
}

beforeAll(async () => {});

describe("TemplateStoreFake — put/get round-trip (§5 C4)", () => {
  it("putTemplate then getTemplate returns the SAME graph, keyed by its own hash", async () => {
    const store = new TemplateStoreFake();
    const p = await wf("(map (lambda (v) (src-a v)) xs)");
    const fan = p.main.nodes.find((n) => n.kind === "fan");
    if (fan?.kind !== "fan" || !fan.template) throw new Error("expected a fan template");
    const hash = hashGraph(fan.template);

    await store.putTemplate({ templateHash: hash, graph: fan.template });
    const got = await store.getTemplate(hash);
    expect(got).toBe(fan.template); // same object identity — the fake is a plain Map
  });

  it("re-putting the SAME hash is an idempotent upsert, never a duplicate entry", async () => {
    const store = new TemplateStoreFake();
    const p = await wf("(src-a)");
    const hash = hashGraph(p.main);
    await store.putTemplate({ templateHash: hash, graph: p.main });
    await store.putTemplate({ templateHash: hash, graph: p.main });
    expect(await store.getTemplate(hash)).toBe(p.main);
  });

  it("getTemplate on a hash never put throws TemplateNotFound — never fabricates a miss", async () => {
    const store = new TemplateStoreFake();
    await expect(store.getTemplate("never-put")).rejects.toBeInstanceOf(TemplateNotFound);
  });
});

describe("registerSite / resolveSite — the Q8b AMENDMENT reverse index (ordinal-path → site-hash)", () => {
  it("resolves a registered (templateHash, ordinalPath) coordinate back to its siteHash", async () => {
    const store = new TemplateStoreFake();
    const p = await wf("(src-a)");
    const hash = hashGraph(p.main);
    const path = ROOT_ORDINAL_PATH; // main has one static instantiation
    const site = siteHash(hash, MAIN_PROGRAM_SITE);

    await store.registerSite(hash, path, site);
    expect(await store.resolveSite(hash, path)).toBe(site);
  });

  it("ONE templateHash shared by TWO sites (dedup) resolves to TWO DIFFERENT siteHashes, disambiguated by ordinalPath — exactly the amendment's motivating scenario", async () => {
    const store = new TemplateStoreFake();
    // Two `map` call sites whose callback bodies are structurally identical — dedup
    // to ONE templateHash (proven directly, mirroring wireframe-hash.test.ts's row).
    const p = await wf("(list (map (lambda (v) (src-a v)) xs) (map (lambda (v) (src-a v)) ys))");
    const fans = p.main.nodes.filter((n) => n.kind === "fan");
    expect(fans).toHaveLength(2);
    const [fanA, fanB] = fans;
    if (fanA.kind !== "fan" || fanB.kind !== "fan" || !fanA.template || !fanB.template) {
      throw new Error("expected both fans to carry a private template");
    }
    const hash = hashGraph(fanA.template);
    expect(hashGraph(fanB.template)).toBe(hash); // the dedup precondition

    await store.putTemplate({ templateHash: hash, graph: fanA.template });

    // Each SITE gets its own ordinal path (root-binder ordinal of the fan node itself,
    // per `wireframe/hash.ts`'s `rootOrdinalPath`) and its own siteHash (span-bearing).
    const fanIndexA = p.main.nodes.indexOf(fanA);
    const fanIndexB = p.main.nodes.indexOf(fanB);
    const pathA = appendOrdinal(ROOT_ORDINAL_PATH, fanIndexA);
    const pathB = appendOrdinal(ROOT_ORDINAL_PATH, fanIndexB);
    const siteA = siteHash(hash, siteOf(fanA));
    const siteB = siteHash(hash, siteOf(fanB));
    expect(siteA).not.toBe(siteB);

    await store.registerSite(hash, pathA, siteA);
    await store.registerSite(hash, pathB, siteB);

    expect(await store.resolveSite(hash, pathA)).toBe(siteA);
    expect(await store.resolveSite(hash, pathB)).toBe(siteB);
    // The reverse index disambiguates PURELY by ordinalPath — the same templateHash,
    // two different paths, two different answers.
    expect(await store.resolveSite(hash, pathA)).not.toBe(await store.resolveSite(hash, pathB));
  });

  it("an unregistered (templateHash, ordinalPath) coordinate resolves to undefined — never a fabricated site", async () => {
    const store = new TemplateStoreFake();
    const p = await wf("(src-a)");
    const hash = hashGraph(p.main);
    expect(await store.resolveSite(hash, ROOT_ORDINAL_PATH)).toBeUndefined();
  });

  it("registering a DIFFERENT site under an already-registered (hash, path) pair overwrites — last-registered wins, per the interface's upsert contract", async () => {
    const store = new TemplateStoreFake();
    const p = await wf("(src-a)");
    const hash = hashGraph(p.main);
    const path = ROOT_ORDINAL_PATH;
    await store.registerSite(hash, path, "site-1");
    await store.registerSite(hash, path, "site-2");
    expect(await store.resolveSite(hash, path)).toBe("site-2");
  });
});
