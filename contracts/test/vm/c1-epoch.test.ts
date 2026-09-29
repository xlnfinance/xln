// C1 (contracts-review.md): after a dispute finalizes, a proof with a higher nonce that was signed earlier must not
// settle its offdelta a second time. Runs the real Depository stack in BrowserVM.
import { describe, expect, test } from "bun:test";
import { ethers } from "ethers";
import { boot } from "./rig.ts";

describe("C1 ondelta epoch", () => {
  test("a pre-finalize proof cannot start a second dispute that pays its offdelta again", async () => {
    const w = await boot("c1-double");
    const { L, R } = w;
    await w.fundedAccount();
    const e0 = await w.epochOf();
    // Signed history. P3: offdelta 0. P5: Left paid Right 30, signed by both. P6: Left proposed 10 more, signed by Left only.
    const P3 = w.body(0n), P5 = w.body(-30n), P6 = w.body(-40n);
    const p3ByL = w.proofSig(L, e0, 3, true, P3);
    const p5ByR = w.proofSig(R, e0, 5, false, P5);
    const p6ByL = w.proofSig(L, e0, 6, true, P6);
    // Positive control: the honest sequence works. Right opens with stale P3; Left answers at once with P5.
    expect(await w.start(R, L, 3, true, P3, p3ByL)).toBe("ok");
    expect(await w.finalize(L, R, { nonce: 3, body: P3, startedByLeft: false }, { nonce: 5, proposerIsLeft: false, body: P5, sig: p5ByR })).toBe("ok");
    expect(await w.reserves()).toEqual({ L: 970n, R: 1030n, collateral: 0n, nonce: 5n });
    // Attack: Right opens again with Left's unacked P6 (nonce 6 > stored 5) and times it out.
    w.at(100);
    const attackStart = await w.start(R, L, 6, true, P6, p6ByL);
    w.at(300);
    const attackEnd = await w.finalize(R, L, { nonce: 6, body: P6, startedByLeft: false }, { nonce: 6, proposerIsLeft: true, body: P6, sig: "0x" });
    const end = await w.reserves();
    // The latest state both signed owes Right 30 in all; nothing beyond P5 may move. The start is rejected (E4: its epoch-0
    // signature does not verify at epoch 1), so there is no dispute to finalize: J2 skips that finalize instead of reverting.
    expect({ attackStart, attackEnd, L: end.L, R: end.R }).toEqual({ attackStart: "REVERT E4()", attackEnd: "ok", L: 970n, R: 1030n });
    expect((w.last.events as { name: string }[]).map((e) => e.name)).toContain("DisputeOpSkipped");
  });

  test("an offline victim: a timeout at N leaves nonce N+1, so N+2 must not pay a second time", async () => {
    const w = await boot("c1-plusone");
    const { L, R } = w;
    await w.fundedAccount();
    const e0 = await w.epochOf();
    const P3 = w.body(-10n), P5 = w.body(-30n);
    const p3ByL = w.proofSig(L, e0, 3, true, P3);
    const p5ByL = w.proofSig(L, e0, 5, true, P5);
    expect(await w.start(R, L, 3, true, P3, p3ByL)).toBe("ok");
    w.at(130);
    expect(await w.finalize(R, L, { nonce: 3, body: P3, startedByLeft: false }, { nonce: 3, proposerIsLeft: true, body: P3, sig: "0x" })).toBe("ok");
    const afterFirst = await w.reserves();
    expect(afterFirst.R - 1000n).toBe(10n);
    const second = await w.start(R, L, 5, true, P5, p5ByL);
    w.at(300);
    const secondEnd = await w.finalize(R, L, { nonce: 5, body: P5, startedByLeft: false }, { nonce: 5, proposerIsLeft: true, body: P5, sig: "0x" });
    const end = await w.reserves();
    // P5 alone would pay Right 30; the 10 already paid may not be paid again on top of it. The second start is rejected
    // (E4), so there is no dispute to finalize: J2 skips that finalize instead of reverting, and nothing moves.
    expect({ second, secondEnd, R: end.R }).toEqual({ second: "REVERT E4()", secondEnd: "ok", R: 1010n });
    expect((w.last.events as { name: string }[]).map((e) => e.name)).toContain("DisputeOpSkipped");
  });

  test("a proof signed at the new epoch works after the finalize", async () => {
    const w = await boot("c1-fresh");
    const { L, R } = w;
    await w.fundedAccount();
    const e0 = await w.epochOf();
    const P3 = w.body(-10n);
    expect(await w.start(R, L, 3, true, P3, w.proofSig(L, e0, 3, true, P3))).toBe("ok");
    w.at(130);
    expect(await w.finalize(R, L, { nonce: 3, body: P3, startedByLeft: false }, { nonce: 3, proposerIsLeft: true, body: P3, sig: "0x" })).toBe("ok");
    const e1 = await w.epochOf();
    expect(e1).toBe(w.features.epoch ? e0 + 1n : 0n);
    // Both sides re-sign after the finalize; the Account continues at the new epoch (offdelta restarts at 0).
    const Q = w.body(0n);
    w.at(140);
    expect(await w.start(R, L, 5, true, Q, w.proofSig(L, e1, 5, true, Q))).toBe("ok");
  });

  const withdraw = (tokenId: number, amount: bigint) =>
    [{ tokenId, leftDiff: amount, rightDiff: 0n, collateralDiff: -amount, ondeltaDiff: -amount }];

  test("a cooperative settlement voids every proof and settlement signed for the earlier baseline", async () => {
    const w = await boot("c1-settle");
    const { L, R } = w;
    await w.fundedAccount();
    const e0 = await w.epochOf();
    const staleProof = w.body(-40n), staleSettlement = withdraw(w.TOKEN, 20n);
    const proofByL = w.proofSig(L, e0, 7, true, staleProof);
    const settlementByR9 = w.coopSig(R, e0, 9, staleSettlement);
    // Left withdraws 10 at nonce 5, signed by Right.
    const first = withdraw(w.TOKEN, 10n);
    expect(await w.settle(L, R, 5, first, w.coopSig(R, e0, 5, first))).toBe("ok");
    const e1 = await w.epochOf();
    expect(e1).toBe(e0 + 1n);
    // Both artifacts carry a nonce above 5, and both were signed before the settlement.
    expect(await w.start(R, L, 7, true, staleProof, proofByL)).toBe("REVERT E4()");
    // J5: a co-signed settlement made stale by a landed one is a bad counterparty signature inside the ops: the batch fails (E4
    // reported, entity nonce spent, nothing applied) instead of reverting, so the entity is not stalled at that nonce
    const nonceBefore = await w.chain.getEntityNonce(L.id);
    expect(await w.settle(L, R, 9, staleSettlement, settlementByR9)).toBe("ok");
    const failedReasons = (w.last.events as { name: string; args: Record<string, unknown> }[]).filter((e) => e.name === "BatchFailed").map((e) => String(e.args["reason"]));
    expect({ failedReasons, spent: (await w.chain.getEntityNonce(L.id)) - nonceBefore }).toEqual({ failedReasons: [ethers.id("E4()").slice(0, 10)], spent: 1n });
    // The same artifacts re-signed for the new baseline are accepted.
    expect(await w.settle(L, R, 9, staleSettlement, w.coopSig(R, e1, 9, staleSettlement))).toBe("ok");
    expect(await w.epochOf()).toBe(e1 + 1n);
  });

  test("R2C keeps the epoch: a deposit by anyone cannot void signed proofs", async () => {
    const w = await boot("c1-r2c");
    const { L, R } = w;
    await w.fundedAccount();
    const e0 = await w.epochOf();
    const P3 = w.body(-10n);
    const p3ByL = w.proofSig(L, e0, 3, true, P3);
    // Right deposits into the Account (Right side), a unilateral act that needs no signature from Left.
    expect(await w.submit(R, { reserveToCollateral: [{ tokenId: w.TOKEN, receivingEntity: R.id, pairs: [{ entity: L.id, amount: 5n }] }] })).toBe("ok");
    expect(await w.epochOf()).toBe(e0);
    expect(await w.start(R, L, 3, true, P3, p3ByL)).toBe("ok");
  });
});
