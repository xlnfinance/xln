// What the Sepolia deploy prepares for and what it refuses, before a single transaction is sent. Nothing here needs a node: every refusal is
// judged from the manifest, the RPC address and the compiled build alone.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { ethers } from "ethers";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { assertRecordFree, assertTarget, deploySet, recordPathOf, resolveDeployerKey } from "../../deploy/deploy-set.ts";
import { smokeSet } from "../../deploy/smoke.ts";
import { CONTRACT_NAMES, deployedManifest, manifestProblems, parseManifest, type Deployed, type Manifest } from "../../deploy/manifest.ts";

const deployDir = path.join(import.meta.dir, "..", "..", "deploy");
const committed = JSON.parse(readFileSync(path.join(deployDir, "sepolia.prepared.manifest.json"), "utf8")) as Manifest;
const record = JSON.parse(readFileSync(path.join(deployDir, "sepolia.manifest.json"), "utf8")) as Manifest;
const ANVIL_DEV_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const LOOPBACK = "http://127.0.0.1:8545";
const target = (patch: Partial<Manifest> = {}, over: { nodeChainId?: number; rpcUrl?: string; live?: boolean } = {}) =>
  ({ manifest: { ...committed, ...patch }, nodeChainId: over.nodeChainId ?? committed.chainId, rpcUrl: over.rpcUrl ?? LOOPBACK, live: over.live ?? false });

describe("the committed Sepolia manifest", () => {
  test("is prepared: parameters only, no address, no key, an empty peer slot", () => {
    expect(parseManifest(committed).ok).toBe(true);
    expect(committed.status).toBe("prepared");
    expect(committed.chainId).toBe(11155111);
    expect(committed.contracts).toBeNull();
    expect(committed.token.address).toBeNull();
    expect(committed.deployer).toBeNull();
    expect(committed.peers).toEqual([]);
    expect(readFileSync(path.join(deployDir, "sepolia.prepared.manifest.json"), "utf8")).not.toMatch(/0x[0-9a-fA-F]{40}/);
  });

  test("agrees with the compiled build and the deploy gate (floors, HANKO_PRELUDE_GAS, total batch gas at most 5,437,937)", () => {
    const build = assertTarget(target());
    expect(build.floor).toBe(60);
    expect(build.requiredTxGas).toBe(5_437_937);
    expect(build.requiredTxGas).toBeLessThanOrEqual(5_437_937);
    expect(committed.gas.hankoPreludeGas).toBe(4_900_000);
    expect(committed.dispute.mainnetResponseFloorSeconds).toBe(21_600);
  });

  test("no deploy file holds a key (anvil's public dev key excepted; a transaction or code hash is not a key)", () => {
    const keysIn = (value: unknown, field = ""): string[] => {
      if (typeof value === "string") return /^0x[0-9a-fA-F]{64}$/.test(value) && !["transactionHash", "codeHash"].includes(field) && value.toLowerCase() !== ANVIL_DEV_KEY ? [value] : [];
      if (Array.isArray(value)) return value.flatMap((item) => keysIn(item, field));
      if (typeof value === "object" && value !== null) return Object.entries(value).flatMap(([name, item]) => keysIn(item, name));
      return [];
    };
    for (const file of readdirSync(deployDir)) {
      const text = readFileSync(path.join(deployDir, file), "utf8");
      const keys = file.endsWith(".json") ? keysIn(JSON.parse(text)) : (text.match(/0x[0-9a-fA-F]{64}/g) ?? []).filter((hex) => hex.toLowerCase() !== ANVIL_DEV_KEY);
      expect(keys, file).toEqual([]);
    }
  });
});

describe("the live Sepolia record (sepolia.manifest.json)", () => {
  const addresses = [record.deployer!, record.foundationRecipient!, record.token.address!, ...CONTRACT_NAMES.map((name) => record.contracts![name].address)];

  test("is a complete deployed manifest, and nothing in it but results differs from the prepared one", () => {
    const full = deployedManifest(record);
    expect(full.chainId).toBe(11155111);
    expect(full.network).toBe(committed.network);
    expect(full.dispute).toEqual(committed.dispute);
    expect(full.gas).toEqual(committed.gas);
    expect(full.peers).toEqual(committed.peers);
    expect({ ...full.token, address: null, tokenId: null }).toEqual(committed.token);
    expect(full.token.tokenId).toBe(1);
  });

  test("its parameters are the build's (floors, HANKO_PRELUDE_GAS, the 5,437,937 ceiling): the same check a deploy runs, offline", () => {
    expect(assertTarget({ manifest: record, nodeChainId: 11155111, rpcUrl: "https://sepolia.example.org", live: true }).requiredTxGas).toBe(5_437_937);
  });

  test("holds checksummed addresses only, all different but the deployer and the Foundation recipient, which are one key", () => {
    for (const address of addresses) expect(ethers.getAddress(address), address).toBe(address);
    expect(record.foundationRecipient).toBe(record.deployer);
    expect(new Set(addresses.slice(1)).size).toBe(addresses.length - 1);
  });

  test("blocks rise strictly in the deployment order and the gas total is the eight deployments' sum", () => {
    const order = ["account", "hankoVerifier", "entityProvider", "deltaTransformer", "depositoryBounds", "hashLadderRegistry", "nftCustody", "depository"] as const;
    const placed = order.map((name) => record.contracts![name]);
    placed.slice(1).forEach((entry, at) => expect(entry.deploymentBlock, order[at + 1]).toBeGreaterThan(placed[at]!.deploymentBlock));
    expect(placed.reduce((sum, entry) => sum + BigInt(entry.gasUsed), 0n).toString()).toBe(record.deploymentGasTotal!);
  });

  test("cannot be deployed over, and no deploy writes over it", async () => {
    await expect(deploySet({ rpcUrl: LOOPBACK, manifest: record })).rejects.toThrow("already deployed");
    expect(() => assertRecordFree(path.join(deployDir, "sepolia.manifest.json"))).toThrow("live record");
    expect(() => assertRecordFree(path.join(deployDir, "sepolia.prepared.manifest.json"))).not.toThrow();
    expect(() => assertRecordFree(path.join(deployDir, "does-not-exist.manifest.json"))).not.toThrow();
    expect(recordPathOf(path.join(deployDir, "sepolia.prepared.manifest.json"))).toBe(path.join(deployDir, "sepolia.manifest.json"));
  });

  test("the live CLI on the default manifest refuses to write over it before it touches the network (the RPC is a closed port)", () => {
    const run = spawnSync("bun", [path.join(deployDir, "deploy-set.ts"), "--rpc", "http://127.0.0.1:1", "--live"], { encoding: "utf8", env: { ...process.env, DEPLOYER_PRIVATE_KEY: "" } });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("live record");
  });
});

describe("assertTarget refuses before anything is sent", () => {
  test("a node on another chain than the manifest's", () => {
    expect(() => assertTarget(target({}, { nodeChainId: 31337 }))).toThrow("chain id 31337");
  });

  test("an RPC that is not this machine, unless --live", () => {
    expect(() => assertTarget(target({}, { rpcUrl: "https://sepolia.example.org" }))).toThrow("--live");
    expect(() => assertTarget(target({}, { rpcUrl: "https://sepolia.example.org", live: true }))).not.toThrow();
  });

  test("mainnet: the testnet floor is refused on a chain that is not a named testnet", () => {
    expect(() => assertTarget(target({ chainId: 1, network: "ethereum-mainnet" }, { nodeChainId: 1, live: true }))).toThrow("mainnet floor of 21600s");
  });

  test("a floor that drifted from the build", () => {
    expect(() => assertTarget(target({ dispute: { ...committed.dispute, responseFloorSeconds: 30 } }))).toThrow("compiled build");
    expect(() => assertTarget(target({ dispute: { ...committed.dispute, mainnetResponseFloorSeconds: 60 } }))).toThrow("mainnet floor");
  });

  test("HANKO_PRELUDE_GAS or the batch gas total that drifted from the build, or above the manifest's ceiling", () => {
    expect(() => assertTarget(target({ gas: { ...committed.gas, hankoPreludeGas: 4_800_000 } }))).toThrow("HANKO_PRELUDE_GAS");
    expect(() => assertTarget(target({ gas: { ...committed.gas, requiredTxGas: 5_000_000 } }))).toThrow("a batch needs");
    expect(() => assertTarget(target({ gas: { ...committed.gas, maxRequiredTxGas: 5_437_936 } }))).toThrow("ceiling");
  });
});

describe("the deployer key", () => {
  test("comes from DEPLOYER_PRIVATE_KEY, with or without 0x", () => {
    const key = "11".repeat(32);
    expect(resolveDeployerKey({ DEPLOYER_PRIVATE_KEY: key }, "https://sepolia.example.org")).toBe(`0x${key}`);
    expect(resolveDeployerKey({ DEPLOYER_PRIVATE_KEY: `0x${key}` }, LOOPBACK)).toBe(`0x${key}`);
  });

  test("anvil's dev key signs on a loopback node only; anywhere else no key means no deploy", () => {
    expect(resolveDeployerKey({}, LOOPBACK)).toBe(ANVIL_DEV_KEY);
    expect(resolveDeployerKey({}, "http://localhost:8545")).toBe(ANVIL_DEV_KEY);
    expect(() => resolveDeployerKey({}, "https://sepolia.example.org")).toThrow("DEPLOYER_PRIVATE_KEY");
    expect(() => resolveDeployerKey({ DEPLOYER_PRIVATE_KEY: "  " }, "https://10.0.0.5:8545")).toThrow("DEPLOYER_PRIVATE_KEY");
  });
});

describe("the manifest's shape", () => {
  const deployedPatch = { status: "deployed" as const };
  test("a prepared manifest holds no contracts; a deployed one must hold the whole set", () => {
    expect(manifestProblems({ ...committed, contracts: {} })).toContain("a prepared manifest has no contracts");
    const problems = manifestProblems({ ...committed, ...deployedPatch });
    expect(problems).toContain("a deployed manifest names its deployer");
    expect(problems.some((problem) => problem.startsWith("contracts.depository"))).toBe(true);
  });

  test("the static peer table slot (Q-T-4) takes { entityId, endpoint } rows and nothing else", () => {
    const entityId = `0x${"ab".repeat(32)}`;
    expect(manifestProblems({ ...committed, peers: [{ entityId, endpoint: "wss://hub.example.org/ws" }] })).toEqual([]);
    expect(manifestProblems({ ...committed, peers: [{ entityId: "0x12", endpoint: "wss://hub.example.org/ws" }] })).not.toEqual([]);
    expect(manifestProblems({ ...committed, peers: [{ entityId, endpoint: "" }] })).not.toEqual([]);
    expect(manifestProblems({ ...committed, peers: "hub" })).not.toEqual([]);
  });

  test("malformed floors, gas, chain id and a token with nowhere to come from are refused", () => {
    expect(manifestProblems({ ...committed, chainId: 0 })).not.toEqual([]);
    expect(manifestProblems({ ...committed, dispute: { responseFloorSeconds: "60" } })).not.toEqual([]);
    expect(manifestProblems({ ...committed, gas: {} })).not.toEqual([]);
    expect(manifestProblems({ ...committed, token: { ...committed.token, deployFaucet: false } })).toContain("token has neither an address nor deployFaucet");
  });
});

describe("the entry points", () => {
  test("deploySet refuses a manifest that is already deployed", async () => {
    await expect(deploySet({ rpcUrl: LOOPBACK, manifest: { ...committed, status: "deployed" } })).rejects.toThrow("already deployed");
  });

  test("the CLI refuses a dry run without --out before it touches the network (it cannot overwrite the prepared manifest)", () => {
    const run = spawnSync("bun", [path.join(deployDir, "deploy-set.ts"), "--rpc", "http://127.0.0.1:1"], { encoding: "utf8" });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("--out");
  });
});

// Review A of PR 81: the refusals that stand between a script and a live network, and the deploy set itself.
describe("a remote node is refused before any call to it", () => {
  // `.invalid` never resolves: were the node asked anything first, the error would be a network one, not the refusal.
  const REMOTE = "https://sepolia.invalid";
  const filler = (index: number): Deployed => ({
    address: ethers.getAddress(`0x${(index + 1).toString(16).padStart(40, "0")}`), deploymentBlock: 1, transactionHash: `0x${"11".repeat(32)}`, gasUsed: "1", codeHash: `0x${"22".repeat(32)}`,
  });
  const deployed: Manifest = {
    ...committed, status: "deployed", deployer: ethers.getAddress(`0x${"aa".repeat(20)}`), foundationRecipient: ethers.getAddress(`0x${"aa".repeat(20)}`),
    contracts: Object.fromEntries(CONTRACT_NAMES.map((name, index) => [name, filler(index)])) as Manifest["contracts"], deploymentGasTotal: "8",
    token: { ...committed.token, address: ethers.getAddress(`0x${"bb".repeat(20)}`), tokenId: 1 },
  };

  test("deploySet without --live", async () => {
    await expect(deploySet({ rpcUrl: REMOTE, manifest: committed, privateKey: `0x${"11".repeat(32)}` })).rejects.toThrow("needs --live");
  });

  test("smokeSet without --live, even with a key in hand", async () => {
    expect(manifestProblems(deployed)).toEqual([]);
    await expect(smokeSet({ rpcUrl: REMOTE, manifest: deployed, privateKey: `0x${"11".repeat(32)}` })).rejects.toThrow("needs --live");
  });
});

describe("the deploy set is the frozen contract set", () => {
  const build = path.join(import.meta.dir, "..", "..", "artifacts", "contracts");
  const artifact = (file: string): { deployedBytecode: string; deployedLinkReferences: Record<string, Record<string, unknown>> } =>
    JSON.parse(readFileSync(path.join(build, file), "utf8"));
  const sourceOf = (name: string): string => {
    const contract = name[0]!.toUpperCase() + name.slice(1);
    const nested = path.join("custody", `${contract}.sol`, `${contract}.json`);
    return existsSync(path.join(build, nested)) ? nested : path.join(`${contract}.sol`, `${contract}.json`);
  };

  test("the eight names are the eight deployable, non-mock contracts of the build", () => {
    expect([...CONTRACT_NAMES].sort()).toEqual(["account", "deltaTransformer", "depository", "depositoryBounds", "entityProvider", "hankoVerifier", "hashLadderRegistry", "nftCustody"]);
    for (const name of CONTRACT_NAMES) expect(artifact(sourceOf(name)).deployedBytecode.length, name).toBeGreaterThan(100);
  });

  test("every library or contract the Depository and the EntityProvider link to is in the set", () => {
    const set = new Set(CONTRACT_NAMES.map((name) => `${name[0]!.toUpperCase()}${name.slice(1)}`));
    for (const holder of ["depository", "entityProvider"] as const) {
      const links = Object.values(artifact(sourceOf(holder)).deployedLinkReferences).flatMap((byName) => Object.keys(byName));
      expect(links.length, holder).toBeGreaterThan(0);
      for (const link of links) expect(set.has(link), `${holder} links ${link}`).toBe(true);
    }
  });
});
