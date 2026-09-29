import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseEbnf, type Grammar } from "./match.js";

/** Public specifier — the test load path IS the package export. */
export const GRAMMAR_EXPORT = "@inhuman.tools/arrival/grammar.ebnf";

let cached: Grammar | undefined;

export function ebnfHref(): string {
  return import.meta.resolve(GRAMMAR_EXPORT);
}

export function ebnfPath(): string {
  return fileURLToPath(ebnfHref());
}

export function ebnfSource(): string {
  return readFileSync(ebnfPath(), "utf8");
}

export function arrivalGrammar(): Grammar {
  cached ??= parseEbnf(ebnfSource());
  return cached;
}
