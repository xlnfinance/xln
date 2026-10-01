// The deploy and the smoke test on a real node: a throw-away anvil on a free loopback port. Needs anvil (export PATH=$PATH:/foundry); a missing
// anvil fails the test, it does not skip it. The fork of Sepolia is the same code with --fork and needs the network, so it is run by hand:
//   bun contracts/deploy/dry-run.ts --fork https://ethereum-sepolia-rpc.publicnode.com
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ethers } from "ethers";
import { CONTRACT_NAMES, deployedManifest, type Manifest } from "../../deploy/manifest.ts";
import { deploySet } from "../../deploy/deploy-set.ts";
import { dryRun, startAnvil } from "../../deploy/dry-run.ts";
import { smokeSet } from "../../deploy/smoke.ts";

const prepared = JSON.parse(readFileSync(path.join(import.meta.dir, "..", "..", "deploy", "sepolia.prepared.manifest.json"), "utf8")) as Manifest;
const peers = [{ entityId: `0x${"cd".repeat(32)}`, endpoint: "wss://hub.example.org/ws" }];
const local: Manifest = { ...prepared, network: "anvil-local", chainId: 31337, peers };
const ANVIL_DEV_KEY = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const EIP_170 = 24_576;

// Without --live the deploy and the smoke test ignore DEPLOYER_PRIVATE_KEY and anvil's dev account signs. A dummy key (it has no funds on the node)
// is exported for the whole file, so a deploy that read it would fail here; the real value of a shell is put back afterwards and never looked at.
const ambientKey = process.env["DEPLOYER_PRIVATE_KEY"];
const DUMMY_KEY = `0x${"11".repeat(32)}`;

let node: Awaited<ReturnType<typeof startAnvil>>;
let deployed: Manifest & { readonly contracts: NonNullable<Manifest["contracts"]> };
beforeAll(async () => {
  process.env["DEPLOYER_PRIVATE_KEY"] = DUMMY_KEY;
  node = await startAnvil(null);
  deployed = deployedManifest(await deploySet({ rpcUrl: node.url, manifest: local }));
}, 600_000);
afterAll(() => {
  node?.stop();
  if (ambientKey === undefined) delete process.env["DEPLOYER_PRIVATE_KEY"];
  else process.env["DEPLOYER_PRIVATE_KEY"] = ambientKey;
});

describe("deploy on a local anvil", () => {
  test("the whole set is placed and the manifest is complete, with the parameters and the peer slot carried through", () => {
    expect(Object.keys(deployed.contracts).sort()).toEqual([...CONTRACT_NAMES].sort());
    expect(deployed.token.tokenId).toBe(1);
    expect(deployed.dispute.responseFloorSeconds).toBe(60);
    expect(deployed.gas.hankoPreludeGas).toBe(4_900_000);
    expect(deployed.peers).toEqual(peers);
  });

  test("the batch gas total stays at or under 5,437,937", () => {
    expect(deployed.gas.requiredTxGas).toBeLessThanOrEqual(5_437_937);
  });

  test("each recorded code hash is the hash of the code the chain holds, and every contract fits EIP-170", async () => {
    const provider = new ethers.JsonRpcProvider(node.url, undefined, { cacheTimeout: -1 });
    for (const name of CONTRACT_NAMES) {
      const entry = deployed.contracts[name];
      const code = await provider.getCode(entry.address);
      expect(ethers.keccak256(code), name).toBe(entry.codeHash);
      expect((code.length - 2) / 2, name).toBeLessThanOrEqual(EIP_170);
    }
  });

  test("the manifest holds no private key", () => {
    expect(JSON.stringify(deployed).toLowerCase()).not.toContain(ANVIL_DEV_KEY);
    expect(deployed.deployer).toBe(ethers.getAddress("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"));
  });

  test("the smoke test passes: deposit, open, signed batch, dispute start and finalize, from the implicit proof and from a signed one; and again with other entities", async () => {
    const first = await smokeSet({ rpcUrl: node.url, manifest: deployed, salt: "one" });
    const steps = first.steps.map((entry) => entry.step);
    for (const word of ["deposit", "reserve to collateral", "dispute start", "dispute finalize", "implicit", "signed"]) {
      expect(steps.some((step) => step.includes(word)), word).toBe(true);
    }
    expect(first.final.epoch).toBe("3");
    const second = await smokeSet({ rpcUrl: node.url, manifest: deployed, salt: "two" });
    expect(second.entities.left).not.toBe(first.entities.left);
    expect(second.final.epoch).toBe("3");
  }, 300_000);

  test("a smoke test refuses a node on another chain than the manifest's", async () => {
    await expect(smokeSet({ rpcUrl: node.url, manifest: { ...deployed, chainId: 11155111 } })).rejects.toThrow("chain id");
  });
});

describe("dryRun", () => {
  test("re-targets the Sepolia manifest at anvil's chain id, deploys, smoke-tests, and leaves the prepared manifest as it was", async () => {
    const before = JSON.stringify(prepared);
    const run = await dryRun({ prepared, fork: null });
    expect(run.chainId).toBe(31337);
    expect(run.manifest.status).toBe("deployed");
    expect(run.smoke.final.epoch).toBe("3");
    expect(JSON.stringify(prepared)).toBe(before);
  }, 600_000);

  test("signs with anvil's key even when DEPLOYER_PRIVATE_KEY is set (the key exported for a live deploy never reaches a throw-away node)", async () => {
    const other = `0x${"11".repeat(32)}`;
    const kept = process.env["DEPLOYER_PRIVATE_KEY"];
    process.env["DEPLOYER_PRIVATE_KEY"] = other;
    try {
      const run = await dryRun({ prepared, fork: null });
      expect(run.manifest.deployer).toBe(ethers.getAddress("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"));
      expect(run.manifest.deployer).not.toBe(new ethers.Wallet(other).address);
    } finally {
      if (kept === undefined) delete process.env["DEPLOYER_PRIVATE_KEY"]; else process.env["DEPLOYER_PRIVATE_KEY"] = kept;
    }
  }, 600_000);
});
