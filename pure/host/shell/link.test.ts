// The link between two Runtimes: the peer is proved once, every record after it is sealed to the proof, and a message
// reaches a Host only as the proved peer's own (Q-T-5, R-LINK-AUTH). The forged ack and the replay go through the
// shell's receive path, handshake and sealed record first and Host.receive after, with real Hosts.
import { describe, expect, test } from "bun:test";
import { GENESIS } from "../../account/frame/account.ts";
import { credit, open } from "../../entity/fixtures.ts";
import type { Outbound } from "../../entity/model.ts";
import { err, ok, unwrapOr } from "../../kernel/core/result.ts";
import { begin, persisted, receive } from "../host.ts";
import { entityOf, hostFor, meet, stamp, tell, turn, unhalted } from "../fixtures.ts";
import {
  accept, answer, dial, finish, hear, keyOf, open as openRecord, seal, type Key, type Link, type Peer,
} from "./link.ts";
import { decodeValue, encodeValue } from "./value.ts";

const ALICE = entityOf(1);
const BOB = entityOf(2);
const MALLORY = entityOf(7);

const keyFrom = (n: number): Key =>
  unwrapOr(keyOf(Uint8Array.from({ length: 32 }, () => n)), () => expect.unreachable("key"));

const KEY = { alice: keyFrom(1), bob: keyFrom(2), mallory: keyFrom(3), stranger: keyFrom(4) } as const;

const peer = (key: Key, ...entities: Peer["entities"]): Peer =>
  ({ runtime: key.runtime, entities, endpoint: `ws://${key.runtime}` });

const TABLE: readonly Peer[] = [
  peer(KEY.alice, ALICE), peer(KEY.bob, BOB), peer(KEY.mallory, MALLORY),
];

const nonce = (n: number): Uint8Array => Uint8Array.from({ length: 32 }, () => n);

const must = <T, E>(r: { ok: true; value: T } | { ok: false; error: E }): T =>
  (r.ok ? r.value : expect.unreachable(`unexpected ${String(Object.values(r.error as object))}`));

type Connected = Readonly<{ initiator: Link; responder: Link }>;

/** A full handshake: `from` dials `to`, who is in `table`. */
const connect = (from: Key, to: Key, table: readonly Peer[] = TABLE, n = 10): Connected => {
  const toPeer = table.find((p) => p.runtime === to.runtime) ?? expect.unreachable("table");
  const dialed = dial(from, toPeer, nonce(n));
  const answered = must(answer(to, table, nonce(n + 1), dialed.hello));
  const finished = must(finish(dialed.link, answered.reply));
  return { initiator: finished.link, responder: must(accept(answered.link, finished.finish)) };
};

const ack = (from: Outbound["from"], to: Outbound["to"]): Outbound =>
  ({ from, to, msg: { _tag: "ack", hash: `0x${"cd".repeat(32)}` as never } });

const tagOf = (r: { ok: boolean; error?: { _tag: string } }) => (r.ok ? "ok" : r.error?._tag);

describe("host/shell/link the peer is proved, then a record is sealed to it", () => {
  test("a handshake between two Runtimes of the table leaves both up; records open in both directions", () => {
    const { initiator, responder } = connect(KEY.alice, KEY.bob);
    const forth = must(seal(initiator, ack(ALICE, BOB)));
    const arrived = must(openRecord(responder, forth.data));
    expect(arrived.message).toEqual(ack(ALICE, BOB));
    const back = must(seal(arrived.link, ack(BOB, ALICE)));
    expect(must(openRecord(forth.link, back.data)).message).toEqual(ack(BOB, ALICE));
  });

  test("a hello from a Runtime that is not in the table is refused, and nothing is answered", () => {
    const hello = dial(KEY.stranger, peer(KEY.bob, BOB), nonce(1)).hello;
    const refused = err({ _tag: "unknown_runtime", runtime: KEY.stranger.runtime } as const);
    expect(answer(KEY.bob, TABLE, nonce(2), hello)).toEqual(refused);
  });

  test("a reply signed by another key than the one the table names is refused: an impostor answering for Bob", () => {
    const dialed = dial(KEY.alice, peer(KEY.bob, BOB), nonce(1));
    const impostorTable = [peer(KEY.alice, ALICE), { ...peer(KEY.stranger, BOB), runtime: KEY.stranger.runtime }];
    const reply = must(answer(KEY.stranger, impostorTable, nonce(2), dialed.hello)).reply;
    expect(tagOf(finish(dialed.link, reply))).toBe("bad_signature");
  });

  test("a reply to another challenge is refused: a reply of an earlier connection replayed to this one", () => {
    const old = dial(KEY.alice, peer(KEY.bob, BOB), nonce(1));
    const oldReply = must(answer(KEY.bob, TABLE, nonce(2), old.hello)).reply;
    const now = dial(KEY.alice, peer(KEY.bob, BOB), nonce(5));
    expect(tagOf(finish(now.link, oldReply))).toBe("bad_signature");
    expect(tagOf(finish(old.link, oldReply))).toBe("ok");
  });

  test("a reply Bob made for Mallory's connection is refused by Alice: the signature binds both ids", () => {
    const toMallory = dial(KEY.mallory, peer(KEY.bob, BOB), nonce(1));
    const forMallory = must(answer(KEY.bob, TABLE, nonce(2), toMallory.hello)).reply;
    const alices = dial(KEY.alice, peer(KEY.bob, BOB), nonce(1));
    expect(tagOf(finish(alices.link, forMallory))).toBe("bad_signature");
  });

  test("a finish by another key, a finish of another connection, and a reply passed off as one are refused", () => {
    const dialed = dial(KEY.alice, peer(KEY.bob, BOB), nonce(1));
    const answered = must(answer(KEY.bob, TABLE, nonce(2), dialed.hello));
    const finished = must(finish(dialed.link, answered.reply));
    const other = must(answer(KEY.bob, TABLE, nonce(9), dialed.hello));
    expect(tagOf(accept(other.link, finished.finish))).toBe("bad_signature");
    const mallory = dial(KEY.mallory, peer(KEY.bob, BOB), nonce(1));
    const theirs = must(answer(KEY.bob, TABLE, nonce(2), mallory.hello));
    const byMallory = must(finish(mallory.link, theirs.reply)).finish;
    expect(tagOf(accept(answered.link, byMallory))).toBe("bad_signature");
    const asFinish = encodeValue({ _tag: "finish", sig: JSON.parse("{}") });
    expect(asFinish.ok && tagOf(accept(answered.link, asFinish.value))).toBe("unreadable");
  });

  test("a finish made for a connection to Bob is refused by Carol, though she gave the same challenge", () => {
    const carol = keyFrom(5);
    const table = [...TABLE, peer(carol, entityOf(8))];
    const dialed = dial(KEY.alice, peer(KEY.bob, BOB), nonce(1));
    const forBob = must(finish(dialed.link, must(answer(KEY.bob, table, nonce(2), dialed.hello)).reply)).finish;
    const atCarol = must(answer(carol, table, nonce(2), dialed.hello));
    expect(tagOf(accept(atCarol.link, forBob))).toBe("bad_signature");
  });

  test("a Runtime that dials its own address cannot be answered with its own reply passed off as the finish", () => {
    const self = [peer(KEY.alice, ALICE)];
    const dialed = dial(KEY.alice, peer(KEY.alice, ALICE), nonce(1));
    const answered = must(answer(KEY.alice, self, nonce(2), dialed.hello));
    const reply = decodeValue(answered.reply);
    const asFinish = reply.ok ? encodeValue({ _tag: "finish", sig: (reply.value as { sig: unknown }).sig }) : reply;
    expect(asFinish.ok && tagOf(accept(answered.link, asFinish.value))).toBe("bad_signature");
  });

  test("a record before the handshake is done, and a handshake move out of order, are refused", () => {
    const dialed = dial(KEY.alice, peer(KEY.bob, BOB), nonce(1));
    const answered = must(answer(KEY.bob, TABLE, nonce(2), dialed.hello));
    const { initiator } = connect(KEY.alice, KEY.bob);
    const sealed = must(seal(initiator, ack(ALICE, BOB))).data;
    expect(openRecord(answered.link, sealed)).toEqual(err({ _tag: "wrong_state", state: "answered" }));
    expect(tagOf(finish(answered.link, answered.reply))).toBe("wrong_state");
    expect(tagOf(accept(initiator, "{}"))).toBe("wrong_state");
    expect(tagOf(seal(dialed.link, ack(ALICE, BOB)))).toBe("wrong_state");
  });
});

describe("host/shell/link a record is the peer's own, once, and from an Entity the peer speaks for", () => {
  const { initiator, responder } = connect(KEY.alice, KEY.bob);
  const sealed = must(seal(initiator, ack(ALICE, BOB)));

  test("a record altered in any way is refused: the MAC covers the count and the message", () => {
    const text = sealed.data;
    expect(tagOf(openRecord(responder, text.replace('"n":1', '"n":2')))).toBe("bad_mac");
    expect(tagOf(openRecord(responder, text.replace("cdcd", "cdce")))).toBe("bad_mac");
    expect(tagOf(openRecord(responder, "{"))).toBe("unreadable");
    expect(tagOf(openRecord(responder, '{"_tag":"data"}'))).toBe("unreadable");
  });

  test("a record sealed by another Runtime, and a record turned back on its sender, are refused", () => {
    const other = connect(KEY.mallory, KEY.bob).initiator;
    expect(tagOf(openRecord(responder, must(seal(other, ack(ALICE, BOB))).data))).toBe("bad_mac");
    expect(tagOf(openRecord(initiator, sealed.data))).toBe("bad_mac");
  });

  test("a record heard twice is dropped the second time, and a later record is still heard", () => {
    const heard = must(openRecord(responder, sealed.data));
    expect(openRecord(heard.link, sealed.data)).toEqual(err({ _tag: "replay", count: 1, heard: 1 }));
    const next = must(seal(sealed.link, ack(ALICE, BOB)));
    expect(tagOf(openRecord(heard.link, next.data))).toBe("ok");
  });

  test("a sealed text that is not a message, or is from an Entity the peer does not speak for, is refused", () => {
    const junk = { from: ALICE, to: BOB, msg: { _tag: "ack", hash: "nothex" } } as never;
    expect(tagOf(openRecord(responder, must(seal(initiator, junk)).data))).toBe("unreadable");
    const claimed = must(seal(initiator, ack(MALLORY, BOB)));
    const refused = err({ _tag: "not_theirs", from: MALLORY, runtime: KEY.alice.runtime } as const);
    expect(openRecord(responder, claimed.data)).toEqual(refused);
  });

  test("a key that is not a private key is not a key", () => {
    expect(keyOf(new Uint8Array(32))).toEqual(err({ _tag: "bad_key" }));
    expect(keyOf(new Uint8Array(5))).toEqual(err({ _tag: "bad_key" }));
    expect(keyOf(nonce(1)).ok).toBe(true);
    expect(ok(1).ok).toBe(true);
  });
});

describe("host/shell/link R-LINK-AUTH a stranger's message does not reach a Host as a peer's", () => {
  // Alice has sent a frame to Bob and waits for his ack. Mallory, a Runtime of the table that speaks for Mallory only,
  // has a session with Alice's node and sends Bob's real ack, hash and all, naming Bob as its sender.
  const world = (() => {
    const start = tell(tell(meet(ALICE, BOB), ALICE, open(BOB)), BOB, open(ALICE));
    const proposed = tell(start, ALICE, credit(BOB, 100n));
    const frame = proposed.link.find((m) => m.to === BOB) ?? expect.unreachable("frame");
    const bobsTurn = turn(receive(start.hosts.get(BOB) ?? expect.unreachable("bob"), frame).host, 600n);
    const reack = bobsTurn.sent.find((m) => m.to === ALICE) ?? expect.unreachable("ack");
    return { proposed, frame, reack };
  })();

  const aliceHost = world.proposed.hosts.get(ALICE) ?? expect.unreachable("alice");
  const headOf = (host: typeof aliceHost) => host.runtime.entities.get(ALICE)?.accounts.get(BOB)?.head;

  test("the ack of a real frame, sealed by Mallory's session as Bob's, is refused before Host.receive", () => {
    const fromMallory = connect(KEY.mallory, KEY.alice, [peer(KEY.alice, ALICE), peer(KEY.mallory, MALLORY)]);
    const forged = must(seal(fromMallory.initiator, world.reack));
    const heard = hear(aliceHost, fromMallory.responder, forged.data);
    expect(heard).toEqual(err({ _tag: "not_theirs", from: BOB, runtime: KEY.mallory.runtime }));
    expect(unhalted(begin(aliceHost, stamp(500n))).effects).toEqual([]);
  });

  test("the same ack on a session Bob's Runtime proved is delivered, and Alice's head moves", () => {
    const fromBob = connect(KEY.bob, KEY.alice, [peer(KEY.alice, ALICE), peer(KEY.bob, BOB)]);
    const heard = must(hear(aliceHost, fromBob.responder, must(seal(fromBob.initiator, world.reack)).data));
    expect(heard.notices).toEqual([]);
    const done = unhalted(persisted(unhalted(begin(heard.host, stamp(501n))).host));
    expect(headOf(done.host)).not.toBe(headOf(aliceHost));
  });

  test("a frame heard twice in one session, as one record and as two, changes the Account once", () => {
    const toBob = connect(KEY.alice, KEY.bob, [peer(KEY.alice, ALICE), peer(KEY.bob, BOB)]);
    const bobHost = hostFor(BOB);
    const first = must(seal(toBob.initiator, world.frame));
    const second = must(seal(first.link, world.frame));
    const once = must(hear(bobHost, toBob.responder, first.data));
    expect(hear(once.host, once.link, first.data)).toEqual(err({ _tag: "replay", count: 1, heard: 1 }));
    const twice = must(hear(once.host, once.link, second.data));
    expect(twice.notices).toEqual([]);
    const bobOnce = turn(once.host, 700n).host;
    const bobTwice = turn(twice.host, 700n).host;
    const headAt = (host: typeof bobHost) => host.runtime.entities.get(BOB)?.accounts.get(ALICE)?.head;
    expect(headAt(bobOnce)).not.toBe(GENESIS);
    expect(headAt(bobTwice)).toBe(headAt(bobOnce));
  });
});
