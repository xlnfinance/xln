// H2 (contracts-decisions.md): response windows come from the starter's proof, and zero used to be allowed, so a
// starter could open and finalize in one batch and skip the counterparty's answer. Decided: a compile-time floor,
// MIN_RESPONSE_SECONDS = 60 for the testnet build, on BOTH windows of every proof body. Real stack in BrowserVM.
import { describe, expect, test } from "bun:test";
import { boot } from "./rig.ts";

const FLOOR = 60;

const opened = async (label: string, windows: number, rightWindows = windows) => {
  const w = await boot(label);
  await w.fundedAccount();
  const body = w.body(-30n, windows, rightWindows);
  const epoch = await w.epochOf();
  const sig = w.proofSig(w.L, epoch, 1, true, body);
  return { w, body, sig, start: () => w.start(w.R, w.L, 1, true, body, sig) };
};

describe("H2 response window floor", () => {
  test("a zero window is rejected at start, so open-and-finalize in one batch is gone", async () => {
    const { start } = await opened("h2-zero", 0);
    expect(await start()).toBe(`REVERT ResponseWindowTooShort(${FLOOR})`);
  });

  test("either window below the floor is rejected, on either side", async () => {
    expect(await (await opened("h2-left", FLOOR - 1, FLOOR)).start()).toBe(`REVERT ResponseWindowTooShort(${FLOOR})`);
    expect(await (await opened("h2-right", FLOOR, FLOOR - 1)).start()).toBe(`REVERT ResponseWindowTooShort(${FLOOR})`);
  });

  test("exactly the floor works, and the dispute cannot be finalized before both windows have run", async () => {
    const { w, body, start } = await opened("h2-floor", FLOOR);
    expect(await start()).toBe("ok");
    w.at(2 * FLOOR - 1);
    const early = await w.finalize(w.R, w.L, { nonce: 1, body, startedByLeft: false }, { nonce: 1, proposerIsLeft: true, body, sig: "0x" });
    expect(early).toStartWith("REVERT");
    w.at(2 * FLOOR);
    expect(await w.finalize(w.R, w.L, { nonce: 1, body, startedByLeft: false }, { nonce: 1, proposerIsLeft: true, body, sig: "0x" })).toBe("ok");
    expect((await w.reserves()).R).toBe(1030n);
  });
});
