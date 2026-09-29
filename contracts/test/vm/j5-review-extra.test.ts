// Review of J5 (PR 54): what an authenticated batch's settlement ops do when the account moved under them.
import { describe, expect, test } from "bun:test";
import { ethers } from "ethers";
import { boot } from "./rig.ts";

const BATCH_FAILED = "BatchFailed";
const ERROR_STRING = ethers.id("Error(string)").slice(0, 10);
const E2 = ethers.id("E2()").slice(0, 10);
const E4 = ethers.id("E4()").slice(0, 10);

const world = async (label: string) => {
  const w = await boot(label);
  const acct = w.accountOf(w.L, w.R, `${label}-acct`);
  await acct.fundedAccount();
  const events = (name: string) => (w.last.events as { name: string; args: Record<string, unknown> }[]).filter((e) => e.name === name);
  const nonceOf = () => w.chain.getEntityNonce(w.L.id);
  const diffs = (n: bigint) => [{ tokenId: w.TOKEN, leftDiff: n, rightDiff: 0n, collateralDiff: -n, ondeltaDiff: -n }];
  const settle = async (nonce: number, d: ReturnType<typeof diffs>, epoch: bigint, sig?: string) =>
    w.settle(w.L, w.R, nonce, d, sig ?? acct.coopSig(w.R, epoch, nonce, d));
  return { w, acct, events, nonceOf, diffs, settle };
};

describe("J5 review: settlement signatures commit to the account epoch, which moves on every settlement", () => {
  test("a settlement signed before another one landed is a BatchFailed E4: the nonce is spent, and the re-signed one lands at the next", async () => {
    const { w, acct, events, nonceOf, diffs, settle } = await world("j5r-epoch");
    const e0 = await acct.epochOf();
    expect(await settle(1, diffs(10n), e0)).toBe("ok"); // a good settlement lands; the epoch advances
    const e1 = await acct.epochOf();
    expect(e1).toBe(e0 + 1n);
    const before = await nonceOf();
    // a second co-signed settlement made against the old epoch: the counterparty's signature is genuine, the state moved
    const stale = await settle(2, diffs(10n), e0);
    expect({ stale, nonce: await nonceOf() - before, failed: events(BATCH_FAILED).map((e) => String(e.args["reason"])) }).toEqual({ stale: "ok", nonce: 1n, failed: [E4] });
    // J5 (coordinator): a bad counterparty signature is a failure of the batch, so it spends the nonce and the entity is not stalled;
    // the same intent re-signed at the current epoch lands at the next entity nonce
    expect(await settle(2, diffs(10n), e1)).toBe("ok");
    expect(await nonceOf()).toBe(before + 2n);
    expect((await acct.reserves()).collateral).toBe(80n);
  });

  test("a settlement at an account nonce already used is E2: soft-fail, nonce burned", async () => {
    const { w, acct, events, nonceOf, diffs, settle } = await world("j5r-nonce");
    const e0 = await acct.epochOf();
    expect(await settle(1, diffs(10n), e0)).toBe("ok");
    const e1 = await acct.epochOf();
    const before = await nonceOf();
    expect(await settle(1, diffs(10n), e1)).toBe("ok");
    expect(await nonceOf()).toBe(before + 1n);
    expect(events(BATCH_FAILED).map((e) => String(e.args["reason"]))).toEqual([E2]);
    void w;
  });

  test("an unsigned settlement soft-fails with reason Error(string): its nonce is spent", async () => {
    const { w, acct, events, nonceOf, diffs, settle } = await world("j5r-unsigned");
    const before = await nonceOf();
    expect(await settle(1, diffs(10n), await acct.epochOf(), "0x")).toBe("ok");
    expect(await nonceOf()).toBe(before + 1n);
    expect(events(BATCH_FAILED).map((e) => String(e.args["reason"]))).toEqual([ERROR_STRING]);
    expect((await acct.reserves()).collateral).toBe(100n);
    void w;
  });

  test("a settlement that overdraws collateral is E3: soft-fail, nothing moves", async () => {
    const { w, acct, events, nonceOf, diffs, settle } = await world("j5r-e3");
    const before = await nonceOf();
    const reserves = await acct.reserves();
    expect(await settle(1, diffs(5000n), await acct.epochOf())).toBe("ok");
    expect(await nonceOf()).toBe(before + 1n);
    expect(await acct.reserves()).toEqual(reserves);
    expect(events(BATCH_FAILED)).toHaveLength(1);
    void w;
  });
});

// A good batch must never soft-fail because a relayer chose the gas. The guard in processBatch reads "a failure that left under
// 1/32 of the gas was gas starvation". Each call frame keeps 1/64 of its gas, so a starved frame three or four calls deep
// (C2R -> Account -> EntityProvider -> HankoVerifier) can bubble up as an ordinary revert with about 3/64 left.
import { signWith } from "./rig.ts";
import { Depository__factory as forkDepository } from "../../typechain-types/index.ts";

const BATCH_FAILED_TOPIC = ethers.id("BatchFailed(bytes32,uint256,bytes4)");
const BATCH_PROCESSED_TOPIC = ethers.id("HankoBatchProcessed(bytes32,bytes32,uint256)");

describe("J5 review: a relayer starving the nested signature check of gas", () => {
  const sweep = async (kind: "c2r" | "settlement") => {
    const { w, acct, diffs } = await world(`j5r-gas-${kind}`);
    const e0 = await acct.epochOf();
    const d = diffs(10n);
    const sig = acct.coopSig(w.R, e0, 1, d);
    const patch = kind === "c2r"
      ? { collateralToReserve: [{ counterparty: w.R.id, tokenId: w.TOKEN, amount: 10n, nonce: 1, sig }] }
      : { settlements: [{ leftEntity: w.L.id, rightEntity: w.R.id, diffs: d, forgiveDebtsInTokenIds: [], sig, nonce: 1 }] };
    const encoded = w.encodeJBatch({ ...w.createEmptyBatch(), ...patch } as never);
    const nonce = (await w.chain.getEntityNonce(w.L.id)) + 1n;
    const iface = forkDepository.createInterface();
    const data = ethers.getBytes(iface.encodeFunctionData("processBatch", [w.L.id, encoded, signWith(w.L, w.batchHash(w.L.id, encoded, nonce)), nonce]));
    const run = async (gasLimit: bigint) => {
      const r = await w.vm.runReadOnlyCall({ to: w.vm.depositoryAddress, caller: w.vm.deployerAddress, data, gasLimit });
      const topics = (r.execResult.logs ?? []).map((l: [Uint8Array, Uint8Array[], Uint8Array]) => ethers.hexlify(l[1][0]!));
      return { limit: gasLimit, ok: r.execResult.exceptionError === undefined, failed: topics.includes(BATCH_FAILED_TOPIC), processed: topics.includes(BATCH_PROCESSED_TOPIC), used: BigInt(r.execResult.executionGasUsed) };
    };
    const full = await run(15_000_000n);
    expect(full).toMatchObject({ ok: true, failed: false, processed: true });
    const intrinsic = 21_000n + 16n * BigInt(data.length);
    const step = full.used / 300n;
    const limits = Array.from({ length: 330 }, (_, i) => full.used + intrinsic + 20n * step - BigInt(i) * step);
    const outcomes = await limits.reduce<Promise<Awaited<ReturnType<typeof run>>[]>>(async (acc, limit) => [...(await acc), await run(limit)], Promise.resolve([]));
    return { full, outcomes };
  };

  test("C2R: at no gas limit does a good batch return as BatchFailed", async () => {
    const { outcomes } = await sweep("c2r");
    expect(outcomes.filter((o) => o.ok && o.failed).map((o) => o.limit)).toEqual([]);
    expect(outcomes.some((o) => o.ok && o.processed)).toBe(true);
    expect(outcomes.some((o) => !o.ok)).toBe(true);
  }, 600_000);

  test("settlement: at no gas limit does a good batch return as BatchFailed", async () => {
    const { outcomes } = await sweep("settlement");
    expect(outcomes.filter((o) => o.ok && o.failed).map((o) => o.limit)).toEqual([]);
    expect(outcomes.some((o) => o.ok && o.processed)).toBe(true);
    expect(outcomes.some((o) => !o.ok)).toBe(true);
  }, 600_000);
});

// R-SPLIT for every member of the dispute-op set: `_carriesDisputeOps` must count starts and counters as well as finalizations,
// reveals and ladders, or a start beside a failing payment lands as a BatchFailed and the start is silently dropped.
import { party, type Body } from "./rig.ts";

describe("J5 review: a dispute start or counter beside a failing payment reverts the whole batch (R-SPLIT)", () => {
  const WINDOWS = 60;
  const setup = async () => {
    const w = await boot("j5r-split");
    const [A, B] = [party("j5r-split-a"), party("j5r-split-b")];
    const acct = w.accountOf(A, B, "j5r-split-acct");
    await acct.fundedAccount();
    const aIsLeft = acct.L.id === A.id;
    const body: Body = acct.body(0n, WINDOWS);
    const epoch = await acct.epochOf();
    const startOp = w.startOp(B, 1, aIsLeft, body, acct.proofSig(B, epoch, 1, aIsLeft, body));
    const counterOp = (nonce: number, b: Body) => w.counterOp(A, { nonce: 1, body }, { nonce, proposerIsLeft: !aIsLeft, body: b, sig: acct.proofSig(A, epoch, nonce, !aIsLeft, b) });
    const overdraw = (to: string) => ({ reserveToReserve: [{ receivingEntity: to, tokenId: w.TOKEN, amount: 5000n }] });
    const events = (name: string) => (w.last.events as { name: string }[]).filter((e) => e.name === name);
    return { w, A, B, acct, startOp, counterOp, overdraw, events };
  };

  test("a start beside a failing payment: E3, nothing lands, the nonce stays open", async () => {
    const { w, A, B, startOp, overdraw, events } = await setup();
    w.at(100);
    const before = await w.chain.getEntityNonce(A.id);
    expect(await w.submit(A, { disputeStarts: [startOp], ...overdraw(B.id) })).toBe("REVERT E3()");
    expect(await w.chain.getEntityNonce(A.id)).toBe(before);
    expect(events("BatchFailed")).toHaveLength(0);
    expect(await w.submit(A, { disputeStarts: [startOp] })).toBe("ok"); // the op itself was good
  });

  test("a counter beside a failing payment: E3, nothing lands, the nonce stays open", async () => {
    const { w, A, B, acct, startOp, counterOp, overdraw, events } = await setup();
    w.at(100);
    expect(await w.submit(A, { disputeStarts: [startOp] })).toBe("ok");
    w.at(110);
    const newer = counterOp(3, acct.body(30n, WINDOWS));
    const before = await w.chain.getEntityNonce(B.id);
    expect(await w.submit(B, { counterDisputes: [newer], ...overdraw(A.id) })).toBe("REVERT E3()");
    expect(await w.chain.getEntityNonce(B.id)).toBe(before);
    expect(events("BatchFailed")).toHaveLength(0);
    expect(await w.submit(B, { counterDisputes: [newer] })).toBe("ok");
  });
});
