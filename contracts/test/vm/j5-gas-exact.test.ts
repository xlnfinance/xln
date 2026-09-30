// J5 gas, fourth pass (PR #54 at 0aeb766): is BATCH_POST_CALL_RESERVE (30,000) load-bearing?
// Two independent arguments, both tested here:
//   P  POST-CALL COST. Trace the depth-0 frame: gas it holds when the self-call returns vs the gas it needs to log BatchFailed and return.
//      At the smallest budget (500,000) the retained 1/63 is about 7,900 minus the CALL's own overhead; the post-call code is measured, not assumed.
//   X  EXACT BUDGET. The check `gasleft() >= budget*64/63 + RESERVE` is what makes the callee get *exactly* budget: the CALL's own base cost and the
//      opcodes between the check and the CALL come out of the 63/64 base, so without the reserve the callee is handed budget - (a few hundred) in a
//      window just above the check. A batch signed at its exact need (budget == need, zero margin) must then land at EVERY limit the check accepts.
//      With the reserve removed the window [check, check + ~overhead] soft-fails a good batch: BatchFailed(E4) burns the nonce on a relayer's gas choice.
// One file per process: `bun test contracts/test/vm/j5-gas-exact.test.ts`. Env: WIN (scan width above the first accepted limit, default 800).
import { describe, expect, test } from "bun:test";
import { ethers } from "ethers";
import { createAddressFromString } from "@ethereumjs/util";
import { boot, party, signWith } from "./rig.ts";
import { Depository__factory as forkDepository } from "../../typechain-types/index.ts";

const coder = ethers.AbiCoder.defaultAbiCoder();
const BATCH_FAILED = ethers.id("BatchFailed(bytes32,uint256,bytes4)");
const BATCH_PROCESSED = ethers.id("HankoBatchProcessed(bytes32,bytes32,uint256)");
const GUARD = "0x013e4115";
const RESERVE = 30_000n; // as in the source; the mutant sets it to 0 and recompiles
const MIN_BUDGET = 500_000n;
const HANKO_ABI = ["tuple(bytes32[],bytes,tuple(bytes32,uint256[],uint256[],uint256,uint32,uint32,uint32)[],bytes[])"];
const BOARD_ABI = ["tuple(uint16 votingThreshold, bytes32[] entityIds, uint16[] votingPowers, uint32 boardChangeDelay, uint32 controlChangeDelay, uint32 dividendChangeDelay)"];
const memberRuntime = (iterations: number): string =>
  "0x61" + iterations.toString(16).padStart(4, "0") + "5b6001900380600357" + "50" + "7f" + "1626ba7e" + "00".repeat(28) + "600052" + "60206000f3";
const BURNER_TOKEN = "0x600035" + "60e01c" + "6370a08231" + "14" + "6010" + "57" + "fe" + "5b" + "7f" + "ff".repeat(32) + "600052" + "60206000f3";

type World = Awaited<ReturnType<typeof boot>>;
type Probe = { limit: bigint; ok: boolean; rv: string; failed: boolean; processed: boolean; used: bigint; reason: string };
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
/** Lowest limit in [lo, hi] at which `pred` holds, `pred` monotone (false below, true above). */
const lowest = async (lo: bigint, hi: bigint, pred: (g: bigint) => Promise<boolean>): Promise<bigint> =>
  hi - lo <= 1n ? hi : (await pred((lo + hi) / 2n)) ? lowest(lo, (lo + hi) / 2n, pred) : lowest((lo + hi) / 2n, hi, pred);

describe("P the depth-0 frame's gas when the self-call returns, against what it needs after", () => {
  test("burner token, smallest budget, at the first limit the check accepts (trace)", async () => {
    const w = await boot("j5f-post");
    const iface = forkDepository.createInterface();
    const meta = await w.vm.runReadOnlyCall({ to: w.vm.depositoryAddress, caller: w.vm.deployerAddress, data: ethers.getBytes(iface.encodeFunctionData("_tokens", [1])), gasLimit: 500_000n });
    const tokenAddress = iface.decodeFunctionResult("_tokens", meta.execResult.returnValue)[0] as string;
    await w.vm.vm.stateManager.putCode(createAddressFromString(tokenAddress), ethers.getBytes(BURNER_TOKEN));
    const E = party("j5f-post-entity");
    await w.chain.debugFundReserves(E.id, w.TOKEN, 1000n);
    const encoded = w.encodeJBatch({ ...w.createEmptyBatch(), gasBudget: MIN_BUDGET,
      reserveToExternalToken: [{ receivingEntity: ethers.zeroPadValue("0x00000000000000000000000000000000000000aa", 32), tokenId: w.TOKEN, amount: 1n }] } as never);
    const nonce = (await w.chain.getEntityNonce(E.id)) + 1n;
    const data = ethers.getBytes(iface.encodeFunctionData("processBatch", [E.id, encoded, signWith(E, w.batchHash(E.id, encoded, nonce)), nonce]));
    const run = prober(w, data);
    const first = await lowest(100_000n, 2_000_000n, async (g) => (await run(g)).ok);
    console.log("first limit that gets through:", first.toString(), "->", kindOf(await run(first)), "; guard at", kindOf(await run(first - 1n)));

    // trace depth 0 at that limit and at a few above
    const trace = async (gasLimit: bigint) => {
      const steps: { op: string; gas: bigint; depth: number }[] = [];
      const listener = (d: { opcode: { name: string }; gasLeft: bigint; depth: number }, next?: () => void) => { steps.push({ op: d.opcode.name, gas: d.gasLeft, depth: d.depth }); next?.(); };
      const evm = (w.vm.vm as unknown as { evm: { events: { on: (e: string, f: unknown) => void; removeListener: (e: string, f: unknown) => void } } }).evm;
      evm.events.on("step", listener);
      await run(gasLimit);
      evm.events.removeListener("step", listener);
      const top = steps.filter((s) => s.depth === 0);
      const idx = top.map((s) => s.op).lastIndexOf("CALL"); // the self-call: the last CALL of the depth-0 frame
      const before = top[idx]!.gas;
      const after = top[idx + 1]!.gas; // first depth-0 step after the call returned
      const end = top[top.length - 1]!.gas;
      const logAt = top.findIndex((s, i) => i > idx && s.op.startsWith("LOG"));
      return { gasLimit, beforeCall: before, afterReturn: after, atLastOp: end, postCost: after - end, logStepGas: top[logAt]?.gas };
    };
    const rows = [];
    for (const g of [first, first + 5_000n, first + 30_000n]) rows.push(await trace(g));
    for (const r of rows) console.log(`limit ${r.gasLimit}: gas before CALL ${r.beforeCall}, held after it returns ${r.afterReturn}, held at the last opcode ${r.atLastOp} => post-call code spends about ${r.postCost}`);
    const needed = rows[0]!.postCost;
    console.log("smallest budget", MIN_BUDGET.toString(), "; retained 1/63 =", (MIN_BUDGET / 63n).toString(), "; post-call spend measured", needed.toString(), "; held after return at the first accepted limit", rows[0]!.afterReturn.toString());
    // the claim under test: what the frame holds after the call covers what it spends after, with the reserve as extra
    expect(rows[0]!.afterReturn).toBeGreaterThan(needed);
    // and the margin WITHOUT the reserve: held - reserve is what the mutant would leave; the test only prints it (see the mutant runs)
    console.log("held after return minus RESERVE (what remains if the reserve were 0):", (rows[0]!.afterReturn - RESERVE).toString(), "vs post-call spend", needed.toString());
    // every limit from the first accepted one reports BatchFailed, never an out-of-gas in the log (dense window right above the check)
    const outcomes: Probe[] = [];
    for (let g = first; g <= first + BigInt(process.env.WIN ?? 800); g += 7n) outcomes.push(await run(g));
    console.log("window above the check:", runsOf(outcomes));
    expect(outcomes.every((o) => o.ok && o.failed)).toBe(true);
  }, 900_000);
});

describe("X a batch signed at its exact need lands at every limit the check accepts", () => {
  test("ERC-1271 member burning ~600k: budget bisected to the exact need, then a dense scan at the check", async () => {
    const w = await boot("j5f-exact");
    const members = [ethers.getAddress("0x" + "79".repeat(20))];
    for (const m of members) await w.vm.vm.stateManager.putCode(createAddressFromString(m), ethers.getBytes(memberRuntime(Math.floor(600_000 / 26))));
    const ids = members.map((a) => ethers.zeroPadValue(a, 32));
    const { entityNumbers } = await w.vm.registerNumberedEntitiesBatch([coder.encode(BOARD_ABI, [[1, ids, [1], 0, 0, 0]])]);
    const cpId = ethers.zeroPadValue(ethers.toBeHex(entityNumbers[0]!), 32);
    const hanko = coder.encode(HANKO_ABI, [[ids, "0x", [[cpId, [0], [1], 1, 0, 0, 0]], ["0x01"]]]);
    const E = party("j5f-exact-entity");
    await w.chain.debugFundReserves(E.id, w.TOKEN, 1000n);
    expect(await w.submit(E, { reserveToCollateral: [{ tokenId: w.TOKEN, receivingEntity: E.id, pairs: [{ entity: cpId, amount: 100n }] }] })).toBe("ok");
    const nonce = (await w.chain.getEntityNonce(E.id)) + 1n;
    const dataFor = (budget: bigint) => {
      const encoded = w.encodeJBatch({ ...w.createEmptyBatch(), gasBudget: budget, collateralToReserve: [{ counterparty: cpId, tokenId: w.TOKEN, amount: 10n, nonce: 1, sig: hanko }] } as never);
      return ethers.getBytes(forkDepository.createInterface().encodeFunctionData("processBatch", [E.id, encoded, signWith(E, w.batchHash(E.id, encoded, nonce)), nonce]));
    };
    const landsAtBudget = async (budget: bigint): Promise<boolean> => {
      const o = await prober(w, dataFor(budget))(30_000_000n);
      return o.ok && o.processed && !o.failed;
    };
    expect(await landsAtBudget(3_000_000n)).toBe(true);
    const need = await lowest(MIN_BUDGET, 3_000_000n, (b) => landsAtBudget(b));
    console.log("exact need (smallest budget at which the batch lands with unlimited gas):", need.toString());
    expect(await landsAtBudget(need)).toBe(true);
    expect(await landsAtBudget(need - 1n)).toBe(false);

    const run = prober(w, dataFor(need));
    const first = await lowest(100_000n, 6_000_000n, async (g) => (await run(g)).ok);
    console.log("first limit the check accepts:", first.toString(), "->", kindOf(await run(first)), "; one under:", kindOf(await run(first - 1n)));
    const outcomes: Probe[] = [];
    for (let g = first - 50n; g <= first + BigInt(process.env.WIN ?? 800); g += 1n) outcomes.push(await run(g));
    console.log("dense scan (step 1) around the check:", runsOf(outcomes));
    const sparse: Probe[] = [];
    for (let g = first + 3000n; g <= first + 400_000n; g += 20_000n) sparse.push(await run(g));
    console.log("sparse scan above:", runsOf(sparse));
    // the claim: below the check nothing gets through; from the check up a batch signed at its exact need is never reported as failed
    expect(outcomes.filter((o) => o.limit < first).every((o) => !o.ok)).toBe(true);
    const softFails = outcomes.filter((o) => o.ok && o.failed);
    console.log(`good batch reported BatchFailed at ${softFails.length} limits`, softFails.length ? `(${softFails[0]!.limit}..${softFails[softFails.length - 1]!.limit}, first ${first}: window ${softFails[softFails.length - 1]!.limit - first + 1n} gas wide above the check)` : "");
    expect(softFails.length).toBe(0);
    expect([...outcomes, ...sparse].filter((o) => o.ok).every((o) => o.processed && !o.failed)).toBe(true);
  }, 1_800_000);
});
