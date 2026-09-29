#!/usr/bin/env node
// Arrival MCP server for the xln spec: lets an agent run and check Arrival programs
// against spec/ with the same capabilities and `(require …)` root as the CLI.
//
// Tools
//   arrival_run    run one .scm file under spec/, or a code snippet evaluated in spec/
//   arrival_check  static diagnostics for .scm files under spec/ (nothing evaluates)
//   arrival_guide  the language card (how to write Arrival) and the spec conventions
//
// Start: node spec/mcp/server.mjs   (stdio; see spec/README.md for client setup)
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SPEC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(SPEC, "arrival/packages/arrival-cli/dist/cli.js");
const CARD = path.join(SPEC, "arrival/packages/arrival/docs/llm-agent-card.md");
const README = path.join(SPEC, "README.md");
const TIMEOUT_MS = 120_000;

/** A path the caller gave, resolved inside spec/ — anything that escapes is refused. */
const inSpec = (file) => {
  const full = path.resolve(SPEC, file);
  if (full !== SPEC && !full.startsWith(SPEC + path.sep)) throw new Error(`${file} is outside spec/`);
  return full;
};

/** Run the arrival CLI from spec/ (so arrival.config.json arms the spec's capabilities). */
const cli = (args) =>
  new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { cwd: SPEC, timeout: TIMEOUT_MS, maxBuffer: 16 << 20 }, (error, stdout, stderr) =>
      resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr }),
    );
  });

const report = ({ code, stdout, stderr }) => ({
  content: [{ type: "text", text: [stdout.trim(), stderr.trim() && `stderr:\n${stderr.trim()}`].filter(Boolean).join("\n\n") || "(no output)" }],
  isError: code !== 0,
});

/** A snippet runs as a scratch file in spec/, so its `(require "lib/…")` paths match a page's. */
const withScratch = async (code, run) => {
  const file = path.join(SPEC, `.scratch-${randomUUID()}.scm`);
  await writeFile(file, code);
  try {
    return await run(path.basename(file));
  } finally {
    await rm(file, { force: true });
  }
};

const server = new McpServer({ name: "arrival-xln-spec", version: "0.1.0" });

server.registerTool(
  "arrival_run",
  {
    description:
      "Run an Arrival (Scheme) program in the xln spec workspace. Give `file` (path under spec/, e.g. " +
      "account-frames.check.scm) or `code` (a snippet evaluated from spec/, so (require \"lib/check.scm\") works). " +
      "Prints each top-level form's value. `json: true` prints values as NDJSON.",
    inputSchema: {
      file: z.string().optional().describe("path under spec/ to a .scm file"),
      code: z.string().optional().describe("Arrival source to evaluate from spec/"),
      json: z.boolean().optional().describe("values as NDJSON instead of s-expressions"),
    },
  },
  async ({ file, code, json }) => {
    if ((file === undefined) === (code === undefined)) throw new Error("give exactly one of `file` or `code`");
    const flags = json ? ["--json"] : [];
    if (file !== undefined) return report(await cli(["run", ...flags, path.relative(SPEC, inSpec(file))]));
    return report(await withScratch(code, (name) => cli(["run", ...flags, name])));
  },
);

server.registerTool(
  "arrival_check",
  {
    description:
      "Static diagnostics for Arrival files under spec/: every unbound name and misuse at once, each with its fix. " +
      "Nothing is evaluated. Files that use (require …) are reported as skipped; a page that relies on its entry file's requires reports false unbound names, so check entry files (*.check.scm).",
    inputSchema: { files: z.array(z.string()).min(1).describe("paths under spec/") },
  },
  async ({ files }) => report(await cli(["check", ...files.map((f) => path.relative(SPEC, inSpec(f)))])),
);

server.registerTool(
  "arrival_guide",
  {
    description: "How to write Arrival: the language card, then the xln spec conventions (layout, vocabulary, checker).",
    inputSchema: {},
  },
  async () => ({
    content: [{ type: "text", text: `${await readFile(CARD, "utf8")}\n\n---\n\n${await readFile(README, "utf8")}` }],
  }),
);

await server.connect(new StdioServerTransport());
