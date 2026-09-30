// Quint checks: a `run` (a scenario that quint executes) and an invariant a check script passes to
// `quint run --invariant`. A `val`, `def` or `action` is model code, not a check. Mutants are named by id and by
// the rule their `why` opens with.
import { SLASH_LANGUAGES, lex } from "./source.ts";

export const runNames = (source: string): readonly string[] =>
  [...lex(source, SLASH_LANGUAGES).code.matchAll(/^\s*run\s+(\w+)/gm)].map((found) => found[1] ?? "");

export const invariantNames = (script: string): readonly string[] =>
  [...script.matchAll(/--invariant(?:=|\s+)(\w+)/g)].map((found) => found[1] ?? "");
