// J2 (contracts-decisions.md): inside processBatch a dispute op that is stale or already applied is skipped, not reverted, and
// says so with an event. Why: one moved dispute used to revert the whole batch and take an urgent HTLC secret reveal in the
// same batch down with it. A real error (a bad signature, malformed evidence, the wrong sender, too early) still reverts.
// Real Depository stack in BrowserVM; one file per process: `bun test contracts/test/vm/j2-skip-stale-dispute-ops.test.ts`.
import { describe, expect, test } from "bun:test";
import { ethers } from "ethers";
import { boot, party, type Body, type Party } from "./rig.ts";
import { createAddressFromString } from "@ethereumjs/util";
import { DeltaTransformer__factory as forkTransformer } from "../../typechain-types/index.ts";

const coder = ethers.AbiCoder.defaultAbiCoder();
const WINDOWS = 60;
/** `op` and `reason` of Account.sol DisputeOpSkipped. */
const OP = { start: 0n, counter: 1n, finalize: 2n } as const;
const REASON = {
  nonceNotAboveStored: 0n, disputeActive: 1n, noActiveDispute: 2n, disputeMoved: 3n,
  windowClosed: 4n, counterNotNewer: 5n, counterSuperseded: 6n, counterAlreadyRegistered: 7n,
} as const;

const world = async () => {
  const w = await boot("j2");
  const [A, B] = [party("j2-a"), party("j2-b")];
  const acct = w.accountOf(A, B, "j2-acct");
  await acct.fundedAccount();
  const transformer = w.chain.addresses.deltaTransformer;
  const secret = ethers.id("j2-urgent-secret");
  const hashlock = ethers.keccak256(coder.encode(["bytes32"], [secret]));
  const reveal = { transformer, secret };
  const aIsLeft = acct.L.id === A.id;
  const body: Body = acct.body(0n, WINDOWS);
  const epoch = await acct.epochOf();
  // A starts from a state B signed; B answers with newer states A signed.
  const evidence = (nonce: number, b: Body = body) => acct.proofSig(B, epoch, nonce, aIsLeft, b);
  const startOp = (nonce: number) => w.startOp(B, nonce, aIsLeft, body, evidence(nonce));
  const counterBody = (offdelta: bigint): Body => acct.body(offdelta, WINDOWS);
  const counterSig = (nonce: number, b: Body) => acct.proofSig(A, epoch, nonce, !aIsLeft, b);
  const counterOp = (nonce: number, b: Body) => w.counterOp(A, { nonce: 1, body }, { nonce, proposerIsLeft: !aIsLeft, body: b, sig: counterSig(nonce, b) });
  const finalizeAgainst = (other: Party) => w.finalizeOp(other, { nonce: 1, body, startedByLeft: aIsLeft }, { nonce: 1, proposerIsLeft: aIsLeft, body, sig: "0x" });
  const revealedAt = async (): Promise<bigint> => {
    const iface = forkTransformer.createInterface();
    const data = iface.encodeFunctionData("hashToTimestamp", [hashlock]);
    const r = await w.vm.runReadOnlyCall({ to: createAddressFromString(transformer), caller: w.vm.deployerAddress, data: ethers.getBytes(data), gasLimit: 500_000n });
    return BigInt(iface.decodeFunctionResult("hashToTimestamp", r.execResult.returnValue)[0]);
  };
  const events = (name: string) => (w.last.events as { name: string; args: Record<string, unknown> }[]).filter((e) => e.name === name);
  const skipped = () => events("DisputeOpSkipped").map((e) => ({ op: BigInt(e.args["op"] as bigint), reason: BigInt(e.args["reason"] as bigint), nonce: BigInt(e.args["nonce"] as bigint) }));
  const started = async (): Promise<void> => {
    w.at(100);
    expect(await w.submit(A, { disputeStarts: [startOp(1)] })).toBe("ok");
  };
  return { w, A, B, acct, aIsLeft, body, reveal, secret, revealedAt, events, skipped, startOp, counterOp, counterBody, finalizeAgainst, started, evidence };
};

describe("J2 a stale or already-applied dispute op is skipped, the rest of the batch lands", () => {
  test("a start already applied is skipped and the secret revealed beside it lands", async () => {
    const { w, A, reveal, revealedAt, events, skipped, startOp, started } = await world();
    await started();
    expect(await revealedAt()).toBe(0n);
    w.at(110);
    expect(await w.submit(A, { disputeStarts: [startOp(1)], revealSecrets: [reveal] })).toBe("ok");
    expect(await revealedAt()).not.toBe(0n);
    expect(events("SecretRevealed")).toHaveLength(1);
    expect(events("DisputeStarted")).toHaveLength(0);
    expect(skipped()).toEqual([{ op: OP.start, reason: REASON.nonceNotAboveStored, nonce: 1n }]);
  });

  test("a start beside an active dispute is skipped", async () => {
    const { w, A, reveal, revealedAt, skipped, startOp, started } = await world();
    await started();
    w.at(110);
    expect(await w.submit(A, { disputeStarts: [startOp(2)], revealSecrets: [reveal] })).toBe("ok");
    expect(await revealedAt()).not.toBe(0n);
    expect(skipped()).toEqual([{ op: OP.start, reason: REASON.disputeActive, nonce: 2n }]);
  });

  test("a start whose nonce a settlement already passed is skipped even though its epoch signature is old", async () => {
    const { w, A, B, acct, reveal, revealedAt, skipped, startOp } = await world();
    // A start signed for epoch 0 nonce 1, then a settlement moves the epoch on and the nonce past it.
    const diffs = [{ tokenId: w.TOKEN, leftDiff: 0n, rightDiff: 0n, collateralDiff: 0n, ondeltaDiff: 0n }];
    const settleEpoch = await acct.epochOf();
    const sig = acct.coopSig(B, settleEpoch, 5, diffs);
    w.at(50);
    expect(await w.settle(A, B, 5, diffs, sig)).toBe("ok");
    expect(await acct.epochOf()).toBe(settleEpoch + 1n);
    w.at(60);
    expect(await w.submit(A, { disputeStarts: [startOp(1)], revealSecrets: [reveal] })).toBe("ok");
    expect(await revealedAt()).not.toBe(0n);
    expect(skipped()).toEqual([{ op: OP.start, reason: REASON.nonceNotAboveStored, nonce: 1n }]);
  });

  test("a counter already registered is skipped; one superseded by a newer registered counter is skipped", async () => {
    const { w, A, B, counterOp, counterBody, reveal, revealedAt, skipped, started } = await world();
    await started();
    w.at(110);
    const newer = counterOp(3, counterBody(30n));
    expect(await w.submit(B, { counterDisputes: [newer] })).toBe("ok");
    w.at(112);
    expect(await w.submit(B, { counterDisputes: [newer], revealSecrets: [reveal] })).toBe("ok");
    expect(await revealedAt()).not.toBe(0n);
    expect(skipped()).toEqual([{ op: OP.counter, reason: REASON.counterAlreadyRegistered, nonce: 3n }]);
    // a body older than the registered one arrives late: superseded
    const older = counterOp(2, counterBody(20n));
    w.at(114);
    expect(await w.submit(B, { counterDisputes: [older] })).toBe("ok");
    expect(skipped()).toEqual([{ op: OP.counter, reason: REASON.counterSuperseded, nonce: 2n }]);
    void A;
  });

  test("a counter after the challenge window is skipped", async () => {
    const { w, B, counterOp, counterBody, reveal, revealedAt, skipped, started } = await world();
    await started();
    w.at(100 + 2 * WINDOWS + 1);
    expect(await w.submit(B, { counterDisputes: [counterOp(2, counterBody(20n))], revealSecrets: [reveal] })).toBe("ok");
    expect(await revealedAt()).not.toBe(0n);
    expect(skipped()).toEqual([{ op: OP.counter, reason: REASON.windowClosed, nonce: 2n }]);
  });

  test("a counter for a dispute that is not active is skipped", async () => {
    const { w, B, counterOp, counterBody, reveal, revealedAt, skipped } = await world();
    w.at(100);
    expect(await w.submit(B, { counterDisputes: [counterOp(2, counterBody(20n))], revealSecrets: [reveal] })).toBe("ok");
    expect(await revealedAt()).not.toBe(0n);
    expect(skipped()).toEqual([{ op: OP.counter, reason: REASON.noActiveDispute, nonce: 2n }]);
  });

  test("a finalize already applied is skipped, pays nothing twice, and the reveal beside it lands", async () => {
    const { w, A, B, acct, reveal, revealedAt, skipped, finalizeAgainst, started } = await world();
    await started();
    w.at(100 + 2 * WINDOWS + 1);
    expect(await w.submit(B, { disputeFinalizations: [finalizeAgainst(A)] })).toBe("ok");
    const settled = await acct.reserves();
    w.at(100 + 2 * WINDOWS + 5);
    expect(await w.submit(B, { disputeFinalizations: [finalizeAgainst(A)], revealSecrets: [reveal] })).toBe("ok");
    expect(await acct.reserves()).toEqual({ ...settled, nonce: settled.nonce });
    expect(await revealedAt()).not.toBe(0n);
    expect(skipped()).toEqual([{ op: OP.finalize, reason: REASON.noActiveDispute, nonce: 1n }]);
    void A;
  });

  test("a finalize for a dispute that moved is skipped", async () => {
    const { w, A, B, reveal, revealedAt, skipped, started, body, aIsLeft } = await world();
    await started();
    w.at(100 + 2 * WINDOWS + 1);
    // the batch names a start nonce the stored dispute no longer has
    const stale = w.finalizeOp(A, { nonce: 7, body, startedByLeft: aIsLeft }, { nonce: 7, proposerIsLeft: aIsLeft, body, sig: "0x" });
    expect(await w.submit(B, { disputeFinalizations: [stale], revealSecrets: [reveal] })).toBe("ok");
    expect(await revealedAt()).not.toBe(0n);
    expect(skipped()).toEqual([{ op: OP.finalize, reason: REASON.disputeMoved, nonce: 7n }]);
  });
});

describe("J2 a real error still reverts the whole batch", () => {
  test("a fresh start with a bad evidence signature reverts, and the reveal beside it does not land", async () => {
    const { w, A, acct, body, aIsLeft, reveal, revealedAt } = await world();
    w.at(100);
    // signed by A itself, not by the counterparty B: no board of B's signed this state
    const forged = w.startOp(party("j2-b"), 1, aIsLeft, body, acct.proofSig(A, await acct.epochOf(), 1, aIsLeft, body));
    expect(await w.submit(A, { disputeStarts: [forged], revealSecrets: [reveal] })).toBe("REVERT E4()");
    expect(await revealedAt()).toBe(0n);
  });

  test("the starter's finalize before the window ends reverts (not stale, only early), and the reveal does not land", async () => {
    const { w, A, B, finalizeAgainst, reveal, revealedAt, started } = await world();
    await started();
    w.at(100 + WINDOWS);
    const result = await w.submit(A, { disputeFinalizations: [finalizeAgainst(B)], revealSecrets: [reveal] });
    expect(result).toMatch(/^REVERT /);
    expect(await revealedAt()).toBe(0n);
  });

  test("a counter from the starter (the wrong sender) reverts", async () => {
    const { w, A, counterOp, counterBody, reveal, revealedAt, started } = await world();
    await started();
    w.at(110);
    expect(await w.submit(A, { counterDisputes: [counterOp(2, counterBody(20n))], revealSecrets: [reveal] })).toMatch(/^REVERT /);
    expect(await revealedAt()).toBe(0n);
  });

  test("a start that is not stale still starts the dispute and emits no skip", async () => {
    const { w, A, startOp, skipped, events } = await world();
    w.at(100);
    expect(await w.submit(A, { disputeStarts: [startOp(1)] })).toBe("ok");
    expect(events("DisputeStarted")).toHaveLength(1);
    expect(skipped()).toEqual([]);
  });
});

