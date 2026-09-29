// prelude — proves the harvest chain: grant tool defs → ambient prelude → a lowered scheme
// program type-checks against it (and a wrong program bites, so the Σ∩T narrow has teeth).
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

import * as z from "../../common/scheme-zod/index.js";
import { symbol } from "../../symbol/index.js";
import { lower } from "../lower.js";
import { assembleHarvestedPrelude } from "../prelude.js";

/** Type-check `source` as one in-memory file; return the diagnostic messages (empty = clean). */
function compileErrors(source: string): string[] {
  const fileName = "/_virtual.ts";
  const options: ts.CompilerOptions = {
    strict: true,
    target: ts.ScriptTarget.ES2022,
    lib: ["lib.es2022.d.ts"],
    noEmit: true,
    skipLibCheck: true,
  };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, lang, onError, shouldCreate) =>
    name === fileName
      ? ts.createSourceFile(name, source, lang, true)
      : getSourceFile(name, lang, onError, shouldCreate);
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (name) => name === fileName || fileExists(name);
  const readFile = host.readFile.bind(host);
  host.readFile = (name) => (name === fileName ? source : readFile(name));
  const program = ts.createProgram([fileName], options, host);
  return ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
}

describe("assembleHarvestedPrelude — grant tool defs → lens prelude", () => {
  // `get-route` takes a proper list (z.list() → List<unknown>) + a string. `z.pair` is
  // cons(value, value) — a dotted-pair codec, not list-shaped — `z.union([z.pair, z.nil])`
  // is not "a proper list."
  const getRoute = symbol.rosetta`get-route: route between stops`(
    { input: [z.list(), z.string], output: [z.string] },
    () => "",
  );
  const setTimer = symbol.rosetta`set-timer: start a timer`(
    { input: [z.number], output: [z.undefinedResult] },
    () => undefined,
  );
  const entries = [
    ["get_route", getRoute],
    ["set_timer", setTimer],
  ] as const;

  it("emits the carrier vocabulary + a declare per tool", () => {
    const { prelude, members } = assembleHarvestedPrelude(entries);
    expect(prelude).toContain("interface Cons");
    expect(prelude).toContain("declare const get_route:");
    expect(prelude).toContain("declare const set_timer:");
    expect(members).toEqual(["get_route", "set_timer"]);
  });

  it("a VALID lowered program type-checks against the harvested prelude", () => {
    const { prelude } = assembleHarvestedPrelude(entries);
    const program = `set_timer(600);\nget_route(list("A", "B"), "fast");\n`;
    expect(compileErrors(`${prelude}\n${program}`)).toEqual([]);
  });

  it("a WRONG lowered program bites (a vector where a list is expected; a string where a number is)", () => {
    const { prelude } = assembleHarvestedPrelude(entries);
    expect(compileErrors(`${prelude}\nget_route([1, 2, 3], "fast");\n`).length).toBeGreaterThan(0);
    expect(compileErrors(`${prelude}\nset_timer("ten");\n`).length).toBeGreaterThan(0);
  });

  it("a kwargs tool: a valid `:key value` call type-checks; a bad value / missing required prop bites", () => {
    // create_user takes a kwargs object: required name:string + optional mode:"fast"|"scenic".
    const createUser = symbol.rosetta`create_user: make a user`(
      { input: [], inputRest: { name: z.string, mode: z.enum(["fast", "scenic"]).optional() }, output: [z.string] },
      () => "",
    );
    const { prelude } = assembleHarvestedPrelude([["create_user", createUser]]);
    const check = (scheme: string): number => compileErrors(`${prelude}\n${lower(scheme).ts};\n`).length;
    // valid: required :name (+ an optional :mode) — lowers to create_user({ name: "Ada", mode: "fast" })
    expect(check('(create_user :name "Ada" :mode "fast")')).toBe(0);
    expect(check('(create_user :name "Ada")')).toBe(0);
    expect(check("(create_user :name 42)")).toBeGreaterThan(0);
    expect(check('(create_user :name "Ada" :mode "teleport")')).toBeGreaterThan(0);
    expect(check('(create_user :mode "fast")')).toBeGreaterThan(0);
  });
});
