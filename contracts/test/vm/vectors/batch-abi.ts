// Batch ABI vectors produced by the contracts themselves, in BrowserVM. The lifecycle vectors run four op kinds (R2C, settlement, dispute
// start, finalize); the Batch struct has eleven op arrays and a signed gas budget. This pins the whole layout and runs the ops the lifecycle does not:
//
//   layout  the deployed DepositoryBounds.assertBatch decodes a Batch from calldata (the same ABI decode processBatch does). One case per field with only that
//           array populated, plus every array at once, in distinct "mixed" values so a swap of two fields or two slots changes the bytes. The contract accepts
//           each, which is what pins the field order and every struct's slot order; the bound rejections (E10) are recorded too.
//   ops     the ops the lifecycle does not run, through the real Depository: reserve to reserve, reserve to collateral with two pairs, collateral to reserve,
//           a reveal of a payment secret, a counter dispute, a composite batch (R2R + C2R, the implicit flash), each with its encoded batch, hashes and events.
//
// Not run against the real Depository here (recorded as layout only): external token in and out (an ERC-20 must be deployed and listed first) and hash-ladder
// registration (it needs a Pull dispute). Their layout is in `layout`; their behaviour has Hardhat tests (Depository-part-2, HashLadderRegistry).
import { ethers } from "ethers";
import { createAddressFromString } from "@ethereumjs/util";
import { DepositoryBounds__factory, Depository__factory } from "../../../typechain-types/index.ts";
import { boot, party, bodyHash, type Rig } from "../rig.ts";

const coder = ethers.AbiCoder.defaultAbiCoder();
const digest = (path: string): string => ethers.keccak256(ethers.toUtf8Bytes(path));

type Mode = "small" | "wide" | "mixed";
const distinct = (path: string, bits: number): bigint => (BigInt(digest(path)) % (1n << BigInt(Math.min(bits, 20)))) + 1n;

/** A deterministic value for an ABI type; `mixed` gives every slot its own small value (negative for signed types), `wide` the type's limit, `small` 7. */
const sample = (param: ethers.ParamType, path: string, mode: Mode): unknown => {
  if (param.baseType === "array") {
    const length = param.arrayLength && param.arrayLength > 0 ? param.arrayLength : mode === "small" ? 1 : 2;
    return Array.from({ length }, (_, i) => sample(param.arrayChildren!, `${path}[${i}]`, mode));
  }
  if (param.baseType === "tuple") return Object.fromEntries(param.components!.map((c, i) => [c.name || `f${i}`, sample(c, `${path}.${c.name || i}`, mode)]));
  if (param.baseType === "bool") return mode === "mixed" ? BigInt(digest(path)) % 2n === 0n : mode === "wide";
  if (param.baseType === "address") return ethers.getAddress(`0x${digest(path).slice(26)}`);
  if (param.baseType === "bytes32") return digest(path);
  if (param.baseType === "bytes") return mode === "small" ? "0x" : `0x${digest(path).slice(2, 76)}`;
  const uint = /^uint(\d*)$/.exec(param.baseType);
  if (uint) {
    const bits = uint[1] ? Number(uint[1]) : 256;
    return mode === "wide" ? (1n << BigInt(bits)) - 1n : mode === "mixed" ? distinct(path, bits) : 7n;
  }
  const int = /^int(\d*)$/.exec(param.baseType);
  if (int) {
    const bits = int[1] ? Number(int[1]) : 256;
    return mode === "wide" ? -(1n << BigInt(bits - 1)) : mode === "mixed" ? -distinct(path, bits - 1) : -7n;
  }
  throw new Error(`no sample for ${param.baseType}`);
};

const json = (value: unknown): unknown => {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(json);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as object).map(([k, v]) => [k, json(v)]));
  return value;
};
const eventsJson = (events: readonly unknown[]): unknown =>
  json((events as { name: string; args: unknown; logIndex: number }[]).map(({ name, args, logIndex }) => ({ name, args, logIndex })));

const bounds = DepositoryBounds__factory.createInterface();
const depositoryErrors = Depository__factory.createInterface();
const BATCH_PARAM = bounds.getFunction("assertBatch")!.inputs[0]!;
const OP_FIELDS = BATCH_PARAM.components!.filter((c) => c.baseType === "array").map((c) => c.name);
const GAS_BUDGET = 15_000_000n;
const ASSERT_BATCH_SELECTOR = ethers.id("assertBatch(Batch)").slice(0, 10);

/** The deployed bounds library (the same bytecode processBatch links), called read-only. */
const boundsProbe = async (rig: Rig) => {
  const state = await rig.vm.vm.stateManager.getAccount(rig.vm.deployerAddress);
  const address = ethers.getCreateAddress({ from: rig.vm.deployerAddress.toString(), nonce: state.nonce });
  await rig.vm.executeTx({ data: DepositoryBounds__factory.bytecode, gasLimit: 30_000_000n });
  return async (batch: unknown, param: ethers.ParamType = BATCH_PARAM) => {
    // A library's external selector is over its source signature, `assertBatch(Batch)` (0xab551cf9), not the expanded tuple ethers derives.
    const encodedBatch = coder.encode([param], [batch]);
    const calldata = `${ASSERT_BATCH_SELECTOR}${encodedBatch.slice(2)}`;
    const result = await rig.vm.runReadOnlyCall({ to: createAddressFromString(address), caller: rig.vm.deployerAddress, data: ethers.getBytes(calldata), gasLimit: 50_000_000n });
    const returned = ethers.hexlify(result.execResult.returnValue ?? new Uint8Array());
    const named = (data: string): string => (data.length >= 10 ? depositoryErrors.parseError(data)?.name : undefined) ?? (data === "0x" ? "revert with no data" : data);
    const error = result.execResult.exceptionError ? named(returned) : null;
    return { encodedBatch, accepted: error === null, ...(error === null ? {} : { rejectedWith: error }) };
  };
};

/** A batch carries at most one dispute finalization (DepositoryBounds); every other array gets the sample's two (one for `small`). */
const populated = (field: ethers.ParamType, mode: Mode): unknown[] => (sample(field, `batch.${field.name}`, mode) as unknown[]).slice(0, field.name === "disputeFinalizations" ? 1 : 2);

const batchWith = (mode: Mode, populate: readonly string[], gasBudget = GAS_BUDGET): Record<string, unknown> =>
  Object.fromEntries(BATCH_PARAM.components!.map((c) => [
    c.name,
    c.name === "gasBudget" ? gasBudget : populate.includes(c.name) ? populated(c, mode) : [],
  ]));

type Segment = string | number;
type Json = { type: string; name?: string; components?: Json[] };
/** The Batch type with the slot at `at` widened to uint256, so a value the real type cannot hold can be encoded into the same layout. */
const widened = (at: readonly Segment[]): ethers.ParamType => {
  const root = JSON.parse(BATCH_PARAM.format("json")) as Json;
  const node = at.filter((segment) => typeof segment === "string").reduce<Json>((n, name) => n.components!.find((c) => c.name === name)!, root);
  node.type = "uint256";
  return ethers.ParamType.from(root);
};
const setAt = (value: unknown, at: readonly Segment[], leaf: unknown): unknown => {
  if (at.length === 0) return leaf;
  const [head, ...rest] = at as [Segment, ...Segment[]];
  if (Array.isArray(value)) return value.map((item, i) => (i === head ? setAt(item, rest, leaf) : item));
  return { ...(value as object), [head]: setAt((value as Record<string, unknown>)[head as string], rest, leaf) };
};
/** Every bool slot of the Batch, first element of each array: where a one-hot case can tell two bools of one struct apart. */
const boolSlots = (param: ethers.ParamType, at: readonly Segment[] = []): (readonly Segment[])[] => {
  if (param.baseType === "array") return boolSlots(param.arrayChildren!, [...at, 0]);
  if (param.baseType === "tuple") return param.components!.flatMap((c) => boolSlots(c, [...at, c.name]));
  return param.baseType === "bool" ? [at] : [];
};

/** `count` small elements of an op array (the bounds are on lengths, so the values are the smallest legal ones). */
const small = (field: string, count: number): unknown[] => {
  const param = BATCH_PARAM.components!.find((c) => c.name === field)!;
  return Array.from({ length: count }, (_, i) => sample(param.arrayChildren!, `batch.${field}[${i}]`, "small"));
};
const pairsOf = (count: number): unknown[] => {
  const param = BATCH_PARAM.components!.find((c) => c.name === "reserveToCollateral")!.arrayChildren!.components!.find((c) => c.name === "pairs")!;
  return Array.from({ length: count }, (_, i) => sample(param.arrayChildren!, `pairs[${i}]`, "small"));
};
const withOps = (counts: Readonly<Record<string, number>>, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...batchWith("small", []), ...Object.fromEntries(Object.entries(counts).map(([field, n]) => [field, small(field, n)])), ...extra,
});

export const layoutVectors = async (rig: Rig) => {
  const probe = await boundsProbe(rig);
  const cases: unknown[] = [];
  // `input` is the value that was ABI encoded (numbers as decimal strings), so an encoder elsewhere can build the same bytes from it
  const record = async (label: string, batch: Record<string, unknown>, extra: { shape?: unknown; param?: ethers.ParamType; input?: boolean } = {}) => {
    const { encodedBatch, ...verdict } = await probe(batch, extra.param);
    // a bound case is a count of small ops: `shape` says what it was, and the bytes (up to 190 KB of zeros and sample words) are not kept
    cases.push({ label, ...(extra.input === false ? { shape: extra.shape } : { input: json(batch), encodedBatch }), ...verdict });
  };
  for (const field of OP_FIELDS) await record(`only ${field} (mixed values)`, batchWith("mixed", [field]));
  await record("every array, mixed values", batchWith("mixed", OP_FIELDS));
  await record("every array, small values", batchWith("small", OP_FIELDS));
  await record("every array, wide values (every slot at its type's limit)", { ...batchWith("wide", OP_FIELDS), gasBudget: (1n << 64n) - 1n });
  await record("no ops, the minimum gas budget", batchWith("small", [], 500_000n));
  await record("gas budget below the minimum: rejected", batchWith("small", [], 499_999n));

  // two bools of one struct can coincide in the mixed sample (a swap would not show): one case per bool slot, that slot alone true
  for (const at of boolSlots(BATCH_PARAM)) await record(`one-hot: only ${at.join(".")} is true`, setAt(batchWith("small", OP_FIELDS), at, true) as Record<string, unknown>);

  // a value one past the slot's type: the deployed decoder refuses it (the same layout, the slot widened to uint256 for the encoding)
  const pastType = async (label: string, at: readonly Segment[], value: bigint) => {
    const batch = setAt(batchWith("small", OP_FIELDS), at, value) as Record<string, unknown>;
    await record(label, batch, { param: widened(at) });
  };
  await pastType("gasBudget 2^64 (uint64): rejected", ["gasBudget"], 1n << 64n);
  await pastType("externalTokenToReserve.tokenType 256 (uint8): rejected", ["externalTokenToReserve", 0, "tokenType"], 256n);
  await pastType("hashLadderRegistrations.witness.fillRatio 65536 (uint16): rejected", ["hashLadderRegistrations", 0, "witness", "fillRatio"], 65_536n);
  await pastType("disputeFinalizations.cooperative 2 (bool): rejected", ["disputeFinalizations", 0, "cooperative"], 2n);

  // the bounds (DepositoryBounds), at the edge; the values are the smallest legal ones, so `shape` names what is populated
  const bound = async (label: string, shape: Record<string, number>, extra: Record<string, unknown> = {}) => record(label, withOps(shape, extra), { shape: { ...shape, ...(extra.reserveToCollateral ? { pairsPerReserveToCollateral: (extra.reserveToCollateral as { pairs: unknown[] }[]).map((r) => r.pairs.length) } : {}) }, input: false });
  await bound("50 reserve-to-reserve ops in all: accepted", { reserveToReserve: 50 });
  await bound("51 ops in all: rejected", { reserveToReserve: 51 });
  await bound("8 dispute starts: accepted", { disputeStarts: 8 });
  await bound("9 dispute starts: rejected", { disputeStarts: 9 });
  await bound("1 dispute finalization: accepted", { disputeFinalizations: 1 });
  await bound("2 dispute finalizations: rejected", { disputeFinalizations: 2 });
  const r2c = (pairCounts: readonly number[]) => small("reserveToCollateral", pairCounts.length).map((op, i) => ({ ...(op as object), pairs: pairsOf(pairCounts[i]!) }));
  await bound("one reserve-to-collateral with 64 pairs: accepted", {}, { reserveToCollateral: r2c([64]) });
  await bound("one reserve-to-collateral with 65 pairs: rejected", {}, { reserveToCollateral: r2c([65]) });
  await bound("five reserve-to-collateral ops with 50 pairs each (250 in all): accepted", {}, { reserveToCollateral: r2c([50, 50, 50, 50, 50]) });
  await bound("251 pairs in all: rejected", {}, { reserveToCollateral: r2c([50, 50, 50, 50, 51]) });
  await bound("1000 reserve-to-reserve ops: rejected", { reserveToReserve: 1000 });
  return { fields: BATCH_PARAM.components!.map((c) => c.name), gasBudget: GAS_BUDGET.toString(), cases };
};

// ---- ops through the real Depository ----

/** What one batch did: the bytes, the nonce, the hash, the result and the events, and the state the caller reads after. */
const ran = async (rig: Rig, result: string, state: Record<string, unknown>, input: Record<string, unknown>) => {
  const batch = rig.last.batch!;
  const failed = (rig.last.events as { name: string; args: { reason: string } }[]).find((e) => e.name === "BatchFailed");
  return {
    result: failed ? `ok, batch failed (${depositoryErrors.parseError(String(failed.args.reason))?.name ?? failed.args.reason})` : result,
    entityId: batch.entityId, entityNonce: batch.nonce.toString(), input: json(input), encodedBatch: batch.encodedBatch, batchHash: batch.hash,
    events: eventsJson(rig.last.events), state: json(state),
  };
};

export const opVectors = async () => {
  const third = party("batch-ops-third").id;

  // reserve to reserve, then reserve to collateral with two pairs (one to the counterparty, one to a third entity)
  const a = await boot("batch-ops-r2r");
  await a.chain.debugFundReserves(a.L.id, a.TOKEN, 1000n);
  const r2rOps = { reserveToReserve: [{ receivingEntity: a.R.id, tokenId: a.TOKEN, amount: 123n }] };
  const r2r = await a.submit(a.L, r2rOps);
  const reserveToReserve = await ran(a, r2r, { left: await a.chain.getReserves(a.L.id, a.TOKEN), right: await a.chain.getReserves(a.R.id, a.TOKEN) }, r2rOps);
  const r2cOps = { reserveToCollateral: [{ tokenId: a.TOKEN, receivingEntity: a.L.id, pairs: [{ entity: a.R.id, amount: 100n }, { entity: third, amount: 50n }] }] };
  const r2c = await a.submit(a.L, r2cOps);
  const reserveToCollateral = await ran(a, r2c, {
    left: await a.chain.getReserves(a.L.id, a.TOKEN),
    collateralWithRight: await a.chain.getCollateral(a.L.id, a.R.id, a.TOKEN),
    collateralWithThird: await a.chain.getCollateral(a.L.id, third, a.TOKEN),
  }, r2cOps);

  // collateral to reserve (the shortcut for a cooperative settlement), signed by the counterparty
  const b = await boot("batch-ops-c2r");
  await b.fundedAccount();
  const epoch = await b.epochOf();
  const c2rNonce = 3;
  const c2rDiffs = [{ tokenId: b.TOKEN, leftDiff: 40n, rightDiff: 0n, collateralDiff: -40n, ondeltaDiff: -40n }];
  const c2rSig = b.coopSig(b.R, epoch, c2rNonce, c2rDiffs);
  const c2rOps = { collateralToReserve: [{ counterparty: b.R.id, tokenId: b.TOKEN, amount: 40n, nonce: c2rNonce, sig: c2rSig }] };
  const c2r = await b.submit(b.L, c2rOps);
  const collateralToReserve = {
    ...(await ran(b, c2r, { left: await b.chain.getReserves(b.L.id, b.TOKEN), collateral: await b.chain.getCollateral(b.L.id, b.R.id, b.TOKEN), storedNonce: (await b.chain.getAccountInfo(b.L.id, b.R.id)).nonce }, c2rOps)),
    cooperativeUpdateHash: b.coopHash(epoch, c2rNonce, c2rDiffs), signedDiffs: json(c2rDiffs),
    accountKey: b.acctKey, epoch: epoch.toString(), depository: b.domain.depository, chainId: b.domain.chainId.toString(),
  };

  // a reveal of a payment secret to the canonical transformer
  const c = await boot("batch-ops-reveal");
  await c.chain.debugFundReserves(c.L.id, c.TOKEN, 1n);
  const secret = ethers.id("batch-ops-secret");
  const revealOps = { revealSecrets: [{ transformer: c.chain.addresses.deltaTransformer, secret }] };
  const reveal = await c.submit(c.L, revealOps);
  const revealSecrets = {
    ...(await ran(c, reveal, {}, revealOps)),
    hashlock: ethers.keccak256(coder.encode(["bytes32"], [secret])), transformer: c.chain.addresses.deltaTransformer,
  };

  // a counter dispute: Right starts with Left's proof at nonce 7, Left locks Right's newer proof at nonce 9
  const d = await boot("batch-ops-counter");
  await d.fundedAccount();
  const dEpoch = await d.epochOf();
  const P7 = d.body(-10n);
  const P9 = d.body(-20n);
  const started = await d.start(d.R, d.L, 7, true, P7, d.proofSig(d.L, dEpoch, 7, true, P7), dEpoch);
  const countered = await d.counter(d.L, d.R, { nonce: 7, body: P7 }, { nonce: 9, proposerIsLeft: false, body: P9, sig: d.proofSig(d.R, dEpoch, 9, false, P9) });
  const counterDispute = {
    start: started,
    ...(await ran(d, countered, { storedNonce: (await d.chain.getAccountInfo(d.L.id, d.R.id)).nonce }, { initial: { nonce: 7, body: P7 }, counter: { nonce: 9, proposerIsLeft: false, body: P9, sig: d.proofSig(d.R, dEpoch, 9, false, P9) } })),
    counterProofHash: d.proofHash(dEpoch, 9, false, P9), counterProofBodyHash: bodyHash(P9),
  };

  // the implicit flash: R2R of more than the initiator holds, repaid by a C2R in the same batch
  const e = await boot("batch-ops-flash");
  await e.fundedAccount();                                       // Left 900, collateral 100
  const eEpoch = await e.epochOf();
  const flashDiffs = [{ tokenId: e.TOKEN, leftDiff: 100n, rightDiff: 0n, collateralDiff: -100n, ondeltaDiff: -100n }];
  const flashOps = {
    reserveToReserve: [{ receivingEntity: e.R.id, tokenId: e.TOKEN, amount: 950n }],        // holds 900: 50 short, repaid below
    collateralToReserve: [{ counterparty: e.R.id, tokenId: e.TOKEN, amount: 100n, nonce: 3, sig: e.coopSig(e.R, eEpoch, 3, flashDiffs) }],
  };
  const flash = await e.submit(e.L, flashOps);
  const composite = await ran(e, flash, { left: await e.chain.getReserves(e.L.id, e.TOKEN), right: await e.chain.getReserves(e.R.id, e.TOKEN), collateral: await e.chain.getCollateral(e.L.id, e.R.id, e.TOKEN) }, flashOps);

  return { reserveToReserve, reserveToCollateral, collateralToReserve, revealSecrets, counterDispute, composite };
};

