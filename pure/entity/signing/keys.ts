// What the signed-heads tests share: real keys, the lazy Entities their addresses make, and the Host's signing of an
// Outbound as the shell does it. Only tests import this.
import { expect } from "bun:test";
import { lazyEntityId, lazyHanko } from "../../chain/hanko/hanko.ts";
import { unwrapOr, type Result } from "../../kernel/core/result.ts";
import { addressOf, signDigest } from "../../kernel/crypto/signature.ts";
import { hexToBytes } from "../../kernel/encoding/bytes.ts";
import { anchor, judge } from "../fixtures.ts";
import { entityFrame } from "../frame.ts";
import type { EntityId, EntityInput, EntityState, Outbound, PeerMessage } from "../model.ts";
import { lazyCheck } from "./attest.ts";

export const must = <T, E>(r: Result<T, E>): T => unwrapOr(r, (e) => expect.unreachable(JSON.stringify(e)));

type Party = Readonly<{ id: EntityId; secret: Uint8Array }>;

const party = (n: number): Party => {
  const secret = hexToBytes(`0x${n.toString(16).padStart(64, "0")}`);
  const key = must(secret);
  const id = must(lazyEntityId(addressOf(signDigest(ONES, key).publicKey))) as EntityId;
  return { id, secret: key };
};

/** What the Host's shell does to an Outbound that names a head: the Hanko of the party's own Entity over it. */
export const hanko = (who: Party, digest: string): string => {
  const raw = must(hexToBytes(digest));
  const sig = signDigest(raw, who.secret);
  const word = (n: bigint): string => n.toString(16).padStart(64, "0");
  return must(lazyHanko(who.id, `0x${word(sig.r)}${word(sig.s)}${(27 + sig.recovery).toString(16)}`));
};

export const signed = (who: Party, o: Outbound): PeerMessage => ({
  _tag: "peer_message", from: o.from, msg: o.msg, ...(o.attest === undefined ? {} : { sig: hanko(who, o.attest) }),
});

const ONES = Uint8Array.from({ length: 32 }, () => 1);

export const real = { ...anchor, check: lazyCheck };
export const run = (state: EntityState, ...inputs: readonly EntityInput[]) => entityFrame(judge, real, state, inputs);

export const ALICE = party(1);
export const BOB = party(2);
export const MALLORY = party(3);
