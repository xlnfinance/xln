/**
 * Classify an LLM-custdev harvest against the reader of record.
 *
 * The model writes sugarcoat programs plus the canonical scheme it BELIEVES each
 * lowers to; we read its sugarcoat with the real reader and compare ASTs. Outcomes:
 *
 *   MATCH          — parses, AST ≡ the model's expectation (the docs taught correctly)
 *   MISMATCH       — parses but means something else. The interesting class: either the
 *                    doc under-teaches (add a ✗-example) or the reader silently misparses.
 *   EXPECT_INVALID — the model's own canonical doesn't parse as scheme
 *   ERROR          — reader rejected; `door` carries the message (is it teaching?)
 *   READER_EMITTED_INVALID — reader produced unparseable scheme (a reader bug)
 *
 * Field names are matched leniently — schema-free models rename output fields
 * (`lowers_to`, `program`/`canonical`) between runs.
 */
import { parseSexprs, nodeEq, schemeToSugarcoat, type Node } from "../sugarcoat-render.js";
import { readSugarcoat } from "../sugarcoat-read.js";

export type HarvestProgram = {
  title?: string;
  name?: string;
  features?: string[];
  sugarcoat?: string;
  program?: string;
  source?: string;
  expected_canonical?: string;
  lowers_to?: string;
  canonical?: string;
  expected?: string;
};

export type Classified = {
  title: string;
  features?: string[];
  outcome: "MATCH" | "MISMATCH" | "EXPECT_INVALID" | "ERROR" | "READER_EMITTED_INVALID";
  got_canonical?: string;
  expected?: string;
  door?: string;
  idempotent?: boolean | string;
};

const show = (n: Node): string =>
  "atom" in n ? (n.str ? `"${n.atom}"` : n.atom) : "(" + n.list.map(show).join(" ") + ")";

const forestEq = (a: Node[], b: Node[]): boolean => a.length === b.length && a.every((n, i) => nodeEq(n, b[i]!));

export function classify(harvest: HarvestProgram[]): { counts: Record<string, number>; results: Classified[] } {
  const results: Classified[] = [];
  for (const [i, raw] of harvest.entries()) {
    const sugarcoat = raw.sugarcoat ?? raw.program ?? raw.source;
    const expected = raw.expected_canonical ?? raw.lowers_to ?? raw.canonical ?? raw.expected;
    const r: Classified = { title: raw.title ?? raw.name ?? `#${i + 1}`, features: raw.features, outcome: "ERROR" };
    if (!sugarcoat || !expected) {
      r.door = "harvest entry missing sugarcoat/expected fields";
      results.push(r);
      continue;
    }
    let gotForest: Node[];
    try {
      gotForest = readSugarcoat(sugarcoat);
      r.got_canonical = gotForest.map(show).join("\n");
    } catch (error) {
      r.outcome = "ERROR";
      r.door = String((error as Error).message).slice(0, 200);
      results.push(r);
      continue;
    }
    let expForest: Node[];
    try {
      expForest = parseSexprs(expected);
    } catch (error) {
      r.outcome = "EXPECT_INVALID";
      r.door = String((error as Error).message).slice(0, 200);
      results.push(r);
      continue;
    }
    r.outcome = forestEq(gotForest, expForest) ? "MATCH" : "MISMATCH";
    if (r.outcome === "MISMATCH") r.expected = expected;
    try {
      const rerender = gotForest.map((n) => schemeToSugarcoat(show(n))).join("\n");
      const reread = readSugarcoat(rerender);
      r.idempotent = forestEq(reread, gotForest);
    } catch (error) {
      r.idempotent = "render/reread threw: " + String((error as Error).message).slice(0, 120);
    }
    results.push(r);
  }
  const counts: Record<string, number> = {};
  for (const r of results) counts[r.outcome] = (counts[r.outcome] ?? 0) + 1;
  return { counts, results };
}
