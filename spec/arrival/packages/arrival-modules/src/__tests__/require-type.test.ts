// require-type.test.ts — the EDITOR twin of the require registry: a single
// extension registration teaches BOTH the runtime parse (`resolve`) and the
// lens shape (`type`). Pure synthesis, no LLM, no worker — just the loader.

import { describe, expect, it } from "vitest";

import {
  defaultResolvers,
  loaderFromResolver,
  resolveRequireType,
  valueToTsType,
  type ExtensionHandler,
  type Loader,
} from "../loader.js";

describe("valueToTsType — JS value → lens TS type", () => {
  it("maps scalars to plain TS natives (not SStr/SNum/SBool brands)", () => {
    expect(valueToTsType("x")).toBe("string");
    expect(valueToTsType(3)).toBe("number");
    expect(valueToTsType(true)).toBe("boolean");
    expect(valueToTsType(null)).toBe("null");
  });

  it("maps a plain object to an accessible record (quoted keys, recursive)", () => {
    expect(valueToTsType({ name: "a", age: 30 })).toBe(`{ "name": string; "age": number }`);
    expect(valueToTsType({ user: { id: 1 } })).toBe(`{ "user": { "id": number } }`);
  });

  it("maps an array to List<T> with a deduped element union", () => {
    expect(valueToTsType([1, 2, 3])).toBe("List<number>");
    expect(valueToTsType([{ name: "a", age: 1 }])).toBe(`List<{ "name": string; "age": number }>`);
    expect(valueToTsType([1, "x"])).toBe("List<(number | string)>");
    expect(valueToTsType([])).toBe("List<unknown>");
  });
});

describe("resolveRequireType — route a file's source through the registry", () => {
  const loader: Loader = loaderFromResolver(() => {
    throw new Error("read not used in type synthesis");
  });

  it("synthesizes the granular shape for a .json data file", () => {
    const ts = resolveRequireType(loader, "personas.json", `[{"name":"a","age":30}]`);
    expect(ts).toBe(`List<{ "name": string; "age": number }>`);
  });

  it("JSONC comments/trailing commas still yield the same granular shape", () => {
    const ts = resolveRequireType(loader, "personas.json", `// people roster\n[{"name":"a","age":30,},]\n`);
    expect(ts).toBe(`List<{ "name": string; "age": number }>`);
  });

  it(".txt is a string; .scm (no type provider) and unknown extensions are null", () => {
    expect(resolveRequireType(loader, "notes.txt", "hello")).toBe("string");
    expect(resolveRequireType(loader, "lib.scm", "(define x 1)")).toBeNull();
    expect(resolveRequireType(loader, "thing.bin", "...")).toBeNull();
  });

  it("a malformed data file degrades to null (lens falls back to unknown)", () => {
    expect(resolveRequireType(loader, "broken.json", "{not json")).toBeNull();
  });

  it("a custom extension registered with a `type` provider is reachable", () => {
    const custom: ExtensionHandler = {
      resolve: (contents) => ({ kind: "value", value: String(contents) }),
      type: () => `{ "csv": List<string> }`,
    };
    const customLoader: Loader = {
      ...loader,
      resolvers: new Map(defaultResolvers()).set(".csv", custom),
    };
    expect(resolveRequireType(customLoader, "rows.csv", "a,b\n1,2")).toBe(`{ "csv": List<string> }`);
  });
});
