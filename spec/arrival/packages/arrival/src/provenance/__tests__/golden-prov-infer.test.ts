/**
 * GOLDEN CAPTURE (gate G2 oracle) — INFER / Rosetta-IN source provenance:
 * minted-at-the-membrane, then piped / merged / field-projected.
 *
 * Wave R / RED-SPEC for the static-lineage migration
 * (the confluent dataflow-graph IR design (2026-06-17) §5, build-step
 * "wire the classifier into the runtime"). The `--ir-lineage` flag does NOT exist
 * yet, so the CURRENT eager engine IS the golden oracle: we run real programs and
 * snapshot the provenance they produce TODAY. When the static path lands, gate G2
 * requires `provenance(static, flag-on) == provenance(eager, flag-off)` — these
 * snapshots are the flag-off half it must reproduce byte-for-byte.
 *
 * The unit under capture is the SOURCE end of the lineage: a Rosetta-IN crossing
 * (`infer`-shaped) is where provenance is BORN (the classifier's `source` node;
 * design §5 "minted only at Rosetta crossings"). A deterministic FAKE source is
 * registered via `symbol.rosetta` — its fn ignores its arg and returns an
 * already-stamped value (a fixed mint id), so the capture is reproducible without
 * a live model. (This is the same rosetta-fixture pattern as
 * rosetta-pure-marker.test.ts / lineage-assumptions.test.ts rosetta "boom" fixture,
 * with the fn returning a STAMPED value so the mint id is observable.)
 *
 * Why a stamped return value is the faithful stand-in: a registered rosetta defaults
 * to a Rosetta-IN SOURCE (rosetta.ts `pure` doc) — its result mints a fresh leaf. The
 * real membrane mints a provenance POINT (`{ inv.id }`) via `ctx.currentInvocation`
 * when called through the trace tap (baked `symbol.rosetta` / host-fn lens); a direct
 * `exec` has no invocation, so the wrapper falls back to the inputs' provenance
 * (EMPTY for a literal arg). Returning a STAMPED AValue makes the same "fresh single
 * id at the boundary" observable deterministically: a single-id mint, propagated by
 * pure ops, unioned across two sources, narrowed by a field projection. The id
 * *value* is a fixed stand-in for "whatever the membrane minted"; the SHAPE (single
 * point in / single point out, two points merge, projection narrows) is the invariant.
 *
 * Four shapes pinned (design §5 + the source-id half of gate G7 — per-source identity
 * survives into the result):
 *   - single mint:        (infer-x …)                       → one point (the leaf is born)
 *   - pure pipe over it:  (string-upcase (infer-x …))       → SAME point (pure op mints nothing)
 *   - merge of two:       (string-append (infer-x …) (infer-y …)) → both points fan in
 *   - field projection:   (:field (infer-dict …))           → the projected field's point ALONE
 *                          (the dict carries two per-field ids; projecting one NARROWS
 *                          to it — "field-projection refining a point", design §5.3 A).
 *
 * Shared provenance helpers (provOf, sStr, runRaw) are imported — provOf from the
 * canonical production shadow module, sStr/runRaw from the test-helper module — so
 * there is ONE definition of each across the suite. The file-SPECIFIC part is the
 * `inferSources` setup (the deterministic rosetta fixtures), passed to the
 * shared `runRaw` via its setup hook; the `prov`/`value` wrappers stay local.
 */
import { describe, it, expect } from "vitest";
import { AValue } from "../../values/primitives/AValue.js";
import { provOf } from "../../provenance/lineage.js";
import { sStr, runRaw, type EnvSetup } from "../../__tests__/_lineage-test-helpers.js";
import { EnvCapability } from "../../common/capability.js";
import { applyCapability } from "../../__tests__/_fresh-env.js";
import { jsToScheme } from "../../membrane/rosetta.js";
import { CONSTANT_CTX } from "../../run/RunContext.js";

// Fixed mint ids — stand-ins for "whatever the membrane minted at this crossing".
// The SHAPE of how they flow (born / propagate / merge / narrow) is the invariant;
// the id values are arbitrary-but-deterministic so the snapshots are reproducible.
const MINT_X = 500; // infer-x's minted leaf
const MINT_Y = 600; // infer-y's minted leaf
const FIELD_ID = 700; // infer-dict's `field` slot id
const OTHER_ID = 701; // infer-dict's `other` slot id (must be PRUNED by the projection)

// Register deterministic fake sources on the run env via a test-local
// `EnvCapability`. Each fake source IGNORES its argument and returns an
// already-stamped value: this is
// the "data is born at the membrane" behavior — the result's provenance is the mint,
// independent of the (literal) input. Mirrors lineage-assumptions.test.ts's own
// capability-authored fixtures (`_lineage-test-helpers.ts`).
//
// WORLD-FLIP REBASELINE (ruling 2026-08-13): these fixtures used to be `symbol.rosetta`
// + `output: [z.dynamic]` ("impl returns raw, does its own conversion") so the pre-
// stamped return rode `jsToScheme`'s AValue identity claim untouched. A rosetta impl's
// return is now a JS-world value — an AValue there doors (`WorldFlipError`). A fake
// source that mints its OWN stamps genuinely works over scheme values, which is exactly
// the native contour: `z.schemeValue` slots, no membrane, no auto-mint — the custom
// stamp survives by construction, and the declared `"source"` role keeps the lineage
// classifier reading it as a source (the rosetta default it used to inherit).
const inferSources: EnvSetup = async (env) => {
  const cap = EnvCapability.define("test/infer-sources", {
    symbols: (symbol, z) => ({
      // infer-x / infer-y: scalar sources, each minting a single fixed leaf.
      "infer-x": symbol.native`infer-x: fake scalar source (X)`(
        { input: [z.schemeValue], output: [z.schemeValue], provenance: "source" },
        () => sStr("RESULT-X", MINT_X),
      ),
      "infer-y": symbol.native`infer-y: fake scalar source (Y)`(
        { input: [z.schemeValue], output: [z.schemeValue], provenance: "source" },
        () => sStr("RESULT-Y", MINT_Y),
      ),
      // infer-dict: a structured source whose fields carry DISTINCT per-field ids, so a
      // field projection has something to narrow FROM (two ids) TO (one id). The raw
      // `{ field, other }` object isn't itself a `SchemeValue` — a native may construct
      // scheme values, so `jsToScheme(CONSTANT_CTX, …)` at its default EMPTY provenance
      // borrows it as an AJSObject WITHOUT touching the already-stamped field values (a
      // shallow, lazy-entries wrap).
      "infer-dict": symbol.native`infer-dict: fake structured source`(
        { input: [z.schemeValue], output: [z.schemeValue], provenance: "source" },
        () => jsToScheme(CONSTANT_CTX, { field: sStr("FV", FIELD_ID), other: sStr("OV", OTHER_ID) }) as never,
      ),
    }),
  });
  await applyCapability(env, [cap]);
};

// provenance of the result (the infer sources are registered via the setup hook)
async function prov(src: string, binds: Record<string, unknown> = {}): Promise<number[]> {
  return provOf(await runRaw(src, binds, inferSources));
}

// the runtime value, unwrapped to plain JS (pinned alongside the cone so a rewrite
// that changes the VALUE — not just the provenance — is also caught).
async function value(src: string, binds: Record<string, unknown> = {}): Promise<unknown> {
  const r = await runRaw(src, binds, inferSources);
  return r instanceof AValue ? r["arrival/toJS"]() : r;
}

// ============================================================================
// GOLDEN — runnable NOW. These go GREEN and become the gate-G2 equivalence
// oracle. `flag-off` (today's eager engine) MUST stay byte-identical to these.
// ============================================================================

describe("GOLDEN (G2 oracle) — a single Rosetta-IN crossing MINTS one leaf", () => {
  it("(infer-x …): the result carries exactly the minted point — provenance is BORN here", async () => {
    // The literal argument contributes nothing; the source introduces the data, so
    // the provenance is the mint alone. This is the classifier's `source` node.
    expect({
      value: await value(`(infer-x "ignored-prompt")`),
      prov: await prov(`(infer-x "ignored-prompt")`),
    }).toMatchInlineSnapshot(`
        {
          "prov": [
            500,
          ],
          "value": "RESULT-X",
        }
      `);
  });
});

describe("GOLDEN (G2 oracle) — a pure pipe over the source PROPAGATES, never re-mints", () => {
  it("(string-upcase (infer-x …)): same single point as the bare mint — the pipe adds nothing", async () => {
    // string-upcase is a pure transform → the classifier's `pipe` node. The cone is
    // unchanged from the bare mint: a pure op can forget to PROPAGATE (empty set),
    // never to CARRY a new id (AValue.ts on-value provenance rationale).
    expect({
      value: await value(`(string-upcase (infer-x "p"))`),
      prov: await prov(`(string-upcase (infer-x "p"))`),
    }).toMatchInlineSnapshot(`
        {
          "prov": [
            500,
          ],
          "value": "RESULT-X",
        }
      `);
  });

  it('(string-append "pre-" (infer-x …)): the literal prefix contributes no id — still the single mint', async () => {
    // One prov-bearing operand (the infer-x source) + a literal → still a PIPE, not a
    // merge: the literal is not a source (lineage-spike.test.ts pure-predicate case).
    expect({
      value: await value(`(string-append "pre-" (infer-x "p"))`),
      prov: await prov(`(string-append "pre-" (infer-x "p"))`),
    }).toMatchInlineSnapshot(`
        {
          "prov": [
            500,
          ],
          "value": "pre-RESULT-X",
        }
      `);
  });
});

describe("GOLDEN (G2 oracle) — a MERGE of two infer sources fans both points in", () => {
  it("(string-append (infer-x …) (infer-y …)): the cone is the UNION of both mints", async () => {
    // Two provenance-bearing operands → the classifier's `merge` node. The result
    // depends on both crossings, so both minted ids are carried (set-union, sorted).
    expect({
      value: await value(`(string-append (infer-x "a") (infer-y "b"))`),
      prov: await prov(`(string-append (infer-x "a") (infer-y "b"))`),
    }).toMatchInlineSnapshot(`
        {
          "prov": [
            500,
            600,
          ],
          "value": "RESULT-XRESULT-Y",
        }
      `);
  });
});

describe("GOLDEN (G2 oracle) — a FIELD PROJECTION refines a point (narrows the cone)", () => {
  it("(:field (infer-dict …)): only the PROJECTED field's id survives — the sibling field is pruned", async () => {
    // infer-dict mints a structured value whose fields carry distinct ids (field=700,
    // other=701). Projecting `field` via the `:field` keyword accessor lands
    // element-only provenance (rosetta.ts jsToScheme deep-stamp + the car/cdr
    // "element-only" rule) → the cone NARROWS to just 700. This is "field-projection
    // refining a point" (design §5.3 Interp. A): the keyword accessor is faithful — it
    // carries the projected slot's origin and drops the rest. The same shape backs the
    // static classifier's pipe-over-source. NB: `:field` is ONE keyword token — a
    // spaced `(: field …)` reads `field` as a free variable (Unbound variable).
    expect({
      value: await value(`(:field (infer-dict "p"))`),
      prov: await prov(`(:field (infer-dict "p"))`),
    }).toMatchInlineSnapshot(`
        {
          "prov": [
            700,
          ],
          "value": "FV",
        }
      `);
  });

  it('(@ (infer-dict …) "field"): the @ member-read narrows identically to the keyword accessor', async () => {
    // The polyglot member-read `@` and the `:keyword` accessor are ONE member-read
    // over a dict (per the project's polyglot/membrane note); both must narrow the
    // cone to the projected field's id. Pinned so a rewrite can't diverge the two.
    expect({
      value: await value(`(@ (infer-dict "p") "field")`),
      prov: await prov(`(@ (infer-dict "p") "field")`),
    }).toMatchInlineSnapshot(`
        {
          "prov": [
            700,
          ],
          "value": "FV",
        }
      `);
  });
});

// ============================================================================
// GATE G2 TARGET — the STATIC path is unbuilt (no --ir-lineage flag yet), so
// these are it.todo. They pin the intent the eager golden above must converge
// to once the classifier is wired in. They are NOT runnable today and must NOT
// be made green by relaxing them.
// ============================================================================

describe("GATE G2 TARGET (static path, --ir-lineage on) — the source end matches the eager golden", () => {
  // The migration's hard equivalence promise at the SOURCE end: with the flag OFF the
  // new path must reproduce the snapshots above EXACTLY; with it ON, the static
  // `source`/`pipe`/`merge` lineage nodes must compute the SAME cones the eager engine
  // does here (a mint is one point, a pure pipe is identity on the cone, a merge is the
  // union, a field projection narrows to the projected slot). The classifier already
  // MODELS this (lineage-spike.test.ts `(infer p)` → source; `(* val1 (+ 1 val2))` →
  // merge/pipe); these todos pin that the WIRED runtime reproduces it over real infer
  // crossings, not only over the hand-classified AST.
  it.todo("(infer-x …) static cone == eager golden — a Rosetta-IN crossing mints exactly one point");
  it.todo("(string-upcase (infer-x …)) static cone == the bare mint — pure pipe is identity on the cone");
  it.todo("(string-append (infer-x …) (infer-y …)) static cone == union of both mints — the merge fans in");
  it.todo("(:field (infer-dict …)) static cone == the projected slot's id ALONE — projection narrows");
  it.todo("provenance(flag-off) on every program above == the eager golden snapshot, byte-for-byte");
});
