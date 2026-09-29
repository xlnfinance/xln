// J5 (contracts-decisions.md): a signed batch that carries no dispute or reveal op and whose ops fail (payment, settlement or
// reserve ops) applies none of them, still consumes the entity nonce, and emits BatchFailed(entity, nonce, reason); the
// transaction does not revert. Why: with F1 (a signed batch is final at its nonce) a reverting batch leaves its nonce open, and
// every urgent op above it stalls, because nothing else may be signed at that nonce.
// A failure of the batch's own hanko authorisation (bad hanko, wrong entity, wrong nonce, malformed or oversize batch) still reverts
// and takes no nonce, so nobody can burn nonces with garbage; a bad counterparty signature inside the ops is a BatchFailed.
// A batch with an external deposit leg reverts whole too: deposits pull from the caller, so a relayer must not burn the nonce. A relayer must not be able to turn a batch that would succeed into a failed one by
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

describe("J5 a bad counterparty signature inside the ops is a failure of the batch: it spends the nonce", () => {
  // Why not a revert: a settlement or C2R is co-signed against the account epoch, which every landed settlement, C2R and
  // dispute finalize advances. A co-signed batch made stale that way would revert E4 forever, and under F1 the entity cannot sign
  // a different batch at that nonce, so it would stall every batch above it. Only the signer can put a bad signature in the
  // bytes, so spending the nonce hurts no one else.
  const E4 = ethers.id("E4()").slice(0, 10);

  test("a settlement signed by the wrong party is a BatchFailed E4, nonce spent, nothing moves", async () => {
    const { w, A, B, nonceOf, failed, events } = await world();
    const acct = w.accountOf(A, B, "j5-badsig");
    await acct.fundedAccount();
    const nonceBefore = await nonceOf();
    const reserves = await acct.reserves();
    const diffs = [{ tokenId: w.TOKEN, leftDiff: 10n, rightDiff: 0n, collateralDiff: -10n, ondeltaDiff: -10n }];
    // signed by A itself, not by the counterparty B
    expect(await w.settle(A, B, 5, diffs, acct.coopSig(A, await acct.epochOf(), 5, diffs))).toBe("ok");
    expect(await nonceOf()).toBe(nonceBefore + 1n);
    expect(failed()).toEqual([{ entity: A.id, nonce: nonceBefore + 1n, reason: E4 }]);
    expect(events("HankoBatchProcessed")).toHaveLength(0);
    expect(await acct.reserves()).toEqual(reserves);
  });
});

describe("J5 a C2R whose counterparty signature is empty or malformed is a BatchFailed E4 too", () => {
  // The signature check reverts with no data on an empty or undecodable signature. That must not fall into the hard revert for an
  // empty reason (which is meant for an out-of-gas frame): it is one more kind of bad counterparty signature, so E4, nonce spent.
  const E4 = ethers.id("E4()").slice(0, 10);
  for (const [label, sig] of [["empty", "0x"], ["malformed", "0x1234"]] as const) {
    test(`an ${label} counterparty signature: BatchFailed E4, nonce spent, nothing moves`, async () => {
      const { w, A, B, nonceOf, failed, events } = await world();
      const acct = w.accountOf(A, B, `j5-c2r-${label}`);
      await acct.fundedAccount();
      const nonceBefore = await nonceOf();
      const reserves = await acct.reserves();
      expect(await w.submit(A, { collateralToReserve: [{ counterparty: B.id, tokenId: w.TOKEN, amount: 10n, nonce: 1, sig }] })).toBe("ok");
      expect(await nonceOf()).toBe(nonceBefore + 1n);
      expect(failed()).toEqual([{ entity: A.id, nonce: nonceBefore + 1n, reason: E4 }]);
      expect(events("HankoBatchProcessed")).toHaveLength(0);
      expect(await acct.reserves()).toEqual(reserves);
    });
  }
});

describe("J5 a failure of the batch's own hanko authorisation still reverts and takes no nonce", () => {
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

describe("J5 the inner entry point is not a public door", () => {
  test("applyBatch called from outside reverts E2: it would run any batch without a hanko", async () => {
    const { w, A, pay } = await world();
    const iface = forkDepository.createInterface();
    const encoded = w.encodeJBatch({ ...w.createEmptyBatch(), reserveToReserve: [pay(1n)] } as never);
    const data = iface.encodeFunctionData("applyBatch", [A.id, encoded, ethers.ZeroAddress]);
    const r = await w.vm.runReadOnlyCall({ to: w.vm.depositoryAddress, caller: w.vm.deployerAddress, data: ethers.getBytes(data), gasLimit: 5_000_000n });
    expect(r.execResult.exceptionError?.error).toBe("revert");
    expect(iface.parseError(ethers.hexlify(r.execResult.returnValue))?.name).toBe("E2");
    expect(await w.chain.getReserves(A.id, w.TOKEN)).toBe(1000n);
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

describe("J5 a stale dispute op is a dispute op: it shares no batch with a payment", () => {
  const staleFinalize = async () => {
    const world_ = await world();
    const { w, A, B } = world_;
    const acct = w.accountOf(A, B, "j5-acct");
    await acct.fundedAccount();
    const aIsLeft = acct.L.id === A.id;
    const body = acct.body(0n, 60);
    // no dispute is open on this Account, so this finalize is stale: alone it is skipped (J2)
    const op = w.finalizeOp(B, { nonce: 1, body, startedByLeft: aIsLeft }, { nonce: 1, proposerIsLeft: aIsLeft, body, sig: "0x" });
    return { ...world_, op };
  };

  test("alone it lands as a skip and spends the nonce; beside a failing payment the whole batch reverts E3, the skip rolled back", async () => {
    const { w, A, op, pay, nonceOf, events } = await staleFinalize();
    const before = await nonceOf();
    expect(await w.submit(A, { disputeFinalizations: [op], reserveToReserve: [pay(5000n)] })).toBe("REVERT E3()");
    expect(await nonceOf()).toBe(before);
    expect(events("DisputeOpSkipped")).toHaveLength(0);
    expect(events("BatchFailed")).toHaveLength(0);
    // the same op in its own batch is a skip (J2) and takes the next nonce; it is not a BatchFailed
    expect(await w.submit(A, { disputeFinalizations: [op] })).toBe("ok");
    expect(await nonceOf()).toBe(before + 1n);
    expect(events("DisputeOpSkipped")).toHaveLength(1);
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
