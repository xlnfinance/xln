// Encoding vectors produced by the contracts themselves, in BrowserVM. `bun contracts/scripts/write-vectors.ts` writes
// contracts/vectors/*.json from this; vectors.test.ts fails when the committed files drift from what the contracts say.
//
// Two kinds:
//   functions.json  every audit-surface and pure encoder the contracts expose, called on the deployed bytecode with
//                   deterministic sample arguments (small and wide values), as calldata and return data.
//   lifecycle.json  one account lifecycle run through the real Depository: the values production stores and emits.
import { ethers } from "ethers";
import { createAddressFromString } from "@ethereumjs/util";
import { Account__factory, DeltaTransformer__factory, EntityProvider__factory, HankoCodec__factory } from "../../typechain-types/index.ts";
import { boot, claimsHanko, rawHanko, bodyHash, type Rig } from "./rig.ts";
import { encodeInt512, encodeSignedAmount } from "../../../core/protocol/crypto/abi-money.ts";

const coder = ethers.AbiCoder.defaultAbiCoder();

// ---- deterministic sample values, derived from the ABI ----

const digest = (path: string): string => ethers.keccak256(ethers.toUtf8Bytes(path));

const sample = (param: ethers.ParamType, path: string, wide: boolean): unknown => {
  if (param.baseType === "array") {
    const length = wide ? 2 : 1;
    return Array.from({ length }, (_, i) => sample(param.arrayChildren!, `${path}[${i}]`, wide));
  }
  if (param.baseType === "tuple") return Object.fromEntries(param.components!.map((c, i) => [c.name || `f${i}`, sample(c, `${path}.${c.name || i}`, wide)]));
  if (param.baseType === "bool") return wide;
  if (param.baseType === "address") return ethers.getAddress(`0x${digest(path).slice(26)}`);
  if (param.baseType === "bytes32") return digest(path);
  if (param.baseType === "bytes") return wide ? `0x${digest(path).slice(2, 76)}` : "0x";
  if (param.baseType === "string") return wide ? path : "";
  const uint = /^uint(\d*)$/.exec(param.baseType);
  if (uint) return wide ? (1n << BigInt(uint[1] ? Number(uint[1]) : 256)) - 1n : 7n;
  const int = /^int(\d*)$/.exec(param.baseType);
  if (int) return wide ? -(1n << BigInt((int[1] ? Number(int[1]) : 256) - 1)) : -7n;
  throw new Error(`no sample for ${param.baseType}`);
};

// ---- JSON: bigints as decimal strings, everything else as ethers gives it ----
const json = (value: unknown): unknown => {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(json);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as object).map(([k, v]) => [k, json(v)]));
  return value;
};
/** An event as the J layer reads it: name, decoded args and position, without block or transaction ids. */
const eventsJson = (events: readonly unknown[]): unknown =>
  json((events as { name: string; args: unknown; logIndex: number }[]).map(({ name, args, logIndex }) => ({ name, args, logIndex })));
const jsonOfResult = (r: ethers.Result | unknown): unknown => (r instanceof ethers.Result ? json(r.toObject ? safeObject(r) : r.toArray()) : json(r));
const safeObject = (r: ethers.Result): unknown => { try { return r.toObject(); } catch { return r.toArray(); } };

type Called = { readonly calldata: string; readonly returnData: string; readonly decoded: unknown };

const caller = (rig: Rig) => async (to: string, iface: ethers.Interface, fn: string, args: readonly unknown[]): Promise<Called> => {
  const calldata = iface.encodeFunctionData(fn, args as unknown[]);
  const result = await rig.vm.runReadOnlyCall({ to: createAddressFromString(to), caller: rig.vm.deployerAddress, data: ethers.getBytes(calldata), gasLimit: 50_000_000n });
  if (result.execResult.exceptionError) throw new Error(`${fn} reverted: ${JSON.stringify(result.execResult.exceptionError)}`);
  const returnData = ethers.hexlify(result.execResult.returnValue);
  return { calldata, returnData, decoded: jsonOfResult(iface.decodeFunctionResult(fn, returnData)) };
};

/** Deploy the audit codec next to the stack (it is not part of deployStack) and return its address. */
const deployCodec = async (rig: Rig): Promise<string> => {
  const state = await rig.vm.vm.stateManager.getAccount(rig.vm.deployerAddress);
  const address = ethers.getCreateAddress({ from: rig.vm.deployerAddress.toString(), nonce: state.nonce });
  await rig.vm.executeTx({ data: HankoCodec__factory.bytecode, gasLimit: 30_000_000n });
  return address;
};

// ---- the proof bodies handled by hand (the contract enforces bounds on them) ----
const bodySamples = async (rig: Rig, call: ReturnType<typeof caller>) => {
  const one = rig.body(-30n);
  const wide = { ...rig.body((1n << 300n) - 1n, 3600), tokenIds: [1, 7], offdeltas: [(1n << 300n) - 1n, -(1n << 300n)] };
  // The clause payload is what DeltaTransformer.encodeBatch returns for a payment and a swap.
  const encoded = await call(rig.chain.addresses.deltaTransformer, DeltaTransformer__factory.createInterface(), "encodeBatch", [{
    payment: [{ deltaIndex: 0, amount: encodeSignedAmount(-50n), revealedUntilTimestamp: 1_800_001_000, hash: ethers.id("hashlock") }],
    swap: [{ ownerIsLeft: true, addDeltaIndex: 0, addAmount: 10n, subDeltaIndex: 1, subAmount: 20n }],
    pull: [],
  }]);
  const clause = {
    transformerAddress: rig.chain.addresses.deltaTransformer,
    encodedBatch: (encoded.decoded as string[])[0]!,
    allowances: [{ deltaIndex: 0, rightAllowance: 50n, leftAllowance: 50n }],
  };
  return [
    { name: "one-token", body: { ...one, offdeltas: one.offdeltas.map((x) => x), transformers: [] } },
    { name: "wide-two-token", body: { ...wide, transformers: [] } },
    { name: "with-canonical-clause", body: { ...one, offdeltas: [...one.offdeltas], transformers: [clause] } },
  ];
};

export const functionVectors = async (rig: Rig) => {
  const call = caller(rig);
  const codecAddress = await deployCodec(rig);
  const out: unknown[] = [];
  const record = async (contract: string, to: string, iface: ethers.Interface, fn: string, args: readonly unknown[], label: string) =>
    out.push({ contract, function: iface.getFunction(fn)!.format("sighash"), label, args: json(args), ...(await call(to, iface, fn, args).catch((e) => { throw new Error(`${contract}.${fn} [${label}]: ${e.message}`); })) });

  const codec = HankoCodec__factory.createInterface();
  for (const fragment of codec.fragments.filter((f): f is ethers.FunctionFragment => f.type === "function")) {
    for (const wide of [false, true]) {
      const args = fragment.inputs.map((p, i) => sample(p, `${fragment.name}.${p.name || i}`, wide));
      await record("HankoCodec", codecAddress, codec, fragment.name, args, wide ? "wide" : "small");
    }
  }

  const account = Account__factory.createInterface();
  const accountAddress = rig.chain.addresses.account;
  for (const wide of [false, true]) {
    const fragment = account.getFunction("encodeDisputeHash")!;
    await record("Account", accountAddress, account, "encodeDisputeHash", fragment.inputs.map((p, i) => sample(p, `encodeDisputeHash.${p.name || i}`, wide)), wide ? "wide" : "small");
  }
  for (const { name, body } of await bodySamples(rig, call)) {
    const struct = { ...body, offdeltas: body.offdeltas.map((v: bigint) => encodeInt512(v)), transformers: body.transformers };
    await record("HankoCodec", codecAddress, codec, "proofBodyHash", [struct], name);
  }

  const transformer = DeltaTransformer__factory.createInterface();
  const transformerAddress = rig.chain.addresses.deltaTransformer;
  const batch = transformer.getFunction("encodeBatch")!.inputs[0]!;
  for (const wide of [false, true]) {
    await record("DeltaTransformer", transformerAddress, transformer, "encodeBatch", [sample(batch, "encodeBatch.b", wide)], wide ? "wide" : "small");
  }

  // Hanko verification: what the EntityProvider returns for the two accepted envelope shapes.
  const provider = EntityProvider__factory.createInterface();
  const signerKey = ethers.id("vectors-signer");
  const hash = ethers.id("vectors-hash");
  const raw = rawHanko(hash, signerKey);
  const lazy = (await call(rig.chain.addresses.entityProvider, provider, "verifyHankoSignature", [raw, hash])).decoded as { entityId: string };
  await record("EntityProvider", rig.chain.addresses.entityProvider, provider, "verifyHankoSignature", [raw, hash], "raw 65-byte signature: lazy entity");
  await record("EntityProvider", rig.chain.addresses.entityProvider, provider, "verifyHankoSignature", [claimsHanko(raw, lazy.entityId), hash], "claims envelope naming the lazy entity");
  await record("EntityProvider", rig.chain.addresses.entityProvider, provider, "verifyHankoSignature", [claimsHanko(raw, ethers.id("other-entity")), hash], "claims envelope naming an unregistered entity: rejected");
  return { codecAddress, vectors: out };
};

/** A batch as production saw it: the bytes, the entity nonce, our hash and the hash the contract emitted for it. */
const batchRecord = (rig: Rig, result: string) => {
  const batch = rig.last.batch!;
  const emitted = (rig.last.events as { name: string; args: { batchHash?: string } }[]).find((e) => e.name === "HankoBatchProcessed");
  return { result, entityId: batch.entityId, entityNonce: batch.nonce.toString(), encodedBatch: batch.encodedBatch, batchHashComputed: batch.hash, batchHashEmitted: emitted?.args.batchHash ?? null };
};

/** Lifecycles through the real Depository; every value here is read back from production storage or events. */
export const lifecycleVectors = async (rig: Rig) => {
  const { L, R } = rig;
  const call = caller(rig);
  const account = Account__factory.createInterface();
  await rig.fundedAccount();
  const deposit = { ...batchRecord(rig, "ok"), events: eventsJson(rig.last.events) };
  const epoch0 = await rig.epochOf();

  // Cooperative settlement: Left withdraws 10 of its collateral, signed by Right at the current epoch.
  const diffs = [{ tokenId: rig.TOKEN, leftDiff: 10n, rightDiff: 0n, collateralDiff: -10n, ondeltaDiff: -10n }];
  const settleResult = await rig.settle(L, R, 5, diffs, rig.coopSig(R, epoch0, 5, diffs));
  const settle = { ...batchRecord(rig, settleResult), epoch: epoch0.toString(), nonce: 5, cooperativeUpdateHash: rig.coopHash(epoch0, 5, diffs), diffs: json(diffs), events: eventsJson(rig.last.events) };
  const epoch1 = await rig.epochOf();

  // Dispute at the new epoch: start by Right with Left's proof, finalize by timeout.
  const P7 = rig.body(-10n);
  const startResult = await rig.start(R, L, 7, true, P7, rig.proofSig(L, epoch1, 7, true, P7));
  const startBatch = batchRecord(rig, startResult);
  const startEvents = rig.last.events;
  const stored = await rig.chain.getAccountInfo(L.id, R.id);
  const startTimestamp = 1_800_000_000;
  const expectedDisputeHash = (await call(rig.chain.addresses.account, account, "encodeDisputeHash",
    [7, false, true, stored.disputeTimeout, 60, 60, bodyHash(P7), startTimestamp, "0x", "0x", ethers.ZeroHash])).decoded;
  rig.at(130);
  const finalizeResult = await rig.finalize(R, L, { nonce: 7, body: P7, startedByLeft: false }, { nonce: 7, proposerIsLeft: true, body: P7, sig: "0x" });
  const finalizeBatch = batchRecord(rig, finalizeResult);
  const finalizeEvents = rig.last.events;
  const empty = ethers.keccak256("0x");
  const evidence = ethers.keccak256(coder.encode(
    ["bytes32", "uint256", "bool", "bool", "bytes32", "bytes32", "bytes32"],
    [bodyHash(P7), 7, true, false, empty, empty, empty]));
  const reservesAfter = json(await rig.reserves());

  // Reopen after the epoch-advancing finalize. A timeout finalize consumed one nonce (7 -> 8), so the reopened baseline
  // proof must carry a nonce strictly above the stored 8. Proof nonce and off-chain frame height are separate counters.
  const epoch2 = await rig.epochOf();
  const storedAfter = await rig.chain.getAccountInfo(L.id, R.id);
  const P9 = rig.body(-10n);
  const at = async (nonce: number, epoch: bigint) => rig.start(R, L, nonce, true, P9, rig.proofSig(L, epoch, nonce, true, P9));
  const reopen = {
    storedNonce: storedAfter.nonce.toString(), epoch: epoch2.toString(),
    startAtStoredNonce: await at(8, epoch2),
    startAtOldBaselineNonce: await at(7, epoch1),
    settleAtStoredNonce: await rig.settle(L, R, 8, diffs, rig.coopSig(R, epoch2, 8, diffs)),
    startAboveStoredNonce: await at(9, epoch2),
  };
  return {
    accountKey: rig.acctKey, left: L.id, right: R.id,
    depository: rig.domain.depository, chainId: rig.domain.chainId.toString(),
    deposit, settle,
    epochAfterSettle: epoch1.toString(), epochAfterFinalize: (await rig.epochOf()).toString(),
    disputeStart: {
      ...startBatch, nonce: 7, epoch: epoch1.toString(), proofBodyHash: bodyHash(P7), disputeHashStored: stored.disputeHash,
      disputeHashFromEncodeDisputeHash: (expectedDisputeHash as string[])[0], disputeTimeout: stored.disputeTimeout.toString(), startTimestamp,
      events: eventsJson(startEvents),
    },
    disputeFinalize: { ...finalizeBatch, finalizationEvidenceHashExpected: evidence, events: eventsJson(finalizeEvents) },
    reservesAfter,
    reopen,
  };
};

/**
 * The spec's baseline rule: a settlement's Lock frame carries a co-signed baseline proof for epoch + 1 (offdelta 0, no
 * clauses, a nonce above the chain's), signed BEFORE the settlement executes, so the honest side always holds a proof it
 * can start a dispute with. Each scenario signs the baseline first, advances the epoch, then starts with it.
 */
export const baselineVectors = async () => {
  const at = (rig: Rig, nonce: number, epoch: bigint, offdelta = 0n) => {
    const body = rig.body(offdelta);
    return { body, nonce, epoch, hash: rig.proofHash(epoch, nonce, true, body), sig: rig.proofSig(rig.L, epoch, nonce, true, body) };
  };
  const startWith = (rig: Rig, b: ReturnType<typeof at>) => rig.start(rig.R, rig.L, b.nonce, true, b.body, b.sig);
  const timeout = (rig: Rig, nonce: number, body: ReturnType<Rig["body"]>) =>
    rig.finalize(rig.R, rig.L, { nonce, body, startedByLeft: false }, { nonce, proposerIsLeft: true, body, sig: "0x" });
  const record = (b: ReturnType<typeof at>) => ({ epoch: b.epoch.toString(), nonce: b.nonce, proofBodyHash: bodyHash(b.body), proofHash: b.hash });

  // 1. After a cooperative settlement (the epoch advances 0 -> 1; the chain's nonce becomes the settlement's, 5).
  const a = await boot("baseline-settle");
  await a.fundedAccount();
  const diffs = [{ tokenId: a.TOKEN, leftDiff: 10n, rightDiff: 0n, collateralDiff: -10n, ondeltaDiff: -10n }];
  const baselineA = at(a, 6, (await a.epochOf()) + 1n);
  const settleA = await a.settle(a.L, a.R, 5, diffs, a.coopSig(a.R, await a.epochOf(), 5, diffs));
  a.at(10);
  const afterSettle = { epoch: (await a.epochOf()).toString(), storedNonce: (await a.chain.getAccountInfo(a.L.id, a.R.id)).nonce.toString() };
  const startA = await startWith(a, baselineA);

  // 2. After a timeout finalize (dispute started at nonce 7, so the chain's nonce becomes 8 and the epoch 1).
  const b = await boot("baseline-finalize");
  await b.fundedAccount();
  const dispute = b.body(-10n);
  const first = await b.start(b.R, b.L, 7, true, dispute, b.proofSig(b.L, await b.epochOf(), 7, true, dispute));
  const baselineB = at(b, 9, (await b.epochOf()) + 1n);
  const atStored = at(b, 8, baselineB.epoch);
  b.at(130);
  const finalized = await timeout(b, 7, dispute);
  b.at(140);
  const afterFinalize = { epoch: (await b.epochOf()).toString(), storedNonce: (await b.chain.getAccountInfo(b.L.id, b.R.id)).nonce.toString() };
  const startAtStored = await startWith(b, atStored);
  const startB = await startWith(b, baselineB);

  // 3. Folding offdelta into ondeltaDiff leaves the payout unchanged: the same Account, offdelta -30, settled by a
  //    dispute on the old state (epoch 0) and by folding the -30 into ondelta then disputing the offdelta-0 baseline.
  const payout = async (folded: boolean) => {
    const rig = await boot(folded ? "baseline-folded" : "baseline-unfolded");
    await rig.fundedAccount();                                    // Left 900, Right 1000, collateral 100 (ondelta 100)
    if (!folded) {
      const old = at(rig, 1, await rig.epochOf(), -30n);
      rig.at(10);
      const started = await startWith(rig, old);
      rig.at(140);
      const done = await timeout(rig, 1, old.body);
      return { started, finalized: done, ...json(await rig.reserves()) as object };
    }
    const fold = [{ tokenId: rig.TOKEN, leftDiff: 0n, rightDiff: 0n, collateralDiff: 0n, ondeltaDiff: -30n }];
    const baseline = at(rig, 2, (await rig.epochOf()) + 1n);
    const settled = await rig.settle(rig.L, rig.R, 1, fold, rig.coopSig(rig.R, await rig.epochOf(), 1, fold));
    rig.at(10);
    const started = await startWith(rig, baseline);
    rig.at(140);
    const done = await timeout(rig, 2, baseline.body);
    return { settled, started, finalized: done, ...json(await rig.reserves()) as object };
  };

  return {
    afterSettlement: { baseline: record(baselineA), settle: settleA, ...afterSettle, start: startA },
    afterTimeoutFinalize: {
      firstDisputeStart: first, finalize: finalized, ...afterFinalize,
      baseline: record(baselineB), startAtStoredNonce: startAtStored, startAboveStoredNonce: startB,
    },
    foldedOffdelta: { unfolded: await payout(false), folded: await payout(true) },
  };
};

export const allVectors = async () => {
  const functions = await functionVectors(await boot("vectors-functions"));
  const lifecycle = await lifecycleVectors(await boot("vectors-lifecycle"));
  const baseline = await baselineVectors();
  return { functions, lifecycle, baseline };
};
