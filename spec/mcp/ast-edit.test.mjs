import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { transform } from "./ast-edit.mjs";

const ret = (name, value, target = "function") => ({ action: "set_return_type", target, name, value });
const add = (name, value, target = "function") => ({ action: "add_parameter", target, name, value });
const drop = (name, value, target = "function") => ({ action: "remove_parameter", target, name, value });
const imp = (name, value) => ({ action: "add_named_import", name, value });

test("set_return_type inserts after the parameter list and leaves the body", () => {
  const source = "export function fetchUser(id: string) {\n  return id;\n}\n";
  const next = transform(source, [ret("fetchUser", "Promise<string>")]);
  assert.equal(next, "export function fetchUser(id: string): Promise<string> {\n  return id;\n}\n");
});

test("set_return_type replaces the type and keeps the line break in front of it", () => {
  const source = "const intentOf = (e: Entry):\n  Intent | undefined => e;\n";
  const next = transform(source, [ret("intentOf", "Entry | undefined", "arrow_function")]);
  assert.equal(next, "const intentOf = (e: Entry):\n  Entry | undefined => e;\n");
});

test("a parameter type may contain parentheses", () => {
  const source = "function fetchUser(id: string) {\n  return id;\n}\n";
  const next = transform(source, [add("fetchUser", "cache: Array<string>")]);
  assert.equal(next, "function fetchUser(id: string, cache: Array<string>) {\n  return id;\n}\n");
});

test("a batch adds a parameter and a return type, or applies nothing", () => {
  const source = "function fetchUser(id: string) {\n  return id;\n}\n";
  const next = transform(source, [add("fetchUser", "cache: boolean"), ret("fetchUser", "string")]);
  assert.equal(next, "function fetchUser(id: string, cache: boolean): string {\n  return id;\n}\n");
  assert.throws(() => transform(source, [ret("fetchUser", "string"), add("fetchUser", "???")]), /operation 1/);
});

test("remove_parameter drops one name and its comma", () => {
  const source = "function fetchUser(id: string, cache: boolean) {\n  return id;\n}\n";
  assert.equal(
    transform(source, [drop("fetchUser", "cache")]),
    "function fetchUser(id: string) {\n  return id;\n}\n",
  );
  assert.equal(
    transform(source, [drop("fetchUser", "id")]),
    "function fetchUser(cache: boolean) {\n  return id;\n}\n",
  );
});

test("a method needs its class when the short name is shared", () => {
  const source = "class A { fetch() { return 1; } }\nclass B { fetch() { return 2; } }\n";
  assert.throws(() => transform(source, [ret("fetch", "number", "method")]), /more than one method/);
  assert.equal(
    transform(source, [ret("A.fetch", "number", "method")]),
    "class A { fetch(): number { return 1; } }\nclass B { fetch() { return 2; } }\n",
  );
});

test("an arrow without parentheses is refused", () => {
  const source = "const id = x => x;\n";
  assert.throws(() => transform(source, [ret("id", "string", "arrow_function")]), /no parentheses/);
});

test("the target kind is part of the name", () => {
  const source = "const fetchUser = (id: string) => id;\n";
  assert.throws(() => transform(source, [ret("fetchUser", "string")]), /arrow_function, not a function/);
});

test("add_named_import inserts one line, then a specifier, and a second copy changes nothing", () => {
  const source = "import { A } from \"./a\";\n\nexport const n = 1;\n";
  const added = transform(source, [imp("User", "./types")]);
  assert.equal(added, "import { A } from \"./a\";\nimport { User } from \"./types\";\n\nexport const n = 1;\n");
  const both = transform(added, [imp("Id", "./types")]);
  assert.equal(both, "import { A } from \"./a\";\nimport { User, Id } from \"./types\";\n\nexport const n = 1;\n");
  assert.equal(transform(both, [imp("Id", "./types")]), both);
});

test("two inserts at the same point are refused", () => {
  const source = "import { A } from \"./types\";\n";
  assert.throws(
    () => transform(source, [imp("B", "./types"), imp("C", "./types")]),
    /same span/,
  );
});

test("a list of pairs is the same operation as a dict", () => {
  const source = "function fetchUser(id: string) {\n  return id;\n}\n";
  const next = transform(source, [[["action", "set_return_type"], ["target", "function"], ["name", "fetchUser"], ["value", "string"]]]);
  assert.equal(next, "function fetchUser(id: string): string {\n  return id;\n}\n");
});

test("a path outside the repo is refused and the file stays", async () => {
  const { editFile } = await import("./ast-edit.mjs");
  const dir = await mkdtemp(path.join(tmpdir(), "ast-edit-"));
  const outside = path.join(dir, "nope.ts");
  await writeFile(outside, "export const n = 1;\n");
  try {
    await assert.rejects(editFile(outside, [imp("User", "./types")], true), /outside the repo/);
    assert.equal(await readFile(outside, "utf8"), "export const n = 1;\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
