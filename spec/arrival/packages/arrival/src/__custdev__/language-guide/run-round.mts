/**
 * Language-guide custdev round runner.
 *
 * Opt-in: fires real models. Not a CI gate.
 *
 *   pnpm exec tsx src/__custdev__/language-guide/run-round.mts
 *   MODELS=longcat,fable TASKS=filter-project pnpm exec tsx …
 */
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  acceptanceGate,
  deepEqual,
  extractSchemeFence,
  scoreProgram,
  sha256,
  summarize,
  type Invite,
} from "./score.mts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, "__custdev-output__");

type Task = {
  id: string;
  title: string;
  invite: Invite[];
  invite_any?: boolean;
  fixture: string;
  prompt: string;
  oracle: unknown;
};

type ModelSpec = { id: string; kind: "grok"; model: string } | { id: string; kind: "claude"; model: string };

const ALL_MODELS: ModelSpec[] = [
  { id: "longcat", kind: "grok", model: "longcat" },
  { id: "grok-4.5", kind: "grok", model: "grok-4.5" },
  { id: "fable", kind: "claude", model: "fable" },
  { id: "sonnet", kind: "claude", model: "sonnet" },
];

function parseList(env: string | undefined, fallback: string[]): string[] {
  if (!env || !env.trim()) return fallback;
  return env
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function which(cmd: string): boolean {
  try {
    execSync(`command -v ${cmd}`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function callGrok(model: string, prompt: string): string {
  const out = execFileSync(
    "grok",
    [
      "-p",
      prompt,
      "-m",
      model,
      "--output-format",
      "json",
      "--max-turns",
      "4",
      "--always-approve",
      "--disable-web-search",
    ],
    { encoding: "utf8", timeout: 600_000, maxBuffer: 16 * 1024 * 1024 },
  );
  try {
    const j = JSON.parse(out);
    return String(j.text ?? j.message ?? out);
  } catch {
    return out;
  }
}

function callClaude(model: string, prompt: string): string {
  // --bare currently fails OAuth in this environment ("Not logged in"). Instead:
  // replace the system prompt so monorepo CLAUDE.md cannot bias the language card.
  const out = execFileSync(
    "claude",
    [
      "-p",
      prompt,
      "--model",
      model,
      "--output-format",
      "text",
      "--system-prompt",
      "You write Arrival-Scheme programs. Follow ONLY the user message and its <guidelines>. Do not use tools. Do not invent APIs. Reply with one fenced scheme block.",
    ],
    { encoding: "utf8", timeout: 600_000, maxBuffer: 16 * 1024 * 1024 },
  );
  return out;
}

async function execProgram(
  fixture: string,
  program: string,
): Promise<{ ok: boolean; value: unknown; error: string | null }> {
  // Dynamic import so the script still loads if dist is stale until we call.
  const { exec } = await import("../../../dist/index.js");
  const source = `${fixture}\n${program}`;
  try {
    const values = await exec(source);
    // last non-nullish-ish form; define returns null/undefined-ish
    let last: unknown = undefined;
    for (const v of values) {
      if (v !== null && v !== undefined) last = v;
      else if (last === undefined) last = v;
    }
    // Prefer last defined value; if all null (only defines), take last
    last = values.length ? values[values.length - 1] : undefined;
    // Skip trailing void from defines: walk back to first non-null
    for (let i = values.length - 1; i >= 0; i--) {
      if (values[i] !== null && values[i] !== undefined) {
        last = values[i];
        break;
      }
    }
    return { ok: true, value: last, error: null };
  } catch (e) {
    return { ok: false, value: null, error: e instanceof Error ? e.message : String(e) };
  }
}

function renderPrompt(template: string, g: string, task: Task): string {
  return template
    .replace("{{GUIDELINES}}", g)
    .replace("{{FIXTURE}}", task.fixture)
    .replace("{{TASK_ID}}", task.id)
    .replace("{{PROMPT}}", task.prompt);
}

async function main() {
  // Single source of truth: docs/llm-agent-card.md (override with GUIDELINES=).
  const guidelinesPath = process.env.GUIDELINES
    ? path.resolve(process.env.GUIDELINES)
    : path.resolve(HERE, "../../../docs/llm-agent-card.md");
  if (!fs.existsSync(guidelinesPath)) {
    console.error(`[custdev] guidelines missing: ${guidelinesPath}`);
    process.exit(2);
  }
  const guidelines = fs.readFileSync(guidelinesPath, "utf8");
  const template = fs.readFileSync(path.join(HERE, "prompt-template.txt"), "utf8");
  const suite = JSON.parse(fs.readFileSync(path.join(HERE, "tasks.json"), "utf8")) as {
    tasks: Task[];
  };

  const modelFilter = parseList(
    process.env.MODELS,
    ALL_MODELS.map((m) => m.id),
  );
  const taskFilter = parseList(
    process.env.TASKS,
    suite.tasks.map((t) => t.id),
  );

  const models = ALL_MODELS.filter((m) => modelFilter.includes(m.id));
  const tasks = suite.tasks.filter((t) => taskFilter.includes(t.id));

  if (!which("grok") && models.some((m) => m.kind === "grok")) {
    console.error("[custdev] grok CLI missing but grok models requested");
    process.exit(2);
  }
  if (!which("claude") && models.some((m) => m.kind === "claude")) {
    console.error("[custdev] claude CLI missing but claude models requested");
    process.exit(2);
  }

  console.log(
    `[custdev] guidelines=${path.basename(guidelinesPath)} sha=${sha256(guidelines)} lines=${guidelines.split("\n").length} bytes=${Buffer.byteLength(guidelines)}`,
  );
  console.log(`[custdev] models=${models.map((m) => m.id).join(",")} tasks=${tasks.map((t) => t.id).join(",")}`);

  const cells: Array<Record<string, unknown>> = [];

  for (const model of models) {
    for (const task of tasks) {
      const prompt = renderPrompt(template, guidelines, task);
      process.stdout.write(`[custdev] ${model.id} × ${task.id} … `);
      let raw = "";
      let callErr: string | null = null;
      try {
        raw = model.kind === "grok" ? callGrok(model.model, prompt) : callClaude(model.model, prompt);
      } catch (e) {
        callErr = e instanceof Error ? e.message : String(e);
      }

      const program = raw ? extractSchemeFence(raw) : null;
      let exec_ok = false;
      let oracle_ok = false;
      let value: unknown = null;
      let error: string | null = callErr;
      let score = scoreProgram("", task.invite, task.invite_any !== false, false);

      if (!program) {
        error = error ?? "no scheme fence in model output";
        console.log("NO_PROGRAM");
      } else {
        const run = await execProgram(task.fixture, program);
        exec_ok = run.ok;
        value = run.value;
        error = run.error;
        oracle_ok = run.ok && deepEqual(run.value, task.oracle);
        score = scoreProgram(program, task.invite, task.invite_any !== false, oracle_ok);
        console.log(
          `${oracle_ok ? "ORACLE_OK" : exec_ok ? "EXEC_OK_ORACLE_FAIL" : "EXEC_FAIL"} odd=${score.oddities.length} under=${score.underuse}`,
        );
      }

      cells.push({
        model: model.id,
        task: task.id,
        program,
        raw: raw.slice(0, 4000),
        exec_ok,
        oracle_ok,
        value,
        error,
        preferred: score.preferred,
        tolerated: score.tolerated,
        oddities: score.oddities,
        underuse: score.underuse,
        invite_hit: score.invite_hit,
      });
    }
  }

  const summary = summarize(
    cells.map((c) => ({
      model: c.model as string,
      task: c.task as string,
      exec_ok: c.exec_ok as boolean,
      oracle_ok: c.oracle_ok as boolean,
      underuse: c.underuse as boolean,
      invite_hit: c.invite_hit as boolean,
      oddities: c.oddities as string[],
    })),
  );

  const lines = guidelines.split("\n").length;
  const bytes = Buffer.byteLength(guidelines);
  const gate = acceptanceGate(summary, lines, bytes);

  const report = {
    ts: new Date().toISOString(),
    guidelines_path: guidelinesPath,
    guidelines_sha: sha256(guidelines),
    guidelines_bytes: bytes,
    guidelines_lines: lines,
    models: models.map((m) => m.id),
    tasks: tasks.map((t) => t.id),
    cells,
    summary,
    acceptance: gate,
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, `round-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

  console.log("\n=== SUMMARY ===");
  console.log(JSON.stringify(summary, null, 2));
  console.log(`acceptance: ${gate.ok ? "PASS" : "FAIL"}`);
  if (!gate.ok) for (const f of gate.failures) console.log(`  - ${f}`);
  console.log(`trace: ${outPath}`);

  process.exit(gate.ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
