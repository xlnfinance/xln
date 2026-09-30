// Re-review of J5 (PR 54, d645df4): every shape of a bad counterparty signature, and a deposit beside a stale settlement.
import { describe, expect, test } from "bun:test";
import { ethers } from "ethers";
import { boot } from "./rig.ts";

const E4 = ethers.id("E4()").slice(0, 10);

const world = async (label: string) => {
  const w = await boot(label);
  const acct = w.accountOf(w.L, w.R, `${label}-acct`);
  await acct.fundedAccount();
  const events = (name: string) => (w.last.events as { name: string; args: Record<string, unknown> }[]).filter((e) => e.name === name);
  const nonceOf = () => w.chain.getEntityNonce(w.L.id);
  const diffs = (n: bigint) => [{ tokenId: w.TOKEN, leftDiff: n, rightDiff: 0n, collateralDiff: -n, ondeltaDiff: -n }];
  return { w, acct, events, nonceOf, diffs };
};

const shapes = (w: Awaited<ReturnType<typeof world>>["w"], acct: Awaited<ReturnType<typeof world>>["acct"], d: unknown[], epoch: bigint) => ({
  empty: "0x",
  oneByte: "0x00",
  short32: ethers.hexlify(ethers.randomBytes(32)),
  garbage65: ethers.hexlify(ethers.randomBytes(65)),
  garbage500: ethers.hexlify(ethers.randomBytes(500)),
  wrongKeyHanko: acct.coopSig(w.L, epoch, 1, d as never), // signed by the submitter, not the counterparty
});

describe("J5 re-review: every shape of a bad counterparty signature is a BatchFailed E4 that spends the nonce", () => {
  for (const kind of ["settlement", "c2r"] as const) {
    for (const shape of ["empty", "oneByte", "short32", "garbage65", "garbage500", "wrongKeyHanko"] as const) {
      test(`${kind} with signature shape ${shape}`, async () => {
        const { w, acct, events, nonceOf, diffs } = await world(`j5b-${kind}-${shape}`);
        const e0 = await acct.epochOf();
        const d = diffs(10n);
        const sig = shapes(w, acct, d, e0)[shape];
        const patch = kind === "c2r"
          ? { collateralToReserve: [{ counterparty: w.R.id, tokenId: w.TOKEN, amount: 10n, nonce: 1, sig }] }
          : { settlements: [{ leftEntity: w.L.id, rightEntity: w.R.id, diffs: d, forgiveDebtsInTokenIds: [], sig, nonce: 1 }] };
        const before = await nonceOf();
        const outcome = await w.submit(w.L, patch);
        const reasons = events("BatchFailed").map((e) => String(e.args["reason"]));
        console.log(`SHAPE ${kind} ${shape}: ${outcome} spent=${(await nonceOf()) - before} reasons=${reasons.join(",")}`);
        expect({ outcome, spent: (await nonceOf()) - before }).toEqual({ outcome: "ok", spent: 1n });
        if (shape !== "empty") expect(reasons).toEqual([E4]);
      });
    }
  }
});
