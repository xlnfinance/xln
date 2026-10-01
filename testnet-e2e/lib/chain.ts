// The J side of the run, as a stand-in (gaps `j-batch-builder`, `j-events`): parties with anvil-dev style keys, signed
// batches sent to the deployed Depository, and reads of what the chain holds. Everything that is bytes comes from the
// rewrite on main (pure/chain: Batch, the batch and dispute-proof payloads, the lazy Hanko, signatures); this file only
// decides which Batch to build and sends it.
import { ethers } from "ethers";
import { Depository__factory, ERC20Mock__factory } from "../../contracts/typechain-types/index.ts";
import type { deployedManifest } from "../../contracts/deploy/manifest.ts";
import { emptyBatch, encodeBatch, type Batch } from "../../pure/chain/batch/batch.ts";
import { lazyEntityId, lazyHanko } from "../../pure/chain/hanko/hanko.ts";
import { deployment, accountKey, type Deployment } from "../../pure/chain/proof/deployment.ts";
import { batchHash } from "../../pure/chain/proof/payload.ts";
import { signDigest } from "../../pure/kernel/crypto/signature.ts";
import { bytesToHex, hexToBytes } from "../../pure/kernel/encoding/bytes.ts";
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

/** r || s || v, v in {27, 28}: what the Hanko packs. The signature itself is the rewrite's (kernel/crypto). */
export const signHex = (digest: string, key: string): string => {
  const s = signDigest(must(hexToBytes(digest), "digest"), must(hexToBytes(key), "key"));
  const word = (n: bigint): string => n.toString(16).padStart(64, "0");
  return `0x${word(s.r)}${word(s.s)}${(27 + s.recovery).toString(16)}`;
};

export const hankoOf = (party: Party, digest: string): string =>
  must(lazyHanko(party.id, signHex(digest, party.key)), `hanko of ${party.name}`);

export const accountKeyOf = (a: Party, b: Party): string => must(accountKey(a.id, b.id), "account key");

/** Left is the smaller id, as in the contract's account key. */
export const leftOf = (a: Party, b: Party): Party => (BigInt(a.id) < BigInt(b.id) ? a : b);

const GAS_BUDGET = 3_000_000n;
const TX_GAS_LIMIT = 8_000_000n;
const REFUSAL_EVENTS = ["BatchFailed", "BatchGasStarved", "DisputeOpSkipped"];

export type Chain = Readonly<{
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
    provider, manifest, chainId,
    dep: must(deployment(chainId, depositoryAddress), "deployment"),
    depository: Depository__factory.connect(depositoryAddress, provider),
    token: ERC20Mock__factory.connect(manifest.token.address!, provider),
    tokenId: BigInt(manifest.token.tokenId!),
  };
};

export const unit = (chain: Chain): bigint => 10n ** BigInt(chain.manifest.token.decimals);

export type Sent = Readonly<{ events: readonly string[]; gasUsed: bigint; nonce: bigint }>;

/** One Batch of `party`, built from pure/chain, signed with a lazy Hanko, sent by the party's own wallet. A batch
 * that does not fully apply (BatchFailed, a gas shortfall, a skipped dispute op) is an error, as in contracts/deploy/smoke.ts. */
export const sendBatch = async (chain: Chain, party: Party, patch: Partial<Batch>, label: string): Promise<Sent> => {
  const encoded = must(encodeBatch({ ...emptyBatch(GAS_BUDGET), ...patch }), `${label}: encode`);
  const nonce = (await chain.depository.entityNonces(party.id)) + 1n;
  const digest = must(batchHash(chain.dep, party.id, encoded, nonce), `${label}: batch hash`);
  const hanko = hankoOf(party, digest);
  const tx = await chain.depository.connect(party.wallet).processBatch(party.id, encoded, hanko, nonce, { gasLimit: TX_GAS_LIMIT });
  const receipt = await tx.wait();
  if (receipt === null || receipt.status !== 1) throw new Error(`${label}: the transaction reverted`);
  const events = receipt.logs
    .filter((log) => log.address.toLowerCase() === chain.manifest.contracts.depository.address.toLowerCase())
    .map((log) => chain.depository.interface.parseLog(log)?.name ?? "?");
  const refused = events.filter((e) => REFUSAL_EVENTS.includes(e));
  if (refused.length > 0) throw new Error(`${label}: the Depository answered ${refused.join(", ")} (events: ${events.join(", ")})`);
  if (!events.includes("HankoBatchProcessed")) throw new Error(`${label}: no HankoBatchProcessed (events: ${events.join(", ")})`);
  return { events, gasUsed: receipt.gasUsed, nonce };
};

export const reserveOf = (chain: Chain, p: Party): Promise<bigint> => chain.depository._reserves(p.id, chain.tokenId);

export const collateralOf = async (chain: Chain, a: Party, b: Party): Promise<Readonly<{ collateral: bigint; ondelta: bigint }>> => {
  const row = await chain.depository._collaterals(accountKeyOf(a, b), chain.tokenId);
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

export const asHex = bytesToHex;
