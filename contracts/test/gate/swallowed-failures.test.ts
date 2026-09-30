// R-OOG: out-of-gas is never a normal outcome (contracts-decisions.md, "Swallowed failures"). Every try/catch and every low-level call in the compiled
// contracts is a place where a failed callee can be read as something else, and a callee that fails for want of gas is the relayer's choice. Each one
// was audited once (the table in the decisions doc says what became of it). This fails when a new one appears or an audited one goes away or moves, so
// the next one is audited too: add its row to the decisions doc, put a gas guard or a test on it, then change the list here.
//
// The sites are read from the COMPILED AST (hardhat's build-info), not from the source text, and compared as places: (source, function, opcode), not counts.
// The text scan this replaces was fooled by string literals that look like comments, missed `.send` and Yul `create`, kept its count when one site was swapped for
// another in the same file, and never saw library code. The AST has none of those problems and includes the imported OpenZeppelin code that ships in the bytecode.
// Run `bash scripts/build.sh` first: a build that does not match the sources on disk fails here instead of being trusted.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import solc from "solc";

const contractsDir = path.join(import.meta.dir, "..", "..");
const sourcesDir = path.join(contractsDir, "contracts");
const buildInfoDir = path.join(contractsDir, "artifacts", "build-info");
const TEST_ONLY = /(^|\/)mocks\/|Mock\.sol$/;

const LOW_LEVEL_MEMBERS = new Set(["call", "staticcall", "delegatecall", "send"]);
const YUL_CALLS = new Set(["call", "staticcall", "delegatecall", "callcode", "create", "create2"]);

type Node = { nodeType?: string; [key: string]: any };

/** The swallow-capable kind of one AST node, if it is one: try/catch, `x.call/.staticcall/.delegatecall/.send`, or a Yul call or create opcode. */
const siteOf = (node: Node): string | undefined => {
  if (node.nodeType === "TryStatement") return "try";
  if (node.nodeType === "FunctionCall") {
    const callee = node.expression?.nodeType === "FunctionCallOptions" ? node.expression.expression : node.expression;
    return callee?.nodeType === "MemberAccess" && LOW_LEVEL_MEMBERS.has(callee.memberName) ? callee.memberName : undefined;
  }
  if (node.nodeType === "YulFunctionCall" && YUL_CALLS.has(node.functionName?.name)) return `yul:${node.functionName.name}`;
  return undefined;
};

/** Every site under `node`, named by its enclosing function ("<function>: <site>"; constructors, fallback and receive by their kind). */
const sitesUnder = (node: unknown, where: string): string[] => {
  if (Array.isArray(node)) return node.flatMap((child) => sitesUnder(child, where));
  if (node === null || typeof node !== "object") return [];
  const here = (node as Node).nodeType === "FunctionDefinition" || (node as Node).nodeType === "ModifierDefinition" ? (node as Node).name || (node as Node).kind : where;
  const own = siteOf(node as Node);
  return [...(own ? [`${here}: ${own}`] : []), ...Object.values(node).flatMap((child) => sitesUnder(child, here))];
};

/** "<source>: <function>: <site>" for every site in every source unit of a compiler output's `sources`, sorted. */
const placesIn = (sources: Record<string, { ast: Node }>): string[] =>
  Object.entries(sources)
    .flatMap(([name, unit]) => sitesUnder(unit.ast, "?").map((site) => `${name}: ${site}`))
    .sort();

const disk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? disk(p) : e.name.endsWith(".sol") ? [p] : [];
  });

/** The deployed sources' ASTs from the build-info whose input matches the files on disk; a project source with no matching build is an error, not a pass. */
const deployedSources = (): Record<string, { ast: Node }> => {
  const outputs = readdirSync(buildInfoDir).filter((f) => f.endsWith(".output.json"));
  const builds = outputs.map((file) => ({
    input: JSON.parse(readFileSync(path.join(buildInfoDir, file.replace(/\.output\.json$/, ".json")), "utf8")).input.sources as Record<string, { content: string }>,
    output: JSON.parse(readFileSync(path.join(buildInfoDir, file), "utf8")).output.sources as Record<string, { ast: Node }>,
  }));
  const onDisk = (name: string): string => path.join(contractsDir, name.slice("project/".length));
  const fresh = (name: string, build: (typeof builds)[number]): boolean =>
    !name.startsWith("project/") || (existsSync(onDisk(name)) && build.input[name]?.content === readFileSync(onDisk(name), "utf8"));
  const picked = new Map<string, { ast: Node }>();
  for (const build of builds)
    for (const [name, unit] of Object.entries(build.output)) if (!picked.has(name) && fresh(name, build)) picked.set(name, unit);
  const missing = disk(sourcesDir)
    .map((file) => `project/${path.relative(contractsDir, file)}`)
    .filter((name) => !TEST_ONLY.test(name) && !picked.has(name));
  expect(missing, "sources with no matching build in artifacts/build-info: run `bash scripts/build.sh`").toEqual([]);
  return Object.fromEntries([...picked].filter(([name]) => !TEST_ONLY.test(name)));
};

/** The audited places, one line per site (a function with two sites of one kind lists it twice). The decisions doc has a row for each. */
const AUDITED: readonly string[] = [
  // Account: the counterparty hanko (catch reverts E4), the 30,000-gas token supply read, the pull-clause probe (failure reverts), the transformer call (failure reverts;
  // all gas but 2,000,000), the transformer-argument decoder (500,000-gas cap, guarded by `gasleft() > 2,500,000`).
  "project/contracts/Account.sol: _applyTransformer: yul:staticcall",
  "project/contracts/Account.sol: _decodeTransformerArgumentList: staticcall",
  "project/contracts/Account.sol: _proofBodyContainsPull: staticcall",
  "project/contracts/Account.sol: _readFixedTokenSupply: yul:staticcall",
  "project/contracts/Account.sol: _requireCounterpartySignature: try",
  // DeltaTransformer: the evidence decode (guarded: fast-path floor plus the post-catch check) and the pull-reveal registry read (failure reverts).
  "project/contracts/DeltaTransformer.sol: _decodeArguments: try",
  "project/contracts/DeltaTransformer.sol: applyPull: staticcall",
  // Depository: the token call (E3 revert, balances checked after) and the batch self-call (J5: BatchFailed at the signed budget).
  "project/contracts/Depository.sol: _safeERC20Call: call",
  "project/contracts/Depository.sol: processBatch: yul:call",
  // EntityProvider: the one gas-capped, one-word, never-copied read of a listed Depository on the control lane (a failed read contributes zero support).
  "project/contracts/EntityProvider.sol: _readDepositoryWord: yul:staticcall",
  // HankoVerifier: the gas-capped ERC-1271 member call (invalid at the verifier, a revert at every consumer).
  "project/contracts/HankoVerifier.sol: _validateMemberSignatures: yul:staticcall",
  // OpenZeppelin, in the bytecode through the share token and the NFT custody. The receiver-acceptance try/catch rethrows every failure (a revert, not a swallow);
  // Math.tryModExp is the modexp precompile and is never called by our code.
  "npm/@openzeppelin/contracts@5.6.1/token/ERC1155/utils/ERC1155Utils.sol: checkOnERC1155BatchReceived: try",
  "npm/@openzeppelin/contracts@5.6.1/token/ERC1155/utils/ERC1155Utils.sol: checkOnERC1155Received: try",
  "npm/@openzeppelin/contracts@5.6.1/token/ERC721/utils/ERC721Utils.sol: checkOnERC721Received: try",
  "npm/@openzeppelin/contracts@5.6.1/utils/math/Math.sol: tryModExp: yul:staticcall",
  "npm/@openzeppelin/contracts@5.6.1/utils/math/Math.sol: tryModExp: yul:staticcall",
];

describe("R-OOG swallowed failures: every try/catch and low-level call is audited", () => {
  test("the deployed contracts have exactly the audited sites, in the audited places", () => {
    expect(placesIn(deployedSources())).toEqual([...AUDITED].sort());
  });
});

// The scan itself, attacked with the shapes that fooled the text counter (reviewer B, RB-2 to RB-6; reviewer A, F4): compiled from a fixture.
describe("the AST scan sees what the text counter missed", () => {
  const compile = (content: string): string[] => {
    const out = JSON.parse(solc.compile(JSON.stringify({ language: "Solidity", sources: { "F.sol": { content } }, settings: { outputSelection: { "*": { "": ["ast"] } } } })));
    expect(out.errors?.filter((e: { severity: string }) => e.severity === "error") ?? []).toEqual([]);
    return placesIn(out.sources);
  };
  const HEAD = "pragma solidity ^0.8.24; interface I { function g() external; } contract F {";

  test("try, call, staticcall, delegatecall, send, call with options", () => {
    expect(
      compile(`${HEAD}
        function a(I x) external { try x.g() {} catch {} }
        function b(address x) external { (bool ok,) = x.call(""); ok; }
        function c(address x) external view { (bool ok,) = x.staticcall(""); ok; }
        function d(address x) external { (bool ok,) = x.delegatecall(""); ok; }
        function e(address payable x) external { bool ok = x.send(1); ok; }
        function f(address x) external { (bool ok,) = x.call{gas: 5}(""); ok; }
      }`),
    ).toEqual(["F.sol: a: try", "F.sol: b: call", "F.sol: c: staticcall", "F.sol: d: delegatecall", "F.sol: e: send", "F.sol: f: call"]);
  });

  test("Yul call opcodes and create/create2 (return 0 on failure)", () => {
    expect(
      compile(`${HEAD}
        function y(bytes memory c) external returns (address r) {
          assembly { r := create(0, add(c, 0x20), mload(c)) r := create2(0, add(c, 0x20), mload(c), 1) pop(staticcall(1, r, 0, 0, 0, 0)) }
        }
      }`),
    ).toEqual(["F.sol: y: yul:create", "F.sol: y: yul:create2", "F.sol: y: yul:staticcall"]);
  });

  test("string literals that look like comments hide nothing, and the word try inside a string is no site", () => {
    expect(
      compile(`${HEAD}
        string constant S = "/*";
        function a(address x) external { string memory u = "http://x try"; (bool ok,) = x.call(""); ok; u; }
        function b(address x) external view { (bool ok,) = x.staticcall(""); ok; }
        /* a real comment with x.call("") in it */
      }`),
    ).toEqual(["F.sol: a: call", "F.sol: b: staticcall"]);
  });

  test("swapping an audited site for another of a different kind in the same function changes the list (the old gate kept its count)", () => {
    const audited = compile(`${HEAD} function f(I x) external { try x.g() {} catch {} } }`);
    const swapped = compile(`${HEAD} function f(address x) external { (bool ok,) = x.call(""); ok; } }`);
    expect(swapped.length).toBe(audited.length);
    expect(swapped).not.toEqual(audited);
  });
});
