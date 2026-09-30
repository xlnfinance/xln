// S1 (second review of J5, PR #54): under F1 a signed batch is final at its nonce, so a dispute-class batch (dispute, reveal, hash-ladder ops)
// that reverts FOR GOOD pins the entity: every batch at nonce + 1 reverts E2, and the only way out is different bytes at the same nonce.
// The reviewer's case: A signs the unilateral finalize for T, B registers a newer counter just before T, and at T + 1 the finalize's evidence is
// outdated for good. The rule (J2 extended): a dispute op that can never succeed again, because of state ANOTHER party moved, is skipped
// (nothing applies, DisputeOpSkipped, nonce spent). A failure that depends only on the op's own bytes (a bad signature, malformed evidence)
// or that only waits for time (too early) still reverts: the runtime can see those by simulating before it signs, and nothing pins.
// Real Depository stack in BrowserVM; one file per process: `bun test contracts/test/vm/j5e-review-outdated.test.ts`.
import { describe, expect, test } from "bun:test";
import { ethers } from "ethers";
import { boot, party, signWith, type Body } from "./rig.ts";
import { createAddressFromString } from "@ethereumjs/util";
import { DeltaTransformer__factory as forkTransformer } from "../../typechain-types/index.ts";

const coder = ethers.AbiCoder.defaultAbiCoder();
const WINDOWS = 60;
/** `op` and `reason` of Account.sol DisputeOpSkipped. */
const OP = { start: 0n, counter: 1n, finalize: 2n } as const;
const REASON = { disputeMoved: 3n, counterSuperseded: 6n, finalizeEvidenceOutdated: 8n, epochMoved: 11n } as const;

const world = async () => {
  const w = await boot("j5-stuck");
  const [A, B] = [party("j5s-a"), party("j5s-b")];
  const acct = w.accountOf(A, B, "j5s-acct");
  await acct.fundedAccount();
  const transformer = w.chain.addresses.deltaTransformer;
  const secret = ethers.id("j5s-urgent-secret");
  const hashlock = ethers.keccak256(coder.encode(["bytes32"], [secret]));
  const reveal = { transformer, secret };
  const aIsLeft = acct.L.id === A.id;
  const body: Body = acct.body(0n, WINDOWS);
  const epoch = await acct.epochOf();
  const events = (name: string) => (w.last.events as { name: string; args: Record<string, unknown> }[]).filter((e) => e.name === name);
  const skipped = () => events("DisputeOpSkipped").map((e) => ({ op: BigInt(e.args["op"] as bigint), reason: BigInt(e.args["reason"] as bigint), nonce: BigInt(e.args["nonce"] as bigint) }));
  const revealedAt = async (): Promise<bigint> => {
    const iface = forkTransformer.createInterface();
    const data = iface.encodeFunctionData("hashToTimestamp", [hashlock]);
    const r = await w.vm.runReadOnlyCall({ to: createAddressFromString(transformer), caller: w.vm.deployerAddress, data: ethers.getBytes(data), gasLimit: 500_000n });
    return BigInt(iface.decodeFunctionResult("hashToTimestamp", r.execResult.returnValue)[0]);
  };
  /** A opens a dispute at account nonce 1 on the state B signed. */
  const started = async (): Promise<void> => {
    w.at(100);
    expect(await w.submit(A, { disputeStarts: [w.startOp(B, 1, aIsLeft, body, acct.proofSig(B, epoch, 1, aIsLeft, body))] })).toBe("ok");
  };
  /** A newer state A signed, as B registers it (a counter, legal until T). */
  const newer: Body = acct.body(30n, WINDOWS);
  const counterOp = (b: Body, nonce: number, initBody: Body = body) =>
    w.counterOp(A, { nonce: 1, body: initBody }, { nonce, proposerIsLeft: !aIsLeft, body: b, sig: acct.proofSig(A, epoch, nonce, !aIsLeft, b) });
  /** The unilateral finalize A signs for T, on the state it started with. */
  const oldFinalize = () => w.finalizeOp(B, { nonce: 1, body, startedByLeft: aIsLeft }, { nonce: 1, proposerIsLeft: aIsLeft, body, sig: "0x" });
  /** The finalize that matches the counter B registered. */
  const rightFinalize = () => w.finalizeOp(B, { nonce: 1, body, startedByLeft: aIsLeft }, { nonce: 2, proposerIsLeft: !aIsLeft, body: newer, sig: acct.proofSig(A, epoch, 2, !aIsLeft, newer) });
  const batch = (patch: Record<string, unknown>) => w.encodeJBatch({ ...w.createEmptyBatch(), ...patch } as never);
  return { w, A, B, acct, aIsLeft, body, epoch, newer, reveal, revealedAt, events, skipped, started, counterOp, oldFinalize, rightFinalize, batch };
};


// Review of 0aeb766: pins each branch of _finalEvidenceOutdated. The mutants that drop one compare survived the S1 suite.
describe("S1 review: every branch of the outdated-evidence decision is pinned", () => {
  test("counter registered, then superseded by a newer counter on the SAME side: a finalize signed for the older counter is skipped (nonce compare)", async () => {
    const { w, A, B, acct, aIsLeft, body, epoch, newer, reveal, revealedAt, skipped, started, counterOp } = await world();
    await started();
    const newest: Body = acct.body(31n, WINDOWS);
    w.at(110);
    expect(await w.submit(B, { counterDisputes: [counterOp(newer, 2)] })).toBe("ok");
    w.at(112);
    expect(await w.submit(B, { counterDisputes: [counterOp(newest, 3)] })).toBe("ok");
    w.at(100 + 2 * WINDOWS + 1);
    const forOlder = w.finalizeOp(A, { nonce: 1, body, startedByLeft: aIsLeft }, { nonce: 2, proposerIsLeft: !aIsLeft, body: newer, sig: acct.proofSig(A, epoch, 2, !aIsLeft, newer) });
    expect(await w.submit(B, { disputeFinalizations: [forOlder], revealSecrets: [reveal] })).toBe("ok");
    expect(skipped()).toEqual([{ op: OP.finalize, reason: REASON.finalizeEvidenceOutdated, nonce: 2n }]);
    expect(await revealedAt()).not.toBe(0n);
  }, 300_000);

  test("counter registered: a finalize at the counter's nonce but the OTHER side is skipped (side compare)", async () => {
    const { w, A, B, acct, aIsLeft, body, epoch, newer, reveal, revealedAt, skipped, started, counterOp } = await world();
    await started();
    w.at(110);
    expect(await w.submit(B, { counterDisputes: [counterOp(newer, 2)] })).toBe("ok");
    w.at(100 + 2 * WINDOWS + 1);
    const otherSide = w.finalizeOp(A, { nonce: 1, body, startedByLeft: aIsLeft }, { nonce: 2, proposerIsLeft: aIsLeft, body: newer, sig: acct.proofSig(B, epoch, 2, aIsLeft, newer) });
    expect(await w.submit(B, { disputeFinalizations: [otherSide], revealSecrets: [reveal] })).toBe("ok");
    expect(skipped()).toEqual([{ op: OP.finalize, reason: REASON.finalizeEvidenceOutdated, nonce: 2n }]);
    expect(await revealedAt()).not.toBe(0n);
  }, 300_000);

  test("no counter, after T: a co-signed newer state (mutual consent) is NOT outdated and lands (exemption)", async () => {
    const { w, A, B, acct, aIsLeft, body, epoch, newer, skipped, started } = await world();
    await started();
    const before = await acct.reserves();
    w.at(100 + 2 * WINDOWS + 1);
    const mutual = w.finalizeOp(A, { nonce: 1, body, startedByLeft: aIsLeft }, { nonce: 2, proposerIsLeft: !aIsLeft, body: newer, sig: acct.proofSig(A, epoch, 2, !aIsLeft, newer) });
    expect(await w.submit(B, { disputeFinalizations: [mutual] })).toBe("ok");
    expect(skipped()).toEqual([]);
    expect(await acct.reserves()).not.toEqual(before);
  }, 300_000);

  test("no counter, after T: an unsigned finalize at another nonce than the dispute's is skipped (initial nonce compare)", async () => {
    const { w, A, B, body, aIsLeft, reveal, revealedAt, skipped, started } = await world();
    await started();
    w.at(100 + 2 * WINDOWS + 1);
    const wrongNonce = w.finalizeOp(A, { nonce: 1, body, startedByLeft: aIsLeft }, { nonce: 5, proposerIsLeft: aIsLeft, body, sig: "0x" });
    expect(await w.submit(B, { disputeFinalizations: [wrongNonce], revealSecrets: [reveal] })).toBe("ok");
    expect(skipped()).toEqual([{ op: OP.finalize, reason: REASON.finalizeEvidenceOutdated, nonce: 5n }]);
    expect(await revealedAt()).not.toBe(0n);
  }, 300_000);
});
