// Review A of PR 76 (R-IMPLICIT-BASELINE): attacks on the implicit proof, written by the reviewer. Every title starts `R-IMPLICIT-BASELINE:` so the register row can name them.
// Real Depository stack in BrowserVM. Run one file per process: `bun test test/vm/disputes/implicit-baseline-review-a.test.ts`.
import { describe, expect, test } from "bun:test";
import { ethers } from "ethers";
import { boot, type Body } from "../rig.ts";

type World = Awaited<ReturnType<typeof boot>>;
const skippedOf = (w: World): { op: bigint; reason: bigint }[] =>
  (w.last.events as { name: string; args: Record<string, unknown> }[]).filter((e) => e.name === "DisputeOpSkipped").map((e) => ({ op: BigInt(e.args["op"] as bigint), reason: BigInt(e.args["reason"] as bigint) }));
const implicitBody = (tokenIds: readonly number[] = [1]): Body => ({
  watchSeed: ethers.ZeroHash, leftResponseSeconds: 60, rightResponseSeconds: 60, offdeltas: tokenIds.map(() => 0n), tokenIds: [...tokenIds],
});
const withdraw = (tokenId: number, amount: bigint) =>
  [{ tokenId, leftDiff: amount, rightDiff: 0n, collateralDiff: -amount, ondeltaDiff: -amount }];
const afterSettlement = async (label: string) => {
  const w = await boot(label);
  await w.fundedAccount();
  const e0 = await w.epochOf();
  const first = withdraw(w.TOKEN, 10n);
  expect(await w.settle(w.L, w.R, 5, first, w.coopSig(w.R, e0, 5, first))).toBe("ok");
  return { w, e0, e1: await w.epochOf() };
};

describe("R-IMPLICIT-BASELINE review A: the final body's windows (the survivor)", () => {
  // The author argues `<` on the FINAL window is equivalent because a finalize must match the registered body hash. That holds for the two branches that
  // compare a hash (a registered counter, the initial body at timeout). It does not hold for the third: the non-starter's immediate close with a fresh
  // signed body (sig non-empty, no counter registered). There the only thing tying the body to the dispute's clock is this check.
  test("R-IMPLICIT-BASELINE: an immediate close with a fresh signed body that SHORTENS a window is refused (E9), at each window on its own", async () => {
    const w = await boot("ra-final-short");
    const { L, R } = w;
    await w.fundedAccount();
    const e0 = await w.epochOf();
    const P3 = w.body(-10n, 300);
    expect(await w.start(R, L, 3, true, P3, w.proofSig(L, e0, 3, true, P3))).toBe("ok");
    w.at(20);
    // Left, the non-starter, closes at once with a newer body Right signed (nonce 5, Right-authored).
    const closeWith = (b: Body, nonce = 5) => w.finalize(L, R, { nonce: 3, body: P3, startedByLeft: false }, { nonce, proposerIsLeft: false, body: b, sig: w.proofSig(R, e0, nonce, false, b) });
    expect(await closeWith(w.body(-30n, 60))).toBe("REVERT E9()");
    expect(await closeWith(w.body(-30n, 60, 300))).toBe("REVERT E9()");
    expect(await closeWith(w.body(-30n, 300, 60))).toBe("REVERT E9()");
    // Its own windows, and longer ones, close.
    expect(await closeWith(w.body(-30n, 300))).toBe("ok");
    expect(await w.reserves()).toEqual({ L: 1000n - 100n + 70n, R: 1000n + 30n, collateral: 0n, nonce: 5n });
  });

  test("R-IMPLICIT-BASELINE: the same immediate close with a LONGER final body lands (windows may lengthen)", async () => {
    const w = await boot("ra-final-long");
    const { L, R } = w;
    await w.fundedAccount();
    const e0 = await w.epochOf();
    const P3 = w.body(-10n, 300);
    expect(await w.start(R, L, 3, true, P3, w.proofSig(L, e0, 3, true, P3))).toBe("ok");
    w.at(20);
    const P5 = w.body(-30n, 600);
    expect(await w.finalize(L, R, { nonce: 3, body: P3, startedByLeft: false }, { nonce: 5, proposerIsLeft: false, body: P5, sig: w.proofSig(R, e0, 5, false, P5) })).toBe("ok");
  });
});

describe("R-IMPLICIT-BASELINE review A: ranking and nonce races at stored + 1 and stored + 2", () => {
  test("R-IMPLICIT-BASELINE: the non-starter's IMMEDIATE close ranks like a counter: Left-authored at stored + 1 closes, Right-authored at stored + 1 does not", async () => {
    const { w, e1 } = await afterSettlement("ra-immediate-rank");
    const { L, R } = w;
    // Left starts from the implicit proof (authored by Right). Right is the non-starter; the evidence is signed by Left.
    expect(await w.start(L, R, 6, false, implicitBody(), "0x", e1)).toBe("ok");
    w.at(20);
    const P6 = w.body(-30n);
    const asFinal = (proposerIsLeft: boolean) => ({ nonce: 6, proposerIsLeft, body: P6, sig: w.proofSig(L, e1, 6, proposerIsLeft, P6) });
    // Right-authored at the same nonce ties the implicit proof: refused (E2), nothing closes.
    expect(await w.finalize(R, L, { nonce: 6, body: implicitBody(), startedByLeft: true }, asFinal(false))).toBe("REVERT E2()");
    // Left-authored outranks it and closes now, at Delta 90 - 30 = 60.
    expect(await w.finalize(R, L, { nonce: 6, body: implicitBody(), startedByLeft: true }, asFinal(true))).toBe("ok");
    expect(await w.reserves()).toEqual({ L: 970n, R: 1030n, collateral: 0n, nonce: 6n });
  });

  test("R-IMPLICIT-BASELINE: stored + 2 outranks the implicit proof at either author, through a counter and through an immediate close", async () => {
    for (const proposerIsLeft of [false, true]) {
      const { w, e1 } = await afterSettlement(`ra-plus2-${proposerIsLeft}`);
      const { L, R } = w;
      expect(await w.start(L, R, 6, false, implicitBody(), "0x", e1)).toBe("ok");
      const P7 = w.body(-30n);
      w.at(20);
      expect(await w.counter(R, L, { nonce: 6, body: implicitBody() }, { nonce: 7, proposerIsLeft, body: P7, sig: w.proofSig(L, e1, 7, proposerIsLeft, P7) })).toBe("ok");
      expect(skippedOf(w)).toEqual([]);
      w.at(200);
      expect(await w.finalize(R, L, { nonce: 6, body: implicitBody(), startedByLeft: true }, { nonce: 7, proposerIsLeft, body: P7, sig: "0x" })).toBe("ok");
      expect(await w.reserves()).toEqual({ L: 970n, R: 1030n, collateral: 0n, nonce: 7n });
    }
  });

  test("R-IMPLICIT-BASELINE: after a timeout close the next implicit start is at the NEW stored + 1, a Right-authored proof there only ties and the first signed proof is at the new stored + 2", async () => {
    const { w, e1 } = await afterSettlement("ra-after-timeout");
    const { L, R } = w;
    expect(await w.start(R, L, 6, false, implicitBody(), "0x", e1)).toBe("ok");
    w.at(200);
    expect(await w.finalize(R, L, { nonce: 6, body: implicitBody(), startedByLeft: false }, { nonce: 6, proposerIsLeft: false, body: implicitBody(), sig: "0x" })).toBe("ok");
    const e2 = await w.epochOf();
    expect(e2).toBe(e1 + 1n);
    const info = await w.chain.getAccountInfo(L.id, R.id);
    expect(info.nonce).toBe(7n);
    // The Runtime rule applied to THIS stored nonce: implicit at 8, the first signed proof at 9. A Right-authored signed proof at 8 would tie.
    w.at(210);
    expect(await w.start(L, R, 8, false, implicitBody(), "0x", e2)).toBe("ok");
    const P8 = w.body(-20n);
    w.at(215);
    expect(await w.counter(R, L, { nonce: 8, body: implicitBody() }, { nonce: 8, proposerIsLeft: false, body: P8, sig: w.proofSig(L, e2, 8, false, P8) })).toBe("ok");
    expect(skippedOf(w)).toEqual([{ op: 1n, reason: 5n }]);
    const P9 = w.body(-20n);
    expect(await w.counter(R, L, { nonce: 8, body: implicitBody() }, { nonce: 9, proposerIsLeft: false, body: P9, sig: w.proofSig(L, e2, 9, false, P9) })).toBe("ok");
    expect(skippedOf(w)).toEqual([]);
  });

  test("R-IMPLICIT-BASELINE: a counter at the implicit nonce with Left authorship replaces it, and a later Right-authored counter at stored + 2 replaces THAT (ordering of several counters)", async () => {
    const { w, e1 } = await afterSettlement("ra-counter-chain");
    const { L, R } = w;
    expect(await w.start(R, L, 6, false, implicitBody(), "0x", e1)).toBe("ok");
    const P6 = w.body(-5n), P7 = w.body(-40n);
    w.at(20);
    expect(await w.counter(L, R, { nonce: 6, body: implicitBody() }, { nonce: 6, proposerIsLeft: true, body: P6, sig: w.proofSig(R, e1, 6, true, P6) })).toBe("ok");
    expect(await w.counter(L, R, { nonce: 6, body: implicitBody() }, { nonce: 7, proposerIsLeft: false, body: P7, sig: w.proofSig(R, e1, 7, false, P7) })).toBe("ok");
    // The older counter cannot come back.
    expect(await w.counter(L, R, { nonce: 6, body: implicitBody() }, { nonce: 6, proposerIsLeft: true, body: P6, sig: w.proofSig(R, e1, 6, true, P6) })).toBe("ok");
    expect(skippedOf(w)).toEqual([{ op: 1n, reason: 6n }]);
    w.at(200);
    expect(await w.finalize(L, R, { nonce: 6, body: implicitBody(), startedByLeft: false }, { nonce: 7, proposerIsLeft: false, body: P7, sig: "0x" })).toBe("ok");
    expect(await w.reserves()).toEqual({ L: 960n, R: 1040n, collateral: 0n, nonce: 7n });
  });
});

describe("R-IMPLICIT-BASELINE review A: skips come first, strangers and what the starter names", () => {
  test("R-IMPLICIT-BASELINE: every NON-canonical unsigned start on a stale epoch, a stale nonce or an open dispute is SKIPPED, never reverted", async () => {
    const { w, e0, e1 } = await afterSettlement("ra-skip-first");
    const { L, R } = w;
    const junk: Body = { ...implicitBody(), leftResponseSeconds: 61, offdeltas: [5n] };
    expect(await w.start(R, L, 6, true, junk, "0x", e0)).toBe("ok");
    expect(skippedOf(w)).toEqual([{ op: 0n, reason: 11n }]);
    expect(await w.start(R, L, 5, true, junk, "0x", e1)).toBe("ok");
    expect(skippedOf(w)).toEqual([{ op: 0n, reason: 0n }]);
    expect(await w.start(R, L, 6, false, implicitBody(), "0x", e1)).toBe("ok");
    expect(await w.start(L, R, 9, true, junk, "0x", e1)).toBe("ok");
    expect(skippedOf(w)).toEqual([{ op: 0n, reason: 1n }]);
  });

  test("R-IMPLICIT-BASELINE: a stranger with no co-signed history (epoch 0) cannot open a dispute against any entity, funded or not", async () => {
    const w = await boot("ra-stranger");
    const { L, R } = w;
    expect(await w.epochOf()).toBe(0n);
    expect(await w.start(R, L, 1, false, implicitBody(), "0x", 0n)).toBe("REVERT NotTheImplicitBaseline()");
    await w.fundedAccount();
    expect(await w.start(L, R, 1, false, implicitBody(), "0x", 0n)).toBe("REVERT NotTheImplicitBaseline()");
    expect(await w.start(R, L, 2, false, implicitBody(), "0x", 0n)).toBe("REVERT NotTheImplicitBaseline()");
  });

  test("R-IMPLICIT-BASELINE: an implicit start that names NO token, or a subset, settles only what it names and still ends the epoch", async () => {
    const w = await boot("ra-tokens");
    const { L, R } = w;
    await w.fundedAccount();
    await w.chain.debugFundReserves(L.id, 2, 1000n);
    await w.chain.debugFundReserves(R.id, 2, 1000n);
    expect(await w.submit(L, { reserveToCollateral: [{ tokenId: 2, receivingEntity: L.id, pairs: [{ entity: R.id, amount: 40n }] }] })).toBe("ok");
    const e0 = await w.epochOf();
    const first = withdraw(w.TOKEN, 10n);
    expect(await w.settle(L, R, 5, first, w.coopSig(R, e0, 5, first))).toBe("ok");
    const e1 = await w.epochOf();
    // Right names no token at all: nothing pays out, but the epoch advances once it times out.
    const none = implicitBody([]);
    expect(await w.start(R, L, 6, false, none, "0x", e1)).toBe("ok");
    w.at(200);
    expect(await w.finalize(R, L, { nonce: 6, body: none, startedByLeft: false }, { nonce: 6, proposerIsLeft: false, body: none, sig: "0x" })).toBe("ok");
    expect(await w.reserves()).toEqual({ L: 910n, R: 1000n, collateral: 90n, nonce: 7n });
    expect(await w.chain.getCollateral(L.id, R.id, 2)).toBe(40n);
    expect(await w.epochOf()).toBe(e1 + 1n);
    // A later implicit start names token 2 and pays it out; token 1 keeps its collateral until some other dispute or update.
    const e2 = await w.epochOf();
    w.at(210);
    const two = implicitBody([2]);
    expect(await w.start(R, L, 8, false, two, "0x", e2)).toBe("ok");
    w.at(400);
    expect(await w.finalize(R, L, { nonce: 8, body: two, startedByLeft: false }, { nonce: 8, proposerIsLeft: false, body: two, sig: "0x" })).toBe("ok");
    expect(await w.chain.getCollateral(L.id, R.id, 2)).toBe(0n);
    expect(await w.chain.getCollateral(L.id, R.id, 1)).toBe(90n);
  });

  test("R-IMPLICIT-BASELINE: the implicit proof cannot be replayed into a later epoch (its start is skipped once the Account has moved)", async () => {
    const { w, e1 } = await afterSettlement("ra-replay");
    const { L, R } = w;
    expect(await w.start(R, L, 6, false, implicitBody(), "0x", e1)).toBe("ok");
    w.at(200);
    expect(await w.finalize(R, L, { nonce: 6, body: implicitBody(), startedByLeft: false }, { nonce: 6, proposerIsLeft: false, body: implicitBody(), sig: "0x" })).toBe("ok");
    // The very same start again: the nonce is judged before the epoch, and it is at most the stored nonce (7), so reason 0 at either epoch.
    expect(await w.start(R, L, 6, false, implicitBody(), "0x", e1)).toBe("ok");
    expect(skippedOf(w)).toEqual([{ op: 0n, reason: 0n }]);
    expect(await w.start(R, L, 6, false, implicitBody(), "0x", e1 + 1n)).toBe("ok");
    expect(skippedOf(w)).toEqual([{ op: 0n, reason: 0n }]);
  });
});

describe("R-IMPLICIT-BASELINE review A: only an EMPTY signature is the unsigned path", () => {
  test("R-IMPLICIT-BASELINE: a canonical body with a non-empty signature that does not verify reverts at every length (1, 32, 64, 65 bytes), never taken as the implicit proof", async () => {
    const { w, e1 } = await afterSettlement("ra-garbage-sig");
    const { L, R } = w;
    const tries: Record<string, string> = {};
    for (const n of [1, 32, 64, 65]) tries[`len${n}`] = await w.start(R, L, 6, false, implicitBody(), ethers.hexlify(new Uint8Array(n).fill(1)), e1);
    // Short garbage reverts inside the verifier with no reason (as on main); a 65-byte one is E4. None opens.
    expect(tries).toEqual({ len1: "REVERT 0x", len32: "REVERT 0x", len64: "REVERT 0x", len65: "REVERT E4()" });
    // A genuine Left signature over the implicit body (Left signs Right-authored proof) is not the unsigned path either: it is checked as a signature, and it passes.
    expect(await w.start(R, L, 6, false, implicitBody(), w.proofSig(L, e1, 6, false, implicitBody()), e1)).toBe("ok");
  });

  test("R-IMPLICIT-BASELINE: every token of the body is held to offdelta 0 (a nonzero in the middle of three is refused)", async () => {
    const { w, e1 } = await afterSettlement("ra-middle-offdelta");
    const { L, R } = w;
    const three = (mid: bigint): Body => ({ ...implicitBody([1, 2, 3]), offdeltas: [0n, mid, 0n] });
    expect(await w.start(R, L, 6, false, three(1n), "0x", e1)).toBe("REVERT NotTheImplicitBaseline()");
    expect(await w.start(R, L, 6, false, three(-1n), "0x", e1)).toBe("REVERT NotTheImplicitBaseline()");
    expect(await w.start(R, L, 6, false, { ...three(0n), offdeltas: [0n, 0n, 1n] }, "0x", e1)).toBe("REVERT NotTheImplicitBaseline()");
    expect(await w.start(R, L, 6, false, three(0n), "0x", e1)).toBe("ok");
  });
});

describe("R-IMPLICIT-BASELINE review A: the window arithmetic of an implicit start", () => {
  // timeout = start + left + right = start + 120 s at the testnet floor. The implicit start takes the floor for BOTH windows, whatever policy the signed frames of the account carry.
  test("R-IMPLICIT-BASELINE: the non-starter has exactly 2 x floor to counter (119 s lands, 120 s is skipped), and the starter cannot finalize before it", async () => {
    const land = async (seconds: number): Promise<{ skipped: { op: bigint; reason: bigint }[]; closeEarly: string }> => {
      const { w, e1 } = await afterSettlement(`ra-window-${seconds}`);
      const { L, R } = w;
      expect(await w.start(L, R, 6, false, implicitBody(), "0x", e1)).toBe("ok");
      const P7 = w.body(-30n, 300);
      w.at(seconds);
      const closeEarly = await w.finalize(L, R, { nonce: 6, body: implicitBody(), startedByLeft: true }, { nonce: 6, proposerIsLeft: false, body: implicitBody(), sig: "0x" });
      expect(await w.counter(R, L, { nonce: 6, body: implicitBody() }, { nonce: 7, proposerIsLeft: true, body: P7, sig: w.proofSig(L, e1, 7, true, P7) })).toBe("ok");
      return { skipped: skippedOf(w), closeEarly };
    };
    const inside = await land(119);
    expect(inside.skipped).toEqual([]);
    expect(inside.closeEarly).toMatch(/^REVERT/);
    const outside = await land(120);
    expect(outside.skipped.map((x) => x.op)).toEqual([1n]);
    // and at 120 s the starter can close on its own (the implicit proof settles).
    expect(outside.closeEarly).toBe("ok");
  });
});

describe("R-IMPLICIT-BASELINE review A: an implicit dispute is never graded as retired-board evidence (H3)", () => {
  // H3 clamps a shortfall against a side whose RETIRED board signed the proof that settles. An implicit proof has no signature, so no side is retired and a debtor's reserves
  // pay the shortfall in full. A contract that stamped retiredSide on it would let a debtor escape the debt by the route the implicit proof opens.
  test("R-IMPLICIT-BASELINE: Delta = ondelta above the collateral (Right took more than its share) is paid from RIGHT's reserves, in full, by an implicit dispute started by either side", async () => {
    for (const starterIsLeft of [true, false]) {
      const w = await boot(`ra-h3-right-${starterIsLeft}`);
      const { L, R } = w;
      await w.fundedAccount();
      const e0 = await w.epochOf();
      const diffs = [{ tokenId: w.TOKEN, leftDiff: 0n, rightDiff: 30n, collateralDiff: -30n, ondeltaDiff: 0n }];
      expect(await w.settle(L, R, 5, diffs, w.coopSig(R, e0, 5, diffs))).toBe("ok");
      const e1 = await w.epochOf();
      expect(await w.reserves()).toEqual({ L: 900n, R: 1030n, collateral: 70n, nonce: 5n });
      const [starter, other] = starterIsLeft ? [L, R] : [R, L];
      expect(await w.start(starter, other, 6, false, implicitBody(), "0x", e1)).toBe("ok");
      w.at(200);
      expect(await w.finalize(starter, other, { nonce: 6, body: implicitBody(), startedByLeft: starterIsLeft }, { nonce: 6, proposerIsLeft: false, body: implicitBody(), sig: "0x" })).toBe("ok");
      // Delta 100: Left takes the 70 of collateral and the 30 Right owes out of its reserves.
      expect(await w.reserves()).toEqual({ L: 1000n, R: 1000n, collateral: 0n, nonce: 7n });
    }
  });

  test("R-IMPLICIT-BASELINE: Delta = ondelta below zero (Left took more than its claim) is paid from LEFT's reserves, in full", async () => {
    const w = await boot("ra-h3-left");
    const { L, R } = w;
    await w.fundedAccount();
    expect(await w.submit(R, { reserveToCollateral: [{ tokenId: w.TOKEN, receivingEntity: R.id, pairs: [{ entity: L.id, amount: 50n }] }] })).toBe("ok");
    const e0 = await w.epochOf();
    const diffs = [{ tokenId: w.TOKEN, leftDiff: 120n, rightDiff: 0n, collateralDiff: -120n, ondeltaDiff: -120n }];
    expect(await w.settle(L, R, 5, diffs, w.coopSig(R, e0, 5, diffs))).toBe("ok");
    const e1 = await w.epochOf();
    expect(await w.reserves()).toEqual({ L: 1020n, R: 950n, collateral: 30n, nonce: 5n });
    expect(await w.start(R, L, 6, false, implicitBody(), "0x", e1)).toBe("ok");
    w.at(200);
    expect(await w.finalize(R, L, { nonce: 6, body: implicitBody(), startedByLeft: false }, { nonce: 6, proposerIsLeft: false, body: implicitBody(), sig: "0x" })).toBe("ok");
    // Delta -20: Right takes the 30 of collateral and the 20 Left owes out of its reserves.
    expect(await w.reserves()).toEqual({ L: 1000n, R: 1000n, collateral: 0n, nonce: 7n });
  });
});
