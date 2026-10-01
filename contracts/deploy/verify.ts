// Read-only check of a deployed manifest against the chain: is the code the chain holds at each address the code the current build produces?
//
//   bash contracts/scripts/build.sh                                  # the build to compare against
//   bun contracts/deploy/verify.ts [--rpc <url>] [--manifest contracts/deploy/sepolia.manifest.json]
//
// For every contract in the manifest (and the faucet token) it rebuilds the RUNTIME code from the compiled artifact with everything the
// deployment filled in put back: the library addresses substituted into the link slots, and each immutable set to the value the deploy gave it
// (a library's own address; the Depository's EntityProvider, DeltaTransformer and admin; the EntityProvider's deployer; the token's decimals).
// It then reads the code at the address through the RPC and compares every byte, and compares keccak256 of the chain's code with the manifest's
// codeHash. A contract is `match` only when both agree; anything else is `differ`, with the first byte that differs and what that byte is.
//
// Reads only: eth_chainId, eth_blockNumber, eth_getCode. No key, no signer, no environment variable. Nothing here is behind --live because
// nothing here can send a transaction.
//
// Exit codes: 0 every contract matches; 1 at least one differs; 2 the check could not be made (RPC unreachable, wrong chain, no build, bad manifest).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ethers } from "ethers";
import { CONTRACT_NAMES, deployedManifest, type ContractName, type Manifest } from "./manifest.ts";

export const DEFAULT_MANIFEST = resolve(import.meta.dir, "sepolia.manifest.json");
export const DEFAULT_ARTIFACTS = resolve(import.meta.dir, "..", "artifacts");
/** A public node, no key. Any Sepolia node will do; --rpc overrides it. */
export const DEFAULT_SEPOLIA_RPC = "https://ethereum-sepolia-rpc.publicnode.com";

type Range = { readonly start: number; readonly length: number };
export type Artifact = {
  readonly contractName: string;
  readonly deployedBytecode: string;
  readonly deployedLinkReferences: Readonly<Record<string, Readonly<Record<string, readonly Range[]>>>>;
  readonly immutableReferences: Readonly<Record<string, readonly Range[]>>;
  readonly inputSourceName: string;
  readonly buildInfoId: string;
};

/** Where each deployed contract's artifact sits under artifacts/contracts/. */
const ARTIFACT_FILE: Readonly<Record<ContractName | "token", string>> = {
  account: "Account.sol/Account.json", hankoVerifier: "HankoVerifier.sol/HankoVerifier.json", entityProvider: "EntityProvider.sol/EntityProvider.json",
  deltaTransformer: "DeltaTransformer.sol/DeltaTransformer.json", depositoryBounds: "DepositoryBounds.sol/DepositoryBounds.json",
  hashLadderRegistry: "HashLadderRegistry.sol/HashLadderRegistry.json", nftCustody: "custody/NftCustody.sol/NftCustody.json",
  depository: "Depository.sol/Depository.json", token: "ERC20Mock.sol/ERC20Mock.json",
};

export type Subject = ContractName | "token";
export const SUBJECTS: readonly Subject[] = [...CONTRACT_NAMES, "token"];

/** The compiled build: artifact by subject, and the names of the immutables inside it (the artifact only numbers them by syntax-tree id). */
export type Build = {
  readonly artifactOf: (subject: Subject) => Artifact;
  readonly immutableName: (artifact: Artifact, id: string) => string;
  /** The project sources this artifact was compiled from that no longer match the files on disk (empty when the artifact is current). */
  readonly staleSources: (artifact: Artifact) => readonly string[];
};

export const readBuild = (artifactsDir: string = DEFAULT_ARTIFACTS): Build => {
  const outputs = new Map<string, { sources: Record<string, { ast: unknown }> }>();
  const outputOf = (id: string) => {
    const held = outputs.get(id);
    if (held !== undefined) return held;
    const read = (JSON.parse(readFileSync(resolve(artifactsDir, "build-info", `${id}.output.json`), "utf8")) as { output: { sources: Record<string, { ast: unknown }> } }).output;
    outputs.set(id, read);
    return read;
  };
  const artifactOf = (subject: Subject): Artifact => {
    const path = resolve(artifactsDir, "contracts", ARTIFACT_FILE[subject]);
    try { return JSON.parse(readFileSync(path, "utf8")) as Artifact; }
    catch { throw new Error(`no compiled artifact at ${path}: run bash contracts/scripts/build.sh first`); }
  };
  const immutableName = (artifact: Artifact, id: string): string => {
    if (!/^[0-9]+$/.test(id)) return id; // solc names the library's own address itself ("library_deploy_address")
    const found = declarationName(outputOf(artifact.buildInfoId).sources[artifact.inputSourceName]?.ast, Number(id));
    if (found === null) throw new Error(`${artifact.contractName}: immutable ${id} has no declaration in the build info`);
    return found;
  };
  const staleSources = (artifact: Artifact): string[] => {
    // Only the sources this artifact imports, directly or not: the build info of an artifact hardhat did not need to recompile is older than unrelated files.
    const { sources } = outputOf(artifact.buildInfoId);
    const input = (JSON.parse(readFileSync(resolve(artifactsDir, "build-info", `${artifact.buildInfoId}.json`), "utf8")) as { input: { sources: Record<string, { content: string }> } }).input;
    const seen = new Set<string>();
    const visit = (name: string): void => {
      if (seen.has(name)) return;
      seen.add(name);
      const nodes = (sources[name]?.ast as { nodes?: { nodeType: string; absolutePath?: string }[] } | undefined)?.nodes ?? [];
      for (const node of nodes) if (node.nodeType === "ImportDirective" && node.absolutePath !== undefined) visit(node.absolutePath);
    };
    visit(artifact.inputSourceName);
    return [...seen].filter((name) => name.startsWith("project/")).filter((name) => {
      try { return readFileSync(resolve(artifactsDir, "..", name.slice("project/".length)), "utf8") !== input.sources[name]?.content; } catch { return true; }
    }).map((name) => name.slice("project/".length));
  };
  return { artifactOf, immutableName, staleSources };
};

/** The name of the variable declared with this syntax-tree id. */
const declarationName = (node: unknown, id: number): string | null => {
  if (typeof node !== "object" || node === null) return null;
  const record = node as Record<string, unknown>;
  if (record["id"] === id && record["nodeType"] === "VariableDeclaration" && typeof record["name"] === "string") return record["name"];
  for (const child of Object.values(record)) {
    for (const item of Array.isArray(child) ? child : [child]) {
      const found = declarationName(item, id);
      if (found !== null) return found;
    }
  }
  return null;
};

const word = (value: bigint | string): Uint8Array => ethers.getBytes(ethers.zeroPadValue(typeof value === "bigint" ? ethers.toBeHex(value) : value, 32));
const addressOf = (manifest: Manifest & { readonly contracts: NonNullable<Manifest["contracts"]> }, subject: Subject): string =>
  subject === "token" ? manifest.token.address! : manifest.contracts[subject].address;

/** What the deployment gave each named immutable. An immutable this table does not know is an error, never a guess. */
const immutableValue = (manifest: Manifest & { readonly contracts: NonNullable<Manifest["contracts"]> }, subject: Subject, name: string): Uint8Array => {
  const known: Readonly<Record<string, string | bigint>> = {
    library_deploy_address: addressOf(manifest, subject),
    entityProvider: manifest.contracts.entityProvider.address,
    deltaTransformer: manifest.contracts.deltaTransformer.address,
    admin: manifest.deployer!,
    foundationDeployer: manifest.deployer!,
    tokenDecimals: BigInt(manifest.token.decimals),
  };
  const value = known[name];
  if (value === undefined) throw new Error(`${subject}: immutable "${name}" is not one this check knows the deployed value of`);
  return word(value);
};

/** A stretch of the runtime code that is not plain compiled code, so a difference there can be named. */
export type Slot = { readonly start: number; readonly length: number; readonly what: string };

export type Expected = { readonly code: Uint8Array; readonly slots: readonly Slot[] };

/** The runtime code the build gives this subject at its deployed address, with link slots and immutables filled in. */
export const expectedRuntime = (manifest: Manifest, build: Build, subject: Subject): Expected => {
  const deployed = deployedManifest(manifest);
  const artifact = build.artifactOf(subject);
  const stale = build.staleSources(artifact);
  if (stale.length > 0) throw new Error(`${subject}: the compiled artifact is older than ${stale.join(", ")}: run bash contracts/scripts/build.sh first`);
  const code = ethers.getBytes(artifact.deployedBytecode.replace(/__\$[0-9a-fA-F]{34}\$__/g, "0".repeat(40))).slice();
  const slots: Slot[] = [];
  for (const byLibrary of Object.values(artifact.deployedLinkReferences)) {
    for (const [library, ranges] of Object.entries(byLibrary)) {
      const key = library.charAt(0).toLowerCase() + library.slice(1);
      if (!(CONTRACT_NAMES as readonly string[]).includes(key)) throw new Error(`${subject}: linked library ${library} is not in the manifest`);
      for (const { start, length } of ranges) {
        if (length !== 20) throw new Error(`${subject}: a link slot of ${length} bytes`);
        code.set(ethers.getBytes(deployed.contracts[key as ContractName].address), start);
        slots.push({ start, length, what: `link slot for library ${library}` });
      }
    }
  }
  for (const [id, ranges] of Object.entries(artifact.immutableReferences)) {
    const name = build.immutableName(artifact, id);
    const value = immutableValue(deployed, subject, name);
    for (const { start, length } of ranges) {
      if (length !== 32) throw new Error(`${subject}: immutable ${name} slot of ${length} bytes`);
      code.set(value, start);
      slots.push({ start, length, what: `immutable ${name}` });
    }
  }
  return { code, slots: slots.sort((a, b) => a.start - b.start) };
};

const hex = (bytes: Uint8Array, from: number, count: number): string => ethers.hexlify(bytes.slice(from, from + count));

export type Row = {
  readonly subject: Subject;
  readonly address: string;
  readonly match: boolean;
  /** One line per way the chain differs from the build or from the manifest. Empty when it matches. */
  readonly reasons: readonly string[];
  /** Bytes of runtime code on the chain. */
  readonly bytes: number;
  /** keccak256 of the chain's code. */
  readonly chainCodeHash: string;
};

/** Compare the chain's code with the rebuilt code and the manifest's code hash. `manifestCodeHash` is null for the token (the manifest records none). */
export const compareCode = (subject: Subject, address: string, chainCode: string, expected: Expected, manifestCodeHash: string | null): Row => {
  const chain = ethers.getBytes(chainCode);
  const reasons: string[] = [];
  const chainCodeHash = ethers.keccak256(chain);
  if (chain.length === 0) reasons.push(`no code at ${address}`);
  else {
    if (chain.length !== expected.code.length) reasons.push(`the chain holds ${chain.length} bytes, the current build ${expected.code.length}`);
    const shared = Math.min(chain.length, expected.code.length);
    let at = 0;
    while (at < shared && chain[at] === expected.code[at]) at += 1;
    if (at < shared) {
      const slot = expected.slots.find(({ start, length }) => at >= start && at < start + length);
      reasons.push(`first difference at byte ${at}, ${slot === undefined ? "in compiled code" : `inside the ${slot.what} (bytes ${slot.start}..${slot.start + slot.length - 1})`}: chain ${hex(chain, at, 4)}, build ${hex(expected.code, at, 4)}`);
    }
  }
  if (manifestCodeHash !== null && chainCodeHash.toLowerCase() !== manifestCodeHash.toLowerCase()) {
    reasons.push(`keccak256 of the chain's code ${chainCodeHash} is not the manifest's codeHash ${manifestCodeHash}`);
  }
  return { subject, address, match: reasons.length === 0, reasons, bytes: chain.length, chainCodeHash };
};

/** The three reads this check makes. A test hands in a fake; the command reads a JSON-RPC node. */
export type Chain = {
  readonly chainId: () => Promise<number>;
  readonly blockNumber: () => Promise<number>;
  readonly getCode: (address: string, blockNumber: number) => Promise<string>;
};

export type Report = { readonly chainId: number; readonly blockNumber: number; readonly rows: readonly Row[] };

export const verifyDeployment = async (manifestValue: unknown, build: Build, chain: Chain): Promise<Report> => {
  const manifest = deployedManifest(manifestValue);
  const chainId = await chain.chainId();
  if (chainId !== manifest.chainId) throw new Error(`the node reports chain id ${chainId}, the manifest is for ${manifest.chainId} (${manifest.network})`);
  const blockNumber = await chain.blockNumber();
  const rows: Row[] = [];
  for (const subject of SUBJECTS) {
    const address = addressOf(manifest, subject);
    const code = await chain.getCode(address, blockNumber);
    rows.push(compareCode(subject, address, code, expectedRuntime(manifest, build, subject), subject === "token" ? null : manifest.contracts[subject].codeHash));
  }
  return { chainId, blockNumber, rows };
};

/** A JSON-RPC node over HTTP, read calls only. Two retries on a failed request: a public node drops one now and then. */
export const rpcChain = (url: string, fetcher: typeof fetch = fetch): Chain => {
  let next = 1;
  const call = async (method: "eth_chainId" | "eth_blockNumber" | "eth_getCode", params: readonly unknown[]): Promise<string> => {
    let failure = "";
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await fetcher(url, {
          method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(20_000),
          body: JSON.stringify({ jsonrpc: "2.0", id: next++, method, params }),
        });
        const body = (await response.json()) as { result?: unknown; error?: { message?: string } };
        if (typeof body.result === "string") return body.result;
        failure = `${method}: ${body.error?.message ?? `no result (HTTP ${response.status})`}`;
      } catch (error) { failure = `${method}: ${error instanceof Error ? error.message : String(error)}`; }
      await new Promise((done) => setTimeout(done, 400 * (attempt + 1)));
    }
    throw new Error(`the node at ${new URL(url).host} did not answer ${failure}`);
  };
  return {
    chainId: async () => Number(BigInt(await call("eth_chainId", []))),
    blockNumber: async () => Number(BigInt(await call("eth_blockNumber", []))),
    getCode: (address, blockNumber) => call("eth_getCode", [address, ethers.toBeHex(blockNumber)]),
  };
};

export const renderReport = (manifest: Manifest, report: Report, rpcUrl: string): string => {
  const lines = [`${manifest.network} (chain ${report.chainId}), read through ${new URL(rpcUrl).host} at block ${report.blockNumber}`];
  for (const row of report.rows) {
    lines.push(`${row.subject.padEnd(19)} ${row.address}  ${row.match ? "match " : "differ"}  ${row.bytes} bytes`);
    for (const reason of row.reasons) lines.push(`    ${reason}`);
  }
  const differing = report.rows.filter((row) => !row.match).length;
  lines.push(differing === 0 ? `all ${report.rows.length} match the current build and the manifest` : `${differing} of ${report.rows.length} differ`);
  return lines.join("\n");
};

type Args = { readonly rpc: string; readonly manifest: string; readonly artifacts: string };
const parseArgs = (argv: readonly string[]): Args => {
  const value = (flag: string): string | null => { const at = argv.indexOf(flag); return at >= 0 ? argv[at + 1] ?? null : null; };
  return { rpc: value("--rpc") ?? DEFAULT_SEPOLIA_RPC, manifest: value("--manifest") ?? DEFAULT_MANIFEST, artifacts: value("--artifacts") ?? DEFAULT_ARTIFACTS };
};

if (import.meta.main) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const manifest = deployedManifest(JSON.parse(readFileSync(args.manifest, "utf8")));
    const report = await verifyDeployment(manifest, readBuild(args.artifacts), rpcChain(args.rpc));
    console.log(renderReport(manifest, report, args.rpc));
    process.exitCode = report.rows.every((row) => row.match) ? 0 : 1;
  } catch (error) {
    console.error(`verify: could not check: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
