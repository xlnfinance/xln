// Foundry checks that forge runs: public or external `test*` and `invariant*` functions in a concrete contract
// that inherits a test base. Internal and private functions, abstract contracts, `check*` and `prove*` prefixes (forge
// does not run them) and anything in a comment or string do not count.
import { SLASH_LANGUAGES, closeOf, depthsBefore, lex } from "./source.ts";

const CONTRACT = /(abstract\s+)?contract\s+(\w+)([^{;]*)\{/g;
const FUNCTION = /function\s+(\w+)\s*\([^)]*\)([^{;]*)\{/g;
const FORGE_PREFIX = /^(?:test|invariant)/;

const runsUnderForge = (modifiers: string): boolean =>
  /\b(?:public|external)\b/.test(modifiers) && !/\b(?:internal|private)\b/.test(modifiers);

// The fixtures (XlnFixture, StdInvariant) inherit Test themselves, so any inheriting concrete contract may hold tests.
const inherits = (header: string): boolean => /\bis\b/.test(header);

export type FoundryNames = Readonly<{ contracts: readonly string[]; functions: readonly string[] }>;

export const foundryChecks = (source: string): FoundryNames => {
  const { code } = lex(source, SLASH_LANGUAGES);
  const depths = depthsBefore(code);
  const functions = [...code.matchAll(FUNCTION)];
  const concrete = [...code.matchAll(CONTRACT)]
    .filter((found) => found[1] === undefined && inherits(found[3] ?? ""))
    .map((found) => ({ name: found[2] ?? "", open: found.index + found[0].length - 1 }))
    .map((found) => ({ ...found, close: closeOf(depths, found.open) }));
  const tests = concrete.map((contract) => ({
    contract: contract.name,
    names: functions
      .filter((found) => found.index > contract.open && found.index < contract.close)
      .filter((found) => depths[found.index] === (depths[contract.open] ?? 0) + 1)
      .filter((found) => FORGE_PREFIX.test(found[1] ?? "") && runsUnderForge(found[2] ?? ""))
      .map((found) => found[1] ?? ""),
  }));
  const running = tests.filter((each) => each.names.length > 0);
  return { contracts: running.map((each) => each.contract), functions: running.flatMap((each) => each.names) };
};
