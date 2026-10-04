#!/usr/bin/env node
// A compliance check in front of apply. The diff is built here, from the file
// (or the given text) and the preview, so the program cannot hand a prettier one.
// One Noul asks whether that diff carries out the operations and nothing else.
//
// allow is quiet and is the only verdict that means write. doubt returns the
// probability and the diff, and the caller decides. refuse is an obvious miss.
// This function never writes. A Noul has no confidence field; the two bars below
// belong to this gate, because a false allow is the miss that writes.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-latest";

/** At or above this, the preview may be written. A false yes is the expensive miss. */
export const ALLOW_AT = 0.9;

/** At or below this, the miss is obvious. Between the bars the caller decides. */
export const REFUSE_AT = 0.1;

const CONTEXT = 3;
const MAX_MIDDLE = 400;
const MAX_DIFF_CHARS = 8000;
const KNOWN = new Set(["set_return_type", "add_parameter", "remove_parameter", "add_named_import"]);

// The id stays here. The model sees the question, the operations, and the diff.
const FAITHFUL = {
  type: "noul",
  instructions: {
    question: "Does `diff` carry out `operations`, and nothing else?",
    read: "Each operation names one slot: a return type, a parameter, or a named import. On a line that is both removed and added, words present in both versions are the declaration, not a change.",
    ignore: "Whether the new type matches what the function returns. Disagreement is still yes when the only new text is the named slot.",
  },
  criteria: {
    true: "The only text that was added or removed is the slots the operations name.",
    false: "A named slot is missing, or text changed that no operation named, including a function body.",
  },
};

/** Scheme spells a dict as a list of pairs. Read that spelling too. */
const asObject = (value) => {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (!Array.isArray(value) || value.length === 0) return value;
  const out = {};
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string") return value;
    const key = entry[0].startsWith(":") ? entry[0].slice(1) : entry[0];
    out[key] = entry[1];
  }
  return out;
};

const redact = (text, secret) => (secret && text.includes(secret) ? text.split(secret).join("[redacted]") : text);

const inRepo = (file) => {
  const full = path.resolve(ROOT, file);
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) throw new Error(`${file} is outside the repo`);
  return full;
};

const wordIn = (text, name) => {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^A-Za-z0-9_$])${escaped}(?:$|[^A-Za-z0-9_$])`).test(text);
};

/** The declaration, or the member after the dot. A short name still has to be a word. */
const namedIn = (text, name) => {
  if (wordIn(text, name)) return true;
  const dot = name.lastIndexOf(".");
  return dot !== -1 && wordIn(text, name.slice(dot + 1));
};

const operationsOf = (value) => {
  if (!Array.isArray(value) || value.length === 0) throw new Error("operations are a non-empty list");
  return value.map((entry, index) => {
    const op = asObject(entry);
    if (!op || typeof op !== "object" || Array.isArray(op)) throw new Error(`operation ${index} is not a record`);
    if (typeof op.action !== "string" || op.action === "") throw new Error(`operation ${index} has no action`);
    const plain = {};
    for (const [key, field] of Object.entries(op)) {
      if (typeof field === "string") plain[key] = field;
    }
    if (KNOWN.has(plain.action)) {
      if (!plain.name) throw new Error(`operation ${index} has no name`);
      if (!plain.value) throw new Error(`operation ${index} has no value`);
    }
    return plain;
  });
};

const lcsOps = (a, b) => {
  const width = b.length + 1;
  const dp = new Uint16Array((a.length + 1) * width);
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const at = i * width + j;
      dp[at] = a[i - 1] === b[j - 1]
        ? dp[(i - 1) * width + (j - 1)] + 1
        : Math.max(dp[(i - 1) * width + j], dp[i * width + (j - 1)]);
    }
  }
  const ops = [];
  let i = a.length;
  let j = b.length;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      ops.push({ kind: "eq", line: a[i - 1] });
      i -= 1;
      j -= 1;
    } else if (dp[(i - 1) * width + j] > dp[i * width + (j - 1)]) {
      // Equal scores take the added line while walking backward, so the
      // reversed hunk shows the old line and then the new one.
      ops.push({ kind: "del", line: a[i - 1] });
      i -= 1;
    } else {
      ops.push({ kind: "add", line: b[j - 1] });
      j -= 1;
    }
  }
  while (i > 0) {
    ops.push({ kind: "del", line: a[i - 1] });
    i -= 1;
  }
  while (j > 0) {
    ops.push({ kind: "add", line: b[j - 1] });
    j -= 1;
  }
  ops.reverse();
  return ops;
};

const atomsOf = (before, after, start, endA, endB, ops) => {
  const atoms = [];
  for (let i = 0; i < start; i += 1) atoms.push({ kind: " ", line: before[i], old: i + 1, neu: i + 1 });
  let oldLine = start + 1;
  let newLine = start + 1;
  for (const op of ops) {
    if (op.kind === "eq") {
      atoms.push({ kind: " ", line: op.line, old: oldLine, neu: newLine });
      oldLine += 1;
      newLine += 1;
    } else if (op.kind === "del") {
      atoms.push({ kind: "-", line: op.line, old: oldLine, neu: newLine });
      oldLine += 1;
    } else {
      atoms.push({ kind: "+", line: op.line, old: oldLine, neu: newLine });
      newLine += 1;
    }
  }
  for (let k = 0; k < before.length - endA; k += 1) {
    atoms.push({ kind: " ", line: before[endA + k], old: endA + k + 1, neu: endB + k + 1 });
  }
  return atoms;
};

const hunk = (atoms, first, last) => {
  const from = Math.max(0, first - CONTEXT);
  const to = Math.min(atoms.length, last + CONTEXT + 1);
  const slice = atoms.slice(from, to);
  const oldLines = slice.filter((atom) => atom.kind !== "+");
  const newLines = slice.filter((atom) => atom.kind !== "-");
  const oldStart = oldLines.length === 0 ? 0 : oldLines[0].old;
  const newStart = newLines.length === 0 ? 0 : newLines[0].neu;
  const header = `@@ -${oldStart},${oldLines.length} +${newStart},${newLines.length} @@\n`;
  const body = slice.map((atom) => `${atom.kind}${atom.line}`).join("\n");
  return `${header}${body}\n`;
};

const unified = (atoms) => {
  const changes = [];
  atoms.forEach((atom, index) => {
    if (atom.kind !== " ") changes.push(index);
  });
  if (changes.length === 0) return "";
  const groups = [[changes[0]]];
  for (let i = 1; i < changes.length; i += 1) {
    const group = groups[groups.length - 1];
    if (changes[i] - group[group.length - 1] <= CONTEXT * 2) group.push(changes[i]);
    else groups.push([changes[i]]);
  }
  return groups.map((group) => hunk(atoms, group[0], group[group.length - 1])).join("");
};

/**
 * A line diff of the two texts. Common edges are context. The middle is a real
 * line LCS, so two edits far apart do not mark the unchanged lines between them
 * as removed and added. Too wide to judge comes back as `wide` and is not sent.
 */
export const lineDiff = (before, after) => {
  if (before === after) return { kind: "same", text: "" };
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (midA.length > MAX_MIDDLE || midB.length > MAX_MIDDLE) {
    return { kind: "wide", lines: { before: a.length, after: b.length } };
  }
  const text = unified(atomsOf(a, b, start, endA, endB, lcsOps(midA, midB)));
  if (text.length > MAX_DIFF_CHARS) return { kind: "wide", lines: { before: a.length, after: b.length } };
  return { kind: "diff", text };
};

const valueLanded = (after, value) => after.includes(value) || after.includes(JSON.stringify(value)) || after.includes(`'${value}'`);

const deletedLines = (diff) => diff.split("\n").filter((line) => line.startsWith("-") && !line.startsWith("---")).map((line) => line.slice(1));

/** An obvious miss, before any call. Unknown actions are left for the Noul. */
const obvious = (operations, after, diff) => {
  for (let index = 0; index < operations.length; index += 1) {
    const op = operations[index];
    if (!KNOWN.has(op.action)) continue;
    if (!namedIn(diff, op.name)) {
      return { verdict: "refuse", reason: "unrelated", asked: false, detail: `operation ${index} ${op.action} names ${op.name}, and the diff does not` };
    }
    if (op.action === "remove_parameter") {
      if (!deletedLines(diff).some((line) => wordIn(line, op.value))) {
        return { verdict: "refuse", reason: "kept", asked: false, detail: `operation ${index} remove_parameter ${op.value} is not on a deleted line` };
      }
      continue;
    }
    if (op.action === "add_named_import" && !after.includes(op.name)) {
      return { verdict: "refuse", reason: "missing", asked: false, detail: `operation ${index} add_named_import ${op.name} is not in the result` };
    }
    if (!valueLanded(after, op.value)) {
      return { verdict: "refuse", reason: "missing", asked: false, detail: `operation ${index} ${op.action} ${op.value} is not in the result` };
    }
  }
  return undefined;
};

const loadKey = async () => {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY;
  if (process.env.JEV_API_KEY) return process.env.JEV_API_KEY;
  let text;
  try {
    text = await readFile(new URL("../../.env", import.meta.url), "utf8");
  } catch {
    return undefined;
  }
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*(?:export\s+)?(?:TYPESAFE_API_KEY|JEV_API_KEY)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[1];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (value) return value;
  }
  return undefined;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const askJev = async ({ state, questions }) => {
  const key = await loadKey();
  if (!key) throw new Error("JEV_API_KEY is not set");
  const body = JSON.stringify({ model: MODEL, state, questions });
  let last = "jev failed";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response;
    try {
      response = await fetch(ENDPOINT, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      last = redact(error instanceof Error ? error.name : "jev failed", key);
      if (attempt < 2) {
        await sleep(400 * 2 ** attempt);
        continue;
      }
      throw new Error(last);
    }
    if (response.status === 429 || response.status === 529) {
      last = `jev ${response.status}`;
      if (attempt < 2) {
        await sleep(400 * 2 ** attempt);
        continue;
      }
      throw new Error(last);
    }
    if (!response.ok) {
      const detail = redact(await response.text(), key).slice(0, 180);
      throw new Error(detail === "" ? `jev ${response.status}` : `jev ${response.status}: ${detail}`);
    }
    let parsed;
    try {
      parsed = await response.json();
    } catch {
      throw new Error("jev response was not json");
    }
    const faithful = parsed?.answers?.faithful;
    if (faithful?.type !== "noul" || typeof faithful.noul !== "number") {
      const keys = parsed && typeof parsed === "object" ? Object.keys(parsed) : [];
      throw new Error(`jev answer shape (${keys.join(",")})`);
    }
    return { model: typeof parsed.model === "string" ? parsed.model : MODEL, noul: faithful.noul };
  }
  throw new Error(last);
};

const readNoul = (answer) => {
  const noul = answer?.noul;
  if (typeof noul !== "number" || !Number.isFinite(noul) || noul < 0 || noul > 1) {
    const keys = answer && typeof answer === "object" ? Object.keys(answer) : [];
    throw new Error(`jev noul missing (${keys.join(",")})`);
  }
  return noul;
};

const fromModel = (noul, model, diff) => {
  const shared = { asked: true, model, probability: noul, probabilities: { yes: noul, no: 1 - noul } };
  if (noul >= ALLOW_AT) return { verdict: "allow", reason: "yes", ...shared };
  if (noul <= REFUSE_AT) return { verdict: "refuse", reason: "no", ...shared };
  return { verdict: "doubt", reason: "spread", ...shared, diff };
};

const beforeOf = async (input) => {
  const hasPath = input.path !== undefined;
  const hasBefore = input.before !== undefined;
  if (hasPath && hasBefore) throw new Error("pass path or before, not both");
  if (!hasPath && !hasBefore) throw new Error("pass path or before");
  if (hasPath) return readFile(inRepo(input.path), "utf8");
  if (typeof input.before !== "string") throw new Error("before is text");
  return input.before;
};

/**
 * Operations against the preview. `ask` is the Noul call; tests pass their own.
 * The state it sees is `{ operations, diff }` and nothing else.
 */
export const gate = async (input, ask = askJev) => {
  const operations = operationsOf(input.operations);
  if (typeof input.after !== "string") throw new Error("after is text");
  const before = await beforeOf(input);
  if (before === input.after) return { verdict: "allow", reason: "unchanged", asked: false };
  const diff = lineDiff(before, input.after);
  if (diff.kind === "wide") return { verdict: "doubt", reason: "wide", asked: false, lines: diff.lines };
  const miss = obvious(operations, input.after, diff.text);
  if (miss) return miss;
  let answer;
  try {
    answer = await ask({ state: { operations, diff: diff.text }, questions: { faithful: FAITHFUL } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "jev failed";
    throw new Error(redact(redact(message, process.env.TYPESAFE_API_KEY), process.env.JEV_API_KEY));
  }
  return fromModel(readNoul(answer), typeof answer?.model === "string" ? answer.model : MODEL, diff.text);
};

const answer = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

const operation = z.preprocess(asObject, z.record(z.string(), z.unknown()));

const shape = {
  operations: z.array(operation).describe("The same list given to ast-edit/preview."),
  after: z.string().describe("The preview text."),
  before: z.string().optional().describe("The text before the edit. Omit when path is set."),
  path: z.string().optional().describe("Repo path of the file before the edit. Omit when before is set."),
};

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const server = new McpServer({ name: "jev", version: "0.1.0" });
  server.registerTool(
    "gate",
    {
      description: "Compare operations with a preview. Returns allow, doubt, or refuse. Writes nothing. Only allow means apply. doubt is for the caller to decide.",
      inputSchema: shape,
    },
    async (input) => {
      try {
        return answer(await gate(input));
      } catch (error) {
        const message = error instanceof Error ? error.message : "jev failed";
        return { isError: true, content: [{ type: "text", text: redact(redact(message, process.env.TYPESAFE_API_KEY), process.env.JEV_API_KEY) }] };
      }
    },
  );
  await server.connect(new StdioServerTransport());
}
