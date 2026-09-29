// N3: the deploy gate refuses the testnet response-window floor on any chain that is not a named testnet, on every
// deploy path, reading the floor from the compiled build.
import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
// @ts-expect-error CommonJS script without types
import gate from "../../scripts/deploy-gate.cjs";
// @ts-expect-error CommonJS script without types
import matrixModule from "../../scripts/deploy-chain-matrix.cjs";

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

describe("every deploy path runs the gate", () => {
  const run = (args: string[], command = "bun") => spawnSync(command, args, {
    cwd: contractsRoot, encoding: "utf8", timeout: 240_000,
    env: { ...process.env, DEPLOYER_PRIVATE_KEY: "", ETH_MAINNET_RPC: "", ETH_SEPOLIA_RPC: "", HARDHAT_EXPERIMENTAL_ALLOW_NON_LOCAL_INSTALLATION: "true" },
  });
  const stack = (network: string) => () => run(["--bun", "hardhat", "run", "scripts/deploy-stack.cjs", "--network", network], "bunx");
  const matrix = (...flags: string[]) => () => run(["scripts/deploy-chain-matrix.cjs", "--profile=mainnet", "--dry-run", ...flags]);

  // Every script that can deploy needs at least one entry here that runs it against a chain id the gate must refuse.
  // Importing the gate is not enough: a script that never calls it fails its entry, and a new deploy script fails the
  // coverage test below until someone adds an entry for it.
  const entries: Record<string, ReadonlyArray<readonly [string, () => ReturnType<typeof run>]>> = {
    "deploy-chain-matrix.cjs": [
      ["mainnet profile, all chains", matrix()],
      ["mainnet profile, ethereum only", matrix("--chain=ethereum")],
      ["mainnet profile, tron only", matrix("--chain=tron")],
    ],
    "deploy-stack.cjs": [
      ["--network ethereum-mainnet (chain 1)", stack("ethereum-mainnet")],
      ["--network base-mainnet (chain 8453)", stack("base-mainnet")],
    ],
  };

  // Scripts that never deploy or broadcast. Each one is asserted below to match none of the sinks, so a script cannot
  // hide on this list after it grows a deploy path.
  const nonDeploying = ["build.sh", "compile-tron.cjs", "deploy-gate.cjs", "foundation-hanko.cjs", "generate-typechain.cjs", "write-vectors.ts"];
  const sinks = /\.deploy\(|getContractFactory\(|deployContract\(|createSmartContract\(|broadcastTronTransaction\(|broadcastTransaction\(|sendRawTransaction\(|sendHexTransaction\(|sendTransaction\(|eth_sendRawTransaction|eth_sendTransaction|\bcast (send|create)\b|forge (create|script)\b|hardhat (ignition|run)\b/;
  const scriptsRoot = path.join(contractsRoot, "scripts");
  const filesUnder = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? filesUnder(full) : [full];
  });
  const allScripts = filesUnder(scriptsRoot).map((file) => path.relative(scriptsRoot, file));

  test("every file under scripts/ has an entry that exercises it or is on the non-deploying list", () => {
    expect(allScripts.filter((file) => !(file in entries) && !nonDeploying.includes(file))).toEqual([]);
    expect(Object.keys(entries).filter((file) => !allScripts.includes(file))).toEqual([]);
    expect(nonDeploying.filter((file) => !allScripts.includes(file))).toEqual([]);
  });

  test("a script on the non-deploying list contains no deploy or broadcast call", () => {
    const offenders = nonDeploying.filter((file) => sinks.test(readFileSync(path.join(scriptsRoot, file), "utf8")));
    expect(offenders).toEqual([]);
  });

  test("every script with a deploy or broadcast call has an entry", () => {
    const deployers = allScripts.filter((file) => sinks.test(readFileSync(path.join(scriptsRoot, file), "utf8")));
    expect(deployers.filter((file) => !(file in entries))).toEqual([]);
    expect(Object.keys(entries).filter((file) => !deployers.includes(file))).toEqual([]);
  });

  test("no other deploy surface exists: no ignition or deploy directory, and package.json only runs listed scripts", () => {
    expect(existsSync(path.join(contractsRoot, "ignition"))).toBe(false);
    expect(existsSync(path.join(contractsRoot, "deploy"))).toBe(false);
    const { scripts } = JSON.parse(readFileSync(path.join(contractsRoot, "package.json"), "utf8")) as { scripts: Record<string, string> };
    const commands = Object.values(scripts);
    expect(commands.filter((command) => /hardhat ignition/.test(command))).toEqual([]);
    const referenced = commands.flatMap((command) => [...command.matchAll(/(?:^|[\s&;])(?:bun|node|bash|sh)\s+scripts\/([\w./-]+)/g)].map((match) => match[1]!)).filter((file) => existsSync(path.join(scriptsRoot, file)));
    expect(referenced.filter((file) => !(file in entries) && !nonDeploying.includes(file))).toEqual([]);
  });

  for (const [script, cases] of Object.entries(entries)) {
    test.each(cases.map(([label, go]) => [label, go] as const))(`${script} refuses: %s`, (_label, go) => {
      const result = go();
      const output = `${result.stdout}${result.stderr}`;
      expect(result.status).not.toBe(0);
      expect(output).toContain("Deploy gate: MIN_RESPONSE_SECONDS is 60s");
      // Refused before any deployment step started.
      expect(output).not.toContain("preflight");
      expect(output).not.toContain("Deploying");
    });
  }

  test("deploy-chain-matrix.cjs refuses --skip-compile on a mainnet", () => {
    const result = matrix("--skip-compile")();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("--skip-compile is refused");
  });

  test("deploy-stack.cjs lets a local network through the gate (it stops later, on the missing stablecoin address)", () => {
    const result = stack("hardhat")();
    expect(`${result.stdout}${result.stderr}`).not.toContain("Deploy gate");
  });

  test("deploy-stack.cjs gates on the chain id the node reports when the network config names none", async () => {
    // stack-manager and localhost carry no configured chain id, so only the post-RPC gate call can stop them.
    const requests: string[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as { id: number; method: string };
        requests.push(body.method);
        const results: Record<string, string> = { eth_chainId: "0x1", net_version: "1" };
        return Response.json({ jsonrpc: "2.0", id: body.id, result: results[body.method] ?? "0x0" });
      },
    });
    try {
      const output = await new Promise<{ status: number | null; text: string }>((resolve) => {
        const child = spawn("bunx", ["--bun", "hardhat", "run", "scripts/deploy-stack.cjs", "--network", "stack-manager"], {
          cwd: contractsRoot,
          env: { ...process.env, DEPLOYER_PRIVATE_KEY: "", XLN_STACK_MANAGER_RPC_URL: `http://127.0.0.1:${server.port}`, XLN_STACK_MANAGER_CHAIN_ID: "", HARDHAT_EXPERIMENTAL_ALLOW_NON_LOCAL_INSTALLATION: "true" },
        });
        let text = "";
        child.stdout.on("data", (chunk) => { text += chunk; });
        child.stderr.on("data", (chunk) => { text += chunk; });
        child.on("close", (status) => resolve({ status, text }));
      });
      expect(output.status).not.toBe(0);
      expect(output.text).toContain("Deploy gate: MIN_RESPONSE_SECONDS is 60s");
      expect(requests).toContain("eth_chainId");
      expect(requests.filter((method) => /^eth_send/.test(method))).toEqual([]);
    } finally {
      server.stop(true);
    }
  }, 240_000);

  test("the root mainnet deploy scripts no longer reach the frozen jurisdictions/ deployer", () => {
    const repoRoot = path.join(contractsRoot, "..");
    for (const script of ["deploy:chains:mainnet", "deploy:mainnets"]) {
      const result = spawnSync("bun", ["run", script], { cwd: repoRoot, encoding: "utf8", timeout: 60_000 });
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain("cd contracts && bun run deploy:chains:mainnet");
    }
    const root = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(Object.values(root.scripts).filter((command) => /jurisdictions.*deploy-chain-matrix.*--profile=mainnet/.test(command))).toEqual([]);
  });

  test("the exported deployTron gates on its own, before any RPC or key", async () => {
    const { profiles, deployTron } = matrixModule;
    await expect(deployTron(profiles.mainnet.tron, { dryRun: false, skipCompile: true })).rejects.toThrow(/Deploy gate: MIN_RESPONSE_SECONDS is 60s/);
    await expect(deployTron(profiles.mainnet.tron, { dryRun: true })).rejects.toThrow(/Deploy gate/);
  });
});
