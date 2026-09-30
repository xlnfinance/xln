// J5 gas (PR #54, third round): the batch carries a SIGNED gas budget. processBatch requires gasleft() >= budget * 64/63 + BATCH_POST_CALL_RESERVE
// before the self-call (else BatchGasStarved: revert, no nonce) and gives the ops EXACTLY the budget. Consequences pinned here, on the real stack:
//   G1  a relayer's gas limit never decides a signature check: at no limit does a good batch soft-fail (20k, 100k, 300k ERC-1271 members and a
//       member that rejects under 500k gas), every limit under the requirement reverts, and from the requirement up every limit lands the same way;
//   F2  a valid batch that needs more than the old 15M floor (two C2Rs against two 8-member ERC-1271 boards, 15.6M) lands at its own budget;
//   B   a budget below the need is the signer's own doing: from the requirement up EVERY limit reports BatchFailed E4, never a landed half batch.
// One file per process: `bun test contracts/test/vm/j5-gas-budget.test.ts` (BURN=..., STEP=... narrow the G1 scan).
import { describe, expect, test } from "bun:test";
import { ethers } from "ethers";
import { createAddressFromString } from "@ethereumjs/util";
import { boot, party, signWith, singleSignerBoard } from "./rig.ts";
import { Depository__factory as forkDepository } from "../../typechain-types/index.ts";

const coder = ethers.AbiCoder.defaultAbiCoder();
const BATCH_FAILED = ethers.id("BatchFailed(bytes32,uint256,bytes4)");
const BATCH_PROCESSED = ethers.id("HankoBatchProcessed(bytes32,bytes32,uint256)");
const E4 = ethers.id("E4()").slice(0, 10);
const GUARD = "0x013e4115"; // BatchGasStarved()
const HANKO_ABI = ["tuple(bytes32[],bytes,tuple(bytes32,uint256[],uint256[],uint256,uint32,uint32,uint32)[],bytes[])"];
const BOARD_ABI = ["tuple(uint16 votingThreshold, bytes32[] entityIds, uint16[] votingPowers, uint32 boardChangeDelay, uint32 controlChangeDelay, uint32 dividendChangeDelay)"];
/** BATCH_POST_CALL_RESERVE of Depository.sol. */
const RESERVE = 30_000n;
/** What the self-call needs in the transaction beyond the outer prelude (63/64 rule, so the call is given the whole budget). */
const withBudget = (budget: bigint): bigint => (budget * 64n) / 63n + RESERVE;

/** Runtime code of an honest ERC-1271 member: spends about 26 * iterations gas, then returns 0x1626ba7e00..00. */
const memberRuntime = (iterations: number): string =>
  "0x61" + iterations.toString(16).padStart(4, "0") + "5b6001900380600357" + "50" + "7f" + "1626ba7e" + "00".repeat(28) + "600052" + "60206000f3";
/** A member whose verdict depends on the gas it is given: it rejects when gasleft() < 500,000 and otherwise returns the magic. */
const gasSensitiveRuntime =
  "0x" + "62" + "07a120" + "5a" + "10" + "6032" + "57" + "7f" + "1626ba7e" + "00".repeat(28) + "600052" + "60206000f3" + "5b" + "600060" + "00fd";

type World = Awaited<ReturnType<typeof boot>>;
type Probe = { limit: bigint; ok: boolean; rv: string; failed: boolean; processed: boolean; used: bigint; reason: string };

/** Run `data` read-only at `gasLimit`: what a node would answer for a transaction with that limit. */
const prober = (w: World, data: Uint8Array) => async (gasLimit: bigint): Promise<Probe> => {
  const r = await w.vm.runReadOnlyCall({ to: w.vm.depositoryAddress, caller: w.vm.deployerAddress, data, gasLimit });
  const logs = (r.execResult.logs ?? []) as [Uint8Array, Uint8Array[], Uint8Array][];
  const topics = logs.map((l) => ethers.hexlify(l[1][0]!));
  const failedLog = logs.find((l) => ethers.hexlify(l[1][0]!) === BATCH_FAILED);
  return {
    limit: gasLimit, rv: ethers.hexlify(r.execResult.returnValue ?? new Uint8Array()).slice(0, 10), ok: r.execResult.exceptionError === undefined,
    failed: topics.includes(BATCH_FAILED), processed: topics.includes(BATCH_PROCESSED), used: BigInt(r.execResult.executionGasUsed),
    reason: failedLog ? ethers.hexlify(failedLog[2]).slice(0, 10) : "",
  };
};
const kindOf = (o: Probe): string => (o.ok ? (o.failed ? `BatchFailed(${o.reason})` : o.processed ? "landed" : "?") : o.rv === GUARD ? "guard" : o.rv === "0x" ? "empty-revert" : o.rv);
const runsOf = (seq: readonly Probe[]): string => seq.reduce<[bigint, bigint, string][]>(
  (acc, o) => (acc.length && acc[acc.length - 1]![2] === kindOf(o) ? (acc[acc.length - 1]![1] = o.limit, acc) : [...acc, [o.limit, o.limit, kindOf(o)]]), [])
  .map(([a, b, k]) => `${a}..${b}:${k}`).join("  ");
/** Every limit under the first one that gets through reverts (guard or an out-of-gas frame); from there up the outcome is one and the same. */
const expectStep = (outcomes: readonly Probe[], through: (o: Probe) => boolean): Probe => {
  const first = outcomes.findIndex((o) => o.ok);
  expect(first).toBeGreaterThan(0);
  expect(outcomes.slice(0, first).every((o) => !o.ok && (o.rv === GUARD || o.rv === "0x"))).toBe(true);
  expect(outcomes.slice(first).every(through)).toBe(true);
  return outcomes[first]!;
};

/** Numbered entity whose board is `members` contract members (threshold: all), and the co-signature a C2R against it carries. */
const contractBoard = async (w: World, addresses: readonly string[], code: string) => {
  for (const address of addresses) await w.vm.vm.stateManager.putCode(createAddressFromString(address), ethers.getBytes(code));
  const ids = addresses.map((a) => ethers.zeroPadValue(a, 32));
  const { entityNumbers } = await w.vm.registerNumberedEntitiesBatch([coder.encode(BOARD_ABI, [[ids.length, ids, ids.map(() => 1), 0, 0, 0]])]);
  const id = ethers.zeroPadValue(ethers.toBeHex(entityNumbers[0]!), 32);
  const hanko = coder.encode(HANKO_ABI, [[ids, "0x", [[id, ids.map((_, i) => i), ids.map(() => 1), ids.length, 0, 0, 0]], ids.map(() => "0x01")]]);
  return { id, hanko };
};

const MEMBERS = (process.env.BURN ? [Number(process.env.BURN)] : [20_000, 100_000, 300_000]).map((burn) => ({
  name: `member costing ${burn}`,
  code: memberRuntime(Math.floor(burn / 26)),
})).concat(process.env.BURN ? [] : [{ name: "member that rejects under 500k gas", code: gasSensitiveRuntime }]);

const G1_BUDGET = 2_000_000n;

describe("G1 a relayer cannot pick the gas so an ERC-1271 member starves and a good C2R soft-fails E4", () => {
  for (const [index, member] of MEMBERS.entries()) test(`${member.name}: scan gas limits, then estimateGas-style search`, async () => {
    const w = await boot(`j5g-${index}`);
    const memberAddress = ethers.getAddress("0x" + "77".repeat(20));
    await w.vm.vm.stateManager.putCode(createAddressFromString(memberAddress), ethers.getBytes(member.code));
    const { entityNumbers } = await w.vm.registerNumberedEntitiesBatch([singleSignerBoard(memberAddress)]);
    const counterpartyId = ethers.zeroPadValue(ethers.toBeHex(entityNumbers[0]!), 32);
    const memberHanko = coder.encode(HANKO_ABI, [[[ethers.zeroPadValue(memberAddress, 32)], "0x", [[counterpartyId, [0], [1], 1, 0, 0, 0]], ["0x01"]]]);
    const E = party("j5g-entity");
    const acct = w.accountOf(E, { id: counterpartyId } as never, "j5g-member-acct");
    expect(acct.R.id).toBe(E.id); // the numbered entity has the smaller id: it is Left, the entity is Right
    await w.chain.debugFundReserves(E.id, w.TOKEN, 1000n);
    expect(await w.submit(E, { reserveToCollateral: [{ tokenId: w.TOKEN, receivingEntity: E.id, pairs: [{ entity: counterpartyId, amount: 100n }] }] })).toBe("ok");

    const encoded = w.encodeJBatch({ ...w.createEmptyBatch(), gasBudget: G1_BUDGET, collateralToReserve: [{ counterparty: counterpartyId, tokenId: w.TOKEN, amount: 10n, nonce: 1, sig: memberHanko }] } as never);
    const nonce = (await w.chain.getEntityNonce(E.id)) + 1n;
    const data = ethers.getBytes(forkDepository.createInterface().encodeFunctionData("processBatch", [E.id, encoded, signWith(E, w.batchHash(E.id, encoded, nonce)), nonce]));
    const run = prober(w, data);
    const full = await run(15_000_000n);
    console.log("full gas:", full.used.toString(), kindOf(full));
    expect(full).toMatchObject({ ok: true, failed: false, processed: true });
    expect(full.used).toBeLessThan(G1_BUDGET); // the budget really is a ceiling above the need

    // dense scan of every limit from far under the need to well over the requirement
    const requirement = withBudget(G1_BUDGET);
    const step = BigInt(process.env.STEP ?? 2000);
    const outcomes: Probe[] = [];
    for (let g = BigInt(process.env.LO ?? 40_000); g <= requirement + 400_000n; g += step) outcomes.push(await run(g));
    console.log("outcome by gas limit (low -> high):", runsOf(outcomes));
    expect(outcomes.filter((o) => o.ok && o.failed)).toEqual([]); // the claim: a relayer cannot fail a good batch by choosing the gas
    const first = expectStep(outcomes, (o) => o.ok && o.processed && !o.failed);
    expect(first.limit).toBeGreaterThanOrEqual(requirement); // the pre-call check is what decides, not the callee's luck
    expect(first.limit).toBeLessThan(requirement + 400_000n); // and the outer prelude stays a small part of it

    // what eth_estimateGas does: the lowest limit that does not revert
    const search = async (lo: bigint, hi: bigint): Promise<bigint> => (hi - lo <= 1n ? hi : (await run((lo + hi) / 2n)).ok ? search(lo, (lo + hi) / 2n) : search((lo + hi) / 2n, hi));
    const estimate = await search(21_000n, 15_000_000n);
    expect(await run(estimate)).toMatchObject({ ok: true, failed: false, processed: true });
    // and a limit far above the requirement does exactly the same thing: the relayer's surplus changes nothing
    // (the very first call in a fresh rig costs ~45k more, a warm-up of the rig: compare two calls that are both warm)
    const warm = await run(15_000_000n);
    expect(await run(60_000_000n)).toMatchObject({ ok: true, failed: false, processed: true, used: warm.used });
    expect(await w.chain.getEntityNonce(E.id)).toBe(nonce - 1n); // nothing above spent the nonce (read-only calls)
  }, 1_200_000);
});

describe("B a budget below the need is the signer's doing: from the requirement up every limit reports BatchFailed, at one and the same reason", () => {
  test("a member that costs 600k against the smallest allowed budget (500k)", async () => {
    const w = await boot("j5g-small");
    const memberAddress = ethers.getAddress("0x" + "78".repeat(20));
    const cp = await contractBoard(w, [memberAddress], memberRuntime(Math.floor(600_000 / 26)));
    const E = party("j5g-small-entity");
    await w.chain.debugFundReserves(E.id, w.TOKEN, 1000n);
    expect(await w.submit(E, { reserveToCollateral: [{ tokenId: w.TOKEN, receivingEntity: E.id, pairs: [{ entity: cp.id, amount: 100n }] }] })).toBe("ok");
    const c2r = { counterparty: cp.id, tokenId: w.TOKEN, amount: 10n, nonce: 1, sig: cp.hanko };
    const nonce = (await w.chain.getEntityNonce(E.id)) + 1n;
    const encode = (gasBudget: bigint) => w.encodeJBatch({ ...w.createEmptyBatch(), gasBudget, collateralToReserve: [c2r] } as never);
    const dataFor = (encoded: string) => ethers.getBytes(forkDepository.createInterface().encodeFunctionData("processBatch", [E.id, encoded, signWith(E, w.batchHash(E.id, encoded, nonce)), nonce]));

    // with a budget that covers it, it lands
    expect(await prober(w, dataFor(encode(2_000_000n)))(3_000_000n)).toMatchObject({ ok: true, failed: false, processed: true });
    // with the smallest budget the member cannot finish inside the self-call: E4 (the hanko reads invalid), at every limit that carries the budget
    const small = encode(500_000n);
    const run = prober(w, dataFor(small));
    const outcomes: Probe[] = [];
    for (let g = 300_000n; g <= withBudget(500_000n) + 600_000n; g += 20_000n) outcomes.push(await run(g));
    console.log("small budget, by gas limit:", runsOf(outcomes));
    expect(outcomes.filter((o) => o.ok && o.processed)).toEqual([]);
    expectStep(outcomes, (o) => o.ok && o.failed && o.reason === E4);
    expect((await run(60_000_000n)).reason).toBe(E4);
    // a real transaction: the batch is spent, not applied, and cannot be resent
    const done = await w.vm.executeTx({ to: w.domain.depository, data: ethers.hexlify(dataFor(small)), gasLimit: 2_000_000n }, undefined, { emitEvents: true });
    const failed = (done.events as { name: string; args: Record<string, unknown> }[]).filter((e) => e.name === "BatchFailed");
    expect(failed.map((e) => String(e.args["reason"]))).toEqual([E4]);
    expect(await w.chain.getEntityNonce(E.id)).toBe(nonce);
    expect(await w.sendRaw(E.id, small, signWith(E, w.batchHash(E.id, small, nonce)), nonce)).toBe("REVERT E2()");
  }, 600_000);
});

describe("F2 a valid batch that needs more than the old 15M floor lands at its own budget", () => {
  test("two C2Rs against two 8-member boards (each member burns 950k and returns valid)", async () => {
    const w = await boot("j5g-two-boards");
    const BURN = Number(process.env.BURN2 ?? 950_000);
    const boards = await Promise.all([0, 1].map((c) =>
      contractBoard(w, Array.from({ length: 8 }, (_, i) => ethers.getAddress("0x" + (c * 8 + i + 1).toString(16).padStart(2, "0").repeat(20))), memberRuntime(Math.floor(BURN / 26)))));
    const E = party("j5g-two-boards-entity");
    await w.chain.debugFundReserves(E.id, w.TOKEN, 1000n);
    expect(await w.submit(E, { reserveToCollateral: [{ tokenId: w.TOKEN, receivingEntity: E.id, pairs: boards.map((b) => ({ entity: b.id, amount: 100n })) }] })).toBe("ok");
    const nonce = (await w.chain.getEntityNonce(E.id)) + 1n;
    const encode = (gasBudget: bigint) => w.encodeJBatch({ ...w.createEmptyBatch(), gasBudget,
      collateralToReserve: boards.map((b) => ({ counterparty: b.id, tokenId: w.TOKEN, amount: 10n, nonce: 1, sig: b.hanko })) } as never);
    const dataFor = (encoded: string) => ethers.getBytes(forkDepository.createInterface().encodeFunctionData("processBatch", [E.id, encoded, signWith(E, w.batchHash(E.id, encoded, nonce)), nonce]));

    // measure the need with a generous budget, then sign the budget from the measurement plus a margin (the Runtime rule)
    const measured = await prober(w, dataFor(encode(30_000_000n)))(40_000_000n);
    expect(measured).toMatchObject({ ok: true, failed: false, processed: true });
    const budget = ((measured.used + 300_000n) / 100_000n + 1n) * 100_000n;
    console.log("measured need", measured.used.toString(), "-> signed budget", budget.toString(), "(the retired floor was 15,240,095)");
    expect(measured.used).toBeGreaterThan(15_000_000n); // the batch really is over the old budget
    const run = prober(w, dataFor(encode(budget)));
    const requirement = withBudget(budget);
    const outcomes: Probe[] = [];
    for (let g = requirement - 300_000n; g <= requirement + 900_000n; g += 40_000n) outcomes.push(await run(g));
    console.log("by gas limit:", runsOf(outcomes));
    expect(outcomes.filter((o) => o.ok && o.failed)).toEqual([]); // the old floor let 16 of 30 limits soft-fail here
    const first = expectStep(outcomes, (o) => o.ok && o.processed && !o.failed);
    expect(first.limit).toBeGreaterThanOrEqual(requirement);
    expect(first.limit).toBeLessThan(16_777_216n * 2n); // (reported, not a bound of the contract: the chain's cap is the deploy gate's business)
    // the same batch signed with a budget 1M under the need: never a landed half batch, BatchFailed from the requirement up
    const short = prober(w, dataFor(encode(measured.used - 1_000_000n)));
    const shortOutcomes: Probe[] = [];
    for (let g = withBudget(measured.used - 1_000_000n) - 100_000n; g <= withBudget(measured.used - 1_000_000n) + 700_000n; g += 50_000n) shortOutcomes.push(await short(g));
    console.log("short budget, by gas limit:", runsOf(shortOutcomes));
    expect(shortOutcomes.filter((o) => o.ok && o.processed)).toEqual([]);
    expectStep(shortOutcomes, (o) => o.ok && o.failed);
  }, 1_800_000);
});
