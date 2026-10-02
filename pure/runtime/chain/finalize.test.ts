// R-DISPUTE-FINALIZE: the node that started a dispute finalizes it once the chain's clock has passed its window. The
// Host tells the Entity of the chain's window for the dispute (`j_dispute`, by the node's own side) and, when a final
// block's second is past its end, that the window is over (`j_window_over`); from then on every frame of the Entity
// asks the chain to finalize with what the node started from, until the chain says the dispute is over.
// Alice is the Left of the Account and starts the dispute; Bob extends credit: each of his frames is a co-signed proof.
import { describe, expect, test } from "bun:test";
import { viewOf } from "../../account/fixtures.ts";
import type { ChainFacts, JAction, JEvent } from "../../entity/model.ts";
import { type Cluster, credit, entityOf, feed, hostOf, open, restarted, rise, settle, start } from "../fixtures.ts";

const ALICE = entityOf(1);
const BOB = entityOf(2);

const opened = settle(feed(feed(start(viewOf(110n), viewOf(110n)), ALICE, open(BOB)), BOB, open(ALICE)));
const framed = (c: Cluster): Cluster => settle(feed(c, BOB, credit(ALICE, 100n)));
const asked = feed(framed(opened), ALICE, { _tag: "dispute", peer: BOB });

const gave = (epoch: bigint, by: "left" | "right", timeout: bigint): JEvent =>
  ({ _tag: "j_dispute", peer: BOB, epoch, by, timeout });
const windowOver: JEvent = { _tag: "j_window_over", peer: BOB };
const over: JEvent = { _tag: "j_dispute_over", peer: BOB };

const factsOf = (c: Cluster): ChainFacts | undefined => hostOf(c, ALICE).entities.get(ALICE)?.chain.get(BOB);
const finalizes = (c: Cluster): readonly JAction[] => c.chain.filter((a: JAction) => a._tag === "dispute_finalize");
const starts = (c: Cluster): readonly JAction[] => c.chain.filter((a: JAction) => a._tag === "dispute_start");

const windowed = feed(asked, ALICE, gave(0n, "left", 500n));
const ended = feed(windowed, ALICE, windowOver);

describe("runtime/chain R-DISPUTE-FINALIZE the node that started a dispute finalizes it after its window", () => {
  test("R-DISPUTE-FINALIZE the node keeps what it started with, and asks nothing more until the window is over", () => {
    expect(starts(asked)).toHaveLength(1);
    const kept = factsOf(asked)?.starting;
    expect(starts(asked)[0]).toMatchObject({ ...kept?.start });
    expect([kept?.window, kept?.over]).toEqual([undefined, false]);
    expect(finalizes(asked)).toEqual([]);
    expect(finalizes(rise(windowed, ALICE, 111n))).toEqual([]);
  });

  test("R-DISPUTE-FINALIZE the window is the one the chain gave the node's own dispute of this epoch", () => {
    expect(factsOf(windowed)?.starting?.window).toBe(500n);
    const again = feed(windowed, ALICE, gave(0n, "left", 900n));
    expect(factsOf(again)?.starting?.window).toBe(500n);
    const theirs = feed(asked, ALICE, gave(0n, "right", 700n));
    expect(factsOf(theirs)?.starting?.window).toBeUndefined();
    expect(factsOf(theirs)?.disputed).toBe(true);
    expect(factsOf(feed(asked, ALICE, gave(1n, "left", 700n)))?.starting?.window).toBeUndefined();
    expect(factsOf(feed(framed(opened), ALICE, gave(0n, "left", 700n)))?.starting).toBeUndefined();
  });

  test("R-DISPUTE-FINALIZE a window over before the chain gave one, or with no start, asks nothing", () => {
    const early = feed(asked, ALICE, windowOver);
    expect(factsOf(early)?.starting).toMatchObject({ window: undefined, over: false });
    expect(finalizes(rise(early, ALICE, 111n))).toEqual([]);
    const none = feed(framed(opened), ALICE, windowOver);
    expect(factsOf(none)?.starting).toBeUndefined();
    expect(finalizes(rise(none, ALICE, 111n))).toEqual([]);
  });

  test("R-DISPUTE-FINALIZE once the window is over the node asks to finalize with the state it started from", () => {
    const [start] = starts(asked);
    const [first] = finalizes(ended);
    if (start?._tag !== "dispute_start" || first?._tag !== "dispute_finalize") return expect.unreachable("no ask");
    expect(first).toEqual({
      _tag: "dispute_finalize", peer: BOB, nonce: start.nonce, proposerIsLeft: start.proposerIsLeft, body: start.body,
      startedByLeft: true,
    });
    expect(finalizes(ended)).toHaveLength(1);
  });

  test("R-DISPUTE-FINALIZE every frame restates the finalize until the chain says the dispute is over", () => {
    expect(finalizes(rise(ended, ALICE, 111n))).toHaveLength(2);
    expect(finalizes(rise(rise(ended, ALICE, 111n), ALICE, 112n))).toHaveLength(3);
    const done = feed(ended, ALICE, over);
    expect(factsOf(done)?.starting).toBeUndefined();
    expect(finalizes(rise(done, ALICE, 111n))).toHaveLength(1);
  });

  test("R-DISPUTE-FINALIZE the epoch moving on ends the dispute too: nothing is finalized for the next one", () => {
    const moved = feed(ended, ALICE, { _tag: "j_epoch", peer: BOB, epoch: 1n, stored: 9n });
    expect(factsOf(moved)?.starting).toBeUndefined();
    expect(finalizes(rise(moved, ALICE, 111n))).toHaveLength(1);
  });

  test("R-DISPUTE-FINALIZE a Host that restarts keeps the window and is asked to finalize again", () => {
    const back = restarted(ended, ALICE);
    expect(factsOf(back)).toEqual(factsOf(ended));
    expect(finalizes(back)).toHaveLength(2);
    const early = restarted(windowed, ALICE);
    expect(factsOf(early)?.starting?.window).toBe(500n);
    expect(finalizes(early)).toEqual([]);
  });

  test("R-DISPUTE-FINALIZE the one who is the Account's Right says so in the ask", () => {
    const bob = feed(framed(opened), BOB, { _tag: "dispute", peer: ALICE });
    const gaveBob = feed(feed(bob, BOB, { _tag: "j_dispute", peer: ALICE, epoch: 0n, by: "right", timeout: 500n }), BOB,
      { _tag: "j_window_over", peer: ALICE });
    const ask = finalizes(gaveBob)[0];
    expect(ask?._tag === "dispute_finalize" ? ask.startedByLeft : undefined).toBe(false);
  });
});
