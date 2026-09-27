

import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex as nobleHex } from "@noble/hashes/utils";
import {
  accountId, ackPlan, address, addressOf, applyAccountBody, bytesToHex, concat, encodeHankoEnvelope, encodeLazyAccountHanko, encodeLazyEntityId, entityId, genesisAccount, genesisAccountBody,
  genesisReplica, getDelta, hashEntityFrame, hexToBytes, isLeft, match, matchBy, ok, opt, packSignatures, partyOf, planAccountProposal, previewAck, replicaId, sentBy, setCreditLimit, signRaw, signature, tokenId,
  recoverRawSigner, unwrapOr, updateDelta, verifyAccountHanko, wordOf,
} from "./xln.ts";
import type {
  AccountEnvelope, AccountFrame, AccountGrammar, AccountId, AccountInput, AccountInputFor, AccountMessage, AccountOutput, AccountPhase, AccountReplica, AccountReplicaError, AccountTerms, Address, At, Board, DisputeHanko,
  DisputePlan, EntityFrame, EntityGrammar, EntityId, EntityPhase, EntityReplica, FrameClock, Hanko, HankoClaimInput, Hash, OpenAccount, Party, ProposedAccount, RawSig, Result, Signature, Verify, WireAccountTx,
  DeltaTransformerRef, JReplica, Runtime,
} from "./xln.ts";


const show = (e: unknown): string => (typeof e === "string" ? e : JSON.stringify(e, (_, v: unknown) => (typeof v === "bigint" ? v.toString() : v)));
export const unwrap = <T, E>(r: Result<T, E>): T => unwrapOr(r, (e) => { throw new Error(show(e)); });
export const unwrapErr = <T, E>(r: Result<T, E>): E => { if (r.ok) throw new Error("expected a refusal"); return r.error; };
const expectPhase = (want: string) => (found: string) => (): void => { if (found !== want) throw new Error(`expected ${want}, found ${found}`); };
export const inPhase = <P extends AccountPhase>(r: AccountReplica, p: P): At<AccountGrammar, P> => {
  const at = expectPhase(p);
  match(r, { open: at("open"), proposed: at("proposed"), received: at("received"), preparing: at("preparing"), disputed: at("disputed") });
  return r as At<AccountGrammar, P>;
};
export const entityInPhase = <P extends EntityPhase>(r: EntityReplica, p: P): At<EntityGrammar, P> => {
  const at = expectPhase(p);
  match(r, { open: at("open"), proposed: at("proposed"), locked: at("locked") });
  return r as At<EntityGrammar, P>;
};
export const outputOf = <K extends AccountOutput["kind"]>(outputs: readonly AccountOutput[], kind: K): Extract<AccountOutput, { readonly kind: K }> => {
  const found = outputs.find((o): o is Extract<AccountOutput, { readonly kind: K }> => o.kind === kind);
  if (found === undefined) throw new Error(`no ${kind} output`);
  return found;
};
export const causeOf = (e: AccountReplicaError): AccountReplicaError => { if (!("cause" in e)) throw new Error(`expected dispute_required, got ${e._tag}`); return e.cause; };
export const envelopeIn = (m: AccountMessage): AccountEnvelope => ({ fromEntityId: m.fromEntityId, toEntityId: m.toEntityId, domain: m.domain, disputeConfig: m.disputeConfig, ...opt("watchSeed", m.watchSeed) });
export const TOKEN = unwrap(tokenId("0"));


const digest = (h: Hash, addr: Address): Signature => unwrap(signature(nobleHex(keccak_256(new TextEncoder().encode(`sig:${h}:${addr}`)))));
/** Anvil-keyed signer addresses sign real ECDSA (0/1 recovery, og's validator signatures, so og's quorum Hanko builds); any other address signs a fake digest. */
let keyedSigners: ReadonlyMap<string, string> | undefined;
const keyFor = (addr: string): string | undefined => (keyedSigners ??= new Map([...ANVIL_KEYS, ...MORE_ANVIL_KEYS].map((k) => [signerAddress(k), k] as const))).get(addr.toLowerCase());
export const makeCrypto = () => {
  const issued = new Map<string, Signature>();
  const sign = (h: Hash, addr: Address): Result<Signature, "sign_failed"> => {
    const key = keyFor(addr);
    if (key !== undefined) return ok(unwrap(signature(signDigestHex(h, key).slice(2))));
    const sig = digest(h, addr); issued.set(`${h}:${addr}`, sig); return ok(sig);
  };
  const verify = (h: Hash, sig: Signature, addr: Address): boolean => (keyFor(addr) !== undefined ? (recoverRawSigner(h, sig) ?? "").toLowerCase() === addr.toLowerCase() : issued.get(`${h}:${addr}`) === sig);
  return { sign, verify };
};
export const crypto = makeCrypto();
export const signEntityFrame = (frame: EntityFrame, addr: Address): Signature => unwrap(crypto.sign(unwrap(hashEntityFrame(frame)), addr));


export const ANVIL_KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
] as const;
/** Anvil accounts #3-#9: more real keys for boards wider than three (og admission signs every local tx as its author). */
export const MORE_ANVIL_KEYS = [
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
  "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
  "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356",
  "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97",
  "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6",
] as const;
export const anvilKey = (i: number): string => { const k = ANVIL_KEYS[i]; if (k === undefined) throw new Error(`no anvil key at index ${i}`); return k; };
const rawOf = (h: Uint8Array, key: string) => { const s = signRaw(h, hexToBytes(key)); return { r: wordOf(s.r), s: wordOf(s.s), recovery: s.recovery, publicKey: s.publicKey }; };
const signPacked = (h: Uint8Array, key: string): RawSig => { const { r, s, recovery } = rawOf(h, key); return { r, s, v: recovery + 27 }; };
export const encodeRawSig = (i: { readonly hash: string; readonly privateKeyIndex: number }): { readonly signature: string; readonly v: number; readonly recovered: string; readonly s: string } => {
  const { r, s, recovery, publicKey } = rawOf(hexToBytes(i.hash), anvilKey(i.privateKeyIndex)), v = recovery + 27;
  return { signature: bytesToHex(concat([r, s, Uint8Array.of(v)])), v, recovered: addressOf(publicKey), s: bytesToHex(s) };
};
export const signDigestHex = (d: string, privateKey: string): string => { const { r, s, recovery } = rawOf(hexToBytes(d), privateKey); return bytesToHex(concat([r, s, Uint8Array.of(recovery)])); };
export const signerAddress = (privateKey: string): string => addressOf(rawOf(new Uint8Array(32).fill(1), privateKey).publicKey).toLowerCase();
const NUMBERED_TWO = `0x${"00".repeat(31)}02`;
export const hankoBytesEnvelopes = (): { readonly hash: string; readonly twoOfThree: string; readonly oneOfThree: string } => {
  const h = keccak_256(new TextEncoder().encode("xln-pure:hanko-bytes"));
  const account = (i: number): string => `0x${"0".repeat(24)}${addressOf(rawOf(h, anvilKey(i)).publicKey).slice(2)}`;
  const claim = (entityIndexes: readonly number[]): HankoClaimInput => ({ entityId: NUMBERED_TWO, entityIndexes, weights: [1, 1, 1], threshold: 2, boardChangeDelay: 1, controlChangeDelay: 2, dividendChangeDelay: 3 });
  return {
    hash: bytesToHex(h),
    twoOfThree: encodeHankoEnvelope({ placeholders: [account(2)], packedSignatures: packSignatures([signPacked(h, anvilKey(0)), signPacked(h, anvilKey(1))]), claims: [claim([1, 2, 0])], memberSignatures: [] }),
    oneOfThree: encodeHankoEnvelope({ placeholders: [account(1), account(2)], packedSignatures: packSignatures([signPacked(h, anvilKey(0))]), claims: [claim([2, 0, 1])], memberSignatures: [] }),
  };
};
export const signLazyAccountHanko = (d: string, privateKey: string, entity?: string): string => unwrap(encodeLazyAccountHanko(entity ?? encodeLazyEntityId({ signer: signerAddress(privateKey) }), signDigestHex(d, privateKey)));
export const signBoardAccountHanko = (d: string, board: Board & { readonly entityId: string }, privateKeys: readonly string[]): string => {
  const h = hexToBytes(d);
  const signed = new Map(privateKeys.map((key) => { const s = rawOf(h, key); return [addressOf(s.publicKey).toLowerCase(), { r: s.r, s: s.s, v: s.recovery + 27 }] as const; }));
  const members = board.entityIds.map((id) => `0x${id.slice(-40).toLowerCase()}`), byAddress = (l: string, r: string): number => (l < r ? -1 : l > r ? 1 : 0);
  const signers = members.filter((m) => signed.has(m)).sort(byAddress), absent = members.filter((m) => !signed.has(m)).sort(byAddress);
  return encodeHankoEnvelope({
    placeholders: absent.map((m) => `0x${"00".repeat(12)}${m.slice(2)}`),
    packedSignatures: packSignatures(signers.flatMap((m) => { const s = signed.get(m); return s === undefined ? [] : [s]; })),
    claims: [{ entityId: board.entityId, entityIndexes: members.map((m) => (signed.has(m) ? absent.length + signers.indexOf(m) : absent.indexOf(m))), weights: board.votingPowers, threshold: board.votingThreshold, boardChangeDelay: board.boardChangeDelay, controlChangeDelay: board.controlChangeDelay, dividendChangeDelay: board.dividendChangeDelay }],
    memberSignatures: [],
  });
};


export const CLOCK = { timestamp: 1_700_000_000_000n, jHeight: 1n } as const;
export const NOW = CLOCK.timestamp;
const PARTY_KEYS = [anvilKey(2), anvilKey(1), anvilKey(0)] as const;
const lazyParty = (key: string): EntityId => unwrap(entityId(encodeLazyEntityId({ signer: signerAddress(key) })));
export const ALICE = lazyParty(PARTY_KEYS[0]), BOB = lazyParty(PARTY_KEYS[1]), CAROL = lazyParty(PARTY_KEYS[2]);
export const aliceAddr = unwrap(address(signerAddress(PARTY_KEYS[0]))), bobAddr = unwrap(address(signerAddress(PARTY_KEYS[1]))), carolAddr = unwrap(address(signerAddress(PARTY_KEYS[2])));
const partyKeys: ReadonlyMap<EntityId, string> = new Map([[ALICE, PARTY_KEYS[0]], [BOB, PARTY_KEYS[1]], [CAROL, PARTY_KEYS[2]]]);
export const keyOf = (entity: EntityId): string => { const k = partyKeys.get(entity); if (k === undefined) throw new Error(`no key for ${entity}`); return k; };
export const TERMS: AccountTerms = {
  domain: { chainId: 31337, depositoryAddress: "0x5fbdb2315678afecb367f032d93f642f64180aa3" },
  watchSeed: `0x${"33".repeat(32)}`,
  disputeConfig: { leftResponseSeconds: 86400, rightResponseSeconds: 3600 },
};
export const JURISDICTION = TERMS.domain;
/** The durable jurisdiction stack of TERMS.domain: og requireAccountDeltaTransformerAddress reads it for every Account proof body with clauses. */
export const TEST_CONTRACTS = { depository: TERMS.domain.depositoryAddress, entityProvider: `0x${"55".repeat(20)}`, account: `0x${"66".repeat(20)}`, deltaTransformer: `0x${"77".repeat(20)}` } as const;
export const TEST_DT: DeltaTransformerRef = ok(TEST_CONTRACTS.deltaTransformer);
export const TEST_JREPLICA: JReplica = { name: "test", blockNumber: 0n, stateRoot: null, mempool: [], blockDelayMs: 0, lastBlockTimestamp: 0, position: { x: 0, y: 0, z: 0 }, chainId: TERMS.domain.chainId, contracts: TEST_CONTRACTS };
export const withTestJurisdiction = (rt: Runtime): Runtime => ({ ...rt, jReplicas: new Map([...rt.jReplicas, ["test", TEST_JREPLICA]]) });
export const partyIn = (r: AccountReplica, self: EntityId): Party => unwrap(partyOf(replicaId(r), self));
const pairAB = (): AccountId => unwrap(accountId(ALICE, BOB));
export const envelopeAB = (from: EntityId): AccountEnvelope => {
  const id = pairAB(), { domain, disputeConfig, watchSeed } = TERMS;
  return { fromEntityId: from, toEntityId: from === id.left ? id.right : id.left, domain, disputeConfig, watchSeed };
};
export const genesisAB = (): OpenAccount => unwrap(genesisReplica(pairAB(), TERMS));


const memo = <X>(compute: (key: string) => X) => { const held = new Map<string, X>(); return (key: string): X => { const c = held.get(key); if (c !== undefined) return c; const x = compute(key); held.set(key, x); return x; }; };
const hankoAt = memo((key: string): Hanko => { const [d, entity] = key.split("|") as [string, EntityId]; return signLazyAccountHanko(d, keyOf(entity), entity); });
const hankoOf = (d: string, entity: EntityId): Hanko => hankoAt(`${d}|${entity}`);
export const signAccountFrame = (frame: AccountFrame, entity: EntityId): Hanko => hankoOf(frame.stateHash, entity);
const verdictAt = memo((key: string): boolean => { const [d, hanko, entity] = key.split("|") as [string, string, string]; return verifyAccountHanko(hanko, d, entity).ok; });
export const hankoVerify: Verify = (d, hanko, entity) => verdictAt(`${d}|${hanko}|${entity}`);
export const verifiers = { verify: hankoVerify, verifyMember: crypto.verify, sign: crypto.sign } as const;
/** One signature per manifest entry, as og validators precommit (`hashPrecommits`). */
export const signManifestAs = (frame: EntityFrame, addr: Address): readonly Signature[] => frame.hashesToSign.map((h) => unwrap(crypto.sign(h.hash as Hash, addr)));
export const disputeFor = (plan: DisputePlan, entity: EntityId): DisputeHanko | undefined => match(plan, {
  sign: ({ draft }): DisputeHanko | undefined => ({ ...draft, hanko: hankoOf(draft.hash, entity) }), resend: ({ disputeHanko }): DisputeHanko | undefined => disputeHanko, none: (): DisputeHanko | undefined => undefined,
});


type ProposeInput = AccountInputFor<"propose">;
type AckInput = AccountInputFor<"ack">;
type AckFrameInput = AccountInputFor<"ack_frame">;
export const proposeInput = (r: AccountReplica, self: EntityId, clock: FrameClock = CLOCK, selected?: readonly WireAccountTx[]): ProposeInput => match(unwrap(planAccountProposal(r, self, clock, hankoVerify, selected)), {
  frame: ({ preview }): ProposeInput => ({ kind: "propose", frameHanko: signAccountFrame(preview.frame, self), ...opt("disputeHanko", disputeFor(preview.dispute, self)), ...opt("selected", selected), ...clock }),
  idle: (): ProposeInput => ({ kind: "propose", ...opt("selected", selected), ...clock }),
});
export const ackInput = (r: AccountReplica, self: EntityId): AckInput => {
  const p = unwrap(previewAck(r, self));
  return { kind: "ack", ...sentBy(r, partyIn(r, self)), height: p.height, frameHash: p.frameHash, frameHanko: hankoOf(p.frameHash, self), ...opt("disputeHanko", disputeFor(p.dispute, self)) };
};
const carriedBy = (p: ProposedAccount, self: EntityId): DisputeHanko | undefined => { const c = p.dispute.current; return c !== undefined && c.proposerIsLeft === isLeft(self, p.state.account.id) ? c : undefined; };
export const offerOf = (p: ProposedAccount, self: EntityId, ack: AckInput | null = null): AckFrameInput => ({
  kind: "ack_frame", ...sentBy(p, partyIn(p, self)),
  ack: ack === null ? null : { height: ack.height, frameHash: ack.frameHash, frameHanko: ack.frameHanko, ...opt("disputeHanko", ack.disputeHanko) },
  frame: p.candidate.frame, frameHanko: p.candidate.frameHanko, ...opt("disputeHanko", carriedBy(p, self)),
});
export const _ackPlan = ackPlan;
export type { AccountInput };


export const consumerExample = (): { readonly ok: true; readonly offdelta: string; readonly collateral: string; readonly ondelta: string } | { readonly ok: false } => {
  const alice = unwrap(entityId("alice")), bob = unwrap(entityId("bob")), token = unwrap(tokenId("0"));
  const state = unwrap(updateDelta(genesisAccount(unwrap(accountId(alice, bob))), token, (d) => setCreditLimit(d, 100n, false)));

  const terms: AccountTerms = { domain: { chainId: 31337, depositoryAddress: `0x${"5f".repeat(20)}` }, watchSeed: `0x${"33".repeat(32)}`, disputeConfig: { leftResponseSeconds: 86400, rightResponseSeconds: 3600 } };
  const stepped = applyAccountBody(genesisAccountBody(state, terms), { type: "payment", tokenId: token, amount: 25n }, { byLeft: true, nowMs: 1_000n, jHeight: 0n, accountHeight: 1n });
  if (!stepped.ok) return { ok: false };
  const row = getDelta(stepped.value.state.account, token);
  return { ok: true, offdelta: row.offdelta.toString(), collateral: row.collateral.toString(), ondelta: row.ondelta.toString() };
};
if (import.meta.main) { const out = consumerExample(); console.log(JSON.stringify(out)); if (!out.ok) process.exit(1); }
