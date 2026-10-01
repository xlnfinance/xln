// N3: the deploy gate refuses the testnet response-window floor on any chain that is not a named testnet, on every
// deploy path, reading the floor from the compiled build.
import { afterAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildFingerprint, removeSandboxes, runInSandbox, sandboxOf } from "../helpers/project-sandbox.ts";
// @ts-expect-error CommonJS script without types
import gate from "../../scripts/deploy-gate.cjs";
// @ts-expect-error CommonJS script without types
import matrixModule from "../../scripts/deploy-chain-matrix.cjs";

const contractsRoot = path.join(import.meta.dir, "..", "..");
// Scripts that may compile (hardhat run, the matrix) run in a private copy: they must never rewrite the build the other tests read.
const scriptCwd = () => sandboxOf(contractsRoot);
// Whatever else happens, this file must leave the real build exactly as it found it (a compile run in the real project would rewrite it mid-run).
const buildBefore = existsSync(path.join(contractsRoot, "artifacts")) ? buildFingerprint(contractsRoot) : null;
afterAll(() => {
  removeSandboxes();
  if (buildBefore !== null) expect(buildFingerprint(contractsRoot), "the real artifacts/ or .typechain-hardhat changed while the gate tests ran").toBe(buildBefore);
});

describe("the real build the gate tests read", () => {
  // Sources moved since the last build: every test below that reads the build fails. This one says why, once, with the command.
  test("matches the sources on disk (if not: bash scripts/build.sh)", () => {
    const problem = (() => { try { gate.readCompiledFloor(); return null; } catch (error) { return error instanceof Error ? error.message : String(error); } })();
    expect(problem, "the build in artifacts/ is stale: run `bash scripts/build.sh`, then run the gate tests again").toBeNull();
  });
});
const literal = (value: string, subdenomination: string | null = null) => ({ nodeType: "Literal", kind: "number", value, subdenomination });
const constantAst = (value: unknown) => ({ nodeType: "SourceUnit", nodes: [{ nodeType: "ContractDefinition", nodes: [{ nodeType: "VariableDeclaration", name: "MIN_RESPONSE_SECONDS", constant: true, value }] }] });
const named = (chainId: number, id = "chain") => ({ id, chainId });
const floorOf = (seconds: number | null) => () => seconds as number;

describe("N3 the floor is read from solc's AST", () => {
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

describe("N3 the gate is keyed by chain id", () => {
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

describe("N3 the batch gas budget fits the chain's transaction gas cap (J5)", () => {
  const gas = { minBudget: 500_000, reserve: 30_000 };
  const readGas = () => gas;
  const capsOf = (caps: Record<number, number>) => (chain: { chainId: number }) => caps[Number(chain.chainId)] ?? null;

  test("the constants are read from the compiled build, and the required gas is the supported board's hanko + budget * 64/63 + reserve", () => {
    expect(gate.readCompiledBatchGas()).toEqual(gas);
    expect(gate.requiredTxGas(gas)).toBe(gate.HANKO_PRELUDE_GAS + Math.ceil((500_000 * 64) / 63) + 30_000);
    expect(gate.SUPPORTED_BOARD_SIGNERS).toBe(128); // the board size the prelude constant is measured for (test/vm/j5-gas-prelude.test.ts)
  });

  test("Ethereum's EIP-7825 cap carries it with room to spare", () => {
    expect(gate.EIP_7825_TX_GAS_CAP).toBe(2 ** 24);
    expect(gate.assertBatchGasCap([named(1), named(11155111)], readGas)).toBe(gate.requiredTxGas(gas));
    expect(gate.EIP_7825_TX_GAS_CAP - gate.requiredTxGas(gas)).toBeGreaterThan(10_000_000);
  });

  test("a known cap below the requirement is refused, on a mainnet and on a testnet", () => {
    const tight = capsOf({ 1: 5_000_000, 84532: 5_000_000 });
    expect(() => gate.assertBatchGasCap([named(1, "ethereum-mainnet")], readGas, tight)).toThrow(/gas cap of ethereum-mainnet \(1\) is 5000000, below the/);
    expect(() => gate.assertBatchGasCap([named(84532, "base-sepolia")], readGas, tight)).toThrow(/below the/);
  });

  test("an unknown cap is refused on a mainnet and never blocks a named testnet", () => {
    expect(() => gate.assertBatchGasCap([named(8453, "base-mainnet")], readGas, capsOf({}))).toThrow(/gas cap of base-mainnet \(8453\) is not known/);
    expect(gate.assertBatchGasCap([named(31337), named(84532), named(3448148188)], readGas, capsOf({}))).toBeNull();
  });

  test("fails closed when the constants cannot be read or are not plain constants, but never blocks a testnet with an unknown cap", () => {
    expect(() => gate.assertBatchGasCap([named(1)], () => { throw new Error("stale"); })).toThrow(/cannot establish the batch gas budget/);
    expect(() => gate.assertBatchGasCap([named(1)], () => ({ minBudget: null, reserve: 30_000 }))).toThrow(/not a plain constant/);
    expect(gate.assertBatchGasCap([named(31337)], () => { throw new Error("stale"); }, capsOf({}))).toBeNull();
  });

  test("assertDeployGate runs the response-window floor first, then the gas cap", () => {
    expect(() => gate.assertDeployGate([named(1, "ethereum-mainnet")])).toThrow(/MIN_RESPONSE_SECONDS is 60s/);
    expect(gate.assertDeployGate([named(31337)])).toBeUndefined();
  });
});

describe("N3 every deploy path runs the gate", () => {
  const run = (args: string[], command = "bun") => runInSandbox(contractsRoot, command, args, {
    env: { DEPLOYER_PRIVATE_KEY: "", ETH_MAINNET_RPC: "", ETH_SEPOLIA_RPC: "", HARDHAT_EXPERIMENTAL_ALLOW_NON_LOCAL_INSTALLATION: "true" },
  });
  const stack = (network: string) => () => run(["--bun", "hardhat", "run", "scripts/deploy-stack.cjs", "--network", network], "bunx");
  const matrix = (...flags: string[]) => () => run(["scripts/deploy-chain-matrix.cjs", "--profile=mainnet", "--dry-run", ...flags]);
  // The Sepolia deploy (deploy/) takes a manifest: a mainnet one must be refused by the gate before any RPC call (the RPC here is a closed port).
  const mainnetDir = mkdtempSync(path.join(tmpdir(), "xln-gate-manifest-"));
  const sepolia = JSON.parse(readFileSync(path.join(contractsRoot, "deploy", "sepolia.manifest.json"), "utf8")) as Record<string, unknown>;
  const mainnetPrepared = { ...sepolia, network: "ethereum-mainnet", chainId: 1 };
  const address = "0x1111111111111111111111111111111111111111", hash = `0x${"22".repeat(32)}`;
  const placed = { address, deploymentBlock: 1, transactionHash: hash, gasUsed: "1", codeHash: hash };
  const mainnetDeployed = {
    ...mainnetPrepared, status: "deployed", deployer: address, foundationRecipient: address, deploymentGasTotal: "1",
    token: { symbol: "USDT", decimals: 6, address, deployFaucet: true, tokenId: 1 },
    contracts: Object.fromEntries(["account", "hankoVerifier", "entityProvider", "deltaTransformer", "depositoryBounds", "hashLadderRegistry", "nftCustody", "depository"].map((name) => [name, placed])),
  };
  const manifestFile = (name: string, manifest: unknown) => { const file = path.join(mainnetDir, name); writeFileSync(file, JSON.stringify(manifest)); return file; };
  const closedPort = "http://127.0.0.1:1";
  const sepoliaDeploy = (name: string, manifest: unknown) => () => run(["deploy/deploy-set.ts", "--rpc", closedPort, "--manifest", manifestFile(name, manifest), "--out", path.join(mainnetDir, `${name}.out`)]);
  const sepoliaSmoke = (name: string, manifest: unknown) => () => run(["deploy/smoke.ts", "--rpc", closedPort, "--manifest", manifestFile(name, manifest)]);

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
    "deploy/deploy-set.ts": [
      ["a prepared manifest for Ethereum mainnet (chain 1)", sepoliaDeploy("mainnet-prepared.json", mainnetPrepared)],
      ["a prepared manifest for Ethereum mainnet under a testnet's name", sepoliaDeploy("mainnet-sepolia-name.json", { ...mainnetPrepared, network: "ethereum-sepolia" })],
    ],
    "deploy/smoke.ts": [
      ["a deployed manifest for Ethereum mainnet (chain 1)", sepoliaSmoke("mainnet-deployed.json", mainnetDeployed)],
    ],
  };

  // Scripts that never deploy or broadcast. Each one is asserted below to match none of the sinks, so a script cannot
  // hide on this list after it grows a deploy path.
  const nonDeploying = ["build.sh", "compile-tron.cjs", "deploy-gate.cjs", "foundation-hanko.cjs", "generate-typechain.cjs", "setup-forge-std.sh", "write-vectors.ts",
    "deploy/README.md", "deploy/dry-run.ts", "deploy/manifest.ts", "deploy/sepolia.manifest.json"];
  const sinks = /\.deploy\(|getContractFactory\(|deployContract\(|createSmartContract\(|broadcastTronTransaction\(|\bbroadcast(?:Hex|Transaction)?\(|\{[^}]*\bbroadcast(?:Hex)?\b[^}]*\}\s*=|=\s*\w*\.trx\b|sendRawTransaction\(|sendHexTransaction\(|sendTransaction\(|eth_sendRawTransaction|eth_sendTransaction|\bcast (send|create)\b|forge (create|script)\b|hardhat (ignition|run)\b/;
  const scriptsRoot = path.join(contractsRoot, "scripts");
  const filesUnder = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? filesUnder(full) : [full];
  });
  // The surfaces are scripts/ (keys relative to it) and deploy/ (keys "deploy/<file>", relative to contracts/).
  const deployRoot = path.join(contractsRoot, "deploy");
  const allScripts = [...filesUnder(scriptsRoot).map((file) => path.relative(scriptsRoot, file)), ...filesUnder(deployRoot).map((file) => path.relative(contractsRoot, file))];
  const sourceOf = (file: string) => readFileSync(path.join(file.startsWith("deploy/") ? contractsRoot : scriptsRoot, file), "utf8");

  test("every file under scripts/ has an entry that exercises it or is on the non-deploying list", () => {
    expect(allScripts.filter((file) => !(file in entries) && !nonDeploying.includes(file))).toEqual([]);
    expect(Object.keys(entries).filter((file) => !allScripts.includes(file))).toEqual([]);
    expect(nonDeploying.filter((file) => !allScripts.includes(file))).toEqual([]);
  });

  test("a script on the non-deploying list contains no deploy or broadcast call", () => {
    const offenders = nonDeploying.filter((file) => sinks.test(sourceOf(file)));
    expect(offenders).toEqual([]);
  });

  test("every script with a deploy or broadcast call has an entry", () => {
    const deployers = allScripts.filter((file) => sinks.test(sourceOf(file)));
    expect(deployers.filter((file) => !(file in entries))).toEqual([]);
    expect(Object.keys(entries).filter((file) => !deployers.includes(file))).toEqual([]);
  });

  test("no other deploy surface exists: no ignition or deploy directory, and package.json only runs listed scripts", () => {
    expect(existsSync(path.join(contractsRoot, "ignition"))).toBe(false);
    // deploy/ is a deploy surface the coverage tests above cover file by file: an unlisted file, or a deploy call without an entry, fails there.
    const { scripts } = JSON.parse(readFileSync(path.join(contractsRoot, "package.json"), "utf8")) as { scripts: Record<string, string> };
    const commands = Object.values(scripts);
    expect(commands.filter((command) => /hardhat ignition/.test(command))).toEqual([]);
    const referenced = commands.flatMap((command) => [...command.matchAll(/(?:^|[\s&;])(?:bun|node|bash|sh)\s+scripts\/([\w./-]+)/g)].map((match) => match[1]!)).filter((file) => existsSync(path.join(scriptsRoot, file)));
    expect(referenced.filter((file) => !(file in entries) && !nonDeploying.includes(file))).toEqual([]);
    // A `hardhat run` target anywhere (outside scripts/ too) must be a script that has an entry.
    const hardhatTargets = commands.flatMap((command) => [...command.matchAll(/hardhat run\s+(?:--\S+\s+\S+\s+)*([^\s&;]+)/g)].map((match) => match[1]!));
    expect(hardhatTargets.filter((target) => !(target.replace(/^\.?\/?scripts\//, "") in entries) || !target.replace(/^\.\//, "").startsWith("scripts/"))).toEqual([]);
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
    }, 240_000);
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
          cwd: scriptCwd(),
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

  test("the exported deployTronContract gates on its own, on the host its TronWeb talks to", async () => {
    const { deployTronContract } = matrixModule;
    const on = (host: string) => ({ fullNode: { host } });
    await expect(deployTronContract(on("https://api.trongrid.io"), "Depository")).rejects.toThrow(/Deploy gate: MIN_RESPONSE_SECONDS is 60s/);
    // a host no profile names is an unknown chain, never a testnet
    await expect(deployTronContract(on("http://127.0.0.1:9090"), "Depository")).rejects.toThrow(/Deploy gate/);
    // a named testnet gets past the gate (and stops later, on the missing TRON artifact)
    await expect(deployTronContract(on("https://nile.trongrid.io"), "Depository")).rejects.not.toThrow(/Deploy gate/);
  });

  test("the exported deployTron gates on its own, before any network call", async () => {
    const { profiles, deployTron } = matrixModule;
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((input: unknown) => { calls.push(String(input)); return Promise.reject(new Error("network call before the gate")); }) as typeof fetch;
    try {
      await expect(deployTron(profiles.mainnet.tron, { dryRun: false, skipCompile: true })).rejects.toThrow(/Deploy gate: MIN_RESPONSE_SECONDS is 60s/);
      await expect(deployTron(profiles.mainnet.tron, { dryRun: true })).rejects.toThrow(/Deploy gate/);
      expect(calls).toEqual([]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
