// H3 (contracts-decisions.md): a retired board keeps seven days of dispute evidence, and a leaked retired quorum could
// sign an unbounded debt against the reserves of the entity it once controlled. Decided: evidence signed by a retired
// board still counts, but a dispute that settles on it cannot make the RETIRED side pay from reserves: retired Left is
// clamped at Δ ≥ 0, retired Right at Δ ≤ collateral. The direction in which the retired entity is OWED is never clamped,
// or a debtor could forgive its own debt by racing the rotation. Real Depository and EntityProvider in BrowserVM.
//
// X is the entity that rotates (numbered). Y is its counterparty. Numbered entities get ascending ids, so registering Y
// first makes Y Left and X Right; a lazy Y has a hash id and is always Right, so X is Left.
import { describe, expect, test } from "bun:test";
import { boardOf, boot, party, type Party } from "./rig.ts";

const world = async (label: string, xIsRight = false) => {
  const w = await boot(label);
  const other: Party = xIsRight ? await w.registerNumbered(`${label}-y`) : party(`${label}-y`);
  const oldBoard = await w.registerNumbered(`${label}-old`);
  const account = w.accountOf(oldBoard, other, label);
  expect(account.L.id === oldBoard.id).toBe(!xIsRight);
  await account.fundedAccount();                               // 1000 reserves each, Left puts 100 in collateral
  const newBoard = boardOf(`${label}-new`, oldBoard.id);
  const rotatedAt = await w.rotateBoard(oldBoard, newBoard);
  const epoch = await account.epochOf();
  const xIsLeft = account.L.id === oldBoard.id;
  const body = (offdelta: bigint) => account.body(offdelta);
  /** Y opens with a proof against X signed by `signer`, waits both windows, then times its own dispute out. */
  const yStarts = async (signer: Party, offdelta: bigint) => {
    const b = body(offdelta);
    w.at(rotatedAt + 10);
    const started = await w.start(other, oldBoard, 1, xIsLeft, b, account.proofSig(signer, epoch, 1, xIsLeft, b));
    w.at(rotatedAt + 140);
    const finalized = await w.finalize(other, oldBoard, { nonce: 1, body: b, startedByLeft: !xIsLeft }, { nonce: 1, proposerIsLeft: xIsLeft, body: b, sig: "0x" });
    const r = await account.reserves();
    return { started, finalized, X: xIsLeft ? r.L : r.R, Y: xIsLeft ? r.R : r.L, collateral: r.collateral };
  };
  /** X opens with Y's own proof, signed by Y (never rotated), and times its own dispute out. */
  const xStarts = async (offdelta: bigint) => {
    const b = body(offdelta);
    w.at(rotatedAt + 10);
    const started = await w.start(newBoard, other, 1, !xIsLeft, b, account.proofSig(other, epoch, 1, !xIsLeft, b));
    w.at(rotatedAt + 140);
    const finalized = await w.finalize(newBoard, other, { nonce: 1, body: b, startedByLeft: xIsLeft }, { nonce: 1, proposerIsLeft: !xIsLeft, body: b, sig: "0x" });
    const r = await account.reserves();
    return { started, finalized, X: xIsLeft ? r.L : r.R, Y: xIsLeft ? r.R : r.L };
  };
  return { w, oldBoard, newBoard, other, account, rotatedAt, epoch, xIsLeft, yStarts, xStarts };
};

// Reserves after funding: Left holds 900 (100 went to collateral), Right 1000. Numbers below are X's and Y's final reserves.
describe("H3 a retired board cannot be made to pay from reserves, and is never denied what it is owed", () => {
  test("X is Left: a leaked retired quorum owing 500 pays only the collateral, reserves untouched", async () => {
    const { oldBoard, yStarts } = await world("h3-drain-left");
    const end = await yStarts(oldBoard, -500n);   // Δ = 100 − 500 = −400: Left X would owe Y 400 beyond collateral
    expect(end).toEqual({ started: "ok", finalized: "ok", X: 900n, Y: 1100n, collateral: 0n });
  });

  test("X is Right: a leaked retired quorum owing 500 pays only the collateral, reserves untouched", async () => {
    const { oldBoard, yStarts } = await world("h3-drain-right", true);
    const end = await yStarts(oldBoard, 500n);    // Y is Left with 100 collateral; Δ = 600: Right X would owe 500 beyond it
    expect(end).toEqual({ started: "ok", finalized: "ok", X: 1000n, Y: 1000n, collateral: 0n });
  });

  test("X is Left and is OWED 500: Y cannot forgive it by presenting X's old board, X is paid in full", async () => {
    const { oldBoard, yStarts } = await world("h3-owed-left");
    const end = await yStarts(oldBoard, 500n);    // Δ = 600: Right Y owes Left X 500 beyond the collateral
    expect({ finalized: end.finalized, X: end.X, Y: end.Y }).toEqual({ finalized: "ok", X: 1500n, Y: 500n });
  });

  test("X is Right and is OWED 400: Y cannot forgive it by presenting X's old board, X is paid in full", async () => {
    const { oldBoard, yStarts } = await world("h3-owed-right", true);
    const end = await yStarts(oldBoard, -500n);   // Y is Left with 100 collateral; Δ = −400: Left Y owes Right X 400
    expect({ finalized: end.finalized, X: end.X, Y: end.Y }).toEqual({ finalized: "ok", X: 1500n, Y: 500n });
  });

  test("the race has one answer: X starting first with Y's own signature settles the same as Y presenting X's old board", async () => {
    const { xStarts } = await world("h3-x-first");
    expect(await xStarts(500n)).toEqual({ started: "ok", finalized: "ok", X: 1500n, Y: 500n });
  });

  test("the same proof signed by the current board settles in full", async () => {
    const { newBoard, yStarts } = await world("h3-current");
    const end = await yStarts(newBoard, -500n);
    expect({ started: end.started, finalized: end.finalized, X: end.X, Y: end.Y }).toEqual({ started: "ok", finalized: "ok", X: 500n, Y: 1500n });
  });

  test("retired evidence inside the collateral is honoured exactly: X owes Y 30, Y gets 30", async () => {
    const { oldBoard, yStarts } = await world("h3-inside");
    const end = await yStarts(oldBoard, -30n);    // Δ = 70: X gets 70 of the 100 back, Y gets 30
    expect({ finalized: end.finalized, X: end.X, Y: end.Y }).toEqual({ finalized: "ok", X: 970n, Y: 1030n });
  });

  test("a current-board counter-proof replaces the grade: it settles in full even though the start proof was retired", async () => {
    const { w, oldBoard, newBoard, other, account, rotatedAt, epoch } = await world("h3-counter");
    const startBody = account.body(-500n);
    w.at(rotatedAt + 10);
    expect(await w.start(other, oldBoard, 1, true, startBody, account.proofSig(oldBoard, epoch, 1, true, startBody))).toBe("ok");
    // X answers before T with a newer state that Y (lazy, never rotated) signed itself.
    const counterBody = account.body(-501n);
    w.at(rotatedAt + 20);
    expect(await w.counter(newBoard, other, { nonce: 1, body: startBody },
      { nonce: 2, proposerIsLeft: false, body: counterBody, sig: account.proofSig(other, epoch, 2, false, counterBody) })).toBe("ok");
    w.at(rotatedAt + 140);
    expect(await w.finalize(other, oldBoard, { nonce: 1, body: startBody, startedByLeft: false },
      { nonce: 2, proposerIsLeft: false, body: counterBody, sig: "0x" })).toBe("ok");
    const end = await account.reserves();
    expect({ X: end.L, Y: end.R }).toEqual({ X: 499n, Y: 1501n }); // Δ = 100 − 501 = −401, settled in full
  });

  // X (Left, rotated) starts with Y's proof; Y answers at nonce 2 with a body signed by X: first by the old board or the new
  // board, then the same body again by the other. The body has X owing 500 (Δ = −400), which a retired Left cannot be made to pay.
  const counterOrder = async (label: string, signers: readonly ("old" | "new")[]) => {
    const { w, oldBoard, newBoard, other, account, rotatedAt, epoch } = await world(label);
    const first = account.body(0n), second = account.body(-500n);
    w.at(rotatedAt + 10);
    expect(await w.start(newBoard, other, 1, false, first, account.proofSig(other, epoch, 1, false, first))).toBe("ok");
    w.at(rotatedAt + 20);
    for (const which of signers) {
      const sig = account.proofSig(which === "old" ? oldBoard : newBoard, epoch, 2, true, second);
      expect(await w.counter(other, oldBoard, { nonce: 1, body: first }, { nonce: 2, proposerIsLeft: true, body: second, sig })).toBe("ok");
    }
    w.at(rotatedAt + 140);
    expect(await w.finalize(other, oldBoard, { nonce: 1, body: first, startedByLeft: true }, { nonce: 2, proposerIsLeft: true, body: second, sig: "0x" })).toBe("ok");
    const r = await account.reserves();
    return { X: r.L, Y: r.R };
  };

  test("a counter body graded retired is clamped: X's old board cannot make it pay from reserves", async () => {
    expect(await counterOrder("h3-counter-retired", ["old"])).toEqual({ X: 900n, Y: 1100n });
  });

  test("re-registering the same counter body with current-board evidence upgrades the grade, so it settles in full", async () => {
    expect(await counterOrder("h3-counter-upgrade", ["old", "new"])).toEqual({ X: 500n, Y: 1500n });
  });

  test("a later retired registration of the same body never downgrades a current grade", async () => {
    expect(await counterOrder("h3-counter-nodowngrade", ["new", "old"])).toEqual({ X: 500n, Y: 1500n });
  });
});
