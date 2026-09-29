// N3: the deploy gate refuses the testnet response-window floor on any chain that is not a named testnet, on every
// deploy path, reading the floor from the compiled build.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
// @ts-expect-error CommonJS script without types
import gate from "../../scripts/deploy-gate.cjs";

const contractsRoot = path.join(import.meta.dir, "..", "..");
const literal = (value: string, subdenomination: string | null = null) => ({ nodeType: "Literal", kind: "number", value, subdenomination });
const constantAst = (value: unknown) => ({ nodeType: "SourceUnit", nodes: [{ nodeType: "ContractDefinition", nodes: [{ nodeType: "VariableDeclaration", name: "MIN_RESPONSE_SECONDS", constant: true, value }] }] });
const named = (chainId: number, id = "chain") => ({ id, chainId });
const floorOf = (seconds: number | null) => () => seconds as number;

describe("the floor is read from solc's AST", () => {
  test("literals, units and arithmetic", () => {
    expect(gate.floorFromAst(constantAst(literal("60")))).toBe(60);
    expect(gate.floorFromAst(constantAst(literal("6", "hours")))).toBe(21600);
    expect(gate.floorFromAst(constantAst({ nodeType: "BinaryOperation", operator: "*", leftExpression: literal("6"), rightExpression: literal("3_600") }))).toBe(21600);
  });

  test("anything that is not a plain constant is unknown, not zero", () => {
    expect(gate.floorFromAst(constantAst({ nodeType: "FunctionCall" }))).toBeNull();
    expect(gate.floorFromAst({ nodeType: "SourceUnit", nodes: [] })).toBeNull();
  });

  test("the real compiled build says 60 (the testnet value)", () => {
    expect(gate.readCompiledFloor()).toBe(60);
  });

  test("a build-info whose recorded sources differ from disk is stale and refused, however low or high its floor", () => {
    const root = mkdtempSync(path.join(tmpdir(), "gate-"));
    mkdirSync(path.join(root, "contracts"));
    mkdirSync(path.join(root, "artifacts", "build-info"), { recursive: true });
    writeFileSync(path.join(root, "contracts", "Account.sol"), "// edited after the build\n");
    const info = path.join(root, "artifacts", "build-info");
    writeFileSync(path.join(info, "x.json"), JSON.stringify({ input: { sources: { "project/contracts/Account.sol": { content: "// what was compiled\n" } } } }));
    writeFileSync(path.join(info, "x.output.json"), JSON.stringify({ output: { sources: { "project/contracts/Account.sol": { ast: constantAst(literal("6", "hours")) } } } }));
    expect(() => gate.readCompiledFloor(root)).toThrow(/no compiled build matches/);
    writeFileSync(path.join(root, "contracts", "Account.sol"), "// what was compiled\n");
    expect(gate.readCompiledFloor(root)).toBe(21600);
  });
});

describe("the gate is keyed by chain id", () => {
  test("named testnets and local nets may carry the testnet floor", () => {
    expect(gate.assertResponseFloor([named(31337), named(11155111), named(84532), named(3448148188)], floorOf(60))).toBeNull();
  });

  test("a mainnet is refused below the mainnet floor, and a mixed selection is refused as a whole", () => {
    expect(() => gate.assertResponseFloor([named(1, "ethereum-mainnet")], floorOf(60))).toThrow(/below the mainnet floor/);
    expect(() => gate.assertResponseFloor([named(8453, "base-mainnet")], floorOf(60))).toThrow(/base-mainnet/);
    expect(() => gate.assertResponseFloor([named(11155111), named(1)], floorOf(60))).toThrow(/\(1\)/);
  });

  test("a testnet-looking name on a mainnet id does not pass", () => {
    expect(() => gate.assertResponseFloor([named(1, "ethereum-sepolia")], floorOf(60))).toThrow(/below the mainnet floor/);
  });

  test("a mainnet passes at or above the mainnet floor", () => {
    expect(gate.assertResponseFloor([named(1)], floorOf(21600))).toBe(21600);
    expect(gate.assertResponseFloor([named(1)], floorOf(172800))).toBe(172800);
  });

  test("an unknown or unreadable floor fails closed on a mainnet and never blocks a testnet", () => {
    expect(() => gate.assertResponseFloor([named(1)], floorOf(null))).toThrow(/not a plain constant/);
    expect(() => gate.assertResponseFloor([named(1)], () => { throw new Error("stale"); })).toThrow(/cannot establish/);
    expect(gate.assertResponseFloor([named(31337)], () => { throw new Error("stale"); })).toBeNull();
  });
});

describe("every deploy path goes through the gate", () => {
  test("a script that deploys or broadcasts must reference the gate (a new script cannot skip it silently)", () => {
    const sinks = /\.deploy\(|getContractFactory\(|broadcastTronTransaction\(|deployContract\(|sendTransaction\(/;
    const scripts = readdirSync(path.join(contractsRoot, "scripts")).filter((name) => /\.(cjs|ts|js|mjs)$/.test(name) && name !== "deploy-gate.cjs");
    const deployers = scripts.filter((name) => sinks.test(readFileSync(path.join(contractsRoot, "scripts", name), "utf8")));
    expect(deployers.sort()).toEqual(["deploy-chain-matrix.cjs", "deploy-stack.cjs"]);
    deployers.forEach((name) => expect(readFileSync(path.join(contractsRoot, "scripts", name), "utf8")).toContain("deploy-gate.cjs"));
  });

  const run = (args: string[], command = "bun") => spawnSync(command, args, {
    cwd: contractsRoot, encoding: "utf8", timeout: 240_000,
    env: { ...process.env, DEPLOYER_PRIVATE_KEY: "", ETH_MAINNET_RPC: "", ETH_SEPOLIA_RPC: "", HARDHAT_EXPERIMENTAL_ALLOW_NON_LOCAL_INSTALLATION: "true" },
  });

  test("deploy-chain-matrix.cjs refuses mainnet before any key or network use", () => {
    const result = run(["scripts/deploy-chain-matrix.cjs", "--profile=mainnet", "--dry-run"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Deploy gate: MIN_RESPONSE_SECONDS is 60s");
  });

  test("deploy-chain-matrix.cjs refuses --skip-compile on a mainnet", () => {
    const result = run(["scripts/deploy-chain-matrix.cjs", "--profile=mainnet", "--dry-run", "--skip-compile"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("--skip-compile is refused");
  });

  test("deploy-stack.cjs lets a local network through the gate (it stops later, on the missing stablecoin address)", () => {
    const result = run(["--bun", "hardhat", "run", "scripts/deploy-stack.cjs", "--network", "hardhat"], "bunx");
    expect(`${result.stdout}${result.stderr}`).not.toContain("Deploy gate");
  });

  test.each(["ethereum-mainnet", "base-mainnet"])("deploy-stack.cjs refuses --network %s before any RPC call", (network) => {
    const result = run(["--bun", "hardhat", "run", "scripts/deploy-stack.cjs", "--network", network], "bunx");
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("Deploy gate: MIN_RESPONSE_SECONDS is 60s");
  });
});
