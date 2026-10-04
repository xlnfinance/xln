// R-SIGNED-HEADS-ON-THE-WIRE: a frame and an ack commit their sender to a head, and the receiver commits that head only
// with the sender's signature over it. The Entity names the head (`attest`), the Host's shell signs it with the one
// key it holds, and the receiver checks the signature against the head it computed itself. The tests here use real keys
// and real lazy Entities (the signer's address is the id), so a signature is checked as the chain would check it.
import { describe, expect, test } from "bun:test";
import type { FrameHash, Msg } from "../../account/frame/frame.ts";
import type { AccountTx } from "../../account/tx.ts";
import { frameDigest } from "../../account/proof/signing.ts";
import { freshChain } from "../chain.ts";
import { credit, open } from "../fixtures.ts";
import { emptyEntity, type Notice } from "../model.ts";
import { lazyCheck } from "./attest.ts";
import { ALICE, BOB, hanko, MALLORY, must, real, run, signed } from "./keys.ts";
import { accountKeyOf, signingOf } from "./signing.ts";

const whyOf = (n: Notice): string => (n._tag === "message_unsigned" ? n.why : "");

const alice0 = run(emptyEntity(ALICE.id), open(BOB.id)).state;
const bob0 = run(emptyEntity(BOB.id), open(ALICE.id)).state;
const proposed = run(alice0, credit(BOB.id, 60n));
const frameOut = proposed.outputs[0] ?? expect.unreachable("alice sent nothing");

describe("R-SIGNED-HEADS-ON-THE-WIRE the Entity names the head to sign: the dispute proof's digest", () => {
  test("a frame leaves naming the head its proposer's proof is signed over, and an ack the head it commits to", () => {
    const head = proposed.state.accounts.get(BOB.id)?.pending?.head;
    expect(head).toBeDefined();
    expect(frameOut.attest).toBe(head);
    const acked = run(bob0, signed(ALICE, frameOut));
    expect(acked.outputs.map((o) => [o.msg._tag, o.attest])).toEqual([["ack", head]]);
  });

  test("that head is the digest of the state after the frame, at its slot, in the Account's own context", () => {
    const account = proposed.state.accounts.get(BOB.id) ?? expect.unreachable("no Account");
    const pending = account.pending ?? expect.unreachable("nothing pending");
    const context = signingOf(real, ALICE.id, BOB.id, proposed.state.chain.get(BOB.id) ?? freshChain);
    expect(context.accountKey).toBe(accountKeyOf(ALICE.id, BOB.id));
    const digest = must(frameDigest(context, pending.frame.slot, pending.frame.author, pending.after));
    expect(pending.head).toBe(digest as FrameHash);
  });
});

describe("R-SIGNED-HEADS-ON-THE-WIRE a head is committed only with its sender's signature over it", () => {
  test("a frame signed by its proposer commits, is acked, and its signature is kept as the proof", () => {
    const heard = run(bob0, signed(ALICE, frameOut));
    const kept = heard.state.proofs.get(ALICE.id);
    expect(heard.notices).toEqual([]);
    expect(kept?.head).toBe(frameOut.attest);
    expect(kept?.sig).toBe(hanko(ALICE, frameOut.attest ?? ""));
    expect(kept?.slot).toBe(heard.state.accounts.get(ALICE.id)?.used);
    expect(lazyCheck(ALICE.id, kept?.head ?? "", kept?.sig ?? "")).toBe(true);
  });

  test("the ack, signed by the receiver, commits the proposer's frame and its signature is kept as the proof", () => {
    const ack = run(bob0, signed(ALICE, frameOut)).outputs[0] ?? expect.unreachable("no ack");
    const done = run(proposed.state, signed(BOB, ack));
    expect(done.notices).toEqual([]);
    expect(done.state.accounts.get(BOB.id)?.pending).toBeUndefined();
    const sig = hanko(BOB, ack.attest ?? "");
    const slot = done.state.accounts.get(BOB.id)?.used;
    expect(done.state.proofs.get(BOB.id)).toMatchObject({ head: ack.attest, slot, sig });
  });

  test("a frame with no signature is refused with a notice: nothing committed, nothing acked, nothing kept", () => {
    const heard = run(bob0, { _tag: "peer_message", from: ALICE.id, msg: frameOut.msg });
    expect(heard.outputs).toEqual([]);
    expect(heard.state.accounts.get(ALICE.id)).toEqual(bob0.accounts.get(ALICE.id));
    expect(heard.state.proofs.size).toBe(0);
    expect(heard.notices.map((n) => [n._tag, whyOf(n)])).toEqual([["message_unsigned", "missing"]]);
  });

  test("a frame signed by someone else, or over another head, is refused as wrong", () => {
    const forged = { ...signed(ALICE, frameOut), sig: hanko(MALLORY, frameOut.attest ?? "") };
    const another = { ...signed(ALICE, frameOut), sig: hanko(ALICE, `0x${"11".repeat(32)}`) };
    [forged, another].forEach((message) => {
      const heard = run(bob0, message);
      expect(heard.outputs).toEqual([]);
      expect(heard.state.accounts.get(ALICE.id)).toEqual(bob0.accounts.get(ALICE.id));
      expect(heard.notices.map((n) => [n._tag, whyOf(n)])).toEqual([["message_unsigned", "wrong"]]);
    });
  });

  test("an ack with no signature, or signed over a head that is not the frame's, leaves the frame pending", () => {
    const ack = run(bob0, signed(ALICE, frameOut)).outputs[0] ?? expect.unreachable("no ack");
    [
      run(proposed.state, { _tag: "peer_message", from: BOB.id, msg: ack.msg }),
      run(proposed.state, { ...signed(BOB, ack), sig: hanko(BOB, `0x${"22".repeat(32)}`) }),
    ].forEach((heard) => {
      expect(heard.state.accounts.get(BOB.id)?.pending).toBeDefined();
      expect(heard.state.proofs.size).toBe(0);
      expect(heard.notices.map((n) => n._tag)).toEqual(["message_unsigned"]);
    });
  });

  test("a message that commits no head (a refusal, a frame refused on its merits) needs no signature", () => {
    const msg: Msg<AccountTx> = { _tag: "ack", hash: `0x${"33".repeat(32)}` as FrameHash };
    const stale = run(bob0, { _tag: "peer_message", from: ALICE.id, msg });
    expect(stale.notices.map((n) => n._tag)).not.toContain("message_unsigned");
  });
});
