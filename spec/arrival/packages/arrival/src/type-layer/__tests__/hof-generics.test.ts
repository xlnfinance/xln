// Faithful generic HOF harvest — inference pins against inline dedent type: shapes.
import { describe, expect, it } from "vitest";
import ts from "typescript";
import dedent from "dedent";
import { signatureOf } from "../schema-to-ts.js";
import lists from "../../env/r7rs/lists.js";
import vectors from "../../env/r7rs/vectors.js";
import strings from "../../env/r7rs/strings.js";
import srfi1 from "../../env/srfi/srfi-1.js";
import { harvestContracts } from "../../__tests__/_symbols-harvest.js";

const norm = (s: string) => s.replace(/\s+/g, " ").trim();
// harvestContracts / contractOf pulls the AEntity CONTRACT off each pack's minted `spec.symbols` entries.
const contractsOf = (pack: { spec: { symbols?: unknown } }) => harvestContracts(pack.spec.symbols);

const MAP = dedent`
  {
    <T, B>(f: (x: T) => B, xs: List<T>): List<B>;
    <T, B>(f: (x: T) => B, xs: readonly T[]): readonly B[];
    <A, B, R>(f: (a: A, b: B) => R, as: List<A>, bs: List<B>): List<R>;
    <A, B, R>(f: (a: A, b: B) => R, as: readonly A[], bs: readonly B[]): readonly R[];
    <A, B, C, R>(f: (a: A, b: B, c: C) => R, as: List<A>, bs: List<B>, cs: List<C>): List<R>;
    <A, B, C, R>(f: (a: A, b: B, c: C) => R, as: readonly A[], bs: readonly B[], cs: readonly C[]): readonly R[];
  }
`;
const FILTER = dedent`
  {
    <T, S extends T>(p: (x: T) => x is S, xs: List<T>): List<S>;
    <T>(p: (x: T) => unknown, xs: List<T>): List<T>;
    <T, S extends T>(p: (x: T) => x is S, xs: readonly T[]): readonly S[];
    <T>(p: (x: T) => unknown, xs: readonly T[]): readonly T[];
  }
`;
const REDUCE = dedent`
  {
    <T, A>(f: (element: T, acc: A) => A, ridentity: A, xs: List<T>): A;
    <T, A>(f: (element: T, acc: A) => A, ridentity: A, xs: readonly T[]): A;
  }
`;
const FIND = dedent`
  {
    <T, S extends T>(p: (x: T) => x is S, xs: List<T>): S | null;
    <T>(p: (x: T) => unknown, xs: List<T>): T | null;
  }
`;
const VECTOR_MAP = dedent`
  {
    <T, B>(f: (x: T) => B, v: readonly T[]): readonly B[];
    <A, B, R>(f: (a: A, b: B) => R, a: readonly A[], b: readonly B[]): readonly R[];
    <A, B, C, R>(f: (a: A, b: B, c: C) => R, a: readonly A[], b: readonly B[], c: readonly C[]): readonly R[];
  }
`;
const STRING_MAP = dedent`
  {
    (f: (c: string) => string, s: string): string;
    (f: (...chars: string[]) => string, ...strings: string[]): string;
  }
`;
const TAKE_WHILE = dedent`
  {
    <T>(p: (x: T) => unknown, xs: List<T>): List<T>;
    <T>(p: (x: T) => unknown, xs: readonly T[]): readonly T[];
  }
`;

const AMBIENT = `
declare const LIST_BRAND: unique symbol;
interface Cons<out T> { readonly [LIST_BRAND]: T; }
type List<T> = Cons<T> | null;
`;

function infer(hofSig: string, bindings: string, call: string): string {
  const source = [
    AMBIENT,
    `declare const fn: ${hofSig};`,
    bindings,
    `const __r = ${call};`,
    `type __R = typeof __r;`,
  ].join("\n");

  const file = "/virtual/hof-infer2.ts";
  const host = ts.createCompilerHost({ strict: true, noEmit: true });
  const origGetSourceFile = host.getSourceFile.bind(host);
  const origFileExists = host.fileExists.bind(host);
  const origReadFile = host.readFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
    if (fileName === file) {
      return ts.createSourceFile(file, source, languageVersion, true, ts.ScriptKind.TS);
    }
    return origGetSourceFile(fileName, languageVersion, onError, shouldCreate);
  };
  host.fileExists = (f) => f === file || origFileExists(f);
  host.readFile = (f) => (f === file ? source : origReadFile(f));

  const prog = ts.createProgram([file], { strict: true, noEmit: true, target: ts.ScriptTarget.ES2022 }, host);
  const sf = prog.getSourceFile(file)!;
  const checker = prog.getTypeChecker();
  let result: string | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isTypeAliasDeclaration(node) && node.name.text === "__R") {
      result = checker.typeToString(checker.getTypeFromTypeNode(node.type), node, ts.TypeFormatFlags.NoTruncation);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  const diags = ts.getPreEmitDiagnostics(prog).filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (diags.length) {
    const msgs = diags.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")).join("; ");
    throw new Error(`infer failed: ${msgs}\n${source}`);
  }
  if (!result) throw new Error("no __R");
  return result;
}

describe("harvested HOF signatures are faithful generics (inline dedent)", () => {
  it("map", () => {
    expect(norm(signatureOf(contractsOf(lists).map))).toBe(norm(MAP));
  });
  it("filter", () => {
    expect(norm(signatureOf(contractsOf(srfi1).filter))).toBe(norm(FILTER));
  });
  it("reduce", () => {
    expect(norm(signatureOf(contractsOf(srfi1).reduce))).toBe(norm(REDUCE));
  });
  it("find", () => {
    expect(norm(signatureOf(contractsOf(srfi1).find))).toBe(norm(FIND));
  });
  it("vector-map", () => {
    expect(norm(signatureOf(contractsOf(vectors)["vector-map"]))).toBe(norm(VECTOR_MAP));
  });
  it("string-map", () => {
    expect(norm(signatureOf(contractsOf(strings)["string-map"]))).toBe(norm(STRING_MAP));
  });
  it("take-while", () => {
    expect(norm(signatureOf(contractsOf(srfi1)["take-while"]))).toBe(norm(TAKE_WHILE));
  });
});

describe("HOF generic inference (List|vector dual)", () => {
  it("map list: List<number> → List<string>", () => {
    const t = infer(MAP, "declare const xs: List<number>;", "fn((n) => String(n), xs)");
    expect(t).toMatch(/List<string>|Cons<string>/);
  });

  it("map vector: readonly number[] → readonly string[]", () => {
    const t = infer(MAP, "declare const xs: readonly number[];", "fn((n) => String(n), xs)");
    expect(t).toMatch(/string/);
    expect(t).toMatch(/readonly|\[\]/);
  });

  it("map two lists zips element types", () => {
    const t = infer(
      MAP,
      "declare const as: List<number>; declare const bs: List<string>;",
      "fn((n, s) => n + s.length, as, bs)",
    );
    expect(t).toMatch(/List<number>|Cons<number>/);
  });

  it("filter type-guard keeps refined element", () => {
    const t = infer(FILTER, "declare const xs: List<number>;", "fn((n: number): n is 0 | 1 => n === 0 || n === 1, xs)");
    expect(t).toMatch(/0|1/);
  });

  it("filter boolean pred keeps T", () => {
    const t = infer(FILTER, "declare const xs: List<number>;", "fn((n) => n > 0, xs)");
    expect(t).toMatch(/List<number>|Cons<number>/);
  });

  it("reduce accumulates to init type", () => {
    const t = infer(REDUCE, "declare const xs: List<number>;", "fn((el, acc) => acc + el, 0, xs)");
    expect(t).toBe("number");
  });

  it("find type-guard → S | null", () => {
    const t = infer(FIND, "declare const xs: List<number>;", "fn((n: number): n is 2 => n === 2, xs)");
    expect(t).toMatch(/2/);
    expect(t).toMatch(/null/);
  });

  it("vector-map maps element type", () => {
    const t = infer(VECTOR_MAP, "declare const v: readonly boolean[];", "fn((b) => (b ? 1 : 0), v)");
    expect(t).toMatch(/0|1|number/);
  });

  it("string-map stays string", () => {
    const t = infer(STRING_MAP, "declare const s: string;", "fn((c) => c.toUpperCase(), s)");
    expect(t).toBe("string");
  });
});
