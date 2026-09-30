// The counters that read text: what they count and what they must not be fooled by.
import { describe, expect, test } from "bun:test";
import { deadExports, exportsOf, longDeclarations, wordsOf } from "./counts.ts";

const dead = (text: string, others: readonly string[] = []): readonly string[] =>
  deadExports("k/a.ts", text, others.map(wordsOf)).map((hit) => hit.file);

describe("dead exports: prose is not a user, and every export form is seen", () => {
  test("a name in a comment or a string of another file is not a user", () => {
    expect(dead("export const lonely = 1;", ["// lonely", "const s = \"lonely\";", "/* lonely */ const t = `lonely`;"])).toHaveLength(1);
    expect(dead("export const used = 1;", ["used();"])).toHaveLength(0);
  });

  test("a type named once in its own file and again only in a comment is dead", () => {
    expect(dead("export type Shape = number;\n// Shape is explained here\n")).toHaveLength(1);
    expect(dead("export type Shape = number;\nexport const f = (s: Shape) => s;\n", ["f();"])).toHaveLength(0);
  });

  test("async function, interface, enum, let and declared forms are exports too", () => {
    const forms = [
      "export async function gone() {}", "export function* gone2() {}", "export interface Gone3 { x: number }",
      "export enum Gone4 { A }", "export let gone5 = 1;", "export declare const gone6: number;",
    ];
    forms.forEach((form) => expect(exportsOf(form)).toHaveLength(1));
    forms.forEach((form) => expect(dead(form)).toHaveLength(1));
  });

  test("an export list names what it exports by the alias, and a re-export list too", () => {
    expect(exportsOf("const hidden = 1;\nexport { hidden as shown, other };").map((each) => each.name)).toEqual(["shown", "other"]);
    expect(dead("const hidden = 1;\nexport { hidden as shown };", ["shown();"])).toHaveLength(0);
    expect(dead("const hidden = 1;\nexport { hidden as shown };")).toHaveLength(1);
  });
});

describe("long declarations: every shape is measured to its end", () => {
  const body = (count: number): string => Array.from({ length: count }, (_, index) => `  const v${index} = ${index};`).join("\n");
  const long = (head: string, close = "}"): readonly unknown[] => longDeclarations("k/a.ts", `${head}\n${body(60)}\n${close}\n`);

  test("an async function, an interface and an enum are measured like a const", () => {
    expect(long("export async function f() {")).toHaveLength(1);
    expect(long("export interface I {")).toHaveLength(1);
    expect(long("export enum E {")).toHaveLength(1);
    expect(long("export const f = () => {", "};")).toHaveLength(1);
  });

  test("a column-0 comment in the body does not end the declaration", () => {
    const text = `export const f = () => {\n${body(30)}\n// a comment at column 0\n/**\n * a block comment at column 0\n */\n${body(30)}\n};\n`;
    expect(longDeclarations("k/a.ts", text)).toHaveLength(1);
  });

  test("a template literal whose lines start in column 0 does not end the declaration", () => {
    const text = `export const f = () => {\n${body(30)}\n  const t = \`\nstarts at column 0\n}\n;\n\`;\n${body(30)}\n};\n`;
    expect(longDeclarations("k/a.ts", text)).toHaveLength(1);
  });

  test("a short declaration is not a hit, and a long comment block does not make a short function long", () => {
    expect(longDeclarations("k/a.ts", `export const f = () => {\n${body(10)}\n};\n`)).toHaveLength(0);
    const commented = `// ${"c".repeat(10)}\n`.repeat(80);
    expect(longDeclarations("k/a.ts", `${commented}export const f = () => 1;\n`)).toHaveLength(0);
  });
});
