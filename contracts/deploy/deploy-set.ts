// Deploy the frozen contract set (contracts/, the fork of jurisdictions/) from a manifest and write the result back as a manifest.
//
//   bun contracts/deploy/deploy-set.ts --rpc http://127.0.0.1:8545 [--manifest deploy/sepolia.manifest.json] [--out <path>] [--live]
//
// What it refuses, before anything is sent (each is a test in test/deploy/guards.test.ts):
//   - a node whose chain id is not the manifest's (a fork of Sepolia reports Sepolia's id, so a dry run on a fork passes the same gates);
//   - a chain the deploy gate refuses (a floor below the mainnet one on a chain that is not a named testnet, an unknown tx gas cap);
//   - a manifest whose floors or HANKO_PRELUDE_GAS differ from the compiled build, or whose batch gas total is above maxRequiredTxGas;
//   - an RPC that is not this machine without --live. A live deploy waits for the owner's word; nothing here broadcasts by itself.
// The key comes from DEPLOYER_PRIVATE_KEY and is never written anywhere. On a loopback node with no key set, anvil's public dev account #0 signs.
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ethers } from "ethers";
import {
  Account__factory, DeltaTransformer__factory, Depository__factory, DepositoryBounds__factory, ERC20Mock__factory, EntityProvider__factory,
  HankoVerifier__factory, HashLadderRegistry__factory, NftCustody__factory,
} from "../typechain-types/index.ts";
import { CONTRACT_NAMES, deployedManifest, parseManifest, type ContractName, type Deployed, type Manifest } from "./manifest.ts";

const require = createRequire(import.meta.url);
const gate = require("../scripts/deploy-gate.cjs") as {
  assertDeployGate(chains: { id?: string; chainId: number }[]): void;
  readCompiledFloor(): number | null;
  readCompiledBatchGas(): { minBudget: number; reserve: number };
  requiredTxGas(gas: { minBudget: number; reserve: number }): number;
  txGasCapOf(chain: { chainId: number }): number | null;
  HANKO_PRELUDE_GAS: number;
  MAINNET_MIN_RESPONSE_SECONDS: number;
};
const foundation = require("../scripts/foundation-hanko.cjs") as {
  foundationEntityId(e: typeof ethers): string;
  buildFoundationTokenListing(e: typeof ethers, args: Record<string, unknown>): { actionNonce: bigint; argumentsHash: string; actionHash: string; hankoData: string };
};

/** Anvil's public dev account #0 (the mnemonic "test test ... junk"). Only ever used against a loopback node. */
const ANVIL_DEV_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const EIP_170_CODE_LIMIT = 24_576;

export const isLoopback = (rpcUrl: string): boolean => ["127.0.0.1", "localhost", "::1", "[::1]"].includes(new URL(rpcUrl).hostname);

/** The key that signs: DEPLOYER_PRIVATE_KEY, or on a loopback node alone anvil's dev key. Anything else is refused. */
export const resolveDeployerKey = (env: Readonly<Record<string, string | undefined>>, rpcUrl: string): string => {
  const configured = (env["DEPLOYER_PRIVATE_KEY"] ?? "").trim();
  if (configured !== "") return configured.startsWith("0x") ? configured : `0x${configured}`;
  if (isLoopback(rpcUrl)) return ANVIL_DEV_KEY;
  throw new Error("DEPLOYER_PRIVATE_KEY is not set (a key is read from the environment only; none is stored in the repository)");
};

export type Target = { readonly manifest: Manifest; readonly nodeChainId: number; readonly rpcUrl: string; readonly live: boolean };

/** Everything that can be refused before a transaction is sent. Returns what the build says (floor, batch gas total, tx gas cap). */
export const assertTarget = ({ manifest, nodeChainId, rpcUrl, live }: Target): { floor: number; requiredTxGas: number; txGasCap: number | null } => {
  if (nodeChainId !== manifest.chainId) throw new Error(`the node reports chain id ${nodeChainId}, the manifest is for ${manifest.chainId} (${manifest.network})`);
  if (!isLoopback(rpcUrl) && !live) throw new Error(`${new URL(rpcUrl).hostname} is not this machine: a live deploy needs --live, and the owner's word`);
  gate.assertDeployGate([{ id: manifest.network, chainId: manifest.chainId }]);
  const floor = gate.readCompiledFloor();
  if (floor === null || floor !== manifest.dispute.responseFloorSeconds) {
    throw new Error(`the manifest says the response floor is ${manifest.dispute.responseFloorSeconds}s, the compiled build says ${floor}s`);
  }
  if (manifest.dispute.mainnetResponseFloorSeconds !== gate.MAINNET_MIN_RESPONSE_SECONDS) {
    throw new Error(`the manifest's mainnet floor ${manifest.dispute.mainnetResponseFloorSeconds}s is not the gate's ${gate.MAINNET_MIN_RESPONSE_SECONDS}s`);
  }
  if (manifest.gas.hankoPreludeGas !== gate.HANKO_PRELUDE_GAS) {
    throw new Error(`the manifest says HANKO_PRELUDE_GAS is ${manifest.gas.hankoPreludeGas}, the deploy gate says ${gate.HANKO_PRELUDE_GAS}`);
  }
  const requiredTxGas = gate.requiredTxGas(gate.readCompiledBatchGas());
  if (requiredTxGas !== manifest.gas.requiredTxGas) throw new Error(`the manifest says a batch needs ${manifest.gas.requiredTxGas} gas, the build needs ${requiredTxGas}`);
  if (requiredTxGas > manifest.gas.maxRequiredTxGas) throw new Error(`a batch needs ${requiredTxGas} gas, above the manifest's ceiling ${manifest.gas.maxRequiredTxGas}`);
  const txGasCap = gate.txGasCapOf({ chainId: manifest.chainId });
  if (txGasCap !== null && requiredTxGas > txGasCap) throw new Error(`a batch needs ${requiredTxGas} gas, above the chain's transaction gas cap ${txGasCap}`);
  return { floor, requiredTxGas, txGasCap };
};

export type DeployOptions = {
  readonly rpcUrl: string;
  readonly manifest: Manifest;
  readonly live?: boolean;
  readonly privateKey?: string;
  readonly log?: (line: string) => void;
};

export const deploySet = async ({ rpcUrl, manifest, live = false, privateKey, log = () => undefined }: DeployOptions): Promise<Manifest> => {
  if (manifest.status !== "prepared") throw new Error("the manifest is already deployed: refusing to deploy over it");
  // cacheTimeout -1: the default 250 ms call cache would answer a second nonce query with the first one's answer.
  const provider = new ethers.JsonRpcProvider(rpcUrl, undefined, { cacheTimeout: -1 });
  const nodeChainId = Number((await provider.getNetwork()).chainId);
  const build = assertTarget({ manifest, nodeChainId, rpcUrl, live });
  const signer = new ethers.Wallet(privateKey ?? resolveDeployerKey(process.env, rpcUrl), provider);
  const deployer = signer.address;
  log(`deploying ${manifest.network} (chain ${nodeChainId}) from ${deployer}; response floor ${build.floor}s, a batch needs ${build.requiredTxGas} gas`);

  const evidence = async (contract: { deploymentTransaction(): ethers.ContractTransactionResponse | null; getAddress(): Promise<string> }, label: string): Promise<Deployed> => {
    const transaction = contract.deploymentTransaction();
    if (transaction === null) throw new Error(`${label}: no deployment transaction`);
    const receipt = await transaction.wait();
    if (receipt === null || receipt.status !== 1) throw new Error(`${label}: the deployment failed`);
    const address = await contract.getAddress();
    const code = await provider.getCode(address);
    if (code === "0x") throw new Error(`${label}: no code at ${address}`);
    if ((code.length - 2) / 2 > EIP_170_CODE_LIMIT) throw new Error(`${label}: ${(code.length - 2) / 2} bytes of code, above the EIP-170 limit`);
    if (build.txGasCap !== null && receipt.gasUsed > BigInt(build.txGasCap)) throw new Error(`${label}: ${receipt.gasUsed} gas, above the chain's transaction gas cap ${build.txGasCap}`);
    log(`  ${label.padEnd(20)} ${address}  gas ${receipt.gasUsed}`);
    return { address, deploymentBlock: receipt.blockNumber, transactionHash: transaction.hash, gasUsed: receipt.gasUsed.toString(), codeHash: ethers.keccak256(code) };
  };

  const recipient = manifest.foundationRecipient === null ? deployer : ethers.getAddress(manifest.foundationRecipient);
  if (recipient !== deployer) throw new Error(`the foundation board is the 1-of-1 ${recipient}; listing the token needs that key, but the deployer is ${deployer}`);

  // One deployment at a time, each mined before the next is sent: a node that is slow to report a nonce cannot reuse it.
  const place = async <C extends ethers.BaseContract>(label: string, deployment: Promise<C>): Promise<{ contract: C; deployed: Deployed }> => {
    const contract = await deployment;
    await contract.waitForDeployment();
    return { contract, deployed: await evidence(contract, label) };
  };
  const done: Partial<Record<ContractName, Deployed>> = {};
  const account = await place("Account", new Account__factory(signer).deploy());
  done.account = account.deployed;
  const hankoVerifier = await place("HankoVerifier", new HankoVerifier__factory(signer).deploy());
  done.hankoVerifier = hankoVerifier.deployed;
  const entityProviderPlaced = await place("EntityProvider", new EntityProvider__factory({ "project/contracts/HankoVerifier.sol:HankoVerifier": done.hankoVerifier.address }, signer).deploy(recipient));
  const entityProvider = entityProviderPlaced.contract;
  done.entityProvider = entityProviderPlaced.deployed;
  done.deltaTransformer = (await place("DeltaTransformer", new DeltaTransformer__factory(signer).deploy())).deployed;
  done.depositoryBounds = (await place("DepositoryBounds", new DepositoryBounds__factory(signer).deploy())).deployed;
  done.hashLadderRegistry = (await place("HashLadderRegistry", new HashLadderRegistry__factory(signer).deploy())).deployed;
  done.nftCustody = (await place("NftCustody", new NftCustody__factory(signer).deploy())).deployed;
  const depositoryPlaced = await place("Depository", new Depository__factory({
    "project/contracts/Account.sol:Account": done.account.address,
    "project/contracts/DepositoryBounds.sol:DepositoryBounds": done.depositoryBounds.address,
    "project/contracts/HashLadderRegistry.sol:HashLadderRegistry": done.hashLadderRegistry.address,
    "project/contracts/custody/NftCustody.sol:NftCustody": done.nftCustody.address,
  }, signer).deploy(done.entityProvider.address, done.deltaTransformer.address));
  const depository = depositoryPlaced.contract;
  done.depository = depositoryPlaced.deployed;

  await (await entityProvider.bindShareDepository(done.depository.address)).wait();
  if ((await entityProvider.shareDepository()).toLowerCase() !== done.depository.address.toLowerCase()) throw new Error("the Depository was not bound to the EntityProvider");

  // The token: a real one is taken as it is; otherwise the testnet faucet. Listed through the Foundation, under its hanko.
  let tokenAddress = manifest.token.address;
  if (tokenAddress === null) {
    const faucet = await place("Faucet token", new ERC20Mock__factory(signer).deploy("Tether USD Test", manifest.token.symbol, manifest.token.decimals, ethers.parseUnits("1000000", manifest.token.decimals)));
    tokenAddress = faucet.deployed.address;
  }
  const decimals = Number(await new ethers.Contract(tokenAddress, ["function decimals() view returns (uint8)"], provider).getFunction("decimals")());
  if (decimals !== manifest.token.decimals) throw new Error(`the token has ${decimals} decimals, the manifest says ${manifest.token.decimals}`);
  const listing = foundation.buildFoundationTokenListing(ethers, {
    chainId: nodeChainId, entityProviderAddress: done.entityProvider.address, foundationNonce: await entityProvider.entityActionNonces(foundation.foundationEntityId(ethers)),
    depository: done.depository.address, tokenType: 0, contractAddress: tokenAddress, externalTokenId: 0, privateKey: signer.privateKey,
  });
  const onchainHash = await entityProvider.computeFoundationActionHash(await entityProvider.FOUNDATION_REGISTER_TOKEN(), listing.argumentsHash, listing.actionNonce);
  if (onchainHash.toLowerCase() !== listing.actionHash.toLowerCase()) throw new Error("the Foundation action hash differs from the chain's");
  await (await entityProvider.foundationRegisterExternalToken(done.depository.address, 0, tokenAddress, 0, listing.hankoData, listing.actionNonce)).wait();
  const tokenId = Number(await depository.getTokensLength()) - 1;
  if (tokenId !== 1) throw new Error(`the token got id ${tokenId}, not 1`);
  log(`  token ${manifest.token.symbol.padEnd(14)} ${tokenAddress} (id ${tokenId})`);

  const contracts = Object.fromEntries(CONTRACT_NAMES.map((name) => [name, done[name]!])) as Record<ContractName, Deployed>;
  const total = CONTRACT_NAMES.reduce((sum, name) => sum + BigInt(contracts[name].gasUsed), 0n);
  const result: Manifest = {
    ...manifest, status: "deployed", deployer, foundationRecipient: recipient, contracts, deploymentGasTotal: total.toString(),
    token: { ...manifest.token, address: tokenAddress, tokenId },
  };
  return deployedManifest(result);
};

type Args = { readonly rpc: string | null; readonly manifest: string; readonly out: string | null; readonly live: boolean };
const parseArgs = (argv: readonly string[]): Args => {
  const value = (flag: string): string | null => { const at = argv.indexOf(flag); return at >= 0 ? argv[at + 1] ?? null : null; };
  return { rpc: value("--rpc") ?? process.env["XLN_DEPLOY_RPC"] ?? null, manifest: value("--manifest") ?? resolve(import.meta.dir, "sepolia.manifest.json"), out: value("--out"), live: argv.includes("--live") };
};

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  if (args.rpc === null) throw new Error("--rpc <url> (or XLN_DEPLOY_RPC) is required");
  // The manifest in the repository is the prepared one: a dry run must not overwrite it with a throw-away chain's addresses.
  if (args.out === null && !args.live) throw new Error("--out <path> is required for a dry run (only --live writes back to the manifest)");
  const out = args.out ?? args.manifest;
  const verdict = parseManifest(JSON.parse(readFileSync(args.manifest, "utf8")));
  if (!verdict.ok) throw new Error(`manifest: ${verdict.problems.join("; ")}`);
  const result = await deploySet({ rpcUrl: args.rpc, manifest: verdict.value, live: args.live, log: console.log });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`manifest written to ${out}; deployment gas ${result.deploymentGasTotal}`);
}
