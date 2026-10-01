// Hanko vectors with several signers and nested boards, produced by the deployed EntityProvider in BrowserVM.
// The single-signer shapes (a raw 65-byte signature, a one-claim envelope) are in functions.json; this file pins what they do not:
//
//   - an M-of-N board with some members signing and the rest present as placeholders,
//   - a weighted board where one heavy member alone meets the threshold,
//   - a nested board: a claim whose member is another claim, two and three levels deep,
//   - the rejections: a threshold not met one level down, claims out of order, a signature that is also a placeholder, a duplicate signer, an unused claim,
//     a packed-signature block of the wrong length,
//   - and the nested entity acting for real: a batch signed by a nested board is accepted by the Depository.
//
// Layout of the envelope (HankoVerifier.HankoBytes): members are numbered placeholders first, then the recovered signers in `packedSignatures` order, then the claims in
// order; a claim lists the positions of its members and their weights. A lazy entity's id is the keccak of its Board (threshold, member ids in the claim's order,
// weights, three zero delays), a member that is itself a claim contributes that claim's entity id. The last claim is the proven entity.
// packedSignatures = r||s for each signature in turn, then the recovery bits, one per signature, packed little-endian into ceil(n/8) bytes (bit set = v 28).
import { ethers } from "ethers";
import { createAddressFromString } from "@ethereumjs/util";
import { EntityProvider__factory, HankoVerifier__factory, Depository__factory } from "../../../typechain-types/index.ts";
import { boot, rawHanko, type Rig } from "../rig.ts";

const coder = ethers.AbiCoder.defaultAbiCoder();
const BOARD_ABI = ["tuple(uint16 votingThreshold, bytes32[] entityIds, uint16[] votingPowers, uint32 boardChangeDelay, uint32 controlChangeDelay, uint32 dividendChangeDelay)"];
const HANKO_ABI = ["tuple(bytes32[] placeholders, bytes packedSignatures, tuple(bytes32 entityId, uint256[] entityIndexes, uint256[] weights, uint256 threshold, uint32 boardChangeDelay, uint32 controlChangeDelay, uint32 dividendChangeDelay)[] claims, bytes[] memberSignatures)"];

// Test-only keys, derived from a name; the ones a run used are written out (`signerKeys`) so a builder elsewhere can sign the same digests (ECDSA here is deterministic, RFC 6979).
const seenKeys = new Map<string, string>();
const keyOf = (name: string): string => {
  const key = ethers.id(`hanko-multi-${name}`);
  seenKeys.set(name, key);
  return key;
};
const addressOf = (name: string): string => new ethers.Wallet(keyOf(name)).address;
const idOf = (name: string): string => ethers.zeroPadValue(addressOf(name), 32);

/** A member of a claim: a named key that signed, a named key present only as a placeholder, or an earlier claim (by its index). */
type Member = { readonly signed: string } | { readonly placeholder: string } | { readonly claim: number };
type Claim = { readonly members: readonly { readonly member: Member; readonly weight: number }[]; readonly threshold: number; readonly delays?: readonly [number, number, number] };
type Shape = { readonly claims: readonly Claim[]; readonly signaturesInOrder?: readonly string[]; readonly extraPlaceholders?: readonly string[]; readonly packedOverride?: string };

const boardId = (threshold: number, ids: readonly string[], weights: readonly number[], delays: readonly [number, number, number] = [0, 0, 0]): string =>
  ethers.keccak256(coder.encode(BOARD_ABI, [[threshold, ids, weights, ...delays]]));

/** Build the envelope for `hash` and report the entity id it claims (the last claim). */
const build = (hash: string, shape: Shape) => {
  const signers = shape.signaturesInOrder ?? [...new Set(shape.claims.flatMap((c) => c.members.flatMap((m) => ("signed" in m.member ? [m.member.signed] : []))))];
  const placeholders = [...new Set([...shape.claims.flatMap((c) => c.members.flatMap((m) => ("placeholder" in m.member ? [m.member.placeholder] : []))), ...(shape.extraPlaceholders ?? [])])];
  const firstClaim = placeholders.length + signers.length;
  // a claim's id depends on the ids of the claims it names, which may be listed later (the out-of-order rejection case)
  const memo = new Map<number, string>();
  const idOfClaim = (index: number): string => {
    if (!memo.has(index)) {
      const claim = shape.claims[index]!;
      const ids = claim.members.map(({ member }) => ("claim" in member ? idOfClaim(member.claim) : idOf("placeholder" in member ? member.placeholder : member.signed)));
      memo.set(index, boardId(claim.threshold, ids, claim.members.map((m) => m.weight), claim.delays));
    }
    return memo.get(index)!;
  };
  const claimIds = shape.claims.map((_, i) => idOfClaim(i));
  const claims = shape.claims.map((claim, index) => {
    const positions = claim.members.map(({ member }) =>
      "placeholder" in member ? placeholders.indexOf(member.placeholder) : "signed" in member ? placeholders.length + signers.indexOf(member.signed) : firstClaim + member.claim);
    return [claimIds[index]!, positions, claim.members.map((m) => m.weight), claim.threshold, ...(claim.delays ?? [0, 0, 0])];
  });
  const sigs = signers.map((name) => ethers.Signature.from(rawHanko(hash, keyOf(name))));
  const recovery = new Uint8Array(Math.ceil(sigs.length / 8));
  sigs.forEach((s, i) => { if (s.v === 28) recovery[Math.floor(i / 8)]! |= 1 << (i % 8); });
  const packed = shape.packedOverride ?? (sigs.length === 0 ? "0x" : ethers.concat([...sigs.flatMap((s) => [s.r, s.s]), recovery]));
  const hanko = coder.encode(HANKO_ABI, [[placeholders.map(idOf), packed, claims, []]]);
  return { hanko, entityId: claimIds[claimIds.length - 1]!, placeholders, signers, claimIds };
};

const provider = EntityProvider__factory.createInterface();
const errors = [provider, HankoVerifier__factory.createInterface(), Depository__factory.createInterface()];
const nameOf = (data: string): string => {
  if (data === "0x") return "revert with no data";
  for (const iface of errors) { const parsed = iface.parseError(data); if (parsed) return parsed.name; }
  return data;
};

const verify = async (rig: Rig, hanko: string, hash: string) => {
  const calldata = provider.encodeFunctionData("verifyHankoSignature", [hanko, hash]);
  const result = await rig.vm.runReadOnlyCall({ to: createAddressFromString(rig.chain.addresses.entityProvider), caller: rig.vm.deployerAddress, data: ethers.getBytes(calldata), gasLimit: 50_000_000n });
  const returned = ethers.hexlify(result.execResult.returnValue ?? new Uint8Array());
  if (result.execResult.exceptionError) return { revertedWith: nameOf(returned) };
  const [entityId, success] = provider.decodeFunctionResult("verifyHankoSignature", returned);
  return { entityId: entityId as string, success: success as boolean };
};

const one = (name: string, weight = 1) => ({ member: { signed: name }, weight });
const absent = (name: string, weight = 1) => ({ member: { placeholder: name }, weight });
const inner = (claim: number, weight = 1) => ({ member: { claim }, weight });

export const hankoMultiVectors = async () => {
  seenKeys.clear();
  const rig = await boot("hanko-multi");
  const hash = ethers.id("hanko-multi-hash");
  const cases: unknown[] = [];
  const record = async (label: string, shape: Shape, expect: string) => {
    const built = build(hash, shape);
    cases.push({
      label, expect, hash, hanko: built.hanko,
      placeholders: built.placeholders.map(idOf), signers: built.signers.map(addressOf), claimEntityIds: built.claimIds, provedEntityId: built.entityId,
      result: await verify(rig, built.hanko, hash),
    });
    return built;
  };

  const twoOfThree: Claim = { members: [one("a"), one("b"), absent("c")], threshold: 2 };
  await record("2-of-3: a and b signed, c a placeholder", { claims: [twoOfThree] }, "accepted as the board's lazy entity");
  await record("3-of-3: all three signed", { claims: [{ members: [one("a"), one("b"), one("c")], threshold: 3 }] }, "accepted");
  await record("2-of-3 with only one signature: threshold not met", { claims: [{ members: [one("a"), absent("b"), absent("c")], threshold: 2 }] }, "success false");
  await record("weighted 3/1/1, threshold 3: the heavy member alone", { claims: [{ members: [one("heavy", 3), absent("x"), absent("y")], threshold: 3 }] }, "accepted");
  await record("weighted 3/1/1, threshold 3: the two light members together fall short", { claims: [{ members: [absent("heavy", 3), one("x"), one("y")], threshold: 3 }] }, "success false");

  // nested: B = 2-of-3 (a, b signed; c a placeholder); A = 2-of-2 over [B, d] with d signing
  const nestedB: Claim = { members: [one("a"), one("b"), absent("c")], threshold: 2 };
  await record("nested: A = 2-of-2 [d, B], B = 2-of-3 [a, b, c?], d signed", { claims: [nestedB, { members: [one("d"), inner(0)], threshold: 2 }] }, "accepted as A");
  await record("nested: only one of B's members signed, so B fails and so does A",
    { claims: [{ members: [one("a"), absent("b"), absent("c")], threshold: 2 }, { members: [one("d"), inner(0)], threshold: 2 }] }, "success false");
  await record("nested: A = 1-of-2 [d?, B] where only B signs (d a placeholder)",
    { claims: [nestedB, { members: [absent("d"), inner(0)], threshold: 1 }] }, "accepted as A");
  // three levels: C = 1-of-2 [A, e?]
  const threeDeep = await record("three levels: C = 1-of-2 [e?, A], A = 2-of-2 [d, B], B = 2-of-3 [a, b, c?]",
    { claims: [nestedB, { members: [one("d"), inner(0)], threshold: 2 }, { members: [absent("e"), inner(1)], threshold: 1 }] }, "accepted as C");
  await record("two nested boards side by side: T = 2-of-3 [t?, B1, B2]",
    { claims: [
      { members: [one("a"), one("b")], threshold: 2 },
      { members: [one("c"), one("d")], threshold: 2 },
      { members: [absent("t"), inner(0), inner(1)], threshold: 2 },
    ] }, "accepted as T");

  // rejections (each one changes one thing in an accepted proof)
  await record("rejected: claims out of order (A listed before the B it names)",
    { claims: [{ members: [one("d"), inner(1)], threshold: 2 }, nestedB] }, "revert");
  await record("rejected: a signer that is also named as a placeholder",
    { claims: [twoOfThree], extraPlaceholders: ["a"] }, "revert");
  await record("rejected: a claim nobody references (B listed but A names only d)",
    { claims: [nestedB, { members: [one("d")], threshold: 1 }] }, "revert");
  const short = build(hash, { claims: [twoOfThree] });
  const shortPacked = ethers.hexlify(ethers.getBytes(coder.decode(HANKO_ABI, short.hanko)[0].packedSignatures).slice(0, -1));
  await record("rejected: the packed signatures one byte short", { claims: [twoOfThree], packedOverride: shortPacked }, "revert");

  await record("rejected: a claim whose first member is another claim (the first member must be an address)",
    { claims: [nestedB, { members: [inner(0), one("d")], threshold: 2 }] }, "revert");

  // a duplicated signature: the same key twice in the packed block
  const dup = build(hash, { claims: [{ members: [one("a"), absent("z")], threshold: 1 }] });
  const sigA = ethers.Signature.from(rawHanko(hash, keyOf("a")));
  const packedTwice = ethers.concat([sigA.r, sigA.s, sigA.r, sigA.s, new Uint8Array([(sigA.v === 28 ? 1 : 0) | (sigA.v === 28 ? 2 : 0)])]);
  const dupHanko = coder.encode(HANKO_ABI, [[[idOf("z")], packedTwice, [[dup.entityId, [1, 2], [1, 1], 1, 0, 0, 0]], []]]);
  cases.push({ label: "rejected: the same signature twice", expect: "revert", hash, hanko: dupHanko, result: await verify(rig, dupHanko, hash) });

  // ---- added in review: what the first set leaves to the verifier's own reading of the rules ----
  const ORDER = ethers.getBigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");
  type RawClaim = { entityId: string; indexes: number[]; weights: number[]; threshold: number; delays?: [number, number, number] };
  const envelope = (placeholders: readonly string[], packed: string, claims: readonly RawClaim[], memberSignatures: readonly string[] = []): string =>
    coder.encode(HANKO_ABI, [[placeholders, packed, claims.map((c) => [c.entityId, c.indexes, c.weights, c.threshold, ...(c.delays ?? [0, 0, 0])]), memberSignatures]]);
  const partsOf = (hanko: string) => {
    const d = coder.decode(HANKO_ABI, hanko)[0] as any;
    return {
      placeholders: [...d.placeholders] as string[], packed: d.packedSignatures as string,
      claims: d.claims.map((c: any): RawClaim => ({ entityId: c.entityId, indexes: c.entityIndexes.map(Number), weights: c.weights.map(Number), threshold: Number(c.threshold), delays: [Number(c.boardChangeDelay), Number(c.controlChangeDelay), Number(c.dividendChangeDelay)] })),
    };
  };
  const recordRaw = async (label: string, expect: string, hanko: string) => { cases.push({ label, expect, hash, hanko, result: await verify(rig, hanko, hash) }); };
  const base = partsOf(build(hash, { claims: [twoOfThree] }).hanko);            // 2-of-3: a, b signed, c a placeholder; the claim's indexes are [1, 2, 0]

  await record("a nested claim that misses its threshold fails the proof even when the outer claim is met without it: A = 1-of-2 [d, B], B = 2-of-3 [a, b?, c?]",
    { claims: [{ members: [one("a"), absent("b"), absent("c")], threshold: 2 }, { members: [one("d"), inner(0)], threshold: 1 }] }, "success false");
  await record("threshold above the total weight: 3 of two members of weight 1 (never satisfiable)", { claims: [{ members: [one("a"), one("b")], threshold: 3 }] }, "success false");
  await record("weights 5 and 4 both signed, threshold 9: met exactly", { claims: [{ members: [one("a", 5), one("b", 4)], threshold: 9 }] }, "accepted");
  await record("weights 5 and 4 both signed, threshold 10: one short", { claims: [{ members: [one("a", 5), one("b", 4)], threshold: 10 }] }, "success false");
  await record("non-zero delays (1, 2, 3) are part of the board: 2-of-3 a, b signed, c a placeholder",
    { claims: [{ members: [one("a"), one("b"), absent("c")], threshold: 2, delays: [1, 2, 3] }] }, "accepted as that board's entity");
  await record("non-zero delays in a nested claim: B = 2-of-3 with delays (3, 2, 1) inside A = 2-of-2 [d, B] with delays (0, 7, 0)",
    { claims: [{ members: [one("a"), one("b"), absent("c")], threshold: 2, delays: [3, 2, 1] }, { members: [one("d"), inner(0)], threshold: 2, delays: [0, 7, 0] }] }, "accepted as A");

  // nine signers: the recovery bits spill into a second byte, with both parities on each side of the byte boundary
  const nine = ((): string[] => {
    for (let salt = 0; ; salt++) {
      const names = Array.from({ length: 9 }, (_, i) => `nine${salt}-${i}`);
      const vs = names.map((n) => ethers.Signature.from(rawHanko(hash, ethers.id(`hanko-multi-${n}`))).v);      // not keyOf: the keys tried and dropped are not recorded
      if (vs[8] === 28 && vs.slice(0, 8).includes(28) && vs.slice(0, 8).includes(27)) return names;
    }
  })();
  await record("five-of-nine, all nine signed: the recovery bits take two bytes", { claims: [{ members: nine.map((n) => one(n)), threshold: 5 }] }, "accepted");

  const tailByte = (packed: string) => ethers.getBytes(packed).at(-1)!;
  const withTail = (packed: string, tail: number) => ethers.hexlify(Uint8Array.from([...ethers.getBytes(packed).slice(0, -1), tail]));
  await recordRaw("rejected: a padding bit set in the recovery byte (two signatures use two bits)", "revert",
    envelope(base.placeholders, withTail(base.packed, tailByte(base.packed) | 0x80), base.claims));
  await record("rejected: a placeholder no claim uses", { claims: [twoOfThree], extraPlaceholders: ["unused"] }, "revert");
  await record("rejected: a signature no claim uses", { claims: [twoOfThree], signaturesInOrder: ["a", "b", "unused"] }, "revert");
  await recordRaw("rejected: the same placeholder twice", "revert", envelope([base.placeholders[0]!, base.placeholders[0]!], base.packed, [{ ...base.claims[0]!, indexes: [2, 3, 0] }]));
  await recordRaw("rejected: a claim names the same member index twice", "revert", envelope(base.placeholders, base.packed, [{ ...base.claims[0]!, indexes: [1, 1, 0] }]));
  await recordRaw("rejected: two claims for the same entity id", "revert",
    envelope(base.placeholders, base.packed, [base.claims[0]!, { ...base.claims[0]!, indexes: [1, 2, 3], weights: [1, 1, 1] }]));
  await recordRaw("rejected: weight zero", "revert", envelope(base.placeholders, base.packed, [{ ...base.claims[0]!, weights: [1, 0, 1] }]));
  await recordRaw("rejected: weight 65536 (past uint16)", "revert", envelope(base.placeholders, base.packed, [{ ...base.claims[0]!, weights: [1, 65536, 1] }]));
  await recordRaw("rejected: threshold zero", "revert", envelope(base.placeholders, base.packed, [{ ...base.claims[0]!, threshold: 0 }]));
  await recordRaw("rejected: threshold 65536 (past uint16)", "revert", envelope(base.placeholders, base.packed, [{ ...base.claims[0]!, threshold: 65536 }]));
  await recordRaw("rejected: three member indexes and two weights", "revert", envelope(base.placeholders, base.packed, [{ ...base.claims[0]!, weights: [1, 1] }]));
  await recordRaw("rejected: a claim with no members", "revert", envelope(base.placeholders, base.packed, [{ ...base.claims[0]!, indexes: [], weights: [] }]));
  await recordRaw("rejected: a member index past every placeholder, signer and claim", "revert", envelope(base.placeholders, base.packed, [{ ...base.claims[0]!, indexes: [1, 2, 99] }]));
  await recordRaw("rejected: member signature entries that do not match the placeholders (two entries, one placeholder)", "revert",
    envelope(base.placeholders, base.packed, base.claims, ["0x", "0x"]));
  await recordRaw("rejected: 257 placeholders", "revert",
    envelope(Array.from({ length: 257 }, (_, i) => idOf(`crowd${i}`)), "0x", [{ entityId: base.claims[0]!.entityId, indexes: [0], weights: [1], threshold: 1 }]));

  // a high-s twin of a valid signature recovers the same key; the verifier refuses it
  const twin = (name: string) => {
    const sig = ethers.Signature.from(rawHanko(hash, keyOf(name)));
    return { r: sig.r, s: ethers.toBeHex(ORDER - BigInt(sig.s), 32), v: sig.v === 27 ? 28 : 27 };
  };
  const packTwo = (first: { r: string; s: string; v: number }, second: { r: string; s: string; v: number }) =>
    ethers.concat([first.r, first.s, second.r, second.s, Uint8Array.from([(first.v === 28 ? 1 : 0) | (second.v === 28 ? 2 : 0)])]);
  const sigB = ethers.Signature.from(rawHanko(hash, keyOf("b")));
  await recordRaw("a high-s twin of a's signature: the proof fails (success false)", "success false",
    envelope(base.placeholders, packTwo(twin("a"), sigB), base.claims));

  // the bare 65-byte shape: the signer's own lazy entity
  const bare = ethers.getBytes(rawHanko(hash, keyOf("a")));
  await recordRaw("bare 65 bytes, v = 27 or 28: the signer's lazy entity", "accepted", ethers.hexlify(bare));
  await recordRaw("bare 65 bytes, v written as 0 or 1: accepted as the same lazy entity", "accepted", ethers.hexlify(Uint8Array.from([...bare.slice(0, 64), bare[64]! - 27])));
  await recordRaw("bare 65 bytes, v = 29: refused (success false)", "success false", ethers.hexlify(Uint8Array.from([...bare.slice(0, 64), 29])));
  const highS = twin("a");
  await recordRaw("bare 65 bytes, high-s twin: refused (success false)", "success false", ethers.hexlify(ethers.concat([highS.r, highS.s, Uint8Array.from([highS.v])])));

  // the nested entity acting: a batch signed by the three-level entity C moves C's reserve
  const c = threeDeep.entityId;
  await rig.chain.debugFundReserves(c, rig.TOKEN, 500n);
  const target = rig.R.id;
  const encoded = rig.encodeJBatch({ ...rig.createEmptyBatch(), reserveToReserve: [{ receivingEntity: target, tokenId: rig.TOKEN, amount: 77n }] } as never);
  const nonce = (await rig.chain.getEntityNonce(c)) + 1n;
  const batchHash = rig.batchHash(c, encoded, nonce);
  const batchHanko = build(batchHash, { claims: [nestedB, { members: [one("d"), inner(0)], threshold: 2 }, { members: [absent("e"), inner(1)], threshold: 1 }] });
  if (batchHanko.entityId !== c) throw new Error("the three-level board changed its entity id");
  const result = await rig.sendRaw(c, encoded, batchHanko.hanko, nonce);
  const depository = {
    entityId: c, entityNonce: nonce.toString(), encodedBatch: encoded, batchHash, hanko: batchHanko.hanko, result,
    reserves: { entity: (await rig.chain.getReserves(c, rig.TOKEN)).toString(), target: (await rig.chain.getReserves(target, rig.TOKEN)).toString() },
    events: (rig.last.events as { name: string; args: unknown; logIndex: number }[]).map(({ name, args, logIndex }) => ({ name, args: JSON.parse(JSON.stringify(args, (_k, v) => (typeof v === "bigint" ? v.toString() : v))), logIndex })),
  };
  const wrong = await rig.sendRaw(c, encoded, build(ethers.id("another hash"), { claims: [nestedB, { members: [one("d"), inner(0)], threshold: 2 }, { members: [absent("e"), inner(1)], threshold: 1 }] }).hanko, nonce + 1n);
  const signerKeys = Object.fromEntries([...seenKeys].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, key]) => [name, { key, address: new ethers.Wallet(key).address }]));
  return { hash, signerKeys, cases, depository: { ...depository, signedForAnotherHash: wrong } };
};
