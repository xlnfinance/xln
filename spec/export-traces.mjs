// Export complete runs of a spec page as ITF JSON (Quint's trace format), one file per run,
// into traces/<page>/. A later thread replays them on the independent Quint spec.
//   node export-traces.mjs [page] [count]      (from spec/; default: account-frames 16)
// Value mapping: dict -> record (keys without the leading ":"), list -> list, keyword and
// bigint as in ITF ({"#bigint": "..."} above 2^53), #t/#f -> bool. Each state carries
// "mbt::actionTaken": the rule that led to it ("init" for state 0).
import { evaluate, lib } from "./tools/run.mjs";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";

const pages = { "account-frames": { files: ["account/frames.scm"], spec: "account-frames" } };
const [name = "account-frames", count = "16"] = process.argv.slice(2);
const page = pages[name];
if (!page) throw new Error(`unknown page ${name}; known: ${Object.keys(pages).join(", ")}`);

const itf = (v) =>
  typeof v === "bigint" ? { "#bigint": v.toString() }
  : typeof v === "string" ? v.replace(/^:/, "")
  : Array.isArray(v) ? v.map(itf)
  : v !== null && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k.replace(/^:/, ""), itf(x)]))
  : v;

const traces = await evaluate([...lib, ...page.files], `(goal-traces ${page.spec} ${count})`);
const dir = `traces/${name}`;
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
traces.forEach((steps, i) => {
  const states = steps.map((s, index) => ({ "#meta": { index }, "mbt::actionTaken": s.label, ...itf(s.world) }));
  const vars = Object.keys(itf(steps[0].world));
  const file = `${dir}/${String(i).padStart(3, "0")}.itf.json`;
  writeFileSync(file, JSON.stringify({ "#meta": { format: "ITF", "format-description": "https://apalache-mc.org/docs/adr/015adr-trace.html", source: `arrival spec ${name}`, description: "a complete run: every tx committed or refused, links empty" }, vars: [...vars, "mbt::actionTaken"], states }, null, 1) + "\n");
});
console.log(`${traces.length} traces -> ${dir}/`);
