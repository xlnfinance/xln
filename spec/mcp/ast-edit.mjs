#!/usr/bin/env node
// A slot on a named declaration, as a value. The parser finds the symbol. The printer
// emits only the new slot, and that span is spliced into the original bytes, so the rest
// of the file stays identical. `preview` never writes. `apply` writes that text.
// A batch applies entirely or not at all.
//
// A body is not a slot. There is no `newCode`, no `set_body`, and no `rename`: a rename
// that cannot see every use is a broken name.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ACTIONS = ["set_return_type", "add_parameter", "remove_parameter", "add_named_import"];
const TARGETS = ["function", "method", "arrow_function"];

const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });

/** Scheme spells a dict as a list of pairs. The slot is an object, so read that spelling too. */
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

const operation = z.preprocess(
  asObject,
  z.object({
    action: z.enum(ACTIONS),
    target: z.enum(TARGETS).optional(),
    name: z.string(),
    value: z.string(),
  }),
);

const inRepo = (file) => {
  const full = path.resolve(ROOT, file);
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) throw new Error(`${file} is outside the repo`);
  return full;
};

const commit = async (full, next) => {
  const dest = `${full}.ast-edit.tmp`;
  await writeFile(dest, next);
  try {
    await rename(dest, full);
  } catch (error) {
    await rm(dest, { force: true });
    throw error;
  }
};

const parsedSlot = (wrapper, pick) => {
  const file = ts.createSourceFile("slot.ts", wrapper, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const diagnostics = file.parseDiagnostics;
  if (diagnostics.length > 0) {
    const message = diagnostics[0].messageText;
    throw new Error(typeof message === "string" ? message : message.messageText);
  }
  const node = pick(file);
  if (!node) throw new Error("not a slot");
  return printer.printNode(ts.EmitHint.Unspecified, node, file).trim();
};

const printedType = (text) => {
  const wrapped = `type __Slot = ${text};`;
  const printed = parsedSlot(wrapped, (file) => {
    const stmt = file.statements[0];
    if (!ts.isTypeAliasDeclaration(stmt)) return undefined;
    const semi = wrapped.lastIndexOf(";");
    return stmt.type.end === semi ? stmt.type : undefined;
  });
  if (printed === "") throw new Error("not a type");
  return printed;
};

const parameterNode = (text) => {
  const wrapped = `function __slot(${text}) {}`;
  const file = ts.createSourceFile("slot.ts", wrapped, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const stmt = file.statements[0];
  const start = stmt && ts.isFunctionDeclaration(stmt) ? stmt.parameters.pos : -1;
  const end = stmt && ts.isFunctionDeclaration(stmt) ? stmt.parameters.end : -1;
  if (!ts.isFunctionDeclaration(stmt) || stmt.parameters.length !== 1 || wrapped.slice(start, end) !== text || wrapped[end] !== ")") {
    throw new Error("not one parameter");
  }
  return { node: stmt.parameters[0], file };
};

const printedParameter = (text) => {
  const { node, file } = parameterNode(text);
  return printer.printNode(ts.EmitHint.Unspecified, node, file).trim();
};

const walk = (node, visit) => {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
};

const declarations = (sf) => {
  const found = [];
  walk(sf, (node) => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      found.push({ kind: "function", name: node.name.text, node });
    }
    if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
      const parent = node.parent;
      const className = parent && ts.isClassLike(parent) && parent.name ? parent.name.text : undefined;
      found.push({
        kind: "method",
        name: node.name.text,
        qualified: className ? `${className}.${node.name.text}` : undefined,
        node,
      });
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      found.push({ kind: "arrow_function", name: node.name.text, node: node.initializer });
    }
  });
  return found;
};

const targetOf = (sf, op) => {
  if (!op.target) throw new Error(`${op.action} needs a target`);
  const all = declarations(sf);
  const sameName = all.filter((item) => item.name === op.name || item.qualified === op.name);
  const hits = sameName.filter((item) => item.kind === op.target && (item.name === op.name || item.qualified === op.name));
  if (hits.length === 1) return hits[0].node;
  if (hits.length > 1) throw new Error(`more than one ${op.target} named ${op.name}`);
  const kinds = [...new Set(sameName.map((item) => item.kind))];
  if (kinds.length === 0) throw new Error(`no ${op.target} named ${op.name}`);
  throw new Error(`${op.name} is a ${kinds.join(", ")}, not a ${op.target}`);
};

/** The parameter-list parentheses. An arrow written `x => x` has none. */
const paramParens = (source, fn) => {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, source);
  scanner.setTextPos(fn.getStart());
  let depth = 0;
  let open = -1;
  while (scanner.getTextPos() < fn.end) {
    const kind = scanner.scan();
    if (kind === ts.SyntaxKind.EndOfFileToken) break;
    if (kind === ts.SyntaxKind.OpenParenToken) {
      if (depth === 0) open = scanner.getTokenPos();
      depth += 1;
    } else if (kind === ts.SyntaxKind.CloseParenToken) {
      depth -= 1;
      if (depth === 0 && open !== -1) return { open, close: scanner.getTokenPos() };
    }
  }
  return undefined;
};

const requireParens = (source, fn) => {
  const parens = paramParens(source, fn);
  if (!parens) throw new Error("arrow has no parentheses");
  return parens;
};

const setReturnType = (source, fn, value) => {
  const printed = printedType(value);
  if (fn.type) return { start: fn.type.getStart(), end: fn.type.end, text: printed };
  const parens = requireParens(source, fn);
  return { start: parens.close + 1, end: parens.close + 1, text: `: ${printed}` };
};

const addParameter = (source, fn, value) => {
  const { node } = parameterNode(value);
  const printed = printedParameter(value);
  if (ts.isIdentifier(node.name)) {
    const declared = fn.parameters.find((p) => ts.isIdentifier(p.name) && p.name.text === node.name.text);
    if (declared) throw new Error(`parameter ${node.name.text} already exists`);
  }
  const parens = requireParens(source, fn);
  const interior = source.slice(parens.open + 1, parens.close).trimEnd();
  const text = interior === "" ? printed : interior.endsWith(",") ? ` ${printed}` : `, ${printed}`;
  return { start: parens.close, end: parens.close, text };
};

const removeParameter = (source, fn, value) => {
  const parens = requireParens(source, fn);
  const param = fn.parameters.find((p) => ts.isIdentifier(p.name) && p.name.text === value);
  if (!param) throw new Error(`no parameter ${value}`);
  if (fn.parameters.length === 1) return { start: parens.open + 1, end: parens.close, text: "" };
  const index = fn.parameters.indexOf(param);
  if (index === 0) {
    const next = fn.parameters[1];
    const comma = source.indexOf(",", param.end);
    if (comma < 0 || comma > next.getStart()) throw new Error("no comma after the parameter");
    const newline = source[comma + 1] === "\n" || source[comma + 1] === "\r";
    let end = comma + 1;
    if (newline) end = next.getStart();
    else while (end < next.getStart() && (source[end] === " " || source[end] === "\t")) end += 1;
    return { start: param.getStart(), end, text: "" };
  }
  const previous = fn.parameters[index - 1];
  const comma = source.lastIndexOf(",", param.getStart());
  if (comma < previous.end) throw new Error("no comma before the parameter");
  return { start: comma, end: param.end, text: "" };
};

const importEnd = (source, bindings) => {
  const close = bindings.end - 1;
  if (source[close] !== "}") throw new Error("named import has no closing brace");
  return close;
};

const addNamedImport = (sf, source, name, specifier) => {
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) throw new Error(`${name} is not an identifier`);
  const from = JSON.stringify(specifier);
  const existing = sf.statements.filter(
    (node) => ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === specifier,
  );
  const named = existing.find((node) => node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings));
  if (named) {
    const bindings = named.importClause.namedBindings;
    const already = bindings.elements.some((element) => (element.propertyName ?? element.name).text === name);
    if (already) return undefined;
    const close = importEnd(source, bindings);
    let at = close;
    while (at > bindings.getStart() + 1 && source[at - 1] === " ") at -= 1;
    const interior = source.slice(bindings.getStart() + 1, at).trimEnd();
    const text = interior === "" ? name : interior.endsWith(",") ? ` ${name}` : `, ${name}`;
    return { start: at, end: at, text };
  }
  const line = `import { ${name} } from ${from};\n`;
  const last = sf.statements.filter((node) => ts.isImportDeclaration(node)).at(-1);
  if (!last) {
    const first = sf.statements[0];
    const at = first ? first.getStart() : 0;
    return { start: at, end: at, text: line };
  }
  const at = source[last.end] === "\n" ? last.end + 1 : last.end;
  const prefix = at > 0 && source[at - 1] !== "\n" ? "\n" : "";
  return { start: at, end: at, text: `${prefix}${line}` };
};

const editOf = (sf, source, op) => {
  if (op.action === "add_named_import") return addNamedImport(sf, source, op.name, op.value);
  const fn = targetOf(sf, op);
  if (op.action === "set_return_type") return setReturnType(source, fn, op.value);
  if (op.action === "add_parameter") return addParameter(source, fn, op.value);
  return removeParameter(source, fn, op.value);
};

const overlaps = (edits) => {
  const ordered = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
  return ordered.some((edit, index) => {
    if (index === 0) return false;
    const previous = ordered[index - 1];
    const samePoint = edit.start === previous.start && edit.end === previous.end;
    return edit.start < previous.end || samePoint;
  });
};

const slots = (source, operations, kind) => {
  const ops = z.array(operation).min(1).parse(operations);
  const sf = ts.createSourceFile("edit.ts", source, ts.ScriptTarget.Latest, true, kind);
  const edits = ops.flatMap((op, index) => {
    try {
      const edit = editOf(sf, source, op);
      return edit ? [edit] : [];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`operation ${index}: ${message}`);
    }
  });
  if (overlaps(edits)) throw new Error("operations touch the same span");
  return edits;
};

/** The file with every slot applied, or the original when every operation was already true. */
export const transform = (source, operations, kind = ts.ScriptKind.TS) =>
  slots(source, operations, kind)
    .sort((a, b) => b.start - a.start)
    .reduce((text, edit) => `${text.slice(0, edit.start)}${edit.text}${text.slice(edit.end)}`, source);

const scriptKind = (file) => (file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

const run = async ({ file, operations, write }) => {
  if (!file.endsWith(".ts") && !file.endsWith(".tsx")) throw new Error(`${file} is not a TypeScript file`);
  const full = inRepo(file);
  const source = await readFile(full, "utf8");
  const preview = transform(source, operations, scriptKind(file));
  let written = false;
  if (write && preview !== source) {
    await commit(full, preview);
    written = true;
  }
  return { written, preview };
};

export const editFile = (file, operations, write = false) => run({ file, operations, write });

const answer = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

const shape = {
  path: z.string().describe("repo path of a .ts or .tsx file"),
  operations: z.array(operation).describe(
    "Slots to change. Each has action, name, value, and target for a declaration. Actions: set_return_type, add_parameter, remove_parameter, add_named_import.",
  ),
};

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const server = new McpServer({ name: "ast-edit", version: "0.1.0" });
  server.registerTool(
    "preview",
    {
      description:
        "Change slots of named TypeScript declarations and return the file text. Writes nothing. A batch applies entirely or not at all. There is no body replacement.",
      inputSchema: shape,
    },
    async ({ path: file, operations }) => answer(await run({ file, operations, write: false })),
  );
  server.registerTool(
    "apply",
    {
      description: "The same slot edit as preview, then write the file. Refuses a path outside the repo.",
      inputSchema: shape,
    },
    async ({ path: file, operations }) => answer(await run({ file, operations, write: true })),
  );
  await server.connect(new StdioServerTransport());
}
