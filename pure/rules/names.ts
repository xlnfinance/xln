// Reads the NAMES of things that check: test titles, Foundry functions, property strings, planted-bug and
// mutant names, file names. A comment never counts: a check that only mentions its rule proves nothing.
import type { Layer, Name, NameKind } from "./model.ts";

type Extract = (text: string) => readonly string[];

const matches = (pattern: RegExp, group: number): Extract => (text) =>
  [...text.matchAll(pattern)].map((found) => found[group] ?? "");

// describe("..."), it("..."), test("...") and their .only/.skip forms; the title may use ', " or `.
const testTitles = matches(
  /\b(?:describe|it|test|context)(?:\.(?:only|skip|each))?\s*\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g,
  2,
);

const foundryFunctions = matches(/function\s+((?:test|invariant|prove|check)\w*)\s*\(/g, 1);
const solidityContracts = matches(/^\s*contract\s+(\w+)/gm, 1);

// Arrival pages name a property with a string: (property "..." ...), (step-property "..." ...).
const schemeProperties = matches(/\((?:step-property|property|liveness)\s+"((?:[^"\\]|\\.)*)"/g, 1);

const quintDefinitions = matches(/^\s*(?:pure\s+)?(?:run|val|def|action)\s+(\w+)/gm, 1);

// Comments never count. Whole-line and trailing comments go; a title with " // " inside it would lose its tail,
// which only ever removes a name, never invents one.
const withoutSlashComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");

const withoutSchemeComments = (text: string): string => text.replace(/(^|\s);.*$/gm, "$1");

const named = (layer: Layer, kind: NameKind, file: string, texts: readonly string[]): readonly Name[] =>
  texts.map((text) => ({ layer, kind, text, file }));

const baseName = (file: string): string => (file.split("/").pop() ?? file).replace(/\.[^.]+$/, "").replace(/\.test$|\.t$/, "");

const extension = (file: string): string => file.split(".").pop() ?? "";

const isTestFile = (file: string): boolean => /\.(?:test\.(?:ts|mjs|js)|t\.sol)$/.test(file);

// A test file's own name is a name too: j5-batch-failed.test.ts carries J5.
export const testFileNames = (layer: Layer, file: string, source: string): readonly Name[] => {
  const text = withoutSlashComments(source);
  const fileName = named(layer, "file", file, [baseName(file)]);
  switch (extension(file)) {
    case "sol":
      return [
        ...fileName,
        ...named(layer, "contract", file, solidityContracts(text)),
        ...named(layer, "function", file, foundryFunctions(text)),
      ];
    default:
      return [...fileName, ...named(layer, "title", file, testTitles(text))];
  }
};

export const arrivalNames = (file: string, source: string): readonly Name[] => {
  const text = withoutSchemeComments(source);
  const isBug = file.includes("/bugs/");
  const properties = named("arrival", "property", file, schemeProperties(text));
  const fileName = named("arrival", isBug ? "bug" : "file", file, [baseName(file)]);
  return [...fileName, ...properties];
};

// A Quint mutant file lists { id, why }. The id is its name; a `why` that opens with "R-A1:" tags its rule.
export const quintMutantNames = (file: string, text: string): readonly Name[] => {
  const parsed: { readonly mutants?: readonly { readonly id?: string; readonly why?: string }[] } = JSON.parse(text);
  return (parsed.mutants ?? []).flatMap((mutant) => {
    const tag = /^([A-Z][A-Za-z0-9-]*):/.exec(mutant.why ?? "")?.[1];
    return named("quint", "mutant", file, [mutant.id ?? "", ...(tag === undefined ? [] : [tag])]);
  });
};

export const quintNames = (file: string, text: string): readonly Name[] =>
  file.endsWith(".json")
    ? quintMutantNames(file, text)
    : named("quint", "def", file, quintDefinitions(withoutSlashComments(text)));

// Splits on anything that is not a letter or digit: "test_R_OOG_x", "R-OOG" and "j5-batch" all become tokens.
export const tokens = (text: string): readonly string[] => text.split(/[^A-Za-z0-9]+/).filter((token) => token !== "");

// Titles and property strings are prose and carry ids in capitals; the rest are identifiers in any case.
const caseSensitive = (kind: NameKind): boolean => kind === "title" || kind === "property";

const sameToken = (kind: NameKind, left: string, right: string): boolean =>
  caseSensitive(kind) ? left === right : left.toLowerCase() === right.toLowerCase();

// An id is carried when its tokens appear next to each other, so "J5" is in "j5-gas-exact" and "J5: fails",
// but not in "J50", and "R-CLOCK" is not in "R-HTLC-CLOCK".
export const carries = (id: string, name: Name): boolean => {
  const wanted = tokens(id);
  const have = tokens(name.text);
  return have.some((_, start) => wanted.every((token, offset) => {
    const at = have[start + offset];
    return at !== undefined && sameToken(name.kind, at, token);
  }));
};

export const hasTestShape = isTestFile;
