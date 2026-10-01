// Style ratchet: counts ast-grep rule hits in xln.ts and fails if any rule rises above style/baseline.json.
// `bun style/check.ts --update` lowers the baseline after a refactor (it never raises it).
import { readFileSync, writeFileSync } from "node:fs";
import { unreachable } from "./reach.ts";

const scan = Bun.spawnSync(["uvx", "--from", "ast-grep-cli==0.45.3", "ast-grep", "scan", "--json=compact", "xln.ts"], { cwd: `${import.meta.dir}/..` });
const hits: readonly { ruleId: string }[] = JSON.parse(scan.stdout.toString().split("\n")[0] ?? "[]");
const ruleCounts = hits.reduce<Record<string, number>>((acc, h) => ({ ...acc, [h.ruleId]: (acc[h.ruleId] ?? 0) + 1 }), {});
// Line length is not an AST property, so it is counted here rather than by an ast-grep rule.
const source = readFileSync(`${import.meta.dir}/../xln.ts`, "utf8");
const longLines = source.split("\n").filter((line) => line.length > 120).length;
// Dead code is a whole-file property, so it is counted by style/reach.ts rather than by an ast-grep rule.
const counts: Record<string, number> = { ...ruleCounts, "long-line": longLines, unreachable: unreachable.length };
const path = `${import.meta.dir}/baseline.json`;
const baseline: Record<string, number> = JSON.parse(readFileSync(path, "utf8"));
const rules = [...new Set([...Object.keys(baseline), ...Object.keys(counts)])].sort();
const rows = rules.map((r) => ({ rule: r, now: counts[r] ?? 0, max: baseline[r] ?? 0 }));
rows.forEach(({ rule, now, max }) => console.log(`${now > max ? "FAIL" : "ok  "} ${rule.padEnd(18)} ${String(now).padStart(5)} / ${max}`));
unreachable.forEach(({ name, line }) => console.log(`     unreachable: ${name} (xln.ts:${line})`));
if (process.argv.includes("--update")) writeFileSync(path, `${JSON.stringify(Object.fromEntries(rows.map(({ rule, now, max }) => [rule, Math.min(now, max)])), null, 2)}\n`);
process.exit(rows.some(({ now, max }) => now > max) ? 1 : 0);
