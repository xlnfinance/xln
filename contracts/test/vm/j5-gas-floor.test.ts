// G1 (both reviews of J5, PR #54): the first gas guard (gasleft() < gasBefore / 32) was blind to a starved frame that is three or more calls
// below processBatch. The counterparty's hanko can carry an ERC-1271 member (HankoVerifier: staticcall capped at 1,000,000 gas, and
// "any other outcome fails the whole proof, soft, like a bad EOA signature"). That call sits four frames down:
//   processBatch -> applyBatch -> Account (library delegatecall) -> EntityProvider -> member.isValidSignature
// A relayer who picks the gas so the member call runs out of gas makes the hanko invalid (E4). Account catches it, and the parent
// frames still hold ~6% of the gas, more than 1/32, so the guard passes: a good, correctly co-signed C2R becomes BatchFailed E4
// with the entity nonce spent. The member here is honest: it returns the ERC-1271 magic, after spending BURN gas (a P-256 passkey
// verifier in software costs this much; the codebase names it as the intended use).
// The fix (re-review of J5, coordinator 00:09): processBatch reports a failed batch only when the self-call started with at least
// BATCH_GAS_FLOOR (15,240,095 = the 15M batch budget * 64/63 + 2,000), so a failure was never starvation, at any depth. Below the floor
// the transaction reverts (BatchGasStarved), takes no nonce, and is resubmitted with more gas. The claim under test: at no gas limit
// does a good batch soft-fail, for a 20k, a 100k and a 300k member and for a member whose answer depends on the gas it is given (it
// rejects under 500k gas: the case a fraction-of-gas guard can never close); a limit that cannot pay for the batch reverts; and the
// estimateGas-style search lands. (A 1/8 fraction guard was tried first and closes only the members that burn gas; a per-call stipend
// closed the gas-sensitive one too; the floor closes all of it with no per-call-site code.)
// One file per process: `bun test contracts/test/vm/j5-gas-floor.test.ts` (BURN=..., STEP=... narrow it).
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

/** Runtime code of an honest ERC-1271 member: spends about 26 * iterations gas, then returns 0x1626ba7e00..00. */
const memberRuntime = (iterations: number): string =>
  "0x61" + iterations.toString(16).padStart(4, "0") + "5b6001900380600357" + "50" + "7f" + "1626ba7e" + "00".repeat(28) + "600052" + "60206000f3";

const lookup = (m: Record<string, unknown>) => JSON.stringify(m, (_, v) => (typeof v === "bigint" ? v.toString() : v));

/** A member whose verdict depends on the gas it is given: it rejects when gasleft() < 500,000 and otherwise returns the magic. A fraction-of-gas guard
 *  can never close this one (it sees a cheap failure that left most of the gas); the gas floor does. */
const gasSensitiveRuntime =
  "0x" + "62" + "07a120" + "5a" + "10" + "6032" + "57" + "7f" + "1626ba7e" + "00".repeat(28) + "600052" + "60206000f3" + "5b" + "600060" + "00fd";

const MEMBERS = (process.env.BURN ? [Number(process.env.BURN)] : [20_000, 100_000, 300_000]).map((burn) => ({
  name: `member costing ${burn}`,
  code: memberRuntime(Math.floor(burn / 26)),
})).concat(process.env.BURN ? [] : [{ name: "member that rejects under 500k gas", code: gasSensitiveRuntime }]);

describe("G1 a relayer cannot pick the gas so an ERC-1271 member starves and a good C2R soft-fails E4", () => {
  for (const [index, member] of MEMBERS.entries()) test(`${member.name}: scan gas limits, then estimateGas-style search`, async () => {
    const w = await boot(`j5s-gas-${index}`);
    const memberAddress = ethers.getAddress("0x" + "77".repeat(20));
    await w.vm.vm.stateManager.putCode(createAddressFromString(memberAddress), ethers.getBytes(member.code));
    // the counterparty: a numbered entity whose whole board is that one contract member
    const { entityNumbers } = await w.vm.registerNumberedEntitiesBatch([singleSignerBoard(memberAddress)]);
    const counterpartyId = ethers.zeroPadValue(ethers.toBeHex(entityNumbers[0]!), 32);
    const memberHanko = coder.encode(HANKO_ABI, [[[ethers.zeroPadValue(memberAddress, 32)], "0x", [[counterpartyId, [0], [1], 1, 0, 0, 0]], ["0x01"]]]);
    const E = party("j5s-entity");
    const acct = w.accountOf(E, { id: counterpartyId } as never, "j5s-member-acct");
    expect(acct.R.id).toBe(E.id); // the numbered entity has the smaller id: it is Left, the entity is Right
    await w.chain.debugFundReserves(E.id, w.TOKEN, 1000n);
    expect(await w.submit(E, { reserveToCollateral: [{ tokenId: w.TOKEN, receivingEntity: E.id, pairs: [{ entity: counterpartyId, amount: 100n }] }] })).toBe("ok");

    const amount = 10n;
    const encoded = w.encodeJBatch({ ...w.createEmptyBatch(), collateralToReserve: [{ counterparty: counterpartyId, tokenId: w.TOKEN, amount, nonce: 1, sig: memberHanko }] } as never);
    const nonce = (await w.chain.getEntityNonce(E.id)) + 1n;
    const data = ethers.getBytes(forkDepository.createInterface().encodeFunctionData("processBatch", [E.id, encoded, signWith(E, w.batchHash(E.id, encoded, nonce)), nonce]));
    const run = async (gasLimit: bigint) => {
      const r = await w.vm.runReadOnlyCall({ to: w.vm.depositoryAddress, caller: w.vm.deployerAddress, data, gasLimit });
      const topics = (r.execResult.logs ?? []).map((l: [Uint8Array, Uint8Array[], Uint8Array]) => ethers.hexlify(l[1][0]!));
      const rv = ethers.hexlify(r.execResult.returnValue ?? new Uint8Array());
      return { limit: gasLimit, rv: rv.slice(0, 10), ok: r.execResult.exceptionError === undefined, failed: topics.includes(BATCH_FAILED), processed: topics.includes(BATCH_PROCESSED), used: BigInt(r.execResult.executionGasUsed) };
    };
    const full = await run(15_000_000n);
    console.log("full gas:", lookup(full));
    expect(full).toMatchObject({ ok: true, failed: false, processed: true });

    // 1. dense scan of every gas limit below what the batch needs
    const landsAt = full.used + 21_000n + 16n * BigInt(data.length) + 5_000n;
    const hi = landsAt > 1_400_000n ? landsAt : 1_400_000n; // covers every limit where a member can be starved (all far below the 15.24M floor)
    const lo = BigInt(process.env.LO ?? 40_000);
    const step = BigInt(process.env.STEP ?? 1000);
    const outcomes: Awaited<ReturnType<typeof run>>[] = [];
    for (let g = hi; g >= lo; g -= step) outcomes.push(await run(g));
    const soft = outcomes.filter((o) => o.ok && o.failed);
    const kinds = (o: (typeof outcomes)[number]) => (o.ok ? (o.failed ? "BatchFailed" : "landed") : o.rv === GUARD ? "guard" : o.rv === "0x" ? "empty-revert" : o.rv);
    const seq = outcomes.map((o) => [o.limit, kinds(o)] as const);
    const runs = seq.reduce<[bigint, bigint, string][]>((acc, [g, k]) => (acc.length && acc[acc.length - 1]![2] === k ? (acc[acc.length - 1]![1] = g, acc) : [...acc, [g, g, k]]), []);
    console.log("outcome by gas limit (high -> low):", runs.map(([a, b, k]) => `${a}..${b}:${k}`).join("  "));
    const ratios = soft.map((o) => Number(o.limit - o.used) / Number(o.limit));
    console.log("soft-fail gasleft/limit at the guard (approx, incl. ~3k of BatchFailed tail): min", Math.min(...ratios).toFixed(4), "max", Math.max(...ratios).toFixed(4), "| guard threshold is 1/32 =", (1 / 32).toFixed(4), "; a 1/8 guard would be", (1 / 8).toFixed(4));
    console.log("soft-fail limits:", soft.length, soft.length ? `${soft[soft.length - 1]!.limit}..${soft[0]!.limit}` : "");

    // 2. what eth_estimateGas would do: the lowest limit that does not revert (geth/anvil binary search treats a non-revert as success)
    const search = async (): Promise<bigint> => {
      const step2 = async (lo2: bigint, hi2: bigint): Promise<bigint> => (hi2 - lo2 <= 1n ? hi2 : (await run((lo2 + hi2) / 2n)).ok ? step2(lo2, (lo2 + hi2) / 2n) : step2((lo2 + hi2) / 2n, hi2));
      return step2(21_000n, 15_000_000n);
    };
    const estimate = await search();
    const atEstimate = await run(estimate);
    console.log("estimateGas-style result:", estimate.toString(), "->", kinds(atEstimate), "(needed for a landing batch without the floor:", (landsAt - 5_000n).toString() + ")");

    // 3. a real transaction at a limit inside the window: the batch is spent, not applied, and cannot be resent
    if (soft.length > 0) {
      const inside = soft[Math.floor(soft.length / 2)]!.limit;
      const before = await acct.reserves();
      const done = await w.vm.executeTx({ to: w.domain.depository, data: ethers.hexlify(data), gasLimit: inside }, undefined, { emitEvents: true });
      const ev = (done.events as { name: string; args: Record<string, unknown> }[]).filter((e) => e.name === "BatchFailed");
      console.log("real tx at", inside.toString(), "-> BatchFailed", ev.map((e) => `nonce ${e.args["nonce"]} reason ${e.args["reason"]}`).join(";"), "| entity nonce now", (await w.chain.getEntityNonce(E.id)).toString());
      expect(ev.map((e) => String(e.args["reason"]))).toEqual([E4]);
      expect(await w.chain.getEntityNonce(E.id)).toBe(nonce);
      expect(await acct.reserves()).toEqual(before);
      expect(await w.sendRaw(E.id, encoded, signWith(E, w.batchHash(E.id, encoded, nonce)), nonce)).toBe("REVERT E2()"); // the same signed batch cannot land any more
    }
    expect(soft).toEqual([]); // the claim under test: a relayer cannot fail a good batch by choosing the gas
    // what a gas limit that cannot pay for the batch does: revert (BatchGasStarved, or an out-of-gas frame with no data), never land half
    expect(outcomes.filter((o) => !o.ok).every((o) => o.rv === GUARD || o.rv === "0x")).toBe(true);
    expect(atEstimate).toMatchObject({ ok: true, failed: false, processed: true }); // the honest signer's own estimate lands
    expect(await w.chain.getEntityNonce(E.id)).toBe(nonce - 1n); // nothing above spent the nonce (read-only calls)
  }, 1_200_000);
});
