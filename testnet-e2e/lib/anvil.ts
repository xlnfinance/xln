// A throw-away anvil node, optionally a fork of Sepolia. Nothing here can reach a real chain: the only RPC this harness
// talks to is a loopback one, and the fork URL is read by anvil, which keeps every transaction in its own memory.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";

export const SEPOLIA_RPC = "https://ethereum-sepolia-rpc.publicnode.com";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** The harness sends transactions: only to a node on this machine. */
export const isLoopback = (rpc: string): boolean => {
  try {
    return LOOPBACK.has(new URL(rpc).hostname);
  } catch {
    return false;
  }
};

export const assertLoopback = (rpc: string): void => {
  if (!isLoopback(rpc)) throw new Error(`refusing ${rpc}: the e2e run sends transactions and only a loopback node may receive them`);
};

const anvilBinary = (): string => {
  const candidates = [process.env.ANVIL, "/opt/foundry/anvil", "/foundry/anvil"].filter((c): c is string => !!c);
  return candidates.find((c) => existsSync(c)) ?? "anvil";
};

const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    server.close(() => (typeof address === "object" && address !== null ? resolve(address.port) : reject(new Error("no port"))));
  });
});

const answers = async (url: string): Promise<boolean> => {
  try {
    const reply = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
    return reply.ok;
  } catch {
    return false;
  }
};

export type Anvil = Readonly<{ url: string; stop: () => void }>;

/** `fork` is the URL anvil reads state from, or null for an empty chain (chain id 31337, no deployed contracts). */
export const startAnvil = async (fork: string | null): Promise<Anvil> => {
  const port = await freePort();
  const args = ["--host", "127.0.0.1", "--port", String(port), "--silent", ...(fork === null ? [] : ["--fork-url", fork])];
  const child = spawn(anvilBinary(), args, { stdio: "ignore" });
  const state: { failure: Error | null } = { failure: null };
  child.once("error", (error) => { state.failure = new Error(`anvil did not start (${error.message}); install Foundry (see testnet-e2e/README.md)`); });
  const url = `http://127.0.0.1:${port}`;
  const stop = (): void => { child.kill("SIGTERM"); };
  const deadline = Date.now() + 90_000;
  while (!(await answers(url))) {
    if (state.failure !== null || child.exitCode !== null || Date.now() > deadline) {
      stop();
      throw state.failure ?? new Error("anvil did not become ready within 90 s (a fork needs the RPC to answer)");
    }
    await new Promise((wake) => setTimeout(wake, 250));
  }
  return { url, stop };
};
