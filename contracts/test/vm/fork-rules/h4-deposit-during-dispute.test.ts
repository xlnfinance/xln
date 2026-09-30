// H4 (contracts-decisions.md), ACCEPTED as is: Account.processR2C has no dispute check, so a reserve-to-collateral
// deposit made while a dispute is open changes the collateral the dispute settles. It is harmless because a deposit
// only raises its own beneficiary's share: the receiver's ondelta rises by the deposit when the receiver is Left, and
// the collateral rises by the deposit either way, so at finalize the depositor takes back exactly what it put in and
// the other side's payout does not move. Real Depository in BrowserVM.
import { describe, expect, test } from "bun:test";
import { boot, party } from "../rig.ts";

/** Reserves after Right starts a dispute on Left's proof (Δ = 100 + offdelta), a deposit lands, and the timeout finalizes. */
const run = async (label: string, offdelta: bigint, deposit?: { by: "left" | "right"; amount: bigint }) => {
  const w = await boot(label);
  const account = w.accountOf(party(`${label}-a`), party(`${label}-b`), label);
  await account.fundedAccount();                                  // Left 900, Right 1000, collateral 100 (ondelta 100)
  const epoch = await account.epochOf();
  const b = account.body(offdelta);
  w.at(10);
  const started = await w.start(account.R, account.L, 1, true, b, account.proofSig(account.L, epoch, 1, true, b));
  w.at(20);
  const beneficiary = deposit?.by === "left" ? account.L : account.R;
  const other = deposit?.by === "left" ? account.R : account.L;
  const deposited = deposit === undefined ? "none" : await w.submit(beneficiary, {
    reserveToCollateral: [{ tokenId: w.TOKEN, receivingEntity: beneficiary.id, pairs: [{ entity: other.id, amount: deposit.amount }] }],
  });
  const during = await account.reserves();
  w.at(140);
  const finalized = await w.finalize(account.R, account.L, { nonce: 1, body: b, startedByLeft: false }, { nonce: 1, proposerIsLeft: true, body: b, sig: "0x" });
  const after = await account.reserves();
  return { started, deposited, finalized, during, L: after.L, R: after.R, collateral: after.collateral, epoch: await account.epochOf() };
};

describe("H4 a deposit during a dispute raises only the depositor's side", () => {
  test("baseline: with offdelta −30, Δ = 70, Left gets 70 of the collateral and Right 30", async () => {
    const end = await run("h4-base", -30n);
    expect({ started: end.started, finalized: end.finalized, L: end.L, R: end.R, collateral: end.collateral }).toEqual({ started: "ok", finalized: "ok", L: 970n, R: 1030n, collateral: 0n });
  });

  test("Left deposits 50 while the dispute is open: the deposit is accepted and Left takes back exactly 50 more, Right's payout is unchanged", async () => {
    const end = await run("h4-left", -30n, { by: "left", amount: 50n });
    expect(end.deposited).toBe("ok");
    expect(end.during.collateral).toBe(150n);                     // the deposit really changed what the dispute settles
    expect({ finalized: end.finalized, L: end.L, R: end.R, collateral: end.collateral }).toEqual({ finalized: "ok", L: 970n, R: 1030n, collateral: 0n });
  });

  test("Right deposits 30 while the dispute is open: Right takes back exactly 30 more, Left's payout is unchanged", async () => {
    const end = await run("h4-right", -30n, { by: "right", amount: 30n });
    expect(end.deposited).toBe("ok");
    expect(end.during.collateral).toBe(130n);
    expect({ finalized: end.finalized, L: end.L, R: end.R, collateral: end.collateral }).toEqual({ finalized: "ok", L: 970n, R: 1030n, collateral: 0n });
  });

  test("the deposit does not advance the epoch, so the proof that started the dispute stays valid", async () => {
    const end = await run("h4-epoch", -30n, { by: "left", amount: 50n });
    expect(end.finalized).toBe("ok");
    expect(end.epoch).toBe(1n);                                  // one advance, by the finalize itself (C1), not by R2C
  });
});
