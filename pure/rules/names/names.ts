// Reads the NAMES of things that check: test titles, Foundry functions, property strings, planted-bug and
// mutant names, file names. Only checks that run count; a comment or a string never does. A check that only
// mentions its rule proves nothing.
import type { Layer, Name, NameKind } from "../model.ts";
import { foundryChecks } from "./solidity.ts";
import { invariantNames, runNames } from "./quint.ts";
import { propertyNames } from "./scheme.ts";
import { runnableTitles } from "./typescript.ts";

const named = (layer: Layer, kind: NameKind, file: string, texts: readonly string[]): readonly Name[] =>
  texts.map((text) => ({ layer, kind, text, file }));

const baseName = (file: string): string =>
  (file.split("/").pop() ?? file).replace(/\.[^.]+$/, "").replace(/\.test$|\.t$/, "");

const extension = (file: string): string => file.split(".").pop() ?? "";

export const hasTestShape = (file: string): boolean => /\.(?:test\.(?:ts|mjs|js)|t\.sol)$/.test(file);

// A test file's own name is a name too (j5-batch-failed.test.ts carries J5), but only when the file holds at least
// one check that runs: an empty file named after a rule carries nothing.
export const testFileNames = (layer: Layer, file: string, source: string): readonly Name[] => {
  if (extension(file) === "sol") {
    const { contracts, functions } = foundryChecks(source);
    return functions.length === 0
      ? []
      : [
          ...named(layer, "file", file, [baseName(file)]),
          ...named(layer, "contract", file, contracts),
          ...named(layer, "function", file, functions),
        ];
  }
  const titles = runnableTitles(source);
  return titles.length === 0 ? [] : [...named(layer, "file", file, [baseName(file)]), ...named(layer, "title", file, titles)];
};

export const arrivalNames = (file: string, source: string): readonly Name[] => {
  const kind: NameKind = file.includes("/bugs/") ? "bug" : "file";
  return [...named("arrival", kind, file, [baseName(file)]), ...named("arrival", "property", file, propertyNames(source))];
};

type MutantFile = Readonly<{ mutants?: readonly Readonly<{ id?: string; why?: string }>[] }>;

// A Quint mutant file lists { id, why }. The id is its name; a `why` that opens with "R-A1:" tags its rule.
const mutantNames = (file: string, parsed: MutantFile): readonly Name[] =>
  (parsed.mutants ?? []).flatMap((mutant) => {
    const tag = /^([A-Z][A-Za-z0-9-]*):/.exec(mutant.why ?? "")?.[1];
    return named("quint", "mutant", file, [mutant.id ?? "", ...(tag === undefined ? [] : [tag])]);
  });

// The one place a JSON parse may throw; a file that is not JSON has no mutants.
const parseMutants = (text: string): MutantFile => {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
};

export const quintNames = (file: string, text: string): readonly Name[] => {
  if (file.endsWith(".json")) return mutantNames(file, parseMutants(text));
  if (file.endsWith(".sh")) return named("quint", "invariant", file, invariantNames(text));
  return named("quint", "run", file, runNames(text));
};

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
