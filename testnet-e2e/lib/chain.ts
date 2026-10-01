// The J side of the run: parties with anvil-dev style keys, batches built and sealed by the rewrite's J builder
// (pure/j/batch: queue, seal), the Host's part of sealing (simulate at the head, R-SIMULATE) done on the fork, signed
// with a lazy Hanko and sent to the deployed Depository, and reads of what the chain holds. Everything that is bytes
// comes from the rewrite (pure/chain: Batch, the payloads, the lazy Hanko, signatures); this file only decides which
// ops to queue and sends what the builder sealed. Its reads of the chain are the check on what the nodes learn.
import { ethers } from "ethers";
import { Depository__factory, ERC20Mock__factory } from "../../contracts/typechain-types/index.ts";
import type { deployedManifest } from "../../contracts/deploy/manifest.ts";
import { lazyEntityId, lazyHanko } from "../../pure/chain/hanko/hanko.ts";
import { deployment, accountKey, type Deployment } from "../../pure/chain/proof/deployment.ts";
import { openJBatch, queue, seal, type SealContext } from "../../pure/j/batch/jbatch.ts";
import { processBatchCall, type SealedBatch } from "../../pure/j/batch/sealed.ts";
import { requirement } from "../../pure/j/gas/gas.ts";
import type { Gas, Simulation } from "../../pure/j/gas/simulate.ts";
import type { ChainWorld } from "../../pure/host/ops.ts";
import type { JOp } from "../../pure/j/op/ops.ts";
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

/** The chain's transaction gas cap (EIP-7825) and the outer Hanko check an entity's lazy board costs: the harness's choice. */
export const GAS: Gas = { txGasCap: 16_777_216n, prelude: 200_000n };
const REFUSAL_EVENTS = ["BatchFailed", "BatchGasStarved", "DisputeOpSkipped"];

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

export type Sent = Readonly<{ events: readonly string[]; gasUsed: bigint; nonce: bigint }>;

const eventsOf = (chain: Chain, receipt: ethers.TransactionReceipt): readonly string[] =>
  receipt.logs
    .filter((log) => log.address.toLowerCase() === chain.manifest.contracts.depository.address.toLowerCase())
    .map((log) => chain.depository.interface.parseLog(log)?.name ?? "?");

/** The Host's answer to "simulate this sealed batch at the head" (R-SIMULATE): run it on the fork at the cap, read the gas, undo it. */
const simulate = async (chain: Chain, party: Party, candidate: SealedBatch): Promise<Simulation> => {
  const call = processBatchCall(candidate, hankoOf(party, candidate.digest));
  const snapshot = await chain.provider.send("evm_snapshot", []);
  try {
    const tx = await chain.depository.connect(party.wallet).processBatch(call.entityId, call.encodedBatch, call.hankoData, call.nonce, { gasLimit: GAS.txGasCap });
    const receipt = await tx.wait();
    const events = receipt === null ? ["no receipt"] : eventsOf(chain, receipt);
    const refused = events.filter((e) => REFUSAL_EVENTS.includes(e));
    if (receipt === null || receipt.status !== 1 || refused.length > 0) {
      return { digest: candidate.digest, outcome: { _tag: "reverts", reason: refused.join(", ") || "the transaction reverted" } };
    }
    // The whole transaction's gas is an upper bound of the self-call's: the budget is sized a little high, never low.
    return { digest: candidate.digest, outcome: { _tag: "ok", applyGas: receipt.gasUsed } };
  } catch (e) {
    return { digest: candidate.digest, outcome: { _tag: "reverts", reason: e instanceof Error ? e.message.slice(0, 120) : String(e) } };
  } finally {
    await chain.provider.send("evm_revert", [snapshot]);
  }
};

/**
 * The ops of `party`, through the rewrite's J builder: queued, sealed at the next nonce (the Host simulates what the
 * builder asks it to, on the fork), signed with a lazy Hanko, sent by the party's own wallet. A batch that does not fully
 * apply (BatchFailed, a gas shortfall, a skipped dispute op) is an error, as in contracts/deploy/smoke.ts.
 */
export const sendOps = async (chain: Chain, party: Party, ops: readonly JOp[], label: string): Promise<Sent> => {
  const stored = await chain.depository.entityNonces(party.id);
  const queued = ops.reduce((j, op) => {
    const out = queue(j, op);
    if (out._tag !== "queued") throw new Error(`${label}: the J builder did not queue ${op._tag}: ${JSON.stringify(out, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`);
    return out.jbatch;
  }, openJBatch(party.id, stored));
  // The Entity's holdings for the funded check: reserve of the one token; the harness holds no debts.
  const treasury = new Map([[chain.tokenId, { reserve: await reserveOf(chain, party), debt: 0n }]]);
  const sealed = async (answers: readonly Simulation[]): Promise<SealedBatch> => {
    const ctx: SealContext = { deployment: chain.dep, treasury, gas: GAS, answers };
    const out = seal(queued, ctx);
    switch (out._tag) {
      case "sealed": return out.batch;
      case "simulate": return sealed([...answers, await simulate(chain, party, out.candidate)]);
      default: throw new Error(`${label}: the J builder answered ${out._tag} ${JSON.stringify(out, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`);
    }
  };
  const batch = await sealed([]);
  const call = processBatchCall(batch, hankoOf(party, batch.digest));
  const need = requirement(GAS.prelude, batch.gasBudget);
  const tx = await chain.depository.connect(party.wallet).processBatch(call.entityId, call.encodedBatch, call.hankoData, call.nonce, { gasLimit: need < GAS.txGasCap ? need + 100_000n : GAS.txGasCap });
  const receipt = await tx.wait();
  if (receipt === null || receipt.status !== 1) throw new Error(`${label}: the transaction reverted`);
  const events = eventsOf(chain, receipt);
  const refused = events.filter((e) => REFUSAL_EVENTS.includes(e));
  if (refused.length > 0) throw new Error(`${label}: the Depository answered ${refused.join(", ")} (events: ${events.join(", ")})`);
  if (!events.includes("HankoBatchProcessed")) throw new Error(`${label}: no HankoBatchProcessed (events: ${events.join(", ")})`);
  return { events, gasUsed: receipt.gasUsed, nonce: batch.nonce };
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
