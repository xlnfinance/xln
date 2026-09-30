// og's Runtime is frozen and speaks the frozen contracts' ABI. The fork's processBatch takes the acting entity first and
// its batch hash binds that entity (C2), so og's submission goes through this shim at the one place it meets the chain:
// og's BrowserVM encodes the processBatch call with its Depository interface. The shim rewrites that one encoding
// (entity from the hanko's target claim, new digest, the same signers re-sign it) and touches nothing else, so what the
// Runtime commits, signs and compares stays og's, and the chain still sees a real hanko for its own digest.
import { ethers } from "ethers";
import { computeBatchHankoHash, decodeJBatch, encodeJBatch, type JBatch } from "../../core/jurisdiction/machine/batch/index.ts";
import { Depository__factory } from "../../contracts/typechain-types/factories/Depository.sol/Depository__factory.ts";
import { DepositoryBounds__factory } from "../../contracts/typechain-types/factories/DepositoryBounds__factory.ts";
import { PROOF_BODY_ABI } from "../../core/protocol/dispute/proof-body.ts";
import { SIGNED_AMOUNT_ABI_COMPONENTS } from "../../core/protocol/crypto/abi-money.ts";
import { encodeCooperativeUpdateDiff, encodeCooperativeUpdateHankoPayload, encodeDisputeProofHankoPayload } from "../../core/hanko/onchain-domain.ts";
import { chainHankoTargetEntityId, isShortHanko } from "../../core/hanko/short.ts";
import {
  decodeHankoEnvelope,
  encodeHankoEnvelope,
  packHankoSignatures,
  recoverHankoSignatures,
  unpackHankoSignatures,
} from "../../core/hanko/codec.ts";

type Hanko = Parameters<typeof decodeHankoEnvelope>[0];
type Sign = (digest: string) => Uint8Array;

/** The fork's batch digest (HankoEncoding.sol, XLN_DEPOSITORY_HANKO_V2): the acting entity is part of what is signed. */
export const forkBatchHash = (chainId: bigint, depository: string, entityId: string, encodedBatch: string, nonce: bigint): string =>
  ethers.keccak256(ethers.solidityPacked(
    ["bytes32", "uint256", "address", "bytes32", "bytes", "uint256"],
    [ethers.id("XLN_DEPOSITORY_HANKO_V2"), chainId, depository, entityId, encodedBatch, nonce],
  ));

/** Keys by signer address, so a hanko can be signed again by whoever signed it the first time. */
export const keyring = (keys: readonly string[]): ((address: string) => Sign | undefined) => {
  const byAddress = new Map(keys.map((k) => [new ethers.Wallet(k).address.toLowerCase(), new ethers.SigningKey(k)]));
  return (address) => {
    const key = byAddress.get(address.toLowerCase());
    return key === undefined ? undefined : (digest) => ethers.getBytes(key.sign(digest).serialized);
  };
};

const addressOf = (signerEntityId: string): string => `0x${signerEntityId.slice(-40)}`;

/** The same hanko, its signers signing `to` instead of `from`; claims, placeholders and signer order are untouched. */
export const resign = (hanko: string, from: string, to: string, signerFor: (address: string) => Sign | undefined): string => {
  const signWith = (address: string): Uint8Array => {
    const sign = signerFor(address);
    if (sign === undefined) throw new Error(`FORK_SHIM_NO_KEY:${address}`);
    return sign(to);
  };
  if (isShortHanko(hanko)) {
    const signer = recoverHankoSignatures(from, packHankoSignatures([ethers.getBytes(hanko)]))[0]!.signerEntityId;
    return ethers.hexlify(signWith(addressOf(signer)));
  }
  const envelope = decodeHankoEnvelope(hanko as Hanko);
  const signers = recoverHankoSignatures(from, envelope.packedSignatures).map((r) => addressOf(r.signerEntityId));
  const packedSignatures = packHankoSignatures(signers.map(signWith));
  // unpacking what was just packed is the round trip encodeHankoEnvelope's own validation relies on
  unpackHankoSignatures(packedSignatures);
  return encodeHankoEnvelope({ ...envelope, packedSignatures });
};

const coder = ethers.AbiCoder.defaultAbiCoder();
const COOPERATIVE_DIFFS = ethers.ParamType.from({
  type: "tuple[]",
  components: [
    { name: "tokenId", type: "uint256" },
    ...["leftDiff", "rightDiff", "collateralDiff", "ondeltaDiff"].map((name) => ({ name, type: "tuple", components: SIGNED_AMOUNT_ABI_COMPONENTS })),
  ],
});
const COOPERATIVE_TYPES = ["uint256", "uint256", "address", "bytes", "uint256", COOPERATIVE_DIFFS, "uint256[]"];
const DISPUTE_TYPES = ["uint256", "uint256", "address", "bytes", "uint256", "bool", "bytes32", "bytes32"];

/** The account key: both entity ids, the smaller first (Depository._accountKey). */
export const accountKey = (a: string, b: string): string =>
  ethers.solidityPacked(["bytes32", "bytes32"], BigInt(a) < BigInt(b) ? [a, b] : [b, a]);

/**
 * C1: the cooperative-update and dispute-proof payloads bind the Account's ondeltaEpoch, straight after the account key.
 * `old` is og's payload; the fork's is the same values with the epoch inserted, so it is derived from og's own encoding.
 */
export const withEpoch = (old: string, types: readonly (string | ethers.ParamType)[], epoch: bigint): string => {
  const values = [...coder.decode(types as never, old)];
  return coder.encode(
    [...types.slice(0, 4), "uint256", ...types.slice(4)] as never,
    [...values.slice(0, 4), epoch, ...values.slice(4)],
  );
};

const digestOf = (payload: string): string => ethers.keccak256(payload);
const proofBodyHash = (body: unknown): string => ethers.keccak256(coder.encode([ethers.ParamType.from(PROOF_BODY_ABI)], [body]));

/** One signature og made over `old`, made again by the same signers over `next`; left alone when nobody here holds their key. */
const rebind = (sig: string, old: string, next: string, signerFor: (a: string) => Sign | undefined): string => {
  if (sig === "0x" || sig === "") return sig;
  try {
    return resign(sig, old, next, signerFor);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("FORK_SHIM_NO_KEY")) return sig;
    throw error;
  }
};

type Chain = { chainId: bigint; depository: string };

/**
 * The batch og sealed, with every epoch-bound signature signed again for the Account's epoch on chain now. og signed
 * before the fork's ABI existed, and only these two payload kinds changed (HankoEncoding.sol); the signers are the ones
 * og's own hanko names, so no authority is invented.
 */
export const rebindBatch = (
  batch: JBatch,
  entityId: string,
  epochOf: (left: string, right: string) => bigint,
  domain: Chain,
  signerFor: (a: string) => Sign | undefined,
): JBatch => {
  const dom = { chainId: domain.chainId, depositoryAddress: domain.depository };
  const epochFor = (other: string): { key: string; epoch: bigint } => {
    const key = accountKey(entityId, other);
    return { key, epoch: epochOf(entityId, other) };
  };
  const cooperative = (other: string, nonce: number, diffs: JBatch["settlements"][number]["diffs"], forgive: readonly number[], sig: string): string => {
    const { key, epoch } = epochFor(other);
    const old = encodeCooperativeUpdateHankoPayload(dom, key, nonce, diffs, forgive);
    return rebind(sig, digestOf(old), digestOf(withEpoch(old, COOPERATIVE_TYPES, epoch)), signerFor);
  };
  const dispute = (other: string, nonce: number, proposerIsLeft: boolean, hash: string, watchSeed: string, sig: string): string => {
    const { key, epoch } = epochFor(other);
    const old = encodeDisputeProofHankoPayload(dom, key, nonce, proposerIsLeft, hash, watchSeed);
    return rebind(sig, digestOf(old), digestOf(withEpoch(old, DISPUTE_TYPES, epoch)), signerFor);
  };
  return {
    ...batch,
    settlements: batch.settlements.map((s) => {
      const other = entityId.toLowerCase() === s.leftEntity.toLowerCase() ? s.rightEntity : s.leftEntity;
      return { ...s, sig: cooperative(other, s.nonce, s.diffs, s.forgiveDebtsInTokenIds, s.sig) };
    }),
    collateralToReserve: batch.collateralToReserve.map((c) => {
      // the contract rebuilds the one diff a collateral-to-reserve shortcut stands for (Account.sol)
      const isLeft = BigInt(entityId) < BigInt(c.counterparty);
      const amount = c.amount;
      const diffs = [{
        tokenId: c.tokenId,
        leftDiff: isLeft ? amount : 0n,
        rightDiff: isLeft ? 0n : amount,
        collateralDiff: -amount,
        ondeltaDiff: isLeft ? -amount : 0n,
      }];
      return { ...c, sig: cooperative(c.counterparty, c.nonce, diffs, [], c.sig) };
    }),
    disputeStarts: batch.disputeStarts.map((d) => ({
      ...d, sig: dispute(d.counterentity, d.nonce, d.proposerIsLeft, d.proofbodyHash, d.watchSeed, d.sig),
    })),
    counterDisputes: batch.counterDisputes.map((d) => ({
      ...d, sig: dispute(d.counterentity, d.counterNonce, d.proposerIsLeft, proofBodyHash(d.counterProofbody), String(d.counterProofbody.watchSeed), d.sig),
    })),
    disputeFinalizations: batch.disputeFinalizations.map((d) => (d.cooperative ? d : {
      ...d,
      sig: dispute(d.counterentity, d.finalNonce, d.proposerIsLeft, proofBodyHash(d.finalProofbody), String(d.finalProofbody.watchSeed), d.sig),
    })),
  };
};

/**
 * J5: the fork's Batch carries a signed gas budget (first field) and each dispute start the Account epoch its signature was made at
 * (`ondeltaEpoch`). og's Batch has neither, so the shim adds both when it re-encodes: the epoch is the one `rebindBatch` just
 * signed the start for, and the budget is the shim's own. og's BrowserVM sends every processBatch with a 15,000,000 gas limit, and the
 * Depository wants budget * 64 / 63 + 30,000 (BATCH_POST_CALL_RESERVE) plus the hanko prelude on top of it, so the shim signs
 * 14,000,000: room for the prelude of a board of a few dozen signers, and far above what any batch the walks build costs.
 */
export const SHIM_GAS_BUDGET = 14_000_000n;
const FORK_BATCH_PARAM = DepositoryBounds__factory.createInterface().getFunction("assertBatch")!.inputs[0]!;

/** og's batch (already re-signed for the epochs on chain now) in the fork's ABI: the budget in front, the epoch in every dispute start. */
export const encodeForkBatch = (
  batch: JBatch,
  entityId: string,
  epochOf: (left: string, right: string) => bigint,
  gasBudget: bigint = SHIM_GAS_BUDGET,
): string =>
  coder.encode([FORK_BATCH_PARAM], [{
    gasBudget,
    ...batch,
    settlements: batch.settlements.map((settlement) => ({ ...settlement, diffs: settlement.diffs.map(encodeCooperativeUpdateDiff) })),
    disputeStarts: batch.disputeStarts.map((start) => ({ ...start, ondeltaEpoch: epochOf(entityId, start.counterentity) })),
  }]);

/** Chain digest to og's digest, for every batch this process submitted; og's event codec reads it back. */
const seen: Map<string, string>[] = [];
let viewInstalled = false;
/**
 * og's event codec parses logs with an interface of its own (depository-event-codec.ts), so the digest og sealed is
 * put back into HankoBatchProcessed at ethers' one parseLog, for every interface, once.
 */
const installBatchHashView = (): void => {
  if (viewInstalled) return;
  viewInstalled = true;
  const parse = ethers.Interface.prototype.parseLog;
  ethers.Interface.prototype.parseLog = function (this: ethers.Interface, log: { topics: readonly string[]; data: string }) {
    const parsed = parse.call(this, log);
    if (parsed === null || parsed.name !== "HankoBatchProcessed") return parsed;
    const chain = String(parsed.args["batchHash"]).toLowerCase();
    const shown = seen.map((m) => m.get(chain)).find((h) => h !== undefined);
    if (shown === undefined) return parsed;
    const names = parsed.fragment.inputs.map((input) => input.name);
    const items = parsed.args.map((value, i) => (names[i] === "batchHash" ? shown : value));
    return new ethers.LogDescription(parsed.fragment, parsed.topic, ethers.Result.fromItems(items, names));
  } as typeof ethers.Interface.prototype.parseLog;
};

/** The batch og sealed, by the fork-encoded batch the chain got (J5: the fork's bytes carry a gas budget and epochs og's do not). */
const ogBatchOf = new Map<string, string>();
let calldataInstalled = false;
/**
 * og reads dispute evidence back out of the chain's own transaction calldata (rpc-public.ts), by parsing it with a
 * Depository interface and taking the batch as the first argument of processBatch. The fork's call carries the acting
 * Entity first, so og's parse of it is shown the same call in og's shape: the entity dropped from the arguments, and the
 * batch as og sealed it (og decodes it with its own ABI, which has no gasBudget and no ondeltaEpoch).
 */
const installCalldataView = (): void => {
  if (calldataInstalled) return;
  calldataInstalled = true;
  const fork = new ethers.Interface(Depository__factory.abi);
  const selector = fork.getFunction("processBatch")!.selector;
  const parse = ethers.Interface.prototype.parseTransaction;
  ethers.Interface.prototype.parseTransaction = function (this: ethers.Interface, tx: { data: string; value?: ethers.BigNumberish }) {
    if (tx.data.slice(0, 10).toLowerCase() !== selector) return parse.call(this, tx);
    const call = parse.call(fork, tx)!;
    const [encodedBatch, ...rest] = call.args.slice(1);
    const shown = ogBatchOf.get(String(encodedBatch).toLowerCase()) ?? encodedBatch;
    return { name: call.name, args: ethers.Result.fromItems([shown, ...rest], ["encodedBatch", "hankoData", "nonce"]), fragment: call.fragment, selector: call.selector, signature: call.signature, value: call.value };
  } as typeof ethers.Interface.prototype.parseTransaction;
};

type Encoder = { encodeFunctionData: (fragment: unknown, values?: readonly unknown[]) => string };
type Vm = {
  depositoryInterface: Encoder & { decodeFunctionResult: (f: string, d: string) => ethers.Result };
  depositoryAddress: { toString: () => string } | undefined;
  deployerAddress: unknown;
  runReadOnlyCall: (call: unknown) => Promise<{ execResult: { returnValue: Uint8Array } }>;
  hasProcessedBatch: (entityId: string, batchHash: string, nonce: bigint) => boolean;
};
type Plan = { readonly entityId: string; readonly encodedBatch: string; readonly hanko: string };

/** The chain's refusals, and how many batches it accepted (a check that nothing was refused proves nothing when none was sent). */
export type Refusals = (() => readonly string[]) & { readonly landed: () => number };

/**
 * Make og's BrowserVM talk to the fork's Depository. `vm` is og's BrowserVMProvider; its interface is the fork's
 * (installContracts), so processBatch there takes four arguments while og passes three. Each submission is translated
 * once, asynchronously (the Account epochs are read from the chain), and the encoder then only looks the plan up. og
 * matches the chain's HankoBatchProcessed to the batch it sealed by hash, so the chain's digest is shown to og as og's own.
 * Returns the refusals: a batch the chain rejected must fail the walk, since og logs it and carries on, which reads as
 * agreement.
 */
export const shimBatchSubmission = (
  vm: unknown,
  chainId: bigint,
  depository: string,
  keys: readonly string[],
): Refusals => {
  installBatchHashView();
  installCalldataView();
  const provider = vm as Vm;
  const iface = provider.depositoryInterface;
  const encode = iface.encodeFunctionData.bind(iface);
  const processed = provider.hasProcessedBatch.bind(provider);
  const signerFor = keyring(keys);
  const forkOf = new Map<string, string>();
  const ogOf = new Map<string, string>();
  seen.push(ogOf);
  const plans = new Map<string, Plan>();
  const planKey = (encodedBatch: string, nonce: bigint): string => `${nonce}:${encodedBatch}`;

  const epochs = new Map<string, bigint>();
  const readEpoch = async (a: string, b: string): Promise<void> => {
    const data = iface.encodeFunctionData("ondeltaEpoch", [a, b]);
    const result = await provider.runReadOnlyCall({
      to: provider.depositoryAddress, caller: provider.deployerAddress, data: ethers.getBytes(data), gasLimit: 500_000n,
    });
    epochs.set(accountKey(a, b), BigInt(iface.decodeFunctionResult("ondeltaEpoch", ethers.hexlify(result.execResult.returnValue))[0]));
  };
  const plan = async (encodedBatch: string, hanko: string, nonce: bigint): Promise<void> => {
    const old = computeBatchHankoHash(chainId, depository, encodedBatch, nonce);
    const entityId = chainHankoTargetEntityId(hanko, old);
    const batch = decodeJBatch(encodedBatch);
    if (encodeJBatch(batch) !== encodedBatch) throw new Error("FORK_SHIM_BATCH_ROUNDTRIP");
    const others = [
      ...batch.settlements.map((s) => (entityId.toLowerCase() === s.leftEntity.toLowerCase() ? s.rightEntity : s.leftEntity)),
      ...batch.collateralToReserve.map((c) => c.counterparty),
      ...batch.disputeStarts.map((d) => d.counterentity),
      ...batch.counterDisputes.map((d) => d.counterentity),
      ...batch.disputeFinalizations.map((d) => d.counterentity),
    ];
    await Promise.all(others.map((other) => readEpoch(entityId, other)));
    const epochOf = (l: string, r: string): bigint => epochs.get(accountKey(l, r)) ?? 0n;
    const rebound = rebindBatch(batch, entityId, epochOf, { chainId, depository }, signerFor);
    const next = encodeForkBatch(rebound, entityId, epochOf);
    const digest = forkBatchHash(chainId, depository, entityId, next, nonce);
    ogBatchOf.set(next.toLowerCase(), encodedBatch);
    forkOf.set(old.toLowerCase(), digest);
    ogOf.set(digest.toLowerCase(), old);
    plans.set(planKey(encodedBatch, nonce), { entityId, encodedBatch: next, hanko: resign(hanko, old, digest, signerFor) });
  };

  iface.encodeFunctionData = (fragment, values = []) => {
    const name = typeof fragment === "string" ? fragment : (fragment as { name?: string }).name;
    if (name !== "processBatch" || values.length !== 3) return encode(fragment, values);
    const [encodedBatch, , nonce] = values as [string, string, bigint];
    const planned = plans.get(planKey(encodedBatch, nonce));
    if (planned === undefined) throw new Error("FORK_SHIM_BATCH_NOT_PLANNED");
    return encode(fragment, [planned.entityId, planned.encodedBatch, planned.hanko, nonce]);
  };
  const refused: string[] = [];
  let landed = 0;
  (["processBatch", "processBatchAs"] as const).forEach((method) => {
    const original = (provider as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[method]!.bind(provider);
    (provider as unknown as Record<string, unknown>)[method] = async (encodedBatch: string, hanko: string, nonce: bigint, ...rest: unknown[]) => {
      try {
        await plan(encodedBatch, hanko, nonce);
        const result = await original(encodedBatch, hanko, nonce, ...rest);
        landed += 1;
        return result;
      } catch (error) {
        refused.push(`${method} refused: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
        throw error;
      }
    };
  });
  provider.hasProcessedBatch = (entityId, batchHash, nonce) => processed(entityId, forkOf.get(batchHash.toLowerCase()) ?? batchHash, nonce);
  return Object.assign(() => refused as readonly string[], { landed: () => landed });
};
