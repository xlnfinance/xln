#!/usr/bin/env node
// ast-grep's fix, as a value. A YAML rule with `fix` is scanned and the patched text comes back
// in source order. `preview` never writes. `apply` writes only the bytes the preview just built,
// and only after each slice still equals the matched text. The two are the same function.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn } from "node:child_process";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TIMEOUT_MS = 60_000;

/** A caller path, resolved inside the repo. Anything that escapes is refused. */
const inRepo = (file) => {
  const full = path.resolve(ROOT, file);
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) throw new Error(`${file} is outside the repo`);
  return full;
};

const rel = (full) => (full.startsWith(ROOT + path.sep) ? path.relative(ROOT, full) : full);

// `execFile`'s `input` option never closes this ast-grep's stdin, so `scan --stdin` waits forever.
// Spawn and end the pipe ourselves.
const run = (args, input) =>
  new Promise((resolve, reject) => {
    const child = spawn("ast-grep", args, { cwd: ROOT });
    const out = [];
    const err = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("ast-grep timed out"));
    }, TIMEOUT_MS);
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      });
    });
    child.stdin.end(input ?? "");
  });

/** Scan `yaml` against a file or a snippet. Matches keep their byte spans. */
const scan = async (yaml, target) => {
  const args = ["scan", "--inline-rules", yaml, "--json"];
  const ran = target.kind === "code"
    ? await run([...args, "--stdin"], target.code)
    : await run([...args, target.full]);
  if (ran.code !== 0) throw new Error(ran.stderr.trim() || ran.stdout.trim() || "ast-grep scan failed");
  const matches = ran.stdout.trim() === "" ? [] : JSON.parse(ran.stdout);
  return matches.map((hit) => {
    if (typeof hit.replacement !== "string") throw new Error(`${hit.ruleId ?? "rule"} matched without a fix`);
    return {
      file: target.kind === "code" ? null : rel(hit.file),
      start: hit.range.byteOffset.start,
      end: hit.range.byteOffset.end,
      text: hit.text,
      replacement: hit.replacement,
    };
  });
};

/**
 * Apply `edits` to `source` from low offset to high. Overlaps are refused, and a slice that is no
 * longer the matched text is refused, so a stale span cannot write into the wrong place.
 */
const patched = (source, edits) => {
  const buf = Buffer.from(source, "utf8");
  const ordered = [...edits].sort((a, b) => a.start - b.start);
  for (let i = 1; i < ordered.length; i += 1) {
    if (ordered[i].start < ordered[i - 1].end) {
      throw new Error(`overlapping matches at bytes ${ordered[i - 1].start} and ${ordered[i].start}`);
    }
  }
  const parts = [];
  let cursor = 0;
  for (const edit of ordered) {
    const slice = buf.subarray(edit.start, edit.end).toString("utf8");
    if (slice !== edit.text) throw new Error(`byte ${edit.start} is not the matched text`);
    parts.push(buf.subarray(cursor, edit.start), Buffer.from(edit.replacement, "utf8"));
    cursor = edit.end;
  }
  parts.push(buf.subarray(cursor));
  return Buffer.concat(parts).toString("utf8");
};

const byFile = (matches) => {
  const groups = new Map();
  for (const match of matches) {
    const key = match.file ?? "";
    groups.set(key, [...(groups.get(key) ?? []), match]);
  }
  return [...groups.entries()];
};

/** Replace `full` with `next` by renaming a temp file over it, so a failed write leaves the original. */
const commit = async (full, next) => {
  const dest = `${full}.rewrite.tmp`;
  await writeFile(dest, next);
  try {
    await rename(dest, full);
  } catch (error) {
    await rm(dest, { force: true });
    throw error;
  }
};

/**
 * One target, one preview. A snippet is patched in memory. A path is scanned, then each file's
 * own matches are patched into that file — a directory must not apply one file's offsets to another.
 */
const rewrite = async ({ yaml, file, code, write }) => {
  if ((file === undefined) === (code === undefined)) throw new Error("give exactly one of `path` or `code`");
  if (write && file === undefined) throw new Error("`apply` needs a path");
  if (code !== undefined) {
    const matches = await scan(yaml, { kind: "code", code });
    return { written: false, matches, preview: patched(code, matches) };
  }
  const full = inRepo(file);
  const matches = await scan(yaml, { kind: "file", full });
  const info = await stat(full);
  const groups = byFile(matches);
  const jobs = groups.length > 0 ? groups : info.isDirectory() ? [] : [[rel(full), []]];
  const files = [];
  let written = false;
  for (const [name, edits] of jobs) {
    const target = inRepo(name);
    const source = await readFile(target, "utf8");
    const preview = patched(source, edits);
    if (write && preview !== source) {
      await commit(target, preview);
      written = true;
    }
    files.push({ file: name, preview });
  }
  return { written, matches, preview: files.length === 1 ? files[0].preview : null, files };
};

const answer = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

const server = new McpServer({ name: "ast-grep-rewrite", version: "0.1.0" });
const shape = {
  yaml: z.string().describe("an ast-grep YAML rule whose fix is the update"),
  path: z.string().optional().describe("repo path to scan, file or directory"),
  code: z.string().optional().describe("a snippet to scan instead of a path"),
};

server.registerTool(
  "preview",
  {
    description: "Scan a path or a snippet with an ast-grep fix rule and return the patched text. Writes nothing.",
    inputSchema: shape,
  },
  async ({ yaml, path: file, code }) => answer(await rewrite({ yaml, file, code, write: false })),
);

server.registerTool(
  "apply",
  {
    description: "The same scan as preview, then write the patched text. Refuses a snippet, an overlap, or a stale span.",
    inputSchema: { yaml: shape.yaml, path: z.string().describe("repo path to scan and write") },
  },
  async ({ yaml, path: file }) => answer(await rewrite({ yaml, file, code: undefined, write: true })),
);

await server.connect(new StdioServerTransport());
