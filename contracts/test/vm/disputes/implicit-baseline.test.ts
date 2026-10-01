// R-IMPLICIT-BASELINE (Q-D-21, decision D2): from the epoch after any advance, the empty state (offdelta 0, no clause, one nonce above the stored nonce) is a valid
// dispute proof for both sides WITHOUT a signature, because every field of it is on chain. A dispute from it settles at Delta = ondelta; a later signed frame
// outranks it through a counter like any newer proof. Two disputes in a row, and a deposit made after an advance, therefore always have a proof to dispute with.
// Real Depository stack in BrowserVM. Written before the contract change: at the commit that adds this file these tests fail for the reason named in each.
import { describe, expect, test } from "bun:test";
import { ethers } from "ethers";
import { boot, type Body } from "../rig.ts";

type World = Awaited<ReturnType<typeof boot>>;
const skippedOf = (w: World): { op: bigint; reason: bigint }[] =>
  (w.last.events as { name: string; args: Record<string, unknown> }[]).filter((e) => e.name === "DisputeOpSkipped").map((e) => ({ op: BigInt(e.args["op"] as bigint), reason: BigInt(e.args["reason"] as bigint) }));
/** Account.DISPUTE_OP_START / DISPUTE_OP_COUNTER and the skip reasons. */
const START_NONCE_NOT_ABOVE = { op: 0n, reason: 0n };
const START_DISPUTE_ACTIVE = { op: 0n, reason: 1n };
const START_EPOCH_MOVED = { op: 0n, reason: 11n };
const COUNTER_NOT_NEWER = { op: 1n, reason: 5n };
const NOT_IMPLICIT = "REVERT NotTheImplicitBaseline()";

/** The canonical implicit proof body: offdelta 0 for the named tokens, no clause, no watch seed, both windows at the floor. */
const implicitBody = (tokenIds: readonly number[] = [1]): Body => ({
  watchSeed: ethers.ZeroHash, leftResponseSeconds: 60, rightResponseSeconds: 60, offdeltas: tokenIds.map(() => 0n), tokenIds: [...tokenIds],
});
const withdraw = (tokenId: number, amount: bigint) =>
  [{ tokenId, leftDiff: amount, rightDiff: 0n, collateralDiff: -amount, ondeltaDiff: -amount }];

/** Epoch 1 by a cooperative settlement: Left withdrew 10 at nonce 5. Collateral 90, ondelta 90, stored nonce 5, reserves L 910 R 1000. */
const afterSettlement = async (label: string) => {
  const w = await boot(label);
  await w.fundedAccount();
  const e0 = await w.epochOf();
  const first = withdraw(w.TOKEN, 10n);
  expect(await w.settle(w.L, w.R, 5, first, w.coopSig(w.R, e0, 5, first))).toBe("ok");
  const e1 = await w.epochOf();
  expect(e1).toBe(e0 + 1n);
  expect(await w.reserves()).toEqual({ L: 910n, R: 1000n, collateral: 90n, nonce: 5n });
  return { w, e0, e1 };
};

describe("R-IMPLICIT-BASELINE dispute from the implicit proof", () => {
  test("R-IMPLICIT-BASELINE: after a settlement a side with no signed proof of the new epoch can start, and the dispute settles at ondelta", async () => {
    const { w, e1 } = await afterSettlement("ib-settle");
    const { L, R } = w;
    // Right holds nothing signed at epoch 1. It starts from the implicit proof: nonce stored + 1, authored by Right (the lowest rank at that nonce), no signature.
    expect(await w.start(R, L, 6, false, implicitBody(), "0x", e1)).toBe("ok");
    expect(skippedOf(w)).toEqual([]);
    // Before T the starter cannot close it; after both windows it settles: Delta = ondelta = 90, so Left takes all of the collateral.
    w.at(10);
    expect(await w.finalize(R, L, { nonce: 6, body: implicitBody(), startedByLeft: false }, { nonce: 6, proposerIsLeft: false, body: implicitBody(), sig: "0x" })).toMatch(/^REVERT/);
    w.at(200);
    expect(await w.finalize(R, L, { nonce: 6, body: implicitBody(), startedByLeft: false }, { nonce: 6, proposerIsLeft: false, body: implicitBody(), sig: "0x" })).toBe("ok");
    expect(await w.reserves()).toEqual({ L: 1000n, R: 1000n, collateral: 0n, nonce: 7n });
    expect(await w.epochOf()).toBe(e1 + 1n);
  });

  test("R-IMPLICIT-BASELINE: two disputes in a row, and a third, each starts from nothing (Q-D-21)", async () => {
    const w = await boot("ib-rows");
    const { L, R } = w;
    await w.fundedAccount();
    const e0 = await w.epochOf();
    // The first dispute is an ordinary signed one: Right opens with Left's stale P3 (offdelta -10) and times it out.
    const P3 = w.body(-10n);
    expect(await w.start(R, L, 3, true, P3, w.proofSig(L, e0, 3, true, P3))).toBe("ok");
    w.at(130);
    expect(await w.finalize(R, L, { nonce: 3, body: P3, startedByLeft: false }, { nonce: 3, proposerIsLeft: true, body: P3, sig: "0x" })).toBe("ok");
    expect(await w.reserves()).toEqual({ L: 990n, R: 1010n, collateral: 0n, nonce: 4n });
    const e1 = await w.epochOf();
    // A deposit after the advance needs no signature and there is no frame of epoch 1: Left parks 50.
    expect(await w.submit(L, { reserveToCollateral: [{ tokenId: w.TOKEN, receivingEntity: L.id, pairs: [{ entity: R.id, amount: 50n }] }] })).toBe("ok");
    expect(await w.epochOf()).toBe(e1);
    // Second dispute: the implicit proof, at stored nonce 4 + 1.
    w.at(140);
    expect(await w.start(R, L, 5, false, implicitBody(), "0x", e1)).toBe("ok");
    w.at(300);
    expect(await w.finalize(R, L, { nonce: 5, body: implicitBody(), startedByLeft: false }, { nonce: 5, proposerIsLeft: false, body: implicitBody(), sig: "0x" })).toBe("ok");
    // Left's deposit comes back: Delta = ondelta = 50 of a collateral of 50.
    expect(await w.reserves()).toEqual({ L: 990n, R: 1010n, collateral: 0n, nonce: 6n });
    const e2 = await w.epochOf();
    expect(e2).toBe(e1 + 1n);
    // Third dispute, Left starts this time, after a RIGHT deposit: Delta = ondelta = 0, so Right takes the whole collateral back.
    w.at(310);
    expect(await w.submit(R, { reserveToCollateral: [{ tokenId: w.TOKEN, receivingEntity: R.id, pairs: [{ entity: L.id, amount: 30n }] }] })).toBe("ok");
    expect(await w.start(L, R, 7, false, implicitBody(), "0x", e2)).toBe("ok");
    w.at(450);
    expect(await w.finalize(L, R, { nonce: 7, body: implicitBody(), startedByLeft: true }, { nonce: 7, proposerIsLeft: false, body: implicitBody(), sig: "0x" })).toBe("ok");
    expect(await w.reserves()).toEqual({ L: 990n, R: 1010n, collateral: 0n, nonce: 8n });
  });

  test("R-IMPLICIT-BASELINE: a signed frame of the epoch outranks it through a counter, and it settles instead", async () => {
    const { w, e1 } = await afterSettlement("ib-outrank");
    const { L, R } = w;
    // Left opens from the implicit proof (Delta 90 is best for it); Right holds Left's signed frame at nonce 7 with offdelta -30 (Delta 60).
    expect(await w.start(L, R, 6, false, implicitBody(), "0x", e1)).toBe("ok");
    const P7 = w.body(-30n);
    w.at(20);
    expect(await w.counter(R, L, { nonce: 6, body: implicitBody() }, { nonce: 7, proposerIsLeft: true, body: P7, sig: w.proofSig(L, e1, 7, true, P7) })).toBe("ok");
    expect(skippedOf(w)).toEqual([]);
    w.at(200);
    expect(await w.finalize(R, L, { nonce: 6, body: implicitBody(), startedByLeft: true }, { nonce: 7, proposerIsLeft: true, body: P7, sig: "0x" })).toBe("ok");
    // Delta = 90 - 30 = 60: Left 910 + 60, Right 1000 + 30.
    expect(await w.reserves()).toEqual({ L: 970n, R: 1030n, collateral: 0n, nonce: 7n });
  });

  test("R-IMPLICIT-BASELINE: at its own nonce a Left-authored signed proof outranks it, a Right-authored one ties and does not (the Runtime starts a new epoch's proofs at stored + 2)", async () => {
    const { w, e1 } = await afterSettlement("ib-tie");
    const { L, R } = w;
    // Right starts; Left holds Right's signature on a proof at the SAME nonce 6, offdelta -30.
    expect(await w.start(R, L, 6, false, implicitBody(), "0x", e1)).toBe("ok");
    const P6 = w.body(-30n);
    w.at(20);
    // Authored by Right: equal rank, not newer. Skipped (reason 5), the implicit proof stays.
    expect(await w.counter(L, R, { nonce: 6, body: implicitBody() }, { nonce: 6, proposerIsLeft: false, body: P6, sig: w.proofSig(R, e1, 6, false, P6) })).toBe("ok");
    expect(skippedOf(w)).toEqual([COUNTER_NOT_NEWER]);
    // Authored by Left: rank 2 * 6 + 1 beats 2 * 6, so it counters.
    expect(await w.counter(L, R, { nonce: 6, body: implicitBody() }, { nonce: 6, proposerIsLeft: true, body: P6, sig: w.proofSig(R, e1, 6, true, P6) })).toBe("ok");
    expect(skippedOf(w)).toEqual([]);
    w.at(200);
    expect(await w.finalize(L, R, { nonce: 6, body: implicitBody(), startedByLeft: false }, { nonce: 6, proposerIsLeft: true, body: P6, sig: "0x" })).toBe("ok");
    // A signed branch adopts its own nonce (6), it does not add one.
    expect(await w.reserves()).toEqual({ L: 970n, R: 1030n, collateral: 0n, nonce: 6n });
  });

  test("R-IMPLICIT-BASELINE: a counter may carry longer windows than the implicit proof's, and the final body may too", async () => {
    // The dispute's clock is frozen at start (the implicit proof's floor windows); a newer proof signed under the account's own, longer policy must
    // still be able to answer it and to settle.
    const { w, e1 } = await afterSettlement("ib-longer");
    const { L, R } = w;
    expect(await w.start(L, R, 6, false, implicitBody(), "0x", e1)).toBe("ok");
    const P7 = w.body(-30n, 300);
    w.at(20);
    expect(await w.counter(R, L, { nonce: 6, body: implicitBody() }, { nonce: 7, proposerIsLeft: true, body: P7, sig: w.proofSig(L, e1, 7, true, P7) })).toBe("ok");
    expect(skippedOf(w)).toEqual([]);
    w.at(200);
    expect(await w.finalize(R, L, { nonce: 6, body: implicitBody(), startedByLeft: true }, { nonce: 7, proposerIsLeft: true, body: P7, sig: "0x" })).toBe("ok");
    expect(await w.reserves()).toEqual({ L: 970n, R: 1030n, collateral: 0n, nonce: 7n });
  });

  test("R-IMPLICIT-BASELINE: a counter may never SHORTEN the dispute's windows (a signed start at 300 s, a counter at 60 s)", async () => {
    const w = await boot("ib-shorter");
    const { L, R } = w;
    await w.fundedAccount();
    const e0 = await w.epochOf();
    const P3 = w.body(-10n, 300);
    expect(await w.start(R, L, 3, true, P3, w.proofSig(L, e0, 3, true, P3))).toBe("ok");
    const P5 = w.body(-30n, 60);
    w.at(20);
    expect(await w.counter(L, R, { nonce: 3, body: P3 }, { nonce: 5, proposerIsLeft: false, body: P5, sig: w.proofSig(R, e0, 5, false, P5) })).toBe("REVERT E9()");
    // Each window is held on its own: shortening only Left's, or only Right's, is refused too.
    const P5l = w.body(-30n, 60, 300), P5r = w.body(-30n, 300, 60);
    expect(await w.counter(L, R, { nonce: 3, body: P3 }, { nonce: 5, proposerIsLeft: false, body: P5l, sig: w.proofSig(R, e0, 5, false, P5l) })).toBe("REVERT E9()");
    expect(await w.counter(L, R, { nonce: 3, body: P3 }, { nonce: 5, proposerIsLeft: false, body: P5r, sig: w.proofSig(R, e0, 5, false, P5r) })).toBe("REVERT E9()");
    // The same counter at the dispute's own windows, and at longer ones, lands.
    const P5b = w.body(-30n, 300), P5c = w.body(-30n, 600);
    expect(await w.counter(L, R, { nonce: 3, body: P3 }, { nonce: 5, proposerIsLeft: false, body: P5b, sig: w.proofSig(R, e0, 5, false, P5b) })).toBe("ok");
    const P6 = P5c;
    expect(await w.counter(L, R, { nonce: 3, body: P3 }, { nonce: 6, proposerIsLeft: false, body: P6, sig: w.proofSig(R, e0, 6, false, P6) })).toBe("ok");
    expect(skippedOf(w)).toEqual([]);
  });
});

describe("R-IMPLICIT-BASELINE what stays as it was", () => {
  test("R-IMPLICIT-BASELINE: a start at a dead epoch is still skipped with reason 11, a stale nonce and an open dispute as before", async () => {
    const { w, e0, e1 } = await afterSettlement("ib-dead");
    const { L, R } = w;
    // The implicit proof of epoch 0's world (signed-style, at an epoch the Account has left): skipped, not reverted, nothing opens.
    expect(await w.start(R, L, 6, false, implicitBody(), "0x", e0)).toBe("ok");
    expect(skippedOf(w)).toEqual([START_EPOCH_MOVED]);
    // At the stored nonce (5): not above it.
    expect(await w.start(R, L, 5, false, implicitBody(), "0x", e1)).toBe("ok");
    expect(skippedOf(w)).toEqual([START_NONCE_NOT_ABOVE]);
    // A valid implicit start, then another start while it is open.
    expect(await w.start(R, L, 6, false, implicitBody(), "0x", e1)).toBe("ok");
    expect(skippedOf(w)).toEqual([]);
    expect(await w.start(L, R, 7, false, implicitBody(), "0x", e1)).toBe("ok");
    expect(skippedOf(w)).toEqual([START_DISPUTE_ACTIVE]);
  });

  test("R-IMPLICIT-BASELINE: only the canonical implicit proof starts without a signature", async () => {
    const { w, e1 } = await afterSettlement("ib-reject");
    const { L, R } = w;
    const bad = async (nonce: number, proposerIsLeft: boolean, body: Body, patch: Record<string, unknown> = {}): Promise<string> =>
      w.submit(R, { disputeStarts: [{ ...w.startOp(L, nonce, proposerIsLeft, body, "0x", e1), ...patch }] });
    const ok = implicitBody();
    const clause = { transformerAddress: ethers.ZeroAddress, encodedBatch: "0x", allowances: [] };
    expect({
      nonceTooHigh: await bad(7, false, ok),
      leftAuthor: await bad(6, true, ok),
      offdelta: await bad(6, false, { ...ok, offdeltas: [1n] }),
      offdeltaNegative: await bad(6, false, { ...ok, offdeltas: [-1n] }),
      offdeltaHigh: await bad(6, false, { ...ok, offdeltas: [1n << 256n] }),
      secondOffdelta: await bad(6, false, { ...ok, tokenIds: [1, 2], offdeltas: [0n, 1n] }),
      leftWindow: await bad(6, false, { ...ok, leftResponseSeconds: 61 }),
      rightWindow: await bad(6, false, { ...ok, rightResponseSeconds: 120 }),
      watchSeed: await bad(6, false, { ...ok, watchSeed: ethers.id("seed") }, { watchSeed: ethers.id("seed") }),
      clause: await bad(6, false, { ...ok, transformers: [clause] }),
      starterArguments: await bad(6, false, ok, { starterInitialArguments: "0x01" }),
      counterArguments: await bad(6, false, ok, { starterCounterArguments: "0x01" }),
      counterCommitment: await bad(6, false, ok, { starterCounterProofCommitment: ethers.id("c") }),
    }).toEqual({
      nonceTooHigh: NOT_IMPLICIT, leftAuthor: NOT_IMPLICIT, offdelta: NOT_IMPLICIT, offdeltaNegative: NOT_IMPLICIT, offdeltaHigh: NOT_IMPLICIT, secondOffdelta: NOT_IMPLICIT, leftWindow: NOT_IMPLICIT, rightWindow: NOT_IMPLICIT,
      watchSeed: NOT_IMPLICIT, clause: NOT_IMPLICIT, starterArguments: NOT_IMPLICIT, counterArguments: NOT_IMPLICIT, counterCommitment: NOT_IMPLICIT,
    });
    // The canonical one still opens.
    expect(await bad(6, false, ok)).toBe("ok");
    expect(skippedOf(w)).toEqual([]);
  });

  test("R-IMPLICIT-BASELINE: at epoch 0 there is no implicit proof (a fresh account's first frames are its proofs)", async () => {
    const w = await boot("ib-epoch0");
    const { L, R } = w;
    await w.fundedAccount();
    expect(await w.epochOf()).toBe(0n);
    expect(await w.start(R, L, 1, false, implicitBody(), "0x", 0n)).toBe(NOT_IMPLICIT);
  });

  test("R-IMPLICIT-BASELINE: a signed start is checked as before (a wrong signature is E4)", async () => {
    const { w, e1 } = await afterSettlement("ib-signed");
    const { L, R } = w;
    const P7 = w.body(-30n);
    expect(await w.start(R, L, 7, true, P7, w.proofSig(R, e1, 7, true, P7), e1)).toBe("REVERT E4()");
    expect(await w.start(R, L, 7, true, P7, w.proofSig(L, e1, 7, true, P7), e1)).toBe("ok");
  });
});
