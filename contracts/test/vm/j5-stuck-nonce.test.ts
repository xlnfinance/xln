// S1 (second review of J5, PR #54): under F1 a signed batch is final at its nonce, so a dispute-class batch (dispute, reveal, hash-ladder ops)
// that reverts FOR GOOD pins the entity: every batch at nonce + 1 reverts E2, and the only way out is different bytes at the same nonce.
// The reviewer's case: A signs the unilateral finalize for T, B registers a newer counter just before T, and at T + 1 the finalize's evidence is
// outdated for good. The rule (J2 extended): a dispute op that can never succeed again, because of state ANOTHER party moved, is skipped
// (nothing applies, DisputeOpSkipped, nonce spent). A failure that depends only on the op's own bytes (a bad signature, malformed evidence)
// or that only waits for time (too early) still reverts: the runtime can see those by simulating before it signs, and nothing pins.
// Real Depository stack in BrowserVM; one file per process: `bun test contracts/test/vm/j5-stuck-nonce.test.ts`.
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
  return { w, A, B, acct, aIsLeft, body, newer, reveal, revealedAt, events, skipped, started, counterOp, oldFinalize, rightFinalize, batch };
};

describe("S1 a finalize whose evidence another party's counter outdated is skipped, the nonce moves on", () => {
  test("the reviewer's case: the signed finalize lands after T, is skipped, and A is not pinned", async () => {
    const { w, A, B, acct, newer, reveal, revealedAt, skipped, started, counterOp, oldFinalize, rightFinalize, batch } = await world();
    await started();
    const nonceAfterStart = await w.chain.getEntityNonce(A.id);
    // A signs the finalize with the state it started with, shows it (a broadcast), and reveals an urgent secret beside it
    const n = nonceAfterStart + 1n;
    const encoded = batch({ disputeFinalizations: [oldFinalize()], revealSecrets: [reveal] });
    const signed = signWith(A, w.batchHash(A.id, encoded, n));
    // before it lands, B registers the newer proof A once signed, just before T
    w.at(100 + 2 * WINDOWS - 1);
    expect(await w.submit(B, { counterDisputes: [counterOp(newer, 2)] })).toBe("ok");
    // the broadcast finalize lands at T + 1: its evidence is outdated for good, so it is skipped, not reverted
    w.at(100 + 2 * WINDOWS + 1);
    expect(await w.sendRaw(A.id, encoded, signed, n)).toBe("ok");
    expect(skipped()).toEqual([{ op: OP.finalize, reason: REASON.finalizeEvidenceOutdated, nonce: 1n }]);
    expect(await w.chain.getEntityNonce(A.id)).toBe(n); // the nonce is spent: A can move on
    expect(await revealedAt()).not.toBe(0n); // the urgent reveal beside it landed
    // the dispute is still open and the right finalize, at the next nonce, lands
    const settledBefore = await acct.reserves();
    expect(await w.submit(A, { disputeFinalizations: [rightFinalize()] })).toBe("ok");
    expect(await w.chain.getEntityNonce(A.id)).toBe(n + 1n);
    expect(await acct.reserves()).not.toEqual(settledBefore);
    // and the old bytes stay dead: a permissionless retry reverts E2 (nonce already used)
    expect(await w.sendRaw(A.id, encoded, signed, n)).toBe("REVERT E2()");
  }, 300_000);

  test("before T the same finalize still reverts: too early is not permanent, the nonce stays open", async () => {
    const { w, A, B, newer, started, counterOp, oldFinalize } = await world();
    await started();
    const before = await w.chain.getEntityNonce(A.id);
    w.at(110);
    expect(await w.submit(B, { counterDisputes: [counterOp(newer, 2)] })).toBe("ok");
    w.at(100 + 2 * WINDOWS - 1);
    expect(await w.submit(A, { disputeFinalizations: [oldFinalize()] })).toBe("REVERT E2()");
    expect(await w.chain.getEntityNonce(A.id)).toBe(before);
  }, 300_000);

  test("control: without the counter the same finalize lands at T and pays", async () => {
    const { w, A, acct, started, oldFinalize, skipped } = await world();
    await started();
    const before = await acct.reserves();
    w.at(100 + 2 * WINDOWS + 1);
    expect(await w.submit(A, { disputeFinalizations: [oldFinalize()] })).toBe("ok");
    expect(skipped()).toEqual([]);
    expect(await acct.reserves()).not.toEqual(before);
  }, 300_000);

  test("no counter, after T: evidence that names the other side's proposal priority can never match and is skipped", async () => {
    const { w, A, B, body, aIsLeft, reveal, revealedAt, skipped, started } = await world();
    await started();
    w.at(100 + 2 * WINDOWS + 1);
    const wrong = w.finalizeOp(A, { nonce: 1, body, startedByLeft: aIsLeft }, { nonce: 1, proposerIsLeft: !aIsLeft, body, sig: "0x" });
    expect(await w.submit(B, { disputeFinalizations: [wrong], revealSecrets: [reveal] })).toBe("ok");
    expect(skipped()).toEqual([{ op: OP.finalize, reason: REASON.finalizeEvidenceOutdated, nonce: 1n }]);
    expect(await revealedAt()).not.toBe(0n);
  }, 300_000);

  test("a finalize that names another initial state than this dispute's is skipped", async () => {
    const { w, A, B, acct, aIsLeft, reveal, revealedAt, skipped, started } = await world();
    await started();
    w.at(100 + 2 * WINDOWS + 1);
    const other: Body = acct.body(77n, WINDOWS);
    const wrong = w.finalizeOp(A, { nonce: 1, body: other, startedByLeft: aIsLeft }, { nonce: 1, proposerIsLeft: aIsLeft, body: other, sig: "0x" });
    expect(await w.submit(B, { disputeFinalizations: [wrong], revealSecrets: [reveal] })).toBe("ok");
    expect(skipped()).toEqual([{ op: OP.finalize, reason: REASON.disputeMoved, nonce: 1n }]);
    expect(await revealedAt()).not.toBe(0n);
  }, 300_000);
});

describe("S1 a counter that can never register is skipped", () => {
  test("a counter that names another initial state than this dispute's", async () => {
    const { w, B, acct, newer, reveal, revealedAt, skipped, started, counterOp } = await world();
    await started();
    w.at(110);
    const other: Body = acct.body(77n, WINDOWS);
    expect(await w.submit(B, { counterDisputes: [counterOp(newer, 2, other)], revealSecrets: [reveal] })).toBe("ok");
    expect(skipped()).toEqual([{ op: OP.counter, reason: REASON.disputeMoved, nonce: 2n }]);
    expect(await revealedAt()).not.toBe(0n);
  }, 300_000);

  test("a second body at the nonce and side of a counter already registered (the signer equivocated)", async () => {
    const { w, B, acct, newer, reveal, revealedAt, skipped, started, counterOp } = await world();
    await started();
    w.at(110);
    expect(await w.submit(B, { counterDisputes: [counterOp(newer, 2)] })).toBe("ok");
    w.at(112);
    const rival: Body = acct.body(31n, WINDOWS);
    expect(await w.submit(B, { counterDisputes: [counterOp(rival, 2)], revealSecrets: [reveal] })).toBe("ok");
    expect(skipped()).toEqual([{ op: OP.counter, reason: REASON.counterSuperseded, nonce: 2n }]);
    expect(await revealedAt()).not.toBe(0n);
  }, 300_000);
});

describe("S1' a start signed at an old account epoch is skipped, and does not pin the nonce", () => {
  /** A signs a start on the newest state B signed (nonce 5, epoch e0) and hands the batch to its relayer B; B lands a finalize that advances the epoch first. */
  const staleStart = async (declared: (e0: bigint, e1: bigint) => bigint) => {
    const { w, A, B, acct, aIsLeft, body, skipped } = await world();
    const e0 = await acct.epochOf();
    const p5: Body = acct.body(-10n, WINDOWS);
    const sig = acct.proofSig(B, e0, 5, !aIsLeft, p5);
    // the declared epoch is only known once the finalize has moved it, but the bytes are signed now: build them after, from the same signature
    w.at(100);
    expect(await w.start(B, A, 1, aIsLeft, body, acct.proofSig(A, e0, 1, aIsLeft, body))).toBe("ok");
    w.at(100 + 2 * WINDOWS + 1);
    expect(await w.finalize(B, A, { nonce: 1, body, startedByLeft: !aIsLeft }, { nonce: 1, proposerIsLeft: aIsLeft, body, sig: "0x" })).toBe("ok");
    const e1 = await acct.epochOf();
    expect(e1).toBe(e0 + 1n); // the finalize advanced the epoch; the stored account nonce is now 2
    const n = (await w.chain.getEntityNonce(A.id)) + 1n;
    const held = w.encodeJBatch({ ...w.createEmptyBatch(), disputeStarts: [w.startOp(B, 5, !aIsLeft, p5, sig, declared(e0, e1))] } as never);
    const heldSig = signWith(A, w.batchHash(A.id, held, n));
    return { w, A, n, held, heldSig, skipped };
  };

  test("the reviewer's case: the released start is a skip (epoch moved), the nonce is spent and A moves on", async () => {
    const { w, A, n, held, heldSig, skipped } = await staleStart((e0) => e0);
    expect(await w.sendRaw(A.id, held, heldSig, n)).toBe("ok"); // before: REVERT E4() for good
    expect(skipped()).toEqual([{ op: OP.start, reason: REASON.epochMoved, nonce: 5n }]);
    expect(await w.chain.getEntityNonce(A.id)).toBe(n);
    // the batch at n + 1 lands (before: E2 until the end of time), and the old bytes stay dead
    expect(await w.submit(A, {})).toBe("ok");
    expect(await w.sendRaw(A.id, held, heldSig, n)).toBe("REVERT E2()");
    w.at(100 + 30 * 24 * 3600);
    expect(await w.sendRaw(A.id, held, heldSig, n)).toBe("REVERT E2()");
  }, 300_000);

  test("a start that declares the CURRENT epoch over a signature made at the old one is a lie about its own bytes: E4, the nonce stays open", async () => {
    const { w, A, n, held, heldSig } = await staleStart((_e0, e1) => e1);
    expect(await w.sendRaw(A.id, held, heldSig, n)).toBe("REVERT E4()");
    expect(await w.chain.getEntityNonce(A.id)).toBe(n - 1n); // bytes-only failure: the signer sees it by simulating, and nothing is pinned
  }, 300_000);
});
