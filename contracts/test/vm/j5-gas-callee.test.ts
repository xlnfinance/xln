// J5 gas (PR #54, third round), the callee side. The self-call runs with EXACTLY the signed budget and the frame above it keeps a fixed reserve
// (BATCH_POST_CALL_RESERVE), so whatever the callee does with its gas, the failure is reported as BatchFailed and the nonce is spent:
//   F3  a token that executes INVALID (burns everything it is given), a plain revert(), and a callee that returns megabytes of revert data
//       (a return bomb: `catch (bytes memory reason)` copied it all and ran the catch out of gas; the fix reads the first 4 bytes only);
//   R   the reserve is enough at the smallest budget the bounds allow, at the bare minimum gas limit the check accepts, after a callee that burned its whole budget.
// The token is the registered token 1 with its code replaced: it answers balanceOf and does the hostile thing on transfer.
// One file per process: `bun test contracts/test/vm/j5-gas-callee.test.ts`.
import { describe, expect, test } from "bun:test";
import { ethers } from "ethers";
import { createAddressFromString } from "@ethereumjs/util";
import { boot, party, signWith } from "./rig.ts";
import { Depository__factory as forkDepository } from "../../typechain-types/index.ts";

const BATCH_FAILED = ethers.id("BatchFailed(bytes32,uint256,bytes4)");
const GUARD = "0x013e4115"; // BatchGasStarved()
/** BATCH_POST_CALL_RESERVE of Depository.sol, and DepositoryBounds.MIN_BATCH_GAS_BUDGET. */
const RESERVE = 30_000n;
const MIN_BUDGET = 500_000n;
const withBudget = (budget: bigint): bigint => (budget * 64n) / 63n + RESERVE;

/** balanceOf (0x70a08231) returns 2^256-1; every other selector runs `fail` (hex bytecode that never falls through). */
const tokenRuntime = (fail: string): string => {
  const jumpdest = 15 + fail.length / 2;
  return "0x600035" + "60e01c" + "6370a08231" + "14" + "60" + jumpdest.toString(16).padStart(2, "0") + "57" + fail + "5b" + "7f" + "ff".repeat(32) + "600052" + "60206000f3";
};
const REVERTS = "60006000fd";
const BURNS = "fe"; // INVALID: consumes all the gas it is given
const bomb = (bytes: number): string => "62" + bytes.toString(16).padStart(6, "0") + "6000fd"; // revert(0, bytes): zeros, and the memory it expands

/** Cost of expanding memory to `bytes` (the callee pays it to build the revert data; the caller would pay it again to copy it). */
const memoryGas = (bytes: number): bigint => { const words = BigInt(Math.ceil(bytes / 32)); return 3n * words + (words * words) / 512n; };

const world = async (label: string, fail: string) => {
  const w = await boot(label);
  const iface = forkDepository.createInterface();
  const meta = await w.vm.runReadOnlyCall({ to: w.vm.depositoryAddress, caller: w.vm.deployerAddress, data: ethers.getBytes(iface.encodeFunctionData("_tokens", [1])), gasLimit: 500_000n });
  const tokenAddress = iface.decodeFunctionResult("_tokens", meta.execResult.returnValue)[0] as string;
  await w.vm.vm.stateManager.putCode(createAddressFromString(tokenAddress), ethers.getBytes(tokenRuntime(fail)));
  const E = party(`${label}-entity`);
  await w.chain.debugFundReserves(E.id, w.TOKEN, 1000n);
  const recipient = ethers.zeroPadValue("0x00000000000000000000000000000000000000aa", 32);
  /** The entity's withdrawal of one unit of the (hostile) token, signed with `gasBudget`. */
  const withdraw = async (gasBudget: bigint) => {
    const encoded = w.encodeJBatch({ ...w.createEmptyBatch(), gasBudget, reserveToExternalToken: [{ receivingEntity: recipient, tokenId: w.TOKEN, amount: 1n }] } as never);
    const nonce = (await w.chain.getEntityNonce(E.id)) + 1n;
    const data = ethers.getBytes(iface.encodeFunctionData("processBatch", [E.id, encoded, signWith(E, w.batchHash(E.id, encoded, nonce)), nonce]));
    return { encoded, nonce, data };
  };
  const run = async (data: Uint8Array, gasLimit: bigint) => {
    const r = await w.vm.runReadOnlyCall({ to: w.vm.depositoryAddress, caller: w.vm.deployerAddress, data, gasLimit });
    const logs = (r.execResult.logs ?? []) as [Uint8Array, Uint8Array[], Uint8Array][];
    const failedLog = logs.find((l) => ethers.hexlify(l[1][0]!) === BATCH_FAILED);
    return {
      limit: gasLimit, ok: r.execResult.exceptionError === undefined, rv: ethers.hexlify(r.execResult.returnValue ?? new Uint8Array()).slice(0, 10),
      failed: failedLog !== undefined, reason: failedLog ? ethers.hexlify(failedLog[2]).slice(0, 10) : "", used: BigInt(r.execResult.executionGasUsed),
    };
  };
  return { w, E, iface, withdraw, run };
};

describe("F3 a callee that burns its gas, reverts cheaply or returns a huge revert payload: always BatchFailed(0), nonce spent", () => {
  const CASES: readonly { name: string; fail: string; budget: bigint; bytes?: number }[] = [
    { name: "reverts cheaply", fail: REVERTS, budget: 1_000_000n },
    { name: "burns all gas (INVALID)", fail: BURNS, budget: 1_000_000n },
    { name: "returns 1.5 MB of revert data", fail: bomb(0x180000), budget: 6_000_000n, bytes: 0x180000 },
    { name: "returns 2 MB of revert data", fail: bomb(0x200000), budget: 10_000_000n, bytes: 0x200000 },
    { name: "returns 3 MB of revert data", fail: bomb(0x300000), budget: 22_000_000n, bytes: 0x300000 },
  ];
  for (const c of CASES) test(`token that ${c.name}`, async () => {
    const { w, E, withdraw, run } = await world(`j5c-${c.name.replace(/\W+/g, "")}`, c.fail);
    const { encoded, nonce, data } = await withdraw(c.budget);
    // at the requirement (plus a prelude allowance), at a small surplus and at a large one: the same BatchFailed with reason 0x00000000
    const limits = [withBudget(c.budget) + 300_000n, withBudget(c.budget) + 3_000_000n, 80_000_000n];
    const outcomes = await limits.reduce<Promise<Awaited<ReturnType<typeof run>>[]>>(async (acc, g) => [...(await acc), await run(data, g)], Promise.resolve([]));
    console.log(c.name, outcomes.map((o) => `${o.limit}:${o.ok ? (o.failed ? `BatchFailed(${o.reason}) used ${o.used}` : "landed") : o.rv}`).join("  "));
    expect(outcomes.every((o) => o.ok && o.failed && o.reason === outcomes[0]!.reason)).toBe(true); // one reason, whatever the relayer's surplus
    // the reason: the ERC-20 wrapper's own error when the token returns nothing (INVALID, or a bare revert); the token's payload, here zeros, when it returns some
    expect(outcomes[0]!.reason).toBe(c.bytes === undefined ? "0xbf608974" : "0x00000000");
    // the whole transaction costs the budget plus the prelude and the log, whatever the callee returned: the caller copied 4 bytes, not the payload
    if (c.bytes !== undefined) {
      expect(outcomes[0]!.used).toBeLessThan(c.budget + 400_000n);
      expect(outcomes[0]!.used).toBeGreaterThan(memoryGas(c.bytes)); // and the bomb really was that big
    }
    // a real transaction: the nonce is spent, nothing applied, the same bytes cannot land again, and the entity moves on at nonce + 1
    const done = await w.vm.executeTx({ to: w.domain.depository, data: ethers.hexlify(data), gasLimit: withBudget(c.budget) + 300_000n }, undefined, { emitEvents: true });
    expect((done.events as { name: string }[]).map((e) => e.name)).toContain("BatchFailed");
    expect(await w.chain.getEntityNonce(E.id)).toBe(nonce);
    expect(await w.chain.getReserves(E.id, w.TOKEN)).toBe(1000n);
    expect(await w.sendRaw(E.id, encoded, signWith(E, w.batchHash(E.id, encoded, nonce)), nonce)).toBe("REVERT E2()");
    expect(await w.submit(E, {})).toBe("ok");
    expect(await w.chain.getEntityNonce(E.id)).toBe(nonce + 1n);
  }, 900_000);
});

describe("R the post-call reserve covers the catch after a callee that burned its whole budget, at the smallest budget and the bare minimum gas limit", () => {
  test("every limit from the first one the pre-call check accepts reports BatchFailed(0)", async () => {
    const { withdraw, run } = await world("j5c-reserve", BURNS);
    const { data } = await withdraw(MIN_BUDGET);
    const outcomes: Awaited<ReturnType<typeof run>>[] = [];
    for (let g = 300_000n; g <= withBudget(MIN_BUDGET) + 400_000n; g += 500n) outcomes.push(await run(data, g));
    const first = outcomes.findIndex((o) => o.ok);
    expect(first).toBeGreaterThan(0);
    // below it: the guard, or an out-of-gas frame before the self-call; from it up: BatchFailed, never an out-of-gas in the catch
    expect(outcomes.slice(0, first).every((o) => !o.ok && (o.rv === GUARD || o.rv === "0x"))).toBe(true);
    expect(outcomes.slice(first).every((o) => o.ok && o.failed && o.reason === "0xbf608974")).toBe(true);
    const threshold = outcomes[first]!.limit;
    console.log("smallest budget", MIN_BUDGET.toString(), "-> requirement", withBudget(MIN_BUDGET).toString(), "; first limit accepted", threshold.toString(), "; gas used there", outcomes[first]!.used.toString());
    expect(threshold).toBeGreaterThanOrEqual(withBudget(MIN_BUDGET));
    // what the frame kept for itself after the callee burned MIN_BUDGET: the used gas at the threshold minus the budget and the prelude is far under the reserve
    expect(outcomes[first]!.used - MIN_BUDGET).toBeLessThan(RESERVE * 10n); // (loose: prelude + hanko + encode + the log)
  }, 900_000);
});
