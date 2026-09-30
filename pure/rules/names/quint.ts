// Quint checks: a `run` (a scenario that quint executes) and an invariant a check script passes to
// `quint run --invariant`. A `val`, `def` or `action` is model code, not a check. Mutants are named by id and by
// the rule their `why` opens with.
import { MARK, SHELL_LANGUAGE, SLASH_LANGUAGES, lex } from "./source.ts";

export const runNames = (source: string): readonly string[] =>
  [...lex(source, SLASH_LANGUAGES).code.matchAll(/^\s*run\s+(\w+)/gm)].map((found) => found[1] ?? "");

// A comment and a quoted string are taken out first; a quoted word right after the flag is the name.
export const invariantNames = (script: string): readonly string[] => {
  const { code, strings } = lex(script, SHELL_LANGUAGE);
  const flag = new RegExp(`--invariant(?:=|\\s+)(?:(\\w+)|${MARK}(\\d+)${MARK})`, "g");
  return [...code.matchAll(flag)]
    .map((found) => found[1] ?? strings[Number(found[2])] ?? "")
    .filter((name) => /^\w+$/.test(name));
};
