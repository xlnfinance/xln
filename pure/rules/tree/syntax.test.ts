// The counts that read the shape of the code: what they count and what they must not be fooled by. Each test plants a
// file in a scratch tree and asks the whole gate.
import { describe, expect, test } from "bun:test";
import { treeStyle } from "./gate.ts";
import { isOff } from "./counts.ts";
import { failing, offRows, scratch, used } from "./scratch.ts";

const dead = (name: string): string => `unreachable kernel/a.ts (${name})`;
const importing = (line: string, extra = ""): Readonly<Record<string, string>> => ({ "b.ts": `${line}\nexport const b = 1;\n${extra}`, ...used("b") });

describe("dead exports: only an import that resolves to the file is a user", () => {
  test("a name in a comment or a string of another file is not a user", () => {
    const prose = { "b.ts": "// lonely\nconst s = \"lonely\";\n/* lonely */ export const b = `lonely`;\n", ...used("b") };
    expect(failing({ "a.ts": "export const lonely = 1;\n", ...prose })).toEqual([dead("lonely")]);
  });

  test("a same-spelled local in another file is not a user", () => {
    const local = { "b.ts": "const lonely = 2;\nexport const b = lonely;\n", ...used("b") };
    expect(failing({ "a.ts": "export const lonely = 1;\n", ...local })).toEqual([dead("lonely")]);
  });

  test("a named, aliased or type import of the file is a user", () => {
    expect(failing({ "a.ts": "export const lonely = 1;\n", ...importing("import { lonely } from \"./a.ts\";", "lonely;\n") })).toEqual([]);
    expect(failing({ "a.ts": "export const lonely = 1;\n", ...importing("import { lonely as other } from \"./a.ts\";", "other;\n") })).toEqual([]);
    expect(failing({ "a.ts": "export type Shape = number;\n", ...importing("import type { Shape } from \"./a.ts\";", "export type B = Shape;\n") })).toEqual(["unreachable kernel/b.ts (B)"]);
  });

  test("an import of another file with the same name and spelling is not a user", () => {
    const sibling = { "chain/a.ts": "export const lonely = 1;\n", "chain/a.test.ts": "import { lonely } from \"./a.ts\"; lonely();\n" };
    const root = scratch({ "a.ts": "export const lonely = 1;\n" });
    Object.entries(sibling).forEach(([file, text]) => Bun.write(`${root}/${file}`, text));
    expect(offRows(root)).toEqual([dead("lonely")]);
  });

  test("a bare specifier that spells a sibling file's name is a package, not that file", () => {
    expect(failing({ "a.ts": "export const lonely = 1;\n", ...importing("import { lonely } from \"a\";", "lonely;\n") })).toEqual([dead("lonely")]);
    expect(failing({ "a.ts": "export const lonely = 1;\n", ...importing("import { lonely } from \"a.ts\";", "lonely;\n") })).toEqual([dead("lonely")]);
  });

  test("an import without an extension, or of a directory, resolves to the file or to its index", () => {
    expect(failing({ "a.ts": "export const lonely = 1;\n", ...importing("import { lonely } from \"./a\";", "lonely;\n") })).toEqual([]);
    expect(failing({ "dir/index.ts": "export const x = 1;\n", "b.test.ts": "import { x } from \"./dir\"; x;\n" })).toEqual([]);
    expect(failing({ "dir/index.ts": "export const x = 1;\n", "b.test.ts": "import { x } from \"./other\"; x;\n" })).toEqual(["unreachable kernel/dir/index.ts (x)"]);
  });

  test("a file importing its own export is not its own user", () => {
    expect(failing({ "a.ts": "import { lonely } from \"./a.ts\";\nexport const lonely = 1;\nlonely;\n" })).toEqual([dead("lonely")]);
  });

  test("a user outside the gated directories counts, and an export of a test file is nobody's to use", () => {
    const outside = { "oracle.test.ts": "import { shared } from \"./kernel/a.ts\"; shared;\n" };
    expect(offRows(scratch({ "a.ts": "export const shared = 1;\n" }, {}, outside))).toEqual([]);
    expect(failing({ "a.ts": "export const a = 1;\n", "a.test.ts": "import { a } from \"./a.ts\";\nexport const helper = a;\n" })).toEqual([]);
  });

  test("a re-export is a user of the original and an export of its own", () => {
    const reexport = { "a.ts": "export const x = 1;\n", "b.ts": "export { x } from \"./a.ts\";\n" };
    expect(failing(reexport)).toEqual(["unreachable kernel/b.ts (x)"]);
    expect(failing({ ...reexport, "c.test.ts": "import { x } from \"./b.ts\"; x;\n" })).toEqual([]);
  });

  test("import * as ns of a gated file is a hit of its own", () => {
    expect(failing({ "a.ts": "export const x = 1;\n", ...importing("import * as a from \"./a.ts\";", "a.x;\n") })).toEqual(["namespace-import kernel/b.ts", dead("x")]);
  });
});

describe("dead exports: every export form is seen", () => {
  test("async function, interface, enum, let and declared forms are exports too", () => {
    const forms = [
      "export async function gone() {}", "export function* gone() {}", "export interface gone { x: number }",
      "export enum gone { A }", "export let gone = 1;", "export class gone {}", "export type gone = number;",
    ];
    forms.forEach((form) => expect(failing({ "a.ts": `${form}\n` }).filter((row) => row.startsWith("unreachable"))).toEqual([dead("gone")]));
  });

  test("every declarator of one const is an export", () => {
    expect(failing({ "a.ts": "export const a = 1, b = 2;\n", "a.test.ts": "import { a } from \"./a.ts\"; a;\n" })).toEqual([dead("b")]);
  });

  test("an export list is named by the alias, for values and for types", () => {
    const list = "const hidden = 1;\nexport { hidden as shown };\n";
    expect(failing({ "a.ts": list })).toEqual([dead("shown")]);
    expect(failing({ "a.ts": list, "a.test.ts": "import { shown } from \"./a.ts\"; shown;\n" })).toEqual([]);
    expect(failing({ "a.ts": "type Inner = number;\nexport type { Inner as Outer };\n" })).toEqual([dead("Outer")]);
  });

  test("a form the gate cannot name is a hit, not a silent pass", () => {
    const forms = [
      "export default 5;", "export * from \"./b.ts\";", "export const { p, q } = { p: 1, q: 2 };",
      "export declare const gone: number;", "export const fine = 1, { p } = { p: 1 };",
    ];
    forms.forEach((form) => expect(failing({ "a.ts": `${form}\n`, "b.ts": "export const b = 1;\n", ...used("b") }).filter((row) => row.startsWith("unsupported-export"))).toEqual(["unsupported-export kernel/a.ts"]));
  });
});

describe("a destructured export is one hit, not a dead export named by its pattern", () => {
  test("only unsupported-export is reported", () => {
    expect(failing({ "a.ts": "export const { p, q } = { p: 1, q: 2 };\n" })).toEqual(["unsupported-export kernel/a.ts"]);
  });
});

describe("dead exports: a type may be used by its own file, outside its own declaration", () => {
  const exported = (text: string): readonly string[] => failing({ "a.ts": text, "a.test.ts": "import { f } from \"./a.ts\"; f;\n" });

  test("a type named in an exported signature is live", () => {
    expect(exported("export type Shape = number;\nexport const f = (s: Shape) => s;\n")).toEqual([]);
  });

  test("a type named only in a comment, or only by itself, is dead", () => {
    expect(exported("export type Shape = number;\n// Shape is explained here\nexport const f = 1;\n")).toEqual([dead("Shape")]);
    expect(exported("export type Node = { readonly next: Node | undefined };\nexport const f = 1;\n")).toEqual([dead("Node")]);
  });
});

describe("long declarations: measured by the node, whatever its indentation", () => {
  const importing0 = { "a.test.ts": "import { f } from \"./a.ts\"; f;\n" };
  const body = (count: number, indent = "  "): string => Array.from({ length: count }, (_, index) => `${indent}const v${index} = ${index};`).join("\n");
  const long = (head: string, close: string, name: string, indent = "  "): readonly string[] =>
    failing({ "a.ts": `${head}\n${body(60, indent)}\n${close}\n`, "a.test.ts": `import { ${name} } from "./a.ts"; ${name};\n` });
  const LONG = ["long-declaration kernel/a.ts"];

  test("an async function, an interface, an enum and a const are measured", () => {
    expect(long("export async function f() {", "}", "f")).toEqual(LONG);
    expect(long("export function* f() {", "}", "f")).toEqual(LONG);
    expect(long("export const f = () => {", "};", "f")).toEqual(LONG);
    expect(failing({ "a.ts": `export interface I {\n${Array.from({ length: 60 }, (_, index) => `  readonly k${index}: number;`).join("\n")}\n}\n`, "a.test.ts": "import type { I } from \"./a.ts\"; export type J = I;\n" })).toContain("long-declaration kernel/a.ts");
  });

  test("an enum, a class and a plain declare are measured too", () => {
    const fields = (make: (index: number) => string): string => Array.from({ length: 60 }, (_, index) => make(index)).join("\n");
    const only = (text: string): readonly string[] => failing({ "a.ts": text, "a.test.ts": "import { f } from \"./a.ts\"; f;\n" }).filter((row) => row.startsWith("long-declaration"));
    expect(only(`enum E {\n${fields((index) => `  K${index},`)}\n}\nexport const f = 1;\n`)).toEqual(LONG);
    expect(only(`class C {\n${fields((index) => `  readonly k${index} = ${index};`)}\n}\nexport const f = 1;\n`)).toEqual(LONG);
    expect(only(`declare const big: {\n${fields((index) => `  readonly k${index}: number;`)}\n};\nexport const f = 1;\n`)).toEqual(LONG);
  });

  test("a declaration that is not exported is measured like one that is", () => {
    const plain = (text: string): readonly string[] => failing({ "a.ts": `${text}export const f = 1;\n`, "a.test.ts": "import { f } from \"./a.ts\"; f;\n" }).filter((row) => row.startsWith("long-declaration"));
    const fields = Array.from({ length: 60 }, (_, index) => `  readonly k${index}: number;`).join("\n");
    expect(plain(`function g() {\n${body(60)}\n}\n`)).toEqual(LONG);
    expect(plain(`function* g() {\n${body(60)}\n}\n`)).toEqual(LONG);
    expect(plain(`const g = () => {\n${body(60)}\n};\n`)).toEqual(LONG);
    expect(plain(`type G = {\n${fields}\n};\n`)).toEqual(LONG);
  });

  test("an interface that is not exported is measured like one that is", () => {
    const fields = Array.from({ length: 60 }, (_, index) => `  readonly k${index}: number;`).join("\n");
    expect(failing({ "a.ts": `interface I {\n${fields}\n}\nexport const f = 1;\n`, ...importing0 })).toEqual(LONG);
  });

  test("a function whose body starts in column 0 is measured to its closing brace", () => {
    expect(long("export const f = () => {", "};", "f", "")).toEqual(LONG);
  });

  test("a union whose members start in column 0 is measured to its end", () => {
    const members = Array.from({ length: 60 }, (_, index) => `| "m${index}"`).join("\n");
    expect(failing({ "a.ts": `export type U =\n${members};\n`, "a.test.ts": "import type { U } from \"./a.ts\"; export type V = U;\n" })).toContain("long-declaration kernel/a.ts");
  });

  test("a column-0 comment in the body does not end the declaration", () => {
    const text = `export const f = () => {\n${body(30)}\n// a comment at column 0\n/**\n * a block comment at column 0\n */\n${body(30)}\n};\n`;
    expect(failing({ "a.ts": text, ...importing0 })).toEqual(LONG);
  });

  test("a template literal whose lines start in column 0 does not end the declaration", () => {
    const text = `export const f = () => {\n${body(30)}\n  const t = \`\nstarts at column 0\n}\n;\n\`;\n${body(30)}\n};\n`;
    expect(failing({ "a.ts": text, ...importing0 })).toEqual(LONG);
  });

  test("a declaration of 50 lines is not a hit and one of 51 is; a long comment block does not make a short function long", () => {
    const fn = (inner: number): Readonly<Record<string, string>> => ({ "a.ts": `export const f = () => {\n${body(inner)}\n};\n`, ...importing0 });
    expect(failing(fn(48))).toEqual([]);
    expect(failing(fn(49))).toEqual(LONG);
    expect(failing({ "a.ts": `${"// c\n".repeat(80)}export const f = () => 1;\n`, ...importing0 })).toEqual([]);
  });
});

describe(".mts and .tsx sources are gated like .ts", () => {
  test("a throw and a dead export in an .mts file fail by name", () => {
    const files = { "m.mts": "export const m = () => { throw new Error(\"x\"); };\nexport const dead = 1;\n", "m.test.mts": "import { m } from \"./m.mts\"; m;\n" };
    expect(failing(files)).toEqual(["no-throw kernel/m.mts", "unreachable kernel/m.mts (dead)"]);
  });

  test("a throw, a long line and a dead export in a .tsx file fail by name", () => {
    const text = `export const t = () => <div>{"${"x".repeat(130)}"}</div>;\nexport const dead = 1;\nexport const u = () => { throw new Error("x"); };\n`;
    const files = { "t.tsx": text, "t.test.tsx": "import { t, u } from \"./t.tsx\"; t; u;\n" };
    expect(failing(files)).toEqual(["long-line kernel/t.tsx", "no-throw kernel/t.tsx", "unreachable kernel/t.tsx (dead)"]);
  });

  test("a tree of .tsx files only is scanned: a clean one passes and the canary runs for both languages", () => {
    expect(failing({ "t.tsx": "export const t = () => <div />;\n", "t.test.tsx": "import { t } from \"./t.tsx\"; t;\n" })).toEqual([]);
  });
});

describe("a layer written as a single file", () => {
  const bad = "export const entity = () => { throw new Error(\"x\"); };\n";

  test("a source file directly under pure/ that is neither gated nor named outside the gate is a failing row", () => {
    expect(offRows(scratch({}, {}, { "entity.ts": bad }))).toContain("unlisted-file entity.ts");
  });

  test("once it is a gated entry its sources are read like a directory's", () => {
    const rows = treeStyle(scratch({}, {}, { "entity.ts": bad }), ["kernel", "chain", "entity.ts"]).rows.filter(isOff).map((row) => `${row.rule} ${row.file}`);
    expect(rows).toContain("no-throw entity.ts");
    expect(rows).not.toContain("unlisted-file entity.ts");
  });

  test("the named top-level files and non-source files are not flagged", () => {
    expect(offRows(scratch({}, {}, { "xln.ts": bad, "package.json": "{}" }))).toEqual([]);
  });
});
