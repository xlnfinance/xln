#!/usr/bin/env node
// Read-only references and definition for one TypeScript identifier in pure/.
// The project is pure/tsconfig.json. Its file list is read when this process
// starts; a file created later is not in it. Bytes are read at the query, so
// an edit made after startup is visible. The first query loads the project and
// answers with the binding. Line and column are 1-based. The column is the
// identifier. Writes nothing. A location is not an edit. Scheme and Solidity
// are not this tool.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CONFIG = path.join(ROOT, "pure/tsconfig.json");

const readSpot = (input) => {
  if (!input || typeof input.path !== "string" || input.path === "") throw new Error("path is required");
  if (!Number.isInteger(input.line) || input.line < 1) throw new Error("line is a number from 1");
  if (!Number.isInteger(input.column) || input.column < 1) throw new Error("column is a number from 1");
  if (!input.path.endsWith(".ts") && !input.path.endsWith(".tsx")) throw new Error("only a .ts or .tsx file");
  const full = path.resolve(ROOT, input.path);
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) throw new Error(`${input.path} is outside the repo`);
  return { full, line: input.line, column: input.column };
};

const openProject = () => {
  const read = ts.readConfigFile(CONFIG, ts.sys.readFile);
  if (read.error) throw new Error("pure/tsconfig.json did not load");
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(CONFIG));
  if (parsed.errors.length > 0) {
    throw new Error(ts.flattenDiagnosticMessageText(parsed.errors[0].messageText, "\n"));
  }
  const versionOf = (fileName) => {
    const modified = ts.sys.getModifiedTime?.(fileName);
    return modified ? String(modified.getTime()) : "0";
  };
  const snapshotOf = (fileName) => {
    const text = ts.sys.readFile(fileName);
    return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
  };
  const host = {
    getCompilationSettings: () => parsed.options,
    getScriptFileNames: () => parsed.fileNames,
    getScriptVersion: versionOf,
    getScriptSnapshot: snapshotOf,
    getCurrentDirectory: () => path.dirname(CONFIG),
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  };
  return ts.createLanguageService(host);
};

let loading;
const serviceOf = () => {
  loading ??= Promise.resolve().then(openProject);
  return loading;
};

const byPlace = (a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.column - b.column;

const place = (program, span, definition) => {
  const source = program.getSourceFile(span.fileName);
  if (!source) throw new Error(`${span.fileName} is not in pure/tsconfig.json`);
  const pos = source.getLineAndCharacterOfPosition(span.textSpan.start);
  return {
    path: path.relative(ROOT, span.fileName),
    line: pos.line + 1,
    column: pos.character + 1,
    definition,
  };
};

const positionOf = (source, spot, file) => {
  try {
    return ts.getPositionOfLineAndCharacter(source, spot.line - 1, spot.column - 1);
  } catch {
    throw new Error(`no character at ${file}:${spot.line}:${spot.column}`);
  }
};

const missing = (file, spot) => `no symbol at ${file}:${spot.line}:${spot.column}`;

const tokenAt = (source, pos) => {
  const text = source.text;
  let start = pos;
  while (start > 0 && /[A-Za-z0-9_$]/.test(text[start - 1])) start -= 1;
  const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(text.slice(start));
  if (!match || start + match[0].length <= pos) return undefined;
  return match[0];
};

const locate = async (kind, input) => {
  const spot = readSpot(input);
  const service = await serviceOf();
  const program = service.getProgram();
  if (!program) throw new Error("pure/tsconfig.json did not load");
  const source = program.getSourceFile(spot.full);
  if (!source) throw new Error(`${input.path} is not in pure/tsconfig.json`);
  const pos = positionOf(source, spot, input.path);
  const name = tokenAt(source, pos);
  if (!name) throw new Error(missing(input.path, spot));
  if (kind === "definition") {
    const defs = service.getDefinitionAtPosition(source.fileName, pos);
    if (!defs || defs.length === 0) throw new Error(missing(input.path, spot));
    const locations = defs.map((info) => place(program, info, true)).sort(byPlace);
    return { name, locations };
  }
  const groups = service.findReferences(source.fileName, pos);
  if (!groups || groups.length === 0) throw new Error(missing(input.path, spot));
  const seen = new Set();
  const locations = [];
  for (const group of groups) {
    for (const entry of group.references) {
      const at = place(program, entry, entry.isDefinition === true);
      const key = `${at.path}:${at.line}:${at.column}`;
      if (seen.has(key)) continue;
      seen.add(key);
      locations.push(at);
    }
  }
  return { name, locations: locations.sort(byPlace) };
};

export const references = (input) => locate("references", input);
export const definition = (input) => locate("definition", input);

const answer = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

const shape = {
  path: z.string().describe("Repo path of a .ts or .tsx file in pure/."),
  line: z.number().int().min(1).describe("1-based line of the identifier."),
  column: z.number().int().min(1).describe("1-based column of the identifier, not the keyword before it."),
};

const call = (kind) => async (input) => {
  try {
    return answer(await locate(kind, input));
  } catch (error) {
    const message = error instanceof Error ? error.message : "lsp failed";
    return { isError: true, content: [{ type: "text", text: message }] };
  }
};

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const server = new McpServer({ name: "lsp", version: "0.1.0" });
  server.registerTool(
    "references",
    {
      description:
        "References of the TypeScript identifier at a 1-based line and column in pure/. Returns locations. Writes nothing. The column is the identifier. A location is not an edit.",
      inputSchema: shape,
    },
    call("references"),
  );
  server.registerTool(
    "definition",
    {
      description:
        "Definition of the TypeScript identifier at a 1-based line and column in pure/. Returns locations. Writes nothing.",
      inputSchema: shape,
    },
    call("definition"),
  );
  await server.connect(new StdioServerTransport());
}
