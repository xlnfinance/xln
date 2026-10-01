// The link between two Runtimes: the peer is proved once, every record after it is sealed to the proof, and a message
// reaches a Host only as the proved peer's own (Q-T-5, R-LINK-AUTH). The forged ack and the replay go through the
// shell's receive path, handshake and sealed record first and Host.receive after, with real Hosts.
import { describe, expect, test } from "bun:test";
import { GENESIS } from "../../../account/frame/account.ts";
import { credit, open } from "../../../entity/fixtures.ts";
import type { Outbound } from "../../../entity/model.ts";
import { err, ok, unwrapOr } from "../../../kernel/core/result.ts";
import { begin, persisted, receive } from "../../host.ts";
import { entityOf, meet, stamp, tell, turn, unhalted } from "../../fixtures.ts";
import {
  accept, answer, dial, finish, hear, keyOf, open as openRecord, seal, type Key, type Link, type Peer,
} from "./link.ts";
import { decodeValue, encodeValue } from "../codec/value.ts";

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
  test("R-LINK-AUTH a handshake leaves both Runtimes up, and records open in both directions", () => {
    const { initiator, responder } = connect(KEY.alice, KEY.bob);
    const forth = must(seal(initiator, ack(ALICE, BOB)));
    const arrived = must(openRecord(responder, forth.data));
    expect(arrived.message).toEqual(ack(ALICE, BOB));
    const back = must(seal(arrived.link, ack(BOB, ALICE)));
    expect(must(openRecord(forth.link, back.data)).message).toEqual(ack(BOB, ALICE));
  });

  test("R-X1 a hello, a reply and a finish nested thousands deep or far over the bound are refused, not thrown", () => {
    const deep = "[".repeat(10_000) + "]".repeat(10_000);
    const dialed = dial(KEY.alice, peer(KEY.bob, BOB), nonce(10));
    expect(answer(KEY.bob, TABLE, nonce(11), deep)).toMatchObject({ ok: false, error: { _tag: "unreadable" } });
    const long = "x".repeat(5000);
    expect(answer(KEY.bob, TABLE, nonce(11), long)).toMatchObject({ ok: false, error: { _tag: "unreadable" } });
    expect(finish(dialed.link, deep)).toMatchObject({ ok: false, error: { _tag: "unreadable" } });
    const answered = must(answer(KEY.bob, TABLE, nonce(11), dialed.hello));
    expect(accept(answered.link, deep)).toMatchObject({ ok: false, error: { _tag: "unreadable" } });
  });

  test("R-LINK-AUTH a hello from a Runtime that is not in the table is refused", () => {
    const hello = dial(KEY.stranger, peer(KEY.bob, BOB), nonce(1)).hello;
    const refused = err({ _tag: "unknown_runtime", runtime: KEY.stranger.runtime } as const);
    expect(answer(KEY.bob, TABLE, nonce(2), hello)).toEqual(refused);
  });

  test("R-LINK-AUTH an impostor answering for Bob, with another key than the table names, is refused", () => {
    const dialed = dial(KEY.alice, peer(KEY.bob, BOB), nonce(1));
    const impostorTable = [peer(KEY.alice, ALICE), { ...peer(KEY.stranger, BOB), runtime: KEY.stranger.runtime }];
    const reply = must(answer(KEY.stranger, impostorTable, nonce(2), dialed.hello)).reply;
    expect(tagOf(finish(dialed.link, reply))).toBe("bad_signature");
  });

  test("R-LINK-AUTH a reply of an earlier connection, replayed to this one, is refused", () => {
    const old = dial(KEY.alice, peer(KEY.bob, BOB), nonce(1));
    const oldReply = must(answer(KEY.bob, TABLE, nonce(2), old.hello)).reply;
    const now = dial(KEY.alice, peer(KEY.bob, BOB), nonce(5));
    expect(tagOf(finish(now.link, oldReply))).toBe("bad_signature");
    expect(tagOf(finish(old.link, oldReply))).toBe("ok");
  });

  test("R-LINK-AUTH a reply Bob made for Mallory's connection is refused by Alice: both ids are bound", () => {
    const toMallory = dial(KEY.mallory, peer(KEY.bob, BOB), nonce(1));
    const forMallory = must(answer(KEY.bob, TABLE, nonce(2), toMallory.hello)).reply;
    const alices = dial(KEY.alice, peer(KEY.bob, BOB), nonce(1));
    expect(tagOf(finish(alices.link, forMallory))).toBe("bad_signature");
  });

  test("R-LINK-AUTH a finish by another key, of another connection, or a reply passed off as one, is refused", () => {
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

  test("R-LINK-AUTH a finish made for a connection to Bob is refused by Carol with the same challenge", () => {
    const carol = keyFrom(5);
    const table = [...TABLE, peer(carol, entityOf(8))];
    const dialed = dial(KEY.alice, peer(KEY.bob, BOB), nonce(1));
    const forBob = must(finish(dialed.link, must(answer(KEY.bob, table, nonce(2), dialed.hello)).reply)).finish;
    const atCarol = must(answer(carol, table, nonce(2), dialed.hello));
    expect(tagOf(accept(atCarol.link, forBob))).toBe("bad_signature");
  });

  test("R-LINK-AUTH a Runtime dialing itself cannot pass its reply off as the finish", () => {
    const self = [peer(KEY.alice, ALICE)];
    const dialed = dial(KEY.alice, peer(KEY.alice, ALICE), nonce(1));
    const answered = must(answer(KEY.alice, self, nonce(2), dialed.hello));
    const reply = decodeValue(answered.reply);
    const asFinish = reply.ok ? encodeValue({ _tag: "finish", sig: (reply.value as { sig: unknown }).sig }) : reply;
    expect(asFinish.ok && tagOf(accept(answered.link, asFinish.value))).toBe("bad_signature");
  });

  test("R-LINK-AUTH a record before the handshake is done, and a move out of order, are refused", () => {
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

  test("R-LINK-AUTH a record altered in any way is refused: the MAC covers the count and the message", () => {
    const text = sealed.data;
    expect(tagOf(openRecord(responder, text.replace('"n":1', '"n":2')))).toBe("bad_mac");
    expect(tagOf(openRecord(responder, text.replace("cdcd", "cdce")))).toBe("bad_mac");
    expect(tagOf(openRecord(responder, "{"))).toBe("unreadable");
    expect(tagOf(openRecord(responder, '{"_tag":"data"}'))).toBe("unreadable");
  });

  test("R-LINK-AUTH a record sealed by another Runtime, or turned back on its sender, is refused", () => {
    const other = connect(KEY.mallory, KEY.bob).initiator;
    expect(tagOf(openRecord(responder, must(seal(other, ack(ALICE, BOB))).data))).toBe("bad_mac");
    expect(tagOf(openRecord(initiator, sealed.data))).toBe("bad_mac");
  });

  test("R-LINK-AUTH a record heard twice is dropped the second time, and a later record is still heard", () => {
    const heard = must(openRecord(responder, sealed.data));
    expect(openRecord(heard.link, sealed.data)).toEqual(err({ _tag: "replay", count: 1, heard: 1 }));
    const next = must(seal(sealed.link, ack(ALICE, BOB)));
    expect(tagOf(openRecord(heard.link, next.data))).toBe("ok");
  });

  test("R-LINK-AUTH a sealed text that is no message, or is not the peer's to send, is refused", () => {
    const junk = { from: ALICE, to: BOB, msg: { _tag: "ack", hash: "nothex" } } as never;
    expect(tagOf(openRecord(responder, must(seal(initiator, junk)).data))).toBe("unreadable");
    const claimed = must(seal(initiator, ack(MALLORY, BOB)));
    const refused = err({ _tag: "not_theirs", from: MALLORY, runtime: KEY.alice.runtime } as const);
    expect(openRecord(responder, claimed.data)).toEqual(refused);
  });

  test("R-X1 a text nested thousands deep, or far over the bound, is refused before anything is believed", () => {
    const deep = "[".repeat(10_000) + "]".repeat(10_000);
    expect(openRecord(responder, deep)).toMatchObject({ ok: false, error: { _tag: "unreadable" } });
    const huge = "x".repeat(8 * 1024 * 1024);
    const refused = { ok: false, error: { _tag: "unreadable", fault: { _tag: "too_big" } } };
    expect(openRecord(responder, huge)).toMatchObject(refused);
  });

  test("R-X1 a tx tag that every object has is no message: refused, and the link still hears the next record", () => {
    const hash = `0x${"ab".repeat(32)}`;
    const forged = (tag: string) => ({
      from: ALICE, to: BOB,
      msg: {
        _tag: "frame",
        frame: { author: "left", parent: hash, attempt: 0, slot: 1, epoch: 0n, firstNonce: 0n, txs: [{ _tag: tag }] },
      },
    }) as never;
    ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"].forEach((tag) => {
      expect(openRecord(responder, must(seal(initiator, forged(tag))).data))
        .toMatchObject({ ok: false, error: { _tag: "unreadable" } });
    });
    expect(tagOf(openRecord(responder, sealed.data))).toBe("ok");
  });

  test("R-LINK-AUTH a key that is not a private key is not a key", () => {
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
    const bob = start.hosts.get(BOB) ?? expect.unreachable("bob");
    return { proposed, frame, reack, bob };
  })();

  const aliceHost = world.proposed.hosts.get(ALICE) ?? expect.unreachable("alice");
  const headOf = (host: typeof aliceHost) => host.runtime.entities.get(ALICE)?.accounts.get(BOB)?.head;

  test("R-LINK-AUTH a real frame's ack, sealed by Mallory's session as Bob's, is refused before Host.receive", () => {
    const fromMallory = connect(KEY.mallory, KEY.alice, [peer(KEY.alice, ALICE), peer(KEY.mallory, MALLORY)]);
    const forged = must(seal(fromMallory.initiator, world.reack));
    const heard = hear(aliceHost, fromMallory.responder, forged.data);
    expect(heard).toEqual(err({ _tag: "not_theirs", from: BOB, runtime: KEY.mallory.runtime }));
    expect(unhalted(begin(aliceHost, stamp(500n))).effects).toEqual([]);
  });

  test("R-LINK-AUTH the same ack on a session Bob's Runtime proved is delivered, and Alice's head moves", () => {
    const fromBob = connect(KEY.bob, KEY.alice, [peer(KEY.alice, ALICE), peer(KEY.bob, BOB)]);
    const heard = must(hear(aliceHost, fromBob.responder, must(seal(fromBob.initiator, world.reack)).data));
    expect(heard.notices).toEqual([]);
    const done = unhalted(persisted(unhalted(begin(heard.host, stamp(501n))).host));
    expect(headOf(done.host)).not.toBe(headOf(aliceHost));
  });

  test("R-LINK-AUTH a frame heard twice in one session, as one record and as two, changes the Account once", () => {
    const toBob = connect(KEY.alice, KEY.bob, [peer(KEY.alice, ALICE), peer(KEY.bob, BOB)]);
    const bobHost = world.bob;
    const first = must(seal(toBob.initiator, world.frame));
    const second = must(seal(first.link, world.frame));
    const once = must(hear(bobHost, toBob.responder, first.data));
    expect(hear(once.host, once.link, first.data)).toEqual(err({ _tag: "replay", count: 1, heard: 1 }));
    const twice = must(hear(once.host, once.link, second.data));
    expect(twice.notices).toEqual([]);
    const bobOnce = turn(once.host, 700n).host;
    const bobTwice = turn(twice.host, 700n).host;
    const headAt = (host: typeof bobHost) => host.runtime.entities.get(BOB)?.accounts.get(ALICE)?.head;
    expect(headAt(bobHost)).toBe(GENESIS);
    expect(headAt(bobOnce)).toBeDefined();
    expect(headAt(bobOnce)).not.toBe(GENESIS);
    expect(headAt(bobTwice)).toBe(headAt(bobOnce));
  });

  test("R-FRAME-EPOCH a frame changed in epoch or first nonce after signing is refused, the Account stays", () => {
    const toBob = connect(KEY.alice, KEY.bob, [peer(KEY.alice, ALICE), peer(KEY.bob, BOB)]);
    const proposed = world.frame.msg._tag === "frame" ? world.frame.msg.frame : expect.unreachable("a frame");
    const changed = (patch: Partial<typeof proposed>): Outbound =>
      ({ ...world.frame, msg: { _tag: "frame", frame: { ...proposed, ...patch } } });
    const headAt = (host: typeof world.bob) => host.runtime.entities.get(BOB)?.accounts.get(ALICE)?.head;
    [{ epoch: proposed.epoch + 1n }, { firstNonce: proposed.firstNonce + 1n }].forEach((patch) => {
      const heard = must(hear(world.bob, toBob.responder, must(seal(toBob.initiator, changed(patch))).data));
      const bobsTurn = turn(heard.host, 700n);
      expect(headAt(bobsTurn.host)).toBe(GENESIS);
      expect(bobsTurn.sent.map((m) => m.msg._tag)).toEqual(["refusal"]);
    });
    const same = must(hear(world.bob, toBob.responder, must(seal(toBob.initiator, changed({}))).data));
    expect(headAt(turn(same.host, 700n).host)).not.toBe(GENESIS);
  });
});
