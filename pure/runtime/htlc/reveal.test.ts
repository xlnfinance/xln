// R-HTLC-CLOCK (c): a payee whose resolve is still unacked reveals the secret on chain once its view is within LAG of
// the clause's deadline, so that the payer cannot take the clause back off chain while the payee holds the secret.
// Alice locks 30 for Bob until height 115; the clock's LAG is 1, so Bob's reveal is due at his view 114. Bob resolves
// and Alice's ack does not come: what Bob's Host is asked to send to the chain is the subject here.
import { describe, expect, test } from "bun:test";
import { hashlockOf, holdOf, secretOf, viewOf } from "../../account/fixtures.ts";
import { holdId } from "../../account/model.ts";
import { apply, commit, flush, recover } from "../tick.ts";
import { OPENED_WITH } from "../../entity/fixtures.ts";
import { emptyEntity, type Command, type EntityId, type JAction, type JEvent } from "../../entity/model.ts";
import {
  type Cluster, credit, entityOf, feed, GOLD, heightAt, hostOf, open, restarted, rise, settle, start, unhalted,
} from "../fixtures.ts";

const ALICE = entityOf(1);
const BOB = entityOf(2);
const SLOT = holdId(1n);
const DEADLINE = 115n;
const SECRET = secretOf(1);

const lockIn = (id: bigint, deadline: bigint): Command =>
  ({ _tag: "lock", peer: BOB, token: GOLD, hold: holdOf("left", 30n, id, deadline, 1) });

const resolveOf = (id: bigint): Command =>
  ({ _tag: "resolve", peer: ALICE, token: GOLD, id: holdId(id), secret: SECRET });

const opened = settle(feed(feed(start(viewOf(110n), viewOf(110n)), ALICE, open(BOB)), BOB, open(ALICE)));
const locked = settle(feed(settle(feed(opened, BOB, credit(ALICE, 100n))), ALICE, lockIn(1n, DEADLINE)));

/** Bob has resolved and the frame is on the link: Alice has not answered. */
const unacked = feed(locked, BOB, resolveOf(1n));

/** Alice asks for the dispute and the chain opens it: both Entities hear it, so the Account is frozen. */
const disputed = (c: Cluster): Cluster => {
  const asked = feed(c, ALICE, { _tag: "dispute", peer: BOB });
  const [start] = asked.chain.filter((a: JAction) => a._tag === "dispute_start").slice(-1);
  const nonce = start?._tag === "dispute_start" ? start.nonce : expect.unreachable("no start");
  const opens = (peer: EntityId): JEvent =>
    ({ _tag: "j_dispute", peer, epoch: 0n, by: "left", nonce, timeout: 500n, ...OPENED_WITH });
  return feed(feed(asked, ALICE, opens(BOB)), BOB, opens(ALICE));
};

const reveals = (c: Cluster): readonly JAction[] => c.chain;

const revealedBy = (c: Cluster, id: EntityId, peer: EntityId) => hostOf(c, id).entities.get(id)?.revealed.get(peer);

describe("runtime/reveal the payee asks the chain to reveal its secret when the deadline is near", () => {
  test("R-HTLC-CLOCK a resolve unacked with the deadline more than LAG away asks nothing", () => {
    expect(reveals(rise(unacked, BOB, 113n))).toEqual([]);
  });

  test("R-HTLC-CLOCK at the deadline minus LAG the payee asks for a reveal of the secret of the clause", () => {
    const due = rise(unacked, BOB, 114n);
    expect(reveals(due)).toEqual([
      { _tag: "reveal", peer: ALICE, token: GOLD, id: SLOT, hashlock: hashlockOf(SECRET), secret: SECRET },
    ]);
  });

  test("R-HTLC-CLOCK the reveal is asked once however many heights follow, and never by the payer", () => {
    const later = rise(rise(rise(unacked, BOB, 114n), ALICE, 114n), BOB, 115n);
    expect(reveals(later).map((a) => a._tag)).toEqual(["reveal"]);
  });

  test("R-HTLC-CLOCK a resolve the payer acks in time asks nothing, whatever the height", () => {
    const acked = settle(unacked);
    expect(reveals(rise(acked, BOB, 120n))).toEqual([]);
    expect(revealedBy(acked, BOB, ALICE)).toEqual([]);
  });

  test("R-HTLC-CLOCK a Host that restarts after the reveal row was committed is asked again", () => {
    const due = rise(unacked, BOB, 114n);
    const back = restarted(due, BOB);
    expect(reveals(back).map((a) => a._tag)).toEqual(["reveal", "reveal"]);
    expect(revealedBy(back, BOB, ALICE)).toEqual(revealedBy(due, BOB, ALICE));
  });

  test("R-HTLC-CLOCK a hashlock is forgotten once its hold is gone: its next clause is asked for again", () => {
    const first = settle(rise(unacked, BOB, 114n));
    expect(revealedBy(first, BOB, ALICE)).toEqual([]);
    const next = settle(rise(rise(first, ALICE, 115n), BOB, 115n));
    const relocked = feed(settle(feed(next, ALICE, lockIn(2n, 125n))), BOB, resolveOf(2n));
    expect(reveals(rise(relocked, BOB, 124n)).map((a) => a._tag)).toEqual(["reveal", "reveal"]);
  });

  test("R-HTLC-CLOCK a resolve still in the queue behind a pending frame of its own is watched too", () => {
    const behind = feed(feed(locked, BOB, credit(ALICE, 150n)), BOB, resolveOf(1n));
    const queue = hostOf(behind, BOB).entities.get(BOB)?.accounts.get(ALICE)?.mempool.map((tx) => tx._tag);
    expect(queue).toEqual(["resolve"]);
    expect(reveals(rise(behind, BOB, 114n)).map((a) => a._tag)).toEqual(["reveal"]);
  });

  test("R-HTLC-CLOCK a resolve that comes when the deadline is already near asks in the frame of its command", () => {
    const late = feed(rise(locked, BOB, 114n), BOB, resolveOf(1n));
    expect(reveals(late).map((a) => a._tag)).toEqual(["reveal"]);
    expect(hostOf(late, BOB).wal.at(-1)?.chain.map((a) => a._tag)).toEqual(["reveal"]);
  });

  test("R-DURABLE a staged row asks nothing of the chain: its actions leave once it is committed", () => {
    const bob = hostOf(unacked, BOB);
    const staged = unhalted(apply(bob, heightAt(100n, 114n)));
    expect(flush(staged).chain).toEqual([]);
    expect(flush(unhalted(commit(staged))).chain.map((a) => a._tag)).toEqual(["reveal"]);
  });

  test("R-DURABLE a WAL whose row lost its chain actions does not replay: the Runtime halts on it", () => {
    const due = hostOf(rise(unacked, BOB, 114n), BOB);
    const last = due.wal.at(-1) ?? expect.unreachable("no row");
    const forged = [...due.wal.slice(0, -1), { ...last, chain: [] }];
    expect(recover(due.setup, [emptyEntity(BOB)], forged)).toEqual({
      ok: false, error: { _tag: "replay_diverged", height: last.height },
    });
  });

  test("R-HTLC-CLOCK a payee whose Account is in dispute reveals at once: its resolve cannot be acked there", () => {
    const frozen = disputed(locked);
    const resolved = feed(frozen, BOB, resolveOf(1n));
    const queue = hostOf(resolved, BOB).entities.get(BOB)?.accounts.get(ALICE)?.mempool.map((tx) => tx._tag);
    expect(queue).toEqual(["resolve"]);
    expect(reveals(resolved).filter((a) => a._tag === "reveal")).toEqual([
      { _tag: "reveal", peer: ALICE, token: GOLD, id: SLOT, hashlock: hashlockOf(SECRET), secret: SECRET },
    ]);
    expect(reveals(rise(resolved, BOB, 111n)).filter((a) => a._tag === "reveal")).toHaveLength(1);
  });

  test("R-HTLC-CLOCK a payee whose Account is not in dispute still waits for the deadline minus LAG", () => {
    expect(reveals(unacked).filter((a) => a._tag === "reveal")).toEqual([]);
  });
});
