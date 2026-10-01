// The read-only check of the deployed contracts (deploy/verify.ts), judged offline: a fake chain serves the code the current build gives each
// address, and every way a chain can differ from it is planted one at a time. Nothing here reaches a real network or needs a key.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ethers } from "ethers";
import { CONTRACT_NAMES, type Manifest } from "../../deploy/manifest.ts";
import { expectedRuntime, readBuild, renderReport, rpcChain, SUBJECTS, verifyDeployment, type Build, type Chain, type Subject } from "../../deploy/verify.ts";

const deployDir = path.join(import.meta.dir, "..", "..", "deploy");
const record = JSON.parse(readFileSync(path.join(deployDir, "sepolia.manifest.json"), "utf8")) as Manifest;
const build = readBuild();
const lower = (value: string): string => value.toLowerCase();
const addressOf = (subject: Subject): string => (subject === "token" ? record.token.address! : record.contracts![subject].address);

/** The record with each code hash set to what the CURRENT build gives, so the tests judge the comparison and not whether main has moved past the deployment. */
const manifest: Manifest = {
  ...record,
  contracts: Object.fromEntries(CONTRACT_NAMES.map((name) => [name, { ...record.contracts![name], codeHash: ethers.keccak256(expectedRuntime(record, build, name).code) }])) as never,
};
const served = (): Map<string, Uint8Array> => new Map(SUBJECTS.map((subject) => [lower(addressOf(subject)), expectedRuntime(manifest, build, subject).code.slice()]));
const chainOf = (codes: ReadonlyMap<string, Uint8Array>, chainId = manifest.chainId): Chain => ({
  chainId: async () => chainId,
  blockNumber: async () => 11_820_000,
  getCode: async (address) => ethers.hexlify(codes.get(lower(address)) ?? new Uint8Array()),
});
const rowOf = async (codes: ReadonlyMap<string, Uint8Array>, subject: Subject) => (await verifyDeployment(manifest, build, chainOf(codes))).rows.find((row) => row.subject === subject)!;
const slotOf = (subject: Subject, what: string) => expectedRuntime(manifest, build, subject).slots.find((slot) => slot.what === what)!;
/** The first byte of a subject's code that is plain compiled code: not an immutable, not a link slot. */
const plainByte = (subject: Subject): number => {
  const { code, slots } = expectedRuntime(manifest, build, subject);
  let at = Math.floor(code.length / 2);
  while (slots.some(({ start, length }) => at >= start && at < start + length)) at += 1;
  return at;
};

describe("verify.ts against a chain that holds exactly the build", () => {
  test("R-DEPLOY-VERIFY every contract and the faucet token match, with the manifest's code hashes", async () => {
    const report = await verifyDeployment(manifest, build, chainOf(served()));
    expect(report.rows.map((row) => row.subject)).toEqual([...CONTRACT_NAMES, "token"]);
    expect(report.rows.filter((row) => !row.match)).toEqual([]);
    expect(report.chainId).toBe(11_155_111);
    expect(renderReport(manifest, report, "https://node.example/rpc")).toContain("all 9 match the current build and the manifest");
  });

  test("R-DEPLOY-VERIFY the immutables and link slots are rebuilt from the manifest: the Depository holds 8+4 deploy addresses, the admin once, and 14 library links", () => {
    const { code, slots } = expectedRuntime(manifest, build, "depository");
    const count = (what: string): number => slots.filter((slot) => slot.what === what).length;
    expect(count("immutable entityProvider")).toBe(8);
    expect(count("immutable deltaTransformer")).toBe(4);
    expect(count("immutable admin")).toBe(1);
    expect(count("link slot for library Account")).toBe(14);
    const wordAt = (what: string): string => ethers.getAddress(ethers.dataSlice(code, slotOf("depository", what).start + 12, slotOf("depository", what).start + 32));
    expect(wordAt("immutable entityProvider")).toBe(manifest.contracts!.entityProvider.address);
    expect(wordAt("immutable deltaTransformer")).toBe(manifest.contracts!.deltaTransformer.address);
    expect(wordAt("immutable admin")).toBe(manifest.deployer!);
    expect(ethers.getAddress(ethers.dataSlice(code, slotOf("depository", "link slot for library Account").start, slotOf("depository", "link slot for library Account").start + 20))).toBe(manifest.contracts!.account.address);
  });

  test("R-DEPLOY-VERIFY the EntityProvider the fake chain serves holds the manifest's deployer in both foundationDeployer slots", () => {
    const code = served().get(lower(addressOf("entityProvider")))!;
    const slots = expectedRuntime(manifest, build, "entityProvider").slots.filter((slot) => slot.what === "immutable foundationDeployer");
    expect(slots.length).toBe(2);
    for (const { start } of slots) expect(ethers.getAddress(ethers.dataSlice(code, start + 12, start + 32))).toBe(manifest.deployer!);
  });

  test("R-DEPLOY-VERIFY a library's own-address immutable is its deployed address; the token's immutable is its decimals", () => {
    const own = (subject: "account" | "hashLadderRegistry" | "nftCustody"): string => {
      const { code } = expectedRuntime(manifest, build, subject);
      const { start } = slotOf(subject, "immutable library_deploy_address");
      return ethers.getAddress(ethers.dataSlice(code, start + 12, start + 32));
    };
    expect(own("account")).toBe(manifest.contracts!.account.address);
    expect(own("hashLadderRegistry")).toBe(manifest.contracts!.hashLadderRegistry.address);
    expect(own("nftCustody")).toBe(manifest.contracts!.nftCustody.address);
    const token = expectedRuntime(manifest, build, "token");
    expect(BigInt(ethers.dataSlice(token.code, slotOf("token", "immutable tokenDecimals").start, slotOf("token", "immutable tokenDecimals").start + 32))).toBe(6n);
  });
});

describe("verify.ts names every way the chain can differ", () => {
  test("R-DEPLOY-VERIFY one flipped byte of compiled code: that contract differs at that byte, as compiled code, and no other contract does", async () => {
    const codes = served();
    const at = plainByte("account");
    codes.get(lower(addressOf("account")))![at] ^= 0x01;
    const report = await verifyDeployment(manifest, build, chainOf(codes));
    expect(report.rows.filter((row) => !row.match).map((row) => row.subject)).toEqual(["account"]);
    const reasons = report.rows.find((row) => row.subject === "account")!.reasons.join("\n");
    expect(reasons).toContain(`first difference at byte ${at}, in compiled code`);
    expect(reasons).toContain("is not the manifest's codeHash");
  });

  test("R-DEPLOY-VERIFY a difference in the very last byte of any contract's code, the faucet token's included, is a differ at that byte", async () => {
    for (const subject of SUBJECTS) {
      const codes = served();
      const code = codes.get(lower(addressOf(subject)))!;
      code[code.length - 1] ^= 0x01;
      const report = await verifyDeployment(manifest, build, chainOf(codes));
      expect(report.rows.filter((row) => !row.match).map((row) => row.subject)).toEqual([subject]);
      expect(report.rows.find((row) => row.subject === subject)!.reasons.join("\n")).toContain(`first difference at byte ${code.length - 1}, in compiled code`);
    }
  });

  test("R-DEPLOY-VERIFY a wrong admin in the Depository's immutable slot is named as the admin immutable", async () => {
    const codes = served();
    const { start } = slotOf("depository", "immutable admin");
    codes.get(lower(addressOf("depository")))!.set(ethers.getBytes(ethers.zeroPadValue("0x000000000000000000000000000000000000dEaD", 32)), start);
    const row = await rowOf(codes, "depository");
    expect(row.match).toBe(false);
    expect(row.reasons.join("\n")).toContain(`inside the immutable admin (bytes ${start}..${start + 31})`);
  });

  test("R-DEPLOY-VERIFY a different library address in a link slot is named as that library's link slot", async () => {
    const codes = served();
    const { start } = slotOf("entityProvider", "link slot for library HankoVerifier");
    codes.get(lower(addressOf("entityProvider")))!.set(ethers.getBytes("0x000000000000000000000000000000000000dEaD"), start);
    const row = await rowOf(codes, "entityProvider");
    expect(row.match).toBe(false);
    expect(row.reasons.join("\n")).toContain("inside the link slot for library HankoVerifier");
  });

  test("R-DEPLOY-VERIFY an address with no code, and code that is cut short or has a tail added, differ", async () => {
    const codes = served();
    codes.delete(lower(addressOf("nftCustody")));
    expect((await rowOf(codes, "nftCustody")).reasons[0]).toBe(`no code at ${addressOf("nftCustody")}`);
    const cut = served();
    cut.set(lower(addressOf("hashLadderRegistry")), cut.get(lower(addressOf("hashLadderRegistry")))!.slice(0, -1));
    expect((await rowOf(cut, "hashLadderRegistry")).reasons.join("\n")).toContain("the chain holds 1728 bytes, the current build 1729");
    const longer = served();
    longer.set(lower(addressOf("depositoryBounds")), ethers.getBytes(ethers.concat([longer.get(lower(addressOf("depositoryBounds")))!, "0x00"])));
    expect((await rowOf(longer, "depositoryBounds")).match).toBe(false);
  });

  test("R-DEPLOY-VERIFY code that equals the build but not the manifest's code hash differs too (the manifest names another deployment)", async () => {
    const wrong = { ...manifest, contracts: { ...manifest.contracts!, deltaTransformer: { ...manifest.contracts!.deltaTransformer, codeHash: ethers.ZeroHash } } };
    const report = await verifyDeployment(wrong, build, chainOf(served()));
    expect(report.rows.filter((row) => !row.match).map((row) => row.subject)).toEqual(["deltaTransformer"]);
    expect(report.rows[3]!.reasons).toEqual([`keccak256 of the chain's code ${ethers.keccak256(expectedRuntime(wrong, build, "deltaTransformer").code)} is not the manifest's codeHash ${ethers.ZeroHash}`]);
  });

  test("R-DEPLOY-VERIFY a manifest address that points at another contract's code differs, even though that code is a deployed contract of ours", async () => {
    const codes = served();
    codes.set(lower(addressOf("hankoVerifier")), codes.get(lower(addressOf("depositoryBounds")))!);
    expect((await rowOf(codes, "hankoVerifier")).match).toBe(false);
  });

  test("R-DEPLOY-VERIFY a node on another chain is refused, not read", async () => {
    await expect(verifyDeployment(manifest, build, chainOf(served(), 1))).rejects.toThrow("the node reports chain id 1, the manifest is for 11155111");
  });

  test("R-DEPLOY-VERIFY an artifact older than its source is refused, not compared", () => {
    const stale: Build = { ...build, staleSources: () => ["contracts/Account.sol"] };
    expect(() => expectedRuntime(manifest, stale, "account")).toThrow("older than contracts/Account.sol: run bash contracts/scripts/build.sh");
  });

  test("R-DEPLOY-VERIFY readBuild names a source that was edited after the build: the edited file, one it imports, and not one it does not import", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "xln-stale-"));
    try {
      // a copy of the project: artifacts/ points at the real build, contracts/ is a copy of the sources that can be edited
      const contractsDir = path.join(import.meta.dir, "..", "..");
      mkdirSync(path.join(dir, "artifacts"));
      symlinkSync(path.join(contractsDir, "artifacts", "build-info"), path.join(dir, "artifacts", "build-info"));
      symlinkSync(path.join(contractsDir, "artifacts", "contracts"), path.join(dir, "artifacts", "contracts"));
      cpSync(path.join(contractsDir, "contracts"), path.join(dir, "contracts"), { recursive: true });
      const copy = readBuild(path.join(dir, "artifacts"));
      const staleOf = (subject: Subject): readonly string[] => copy.staleSources(copy.artifactOf(subject));
      expect(staleOf("depository")).toEqual([]);
      expect(staleOf("hashLadderRegistry")).toEqual([]);
      // a file the Depository imports, directly or through another file
      appendFileSync(path.join(dir, "contracts", "Depository.sol"), "\n// edited after the build\n");
      expect(staleOf("depository")).toEqual(["contracts/Depository.sol"]);
      expect(staleOf("hashLadderRegistry")).toEqual([]);
      appendFileSync(path.join(dir, "contracts", "HashLadder.sol"), "\n// edited after the build\n");
      expect(staleOf("hashLadderRegistry")).toEqual(["contracts/HashLadder.sol"]);
      expect(staleOf("depository")).toEqual(expect.arrayContaining(["contracts/Depository.sol"]));
      // a source that is gone counts as edited
      rmSync(path.join(dir, "contracts", "Depository.sol"));
      expect(staleOf("depository")).toContain("contracts/Depository.sol");
      // and the comparison refuses to build code from such an artifact
      expect(() => expectedRuntime(manifest, copy, "depository")).toThrow("the compiled artifact is older than");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("R-DEPLOY-VERIFY an immutable the check does not know the value of is an error, not a pass", () => {
    const unknown: Build = { ...build, immutableName: () => "somethingNew" };
    expect(() => expectedRuntime(manifest, unknown, "depository")).toThrow('immutable "somethingNew" is not one this check knows');
  });
});

describe("verify.ts as a command, against a throw-away JSON-RPC node on this machine", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "xln-verify-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const manifestFile = path.join(dir, "manifest.json");
  writeFileSync(manifestFile, JSON.stringify(manifest));

  type Node = { readonly url: string; readonly methods: string[]; readonly codeReads: unknown[][]; readonly stop: () => void };
  const startNode = (codes: ReadonlyMap<string, Uint8Array>, chainId = manifest.chainId): Node => {
    const methods: string[] = [];
    const codeReads: unknown[][] = [];
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const { id, method, params } = (await request.json()) as { id: number; method: string; params: unknown[] };
        methods.push(method);
        if (method === "eth_getCode") codeReads.push(params);
        const result = method === "eth_chainId" ? ethers.toBeHex(chainId) : method === "eth_blockNumber" ? ethers.toBeHex(11_820_000)
          : method === "eth_getCode" ? ethers.hexlify(codes.get(lower(String(params[0]))) ?? new Uint8Array()) : null;
        return Response.json(result === null ? { jsonrpc: "2.0", id, error: { message: `${method} is not served` } } : { jsonrpc: "2.0", id, result });
      },
    });
    return { url: `http://127.0.0.1:${server.port}`, methods, codeReads, stop: () => server.stop(true) };
  };
  // The command is run asynchronously: spawnSync would block the event loop that serves the node.
  const run = async (args: readonly string[], env: Record<string, string> = {}) => {
    const child = Bun.spawn(["bun", path.join(deployDir, "verify.ts"), ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, code };
  };

  test("R-DEPLOY-VERIFY a matching chain prints nine matches and exits 0; only the three read methods are ever called", async () => {
    const node = startNode(served());
    try {
      const result = await run(["--rpc", node.url, "--manifest", manifestFile]);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("all 9 match the current build and the manifest");
      expect(result.stdout.match(/ {2}match /g)?.length).toBe(9);
      expect(result.code).toBe(0);
      expect([...new Set(node.methods)].sort()).toEqual(["eth_blockNumber", "eth_chainId", "eth_getCode"]);
      // every code read is for one of the nine addresses, once, at the block eth_blockNumber answered
      expect(node.codeReads.map(([address]) => lower(String(address))).sort()).toEqual(SUBJECTS.map((subject) => lower(addressOf(subject))).sort());
      expect([...new Set(node.codeReads.map(([, block]) => block))]).toEqual([ethers.toBeHex(11_820_000)]);
    } finally { node.stop(); }
  }, 60_000);

  test("R-DEPLOY-VERIFY one differing contract is printed as differ with its first differing byte, the others still match, and the exit is 1", async () => {
    const codes = served();
    const at = plainByte("depository");
    codes.get(lower(addressOf("depository")))![at] ^= 0xff;
    const node = startNode(codes);
    try {
      const result = await run(["--rpc", node.url, "--manifest", manifestFile]);
      expect(result.stdout).toContain(`depository          ${addressOf("depository")}  differ`);
      expect(result.stdout).toContain(`first difference at byte ${at}, in compiled code`);
      expect(result.stdout).toContain("1 of 9 differ");
      expect(result.stdout.match(/ {2}match /g)?.length).toBe(8);
      expect(result.code).toBe(1);
    } finally { node.stop(); }
  }, 60_000);

  test("R-DEPLOY-VERIFY a node that cannot be read, and a node on the wrong chain, exit 2 and print no match", async () => {
    const wrongChain = startNode(served(), 1);
    try {
      const result = await run(["--rpc", wrongChain.url, "--manifest", manifestFile]);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("the node reports chain id 1");
      expect(result.stdout).toBe("");
    } finally { wrongChain.stop(); }
    const closed = await run(["--rpc", "http://127.0.0.1:1", "--manifest", manifestFile]);
    expect(closed.code).toBe(2);
    expect(closed.stderr).toContain("did not answer eth_chainId");
    expect(closed.stdout).toBe("");
  }, 60_000);

  test("R-DEPLOY-VERIFY it never reads a key: the environment's DEPLOYER_PRIVATE_KEY does not reach its output, and its source holds no signer and no write call", async () => {
    const sentinel = "0x" + "ab".repeat(32);
    const node = startNode(served());
    try {
      const result = await run(["--rpc", node.url, "--manifest", manifestFile], { DEPLOYER_PRIVATE_KEY: sentinel });
      expect(result.code).toBe(0);
      expect(result.stdout + result.stderr).not.toContain(sentinel);
    } finally { node.stop(); }
    // code only: the header comment names what the file does not do
    const source = readFileSync(path.join(deployDir, "verify.ts"), "utf8").split("\n").filter((line) => !line.trimStart().startsWith("//")).join("\n").replace(/\/\*\*.*?\*\//g, "");
    expect(source).not.toMatch(/PRIVATE_KEY|process\.env|Wallet|Signer|sendTransaction|eth_send|eth_sign|--live/);
    expect([...new Set(source.match(/"eth_[A-Za-z]+"/g))].sort()).toEqual(['"eth_blockNumber"', '"eth_chainId"', '"eth_getCode"']);
  }, 60_000);

  test("R-DEPLOY-VERIFY rpcChain reads the three values through any JSON-RPC node and says which call failed when the node answers with an error", async () => {
    const node = startNode(served());
    try {
      const chain = rpcChain(node.url);
      expect(await chain.chainId()).toBe(11_155_111);
      expect(await chain.blockNumber()).toBe(11_820_000);
      expect((await chain.getCode(addressOf("hankoVerifier"), 11_820_000)).length).toBeGreaterThan(2);
    } finally { node.stop(); }
    const failing = rpcChain("http://node.example/rpc", (async () => Response.json({ jsonrpc: "2.0", id: 1, error: { message: "rate limited" } })) as never);
    await expect(failing.chainId()).rejects.toThrow("did not answer eth_chainId: rate limited");
  }, 60_000);
});
