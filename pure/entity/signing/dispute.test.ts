// The dispute command (S8): the Entity starts a dispute from the newest head its peer signed that the Account
// committed, and asks the chain for everything the chain's dispute start holds: the proof body of that state, the nonce
// and epoch the head was signed at, who authored it, and the peer's signature. The digest the chain computes from those
// is the head, so the signature the Entity holds is the one the chain verifies (R-SIGNED-HEADS-ON-THE-WIRE).
import { describe, expect, test } from "bun:test";
import { proofBodyOf } from "../../account/proof/body.ts";
import { accountMessageHash } from "../../chain/proof/payload.ts";
import { proofBodyHash } from "../../chain/proof/proof.ts";
import { opOf } from "../../host/ops.ts";
import { proofNonce } from "../chain.ts";
import { credit, open } from "../fixtures.ts";
import { entityFrame } from "../frame.ts";
import { judge } from "../fixtures.ts";
import { emptyEntity, sideOf, type EntityState, type JAction } from "../model.ts";
import { accountKeyOf } from "./signing.ts";
import { ALICE, BOB, hanko, must, real, run, signed } from "./keys.ts";

const alice0 = run(emptyEntity(ALICE.id), open(BOB.id)).state;
const bob0 = run(emptyEntity(BOB.id), open(ALICE.id)).state;

/** Alice extends Bob 60 of credit; Bob acks and Alice hears it: each holds the frame and the peer's signature. */
const committed = (() => {
  const proposed = run(alice0, credit(BOB.id, 60n));
  const frame = proposed.outputs[0] ?? expect.unreachable("no frame");
  const heard = run(bob0, signed(ALICE, frame));
  const ack = heard.outputs[0] ?? expect.unreachable("no ack");
  const done = run(proposed.state, signed(BOB, ack));
  return { alice: done.state, bob: heard.state };
})();

const dispute = (state: EntityState, peer: typeof ALICE.id) => run(state, { _tag: "dispute", peer });

const startOf = (state: EntityState, peer: typeof ALICE.id) => {
  const asked = dispute(state, peer).chain;
  const [action] = asked;
  return action?._tag === "dispute_start" && asked.length === 1 ? action : expect.unreachable("not one dispute start");
};

describe("entity/signing R-DISPUTE-START a dispute starts from the peer's signature over the committed head", () => {
  test("the start carries the nonce, epoch, author, body and the peer's own signature, from either side", () => {
    const [fromAlice, fromBob] = [startOf(committed.alice, BOB.id), startOf(committed.bob, ALICE.id)];
    const account = committed.alice.accounts.get(BOB.id) ?? expect.unreachable("no Account");
    const facts = committed.alice.chain.get(BOB.id) ?? expect.unreachable("no chain facts");
    expect(fromAlice).toMatchObject({ peer: BOB.id, nonce: proofNonce(facts, account.used), epoch: 0n });
    expect(fromAlice.sig).toBe(hanko(BOB, account.head));
    expect(fromBob.sig).toBe(hanko(ALICE, account.head));
    expect([fromBob.nonce, fromBob.epoch, fromBob.proposerIsLeft, fromBob.body])
      .toEqual([fromAlice.nonce, fromAlice.epoch, fromAlice.proposerIsLeft, fromAlice.body]);
    expect(fromAlice.proposerIsLeft).toBe(sideOf(ALICE.id, BOB.id) === "left");
    expect(fromAlice.body).toEqual(must(proofBodyOf(real.terms, account.state)));
  });

  test("the digest the chain computes from the start's fields is the head the peer signed", () => {
    const start = startOf(committed.alice, BOB.id);
    const account = committed.alice.accounts.get(BOB.id) ?? expect.unreachable("no Account");
    const digest = must(accountMessageHash(
      real.deployment, { accountKey: accountKeyOf(ALICE.id, BOB.id), ondeltaEpoch: start.epoch, nonce: start.nonce },
      {
        _tag: "dispute_proof", proposerIsLeft: start.proposerIsLeft, proofBodyHash: must(proofBodyHash(start.body)),
        watchSeed: start.body.watchSeed,
      },
    ));
    expect(digest).toBe(account.head);
  });

  test("the Host's op is the chain's dispute start with the same fields and its own hash of the body", () => {
    const start = startOf(committed.alice, BOB.id);
    const action: JAction = start;
    const op = must(opOf(ALICE.id, action, { transformer: "0x", tokens: new Map() }));
    expect(op).toEqual({
      _tag: "dispute_start",
      start: {
        counterentity: BOB.id, nonce: start.nonce, ondeltaEpoch: start.epoch, proposerIsLeft: start.proposerIsLeft,
        proofbodyHash: must(proofBodyHash(start.body)), initialProofbody: start.body, watchSeed: start.body.watchSeed,
        sig: start.sig, starterInitialArguments: "0x", starterCounterArguments: "0x",
        starterCounterProofCommitment: `0x${"00".repeat(32)}`,
      },
    });
  });

  test("with no Account, or no committed frame, or a frame still pending, there is nothing to start with", () => {
    const noAccount = dispute(emptyEntity(ALICE.id), BOB.id);
    expect(noAccount.chain).toEqual([]);
    expect(noAccount.notices.map((n) => n._tag === "command_refused" && n.fault._tag)).toEqual(["no_account"]);
    const proposed = run(alice0, credit(BOB.id, 60n)).state;
    [alice0, proposed].forEach((state) => {
      const refused = dispute(state, BOB.id);
      expect(refused.chain).toEqual([]);
      const faults = refused.notices.map((n) => n._tag === "command_refused" && n.fault);
      expect(faults).toEqual([{ _tag: "no_proof", why: "none" }]);
    });
  });

  test("a state the chain would refuse as a proof starts nothing, and the owner is told it cannot be signed", () => {
    const year = 365n * 24n * 3600n;
    const longer = { ...real, terms: { ...real.terms, leftResponseSeconds: year + 1n } };
    const refused = entityFrame(judge, longer, committed.alice, [{ _tag: "dispute", peer: BOB.id }]);
    expect(refused.chain).toEqual([]);
    const faults = refused.notices.map((n) => n._tag === "command_refused" && n.fault);
    expect(faults).toEqual([{ _tag: "no_proof", why: "unsignable" }]);
    expect(refused.state.chain.get(BOB.id)?.starting).toBeUndefined();
  });

  test("a frame pending on top of the committed head leaves the dispute on the committed one", () => {
    const next = run(committed.alice, credit(BOB.id, 90n)).state;
    expect(next.accounts.get(BOB.id)?.pending).toBeDefined();
    expect(startOf(next, BOB.id)).toEqual(startOf(committed.alice, BOB.id));
  });
});
