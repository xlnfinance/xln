// R-DISPUTE-FREEZE: while a dispute is open on an Account, whoever started it, the node seals nothing on it: it proposes
// no frame, refuses the frames its peer proposes (the fault `frozen`, which can pass), and refuses back to whoever asked
// any command that takes on value, with a notice. A release waits for the epoch that follows. The Entities here sign
// for real, so the proof a dispute starts with is the one the peer gave.
import { describe, expect, test } from "bun:test";
import { heightOf, holdOf, tokenOf } from "../../account/fixtures.ts";
import { holdId } from "../../account/model.ts";
import { proofBodyHash } from "../../chain/proof/proof.ts";
import { credit, entityOf, GOLD, open, pay } from "../fixtures.ts";
import { emptyEntity, type Command, type JEvent, type Notice } from "../model.ts";
import { ALICE, BOB, must, run, signed } from "./keys.ts";

const CAROL = entityOf(3);
const OIL = tokenOf(2n);

const alice0 = run(emptyEntity(ALICE.id), open(BOB.id), open(CAROL)).state;
const bob0 = run(emptyEntity(BOB.id), open(ALICE.id)).state;

/** Bob extends Alice 60 of credit; Alice acks and Bob hears it: each holds the frame and the peer's signature. */
const committed = (() => {
  const proposed = run(bob0, credit(ALICE.id, 60n));
  const frame = proposed.outputs[0] ?? expect.unreachable("no frame");
  const heard = run(alice0, signed(BOB, frame));
  const ack = heard.outputs[0] ?? expect.unreachable("no ack");
  return { alice: heard.state, bob: run(proposed.state, signed(ALICE, ack)).state };
})();

/** Alice starts the dispute from the head Bob signed; Bob hears it open with its window ending at 500. */
const started = run(committed.alice, { _tag: "dispute", peer: BOB.id });
const start = started.chain[0]?._tag === "dispute_start" ? started.chain[0] : expect.unreachable("no start");
const opened: JEvent = {
  _tag: "j_dispute", peer: ALICE.id, epoch: 0n, by: "left", nonce: start.nonce, timeout: 500n,
  proposerIsLeft: start.proposerIsLeft, bodyHash: must(proofBodyHash(start.body)),
};
const bobDisputed = run(committed.bob, opened).state;

const refusals = (notices: readonly Notice[]) =>
  notices.flatMap((n) => (n._tag === "command_refused" && n.fault._tag === "account_disputed" ? [n.command._tag] : []));

const lock: Command = { _tag: "lock", peer: BOB.id, token: GOLD, hold: holdOf("left", 5n) };
const offer: Command = {
  _tag: "offer", peer: BOB.id, id: holdId(7n), give: { token: GOLD, amount: 3n }, want: { token: OIL, amount: 2n },
  deadline: heightOf(105n),
};
const fill: Command = { _tag: "fill", peer: BOB.id, id: holdId(7n), ratio: 1 };

describe("entity/signing R-DISPUTE-FREEZE an Account in dispute proposes nothing, on either side", () => {
  test("a tx queued while a dispute against the node is open waits: no frame goes to the peer", () => {
    expect(run(committed.bob, credit(ALICE.id, 80n)).outputs).toHaveLength(1);
    const waiting = run(bobDisputed, credit(ALICE.id, 80n));
    expect(waiting.outputs).toEqual([]);
    expect(waiting.notices).toEqual([]);
  });

  test("the same holds for the starter of the dispute, as soon as it asks for the start", () => {
    expect(run(committed.alice, credit(BOB.id, 20n)).outputs).toHaveLength(1);
    const waiting = run(started.state, credit(BOB.id, 20n));
    expect(waiting.outputs).toEqual([]);
    expect(waiting.notices).toEqual([]);
  });

  test("a frame the peer proposes meanwhile is refused with the frozen fault, which can pass", () => {
    const proposed = run(committed.alice, credit(BOB.id, 20n)).outputs[0] ?? expect.unreachable("no frame");
    const heard = run(bobDisputed, signed(ALICE, proposed));
    const answer = heard.outputs[0]?.msg ?? expect.unreachable("no answer");
    expect(answer._tag).toBe("refusal");
    expect(JSON.stringify(answer, (_, v) => (typeof v === "bigint" ? String(v) : v))).toContain("frozen");
    const calm = run(committed.bob, signed(ALICE, proposed));
    expect(calm.outputs[0]?.msg._tag).toBe("ack");
  });

  test("only the Account in dispute stops: the others still propose", () => {
    const carol = run(bobDisputed, open(CAROL), credit(CAROL, 5n));
    expect(carol.outputs.map((o) => o.to)).toEqual([CAROL]);
  });

  test("the epoch moving on, or the dispute being over, ends it and the queue goes out", () => {
    const queued = run(bobDisputed, credit(ALICE.id, 80n)).state;
    const moved = run(queued, { _tag: "j_epoch", peer: ALICE.id, epoch: 1n, stored: 9n });
    expect(moved.outputs).toHaveLength(1);
    const over = run(queued, { _tag: "j_dispute_over", peer: ALICE.id });
    expect(over.outputs).toHaveLength(1);
  });

  test("a dispute the Host dropped, because its start would revert, ends it too", () => {
    const lapsed = run(started.state, { _tag: "j_start_lapsed", peer: BOB.id, nonce: start.nonce });
    expect(run(lapsed.state, credit(BOB.id, 20n)).outputs).toHaveLength(1);
  });
});

describe("entity/signing R-DISPUTE-FREEZE a command that takes on value is refused back, a release waits", () => {
  test("a payment, a lock, an offer and a fill asked while a dispute is open are refused with a notice", () => {
    [started.state, bobDisputed].forEach((state, i) => {
      const peer = i === 0 ? BOB.id : ALICE.id;
      const asked = [pay(peer, 5n), { ...lock, peer }, { ...offer, peer }, { ...fill, peer }];
      const done = run(state, ...asked);
      expect(refusals(done.notices)).toEqual(["pay", "lock", "offer", "fill"]);
      expect(done.outputs).toEqual([]);
    });
  });

  test("the same payment on an Account with no dispute is taken", () => {
    const done = run(committed.alice, pay(BOB.id, 5n));
    expect(refusals(done.notices)).toEqual([]);
    expect(done.outputs).toHaveLength(1);
  });

  test("a release or a credit limit is not refused for the dispute, and nothing is sealed for it", () => {
    const releases: readonly Command[] = [
      { _tag: "resolve", peer: BOB.id, token: GOLD, id: holdId(1n), secret: new Uint8Array(32) },
      { _tag: "cancel", peer: BOB.id, token: GOLD, id: holdId(1n) },
      { _tag: "expire", peer: BOB.id, token: GOLD, id: holdId(1n) },
      { _tag: "retract", peer: BOB.id, id: holdId(7n) },
      credit(BOB.id, 20n),
    ];
    const done = run(started.state, ...releases);
    expect(refusals(done.notices)).toEqual([]);
    expect(done.outputs).toEqual([]);
  });

  test("once the dispute is over the payment is taken again", () => {
    const over = run(started.state, { _tag: "j_dispute_over", peer: BOB.id }).state;
    const done = run(over, pay(BOB.id, 5n));
    expect(refusals(done.notices)).toEqual([]);
  });
});
