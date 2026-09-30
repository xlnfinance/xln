// Review of PR 49 (J2): tests the author's file leaves out. Same rig, same conventions.
//   1. every skip path leaves the Account (nonce, dispute hash, timeout), reserves and collateral untouched
//   2. skip reasons the author's file never reaches: counter reason 3 (dispute moved) and reason 5 (not newer)
//   3. counter real errors still revert the whole batch: bad hanko (E4), wrong initial body (E9), wrong windows (E9)
//   4. the window boundary: a counter at exactly the timeout is skipped, one second earlier it registers
//   5. the practical case: the victim's start is skipped beside the attacker's open dispute, its counter registers
// Run one file per process: `bun test contracts/test/vm/j2-review-extra.test.ts`.
import { describe, expect, test } from "bun:test";
import { ethers } from "ethers";
import { boot, party, signWith, type Body } from "../rig.ts";
import { Depository__factory as forkDepository } from "../../../typechain-types/index.ts";

const coder = ethers.AbiCoder.defaultAbiCoder();
const WINDOWS = 60;
const OP = { start: 0n, counter: 1n, finalize: 2n } as const;
const REASON = { nonceNotAboveStored: 0n, disputeActive: 1n, noActiveDispute: 2n, disputeMoved: 3n, windowClosed: 4n, counterNotNewer: 5n, counterSuperseded: 6n, counterAlreadyRegistered: 7n } as const;

const world = async () => {
  const w = await boot("j2x");
  const [A, B] = [party("j2x-a"), party("j2x-b")];
  const acct = w.accountOf(A, B, "j2x-acct");
  await acct.fundedAccount();
  const transformer = w.chain.addresses.deltaTransformer;
  const secret = ethers.id("j2x-urgent-secret");
  const hashlock = ethers.keccak256(coder.encode(["bytes32"], [secret]));
  const reveal = { transformer, secret };
  const aIsLeft = acct.L.id === A.id;
  const body: Body = acct.body(0n, WINDOWS);
  const epoch = await acct.epochOf();
  const startAt = (nonce: number) => w.startOp(B, nonce, aIsLeft, body, acct.proofSig(B, epoch, nonce, aIsLeft, body));
  const counterBody = (offdelta: bigint, windows = WINDOWS): Body => acct.body(offdelta, windows);
  /** A counter against the dispute A opened at `initial`; signed by A (the starter signs the newer state the non-starter B registers). */
  const counterAt = (initial: number, nonce: number, b: Body, signer = A, initialBody: Body = body, proposerIsLeft: boolean = !aIsLeft) =>
    w.counterOp(A, { nonce: initial, body: initialBody }, { nonce, proposerIsLeft, body: b, sig: acct.proofSig(signer, epoch, nonce, proposerIsLeft, b) });
  const revealedAt = async (): Promise<bigint> => {
    const { DeltaTransformer__factory: F } = await import("../../../typechain-types/index.ts");
    const { createAddressFromString } = await import("@ethereumjs/util");
    const iface = F.createInterface();
    const data = iface.encodeFunctionData("hashToTimestamp", [hashlock]);
    const r = await w.vm.runReadOnlyCall({ to: createAddressFromString(transformer), caller: w.vm.deployerAddress, data: ethers.getBytes(data), gasLimit: 500_000n });
    return BigInt(iface.decodeFunctionResult("hashToTimestamp", r.execResult.returnValue)[0]);
  };
  const events = (name: string) => (w.last.events as { name: string; args: Record<string, unknown> }[]).filter((e) => e.name === name);
  const skipped = () => events("DisputeOpSkipped").map((e) => ({ op: BigInt(e.args["op"] as bigint), reason: BigInt(e.args["reason"] as bigint), nonce: BigInt(e.args["nonce"] as bigint) }));
  /** Everything a skip must leave alone. */
  const snapshot = async () => ({ ...(await acct.reserves()), info: await w.chain.getAccountInfo(acct.L.id, acct.R.id) });
  const startDispute = async (nonce = 1): Promise<void> => {
    w.at(100);
    expect(await w.submit(A, { disputeStarts: [startAt(nonce)] })).toBe("ok");
  };
  /** The starter A finalizing its own dispute at `initial` against B, unilaterally, with the initial state. */
  const finalizeOwn = (initial: number, initialBody: Body = body) =>
    w.finalizeOp(B, { nonce: initial, body: initialBody, startedByLeft: aIsLeft }, { nonce: initial, proposerIsLeft: aIsLeft, body, sig: "0x" });
  return { w, A, B, acct, aIsLeft, body, reveal, revealedAt, events, skipped, snapshot, startAt, counterAt, counterBody, startDispute, epoch, finalizeOwn };
};

describe("review: every skip leaves the Account, reserves and collateral untouched", () => {
  test("a stale start BELOW the stored nonce does not move the nonce (no rollback)", async () => {
    const { w, A, B, acct, reveal, revealedAt, snapshot, startAt, skipped } = await world();
    const diffs = [{ tokenId: w.TOKEN, leftDiff: 0n, rightDiff: 0n, collateralDiff: 0n, ondeltaDiff: 0n }];
    const settleEpoch = await acct.epochOf();
    w.at(50);
    expect(await w.settle(A, B, 5, diffs, acct.coopSig(B, settleEpoch, 5, diffs))).toBe("ok");
    const after = await snapshot();
    expect(after.info.nonce).toBe(5n);
    w.at(60);
    expect(await w.submit(A, { disputeStarts: [startAt(1)], revealSecrets: [reveal] })).toBe("ok");
    expect(skipped()).toEqual([{ op: OP.start, reason: REASON.nonceNotAboveStored, nonce: 1n }]);
    expect(await snapshot()).toEqual(after);
    expect(await revealedAt()).not.toBe(0n);
  });

  test("start skips (already applied, beside an open dispute)", async () => {
    const { w, A, reveal, revealedAt, snapshot, startAt, startDispute, skipped } = await world();
    await startDispute(1);
    const before = await snapshot();
    w.at(110);
    expect(await w.submit(A, { disputeStarts: [startAt(1)], revealSecrets: [reveal] })).toBe("ok");
    expect(skipped()).toEqual([{ op: OP.start, reason: REASON.nonceNotAboveStored, nonce: 1n }]);
    expect(await snapshot()).toEqual(before);
    expect(await revealedAt()).not.toBe(0n);
    w.at(111);
    expect(await w.submit(A, { disputeStarts: [startAt(2)] })).toBe("ok");
    expect(skipped()).toEqual([{ op: OP.start, reason: REASON.disputeActive, nonce: 2n }]);
    expect(await snapshot()).toEqual(before);
  });

  test("counter skips: no dispute, window closed, dispute moved, not newer", async () => {
    const x = await world();
    const { w, A, B, snapshot, counterAt, counterBody, startDispute, skipped, reveal, revealedAt, finalizeOwn } = x;
    // no dispute open
    w.at(90);
    const idle = await snapshot();
    expect(await w.submit(B, { counterDisputes: [counterAt(1, 2, counterBody(20n))] })).toBe("ok");
    expect(skipped()).toEqual([{ op: OP.counter, reason: REASON.noActiveDispute, nonce: 2n }]);
    expect(await snapshot()).toEqual(idle);

    // dispute open at nonce 5
    await startDispute(5);
    const open = await snapshot();
    w.at(110);
    // equal nonce from a RIGHT proposer can never replace the opening state: not newer (reason 5)
    expect(await w.submit(B, { counterDisputes: [counterAt(5, 5, counterBody(20n), A, x.body, false)] })).toBe("ok");
    expect(skipped()).toEqual([{ op: OP.counter, reason: REASON.counterNotNewer, nonce: 5n }]);
    expect(await snapshot()).toEqual(open);
    // the counter names another dispute's start nonce: moved (reason 3)
    expect(await w.submit(B, { counterDisputes: [counterAt(4, 6, counterBody(20n))], revealSecrets: [reveal] })).toBe("ok");
    expect(skipped()).toEqual([{ op: OP.counter, reason: REASON.disputeMoved, nonce: 6n }]);
    expect(await snapshot()).toEqual(open);
    expect(await revealedAt()).not.toBe(0n);
    // the counter is older than the state the dispute opened on: not newer (reason 5)
    w.at(111);
    expect(await w.submit(B, { counterDisputes: [counterAt(5, 3, counterBody(20n))] })).toBe("ok");
    expect(skipped()).toEqual([{ op: OP.counter, reason: REASON.counterNotNewer, nonce: 3n }]);
    expect(await snapshot()).toEqual(open);
    // after the window: closed (reason 4)
    w.at(100 + 2 * WINDOWS + 1);
    expect(await w.submit(B, { counterDisputes: [counterAt(5, 6, counterBody(20n))] })).toBe("ok");
    expect(skipped()).toEqual([{ op: OP.counter, reason: REASON.windowClosed, nonce: 6n }]);
    expect(await snapshot()).toEqual(open);
    // the skips wrote nothing the finalization reads: the starter still closes its own dispute on the state it opened
    expect(await w.submit(A, { disputeFinalizations: [finalizeOwn(5)] })).toBe("ok");
    expect((await snapshot()).info.disputeHash).toBe(ethers.ZeroHash);
  });

  test("a superseded and an already-registered counter leave the dispute hash as the registered counter set it", async () => {
    const { w, B, snapshot, counterAt, counterBody, startDispute, skipped } = await world();
    await startDispute(1);
    w.at(110);
    expect(await w.submit(B, { counterDisputes: [counterAt(1, 3, counterBody(30n))] })).toBe("ok");
    const registered = await snapshot();
    w.at(112);
    expect(await w.submit(B, { counterDisputes: [counterAt(1, 3, counterBody(30n))] })).toBe("ok");
    expect(skipped()).toEqual([{ op: OP.counter, reason: REASON.counterAlreadyRegistered, nonce: 3n }]);
    expect(await snapshot()).toEqual(registered);
    w.at(113);
    expect(await w.submit(B, { counterDisputes: [counterAt(1, 2, counterBody(20n))] })).toBe("ok");
    expect(skipped()).toEqual([{ op: OP.counter, reason: REASON.counterSuperseded, nonce: 2n }]);
    expect(await snapshot()).toEqual(registered);
  });

  test("an equal-nonce counter of the other proposer flag is skipped as superseded when it may not replace the registered one", async () => {
    const { w, B, snapshot, counterAt, counterBody, startDispute, skipped } = await world();
    await startDispute(1);
    w.at(110);
    // LEFT-proposed counter at nonce 3 registers; a RIGHT-proposed one at nonce 3 may not replace it
    expect(await w.submit(B, { counterDisputes: [counterAt(1, 3, counterBody(30n), undefined, undefined, true)] })).toBe("ok");
    const registered = await snapshot();
    w.at(112);
    expect(await w.submit(B, { counterDisputes: [counterAt(1, 3, counterBody(40n), undefined, undefined, false)] })).toBe("ok");
    expect(skipped()).toEqual([{ op: OP.counter, reason: REASON.counterSuperseded, nonce: 3n }]);
    expect(await snapshot()).toEqual(registered);
  });

  test("finalize skips (already applied, dispute moved) move no reserve and no nonce", async () => {
    const { w, A, B, acct, body, aIsLeft, snapshot, startDispute, skipped } = await world();
    await startDispute(1);
    w.at(100 + 2 * WINDOWS + 1);
    const fin = (initial: number) => w.finalizeOp(A, { nonce: initial, body, startedByLeft: aIsLeft }, { nonce: initial, proposerIsLeft: aIsLeft, body, sig: "0x" });
    // moved: names nonce 9, the stored dispute is at 1
    const open = await snapshot();
    expect(await w.submit(B, { disputeFinalizations: [fin(9)] })).toBe("ok");
    expect(skipped()).toEqual([{ op: OP.finalize, reason: REASON.disputeMoved, nonce: 9n }]);
    expect(await snapshot()).toEqual(open);
    // applied, then again
    expect(await w.submit(B, { disputeFinalizations: [fin(1)] })).toBe("ok");
    const done = await snapshot();
    expect(done.info.disputeHash).toBe(ethers.ZeroHash);
    w.at(100 + 2 * WINDOWS + 3);
    expect(await w.submit(B, { disputeFinalizations: [fin(1)] })).toBe("ok");
    expect(skipped()).toEqual([{ op: OP.finalize, reason: REASON.noActiveDispute, nonce: 1n }]);
    expect(await snapshot()).toEqual(done);
    void acct;
  });
});

describe("review: counter real errors still revert the whole batch", () => {
  const reverts = async (patch: (x: Awaited<ReturnType<typeof world>>) => Record<string, unknown>, expected: string) => {
    const x = await world();
    await x.startDispute(1);
    x.w.at(110);
    const result = await x.w.submit(x.B, { ...patch(x), revealSecrets: [x.reveal] });
    expect(result).toBe(expected);
    expect(await x.revealedAt()).toBe(0n);
  };

  test("a counter signed by the wrong party (E4)", async () => {
    await reverts((x) => ({ counterDisputes: [x.counterAt(1, 3, x.counterBody(30n), x.B)] }), "REVERT E4()");
  });

  test("a counter naming a different initial body (E9)", async () => {
    await reverts((x) => ({ counterDisputes: [x.counterAt(1, 3, x.counterBody(30n), x.A, x.acct.body(5n))] }), "REVERT E9()");
  });

  test("a counter body with different response windows (E9)", async () => {
    await reverts((x) => ({ counterDisputes: [x.counterAt(1, 3, x.counterBody(30n, WINDOWS + 1))] }), "REVERT E9()");
  });

  test("a second, different body at the registered counter's nonce and flag (E9)", async () => {
    const x = await world();
    await x.startDispute(1);
    x.w.at(110);
    expect(await x.w.submit(x.B, { counterDisputes: [x.counterAt(1, 3, x.counterBody(30n))] })).toBe("ok");
    x.w.at(112);
    expect(await x.w.submit(x.B, { counterDisputes: [x.counterAt(1, 3, x.counterBody(40n))], revealSecrets: [x.reveal] })).toBe("REVERT E9()");
    expect(await x.revealedAt()).toBe(0n);
  });

  test("a finalize naming the wrong initial body reverts (E9), it is not a skip", async () => {
    const x = await world();
    await x.startDispute(1);
    x.w.at(100 + 2 * WINDOWS + 1);
    const result = await x.w.submit(x.A, { disputeFinalizations: [x.finalizeOwn(1, x.acct.body(5n))], revealSecrets: [x.reveal] });
    expect(result).toBe("REVERT E9()");
    expect(await x.revealedAt()).toBe(0n);
  });

  test("a malformed op beside a stale one reverts the batch (validated before anything runs)", async () => {
    const x = await world();
    await x.startDispute(1);
    x.w.at(110);
    const malformed = { ...x.startAt(2), proofbodyHash: ethers.id("not the body") };
    const result = await x.w.submit(x.A, { disputeStarts: [x.startAt(1), malformed], revealSecrets: [x.reveal] });
    expect(result).toBe("REVERT E9()");
    expect(await x.revealedAt()).toBe(0n);
  });
});

describe("review: window boundary and the practical case", () => {
  test("a counter at exactly the timeout is skipped, one second earlier it registers", async () => {
    const { w, B, counterAt, counterBody, startDispute, skipped, events } = await world();
    await startDispute(1);
    w.at(100 + 2 * WINDOWS - 1);
    expect(await w.submit(B, { counterDisputes: [counterAt(1, 3, counterBody(30n))] })).toBe("ok");
    expect(events("CounterDisputeRegistered")).toHaveLength(1);
    const x = await world();
    await x.startDispute(1);
    x.w.at(100 + 2 * WINDOWS);
    expect(await x.w.submit(x.B, { counterDisputes: [x.counterAt(1, 3, x.counterBody(30n))] })).toBe("ok");
    expect(x.events("CounterDisputeRegistered")).toHaveLength(0);
    expect(x.skipped()).toEqual([{ op: OP.counter, reason: REASON.windowClosed, nonce: 3n }]);
    void skipped;
  });

  test("the victim's start is skipped beside the attacker's open dispute, and its counter in the same batch registers", async () => {
    const { w, A, B, acct, aIsLeft, epoch, counterAt, counterBody, startDispute, skipped, events, reveal, revealedAt } = await world();
    await startDispute(1);
    w.at(110);
    const newer = counterBody(20n);
    const startByB = w.startOp(A, 2, !aIsLeft, newer, acct.proofSig(A, epoch, 2, !aIsLeft, newer));
    expect(await w.submit(B, { disputeStarts: [startByB], counterDisputes: [counterAt(1, 3, counterBody(30n))], revealSecrets: [reveal] })).toBe("ok");
    expect(skipped()).toEqual([{ op: OP.start, reason: REASON.disputeActive, nonce: 2n }]);
    expect(events("CounterDisputeRegistered")).toHaveLength(1);
    expect(events("DisputeStarted")).toHaveLength(0);
    expect(await revealedAt()).not.toBe(0n);
  });
});

describe("review: consequence, an abandoned all-stale batch can now land and takes its entity nonce", () => {
  // Before J2 a signed batch whose only ops were stale dispute ops reverted for good. Now it succeeds as a no-op, so anyone
  // holding it can land it (processBatch is permissionless) and consume that entity nonce. A replacement signed for the SAME
  // nonce then reverts E2. This is R-NONCE ("urgent ops go in a batch at a fresh nonce") widened to stale dispute ops.
  test("the old batch lands, the same-nonce replacement is dead, a fresh-nonce replacement lands", async () => {
    const { w, A, reveal, revealedAt, startAt, startDispute, skipped } = await world();
    await startDispute(1);
    w.at(110);
    const n = (await w.chain.getEntityNonce(A.id)) + 1n;
    const signed = (patch: Record<string, unknown>, nonce: bigint) => {
      const encoded = w.encodeJBatch({ ...w.createEmptyBatch(), ...patch } as never);
      return { encoded, hanko: signWith(A, w.batchHash(A.id, encoded, nonce)), nonce };
    };
    const abandoned = signed({ disputeStarts: [startAt(1)] }, n);
    const replacement = signed({ revealSecrets: [reveal] }, n);
    expect(await w.sendRaw(A.id, abandoned.encoded, abandoned.hanko, abandoned.nonce)).toBe("ok");
    expect(skipped()).toEqual([{ op: OP.start, reason: REASON.nonceNotAboveStored, nonce: 1n }]);
    expect(await w.chain.getEntityNonce(A.id)).toBe(n);
    expect(await w.sendRaw(A.id, replacement.encoded, replacement.hanko, replacement.nonce)).toBe("REVERT E2()");
    expect(await revealedAt()).toBe(0n);
    const fresh = signed({ revealSecrets: [reveal] }, n + 1n);
    expect(await w.sendRaw(A.id, fresh.encoded, fresh.hanko, fresh.nonce)).toBe("ok");
    expect(await revealedAt()).not.toBe(0n);
  });
});

describe("review: the watchtower entrypoint keeps reverting (one op, no batch to protect)", () => {
  // The tower checks the dispute, the window and the nonce order itself, so what only Account._registerCounterDispute can
  // still refuse is a counter that names another dispute (initialNonce) or one the registered counter has superseded.
  const towerWorld = async () => {
    const x = await world();
    await x.startDispute(1);
    x.w.at(110);
    const iface = forkDepository.createInterface();
    const tower = x.w.vm.deployerAddress.toString();
    const call = async (fn: string, args: unknown[], write: boolean) => {
      const data = iface.encodeFunctionData(fn, args);
      if (!write) {
        const r = await x.w.vm.runReadOnlyCall({ to: x.w.vm.depositoryAddress, caller: x.w.vm.deployerAddress, data: ethers.getBytes(data), gasLimit: 5_000_000n });
        return iface.decodeFunctionResult(fn, r.execResult.returnValue)[0] as string;
      }
      try {
        const done = await x.w.vm.executeTx({ to: x.w.domain.depository, data, gasLimit: 15_000_000n }, undefined, { emitEvents: true });
        x.w.last.events = done.events ?? [];
        return "ok";
      } catch {
        return "REVERT";
      }
    };
    /** A tower counter for B (the non-starter), the newer state `nonce` signed by A, naming the dispute opened at `initial`. */
    const towerCounter = async (initial: number, nonce: number, offdelta: bigint): Promise<string> => {
      const b = x.counterBody(offdelta);
      const proposerIsLeft = !x.aIsLeft;
      const finalization = {
        counterentity: x.A.id, initialNonce: initial, finalNonce: nonce, proposerIsLeft, initialProofbodyHash: x.w.startOp(x.B, 1, x.aIsLeft, x.body, "0x").proofbodyHash,
        finalProofbody: x.w.startOp(x.B, 1, x.aIsLeft, b, "0x").initialProofbody, starterArguments: "0x", otherArguments: "0x",
        sig: x.acct.proofSig(x.A, x.epoch, nonce, proposerIsLeft, b), startedByLeft: x.aIsLeft, cooperative: false,
      };
      const lastResort = 115n;
      const sequence = 0n;
      const ownerHash = await call("computeWatchtowerCounterDisputeHash", [tower, x.B.id, x.A.id, nonce, x.w.startOp(x.B, 1, x.aIsLeft, b, "0x").proofbodyHash, lastResort, sequence], false);
      return call("watchtowerCounterDispute", [x.B.id, finalization, lastResort, sequence, signWith(x.B, ownerHash)], true);
    };
    return { ...x, towerCounter };
  };

  test("a valid tower counter registers; naming another dispute's nonce reverts; a superseded one reverts", async () => {
    const { towerCounter, events, snapshot } = await towerWorld();
    expect(await towerCounter(1, 3, 30n)).toBe("ok");
    expect(events("CounterDisputeRegistered")).toHaveLength(1);
    const registered = await snapshot();
    expect(await towerCounter(7, 4, 40n)).toBe("REVERT");
    expect(await towerCounter(1, 2, 20n)).toBe("REVERT");
    expect(await snapshot()).toEqual(registered);
  });
});
