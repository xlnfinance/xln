// A12 (Quint model, coordinator 00:44): a peer acks a frame at height h, then sends a different frame for the same height. Can two
// different, fully co-signed proofs exist at one proof nonce, and what does the contract do when both are presented (a dispute start
// with one, a counter with the other)?
//
// What can exist. A proof of a body at (nonce, proposerIsLeft) is the signature of the party that did NOT present it (the presenter's
// counterparty acks; the presenter's own consent is its act of presenting). Two different bodies at one nonce are both "fully co-signed"
// exactly when the two sides proposed at the same height with opposite flags and each acked the other's frame:
//   X: proposed by RIGHT (flag false), acked by LEFT     Z: proposed by LEFT (flag true), acked by RIGHT
// That is the case A12 names: LEFT acked X, then sent the different frame Z at the same height, and RIGHT (dropping its X for LEFT's
// priority, as the frame rule says) acked Z. Same flag cannot give two: both bodies would be signed by the same equivocating side, and
// the other side never signed the second one.
// The contract's answer is a fixed order, not a race: at one nonce the LEFT proposer's proof outranks the RIGHT proposer's, whoever
// starts the dispute and whoever counters. It never lets the loser's proof settle, and the equivocator cannot mint a third.
// Real Depository stack in BrowserVM; one file per process: `bun test contracts/test/vm/disputes/a12-two-cosigned-proofs.test.ts`.
import { describe, expect, test } from "bun:test";
import { boot, party, type Body } from "../rig.ts";

const WINDOWS = 60;
const N = 5; // the height both frames claim
const OP = { counter: 1n } as const;
const REASON = { counterNotNewer: 5n } as const;

const world = async () => {
  const w = await boot("a12");
  const [A, B] = [party("a12-a"), party("a12-b")];
  const acct = w.accountOf(A, B, "a12-acct");
  await acct.fundedAccount();
  const [L, R] = [acct.L, acct.R];
  const epoch = await acct.epochOf();
  const X: Body = acct.body(20n, WINDOWS); // RIGHT's proposal, acked by LEFT
  const Z: Body = acct.body(60n, WINDOWS); // LEFT's proposal, acked by RIGHT
  const events = (name: string) => (w.last.events as { name: string; args: Record<string, unknown> }[]).filter((e) => e.name === name);
  const skipped = () => events("DisputeOpSkipped").map((e) => ({ op: BigInt(e.args["op"] as bigint), reason: BigInt(e.args["reason"] as bigint), nonce: BigInt(e.args["nonce"] as bigint) }));
  /** the dispute start with a proof the presenter's counterparty signed */
  const startWith = (presenter: typeof L, body: Body, proposerIsLeft: boolean) => {
    const other = presenter.id === L.id ? R : L;
    return w.submit(presenter, { disputeStarts: [w.startOp(other, N, proposerIsLeft, body, acct.proofSig(other, epoch, N, proposerIsLeft, body))] });
  };
  /** a counter with a proof the presenter's counterparty (the starter) signed */
  const counterWith = (presenter: typeof L, initial: Body, body: Body, proposerIsLeft: boolean, signer = presenter.id === L.id ? R : L) =>
    w.submit(presenter, {
      counterDisputes: [w.counterOp(presenter.id === L.id ? R : L, { nonce: N, body: initial }, { nonce: N, proposerIsLeft, body, sig: acct.proofSig(signer, epoch, N, proposerIsLeft, body) })],
    });
  /** after T: the non-starter executes what the dispute selected */
  const finalizeAs = (presenter: typeof L, initial: Body, initialProposerIsLeft: boolean, final: Body, finalProposerIsLeft: boolean) => {
    const other = presenter.id === L.id ? R : L;
    const startedByLeft = other.id === L.id;
    return w.submit(presenter, { disputeFinalizations: [w.finalizeOp(other, { nonce: N, body: initial, startedByLeft }, { nonce: N, proposerIsLeft: finalProposerIsLeft, body: final, sig: "0x" })] });
  };
  return { w, acct, L, R, X, Z, events, skipped, startWith, counterWith, finalizeAs, epoch };
};

/** what the dispute settled: both reserves and the collateral (the account nonce differs by design: a unilateral close at T takes
 *  nonce + 1, closing on a counter adopts the counter's signed nonce) */
const valueOf = async (x: Awaited<ReturnType<typeof world>>) => {
  const r = await x.acct.reserves();
  return { L: r.L, R: r.R, collateral: r.collateral };
};

/** the reserves and collateral the account settles to after one dispute that ends on `body` */
const settledOn = async (start: "R" | "L", body: "X" | "Z"): Promise<unknown> => {
  const x = await world();
  x.w.at(100);
  const presenter = start === "R" ? x.R : x.L;
  const bodyOf = body === "X" ? x.X : x.Z;
  const flag = body === "Z"; // Z is LEFT's proposal, X is RIGHT's
  expect(await x.startWith(presenter, bodyOf, flag)).toBe("ok");
  x.w.at(100 + 2 * WINDOWS + 1);
  const nonStarter = presenter.id === x.L.id ? x.R : x.L;
  expect(await x.finalizeAs(nonStarter, bodyOf, flag, bodyOf, flag)).toBe("ok");
  return valueOf(x);
};

describe("A12 two different co-signed proofs at one nonce: LEFT's proposal outranks RIGHT's, whoever presents first", () => {
  test("RIGHT starts with its acked X, LEFT counters with Z: the counter registers and Z settles", async () => {
    const onlyZ = await settledOn("L", "Z");
    const onlyX = await settledOn("R", "X");
    expect(onlyZ).not.toEqual(onlyX); // the two bodies are worth different amounts
    const x = await world();
    x.w.at(100);
    expect(await x.startWith(x.R, x.X, false)).toBe("ok");
    x.w.at(110);
    expect(await x.counterWith(x.L, x.X, x.Z, true)).toBe("ok");
    expect(x.events("CounterDisputeRegistered")).toHaveLength(1);
    expect(x.skipped()).toEqual([]);
    x.w.at(100 + 2 * WINDOWS + 1);
    expect(await x.finalizeAs(x.L, x.X, false, x.Z, true)).toBe("ok");
    expect(await valueOf(x)).toEqual(onlyZ);
  }, 300_000);

  test("LEFT starts with Z, RIGHT counters with its acked X: the counter is skipped (not newer) and Z settles", async () => {
    const onlyZ = await settledOn("L", "Z");
    const x = await world();
    x.w.at(100);
    expect(await x.startWith(x.L, x.Z, true)).toBe("ok");
    x.w.at(110);
    expect(await x.counterWith(x.R, x.Z, x.X, false)).toBe("ok");
    expect(x.events("CounterDisputeRegistered")).toHaveLength(0);
    expect(x.skipped()).toEqual([{ op: OP.counter, reason: REASON.counterNotNewer, nonce: BigInt(N) }]);
    x.w.at(100 + 2 * WINDOWS + 1);
    expect(await x.finalizeAs(x.R, x.Z, true, x.Z, true)).toBe("ok");
    expect(await valueOf(x)).toEqual(onlyZ);
  }, 300_000);

  test("after LEFT's Z is registered, finalizing RIGHT's X is skipped for good (S1), it cannot settle", async () => {
    const onlyZ = await settledOn("L", "Z");
    const x = await world();
    x.w.at(100);
    expect(await x.startWith(x.R, x.X, false)).toBe("ok");
    x.w.at(110);
    expect(await x.counterWith(x.L, x.X, x.Z, true)).toBe("ok");
    x.w.at(100 + 2 * WINDOWS + 1);
    // RIGHT (the starter) tries to close on X, the state it presented, after T
    expect(await x.finalizeAs(x.R, x.X, false, x.X, false)).toBe("ok");
    expect(x.skipped()).toHaveLength(1);
    expect(await valueOf(x)).not.toEqual(onlyZ); // the skipped finalize settled nothing: the dispute is still open
    expect(await x.finalizeAs(x.L, x.X, false, x.Z, true)).toBe("ok");
    expect(await valueOf(x)).toEqual(onlyZ);
  }, 300_000);

  test("same flag, different body: no second proof exists, the counter is not even newer (skipped before any signature is read)", async () => {
    const x = await world();
    x.w.at(100);
    const Y: Body = x.acct.body(90n, WINDOWS);
    expect(await x.startWith(x.R, x.X, false)).toBe("ok");
    x.w.at(110);
    // LEFT presents Y at the same nonce and the same flag as the open dispute: at one nonce only LEFT's proposal can replace RIGHT's, so
    // this can never register, whatever signatures exist (there is none: RIGHT never signed Y)
    expect(await x.counterWith(x.L, x.X, Y, false, x.L)).toBe("ok");
    expect(x.events("CounterDisputeRegistered")).toHaveLength(0);
    expect(x.skipped()).toEqual([{ op: OP.counter, reason: REASON.counterNotNewer, nonce: BigInt(N) }]);
    // and as a LEFT-flagged proof it needs RIGHT's signature over Y, which RIGHT never gave: a bad signature
    expect(await x.counterWith(x.L, x.X, Y, true, x.L)).toBe("REVERT E4()");
  }, 300_000);
});
