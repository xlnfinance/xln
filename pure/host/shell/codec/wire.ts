// A message as it crosses the link, and the one place a message from a stranger is read (Q-T-6): text in, an Outbound
// out or a refusal, before the Runtime or the Host has seen it. The text is value.ts's, so bigints and bytes survive;
// everything else is checked here, field by field, with exactly the keys the type has and the bounds the Runtime and
// the ledger do not give (a count, a length). What the ledger judges (an amount, a deadline's meaning) stays the
// ledger's: here a number is only a number of the right kind.
import { MAX_ROUTE_HOPS, type AccountTx } from "../../../account/tx.ts";
import type { Msg, Frame, FrameHash } from "../../../account/frame/frame.ts";
import { jHeight, type JHeight } from "../../../account/clause/clock.ts";
import {
  holdId, tokenId, type Hold, type HoldId, type Leg, type Offer, type Side, type TokenId,
} from "../../../account/model.ts";
import { entityId, type EntityId, type Outbound } from "../../../entity/model.ts";
import { all, err, flatMap, map, mapErr, ok, traverse, type Result } from "../../../kernel/core/result.ts";
import type { Tagged } from "../../../kernel/core/tagged.ts";
import { bad, big, bytesOf, count, field, record, text, type Fields, type Reader, type ReadFault } from "./read.ts";
import { decodeValue, encodeValue, type ValueFault } from "./value.ts";

/** The most a message may be, as text, and the most txs a frame may carry: bounds of the link, not of the Account. */
export const MAX_WIRE_BYTES = 1 << 20;
export const MAX_FRAME_TXS = 256;
const MAX_FAULT_TAG = 64;
const SECRET_BYTES = 32;
const HEX32 = /^0x[0-9a-f]{64}$/;

const hash: Reader<FrameHash> = (at, v) =>
  (typeof v === "string" && HEX32.test(v) ? ok(v as FrameHash) : bad(at, "hash"));
const hashlock: Reader<string> = (at, v) =>
  (typeof v === "string" && HEX32.test(v) ? ok(v) : bad(at, "hashlock"));

const side: Reader<Side> = (at, v) => (v === "left" || v === "right" ? ok(v) : bad(at, "left|right"));

const token: Reader<TokenId> = (at, v) =>
  flatMap(big(at, v), (n) => mapErr(tokenId(n), () => ({ _tag: "bad_shape", at, want: "token" }) as const));

const hold: Reader<HoldId> = (at, v) =>
  flatMap(big(at, v), (n) => (n >= 0n ? ok(holdId(n)) : bad(at, "slot")));

const height: Reader<JHeight> = (at, v) =>
  flatMap(big(at, v), (n) => mapErr(jHeight(n), () => ({ _tag: "bad_shape", at, want: "height" }) as const));

const entity: Reader<EntityId> = (at, v) =>
  flatMap(text(at, v), (t) => mapErr(entityId(t), () => ({ _tag: "bad_shape", at, want: "entity id" }) as const));

const secret = bytesOf(SECRET_BYTES);

const HOLD_KEYS = ["id", "payer", "amount", "hashlock", "deadline"];

const readHold: Reader<Hold> = (at, v) => flatMap(record(at, v, HOLD_KEYS), (o) =>
  all({
    id: field(at, o, "id", hold), payer: field(at, o, "payer", side), amount: field(at, o, "amount", big),
    hashlock: field(at, o, "hashlock", hashlock), deadline: field(at, o, "deadline", height),
  }));

/** The ids a lock's route names, at most MAX_ROUTE_HOPS of them: a longer one is not a lock a peer may send. */
const readRoute: Reader<readonly string[]> = (at, v) => {
  if (!Array.isArray(v) || v.length > MAX_ROUTE_HOPS) return bad(at, `at most ${MAX_ROUTE_HOPS} entity ids`);
  return traverse(v, (id, i) => entity(`${at}[${i}]`, id));
};

const readLeg: Reader<Leg> = (at, v) => flatMap(record(at, v, ["token", "amount"]), (o) =>
  all({ token: field(at, o, "token", token), amount: field(at, o, "amount", big) }));

const readOffer: Reader<Offer> = (at, v) => flatMap(record(at, v, ["id", "maker", "give", "want", "deadline"]), (o) =>
  all({
    id: field(at, o, "id", hold), maker: field(at, o, "maker", side), give: field(at, o, "give", readLeg),
    want: field(at, o, "want", readLeg), deadline: field(at, o, "deadline", height),
  }));

const tagOf = (at: string, v: unknown): Result<string, ReadFault> =>
  (typeof v === "object" && v !== null && "_tag" in v ? text(`${at}._tag`, v._tag) : bad(at, "tagged"));

const txOf = (tag: string, at: string, o: Fields): Result<AccountTx, ReadFault> => {
  const f = <T>(key: string, read: Reader<T>) => field(at, o, key, read);
  switch (tag) {
    case "pay": return all({ _tag: ok("pay" as const), token: f("token", token), amount: f("amount", big) });
    case "set_credit":
      return all({ _tag: ok("set_credit" as const), token: f("token", token), limit: f("limit", big) });
    case "lock": return Object.hasOwn(o, "route")
      ? all({
        _tag: ok("lock" as const), token: f("token", token), hold: f("hold", readHold), route: f("route", readRoute),
      })
      : all({ _tag: ok("lock" as const), token: f("token", token), hold: f("hold", readHold) });
    case "resolve":
      return all({
        _tag: ok("resolve" as const), token: f("token", token), id: f("id", hold), secret: f("secret", secret),
      });
    case "cancel": return all({ _tag: ok("cancel" as const), token: f("token", token), id: f("id", hold) });
    case "expire": return all({ _tag: ok("expire" as const), token: f("token", token), id: f("id", hold) });
    case "offer": return all({ _tag: ok("offer" as const), offer: f("offer", readOffer) });
    case "fill": return all({ _tag: ok("fill" as const), id: f("id", hold), ratio: f("ratio", count) });
    case "retract": return all({ _tag: ok("retract" as const), id: f("id", hold) });
    default: return all({ _tag: ok("lapse" as const), id: f("id", hold) });
  }
};

const KEYS: Readonly<Record<string, readonly string[]>> = {
  pay: ["token", "amount"], set_credit: ["token", "limit"], lock: ["token", "hold"],
  resolve: ["token", "id", "secret"], cancel: ["token", "id"], expire: ["token", "id"], offer: ["offer"],
  fill: ["id", "ratio"], retract: ["id"], lapse: ["id"],
};

/** The keys a tx has: a lock has a route too when it names one. */
const keysOf = (tag: string, v: unknown): readonly string[] | undefined => {
  const keys = Object.hasOwn(KEYS, tag) ? KEYS[tag] : undefined;
  const routed = tag === "lock" && typeof v === "object" && v !== null && Object.hasOwn(v, "route");
  return routed ? [...(keys ?? []), "route"] : keys;
};

const readTx: Reader<AccountTx> = (at, v) => flatMap(tagOf(at, v), (tag) => {
  const keys = keysOf(tag, v);
  return keys === undefined ? bad(at, "a tx") : flatMap(record(at, v, ["_tag", ...keys]), (o) => txOf(tag, at, o));
});

/** The chain's epoch and nonce are unsigned integers of the Depository's width. */
const unsigned: Reader<bigint> = (at, v) =>
  flatMap(big(at, v), (n) => (n >= 0n && n < 2n ** 256n ? ok(n) : bad(at, "unsigned 256-bit")));

const FRAME_KEYS = ["author", "parent", "attempt", "slot", "epoch", "firstNonce", "txs"];

const readFrame: Reader<Frame<AccountTx>> = (at, v) => flatMap(record(at, v, FRAME_KEYS), (o) => {
  const txs = o["txs"];
  if (!Array.isArray(txs) || txs.length > MAX_FRAME_TXS) return bad(`${at}.txs`, `at most ${MAX_FRAME_TXS} txs`);
  return all({
    author: field(at, o, "author", side), parent: field(at, o, "parent", hash),
    attempt: field(at, o, "attempt", count), slot: field(at, o, "slot", count),
    epoch: field(at, o, "epoch", unsigned), firstNonce: field(at, o, "firstNonce", unsigned),
    txs: traverse(txs, (tx, i) => readTx(`${at}.txs[${i}]`, tx)),
  });
});

const faultTag: Reader<string> = (at, v) =>
  flatMap(text(at, v), (t) => (t.length <= MAX_FAULT_TAG ? ok(t) : bad(at, `at most ${MAX_FAULT_TAG} characters`)));

const readMsg: Reader<Msg<AccountTx>> = (at, v) => flatMap(tagOf(at, v), (tag): Result<Msg<AccountTx>, ReadFault> => {
  switch (tag) {
    case "frame": return flatMap(record(at, v, ["_tag", "frame"]), (o) =>
      all({ _tag: ok("frame" as const), frame: field(at, o, "frame", readFrame) }));
    case "ack": return flatMap(record(at, v, ["_tag", "hash"]), (o) =>
      all({ _tag: ok("ack" as const), hash: field(at, o, "hash", hash) }));
    case "refusal": return flatMap(record(at, v, ["_tag", "hash", "index", "fault", "mark", "floor"]), (o) =>
      all({
        _tag: ok("refusal" as const), hash: field(at, o, "hash", hash), index: field(at, o, "index", count),
        fault: field(at, o, "fault", faultTag), mark: field(at, o, "mark", count), floor: field(at, o, "floor", count),
      }));
    default: return bad(at, "frame|ack|refusal");
  }
});

/** A signature is a Hanko as hex text, at most `MAX_SIG_CHARS` long: what it says is the Entity's to judge. */
const MAX_SIG_CHARS = 2048;
const sig: Reader<string> = (at, v) =>
  (typeof v === "string" && v.length <= MAX_SIG_CHARS && /^0x[0-9a-f]*$/.test(v) ? ok(v) : bad(at, "a hex signature"));

/** A message carries a signature when its sender signed the head it commits to; no other field crosses. */
const readOutbound: Reader<Outbound> = (at, v) => {
  const signed = typeof v === "object" && v !== null && Object.hasOwn(v, "sig");
  return flatMap(record(at, v, signed ? ["from", "to", "msg", "sig"] : ["from", "to", "msg"]), (o) => {
    const base = all({
      from: field(at, o, "from", entity), to: field(at, o, "to", entity), msg: field(at, o, "msg", readMsg),
    });
    return signed ? flatMap(base, (m) => map(field(at, o, "sig", sig), (s): Outbound => ({ ...m, sig: s }))) : base;
  });
};

/** The text a message goes as: sender, recipient, message and signature; the head it is signed over stays home. */
export const writeOutbound = (message: Outbound): Result<string, ValueFault> => {
  const { from, to, msg, sig: signature } = message;
  return encodeValue({ from, to, msg, ...(signature === undefined ? {} : { sig: signature }) });
};

/** The message in `text`, or why it is not one: over the bound, not text of ours, or not the shape of a message. */
export const readWire = (wire: string): Result<Outbound, ReadFault> => {
  if (wire.length > MAX_WIRE_BYTES) return err({ _tag: "too_big", bytes: wire.length });
  const value = decodeValue(wire);
  return value.ok ? readOutbound("$", value.value) : err({ _tag: "bad_text", fault: value.error });
};
