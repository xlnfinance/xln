// R-OOG: out-of-gas is never a normal outcome (contracts-decisions.md, "Swallowed failures"). Every try/catch and every low-level call in the deployed
// contracts is a place where a failed callee can be read as something else, and a callee that fails for want of gas is the relayer's choice. Each
// one was audited once (the table in the decisions doc says what became of it). This fails when a new one appears or an audited one goes away, so
// the next one is audited too: add its row to the decisions doc, put a gas guard or a test on it, then update the count here.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dir, "..", "..", "contracts");
const TEST_ONLY = /(^|\/)mocks\/|Mock\.sol$/;

const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? sources(p) : e.name.endsWith(".sol") ? [p] : [];
  });

const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

/** try/catch, `x.call/.staticcall/.delegatecall`, and the assembly opcodes call, staticcall, delegatecall, callcode. */
const sites = (source: string): number => {
  const s = stripComments(source);
  const count = (re: RegExp) => (s.match(re) ?? []).length;
  return count(/\btry\b/g) + count(/\.(call|staticcall|delegatecall)\b/g) + count(/(?<![.\w])(call|staticcall|delegatecall|callcode)\s*\(/g);
};

/** file -> audited sites. Account 5: try (counterparty hanko, reverts E4), the 30k supply read, the pull-clause probe, the transformer call, the argument decoder.
 *  DeltaTransformer 2: the decode try/catch (guarded), the pull-reveal registry read. Depository 2: the token call, the batch self-call.
 *  EntityProvider 2: the two Depository reads of the control lane. HankoVerifier 1: the ERC-1271 member call. */
const AUDITED: Readonly<Record<string, number>> = {
  "Account.sol": 5,
  "DeltaTransformer.sol": 2,
  "Depository.sol": 2,
  "EntityProvider.sol": 2,
  "HankoVerifier.sol": 1,
};

describe("R-OOG swallowed failures: every try/catch and low-level call is audited", () => {
  test("the deployed contracts have exactly the audited sites", () => {
    const found = Object.fromEntries(
      sources(root)
        .filter((f) => !TEST_ONLY.test(path.relative(root, f)))
        .map((f) => [path.basename(f), sites(readFileSync(f, "utf8"))] as const)
        .filter(([, n]) => n > 0),
    );
    expect(found).toEqual(AUDITED);
  });
});
