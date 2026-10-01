// B1 / R-COSIGN (second review of J5, PR #54): the first reading of the E4 split said only the signer can put a bad signature into the
// bytes, so spending the nonce hurts nobody else. Wrong: the counterparty does not need to touch the bytes, it changes the state the
// signature was made against, and a relayer can change the gas (G1, j5-gas-stipend.test.ts). Here the counterparty R lands ONE unilateral
// dispute start on the shared Account after L signed a batch [payment, C2R co-signed by R]: the whole batch is a BatchFailed, the nonce is
// spent, and the unrelated payment never happens. The nonce burn is still the right price (the alternative is a stuck entity, S1); the
// rule that follows is for the runtime: a batch that carries a co-signed op carries only ops for that one Account (R-COSIGN).
// One file per process: `bun test contracts/test/vm/j5-cosign-veto.test.ts`.
import { describe, expect, test } from "bun:test";
import { ethers } from "ethers";
import { boot, party, signWith } from "../rig.ts";

const E6 = ethers.id("E6()").slice(0, 10); // a C2R against an Account with an open dispute

const world = async () => {
  const w = await boot("j5s-burn");
  await w.fundedAccount(); // L holds 100 of collateral (ondelta 100); L's reserve 900
  const sink = party("j5s-sink");
  const epoch = await w.epochOf();
  const amount = 10n;
  const diffs = [{ tokenId: w.TOKEN, leftDiff: amount, rightDiff: 0n, collateralDiff: -amount, ondeltaDiff: -amount }];
  const c2r = { counterparty: w.R.id, tokenId: w.TOKEN, amount, nonce: 1, sig: w.coopSig(w.R, epoch, 1, diffs) };
  const pay = { receivingEntity: sink.id, tokenId: w.TOKEN, amount: 50n };
  const events = (name: string) => (w.last.events as { name: string; args: Record<string, unknown> }[]).filter((e) => e.name === name);
  return { w, sink, epoch, c2r, pay, events };
};

describe("B1 the counterparty burns the entity's nonce, and the unrelated payment beside the C2R with it", () => {
  test("control: the batch [payment, co-signed C2R] lands when nothing moved", async () => {
    const { w, sink, c2r, pay } = await world();
    expect(await w.submit(w.L, { reserveToReserve: [pay], collateralToReserve: [c2r] })).toBe("ok");
    expect(await w.chain.getReserves(sink.id, w.TOKEN)).toBe(50n);
  });

  test("a dispute start by R on the Account first: L's whole batch is a BatchFailed and the nonce is spent", async () => {
    const { w, sink, epoch, c2r, pay, events } = await world();
    const body = w.accountOf(w.L, w.R, "j5s-burn").body(0n, 60);
    w.at(100);
    const acct = w.accountOf(w.L, w.R, "j5s-burn");
    expect(await w.start(w.R, w.L, 1, true, body, acct.proofSig(w.L, epoch, 1, true, body))).toBe("ok");
    const before = await w.chain.getEntityNonce(w.L.id);
    expect(await w.submit(w.L, { reserveToReserve: [pay], collateralToReserve: [c2r] })).toBe("ok");
    const failed = events("BatchFailed").map((e) => ({ nonce: BigInt(e.args["nonce"] as bigint), reason: String(e.args["reason"]) }));
    expect(failed).toEqual([{ nonce: before + 1n, reason: E6 }]);
    expect(await w.chain.getEntityNonce(w.L.id)).toBe(before + 1n);
    expect(await w.chain.getReserves(sink.id, w.TOKEN)).toBe(0n);
  });
});
