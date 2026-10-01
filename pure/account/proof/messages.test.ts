import { describe, expect, test } from "bun:test";
import { ethers } from "ethers";
import { accountKey } from "../../chain/proof/deployment.ts";
import { some } from "../../kernel/core/option.ts";
import { recoverPublicKey, signDigest } from "../../kernel/crypto/signature.ts";
import { bytesToHex, hexToBytes, keccak256, utf8 } from "../../kernel/encoding/bytes.ts";
import { rlp } from "../../kernel/encoding/rlp.ts";
import { signing } from "../fixtures.ts";
import type { FrameHash, Refusal } from "../frame/frame.ts";
import { frameAuthDigest, refusalAuthDigest } from "./messages.ts";
import type { SigningContext } from "./signing.ts";

const NAME = `0x${"c4".repeat(32)}` as FrameHash;
const REFUSAL: Refusal = { hash: NAME, index: 1, fault: "not_expired", mark: 2, floor: 3 };
const distinct = (xs: readonly string[]) => new Set(xs).size === xs.length;
const bytes = (hex: string): Uint8Array => {
  const parsed = hexToBytes(hex);
  return parsed.ok ? parsed.value : new Uint8Array();
};
const word = (n: bigint): string => `0x${n.toString(16).padStart(64, "0")}`;
const ALICE = word(0xa11ce5n);
const BOB = word(0xb0bn);
const CAROL = word(0xca401n);
const keyOf = (account: readonly [string, string]) => {
  const key = accountKey(...account);
  return key.ok ? key.value : expect.unreachable("an Account key");
};
const aliceKey = ethers.id("alice-frame-signer");

describe("account/proof R-SIGNED-MESSAGES a frame and a refusal are signed under digests of their own", () => {
  test("a digest is a function of what it says: every field of a refusal changes it", () => {
    const variants: readonly Partial<Refusal>[] = [
      {}, { hash: `0x${"c5".repeat(32)}` as FrameHash }, { index: 0 }, { fault: "deadline_too_far" }, { mark: 3 },
      { floor: 4 },
    ];
    expect(distinct(variants.map((v) => refusalAuthDigest(signing, { ...REFUSAL, ...v })))).toBe(true);
    expect(refusalAuthDigest(signing, { ...REFUSAL })).toBe(refusalAuthDigest(signing, REFUSAL));
  });

  test("it is scoped to the deployment and to the Account: no signature carries to another", () => {
    const elsewhere: readonly SigningContext[] = [
      signing, { ...signing, deployment: { ...signing.deployment, chainId: 1n } },
      { ...signing, deployment: { ...signing.deployment, depository: `0x${"cd".repeat(20)}` } },
      { ...signing, accountKey: `0x${"33".repeat(32)}${"22".repeat(32)}` },
      { ...signing, ondeltaEpoch: signing.ondeltaEpoch + 1n },
    ];
    expect(distinct(elsewhere.map((c) => frameAuthDigest(c, NAME, 1)))).toBe(true);
    expect(distinct(elsewhere.map((c) => refusalAuthDigest(c, REFUSAL)))).toBe(true);
  });

  test("a frame's digest is never a refusal's, even over the same hash", () => {
    const empty: Refusal = { hash: NAME, index: 0, fault: "", mark: 0, floor: 0 };
    expect(frameAuthDigest(signing, NAME, 1)).not.toBe(refusalAuthDigest(signing, empty));
  });

  test("the fields cannot be shifted into one another: where one ends is part of what is signed", () => {
    const a = refusalAuthDigest(signing, { ...REFUSAL, fault: "ab", mark: 1 });
    const b = refusalAuthDigest(signing, { ...REFUSAL, fault: "a", mark: 1 });
    const c = refusalAuthDigest(signing, { ...REFUSAL, fault: "a1", mark: 1 });
    const d = refusalAuthDigest(signing, { ...REFUSAL, fault: "a", mark: 11 });
    expect(distinct([a, b, c, d])).toBe(true);
  });

  test("each digest is the keccak of its kind tag and its fields, each field its own item, nothing else", () => {
    const scoped = [
      utf8(signing.deployment.chainId.toString()), utf8(signing.deployment.depository), utf8(signing.accountKey),
      utf8(signing.ondeltaEpoch.toString()),
    ];
    const of = (kind: string, fields: readonly string[]) =>
      bytesToHex(keccak256(rlp([utf8(kind), ...scoped, ...fields.map(utf8)])));
    expect(frameAuthDigest(signing, NAME, 5)).toBe(of("xln/account/frame/v2", [NAME, "3", "5"]));
    const refusal = of("xln/account/refusal/v2", [NAME, "1", "not_expired", "2", "3"]);
    expect(refusalAuthDigest(signing, REFUSAL)).toBe(refusal);
  });

  test("whatever a peer wrote has a digest and nothing throws: a number that is not whole is its own", () => {
    const odd = [Number.NaN, 1.5, -1, Number.POSITIVE_INFINITY, 2 ** 53].map((x) =>
      refusalAuthDigest(signing, { ...REFUSAL, index: x, mark: x, floor: x }));
    expect(distinct([...odd, refusalAuthDigest(signing, REFUSAL)])).toBe(true);
  });
});

describe("account/proof R-FRAME-SIGNATURE-NAMES-ACCOUNT a frame signed for one Account is no other Account's", () => {
  // Alice signs a frame of her Account with Bob; the same bytes are replayed into her Account with Carol, into the same
  // Account at another epoch, and at another nonce: the verifier of each recovers someone else, never Alice.
  const bob = { ...signing, accountKey: keyOf([ALICE, BOB]) };
  const signed = signDigest(bytes(frameAuthDigest(bob, NAME, 2)), bytes(aliceKey));
  const r = bytes(word(signed.r));
  const s = bytes(word(signed.s));
  const signer = (digest: string) => recoverPublicKey(bytes(digest), r, s, signed.recovery);

  test("the Account's key names both entities, the smaller first, whoever asks", () => {
    expect(accountKey(ALICE, BOB)).toEqual(accountKey(BOB, ALICE));
    expect(keyOf([ALICE, BOB])).not.toBe(keyOf([ALICE, CAROL]));
    expect(keyOf([BOB, ALICE])).toBe(`0x${BOB.slice(2)}${ALICE.slice(2)}`);
  });

  test("the verifier of the Account the frame was signed for recovers Alice", () => {
    expect(signer(frameAuthDigest(bob, NAME, 2))).toEqual(some(signed.publicKey));
  });

  test("replayed into Alice's Account with Carol, another epoch or another nonce, it recovers another signer", () => {
    const replays: readonly [string, string][] = [
      ["another Account", frameAuthDigest({ ...signing, accountKey: keyOf([ALICE, CAROL]) }, NAME, 2)],
      ["another epoch", frameAuthDigest({ ...bob, ondeltaEpoch: bob.ondeltaEpoch + 1n }, NAME, 2)],
      ["another slot", frameAuthDigest(bob, NAME, 4)],
      ["another first nonce", frameAuthDigest({ ...bob, firstNonce: bob.firstNonce + 2n }, NAME, 2)],
      ["another chain", frameAuthDigest({ ...bob, deployment: { ...bob.deployment, chainId: 1n } }, NAME, 2)],
    ];
    const recovered = replays.map(([, digest]) => signer(digest));
    expect(recovered.map((who) => who._tag === "some" && bytesToHex(who.value) === bytesToHex(signed.publicKey)))
      .toEqual(replays.map(() => false));
  });
});
