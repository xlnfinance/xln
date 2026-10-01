// Review B of PR 76 (R-IMPLICIT-BASELINE): whole-system scenarios on the real Depository stack in BrowserVM.
// Each test is a story a Runtime would live through, not a per-function check. Tags: REVIEW-B.
import { describe, expect, test } from "bun:test";
import { ethers } from "ethers";
import { boot, type Body } from "../rig.ts";

type World = Awaited<ReturnType<typeof boot>>;
const skippedOf = (w: World): { op: bigint; reason: bigint }[] =>
  (w.last.events as { name: string; args: Record<string, unknown> }[]).filter((e) => e.name === "DisputeOpSkipped").map((e) => ({ op: BigInt(e.args["op"] as bigint), reason: BigInt(e.args["reason"] as bigint) }));
const COUNTER_NOT_NEWER = { op: 1n, reason: 5n };

const implicit = (tokenIds: readonly number[] = [1]): Body => ({
  watchSeed: ethers.ZeroHash, leftResponseSeconds: 60, rightResponseSeconds: 60, offdeltas: tokenIds.map(() => 0n), tokenIds: [...tokenIds],
});
const withdraw = (tokenId: number, amount: bigint) => [{ tokenId, leftDiff: amount, rightDiff: 0n, collateralDiff: -amount, ondeltaDiff: -amount }];

/** Epoch 0: fund (Left 100 collateral, ondelta 100); epoch 1 by a co-signed settlement at nonce 5 (Left withdraws 10): collateral 90, ondelta 90, reserves L 910 R 1000. */
const epochOne = async (label: string) => {
  const w = await boot(label);
  await w.fundedAccount();
  const e0 = await w.epochOf();
  const first = withdraw(w.TOKEN, 10n);
  expect(await w.settle(w.L, w.R, 5, first, w.coopSig(w.R, e0, 5, first))).toBe("ok");
  const e1 = await w.epochOf();
  return { w, e0, e1 };
};

describe("REVIEW-B: a Runtime that follows the rule (first signed proof of an epoch at stored + 2)", () => {
  test("REVIEW-B: open, pay, new epoch, pay, dispute on the implicit baseline, counter at +2..+4 inside the window: both sides get what the last frame says, twice in a row", async () => {
    const { w, e1 } = await epochOne("rb-honest");
    const { L, R } = w;
    // Epoch 1 frames, stored nonce 5, implicit at 6, Runtime signs from 7: Left pays -20 (7), Right pays back +5 (8, Right-authored), Left pays -50 total (9).
    const P7 = w.body(-20n), P8 = w.body(-15n), P9 = w.body(-50n);
    // Left (the side that owes) starts from the implicit proof: Delta = ondelta = 90, best for it.
    expect(await w.start(L, R, 6, false, implicit(), "0x", e1)).toBe("ok");
    w.at(30);
    // Right registers the newest frame it holds, signed by Left: Left-authored at 9.
    expect(await w.counter(R, L, { nonce: 6, body: implicit() }, { nonce: 9, proposerIsLeft: true, body: P9, sig: w.proofSig(L, e1, 9, true, P9) })).toBe("ok");
    expect(skippedOf(w)).toEqual([]);
    // An older frame (Right-authored 8, signed by Left) is refused as not newer and does not displace it.
    expect(await w.counter(R, L, { nonce: 6, body: implicit() }, { nonce: 8, proposerIsLeft: false, body: P8, sig: w.proofSig(L, e1, 8, false, P8) })).toBe("ok");
    expect(skippedOf(w).length).toBe(1);
    w.at(200);
    expect(await w.finalize(R, L, { nonce: 6, body: implicit(), startedByLeft: true }, { nonce: 9, proposerIsLeft: true, body: P9, sig: "0x" })).toBe("ok");
    // Delta = 90 - 50 = 40: Left 910 + 40, Right 1000 + 50. Nothing is lost against the frame both signed.
    expect(await w.reserves()).toEqual({ L: 950n, R: 1050n, collateral: 0n, nonce: 9n });
    // The next epoch: stored nonce is now 9 (a counter adopts its own nonce), so the implicit proof is 10 and the Runtime signs from 11.
    const e2 = await w.epochOf();
    expect(e2).toBe(e1 + 1n);
    expect(await w.start(R, L, 10, false, implicit(), "0x", e2)).toBe("ok");
    w.at(400);
    expect(await w.finalize(L, R, { nonce: 10, body: implicit(), startedByLeft: false }, { nonce: 10, proposerIsLeft: false, body: implicit(), sig: "0x" })).toBe("ok");
    // No collateral left: nothing moves, the stored nonce is 11 (a timeout finalize adds 1), the Runtime of the next epoch signs from 13.
    expect(await w.reserves()).toEqual({ L: 950n, R: 1050n, collateral: 0n, nonce: 11n });
  });

  test("REVIEW-B: the non-starter closes at once with the newest signed frame, no counter registered, pull-free", async () => {
    const { w, e1 } = await epochOne("rb-immediate");
    const { L, R } = w;
    expect(await w.start(L, R, 6, false, implicit(), "0x", e1)).toBe("ok");
    const P7 = w.body(-30n);
    w.at(5);
    expect(await w.finalize(R, L, { nonce: 6, body: implicit(), startedByLeft: true }, { nonce: 7, proposerIsLeft: true, body: P7, sig: w.proofSig(L, e1, 7, true, P7) })).toBe("ok");
    expect(await w.reserves()).toEqual({ L: 970n, R: 1030n, collateral: 0n, nonce: 7n });
  });

  test("REVIEW-B: the starter cannot close an implicit dispute before the window, nor counter its own dispute", async () => {
    const { w, e1 } = await epochOne("rb-starter");
    const { L, R } = w;
    expect(await w.start(L, R, 6, false, implicit(), "0x", e1)).toBe("ok");
    const P7 = w.body(-30n);
    w.at(5);
    // The starter holding the other side's signature on a newer frame is refused (immediate close is the non-starter's).
    expect(await w.finalize(L, R, { nonce: 6, body: implicit(), startedByLeft: true }, { nonce: 7, proposerIsLeft: false, body: P7, sig: w.proofSig(R, e1, 7, false, P7) })).toMatch(/^REVERT/);
    expect(await w.counter(L, R, { nonce: 6, body: implicit() }, { nonce: 7, proposerIsLeft: false, body: P7, sig: w.proofSig(R, e1, 7, false, P7) })).toMatch(/^REVERT/);
    expect(await w.finalize(L, R, { nonce: 6, body: implicit(), startedByLeft: true }, { nonce: 6, proposerIsLeft: false, body: implicit(), sig: "0x" })).toMatch(/^REVERT/);
  });

  test("REVIEW-B: a starter that names no token closes nothing but still advances the epoch and the stored nonce (the price of a missed window)", async () => {
    const { w, e1 } = await epochOne("rb-notokens");
    const { L, R } = w;
    const none: Body = { watchSeed: ethers.ZeroHash, leftResponseSeconds: 60, rightResponseSeconds: 60, offdeltas: [], tokenIds: [] };
    expect(await w.start(R, L, 6, false, none, "0x", e1)).toBe("ok");
    w.at(200);
    expect(await w.finalize(L, R, { nonce: 6, body: none, startedByLeft: false }, { nonce: 6, proposerIsLeft: false, body: none, sig: "0x" })).toBe("ok");
    // Collateral and ondelta of the unnamed token stay; the epoch moved.
    expect(await w.reserves()).toEqual({ L: 910n, R: 1000n, collateral: 90n, nonce: 7n });
    expect(await w.epochOf()).toBe(e1 + 1n);
    // The next implicit proof is nonce 8 and again settles at ondelta 90.
    expect(await w.start(L, R, 8, false, implicit(), "0x", e1 + 1n)).toBe("ok");
    w.at(400);
    expect(await w.finalize(R, L, { nonce: 8, body: implicit(), startedByLeft: true }, { nonce: 8, proposerIsLeft: false, body: implicit(), sig: "0x" })).toBe("ok");
    expect(await w.reserves()).toEqual({ L: 1000n, R: 1000n, collateral: 0n, nonce: 9n });
  });

  test("REVIEW-B: a deposit inside the epoch keeps the epoch, and the implicit proof settles at the new ondelta", async () => {
    const { w, e1 } = await epochOne("rb-deposit");
    const { L, R } = w;
    expect(await w.submit(L, { reserveToCollateral: [{ tokenId: w.TOKEN, receivingEntity: L.id, pairs: [{ entity: R.id, amount: 50n }] }] })).toBe("ok");
    expect(await w.epochOf()).toBe(e1);
    // A frame signed before the deposit (offdelta -30) is still valid evidence, and applies to the new ondelta 140.
    const P7 = w.body(-30n);
    expect(await w.start(L, R, 6, false, implicit(), "0x", e1)).toBe("ok");
    w.at(20);
    expect(await w.counter(R, L, { nonce: 6, body: implicit() }, { nonce: 7, proposerIsLeft: true, body: P7, sig: w.proofSig(L, e1, 7, true, P7) })).toBe("ok");
    w.at(200);
    expect(await w.finalize(L, R, { nonce: 6, body: implicit(), startedByLeft: true }, { nonce: 7, proposerIsLeft: true, body: P7, sig: "0x" })).toBe("ok");
    // collateral 140, Delta = 140 - 30 = 110: Left 860 + 110, Right 1000 + 30.
    expect(await w.reserves()).toEqual({ L: 970n, R: 1030n, collateral: 0n, nonce: 7n });
  });
});

describe("REVIEW-B: the traps", () => {
  test("REVIEW-B R-IMPLICIT-NONCE-FROM-CHAIN: TRAP a Right-authored signed frame at stored + 1 cannot outrank the implicit proof: the payee of that frame loses it", async () => {
    const { w, e1 } = await epochOne("rb-trap-right");
    const { L, R } = w;
    // Right (the payer) signed the first frame of the epoch at stored + 1 = 6 and proposed it: Right owes Left 40 more (offdelta +40), Left holds Right's signature.
    const P6 = w.body(40n);
    // Right starts from the implicit proof (Delta 90 = Right pays no extra).
    expect(await w.start(R, L, 6, false, implicit(), "0x", e1)).toBe("ok");
    w.at(20);
    expect(await w.counter(L, R, { nonce: 6, body: implicit() }, { nonce: 6, proposerIsLeft: false, body: P6, sig: w.proofSig(R, e1, 6, false, P6) })).toBe("ok");
    expect(skippedOf(w)).toEqual([COUNTER_NOT_NEWER]);
    // The immediate close is refused as well.
    expect(await w.finalize(L, R, { nonce: 6, body: implicit(), startedByLeft: false }, { nonce: 6, proposerIsLeft: false, body: P6, sig: w.proofSig(R, e1, 6, false, P6) })).toMatch(/^REVERT/);
    w.at(200);
    expect(await w.finalize(L, R, { nonce: 6, body: implicit(), startedByLeft: false }, { nonce: 6, proposerIsLeft: false, body: implicit(), sig: "0x" })).toBe("ok");
    // Left's 40 is gone: Delta = ondelta = 90, Left 910 + 90, Right 1000 + 0.
    expect(await w.reserves()).toEqual({ L: 1000n, R: 1000n, collateral: 0n, nonce: 7n });
  });

  test("REVIEW-B R-IMPLICIT-NONCE-FROM-CHAIN: the same frame at stored + 2 is safe (the Runtime rule)", async () => {
    const { w, e1 } = await epochOne("rb-rule-right");
    const { L, R } = w;
    const P7 = w.body(40n);
    expect(await w.start(R, L, 6, false, implicit(), "0x", e1)).toBe("ok");
    w.at(20);
    expect(await w.counter(L, R, { nonce: 6, body: implicit() }, { nonce: 7, proposerIsLeft: false, body: P7, sig: w.proofSig(R, e1, 7, false, P7) })).toBe("ok");
    expect(skippedOf(w)).toEqual([]);
    w.at(200);
    expect(await w.finalize(L, R, { nonce: 6, body: implicit(), startedByLeft: false }, { nonce: 7, proposerIsLeft: false, body: P7, sig: "0x" })).toBe("ok");
    // Delta = 90 + 40 = 130 against collateral 90: Left takes all 90 and the 40 above is settled as Right's debt against its reserves (Right 1000 -> 960).
    const r = await w.reserves();
    expect(r.collateral).toBe(0n);
    expect(r.L).toBe(910n + 90n + 40n);
    expect(r.R).toBe(960n);
  });

  test("REVIEW-B R-IMPLICIT-NONCE-FROM-CHAIN: a Left-authored frame at stored + 1 does outrank it (so the trap is the Right author alone)", async () => {
    const { w, e1 } = await epochOne("rb-trap-left");
    const { L, R } = w;
    const P6 = w.body(-40n);
    expect(await w.start(L, R, 6, false, implicit(), "0x", e1)).toBe("ok");
    w.at(20);
    expect(await w.counter(R, L, { nonce: 6, body: implicit() }, { nonce: 6, proposerIsLeft: true, body: P6, sig: w.proofSig(L, e1, 6, true, P6) })).toBe("ok");
    expect(skippedOf(w)).toEqual([]);
  });

  test("REVIEW-B R-WINDOWS-NEVER-SHORTEN: TRAP a policy that lowers its windows inside an epoch: the stale start with the long windows cannot be answered (E9)", async () => {
    const w = await boot("rb-window-policy");
    const { L, R } = w;
    await w.fundedAccount();
    const e0 = await w.epochOf();
    const P3 = w.body(-10n, 3600);
    expect(await w.start(R, L, 3, true, P3, w.proofSig(L, e0, 3, true, P3))).toBe("ok");
    const P5 = w.body(-30n, 600);
    w.at(20);
    expect(await w.counter(L, R, { nonce: 3, body: P3 }, { nonce: 5, proposerIsLeft: false, body: P5, sig: w.proofSig(R, e0, 5, false, P5) })).toBe("REVERT E9()");
    expect(await w.finalize(L, R, { nonce: 3, body: P3, startedByLeft: false }, { nonce: 5, proposerIsLeft: false, body: P5, sig: w.proofSig(R, e0, 5, false, P5) })).toBe("REVERT E9()");
  });

  test("REVIEW-B R-WINDOWS-NEVER-SHORTEN: the survivor of the author's mutation run is not equivalent: the immediate-close path (a signed final body, no registered counter) is guarded by the FINAL window check alone", async () => {
    const w = await boot("rb-final-window");
    const { L, R } = w;
    await w.fundedAccount();
    const e0 = await w.epochOf();
    const P3 = w.body(-10n, 300);
    expect(await w.start(R, L, 3, true, P3, w.proofSig(L, e0, 3, true, P3))).toBe("ok");
    w.at(5);
    const short = w.body(-30n, 60), same = w.body(-30n, 300), shortLeftOnly = w.body(-30n, 60, 300), shortRightOnly = w.body(-30n, 300, 60);
    // No counter was registered (selectedNonce 0), so the final check is the only guard against a shortened window.
    expect(await w.finalize(L, R, { nonce: 3, body: P3, startedByLeft: false }, { nonce: 5, proposerIsLeft: false, body: short, sig: w.proofSig(R, e0, 5, false, short) })).toBe("REVERT E9()");
    expect(await w.finalize(L, R, { nonce: 3, body: P3, startedByLeft: false }, { nonce: 5, proposerIsLeft: false, body: shortLeftOnly, sig: w.proofSig(R, e0, 5, false, shortLeftOnly) })).toBe("REVERT E9()");
    expect(await w.finalize(L, R, { nonce: 3, body: P3, startedByLeft: false }, { nonce: 5, proposerIsLeft: false, body: shortRightOnly, sig: w.proofSig(R, e0, 5, false, shortRightOnly) })).toBe("REVERT E9()");
    expect(await w.finalize(L, R, { nonce: 3, body: P3, startedByLeft: false }, { nonce: 5, proposerIsLeft: false, body: same, sig: w.proofSig(R, e0, 5, false, same) })).toBe("ok");
  });
});
