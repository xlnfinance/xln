// J5 (contracts-decisions.md): a signed batch that carries no dispute or reveal op and whose ops fail (payment, settlement or
// reserve ops) applies none of them, still consumes the entity nonce, and emits BatchFailed(entity, nonce, reason); the
// transaction does not revert. Why: with F1 (a signed batch is final at its nonce) a reverting batch leaves its nonce open, and
// every urgent op above it stalls, because nothing else may be signed at that nonce.
// Authentication failures (bad hanko, wrong entity, wrong nonce, malformed or oversize batch) still revert and take no nonce,
// so nobody can burn nonces with garbage. A relayer must not be able to turn a batch that would succeed into a failed one by
// starving it of gas. Real Depository stack in BrowserVM; one file per process: `bun test contracts/test/vm/j5-batch-failed.test.ts`.
import { describe, expect, test } from "bun:test";
import { ethers } from "ethers";
import { createAddressFromString } from "@ethereumjs/util";
import { boot, party, rawHanko, signWith } from "./rig.ts";
import { DeltaTransformer__factory as forkTransformer, Depository__factory as forkDepository } from "../../typechain-types/index.ts";

const coder = ethers.AbiCoder.defaultAbiCoder();
const E3 = ethers.id("E3()").slice(0, 10);
const BATCH_FAILED = ethers.id("BatchFailed(bytes32,uint256,bytes4)");
const BATCH_PROCESSED = ethers.id("HankoBatchProcessed(bytes32,bytes32,uint256)");

const world = async () => {
  const w = await boot("j5");
  const [A, B, sink] = [party("j5-a"), party("j5-b"), party("j5-sink")];
  await w.chain.debugFundReserves(A.id, w.TOKEN, 1000n);
  const transformer = w.chain.addresses.deltaTransformer;
  const secret = ethers.id("j5-urgent-secret");
  const hashlock = ethers.keccak256(coder.encode(["bytes32"], [secret]));
  const pay = (amount: bigint) => ({ receivingEntity: sink.id, tokenId: w.TOKEN, amount });
  const events = (name: string) => (w.last.events as { name: string; args: Record<string, unknown> }[]).filter((e) => e.name === name);
  const failed = () => events("BatchFailed").map((e) => ({ entity: e.args["entityId"], nonce: BigInt(e.args["nonce"] as bigint), reason: String(e.args["reason"]) }));
  const nonceOf = (who = A) => w.chain.getEntityNonce(who.id);
  const balances = async () => ({ A: await w.chain.getReserves(A.id, w.TOKEN), sink: await w.chain.getReserves(sink.id, w.TOKEN) });
  const revealedAt = async (): Promise<bigint> => {
    const iface = forkTransformer.createInterface();
    const data = iface.encodeFunctionData("hashToTimestamp", [hashlock]);
    const r = await w.vm.runReadOnlyCall({ to: createAddressFromString(transformer), caller: w.vm.deployerAddress, data: ethers.getBytes(data), gasLimit: 500_000n });
    return BigInt(iface.decodeFunctionResult("hashToTimestamp", r.execResult.returnValue)[0]);
  };
  return { w, A, B, sink, secret, reveal: { transformer, secret }, pay, events, failed, nonceOf, balances, revealedAt };
};

describe("J5 a failing payment batch consumes its nonce and the urgent batch above it lands", () => {
  test("a payment beyond the reserve is a BatchFailed, not a revert; nonce consumed, nothing applied", async () => {
    const { w, A, pay, events, failed, nonceOf, balances } = await world();
    expect(await nonceOf()).toBe(0n);
    // signed while affordable in the story; the reserve is short of it now (a drained reserve fails the same way)
    expect(await w.submit(A, { reserveToReserve: [pay(5000n)] })).toBe("ok");
    expect(await nonceOf()).toBe(1n);
    expect(await balances()).toEqual({ A: 1000n, sink: 0n });
    expect(failed()).toEqual([{ entity: A.id, nonce: 1n, reason: E3 }]);
    expect(events("HankoBatchProcessed")).toHaveLength(0);
  });

  test("the urgent batch at n + 1 lands: a secret reveal, and a payment", async () => {
    const { w, A, reveal, pay, events, failed, nonceOf, balances, revealedAt } = await world();
    expect(await w.submit(A, { reserveToReserve: [pay(5000n)] })).toBe("ok");
    expect(failed()).toHaveLength(1);
    expect(await w.submit(A, { revealSecrets: [reveal] })).toBe("ok");
    expect(await revealedAt()).not.toBe(0n);
    expect(events("BatchFailed")).toHaveLength(0);
    expect(await w.submit(A, { reserveToReserve: [pay(100n)] })).toBe("ok");
    expect(await nonceOf()).toBe(3n);
    expect(await balances()).toEqual({ A: 900n, sink: 100n });
  });

  test("the batch is atomic: a valid payment before the failing one is not applied either", async () => {
    const { w, A, pay, failed, nonceOf, balances } = await world();
    expect(await w.submit(A, { reserveToReserve: [pay(10n), pay(5000n)] })).toBe("ok");
    expect(await nonceOf()).toBe(1n);
    expect(await balances()).toEqual({ A: 1000n, sink: 0n });
    expect(failed()).toHaveLength(1);
  });

  test("a settlement that fails (no such collateral) is a BatchFailed too, and takes the nonce", async () => {
    const { w, A, B, failed, nonceOf, balances } = await world();
    const acct = w.accountOf(A, B, "j5-acct");
    const diffs = [{ tokenId: w.TOKEN, leftDiff: 10n, rightDiff: 0n, collateralDiff: -10n, ondeltaDiff: -10n }];
    const before = await acct.reserves();
    expect(await w.settle(A, B, 1, diffs, acct.coopSig(B, await acct.epochOf(), 1, diffs))).toBe("ok");
    expect(await nonceOf()).toBe(1n);
    expect(await acct.reserves()).toEqual(before);
    expect(failed()).toHaveLength(1);
    void balances;
  });

  test("a failed batch does not replay: the same signed batch at the consumed nonce reverts", async () => {
    const { w, A, pay, failed } = await world();
    expect(await w.submit(A, { reserveToReserve: [pay(5000n)] })).toBe("ok");
    const { entityId, encodedBatch, nonce } = w.last.batch!;
    expect(failed()).toHaveLength(1);
    await w.chain.debugFundReserves(A.id, w.TOKEN, 10_000n); // now affordable, but the nonce is spent
    expect(await w.sendRaw(entityId, encodedBatch, signWith(A, w.batchHash(entityId, encodedBatch, nonce)), nonce)).toBe("REVERT E2()");
  });
});

describe("J5 authentication failures still revert and take no nonce", () => {
  test("a bad hanko reverts E4 and the nonce stays open", async () => {
    const { w, A, B, pay, nonceOf } = await world();
    const encoded = w.encodeJBatch({ ...w.createEmptyBatch(), reserveToReserve: [pay(5000n)] } as never);
    expect(await w.sendRaw(A.id, encoded, rawHanko(w.batchHash(A.id, encoded, 1n), B.key), 1n)).toBe("REVERT E4()");
    expect(await nonceOf()).toBe(0n);
  });

  test("a hanko made for another entity reverts E4 and the nonce stays open", async () => {
    const { w, A, B, pay, nonceOf } = await world();
    const encoded = w.encodeJBatch({ ...w.createEmptyBatch(), reserveToReserve: [pay(5000n)] } as never);
    expect(await w.sendRaw(A.id, encoded, signWith(B, w.batchHash(B.id, encoded, 1n)), 1n)).toBe("REVERT E4()");
    expect(await nonceOf()).toBe(0n);
    expect(await nonceOf(B)).toBe(0n);
  });

  test("a wrong nonce reverts E2 and the entity nonce is unchanged", async () => {
    const { w, A, pay, nonceOf } = await world();
    const encoded = w.encodeJBatch({ ...w.createEmptyBatch(), reserveToReserve: [pay(5000n)] } as never);
    expect(await w.sendRaw(A.id, encoded, signWith(A, w.batchHash(A.id, encoded, 2n)), 2n)).toBe("REVERT E2()");
    expect(await nonceOf()).toBe(0n);
  });
});

describe("J5 a batch that carries a dispute or reveal op keeps the J2 rule: a real error reverts the whole batch", () => {
  test("a reveal beside a failing payment reverts E3, the reveal does not land and the nonce stays open", async () => {
    const { w, A, reveal, pay, nonceOf, revealedAt, events } = await world();
    expect(await w.submit(A, { revealSecrets: [reveal], reserveToReserve: [pay(5000n)] })).toBe("REVERT E3()");
    expect(await revealedAt()).toBe(0n);
    expect(await nonceOf()).toBe(0n);
    expect(events("BatchFailed")).toHaveLength(0);
  });
});

describe("J5 a relayer cannot fail a good batch by starving it of gas", () => {
  test("at every gas limit the batch either reverts or lands whole; never a BatchFailed", async () => {
    const { w, A, pay } = await world();
    const iface = forkDepository.createInterface();
    // forty small payments: enough work that the inner call's share of the gas matters
    const encoded = w.encodeJBatch({ ...w.createEmptyBatch(), reserveToReserve: Array.from({ length: 40 }, () => pay(1n)) } as never);
    const data = ethers.getBytes(iface.encodeFunctionData("processBatch", [A.id, encoded, signWith(A, w.batchHash(A.id, encoded, 1n)), 1n]));
    const run = async (gasLimit: bigint) => {
      const r = await w.vm.runReadOnlyCall({ to: w.vm.depositoryAddress, caller: w.vm.deployerAddress, data, gasLimit });
      const topics = (r.execResult.logs ?? []).map((l: [Uint8Array, Uint8Array[], Uint8Array]) => ethers.hexlify(l[1][0]!));
      return { ok: r.execResult.exceptionError === undefined, failed: topics.includes(BATCH_FAILED), processed: topics.includes(BATCH_PROCESSED), used: BigInt(r.execResult.executionGasUsed) };
    };
    const full = await run(15_000_000n);
    expect(full).toMatchObject({ ok: true, failed: false, processed: true });
    // scan from well under the need to the need itself, densely near it (the EIP-150 window is about 1/64 of the gas)
    const intrinsic = 21_000n + 16n * BigInt(data.length);
    const step = full.used / 500n;
    const limits = Array.from({ length: 300 }, (_, i) => full.used + intrinsic + 20n * step - BigInt(i) * step);
    const outcomes = await limits.reduce<Promise<Awaited<ReturnType<typeof run>>[]>>(async (acc, limit) => [...(await acc), await run(limit)], Promise.resolve([]));
    expect(outcomes.filter((o) => o.ok && o.failed)).toEqual([]);
    expect(outcomes.some((o) => o.ok && o.processed)).toBe(true);
    expect(outcomes.some((o) => !o.ok)).toBe(true);
  }, 300_000);
});
