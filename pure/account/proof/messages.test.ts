import { describe, expect, test } from "bun:test";
import { bytesToHex, keccak256, utf8 } from "../../kernel/encoding/bytes.ts";
import { rlp } from "../../kernel/encoding/rlp.ts";
import { signing } from "../fixtures.ts";
import type { FrameHash, Refusal } from "../frame/frame.ts";
import { frameAuthDigest, refusalAuthDigest } from "./messages.ts";
import type { SigningContext } from "./signing.ts";

const NAME = `0x${"c4".repeat(32)}` as FrameHash;
const REFUSAL: Refusal = { hash: NAME, index: 1, fault: "not_expired", mark: 2 };
const distinct = (xs: readonly string[]) => new Set(xs).size === xs.length;

describe("account/proof R-SIGNED-MESSAGES a frame and a refusal are signed under digests of their own", () => {
  test("a digest is a function of what it says: every field of a refusal changes it", () => {
    const variants: readonly Partial<Refusal>[] = [
      {}, { hash: `0x${"c5".repeat(32)}` as FrameHash }, { index: 0 }, { fault: "deadline_too_far" }, { mark: 3 },
    ];
    expect(distinct(variants.map((v) => refusalAuthDigest(signing, { ...REFUSAL, ...v })))).toBe(true);
    expect(refusalAuthDigest(signing, { ...REFUSAL })).toBe(refusalAuthDigest(signing, REFUSAL));
  });

  test("it is scoped to the deployment and to the Account: no signature carries to another", () => {
    const elsewhere: readonly SigningContext[] = [
      signing, { ...signing, deployment: { ...signing.deployment, chainId: 1n } },
      { ...signing, deployment: { ...signing.deployment, depository: `0x${"cd".repeat(20)}` } },
      { ...signing, accountKey: `0x${"33".repeat(32)}${"22".repeat(32)}` },
    ];
    expect(distinct(elsewhere.map((c) => frameAuthDigest(c, NAME)))).toBe(true);
    expect(distinct(elsewhere.map((c) => refusalAuthDigest(c, REFUSAL)))).toBe(true);
  });

  test("a frame's digest is never a refusal's, even over the same hash", () => {
    const empty: Refusal = { hash: NAME, index: 0, fault: "", mark: 0 };
    expect(frameAuthDigest(signing, NAME)).not.toBe(refusalAuthDigest(signing, empty));
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
    ];
    const of = (kind: string, fields: readonly string[]) =>
      bytesToHex(keccak256(rlp([utf8(kind), ...scoped, ...fields.map(utf8)])));
    expect(frameAuthDigest(signing, NAME)).toBe(of("xln/account/frame/v1", [NAME]));
    expect(refusalAuthDigest(signing, REFUSAL)).toBe(of("xln/account/refusal/v1", [NAME, "1", "not_expired", "2"]));
  });

  test("whatever a peer wrote has a digest and nothing throws: a number that is not whole is its own", () => {
    const odd = [Number.NaN, 1.5, -1, Number.POSITIVE_INFINITY, 2 ** 53].map((x) =>
      refusalAuthDigest(signing, { ...REFUSAL, index: x, mark: x }));
    expect(distinct([...odd, refusalAuthDigest(signing, REFUSAL)])).toBe(true);
  });
});
