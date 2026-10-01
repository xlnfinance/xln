// The testnet end-to-end skeleton: run the scenario's steps in the order money flows against an anvil fork of Sepolia
// (the deployed contracts, anvil dev-style keys, nothing sent to a live chain) and write what ran and what is missing.
//
//   bun testnet-e2e/run.ts [--out <status.md>] [--fork <rpc to read from>] [--rpc <loopback node already running>]
//
// Exit 0 when every step is done on the rewrite alone, 1 when some are blocked or scaffolded, 2 when a check failed.
// It is deliberately not part of the one gate: it is red until the pieces it names exist.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SEPOLIA_RPC } from "./lib/anvil.ts";
import { REPO } from "./lib/gaps.ts";
import { exitCode, renderReport, type StepResult } from "./lib/report.ts";
import { runStep } from "./lib/runner.ts";
import { newWorld, STEPS } from "./steps.ts";

const argv = process.argv.slice(2);
const flag = (name: string): string | null => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] ?? null : null; };

const git = (...args: string[]): string => Bun.spawnSync(["git", ...args], { cwd: REPO }).stdout.toString().trim();

/** What was run: the branch checked out and its short commit (the integration branch is not main). */
const head = (): string => `${git("rev-parse", "--abbrev-ref", "HEAD")} ${git("rev-parse", "--short", "HEAD")}`;

const main = async (): Promise<number> => {
  const started = Date.now();
  const world = newWorld({ rpc: flag("--rpc"), fork: flag("--fork") ?? SEPOLIA_RPC });
  const results: StepResult[] = [];
  try {
    for (const step of STEPS) {
      const result = await runStep(world, new Map(results.map((r) => [r.id, r])), step);
      results.push(result);
      console.log(`${result.status.toUpperCase().padEnd(10)} ${step.id.padEnd(14)} ${result.problem ?? result.checks[0] ?? ""}`);
    }
  } finally {
    world.anvil?.stop();
  }
  const report = renderReport({ head: head(), mode: world.facts.mode || "no node", chainId: world.facts.chainId || "-", block: world.facts.block || "-", startedAt: new Date(started).toISOString(), seconds: (Date.now() - started) / 1000 }, results);
  const out = flag("--out");
  if (out !== null) { mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, report); console.log(`status written to ${out}`); }
  else console.log(`\n${report}`);
  return exitCode(results);
};

process.exit(await main());
