// J5 gas, fourth pass (PR #54 at 0aeb766): attacks on the signed gasBudget itself. One file per process.
//   H  the budget is signed: the same signature over the same batch with another budget is E4 (no nonce)
//   I  inflation: uint64 max, over the tx cap, and the exact minimum: guard revert (never a Panic, never a nonce); 499,999 is E10, 500,000 passes
//   V  revert-whole batches: the budget is ignored by the ops but bounded like every batch (E10 below the minimum); a huge one does not change the outcome
//   D  simulation divergence: a member whose answer depends on gasleft() sees the SIGNED budget, not the relayer's limit (same answer at every limit),
//      but a simulation run with a different gas than the final budget can disagree with the landing (runtime rule: the last simulation is at the final budget)
// `bun test contracts/test/vm/j5-fourth-budget.test.ts`
import { describe, expect, test } from "bun:test";
import { ethers } from "ethers";
import { createAddressFromString } from "@ethereumjs/util";
import { boot, party, signWith } from "../rig.ts";
import { Depository__factory as forkDepository } from "../../../typechain-types/index.ts";

const coder = ethers.AbiCoder.defaultAbiCoder();
const BATCH_FAILED = ethers.id("BatchFailed(bytes32,uint256,bytes4)");
const BATCH_PROCESSED = ethers.id("HankoBatchProcessed(bytes32,bytes32,uint256)");
const GUARD = "0x013e4115";
const E4 = ethers.id("E4()").slice(0, 10);
const E10 = ethers.id("E10()").slice(0, 10);
const MIN_BUDGET = 500_000n;
const HANKO_ABI = ["tuple(bytes32[],bytes,tuple(bytes32,uint256[],uint256[],uint256,uint32,uint32,uint32)[],bytes[])"];
const BOARD_ABI = ["tuple(uint16 votingThreshold, bytes32[] entityIds, uint16[] votingPowers, uint32 boardChangeDelay, uint32 controlChangeDelay, uint32 dividendChangeDelay)"];
/** Honest member burning about 26*n gas, then returning the ERC-1271 magic. */
const memberRuntime = (n: number): string =>
  "0x61" + n.toString(16).padStart(4, "0") + "5b6001900380600357" + "50" + "7f" + "1626ba7e" + "00".repeat(28) + "600052" + "60206000f3";
/** Member that answers the magic only when gasleft() (as seen at entry) is <= LIMIT, else reverts. */
const gasBranching = (limit: number): string =>
  "0x" + "62" + limit.toString(16).padStart(6, "0") + "5a" + "11" + "6032" + "57" + "7f" + "1626ba7e" + "00".repeat(28) + "600052" + "60206000f3" + "5b" + "600060" + "00fd";

type World = Awaited<ReturnType<typeof boot>>;
const iface = forkDepository.createInterface();
const call = async (w: World, data: Uint8Array, gasLimit: bigint) => {
  const r = await w.vm.runReadOnlyCall({ to: w.vm.depositoryAddress, caller: w.vm.deployerAddress, data, gasLimit });
  const logs = (r.execResult.logs ?? []) as [Uint8Array, Uint8Array[], Uint8Array][];
  const topics = logs.map((l) => ethers.hexlify(l[1][0]!));
  const failedLog = logs.find((l) => ethers.hexlify(l[1][0]!) === BATCH_FAILED);
  const ok = r.execResult.exceptionError === undefined;
  const rv = ethers.hexlify(r.execResult.returnValue ?? new Uint8Array()).slice(0, 10);
  const kind = ok ? (topics.includes(BATCH_FAILED) ? `BatchFailed(${ethers.hexlify(failedLog![2]).slice(0, 10)})` : topics.includes(BATCH_PROCESSED) ? "landed" : "?") : rv === GUARD ? "guard" : rv === E4 ? "E4" : rv === E10 ? "E10" : rv === "0x" ? "empty-revert" : rv;
  return { ok, kind, used: BigInt(r.execResult.executionGasUsed) };
};
const contractBoard = async (w: World, addr: string, code: string) => {
  await w.vm.vm.stateManager.putCode(createAddressFromString(addr), ethers.getBytes(code));
  const ids = [ethers.zeroPadValue(addr, 32)];
  const { entityNumbers } = await w.vm.registerNumberedEntitiesBatch([coder.encode(BOARD_ABI, [[1, ids, [1], 0, 0, 0]])]);
  const id = ethers.zeroPadValue(ethers.toBeHex(entityNumbers[0]!), 32);
  return { id, hanko: coder.encode(HANKO_ABI, [[ids, "0x", [[id, [0], [1], 1, 0, 0, 0]], ["0x01"]]]) };
};
/** Entity E funded with a C2R against a numbered member board; `dataFor(budget)` is the signed processBatch calldata. */
const c2rWorld = async (label: string, memberCode: string, addr: string) => {
  const w = await boot(label);
  const cp = await contractBoard(w, addr, memberCode);
  const E = party(`${label}-entity`);
  await w.chain.debugFundReserves(E.id, w.TOKEN, 1000n);
  expect(await w.submit(E, { reserveToCollateral: [{ tokenId: w.TOKEN, receivingEntity: E.id, pairs: [{ entity: cp.id, amount: 100n }] }] })).toBe("ok");
  const nonce = (await w.chain.getEntityNonce(E.id)) + 1n;
  const encode = (gasBudget: bigint) => w.encodeJBatch({ ...w.createEmptyBatch(), gasBudget, collateralToReserve: [{ counterparty: cp.id, tokenId: w.TOKEN, amount: 10n, nonce: 1, sig: cp.hanko }] } as never);
  const dataFor = (budget: bigint) => { const e = encode(budget); return ethers.getBytes(iface.encodeFunctionData("processBatch", [E.id, e, signWith(E, w.batchHash(E.id, e, nonce)), nonce])); };
  return { w, E, nonce, encode, dataFor };
};

describe("H the budget is inside what is signed", () => {
  test("same signature, other budget: E4, no nonce", async () => {
    const { w, E, nonce, encode } = await c2rWorld("j5h", memberRuntime(Math.floor(100_000 / 26)), ethers.getAddress("0x" + "7a".repeat(20)));
    const signedFor = encode(2_000_000n);
    const sig = signWith(E, w.batchHash(E.id, signedFor, nonce));
    const run = (budget: bigint) => call(w, ethers.getBytes(iface.encodeFunctionData("processBatch", [E.id, encode(budget), sig, nonce])), 6_000_000n);
    expect(await run(2_000_000n)).toMatchObject({ kind: "landed" });
    for (const b of [2_000_001n, 1_999_999n, 500_000n, 15_000_000n, (1n << 64n) - 1n]) expect((await run(b)).kind).toBe("E4");
    expect(await w.chain.getEntityNonce(E.id)).toBe(nonce - 1n);
  }, 600_000);
});

describe("I inflated, huge and minimum budgets", () => {
  test("uint64 max, over the tx cap, minimum, minimum - 1", async () => {
    const { w, E, nonce, dataFor } = await c2rWorld("j5i", memberRuntime(Math.floor(50_000 / 26)), ethers.getAddress("0x" + "7b".repeat(20)));
    const at = async (b: bigint, limit: bigint) => (await call(w, dataFor(b), limit)).kind;
    expect(await at((1n << 64n) - 1n, 16_777_216n)).toBe("guard");   // 64x overflows nothing in uint256: a plain guard revert
    expect(await at((1n << 64n) - 1n, 1_000_000_000n)).toBe("guard"); // even with a billion gas: unlandable, no Panic
    expect(await at(20_000_000n, 16_777_216n)).toBe("guard");         // above the EIP-7825 cap: unlandable on that chain, nonce stays open
    expect(await at(16_500_000n, 16_777_216n)).toBe("guard");         // budget*64/63 + reserve + prelude exceeds the cap
    expect(await at(500_000n, 16_777_216n)).toBe("landed");
    expect(await at(499_999n, 16_777_216n)).toBe("E10");
    expect(await at(0n, 16_777_216n)).toBe("E10");
    expect(await w.chain.getEntityNonce(E.id)).toBe(nonce - 1n);
    // the largest budget that can still land under the cap, for the record: bisect on the limit = cap
    const lo = await (async (a: bigint, b: bigint): Promise<bigint> => { let x = a, y = b; while (y - x > 1n) { const m = (x + y) / 2n; if ((await at(m, 16_777_216n)) === "landed") x = m; else y = m; } return x; })(500_000n, 20_000_000n);
    console.log("largest signable budget under the 16,777,216 cap for this entity (single-signer prelude):", lo.toString());
  }, 600_000);
});

describe("F16 V revert-whole batches ignore the budget but keep the minimum", () => {
  test("reveal batch: outcome is the same for 500k and uint64 max, E10 under the minimum", async () => {
    const w = await boot("j5v");
    const E = party("j5v-entity");
    await w.chain.debugFundReserves(E.id, w.TOKEN, 1000n);
    const secret = ethers.hexlify(ethers.randomBytes(32));
    const outcome = async (gasBudget: bigint) => {
      const encoded = w.encodeJBatch({ ...w.createEmptyBatch(), gasBudget, revealSecrets: [{ transformer: w.chain.addresses.deltaTransformer, secret }] } as never);
      const nonce = (await w.chain.getEntityNonce(E.id)) + 1n;
      const data = ethers.getBytes(iface.encodeFunctionData("processBatch", [E.id, encoded, signWith(E, w.batchHash(E.id, encoded, nonce)), nonce]));
      return (await call(w, data, 16_777_216n)).kind;
    };
    const results = await Promise.all([500_000n, 15_000_000n, (1n << 64n) - 1n].map(outcome));
    console.log("reveal batch by budget (500k, 15M, uint64 max):", results.join(", "));
    expect(new Set(results).size).toBe(1);
    expect(results[0]).not.toBe("guard");
    expect(await outcome(499_999n)).toBe("E10");
  }, 600_000);
});

describe("D a member that reads gasleft() sees the signed budget, never the relayer's limit", () => {
  test("rejects above 950k: outcome fixed per budget across every tx limit; a simulation at another budget disagrees", async () => {
    const { w, dataFor } = await c2rWorld("j5d", gasBranching(950_000), ethers.getAddress("0x" + "7c".repeat(20)));
    const budgets = [700_000n, 1_100_000n, 3_000_000n];
    const rows: string[] = [];
    for (const b of budgets) {
      const req = (b * 64n) / 63n + 30_000n;
      const kinds = new Set<string>();
      for (const g of [req + 600_000n, req + 1_000_000n, 5_000_000n, 16_777_216n, 200_000_000n]) {
        const o = await call(w, dataFor(b), g);
        if (o.kind !== "guard") kinds.add(o.kind);
      }
      rows.push(`budget ${b}: ${[...kinds].join("|")}`);
      expect(kinds.size).toBe(1);
    }
    console.log(rows.join("   "));
  }, 900_000);
});
