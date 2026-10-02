// R-DISPUTE-LAPSED: a dispute start the Host dropped because it would revert opens no dispute, so the node forgets it
// and may ask again. Without that the record of its own start would refuse every later ask until the epoch moved.
import { describe, expect, test } from "bun:test";
import { viewOf } from "../../account/fixtures.ts";
import type { ChainFacts, JAction, JEvent } from "../../entity/model.ts";
import { type Cluster, credit, entityOf, feed, hostOf, open, restarted, settle, start } from "../fixtures.ts";

const ALICE = entityOf(1);
const BOB = entityOf(2);

const opened = settle(feed(feed(start(viewOf(110n), viewOf(110n)), ALICE, open(BOB)), BOB, open(ALICE)));
const framed = (c: Cluster): Cluster => settle(feed(c, BOB, credit(ALICE, 100n)));
const asked = feed(framed(opened), ALICE, { _tag: "dispute", peer: BOB });

const factsOf = (c: Cluster): ChainFacts | undefined => hostOf(c, ALICE).entities.get(ALICE)?.chain.get(BOB);
const starts = (c: Cluster): readonly JAction[] => c.chain.filter((a: JAction) => a._tag === "dispute_start");
const NONCE = (() => {
  const [first] = starts(asked);
  return first?._tag === "dispute_start" ? first.nonce : expect.unreachable("no start");
})();

const lapsed = (nonce: bigint): JEvent => ({ _tag: "j_start_lapsed", peer: BOB, nonce });
const gave: JEvent = { _tag: "j_dispute", peer: BOB, epoch: 0n, by: "left", nonce: NONCE, timeout: 500n };
const refusals = (c: Cluster): readonly (string | false)[] =>
  hostOf(c, ALICE).wal.at(-1)?.notices.map((n) => n._tag === "command_refused" && n.fault._tag) ?? [];

describe("runtime/chain R-DISPUTE-LAPSED a start the Host dropped is forgotten and the node may ask again", () => {
  test("R-DISPUTE-LAPSED the lapse of the start the node asked for clears its record, and a new ask is taken", () => {
    expect(factsOf(asked)?.starting?.start.nonce).toBe(NONCE);
    const dropped = feed(asked, ALICE, lapsed(NONCE));
    expect(factsOf(dropped)?.starting).toBeUndefined();
    const again = feed(dropped, ALICE, { _tag: "dispute", peer: BOB });
    expect(starts(again)).toHaveLength(2);
    expect(factsOf(again)?.starting?.start.nonce).toBe(NONCE);
  });

  test("R-DISPUTE-LAPSED while the record stands a second ask is still refused", () => {
    const again = feed(asked, ALICE, { _tag: "dispute", peer: BOB });
    expect(starts(again)).toHaveLength(1);
    expect(refusals(again)).toEqual(["dispute_pending"]);
  });

  test("R-DISPUTE-LAPSED a lapse of another nonce, or of a start that has its window, changes nothing", () => {
    expect(factsOf(feed(asked, ALICE, lapsed(NONCE + 2n)))?.starting?.start.nonce).toBe(NONCE);
    const windowed = feed(asked, ALICE, gave);
    const late = feed(windowed, ALICE, lapsed(NONCE));
    expect(factsOf(late)?.starting?.window).toBe(500n);
    expect(factsOf(feed(framed(opened), ALICE, lapsed(NONCE)))?.starting).toBeUndefined();
  });

  test("R-DISPUTE-LAPSED a Host that restarts after the lapse still has no record of the start", () => {
    const back = restarted(feed(asked, ALICE, lapsed(NONCE)), ALICE);
    expect(factsOf(back)?.starting).toBeUndefined();
  });
});
