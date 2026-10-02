// R-DISPUTE-FINALIZE at the Host's door: the finalize the Entity asks once its window is over becomes the chain's own
// finalization of the dispute it started, from the same proof, with no counter and no signature to add.
import { describe, expect, test } from "bun:test";
import { proofBodyHash } from "../../chain/proof/proof.ts";
import { opOf } from "../../host/ops.ts";
import { credit, open } from "../fixtures.ts";
import { emptyEntity, type JAction } from "../model.ts";
import { ALICE, BOB, must, run, signed } from "./keys.ts";

const alice0 = run(emptyEntity(ALICE.id), open(BOB.id)).state;
const bob0 = run(emptyEntity(BOB.id), open(ALICE.id)).state;

const committed = (() => {
  const proposed = run(alice0, credit(BOB.id, 60n));
  const frame = proposed.outputs[0] ?? expect.unreachable("no frame");
  const heard = run(bob0, signed(ALICE, frame));
  const ack = heard.outputs[0] ?? expect.unreachable("no ack");
  return { alice: run(proposed.state, signed(BOB, ack)).state, bob: heard.state };
})();

const window = { _tag: "j_dispute", epoch: 0n, timeout: 500n } as const;
const nonceOf = (action: JAction | undefined): bigint =>
  (action?._tag === "dispute_start" ? action.nonce : expect.unreachable("no dispute start"));
const over = { _tag: "j_window_over" } as const;

/** What each of the two nodes asks of the chain after it starts a dispute, hears its window and hears it is over. */
const finalizeOf = (side: "alice" | "bob"): JAction | undefined => {
  const [self, peer, by] =
    side === "alice" ? [committed.alice, BOB, "left"] as const : [committed.bob, ALICE, "right"] as const;
  const started = run(self, { _tag: "dispute", peer: peer.id });
  const nonce = nonceOf(started.chain[0]);
  const ended = run(started.state, { ...window, peer: peer.id, by, nonce }, { ...over, peer: peer.id });
  return ended.chain.find((a) => a._tag === "dispute_finalize");
};

describe("entity/signing R-DISPUTE-FINALIZE the chain's finalization is made from the dispute's own proof", () => {
  test("the ask names the start's nonce, author and body, and whether the node is the Account's Left", () => {
    const [fromAlice, fromBob] = [finalizeOf("alice"), finalizeOf("bob")];
    if (fromAlice?._tag !== "dispute_finalize" || fromBob?._tag !== "dispute_finalize") {
      return expect.unreachable("no ask");
    }
    const started = run(committed.alice, { _tag: "dispute", peer: BOB.id }).chain[0];
    if (started?._tag !== "dispute_start") return expect.unreachable("no start");
    expect([fromAlice.nonce, fromAlice.proposerIsLeft, fromAlice.body, fromAlice.startedByLeft])
      .toEqual([started.nonce, started.proposerIsLeft, started.body, true]);
    expect(fromBob.startedByLeft).toBe(false);
  });

  test("the Host's op is the chain's finalization of that dispute, with its own hash of the body", () => {
    const ask = finalizeOf("alice");
    if (ask?._tag !== "dispute_finalize") return expect.unreachable("no ask");
    const op = must(opOf(ALICE.id, ask, { transformer: "0x", tokens: new Map() }));
    expect(op).toEqual({
      _tag: "dispute_finalize",
      finalization: {
        counterentity: BOB.id, initialNonce: ask.nonce, finalNonce: ask.nonce, proposerIsLeft: ask.proposerIsLeft,
        initialProofbodyHash: must(proofBodyHash(ask.body)), finalProofbody: ask.body, starterArguments: "0x",
        otherArguments: "0x", sig: "0x", startedByLeft: true, cooperative: false,
      },
    });
  });
});
