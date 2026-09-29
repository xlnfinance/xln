/**
 * Merge per-model round JSON files written in parallel into one panel report.
 * Usage:
 *   node --experimental-strip-types merge-rounds.mts __custdev-output__/round-A.json …
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acceptanceGate, summarize } from "./score.mts";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: merge-rounds.mts <round.json>…");
  process.exit(2);
}

const reports = files.map((f) => JSON.parse(fs.readFileSync(f, "utf8")));
const cells = reports.flatMap((r) => r.cells);
const summary = summarize(
  cells.map(
    (c: {
      model: string;
      task: string;
      exec_ok: boolean;
      oracle_ok: boolean;
      underuse: boolean;
      invite_hit: boolean;
      oddities: string[];
    }) => c,
  ),
);

const g = reports[0]!;
const gate = acceptanceGate(summary, g.guidelines_lines, g.guidelines_bytes);

// Per-model breakdown
const byModel: Record<string, { n: number; exec: number; oracle: number; odd: number; under: number }> = {};
for (const c of cells) {
  const m = c.model as string;
  if (!byModel[m]) byModel[m] = { n: 0, exec: 0, oracle: 0, odd: 0, under: 0 };
  const b = byModel[m]!;
  b.n++;
  if (c.exec_ok) b.exec++;
  if (c.oracle_ok) b.oracle++;
  if ((c.oddities as string[]).length) b.odd++;
  if (c.underuse) b.under++;
}

// Failure detail
const fails = cells.filter((c: { oracle_ok: boolean }) => !c.oracle_ok);
const failTable = fails.map(
  (c: {
    model: string;
    task: string;
    exec_ok: boolean;
    error: string | null;
    oddities: string[];
    underuse: boolean;
    preferred: string[];
    program: string | null;
  }) => ({
    model: c.model,
    task: c.task,
    exec_ok: c.exec_ok,
    error: (c.error ?? "").slice(0, 200),
    oddities: c.oddities,
    underuse: c.underuse,
    preferred: c.preferred,
    program_preview: (c.program ?? "").slice(0, 240),
  }),
);

const merged = {
  ts: new Date().toISOString(),
  sources: files,
  guidelines_sha: g.guidelines_sha,
  guidelines_bytes: g.guidelines_bytes,
  guidelines_lines: g.guidelines_lines,
  models: [...new Set(cells.map((c: { model: string }) => c.model))],
  tasks: [...new Set(cells.map((c: { task: string }) => c.task))],
  cells,
  summary,
  byModel,
  failTable,
  acceptance: gate,
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(HERE, "__custdev-output__", `merged-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
fs.writeFileSync(out, JSON.stringify(merged, null, 2));
console.log(JSON.stringify({ summary, byModel, acceptance: gate, failCount: fails.length }, null, 2));
console.log(`wrote ${out}`);
