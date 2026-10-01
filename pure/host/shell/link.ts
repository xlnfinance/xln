// The link between two Runtimes (Q-T-5, R-LINK-AUTH): who is speaking, proved once with a handshake, and every message
// after it sealed to that proof. Nothing here reads a clock, a socket or a source of randomness: the shell hands in the
// nonces, and moves the text.
//
//   hello   initiator -> responder   its runtime id and a fresh nonce (the challenge for the responder)
//   reply   responder -> initiator   a fresh nonce, and its signature over both ids and both nonces
//   finish  initiator -> responder   its signature over the same, in its own role
//   data    either way               a message, the count of the data records sent before it, and a MAC over both
//
// Each signature binds both runtime ids and both nonces, and its role, so one made for another peer, another
// connection, or the other direction proves nothing here. The MAC key comes from the two Runtime keys (ECDH) and
// the nonces, so only the two of them can seal a record. A record whose count is not above the last heard is a replay
// and is dropped; a replay that got through would be a duplicate message, which the Account already answers (Q-T-6).
//
// The runtime table is static (Q-T-4): a Runtime id, the Entities it may speak for, and where it is. A message
// is delivered to the Host only if its `from` is an Entity the authenticated peer speaks for (R-LINK-AUTH): the
// sender field of the text is a claim until the table says whose it can be.
import { secp256k1 } from "@noble/curves/secp256k1";
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha256";
import type { EntityId, Outbound } from "../../entity/model.ts";
import { all, err, flatMap, map, mapErr, ok, type Result } from "../../kernel/core/result.ts";
import { signDigest, recoverPublicKey, addressOf } from "../../kernel/crypto/signature.ts";
import type { Tagged } from "../../kernel/core/tagged.ts";
import { concat, hexToBytes, keccak256, utf8 } from "../../kernel/encoding/bytes.ts";
import { bytesOf, count, field, record, text, type Fields, type ReadFault } from "./read.ts";
import { decodeValue, encodeValue, type ValueFault } from "./value.ts";
import { MAX_WIRE_BYTES, readWire, writeOutbound } from "./wire.ts";
import { receive } from "../host.ts";
import type { Host, HostNotice } from "../model.ts";

/** A Runtime's address: the lower-case Ethereum address of its key. */
export type RuntimeId = string;

export type Key = Readonly<{ secret: Uint8Array; runtime: RuntimeId }>;

export type Peer = Readonly<{ runtime: RuntimeId; entities: readonly EntityId[]; endpoint: string }>;

export type KeyFault = Tagged<"bad_key">;

export type LinkFault =
  | Tagged<"unreadable", { fault: ReadFault | ValueFault }>
  | Tagged<"unknown_runtime", { runtime: string }>
  | Tagged<"bad_signature">
  | Tagged<"wrong_state", { state: Link["_tag"] }>
  | Tagged<"bad_mac">
  | Tagged<"replay", { count: number; heard: number }>
  | Tagged<"not_theirs", { from: EntityId; runtime: RuntimeId }>;

const NONCE = 32;

// A stranger's text is bounded before it is read: the handshake texts hold an address, nonces and a signature, and a
// data record holds one wire text as a string, which JSON may spell with up to six characters for each of its own.
const HANDSHAKE_BYTES = 4096;
const ESCAPED = 6;
const DATA_BYTES = ESCAPED * MAX_WIRE_BYTES + HANDSHAKE_BYTES;
const DOMAIN = "xln/link/v1";

// The curve library's calls take a positional flag; every key in this tree is the 65-byte uncompressed point.
const COMPRESSED = false;

const runtimeOf = (publicKey: Uint8Array): RuntimeId => addressOf(publicKey).toLowerCase();

export const keyOf = (secret: Uint8Array): Result<Key, KeyFault> =>
  (secp256k1.utils.isValidPrivateKey(secret)
    ? ok({ secret, runtime: runtimeOf(secp256k1.getPublicKey(secret, COMPRESSED)) })
    : err({ _tag: "bad_key" }));

type Role = "initiator" | "responder";

type Session = Readonly<{ peer: Peer; mac: Uint8Array; role: Role; sent: number; heard: number }>;

/** Where one connection stands, from one side: before the peer is proved, and after. */
export type Link =
  | Tagged<"dialing", { self: Key; peer: Peer; nonce: Uint8Array }>
  | Tagged<"answered", { self: Key; peer: Peer; theirs: Uint8Array; ours: Uint8Array }>
  | Tagged<"up", { session: Session }>;

const pad32 = (n: bigint): Uint8Array => {
  const bytes = hexToBytes(`0x${n.toString(16).padStart(64, "0")}`);
  return bytes.ok ? bytes.value : new Uint8Array(32);
};

type Proof = Readonly<{
  initiator: RuntimeId; responder: RuntimeId; initiatorNonce: Uint8Array; responderNonce: Uint8Array;
}>;

const digestOf = (signer: Role, p: Proof): Uint8Array => keccak256(concat([
  utf8(DOMAIN), utf8(signer), utf8(p.initiator), utf8("\0"), utf8(p.responder), utf8("\0"),
  p.initiatorNonce, p.responderNonce,
]));

type Signature = Readonly<{ r: Uint8Array; s: Uint8Array; recovery: number }>;

const signed = (key: Key, signer: Role, p: Proof): Signature => {
  const sig = signDigest(digestOf(signer, p), key.secret);
  return { r: pad32(sig.r), s: pad32(sig.s), recovery: sig.recovery };
};

/** The public key that signed, if it is the one the table says the peer's Runtime is. */
const provedBy = (peer: Peer, signer: Role, p: Proof, sig: Signature): Result<Uint8Array, LinkFault> => {
  const key = recoverPublicKey(digestOf(signer, p), sig.r, sig.s, sig.recovery);
  return key._tag === "some" && runtimeOf(key.value) === peer.runtime ? ok(key.value) : err({ _tag: "bad_signature" });
};

const sessionOf = (self: Key, peer: Peer, theirKey: Uint8Array, role: Role, p: Proof): Session => {
  const shared = secp256k1.getSharedSecret(self.secret, theirKey, COMPRESSED).slice(1, 33);
  const mac = keccak256(concat([
    utf8(`${DOMAIN} key`), shared, p.initiatorNonce, p.responderNonce, utf8(p.initiator), utf8(p.responder),
  ]));
  return { peer, mac, role, sent: 0, heard: 0 };
};

// ---- the records, as text

const signatureText = (s: Signature): Readonly<Record<string, unknown>> => ({ r: s.r, s: s.s, recovery: s.recovery });

const readSignature = (at: string, v: unknown): Result<Signature, ReadFault> =>
  flatMap(record(at, v, ["r", "s", "recovery"]), (o) =>
    all({
      r: field(at, o, "r", bytesOf(NONCE)), s: field(at, o, "s", bytesOf(NONCE)),
      recovery: field(at, o, "recovery", count),
    }));

// The handshake's values are strings, bytes and counts, which always have text; a value that had none would be sent as
// text the peer refuses.
const written = (value: unknown): string => {
  const encoded = encodeValue(value);
  return encoded.ok ? encoded.value : "";
};

const parsed = <T>(
  wire: string, tag: string, keys: readonly string[], max: number, read: (o: Fields) => Result<T, ReadFault>,
): Result<T, LinkFault> => {
  if (wire.length > max) return err({ _tag: "unreadable", fault: { _tag: "too_big", bytes: wire.length } });
  const value = decodeValue(wire);
  if (!value.ok) return err({ _tag: "unreadable", fault: value.error });
  const shape = record("$", value.value, ["_tag", ...keys]);
  const wrongTag = err({ _tag: "bad_shape", at: "$._tag", want: tag } as const);
  const tagged = flatMap(shape, (o) => (o["_tag"] === tag ? read(o) : wrongTag));
  return mapErr(tagged, (fault): LinkFault => ({ _tag: "unreadable", fault }));
};

// ---- the handshake

/** The initiator's first move: its hello for `peer`, and the state that waits for the reply. */
export const dial = (self: Key, peer: Peer, nonce: Uint8Array): Readonly<{ link: Link; hello: string }> =>
  ({ link: { _tag: "dialing", self, peer, nonce }, hello: written({ _tag: "hello", from: self.runtime, nonce }) });

const peerNamed = (table: readonly Peer[], runtime: string): Result<Peer, LinkFault> => {
  const peer = table.find((p) => p.runtime === runtime);
  return peer === undefined ? err({ _tag: "unknown_runtime", runtime }) : ok(peer);
};

/** The responder takes a hello: a Runtime of the table, a reply that proves itself over the challenge, and the wait. */
export const answer = (
  self: Key, table: readonly Peer[], nonce: Uint8Array, hello: string,
): Result<Readonly<{ link: Link; reply: string }>, LinkFault> =>
  flatMap(
    parsed(hello, "hello", ["from", "nonce"], HANDSHAKE_BYTES, (o) =>
      all({ from: field("$", o, "from", text), theirs: field("$", o, "nonce", bytesOf(NONCE)) })),
    ({ from, theirs }) => map(peerNamed(table, from), (peer) => {
      const proof = proofFor(peer, self, theirs, nonce);
      const reply = written({ _tag: "reply", nonce, sig: signatureText(signed(self, "responder", proof)) });
      return { link: { _tag: "answered", self, peer, theirs, ours: nonce } as Link, reply };
    }),
  );

type Named = Readonly<{ runtime: RuntimeId }>;

const proofFor = (initiator: Named, responder: Named, initiatorNonce: Uint8Array, responderNonce: Uint8Array): Proof =>
  ({ initiator: initiator.runtime, responder: responder.runtime, initiatorNonce, responderNonce });

/** The initiator takes the reply: the responder has proved itself over the challenge, and now it proves itself. */
export const finish = (link: Link, reply: string): Result<Readonly<{ link: Link; finish: string }>, LinkFault> => {
  if (link._tag !== "dialing") return err({ _tag: "wrong_state", state: link._tag });
  const read = parsed(reply, "reply", ["nonce", "sig"], HANDSHAKE_BYTES, (o) =>
    all({ nonce: field("$", o, "nonce", bytesOf(NONCE)), sig: readSignature("$.sig", o["sig"]) }));
  return flatMap(read, ({ nonce, sig }) => {
    const proof = proofFor(link.self, link.peer, link.nonce, nonce);
    return map(provedBy(link.peer, "responder", proof, sig), (theirKey) => ({
      link: { _tag: "up", session: sessionOf(link.self, link.peer, theirKey, "initiator", proof) } as Link,
      finish: written({ _tag: "finish", sig: signatureText(signed(link.self, "initiator", proof)) }),
    }));
  });
};

/** The responder takes the finish: the initiator signed over the challenge this connection gave it. */
export const accept = (link: Link, finishing: string): Result<Link, LinkFault> => {
  if (link._tag !== "answered") return err({ _tag: "wrong_state", state: link._tag });
  const read = parsed(finishing, "finish", ["sig"], HANDSHAKE_BYTES, (o) => readSignature("$.sig", o["sig"]));
  return flatMap(read, (sig) => {
    const proof = proofFor(link.peer, link.self, link.theirs, link.ours);
    return map(provedBy(link.peer, "initiator", proof, sig), (theirKey) =>
      ({ _tag: "up", session: sessionOf(link.self, link.peer, theirKey, "responder", proof) }) as Link);
  });
};

// ---- the records after it

const toward = (role: Role): number => (role === "initiator" ? 1 : 2);

const macOf = (s: Session, sender: Role, n: number, body: string): Uint8Array =>
  hmac(sha256, s.mac, concat([Uint8Array.of(toward(sender)), pad32(BigInt(n)), utf8(body)]));

const same = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.reduce((diff, byte, i) => diff | (byte ^ (b[i] ?? 0)), 0) === 0;

const other = (role: Role): Role => (role === "initiator" ? "responder" : "initiator");

/** A message sealed for the peer, and the link after it. */
export const seal = (
  link: Link, message: Outbound,
): Result<Readonly<{ link: Link; data: string }>, LinkFault | ValueFault> => {
  if (link._tag !== "up") return err({ _tag: "wrong_state", state: link._tag });
  const body = writeOutbound(message);
  return map(body, (text) => {
    const n = link.session.sent + 1;
    const data = written({ _tag: "data", n, body: text, mac: macOf(link.session, link.session.role, n, text) });
    return { link: { _tag: "up", session: { ...link.session, sent: n } } as Link, data };
  });
};

/**
 * A message from the peer. It is delivered only if it is the peer's own: sealed with the session's key, above the
 * last count heard, readable as a message, and from an Entity the table says this Runtime speaks for.
 */
export const open = (link: Link, data: string): Result<Readonly<{ link: Link; message: Outbound }>, LinkFault> => {
  if (link._tag !== "up") return err({ _tag: "wrong_state", state: link._tag });
  const { session } = link;
  const sealed = parsed(data, "data", ["n", "body", "mac"], DATA_BYTES, (o) =>
    all({
      n: field("$", o, "n", count), body: field("$", o, "body", text), mac: field("$", o, "mac", bytesOf(NONCE)),
    }));
  return flatMap(sealed, ({ n, body, mac }) => {
    if (!same(mac, macOf(session, other(session.role), n, body))) return err({ _tag: "bad_mac" });
    if (n <= session.heard) return err({ _tag: "replay", count: n, heard: session.heard });
    const read = mapErr(readWire(body), (fault): LinkFault => ({ _tag: "unreadable", fault }));
    return flatMap(read, (message) => (session.peer.entities.includes(message.from)
      ? ok({ link: { _tag: "up", session: { ...session, heard: n } } as Link, message })
      : err({ _tag: "not_theirs", from: message.from, runtime: session.peer.runtime })));
  });
};

/** The shell's receive path: a record off the link, opened as the peer's, and only then handed to the Host. */
export const hear = (host: Host, link: Link, data: string): Result<Heard, LinkFault> =>
  map(open(link, data), ({ link: next, message }) => {
    const got = receive(host, message);
    return { link: next, host: got.host, notices: got.notices };
  });

export type Heard = Readonly<{ link: Link; host: Host; notices: readonly HostNotice[] }>;
