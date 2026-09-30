// Hankos: the encoder and the verifier against the fork's deployed EntityProvider.
//
// contracts/vectors pins three verdicts (a bare signature, an envelope for the lazy Entity, an envelope for an
// unregistered one). This file adds what the vectors do not cover, by asking the deployed bytecode in a child process
// (chain/hanko/live/entity-provider.ts): boards of several signers, nested Entities, and a byte-level mutation of each.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ethers } from "ethers";
import { bytesToHex, hexToBytes } from "../../kernel/encoding/bytes.ts";
import { err, ok, unwrapOr, type Result } from "../../kernel/core/result.ts";
import { HALF_ORDER, addressOf, signDigest } from "../../kernel/crypto/signature.ts";
import {
  addressAsId, boardBytes, boardHash, encodeHanko, isLowS, lazyEntityId, lazyHanko, packSignatures, recoverRawSigner,
  type Board, type Hanko, type HankoClaim,
} from "./hanko.ts";
import { verifyHanko, verifyHankoSignature, type HankoVerdict } from "./hanko-verify.ts";

const must = <T, E>(r: Result<T, E>): T => unwrapOr(r, (e) => expect.unreachable(JSON.stringify(e)));
const bytes = (hex: string): Uint8Array => must(hexToBytes(hex));
const notCanonical = (index: number) => ({ ok: false, error: { _tag: "non_canonical_signature", index } }) as const;
const vectorsPath = new URL("../../../contracts/vectors/functions.json", import.meta.url);
const committed = JSON.parse(readFileSync(vectorsPath, "utf8"));
const isProviderVector = (v: { function: string }): boolean => v.function.startsWith("verifyHankoSignature(");
const providerVectors = committed.vectors.filter(isProviderVector);
const unregistered = () => ok(false);

describe("R-J2 Hanko verdicts the EntityProvider returned (contracts/vectors)", () => {
  const [rawVector, envelopeVector, rejectedVector] = providerVectors;
  const [rawHanko, digest] = rawVector.args as [string, string];
  const lazyId: string = rawVector.decoded.entityId;

  test("a bare 65-byte signature stands for its signer's lazy Entity", () => {
    const verdict = must(verifyHankoSignature(rawHanko, digest, unregistered));
    expect(verdict.entityId).toBe(lazyId);
    expect(verdict.signers).toEqual([new ethers.Wallet(ethers.id("vectors-signer")).address.toLowerCase()]);
  });

  test("the lazy Entity id is the hash of the signer's one-signer board", () => {
    expect(must(lazyEntityId(must(recoverRawSigner(digest, rawHanko))))).toBe(lazyId);
  });

  test("the envelope for the lazy Entity is byte for byte the one the contract accepted", () => {
    expect(must(lazyHanko(lazyId, rawHanko))).toBe(envelopeVector.args[0]);
    expect(must(verifyHankoSignature(envelopeVector.args[0], digest, unregistered)).entityId).toBe(lazyId);
  });

  test("the envelope the contract rejected is ours byte for byte, and is rejected here", () => {
    const other = ethers.id("other-entity");
    expect(must(lazyHanko(other, rawHanko))).toBe(rejectedVector.args[0]);
    expect(rejectedVector.decoded.success).toBe(false);
    const verdict = verifyHankoSignature(rejectedVector.args[0], digest, unregistered);
    expect(verdict).toEqual({ ok: false, error: { _tag: "authority" } });
  });

  test("the same envelope is accepted when the registry says the board is registered", () => {
    const other = ethers.id("other-entity");
    const verdict = verifyHanko(rejectedVector.args[0], digest, { _tag: "entity", entityId: other }, () => ok(true));
    expect(verdict.ok && verdict.value.entityId).toBe(other);
  });
});

// ---- Hankos built here, judged by both ----

const keyOf = (n: number): string => ethers.id(`pure-hanko-key-${n}`);
const digest = ethers.id("pure-hanko-digest");
const idOf = (n: number): string => addressAsId(new ethers.Wallet(keyOf(n)).address);
const signatureOf = (n: number, over = digest) => {
  const s = signDigest(bytes(over), bytes(keyOf(n)));
  const pad = (v: bigint): Uint8Array => bytes(`0x${v.toString(16).padStart(64, "0")}`);
  return { r: pad(s.r), s: pad(s.s), v: 27 + s.recovery };
};
const hankoOf = (signers: readonly number[], placeholders: readonly string[], claims: readonly HankoClaim[]): string =>
  must(encodeHanko({
    placeholders,
    packedSignatures: must(packSignatures(signers.map((n) => signatureOf(n)))),
    claims,
    memberSignatures: [],
  }));
const board = (ids: readonly string[], powers: readonly bigint[], threshold: bigint): Board => ({
  votingThreshold: threshold, entityIds: ids, votingPowers: powers,
  boardChangeDelay: 0n, controlChangeDelay: 0n, dividendChangeDelay: 0n,
});
const claimOf = (b: Board, indexes: readonly bigint[]): HankoClaim => ({
  entityId: must(boardHash(b)), entityIndexes: indexes, weights: b.votingPowers, threshold: b.votingThreshold,
  boardChangeDelay: 0n, controlChangeDelay: 0n, dividendChangeDelay: 0n,
});

const twoOfThree = board([idOf(3), idOf(1), idOf(2)], [1n, 1n, 1n], 2n);
const valid2of3 = hankoOf([1, 2], [idOf(3)], [claimOf(twoOfThree, [0n, 1n, 2n])]);
const lone = board([idOf(1)], [1n], 1n);
const nestedInner = claimOf(lone, [0n]);
const nestedOuter = board([idOf(2), nestedInner.entityId], [1n, 1n], 2n);
const validNested = hankoOf([1, 2], [], [nestedInner, claimOf(nestedOuter, [1n, 2n])]);
const validLazy = must(lazyHanko(must(lazyEntityId(new ethers.Wallet(keyOf(1)).address)), must(recoverSigHex(1))));

function recoverSigHex(n: number): Result<string, never> {
  const sig = new ethers.SigningKey(keyOf(n)).sign(digest);
  return ok(sig.serialized);
}


const twoOfTwo = board([idOf(1), idOf(1)], [1n, 1n], 2n);
/** Placeholders [3, 2], signer [1]: index 0 is 3, 1 is 2, 2 is the signer. The board lists ids in claim order. */
const orderedTwoOfThree = board([idOf(3), idOf(1), idOf(2)], [1n, 1n, 1n], 2n);
const placeholderDoesNotVote = hankoOf([1], [idOf(3), idOf(2)], [claimOf(orderedTwoOfThree, [0n, 2n, 1n])]);
const nestedFirst = (() => {
  const inner = claimOf(lone, [0n]);
  const outer = board([inner.entityId, idOf(2)], [1n, 1n], 1n);
  return hankoOf([1, 2], [], [inner, claimOf(outer, [2n, 1n])]);
})();
const heavy = (weight: bigint): string => {
  const b = board([idOf(1)], [weight > 65_535n ? 65_535n : weight], 1n);
  return hankoOf([1], [], [{ ...claimOf(b, [0n]), weights: [weight] }]);
};
const withDelays = (boardChangeDelay: bigint, controlChangeDelay: bigint, dividendChangeDelay: bigint): string => {
  const b = { ...lone, boardChangeDelay: 1n, controlChangeDelay: 2n, dividendChangeDelay: 3n };
  return hankoOf([1], [], [{ ...claimOf(b, [0n]), boardChangeDelay, controlChangeDelay, dividendChangeDelay }]);
};
const dirtyPadding = (): string => {
  const packed = must(packSignatures([signatureOf(1)]));
  const dirty = Uint8Array.from(packed, (byte, i) => (i === packed.length - 1 ? byte | 0x02 : byte));
  const claims = [claimOf(lone, [0n])];
  return must(encodeHanko({ placeholders: [], packedSignatures: dirty, claims, memberSignatures: [] }));
};
const selfClaim = (): string => hankoOf([1], [], [{
  ...claimOf(lone, [0n]), entityIndexes: [0n, 1n], weights: [1n, 1n], threshold: 1n,
}]);
const emptyMembers = (): string => must(encodeHanko({
  placeholders: [idOf(3)], packedSignatures: must(packSignatures([signatureOf(1), signatureOf(2)])),
  claims: [claimOf(board([idOf(3), idOf(1), idOf(2)], [1n, 1n, 1n], 2n), [0n, 1n, 2n])],
  memberSignatures: [new Uint8Array()],
}));
const memberSignature = (): string => must(encodeHanko({
  placeholders: [idOf(3)], packedSignatures: must(packSignatures([signatureOf(1), signatureOf(2)])),
  claims: [claimOf(board([idOf(3), idOf(1), idOf(2)], [1n, 1n, 1n], 2n), [0n, 1n, 2n])],
  memberSignatures: [bytes("0x1234")],
}));

const flipByte = (hex: string, at: number): string => {
  const b = Uint8Array.from(bytes(hex));
  const flipped = Uint8Array.from(b, (x, i) => (i === at ? x ^ 0x01 : x));
  return bytesToHex(flipped);
};

type Named = Readonly<{ name: string; hanko: string; digest: string }>;

const structural: readonly Named[] = [
  { name: "one signer, lazy", hanko: validLazy, digest },
  { name: "raw 65 bytes", hanko: new ethers.SigningKey(keyOf(1)).sign(digest).serialized, digest },
  { name: "2 of 3, one placeholder", hanko: valid2of3, digest },
  {
    name: "2 of 3 signed by one", digest,
    hanko: hankoOf([1], [idOf(3), idOf(2)], [claimOf(twoOfThree, [1n, 0n, 2n])]),
  },
  { name: "nested Entity", hanko: validNested, digest },
  { name: "the wrong digest", hanko: valid2of3, digest: ethers.id("another digest") },
  {
    name: "signer listed as placeholder", digest,
    hanko: hankoOf([1, 2], [idOf(1)], [claimOf(twoOfThree, [0n, 1n, 2n])]),
  },
  { name: "an unused signature", hanko: hankoOf([1, 2, 3], [], [claimOf(lone, [0n])]), digest },
  { name: "an unused placeholder", hanko: hankoOf([1], [idOf(2)], [claimOf(lone, [0n])]), digest },
  { name: "a claim out of order", hanko: hankoOf([1, 2], [], [claimOf(nestedOuter, [1n, 2n]), nestedInner]), digest },
  {
    name: "threshold above total weight", digest,
    hanko: hankoOf([1], [], [claimOf(board([idOf(1)], [1n], 2n), [0n])]),
  },
  { name: "no signature", hanko: hankoOf([], [idOf(1)], [claimOf(lone, [0n])]), digest },
  // The cases below are built so the claim's Entity id is the hash of the board the claim really names; a mismatched
  // id would be refused for its authority and never reach the rule under test.
  { name: "a placeholder does not vote: 2 of 3 signed by one", hanko: placeholderDoesNotVote, digest },
  { name: "the same signature twice", hanko: hankoOf([1, 1], [], [claimOf(twoOfTwo, [0n, 1n])]), digest },
  {
    name: "an unused placeholder, claim built over the signer", digest,
    hanko: hankoOf([1], [idOf(2)], [claimOf(lone, [1n])]),
  },
  { name: "a nested claim as first member", hanko: nestedFirst, digest },
  { name: "a weight of 65536", hanko: heavy(65_536n), digest },
  { name: "a weight of 65535", hanko: heavy(65_535n), digest },
  { name: "delays in the board", hanko: withDelays(1n, 2n, 3n), digest },
  { name: "delays swapped", hanko: withDelays(3n, 2n, 1n), digest },
  { name: "a padding bit set in the recovery byte", hanko: dirtyPadding(), digest },
  { name: "a claim that names itself", hanko: selfClaim(), digest },
  { name: "the same placeholder twice", hanko: hankoOf([1], [idOf(2), idOf(2)], [claimOf(lone, [2n])]), digest },
  { name: "member signatures, all empty", hanko: emptyMembers(), digest },
  { name: "member signature for an externally owned placeholder", hanko: memberSignature(), digest },
  { name: "no claim", hanko: hankoOf([1], [], []), digest },
];

const mutations = (n: Named, every: number): readonly Named[] => [
  ...Array.from({ length: Math.ceil(bytes(n.hanko).length / every) }, (_, k) =>
    ({ name: `${n.name}: byte ${k * every} flipped`, hanko: flipByte(n.hanko, k * every), digest: n.digest })),
  { name: `${n.name}: truncated by one byte`, hanko: n.hanko.slice(0, -2), digest: n.digest },
  { name: `${n.name}: one byte appended`, hanko: `${n.hanko}00`, digest: n.digest },
];

const suite: readonly Named[] = [
  ...structural,
  ...mutations(structural[0]!, 1),
  ...mutations(structural[2]!, 3),
  ...mutations(structural[4]!, 5),
];

const live = (cases: readonly Named[]): readonly { entityId: string; success: boolean }[] => {
  const child = Bun.spawnSync(["bun", `${import.meta.dir}/live/entity-provider.ts`], {
    stdin: new TextEncoder().encode(JSON.stringify(cases.map(({ hanko, digest: d }) => ({ hanko, digest: d })))),
    cwd: `${import.meta.dir}/../..`,
  });
  const out = child.stdout.toString();
  return JSON.parse(out.slice(out.indexOf("@@VERDICTS@@") + "@@VERDICTS@@".length));
};

describe("R-J2 the verifier against the deployed EntityProvider", () => {
  const verdicts = live(suite);
  const mine = (n: Named): Result<HankoVerdict, unknown> => verifyHankoSignature(n.hanko, n.digest, unregistered);

  test("the suite reaches both verdicts", () => {
    expect(verdicts.filter((v) => v.success).length).toBeGreaterThan(3);
    expect(verdicts.filter((v) => !v.success).length).toBeGreaterThan(10);
  });

  test("a Hanko accepted here is accepted by the contract for the same Entity", () => {
    const accepted = suite.flatMap((n, i) => {
      const r = mine(n);
      return r.ok ? [{ n, i, r }] : [];
    });
    expect(accepted.length).toBeGreaterThan(3);
    accepted.forEach(({ n, i, r }) => {
      expect([n.name, verdicts[i]!.success, verdicts[i]!.entityId]).toEqual([n.name, true, r.value.entityId]);
    });
  });

  test("what is refused here and accepted by the contract is only bytes the canonical spelling does not allow", () => {
    const stricter = suite.flatMap((n, i) => {
      const r = mine(n);
      return !r.ok && verdicts[i]!.success ? [[n.name, JSON.stringify(r.error)]] : [];
    });
    expect(stricter.map(([, fault]) => fault)).toEqual(stricter.map(() => '{"_tag":"non_canonical"}'));
  });

  /** The rule each case is built to reach: the verdict the contract gives and the first refusal named here. */
  const reached: Readonly<Record<string, string | null>> = {
    "a placeholder does not vote: 2 of 3 signed by one": "quorum",
    "the same signature twice": "duplicate_signer",
    "an unused placeholder, claim built over the signer": "unused_placeholder",
    "a nested claim as first member": "first_member",
    "a weight of 65536": "weight",
    "a weight of 65535": null,
    "delays in the board": null,
    "delays swapped": "authority",
    "a padding bit set in the recovery byte": "packed_padding",
    "a claim that names itself": "claim_order",
    "the same placeholder twice": "duplicate_placeholder",
    "threshold above total weight": "threshold_power",
    "member signatures, all empty": null,
    "member signature for an externally owned placeholder": "member_signature",
  };

  test("each new case reaches the rule it names; the contract accepts exactly the cases this verifier does", () => {
    const got = Object.keys(reached).map((name) => {
      const i = suite.findIndex((n) => n.name === name);
      const r = mine(suite[i]!);
      return [name, r.ok ? null : (r.error as { _tag: string })._tag, verdicts[i]!.success] as const;
    });
    expect(got.map(([name, fault]) => [name, fault])).toEqual(Object.entries(reached));
    const acceptedByContract = got.filter(([, , accepted]) => accepted).map(([name]) => name);
    const acceptedHere = got.filter(([, fault]) => fault === null).map(([name]) => name);
    expect(acceptedByContract).toEqual(acceptedHere);
    expect(acceptedHere).toEqual(["a weight of 65535", "delays in the board", "member signatures, all empty"]);
  });

  test("the structural cases are judged as the contract judges them", () => {
    const expected = structural.map((n, i) => [n.name, verdicts[i]!.success]);
    const got = structural.map((n) => [n.name, mine(n).ok]);
    expect(got).toEqual(expected);
  });
});

describe("boards and signatures", () => {
  test("a board's bytes hash to its id, and a lone signer's board is the lazy id", () => {
    expect(ethers.keccak256(bytesToHex(must(boardBytes(lone))))).toBe(must(boardHash(lone)));
    expect(must(boardHash(lone))).toBe(must(lazyEntityId(new ethers.Wallet(keyOf(1)).address)));
  });

  test("a high-s signature cannot be packed", () => {
    const s = signatureOf(1);
    const curveOrder = ethers.getBigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
    const flipped = bytes(`0x${(curveOrder - BigInt(bytesToHex(s.s))).toString(16).padStart(64, "0")}`);
    expect(packSignatures([{ ...s, s: flipped }])).toEqual(notCanonical(0));
    expect(BigInt(bytesToHex(s.s)) <= HALF_ORDER).toBe(true);
  });

  test("a signature that is not canonical is not packed, and v must be 27 or 28", () => {
    const s = signatureOf(1);
    expect(packSignatures([{ ...s, v: 29 }])).toEqual(notCanonical(0));
    expect(packSignatures([s, { ...s, r: new Uint8Array(32) }])).toEqual(notCanonical(1));
  });

  test("the address of a recovered key is the signer's", () => {
    const sig = signDigest(bytes(digest), bytes(keyOf(1)));
    expect(addressOf(sig.publicKey)).toBe(new ethers.Wallet(keyOf(1)).address);
    expect(err("x")).toEqual({ ok: false, error: "x" });
  });
});

describe("R-J2 what only this verifier decides", () => {
  test("a Hanko for another Entity than the one required is refused as the wrong target", () => {
    const other = { _tag: "entity", entityId: ethers.id("someone else") } as const;
    const refused = verifyHanko(validNested, digest, other, unregistered);
    expect(refused).toEqual({ ok: false, error: { _tag: "target" } });
  });

  test("the last claim is the Entity named, and naming it is accepted", () => {
    const last = must(boardHash(nestedOuter));
    const accepted = verifyHanko(validNested, digest, { _tag: "entity", entityId: last }, unregistered);
    expect(accepted.ok && accepted.value.entityId).toBe(last);
  });

  test("a raw signature with recovery byte 2 names no bit", () => {
    const raw = new ethers.SigningKey(keyOf(1)).sign(digest).serialized;
    const two = `${raw.slice(0, -2)}02`;
    expect(recoverRawSigner(digest, two)).toEqual({ ok: false, error: { _tag: "bad_recovery" } });
  });

  test("s equal to half the curve order is low, one more is high", () => {
    const word = (v: bigint): Uint8Array => bytes(`0x${v.toString(16).padStart(64, "0")}`);
    expect(isLowS(word(HALF_ORDER))).toBe(true);
    expect(isLowS(word(HALF_ORDER + 1n))).toBe(false);
  });
});

// ---- hanko.json: 43 Hankos, each judged by the deployed EntityProvider ----

type Plain = any;

describe("R-J2 the verifier against every verdict in hanko.json (the deployed EntityProvider's)", () => {
  type Case = Readonly<{
    label: string; hash: string; hanko: string; signers?: readonly string[];
    result: Readonly<{ success: boolean; entityId: string; revertedWith?: string }>;
  }>;
  const vectors = JSON.parse(readFileSync(new URL("../../../contracts/vectors/hanko.json", import.meta.url), "utf8"));
  const cases: readonly Case[] = vectors.cases;
  const authorize = (id: string, board: string) => ok(id === board);
  const judged = (c: Case) => verifyHankoSignature(c.hanko, c.hash, authorize);

  /** What the verifier names for each of the contract's reverts. One contract revert can be two of our reasons. */
  const named: Readonly<Record<string, readonly string[]>> = {
    InvalidHankoClaimOrder: ["claim_order", "entity_index"],
    NonCanonicalHankoPlaceholder: ["placeholder_signer"],
    UnusedHankoClaim: ["unused_claim"],
    InvalidHankoPackedSignatureLength: ["packed_length"],
    InvalidHankoPackedSignaturePadding: ["packed_padding"],
    InvalidHankoFirstMember: ["first_member"],
    DuplicateHankoSigner: ["duplicate_signer"],
    UnusedHankoPlaceholder: ["unused_placeholder"],
    UnusedHankoSignature: ["unused_signature"],
    DuplicateHankoPlaceholder: ["duplicate_placeholder"],
    DuplicateHankoEntityIndex: ["duplicate_entity_index"],
    DuplicateHankoClaimEntity: ["duplicate_claim_entity"],
    InvalidHankoWeight: ["weight"],
    InvalidHankoThreshold: ["threshold"],
    InvalidHankoClaimShape: ["claim_shape"],
    InvalidHankoMemberSignatures: ["member_signatures_shape"],
    HankoProofTooLarge: ["too_large"],
  };
  /** A proof the contract refuses without a revert (success false): a missed quorum, or a signature not canonical. */
  const soft = ["quorum", "threshold_power", "signature_non_canonical", "bad_recovery", "high_s"];

  test("the vector holds both kinds of verdict and every revert the table names", () => {
    expect(cases.length).toBe(43);
    expect(new Set(cases.flatMap((c) => (c.result.revertedWith === undefined ? [] : [c.result.revertedWith]))))
      .toEqual(new Set(Object.keys(named)));
  });

  cases.filter((c) => c.result.success).forEach((c) => {
    test(`accepted: ${c.label}`, () => {
      const verdict = must(judged(c));
      expect(verdict.entityId).toBe(c.result.entityId);
      if (c.signers !== undefined) expect(verdict.signers).toEqual(c.signers.map((s) => s.toLowerCase()));
    });
  });

  cases.filter((c) => !c.result.success).forEach((c) => {
    test(`refused: ${c.label}`, () => {
      const verdict = judged(c);
      expect(verdict.ok).toBe(false);
      const reasons = c.result.revertedWith === undefined ? soft : named[c.result.revertedWith]!;
      expect(reasons).toContain(verdict.ok ? "accepted" : verdict.error._tag);
    });
  });

  const HANKO = ethers.ParamType.from("tuple(bytes32[] placeholders, bytes packedSignatures, "
    + "tuple(bytes32 entityId, uint256[] entityIndexes, uint256[] weights, uint256 threshold, uint32 boardChangeDelay, "
    + "uint32 controlChangeDelay, uint32 dividendChangeDelay)[] claims, bytes[] memberSignatures)");
  const decoded = (hanko: string): Hanko => {
    const [placeholders, packed, claims, members] = ethers.AbiCoder.defaultAbiCoder().decode([HANKO], hanko)[0];
    return {
      placeholders: [...placeholders],
      packedSignatures: bytes(packed),
      claims: claims.map(([entityId, indexes, weights, threshold, board, control, dividend]: Plain) => ({
        entityId, entityIndexes: [...indexes], weights: [...weights], threshold,
        boardChangeDelay: board, controlChangeDelay: control, dividendChangeDelay: dividend,
      })),
      memberSignatures: members.map((m: string) => bytes(m)),
    };
  };

  cases.filter((c) => c.hanko.length > 132 && c.result.revertedWith === undefined).forEach((c) => {
    test(`the envelope decodes and encodes back to its bytes: ${c.label}`, () => {
      expect(must(encodeHanko(decoded(c.hanko)))).toBe(c.hanko);
    });
  });

  test("a nested Entity acting through the Depository: the batch hash, signed, is accepted for that Entity", () => {
    const acting = vectors.depository;
    const verdict = must(verifyHankoSignature(acting.hanko, acting.batchHash, authorize));
    expect(verdict.entityId).toBe(acting.entityId);
  });
});
