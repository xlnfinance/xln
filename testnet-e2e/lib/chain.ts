// The J side of the run: parties with anvil-dev style keys, the connection to the deployed Depository, and the reads of
// what the chain holds, which are the check on what the nodes learn. Nothing here sends a batch: every batch is built,
// simulated, sealed, signed and sent by a node's own submit path (pure/host/shell/submit), and the steps only read.
import { ethers } from "ethers";
import { Depository__factory, ERC20Mock__factory } from "../../contracts/typechain-types/index.ts";
import type { deployedManifest } from "../../contracts/deploy/manifest.ts";
import { lazyEntityId } from "../../pure/chain/hanko/hanko.ts";
import { deployment, accountKey, type Deployment } from "../../pure/chain/proof/deployment.ts";
import type { Gas } from "../../pure/j/gas/simulate.ts";
import type { ChainWorld } from "../../pure/host/ops.ts";
import { entityId, type EntityId } from "../../pure/entity/model.ts";
import { keyOf, type Key } from "../../pure/host/shell/link/link.ts";
import { lazySigner } from "../../pure/host/shell/submit/signer.ts";
import { hexToBytes } from "../../pure/kernel/encoding/bytes.ts";
import type { Result } from "../../pure/kernel/core/result.ts";

/** The rewrite's functions return Result; this harness has no recovery from a bad encoding, so it stops there. */
export const must = <T, E>(r: Result<T, E>, what: string): T => {
  if (!r.ok) throw new Error(`${what}: ${JSON.stringify(r.error, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`);
  return r.value;
};

/** A manifest of a deployed set: every contract has its address. */
export type Manifest = ReturnType<typeof deployedManifest>;

export type Party = Readonly<{ name: string; wallet: ethers.Wallet; key: string; id: string }>;

/** A key anybody can recompute: these entities hold test money on a throw-away fork and nothing else. */
export const partyOf = (name: string, provider: ethers.Provider): Party => {
  const key = ethers.keccak256(ethers.toUtf8Bytes(`xln-testnet-e2e-skeleton/${name}`));
  const wallet = new ethers.Wallet(key, provider);
  return { name, wallet, key, id: must(lazyEntityId(wallet.address), `entity id of ${name}`) };
};

export const eid = (p: Party): EntityId => must(entityId(p.id), `entity id of ${p.name}`);

/** The party's key as the shell holds it: the one that signs the link, the batch's Hanko and the transaction. */
export const keyOfParty = (p: Party): Key => must(keyOf(must(hexToBytes(p.key), "key bytes")), `${p.name}'s key`);

/** The lazy Hanko of the party over a batch digest: the shell's own signer, so the harness signs as a node does. */
export const hankoOf = (party: Party, digest: string): string =>
  must(lazySigner(eid(party), keyOfParty(party)).hanko(digest), `hanko of ${party.name}`);

export const accountKeyOf = (a: Party, b: Party): string => must(accountKey(a.id, b.id), "account key");

/** Left is the smaller id, as in the contract's account key. */
export const leftOf = (a: Party, b: Party): Party => (BigInt(a.id) < BigInt(b.id) ? a : b);

/** The chain's transaction gas cap (EIP-7825) and the outer Hanko check an entity's lazy board costs: the harness's choice. */
export const GAS: Gas = { txGasCap: 16_777_216n, prelude: 200_000n };

export type Chain = Readonly<{
  rpc: string;
  provider: ethers.JsonRpcProvider;
  manifest: Manifest;
  chainId: bigint;
  dep: Deployment;
  depository: ReturnType<typeof Depository__factory.connect>;
  token: ReturnType<typeof ERC20Mock__factory.connect>;
  tokenId: bigint;
}>;

export const connect = async (rpc: string, manifest: Manifest): Promise<Chain> => {
  const provider = new ethers.JsonRpcProvider(rpc, undefined, { cacheTimeout: -1 });
  const chainId = (await provider.getNetwork()).chainId;
  const depositoryAddress = manifest.contracts.depository.address;
  return {
    rpc, provider, manifest, chainId,
    dep: must(deployment(chainId, depositoryAddress), "deployment"),
    depository: Depository__factory.connect(depositoryAddress, provider),
    token: ERC20Mock__factory.connect(manifest.token.address!, provider),
    tokenId: BigInt(manifest.token.tokenId!),
  };
};

/** What the chain says that an Entity's action does not: the one transformer a reveal may name, and the faucet token a `fund` may name. */
export const worldOf = (chain: Chain): ChainWorld => ({
  transformer: chain.manifest.contracts.deltaTransformer.address,
  tokens: new Map([[chain.tokenId, { contractAddress: chain.manifest.token.address!, externalTokenId: 0n, tokenType: 0n }]]),
});

export const unit = (chain: Chain): bigint => 10n ** BigInt(chain.manifest.token.decimals);

export const reserveOf = (chain: Chain, p: Party): Promise<bigint> => chain.depository._reserves(p.id, chain.tokenId);

export const collateralOf = async (chain: Chain, a: Party, b: Party, token: bigint = chain.tokenId): Promise<Readonly<{ collateral: bigint; ondelta: bigint }>> => {
  const row = await chain.depository._collaterals(accountKeyOf(a, b), token);
  // Types.sol Int512{int256 high; uint256 low}
  return { collateral: row.collateral, ondelta: (BigInt(row.ondelta[0]) << 256n) + BigInt(row.ondelta[1]) };
};

export const accountOnChain = async (chain: Chain, a: Party, b: Party): Promise<Readonly<{ nonce: bigint; epoch: bigint; disputeOpen: boolean }>> => {
  const row = await chain.depository._accounts(accountKeyOf(a, b));
  return { nonce: row.nonce, epoch: await chain.depository.ondeltaEpoch(a.id, b.id), disputeOpen: row.disputeHash !== ethers.ZeroHash };
};

/** What the Depository keeps for these parties and accounts: the quantity that must never change except by deposits. */
export const heldBy = async (chain: Chain, parties: readonly Party[], accounts: readonly (readonly [Party, Party])[]): Promise<bigint> => {
  const reserves = await Promise.all(parties.map((p) => reserveOf(chain, p)));
  const collaterals = await Promise.all(accounts.map(([a, b]) => collateralOf(chain, a, b)));
  return reserves.reduce((s, r) => s + r, 0n) + collaterals.reduce((s, c) => s + c.collateral, 0n);
};

/** anvil moves the clock; the dispute windows are 60 s each, so a run does not wait them out. */
export const advanceTime = async (chain: Chain, seconds: number): Promise<void> => {
  await chain.provider.send("evm_increaseTime", [seconds]);
  await chain.provider.send("evm_mine", []);
};
