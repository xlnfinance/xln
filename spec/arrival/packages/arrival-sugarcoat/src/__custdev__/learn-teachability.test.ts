/**
 * LEARN.md teachability — LLM-as-reader custdev loop.
 *
 * A foreign model gets ONLY LEARN.md and writes sugarcoat programs plus the canonical
 * scheme it believes each lowers to; the real reader arbitrates. MISMATCHes are the
 * yield: each is either a doc gap (add a ✗-example to LEARN.md) or a silent reader
 * misparse.
 *
 * Opt-in category (fires a real LLM). Loud-skips unless BOTH are present:
 *   - the `grok` CLI (a headless agent runner; any OpenAI-compatible runner works
 *     with small edits) — NEVER pass --json-schema: it silently reroutes to the hosted
 *     grok-build model regardless of -m;
 *   - a model to run it on (default `longcat`, override via CUSTDEV_MODEL).
 *
 * Traces land in src/__custdev__/__custdev-output__/ (gitignored) for human reading.
 */
import { describe, it, expect } from "vitest";
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { classify, type HarvestProgram } from "./classify.js";

const MODEL = process.env.CUSTDEV_MODEL ?? "longcat";
const PKG_ROOT = path.resolve(import.meta.dirname, "../..");
const OUT_DIR = path.resolve(import.meta.dirname, "__custdev-output__");

const grokAvailable = (() => {
  try {
    execSync("command -v grok", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
})();
if (!grokAvailable) {
  console.warn("[custdev] SKIPPING learn-teachability: `grok` CLI not on PATH — this run verified nothing.");
}

describe.skipIf(!grokAvailable)("LEARN.md teaches the grammar to a foreign model", () => {
  it("one round: ≥8/10 programs read back exactly as the model intended", () => {
    const prompt = fs.readFileSync(path.resolve(import.meta.dirname, "prompt.txt"), "utf8");
    const out = execFileSync(
      "grok",
      ["-p", prompt, "-m", MODEL, "--output-format", "json", "--max-turns", "8", "--always-approve"],
      { timeout: 560_000, cwd: PKG_ROOT, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );
    let text: string = JSON.parse(out).text ?? "";
    const fence = text.match(/```(?:json)?\n?([\s\S]*?)```/);
    if (fence) text = fence[1]!;
    text = text.slice(text.search(/[[{]/));
    const parsed = JSON.parse(text);
    const harvest: HarvestProgram[] = parsed.programs ?? parsed;
    expect(harvest.length, "model returned a non-empty program set").toBeGreaterThanOrEqual(5);

    const { counts, results } = classify(harvest);
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const trace = path.join(OUT_DIR, `round-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    fs.writeFileSync(trace, JSON.stringify({ model: MODEL, counts, results, harvest }, null, 2));
    console.log(`[custdev] ${JSON.stringify(counts)} — trace: ${trace}`);

    const matches = counts.MATCH ?? 0;
    const detail = results
      .filter((r) => r.outcome !== "MATCH")
      .map((r) => `  ${r.outcome} ${r.title}: ${r.door ?? r.got_canonical ?? ""}`)
      .join("\n");
    expect(
      matches / harvest.length,
      `teachability regressed — non-MATCH outcomes (each = doc gap or silent misparse; see trace)\n${detail}`,
    ).toBeGreaterThanOrEqual(0.8);
  });
});
