// A dry run of the whole deploy on a throw-away anvil node: deploy the frozen set, then run the smoke test on it. Nothing leaves this machine
// unless --fork is given, and then only reads (anvil fetches state from the RPC; every transaction stays in anvil's memory).
//
//   bun contracts/deploy/dry-run.ts                                   # plain anvil, chain id 31337
//   bun contracts/deploy/dry-run.ts --fork https://ethereum-sepolia-rpc.publicnode.com   # anvil fork of Sepolia, chain id 11155111
//
// The manifest used is the committed prepared one (sepolia.prepared.manifest.json; sepolia.manifest.json is the live record and is never an input); without --fork it is re-targeted at chain 31337. The result goes to --out
// (default: a temp file), never over the committed manifest.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ANVIL_DEV_KEY, assertRecordFree, deploySet, PREPARED_SEPOLIA } from "./deploy-set.ts";
import { parseManifest, type Manifest } from "./manifest.ts";
import { smokeSet, type SmokeReport } from "./smoke.ts";

const LOCAL_CHAIN_ID = 31337;
const READY_TIMEOUT_MS = 60_000;

const freePort = (): Promise<number> => new Promise((resolvePort, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    server.close(() => (typeof address === "object" && address !== null ? resolvePort(address.port) : reject(new Error("no port"))));
  });
});

const rpcReady = async (url: string): Promise<boolean> => {
  try {
    const reply = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
    return reply.ok;
  } catch { return false; }
};

/** Start anvil on a free loopback port and wait until it answers. The caller stops it. */
export const startAnvil = async (fork: string | null): Promise<{ readonly url: string; readonly stop: () => void }> => {
  const port = await freePort();
  const args = ["--host", "127.0.0.1", "--port", String(port), "--silent", ...(fork === null ? [] : ["--fork-url", fork])];
  const child: ChildProcess = spawn("anvil", args, { stdio: "ignore" });
  let failure: Error | null = null;
  child.once("error", (error) => { failure = new Error(`anvil did not start (${error.message}); it is in /foundry (export PATH=$PATH:/foundry)`); });
  const url = `http://127.0.0.1:${port}`;
  const stop = (): void => { child.kill("SIGTERM"); };
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (!(await rpcReady(url))) {
    if (failure !== null || child.exitCode !== null || Date.now() > deadline) { stop(); throw failure ?? new Error("anvil did not become ready"); }
    await new Promise((wake) => setTimeout(wake, 200));
  }
  return { url, stop };
};

export type DryRun = { readonly manifest: Manifest; readonly smoke: SmokeReport; readonly chainId: number };

/** Deploy and smoke-test on a fresh anvil. The prepared manifest's own chain id is kept on a fork and replaced by anvil's 31337 otherwise. */
export const dryRun = async ({ prepared, fork, log = () => undefined }: { prepared: Manifest; fork: string | null; log?: (line: string) => void }): Promise<DryRun> => {
  const manifest: Manifest = fork === null ? { ...prepared, network: "anvil-local", chainId: LOCAL_CHAIN_ID } : prepared;
  const anvil = await startAnvil(fork);
  try {
    log(`anvil ${fork === null ? "(plain)" : `(fork of ${new URL(fork).hostname})`} on ${anvil.url}, chain ${manifest.chainId}`);
    // anvil's own dev key, never the environment's: a real DEPLOYER_PRIVATE_KEY exported for a live deploy must not leak into a throw-away node (and has no funds there).
    const deployed = await deploySet({ rpcUrl: anvil.url, manifest, privateKey: ANVIL_DEV_KEY, log });
    const smoke = await smokeSet({ rpcUrl: anvil.url, manifest: deployed, privateKey: ANVIL_DEV_KEY, log });
    return { manifest: deployed, smoke, chainId: manifest.chainId };
  } finally {
    anvil.stop();
  }
};

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const value = (flag: string): string | null => { const at = argv.indexOf(flag); return at >= 0 ? argv[at + 1] ?? null : null; };
  const fork = value("--fork");
  const manifestPath = value("--manifest") ?? PREPARED_SEPOLIA;
  const out = value("--out") ?? join(mkdtempSync(join(tmpdir(), "xln-dry-run-")), "dry-run.manifest.json");
  const verdict = parseManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
  if (!verdict.ok) throw new Error(`manifest: ${verdict.problems.join("; ")}`);
  if (resolve(out) === resolve(manifestPath)) throw new Error("--out would overwrite the prepared manifest");
  assertRecordFree(out);
  const result = await dryRun({ prepared: verdict.value, fork, log: console.log });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(result.manifest, null, 2)}\n`);
  console.log(`dry run passed on chain ${result.chainId}; deployment gas ${result.manifest.deploymentGasTotal}; manifest in ${out}`);
}
