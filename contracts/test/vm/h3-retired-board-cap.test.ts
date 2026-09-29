// H3 (contracts-decisions.md): a retired board keeps seven days of dispute evidence, and a leaked retired quorum could
// sign an unbounded debt against the reserves of the entity it once controlled. Decided: evidence signed by a retired
// board still counts, but the dispute then settles Δ clamped to [0, collateral]: no shortfall from reserves, no debt.
// Real Depository and EntityProvider in BrowserVM.
import { describe, expect, test } from "bun:test";
import { boardOf, boot, party } from "./rig.ts";

const world = async (label: string) => {
  const w = await boot(label);
  const oldBoard = await w.registerNumbered(`${label}-old`);   // X, numbered, so X's id is small and X is Left
  const other = party(`${label}-y`);                           // Y, lazy
  const account = w.accountOf(oldBoard, other, label);
  expect(account.L.id).toBe(oldBoard.id);
  await account.fundedAccount();                               // 1000 reserves each, Left (X) puts 100 in collateral
  const newBoard = boardOf(`${label}-new`, oldBoard.id);
  const rotatedAt = await w.rotateBoard(oldBoard, newBoard);
  const epoch = await account.epochOf();
  /** Y opens with a proof against X signed by `signer`, waits both windows, then times its own dispute out. */
  const dispute = async (signer: typeof oldBoard, offdelta: bigint) => {
    const body = account.body(offdelta);
    w.at(rotatedAt + 10);
    const started = await w.start(other, oldBoard, 1, true, body, account.proofSig(signer, epoch, 1, true, body));
    w.at(rotatedAt + 140);
    const finalized = await w.finalize(other, oldBoard, { nonce: 1, body, startedByLeft: false }, { nonce: 1, proposerIsLeft: true, body, sig: "0x" });
    return { started, finalized, ...(await account.reserves()) };
  };
  return { w, oldBoard, newBoard, other, account, rotatedAt, dispute };
};

describe("H3 retired-board evidence is capped at collateral", () => {
  test("a leaked retired quorum cannot drain reserves: X owes Y 500 on the retired key, Y gets only the collateral", async () => {
    const { oldBoard, dispute } = await world("h3-drain");
    const end = await dispute(oldBoard, -500n);   // Δ = 100 − 500 = −400: X would owe Y 400 beyond collateral
    expect({ started: end.started, finalized: end.finalized, X: end.L, Y: end.R, collateral: end.collateral })
      .toEqual({ started: "ok", finalized: "ok", X: 1000n - 100n, Y: 1000n + 100n, collateral: 0n });
  });

  test("the same proof signed by the current board settles in full", async () => {
    const { newBoard, dispute } = await world("h3-current");
    const end = await dispute(newBoard, -500n);
    expect({ started: end.started, finalized: end.finalized, X: end.L, Y: end.R })
      .toEqual({ started: "ok", finalized: "ok", X: 1000n - 100n - 400n, Y: 1000n + 100n + 400n });
  });

  test("retired evidence inside the collateral is honoured exactly: X owes Y 30, Y gets 30", async () => {
    const { oldBoard, dispute } = await world("h3-inside");
    const end = await dispute(oldBoard, -30n);    // Δ = 70: X gets 70 of the 100 back, Y gets 30
    expect({ finalized: end.finalized, X: end.L, Y: end.R }).toEqual({ finalized: "ok", X: 1000n - 100n + 70n, Y: 1000n + 30n });
  });

  test("retired evidence in the other direction is capped too: Y owes X, X gets the collateral back and no more", async () => {
    const { oldBoard, dispute } = await world("h3-other");
    const end = await dispute(oldBoard, 500n);    // Δ = 600: X would be owed 500 beyond its 100 collateral
    expect({ finalized: end.finalized, X: end.L, Y: end.R }).toEqual({ finalized: "ok", X: 1000n, Y: 1000n });
  });

  test("a counter-proof replaces the grade: a current-board counter settles in full even though the start proof was retired", async () => {
    const { w, oldBoard, newBoard, other, account, rotatedAt } = await world("h3-counter");
    const epoch = await account.epochOf();
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
});
