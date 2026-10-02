// What crosses the link: every message a Runtime makes comes back as it went, and what a stranger can write is refused
// at the first field that is wrong, before the Host or a Runtime has seen it (Q-T-6).
import { describe, expect, test } from "bun:test";
import { holdOf, secretOf } from "../../../account/fixtures.ts";
import type { Hold, Offer } from "../../../account/model.ts";
import { MAX_ROUTE_HOPS, type AccountTx } from "../../../account/tx.ts";
import type { Outbound } from "../../../entity/model.ts";
import { GOLD } from "../../../runtime/fixtures.ts";
import { aliceRun, ALICE, BOB, bobRun, walOf } from "../fixtures.ts";
import { MAX_FRAME_TXS, MAX_WIRE_BYTES, readWire, writeOutbound } from "./wire.ts";
import { encodeValue } from "./value.ts";

const sent = [...walOf(aliceRun, ALICE), ...walOf(bobRun, BOB)].flatMap((row) => row.outputs);

const wire = (message: unknown): string => {
  const text = encodeValue(message);
  return text.ok ? text.value : expect.unreachable("encode");
};

const hash = `0x${"ab".repeat(32)}`;
const SIG = `0x${"cd".repeat(65)}`;
const SIGNED_IN = { epoch: 1n, firstNonce: 3n };
const HOLD: Hold = holdOf("left", 30n, 1n, 115n, 1);
const OFFER: Offer = {
  id: HOLD.id, maker: "right", give: { token: GOLD, amount: 5n }, want: { token: GOLD, amount: 7n },
  deadline: HOLD.deadline,
};

const ALL_TXS: readonly AccountTx[] = [
  { _tag: "pay", token: GOLD, amount: 5n },
  { _tag: "set_credit", token: GOLD, limit: 2n ** 200n },
  { _tag: "lock", token: GOLD, hold: HOLD },
  { _tag: "lock", token: GOLD, hold: HOLD, route: [ALICE, BOB] },
  { _tag: "resolve", token: GOLD, id: HOLD.id, secret: secretOf(1) },
  { _tag: "cancel", token: GOLD, id: HOLD.id },
  { _tag: "expire", token: GOLD, id: HOLD.id },
  { _tag: "offer", offer: OFFER },
  { _tag: "fill", id: HOLD.id, ratio: 65535 },
  { _tag: "retract", id: HOLD.id },
  { _tag: "lapse", id: HOLD.id },
];

const BODY = { author: "left", parent: hash, attempt: 0, slot: 1, ...SIGNED_IN, txs: [] };

/** A frame message whose body is the one above with `patch` laid over it. */
const frameWith = (patch: Record<string, unknown>): unknown =>
  ({ from: ALICE, to: BOB, msg: { _tag: "frame", frame: { ...BODY, ...patch } } });

const framed = (txs: readonly unknown[]): unknown => frameWith({ txs });

const badTx = (tx: unknown) => first(wire(framed([tx])));

const first = (text: string) => {
  const read = readWire(text);
  return read.ok ? undefined : read.error;
};

describe("host/shell/wire a message comes back as it went", () => {
  test("every message of two real Runtimes crosses the link unchanged", () => {
    expect(sent.length).toBeGreaterThan(3);
    sent.forEach((message) => {
      const text = writeOutbound(message);
      const { attest: _head, ...onTheLink } = message;
      expect(text.ok && readWire(text.value)).toEqual({ ok: true, value: onTheLink });
    });
    expect(new Set(sent.map((m) => m.msg._tag))).toEqual(new Set(["frame", "ack"]));
  });

  test("R-SIGNED-HEADS-ON-THE-WIRE a signed message crosses with its signature and the head stays home", () => {
    const named = sent.filter((m) => m.attest !== undefined);
    expect(named.length).toBeGreaterThan(1);
    named.forEach((message) => {
      const text = writeOutbound({ ...message, sig: SIG });
      const read = text.ok ? readWire(text.value) : expect.unreachable("encode");
      expect(read).toEqual({ ok: true, value: { from: message.from, to: message.to, msg: message.msg, sig: SIG } });
      expect(Object.hasOwn(read.ok ? read.value : {}, "attest")).toBe(false);
    });
  });

  test("R-SIGNED-HEADS-ON-THE-WIRE a signature that is no hex, too long, or has a stray key is refused", () => {
    const body = { from: ALICE, to: BOB, msg: { _tag: "ack", hash } };
    expect(first(wire({ ...body, sig: SIG }))).toBeUndefined();
    expect(first(wire({ ...body, sig: "not hex" }))).toMatchObject({ _tag: "bad_shape", at: "$.sig" });
    expect(first(wire({ ...body, sig: `0x${"ab".repeat(1025)}` }))).toMatchObject({ _tag: "bad_shape", at: "$.sig" });
    expect(first(wire({ ...body, sig: 7 }))).toMatchObject({ _tag: "bad_shape", at: "$.sig" });
    expect(first(wire({ ...body, sig: SIG, attest: hash }))).toMatchObject({ _tag: "bad_shape" });
  });

  test("every kind of tx, and a refusal, crosses unchanged", () => {
    const message = framed(ALL_TXS) as Outbound;
    const refusal = { _tag: "refusal", hash, index: 3, fault: "stale_slot", mark: 2, floor: 9 };
    [message, { from: BOB, to: ALICE, msg: refusal } as Outbound].forEach((m) => {
      const text = writeOutbound(m);
      expect(text.ok && readWire(text.value)).toEqual({ ok: true, value: m });
    });
  });
});

describe("host/shell/wire what a stranger can write is refused at the first wrong field", () => {
  test("text over the bound, text that is not ours, and a value that is not a message", () => {
    expect(first("x".repeat(MAX_WIRE_BYTES + 1))).toEqual({ _tag: "too_big", bytes: MAX_WIRE_BYTES + 1 });
    expect(first("not json")).toMatchObject({ _tag: "bad_text" });
    expect(first("[]")).toMatchObject({ _tag: "bad_shape", at: "$" });
    expect(first("null")).toMatchObject({ _tag: "bad_shape" });
    expect(first('{"__proto__":{"x":1}}')).toMatchObject({ _tag: "bad_shape" });
  });

  test("R-X1 a tx tag that is a property of every object is a wrong shape, never a thrown error", () => {
    ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"].forEach((tag) => {
      expect(badTx({ _tag: tag })).toMatchObject({ _tag: "bad_shape", at: "$.msg.frame.txs[0]" });
    });
  });

  test("a missing key, an extra key and a key of the wrong kind are each named with their place", () => {
    const base = framed([{ _tag: "pay", token: GOLD, amount: 5n }]) as { msg: { frame: { txs: unknown[] } } };
    expect(badTx({ _tag: "pay", token: GOLD })).toMatchObject({ at: "$.msg.frame.txs[0]" });
    expect(badTx({ _tag: "pay", token: GOLD, amount: 5n, extra: 1 })).toMatchObject({ _tag: "bad_shape" });
    expect(badTx({ _tag: "pay", token: GOLD, amount: 5 })).toEqual(
      { _tag: "bad_shape", at: "$.msg.frame.txs[0].amount", want: "bigint" });
    expect(badTx({ _tag: "nope" })).toMatchObject({ at: "$.msg.frame.txs[0]" });
    expect(first(wire({ ...base, to: "bob" }))).toEqual({ _tag: "bad_shape", at: "$.to", want: "entity id" });
    expect(first(wire({ ...base, extra: 1 }))).toMatchObject({ _tag: "bad_shape", at: "$" });
  });

  test("R-LOCK-ROUTE a lock's route is a list of entity ids at most MAX_ROUTE_HOPS long, and nothing else", () => {
    const lock = (route: unknown) => badTx({ _tag: "lock", token: GOLD, hold: HOLD, route });
    expect(lock(Array.from({ length: MAX_ROUTE_HOPS }, () => ALICE))).toBeUndefined();
    expect(lock(Array.from({ length: MAX_ROUTE_HOPS + 1 }, () => ALICE)))
      .toMatchObject({ _tag: "bad_shape", at: "$.msg.frame.txs[0].route" });
    expect(lock([ALICE, "bob"])).toEqual({ _tag: "bad_shape", at: "$.msg.frame.txs[0].route[1]", want: "entity id" });
    expect(lock("alice")).toMatchObject({ _tag: "bad_shape", at: "$.msg.frame.txs[0].route" });
    expect(badTx({ _tag: "lock", token: GOLD, hold: HOLD, route: [], extra: 1 })).toMatchObject({ _tag: "bad_shape" });
  });

  test("the epoch and first nonce of a frame are unsigned bigints, both present, and cross unchanged", () => {
    const wide = readWire(wire(frameWith({ epoch: 2n ** 255n, firstNonce: 0n })));
    expect(wide).toMatchObject({ ok: true, value: { msg: { frame: { epoch: 2n ** 255n, firstNonce: 0n } } } });
    ["epoch", "firstNonce"].forEach((key) => {
      const at = `$.msg.frame.${key}`;
      expect(first(wire(frameWith({ [key]: 1 })))).toEqual({ _tag: "bad_shape", at, want: "bigint" });
      expect(first(wire(frameWith({ [key]: -1n })))).toMatchObject({ at, want: "unsigned 256-bit" });
      expect(first(wire(frameWith({ [key]: 2n ** 256n })))).toMatchObject({ at });
      expect(first(wire(frameWith({ [key]: undefined })))).toMatchObject({ _tag: "bad_shape" });
    });
    ["epoch", "firstNonce"].forEach((key) => {
      const kept = Object.entries(BODY).filter(([name]) => name !== key);
      const missing = { from: ALICE, to: BOB, msg: { _tag: "frame", frame: Object.fromEntries(kept) } };
      expect(first(wire(missing))).toMatchObject({ _tag: "bad_shape", at: "$.msg.frame" });
    });
  });

  test("a hash, a hold slot, a token, a height, a count and a secret that are not what the type is", () => {
    const frame = (patch: Record<string, unknown>) => wire(frameWith(patch));
    expect(first(frame({ parent: "0xABC" }))).toMatchObject({ at: "$.msg.frame.parent", want: "hash" });
    expect(first(frame({ attempt: -1 }))).toMatchObject({ at: "$.msg.frame.attempt" });
    expect(first(frame({ slot: 1.5 }))).toMatchObject({ at: "$.msg.frame.slot" });
    expect(first(frame({ author: "middle" }))).toMatchObject({ at: "$.msg.frame.author" });
    const lock = (patch: Partial<Hold>) => badTx({ _tag: "lock", token: GOLD, hold: { ...HOLD, ...patch } });
    expect(badTx({ _tag: "cancel", token: GOLD, id: -1n })).toMatchObject({ want: "slot" });
    expect(badTx({ _tag: "cancel", token: 2n ** 256n, id: 1n })).toMatchObject({ want: "token" });
    expect(lock({ deadline: -1n as Hold["deadline"] })).toMatchObject({ want: "height" });
    expect(lock({ hashlock: "0xzz" })).toMatchObject({ want: "hashlock" });
    const short = { _tag: "resolve", token: GOLD, id: 1n, secret: new Uint8Array(31) };
    expect(badTx(short)).toMatchObject({ want: "32 bytes" });
  });

  test("a frame over the count of txs the link carries, and a refusal tag that is too long", () => {
    const txs = Array.from({ length: MAX_FRAME_TXS + 1 }, () => ({ _tag: "retract", id: 1n }));
    expect(first(wire(framed(txs)))).toMatchObject({ at: "$.msg.frame.txs" });
    expect(readWire(wire(framed(txs.slice(1)))).ok).toBe(true);
    const long = { _tag: "refusal", hash, index: 0, fault: "x".repeat(65), mark: 0, floor: 0 };
    expect(first(wire({ from: ALICE, to: BOB, msg: long }))).toMatchObject({ at: "$.msg.fault" });
  });
});
