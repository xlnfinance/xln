import { CONSTANT_CTX } from "../../run/RunContext.js";
/**
 * GOLDEN CAPTURE (gate G2 oracle) — FAN-OUT provenance: map / filter / length.
 *
 * The `--ir-lineage` flag does NOT exist yet, so the CURRENT eager engine IS the
 * golden oracle: we run real programs and snapshot the provenance they produce.
 * When the static path lands, gate G2 requires
 * `provenance(static, flag-on) == provenance(eager, flag-off)` — these snapshots
 * are the flag-off half it must reproduce byte-for-byte.
 *
 *   (length (map id xs))    — a pure-map length depends only on the GROUPING fact
 *                             (the cardinality), not on what each element became.
 *                             `length` reads the container's own flat stamp; `map`
 *                             (length-preserving) PROXIES that stamp through
 *                             unchanged [GATE: G2].
 *   (length (filter p xs))  — filter RUNS the predicate `p`; the surviving
 *                             elements' provenance flows into the count. A filter
 *                             is length-CHANGING, so its own container stamp is
 *                             PROVENANCED fresh from the union of the input
 *                             container's stamp + the survivors' own provenance.
 *
 * The `it.todo` block pins the static G2 target the eager golden must converge to:
 *   - pure-map length cone  == grouping-fact-only (the source cardinality id), NOT
 *     every element id (the spike's countCone prunes the length-preserving fan).
 *   - filter length cone    INCLUDES the predicate's cone (filter is the
 *     length-changing fan countCone does NOT prune).
 */
import { describe, it, expect } from "vitest";
import { APair } from "../../values/primitives/APair.js";
import { AValue } from "../../values/primitives/AValue.js";
import { provOf } from "../../provenance/lineage.js";
import { sStr, runRaw } from "../../__tests__/_lineage-test-helpers.js";

// provenance of the result
async function prov(src: string, binds: Record<string, unknown> = {}): Promise<number[]> {
  return provOf(await runRaw(src, binds));
}

// the runtime value, unwrapped to plain JS (to pin the COUNT alongside its cone)
async function value(src: string, binds: Record<string, unknown> = {}): Promise<unknown> {
  const r = await runRaw(src, binds);
  return r instanceof AValue ? r["arrival/toJS"]() : r;
}

// a Pair-backed source of three provenance-stamped strings, ids 100/101/102.
const triple = () =>
  APair.fromArray(CONSTANT_CTX, [sStr("a", 100), sStr("b", 101), sStr("c", 102)], false) as unknown as AValue;

// ============================================================================
// GOLDEN — runnable NOW. These go GREEN and become the gate-G2 equivalence
// oracle. `flag-off` (today's eager engine) MUST stay byte-identical to these.
// ============================================================================

describe("GOLDEN (G2 oracle) — pure-map length over a Pair source: the A13 leak is CLOSED", () => {
  // `length` reads the CONTAINER's own flat grouping/length-fact stamp; `map`
  // PROXIES that stamp through unchanged. This fixture mints no container-level
  // grouping id, so the cone is EMPTY.
  it("(length (map id xs)): the count's cone is the MINIMAL grouping fact (empty), not every element id — the A13 leak is closed [GATE: G2]", async () => {
    expect({
      value: await value(`(length (map (lambda (e) e) xs))`, { xs: triple() }),
      prov: await prov(`(length (map (lambda (e) e) xs))`, { xs: triple() }),
    }).toEqual({
      value: 3,
      prov: [],
    });
  });

  it("(map id xs): the mapped LIST head's own provenance is EMPTY — element ids live on the elements", async () => {
    // FINDING (load-bearing for the static path): the fan result's SPINE carries
    // [] — the per-element provenance lives on the ELEMENTS, not the list head.
    // `length` over-attributes precisely because it must touch each element to
    // count it, unioning their ids into the scalar count. A static count-cone that
    // reads the SPINE (empty) instead of folding the elements is the structural
    // shape of the fix. Pinned so a rewrite that relocates ids onto the spine is
    // caught at the source, not only at the count.
    expect(await prov(`(map (lambda (e) e) xs)`, { xs: triple() })).toMatchInlineSnapshot(`[]`);
  });
});

describe("GOLDEN (G2 oracle) — filter RUNS the predicate; the count carries the survivors", () => {
  it('(length (filter pred xs)): pred drops "b"; count is 2, provenance is the survivors', async () => {
    // The predicate is pure (string=?), so it mints nothing of its own here; the
    // surviving elements (a=100, c=102) carry their provenance into the count.
    expect({
      value: await value(`(length (filter (lambda (e) (not (string=? e "b"))) xs))`, { xs: triple() }),
      prov: await prov(`(length (filter (lambda (e) (not (string=? e "b"))) xs))`, { xs: triple() }),
    }).toMatchInlineSnapshot(`
        {
          "prov": [
            100,
            102,
          ],
          "value": 2,
        }
      `);
  });

  it("(filter pred xs): the filtered LIST HEAD's own provenance now CARRIES the survivors' ids (C2/R2 fix)", async () => {
    // Filter is LENGTH-CHANGING: its head is PROVENANCED fresh from union(input
    // container stamp [empty here], survivors' own ids). `length` reads that head stamp.
    expect(await prov(`(filter (lambda (e) (not (string=? e "b"))) xs)`, { xs: triple() })).toMatchInlineSnapshot(`
      [
        100,
        102,
      ]
    `);
  });

  it("(length (filter pred xs)) keeping ALL: pred always true; count is 3, all ids carried", async () => {
    expect({
      value: await value(`(length (filter (lambda (e) #t) xs))`, { xs: triple() }),
      prov: await prov(`(length (filter (lambda (e) #t) xs))`, { xs: triple() }),
    }).toMatchInlineSnapshot(`
        {
          "prov": [
            100,
            101,
            102,
          ],
          "value": 3,
        }
      `);
  });

  it("(length (filter pred xs)) keeping NONE: pred always false; count is 0, empty provenance", async () => {
    // Nothing survives → the count cannot depend on any element. A degenerate
    // anchor for the filter cone: zero survivors ⇒ zero element ids.
    expect({
      value: await value(`(length (filter (lambda (e) #f) xs))`, { xs: triple() }),
      prov: await prov(`(length (filter (lambda (e) #f) xs))`, { xs: triple() }),
    }).toMatchInlineSnapshot(`
        {
          "prov": [],
          "value": 0,
        }
      `);
  });
});

describe("GOLDEN (G2 oracle) — NESTED fan: (length (map g (filter p xs)))", () => {
  it('filter drops "b", map is identity; count is 2, survivors\' provenance', async () => {
    // The nesting the spike's classify() can shape statically (fan-over-fan) but
    // never ran live. Eager golden: the inner filter's survivors flow out through
    // the outer map into the count.
    expect({
      value: await value(`(length (map (lambda (e) e) (filter (lambda (e) (not (string=? e "b"))) xs)))`, {
        xs: triple(),
      }),
      prov: await prov(`(length (map (lambda (e) e) (filter (lambda (e) (not (string=? e "b"))) xs)))`, {
        xs: triple(),
      }),
    }).toMatchInlineSnapshot(`
          {
            "prov": [
              100,
              102,
            ],
            "value": 2,
          }
        `);
  });

  it("nested all-pass: filter keeps all, map identity; count is 3, all ids", async () => {
    expect({
      value: await value(`(length (map (lambda (e) e) (filter (lambda (e) #t) xs)))`, { xs: triple() }),
      prov: await prov(`(length (map (lambda (e) e) (filter (lambda (e) #t) xs)))`, { xs: triple() }),
    }).toMatchInlineSnapshot(`
        {
          "prov": [
            100,
            101,
            102,
          ],
          "value": 3,
        }
      `);
  });
});

// ============================================================================
// GATE G2 TARGET — the STATIC path is unbuilt (no --ir-lineage flag yet), so
// these are it.todo. They pin the intent the eager golden above must converge
// to once the classifier is wired in and the count-cone prunes length-preserving
// fans. They are NOT runnable today and must NOT be made green by relaxing them.
// ============================================================================

describe("GATE G2 TARGET (static path, --ir-lineage on) — pure-map length cone is grouping-fact-only", () => {
  // The spike already models this: countCone(fan(map), …) prunes the
  // length-preserving transform, leaving ONLY the collection-level grouping fact
  // (the cardinality id), NOT the per-element ids. Wiring must reproduce it.
  //   Today (eager golden above): prov == [100,101,102]  (over-attribution)
  //   Target (static):            prov == [<grouping id>] (one collection-level id)
  // The COUNT must remain 3 either way (laziness/statics change the cone, never
  // the value — A18/CAPABILITY confluence).
  it.todo("(length (map id xs)) static cone == [grouping-fact] only — NOT [100,101,102] (the A13 leak is closed)");

  it.todo("(length (map id xs)) static VALUE still == 3 (cone differs, count must not)");
});

describe("GATE G2 TARGET (static path, --ir-lineage on) — filter is length-CHANGING, so its cone is kept", () => {
  // filter is NOT length-preserving, so a count over it genuinely depends on which
  // elements survived — countCone must NOT prune the filter fan. The static cone
  // therefore INCLUDES the predicate's cone (here: the surviving elements
  // a=100, c=102, which the predicate selected). Contrast the pure-map target
  // above, where the cone collapses to the grouping fact.
  it.todo(
    "(length (filter pred xs)) static cone INCLUDES the predicate cone (survivors 100,102) — filter fan is NOT pruned",
  );

  it.todo(
    "nested (length (map g (filter p xs))): static cone == filter-survivor cone (outer pure map pruned, inner filter kept)",
  );

  it.todo("(length (filter pred xs)) static VALUE still == 2 (the count itself is unchanged by the rewrite)");
});

describe("GATE G2 TARGET (static path, --ir-lineage on) — flag-off is byte-identical to the eager golden", () => {
  // The migration's hard equivalence promise: with the flag OFF, the new code path
  // must produce EXACTLY the snapshots captured above. This is the regression wall
  // — encode it as a todo until both paths exist and can be diffed in one run.
  it.todo("provenance(flag-off) on every program above == the eager golden snapshot, byte-for-byte");
});
