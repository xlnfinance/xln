import { describe, expect, test } from "bun:test";
import { encodeAccountStateValue, encodeAccountStateValueOracle, computeCanonicalMerkleRoot } from "../../core/account/commitment/state-root.ts";
import { PersistentAccountStateMap } from "../../core/account/state/persistent-state-map.ts";
import { computeAccountStateRoot } from "../../core/account/commitment/state-root.ts";
import { computeFrameHash } from "../../core/account/consensus/frame/hash.ts";
import { ethers, Interface } from "ethers";
import { Depository__factory } from "../../jurisdictions/typechain-types/factories/Depository.sol/Depository__factory.ts";
import { encodeJBatch, computeBatchHankoHash, createEmptyBatch } from "../../core/jurisdiction/machine/batch/index.ts";
import { hashProofBodyStruct, createDisputeProofHashWithNonce, createSettlementHashWithNonce } from "../../core/protocol/dispute/proof-builder.ts";
import { encodeInt512, decodeInt512 } from "../../core/protocol/crypto/abi-money.ts";
import { computeAccountKey } from "../../core/jurisdiction/adapter/events/contract-codec.ts";
import { rawEventToJEvents } from "../../core/jurisdiction/adapter/events/j-event-payloads.ts";
import { encodeSignedHanko, encodeHankoEnvelope as ogEncodeHankoEnvelope, packHankoSignatures } from "../../core/hanko/codec.ts";
import { verifyCanonicalHanko } from "../../core/hanko/claims.ts";
import { lazySingleSignerEntityId, recoverShortHankoEntityId } from "../../core/hanko/short.ts";
import { computeCanonicalEntityConsensusStateHash, computeEntityAccountValueHash } from "../../core/entity/consensus/state-root.ts";
import { PersistentEntityAccountMap } from "../../core/entity/state/persistent-account-map.ts";
import { createEntityFrameHashFromStateRoot } from "../../core/entity/consensus/frame.ts";
import { replaceLocalDisputeDraft, storeCounterpartyDisputeHanko } from "../../core/account/consensus/dispute/hanko.ts";
import { ALICE, BOB, ackInput, envelopeAB, genesisAB, hankoVerify, offerOf, proposeInput, NOW } from "../xln_run.ts";
import { createAccountJClaimRecord, EMPTY_ACCOUNT_J_CLAIM_ROOT } from "../../core/account/j-claims/j-claim-codec.ts";
import { applyAccountJClaimInsert, createEmptyAccountJClaimAccumulator } from "../../core/account/j-claims/j-claim-accumulator.ts";
import { createAccountJClaimProof } from "../../core/account/j-claims/j-claim-proof.ts";
import { canonicalJurisdictionEventsHash } from "../../core/jurisdiction/machine/event-observation.ts";
import { canon, encodeCanonicalValue, flatDigest, mapRoot, bytesToHex, accountFrameHash, accountStateCommitment, EMPTY_J_ROOT, type CommittedAccountState,
  J_EVENT_SIGNATURES, jEventTopic, readJEvents, encodeAccountSettledData, encodeBatch, emptyBatch, encodeBatchHash, DEPOSITORY_BATCH_HANKO_DOMAIN, encodeProofBodyBytes, proofBodyHash, encodeDisputeProofHash, encodeCooperativeUpdateHash, encodeDisputeHash, encodeAccountKey,
  encodeLazyEntityId, encodeHanko65, encodeHankoEnvelope, packSignatures, verifyAccountHanko, verifyHankoLocal, encodeBoardBytes, entityStateRoot, entityFrameHash, keccak256Hex, accountId as rwAccountId, entityId as rwEntityId, accountTerms, admit, genesisReplica, applyAccountInput, installedAccount, committedView, previewAccountProposal, applyAccountBody, committed, hexToBytes, signRaw, wordOf, concat, addressOf, type Batch, type ProofBody } from "../xln.ts";

// seeded PRNG (mulberry32)
const prng = (seed: number) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
export const rng = prng(0xC0FFEE);
const ri = (n: number) => Math.floor(rng() * n);
const pick = <X>(xs: readonly X[]): X => xs[ri(xs.length)] as X;
const randBig = (): bigint => pick([0n, 1n, -1n, 127n, 128n, 255n, 256n, (1n << 255n) - 1n, -(1n << 255n), (1n << 256n) - 1n, BigInt(ri(1e9)) * BigInt(ri(1e9)) * (rng() < 0.5 ? -1n : 1n)]);
const randStr = (): string => pick(["", "a", "A", "0xAbCd", "0x" + "ab".repeat(32), "é", "日本", "x".repeat(60), "k".repeat(200), String(ri(1e6))]);
const randScalar = (): unknown => pick([() => null, () => rng() < 0.5, () => pick([0, -0, 1, -1, 1.5, 1e21, 2 ** 53, ri(1e6)]), randBig, randStr])();
const randValue = (d = 0): unknown => {
  const r = rng();
  if (d > 3 || r < 0.45) return randScalar();
  if (r < 0.6) return Array.from({ length: ri(4) }, () => randValue(d + 1));
  if (r < 0.75) return new Map(Array.from({ length: ri(5) }, () => [pick([randStr, () => ri(100), randBig])(), randValue(d + 1)] as const));
  if (r < 0.82) return new Set(Array.from({ length: ri(4) }, () => randScalar()));
  const o: Record<string, unknown> = {};
  for (let i = ri(6); i > 0; i--) o[pick(["a", "b", "B", "zz", "Z", "_", "10", "9", "é", ""])] = rng() < 0.1 ? undefined : randValue(d + 1);
  return o;
};
const hex = (b: Uint8Array) => bytesToHex(b);
const unwrap = <T,>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => { if (!r.ok) throw new Error(JSON.stringify(r.error)); return r.value; };

describe("canonical value encoding (RLP)", () => {
  test("MATCH: encodeCanonicalValue == og encodeAccountStateValue == og oracle on 500 random values", () => {
    for (let i = 0; i < 500; i++) {
      const v = randValue();
      const og = hex(encodeAccountStateValue(v));
      expect(hex(encodeAccountStateValueOracle(v))).toBe(og);
      expect(hex(unwrap(encodeCanonicalValue(v)))).toBe(og);
    }
  });
  test("MATCH: edge scalars", () => {
    for (const v of [null, true, false, 0, -0, 0n, -0n, (1n << 256n) - 1n, -(1n << 255n), "", "\u0000", [], {}, new Map(), new Set(), [[]], { a: undefined }]) {
      expect(hex(unwrap(encodeCanonicalValue(v)))).toBe(hex(encodeAccountStateValue(v)));
    }
  });
  test("MATCH: lone UTF-16 surrogate is refused by both (og UTF8_LONE_SURROGATE, rewrite invalid_utf8)", () => {
    for (const v of ["a\uD800b", { ["\uDC00"]: 1 }, new Map([["\uD800", 1]])]) {
      expect(() => encodeAccountStateValue(v)).toThrow("UTF8_LONE_SURROGATE");
      expect(encodeCanonicalValue(v)).toEqual({ ok: false, error: { _tag: "invalid_utf8" } });
    }
  });
});

describe("flat integrity digest", () => {
  test("MATCH: flatDigest == og computeCanonicalMerkleRoot(ns, entries, 'integrity') on 200 random section lists", () => {
    for (let i = 0; i < 200; i++) {
      const ns = pick(["account.frame", "account.state", "x", ""]);
      const names = [...new Set(Array.from({ length: ri(7) }, () => pick(["identity", "financial", "transactions", "a", "Z", "rebalance", "é"])))];
      const entries = names.map((n) => [n, randValue()] as const);
      expect(unwrap(flatDigest(ns, entries))).toBe(computeCanonicalMerkleRoot(ns, entries, "integrity"));
    }
  });
});

const ogMapRoot = (m: Map<number | string, unknown>): string => PersistentAccountStateMap.fromEntries("locks", m).rootHash();
const flatVal = (): unknown => { let v = randValue(); while (hasColl(v)) v = randValue(); return v; };
const hasColl = (v: unknown): boolean => v instanceof Map || v instanceof Set || (Array.isArray(v) ? v.some(hasColl) : v !== null && typeof v === "object" && Object.values(v).some(hasColl));
describe("account map (radix-16 Patricia) root", () => {
  test("MATCH: mapRoot == og PersistentAccountStateMap.rootHash for 200 random numeric-key maps (0..many keys)", () => {
    for (let i = 0; i < 200; i++) {
      const n = pick([0, 1, 2, 3, 5, 17, 40]);
      const m = new Map<number | string, unknown>();
      for (let k = 0; k < n; k++) m.set(pick([() => ri(20), () => ri(1 << 30), () => Number.MAX_SAFE_INTEGER - ri(3), () => 0])(), flatVal());
      expect(unwrap(mapRoot(m))).toBe(ogMapRoot(m));
    }
  });
  test("MATCH: mapRoot == og for 200 random string-key maps", () => {
    for (let i = 0; i < 200; i++) {
      const n = pick([0, 1, 2, 4, 9, 30]);
      const m = new Map<number | string, unknown>();
      for (let k = 0; k < n; k++) m.set(pick(["lock:", "0x", "a", "ab", "custody:", "debit:"]) + String(ri(50)), flatVal());
      expect(unwrap(mapRoot(m))).toBe(ogMapRoot(m));
    }
  });
});

describe("account map edge cases", () => {
  const og = (m: Map<any, any>) => { try { return PersistentAccountStateMap.fromEntries("locks", m).rootHash(); } catch (e) { return "THROW"; } };
  test("MATCH: prefix collision, nested collection, >10000-byte leaf are refused by both; mixed non-colliding keys hash equal", () => {
    expect(og(new Map<any, any>([[0, 1], ["", 2]]))).toBe("THROW");
    expect(mapRoot(new Map<any, any>([[0, 1], ["", 2]]))).toEqual({ ok: false, error: { _tag: "key_prefix_collision" } });
    expect(og(new Map<any, any>([[1, { a: new Map() }]]))).toBe("THROW");
    expect(mapRoot(new Map<any, any>([[1, { a: new Map() }]]))).toEqual({ ok: false, error: { _tag: "nested_collection" } });
    expect(og(new Map<any, any>([[1, "x".repeat(10001)]]))).toBe("THROW");
    expect(mapRoot(new Map<any, any>([[1, "x".repeat(10001)]]))).toEqual({ ok: false, error: { _tag: "leaf_too_large" } });
    for (const m of [new Map<any, any>([[1, 1], ["a", 2]]), new Map<any, any>([[5, 1], ["abc", 2], [7, 3]]), new Map<any, any>([[0, 1], ["\u0000", 2]])]) expect(unwrap(mapRoot(m))).toBe(og(m));
  });
});

const W = (b: string): `0x${string}` => `0x${b.repeat(32)}`;
const TX_TYPES = ["direct_payment", "set_credit_limit", "add_delta", "htlc_lock", "swap_offer", "deposit_collateral", "rebalance_policy", "settle_transition"];
const randTx = (): { type: string; data: any } => {
  const type = pick(TX_TYPES);
  if (type === "settle_transition") return { type, data: { kind: pick(["hanko", "propose", "hanko"]), revision: ri(5), settlementHash: W(pick(["62", "65"])), settlementHanko: "0x" + "ab".repeat(ri(5)), postProof: { nonce: ri(9), proposerIsLeft: rng() < 0.5, proofBodyHash: W("63"), hanko: "0x" + "cd".repeat(ri(4)) } } };
  if (type === "rebalance_policy") return { type, data: { tokenId: ri(4), policyVersion: ri(100), r: randValue() } };
  const data = (() => { const v = randValue(); return v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Map) && !(v instanceof Set) ? v : { v }; })();
  return { type, data };
};
describe("account frame hash", () => {
  test("MATCH: accountFrameHash == og computeFrameHash on 300 random frames (non-j_event_claim txs, incl. settle_transition hanko stripping)", () => {
    for (let i = 0; i < 300; i++) {
      const f = { height: ri(1e6), timestamp: 1_700_000_000_000 + ri(1e9), jHeight: ri(1e5), prevFrameHash: W(pick(["00", "11", "Ab"])), accountStateRoot: W(pick(["33", "aB"])), accountTxs: Array.from({ length: ri(5) }, randTx) };
      expect(unwrap(accountFrameHash(f))).toBe(computeFrameHash({ ...f, stateHash: "" } as any));
    }
  });
  test("MATCH: rebalance_policy with unsafe policyVersion is refused by both", () => {
    const f = { height: 1, timestamp: 1, jHeight: 1, prevFrameHash: W("00"), accountStateRoot: W("00"), accountTxs: [{ type: "rebalance_policy", data: { policyVersion: 2 ** 53 } }] };
    expect(() => computeFrameHash({ ...f, stateHash: "" } as any)).toThrow();
    expect(accountFrameHash(f)).toEqual({ ok: false, error: { _tag: "policy_version" } });
  });
  test("MATCH (malformed input): settle_transition with null data, or kind=hanko without postProof, is refused by both; other malformed shapes hash identically", () => {
    const frame = (data: unknown) => ({ height: 1, timestamp: 1, jHeight: 1, prevFrameHash: W("00"), accountStateRoot: W("00"), accountTxs: [{ type: "settle_transition", data }] });
    const og = (data: unknown) => { try { return computeFrameHash({ ...frame(data), stateHash: "" } as any); } catch { return "REJECT"; } };
    const rw = (data: unknown) => { const r = accountFrameHash(frame(data)); return r.ok ? r.value : "REJECT"; };
    for (const data of [null, { kind: "hanko", settlementHanko: "0x01" }, { kind: "hanko", postProof: null }, { kind: "hanko", postProof: "x", settlementHanko: "0x01" }, { kind: "hanko", postProof: [1] }, { kind: "hanko", postProof: { hanko: "0x02", nonce: 1 } }, { kind: "propose", settlementHanko: "0x01" }, { kind: new String("hanko"), settlementHanko: "0x01" }, "x", 5]) {
      expect(rw(data)).toBe(og(data));
    }
    expect(rw(null)).toBe("REJECT");
    expect(rw({ kind: "hanko" })).toBe("REJECT");
  });
});

const P = (ns: string, m: ReadonlyMap<any, any>) => PersistentAccountStateMap.fromEntries(ns as any, m);
const toOgState = (s: CommittedAccountState, extra: Record<string, unknown> = {}): any => ({
  domain: s.domain, leftEntity: s.leftEntity, rightEntity: s.rightEntity, watchSeed: s.watchSeed, disputeConfig: s.disputeConfig, jNonce: s.jNonce, lastFinalizedJHeight: s.lastFinalizedJHeight,
  leftPendingJClaims: s.leftPendingJClaims, rightPendingJClaims: s.rightPendingJClaims,
  deltas: P("deltas", s.deltas), locks: P("locks", s.locks), pulls: P("pulls", s.pulls), swapOffers: P("swapOffers", s.swapOffers), subcontracts: P("subcontracts", s.subcontracts), lendingIntents: P("lendingIntents", s.lendingIntents),
  requestedRebalance: P("requestedRebalance", s.requestedRebalance), requestedRebalanceFeeState: P("requestedRebalanceFeeState", s.requestedRebalanceFeeState), rebalanceFeePolicies: P("rebalanceFeePolicies", s.rebalanceFeePolicies), ...extra,
});
const strMap = (n: number) => new Map<string, unknown>(Array.from({ length: n }, (_, i) => [`k${i}:${ri(1000)}`, flatVal()]));
const randState = (): CommittedAccountState => {
  const deltas = new Map<number, any>();
  for (let k = ri(6); k > 0; k--) { const tokenId = ri(70000); deltas.set(tokenId, { tokenId, collateral: BigInt(ri(1e9)), ondelta: randBig() % (1n << 200n), offdelta: randBig() % (1n << 200n), leftCreditLimit: BigInt(ri(1e6)), rightCreditLimit: 0n, leftAllowance: 0n, rightAllowance: BigInt(ri(9)), leftHold: 0n, rightHold: BigInt(ri(5)) }); }
  const claims = () => (rng() < 0.7 ? { version: 1 as const, root: EMPTY_J_ROOT, count: 0n } : { version: 1 as const, root: W(pick(["ab", "CD"])), count: BigInt(1 + ri(9)) });
  return {
    domain: { chainId: 1 + ri(40000), depositoryAddress: pick([`0x${"ab".repeat(20)}`, "0x5FbDB2315678afecb367f032d93F642f64180aa3", `0x${"00".repeat(20)}`]) },
    leftEntity: W(pick(["11", "aA"])), rightEntity: W(pick(["22", "Bb"])), watchSeed: W(pick(["44", "eE"])), disputeConfig: { leftResponseSeconds: ri(100), rightResponseSeconds: ri(100) },
    jNonce: ri(10), lastFinalizedJHeight: ri(1000), leftPendingJClaims: claims(), rightPendingJClaims: claims(),
    deltas, locks: strMap(ri(4)), pulls: strMap(ri(2)), swapOffers: strMap(ri(3)), subcontracts: strMap(ri(2)), lendingIntents: strMap(ri(3)),
    requestedRebalance: new Map(Array.from({ length: ri(3) }, () => [ri(100), BigInt(ri(1e6))] as const)), requestedRebalanceFeeState: new Map(), rebalanceFeePolicies: new Map(Array.from({ length: ri(3) }, () => [ri(100), { feePpm: ri(1000) }] as const)),
  };
};
describe("account state commitment", () => {
  test("MATCH: accountStateCommitment == og computeAccountStateRoot on 200 random states without a settlement workspace", () => {
    for (let i = 0; i < 200; i++) {
      const s = randState();
      expect(unwrap(accountStateCommitment(s))).toBe(computeAccountStateRoot(toOgState(s)));
    }
  });
  test("MATCH (H5): og binds settlementWorkspace (minus hankos, incl. post-proof hankos) into the 'commitments' section; so does the rewrite", () => {
    for (let i = 0; i < 50; i++) {
      const s = randState();
      const workspace: any = { workspaceHash: W("61"), ops: [{ type: "r2c", tokenId: 1 + ri(5), amount: BigInt(1 + ri(99)) }], lastModifiedByLeft: rng() < 0.5, status: pick(["awaiting_counterparty", "ready_to_submit", "submitted"]), revision: 1 + ri(4), createdAt: ri(99), lastUpdatedAt: ri(99), executorIsLeft: rng() < 0.5,
        ...(rng() < 0.5 ? { memo: "m" } : {}), ...(rng() < 0.5 ? { settlementHash: W("62"), nonceAtSign: 3, leftHanko: "0xaa", rightHanko: "0xbb", postSettlementDisputeProof: { disputeHash: W("63"), proofBodyHash: W("64"), nonce: 4, proposerIsLeft: true, leftHanko: "0xcc" } } : {}) };
      const withWs = computeAccountStateRoot(toOgState(s, { settlementWorkspace: workspace }));
      expect(withWs).not.toBe(computeAccountStateRoot(toOgState(s)));
      expect(unwrap(accountStateCommitment({ ...s, settlementWorkspace: workspace }))).toBe(withWs);
      const rehankoed = { ...workspace, leftHanko: "0xff", ...(workspace.postSettlementDisputeProof ? { postSettlementDisputeProof: { ...workspace.postSettlementDisputeProof, rightHanko: "0xdd" } } : {}) };
      expect(computeAccountStateRoot(toOgState(s, { settlementWorkspace: rehankoed }))).toBe(withWs);
      expect(unwrap(accountStateCommitment({ ...s, settlementWorkspace: rehankoed }))).toBe(withWs);
    }
  });
  test("MATCH: mixed-case depository with a bad EIP-55 checksum is refused by both; all-uppercase accepted by both", () => {
    const s = randState();
    const bad = { ...s, domain: { chainId: 1, depositoryAddress: "0x5fbDB2315678afecb367f032d93F642f64180aa3" } };
    expect(() => computeAccountStateRoot(toOgState(bad))).toThrow();
    expect(accountStateCommitment(bad)).toEqual({ ok: false, error: { _tag: "bad_domain" } });
    const upper = { ...s, domain: { chainId: 1, depositoryAddress: "0x5FBDB2315678AFECB367F032D93F642F64180AA3" } };
    expect(unwrap(accountStateCommitment(upper))).toBe(computeAccountStateRoot(toOgState(upper)));
  });
});

// ---------------------------------------------------------------- events
const DEPOSITORY = new Interface(Depository__factory.abi as any);
describe("J event signatures vs Depository ABI (typechain from Types.sol/Depository.sol)", () => {
  test("MATCH: HankoBatchProcessed, ReserveUpdated, DisputeStarted, DisputeFinalized topics equal the contract's", () => {
    for (const n of ["HankoBatchProcessed", "ReserveUpdated", "DisputeStarted", "DisputeFinalized"] as const) {
      const e = DEPOSITORY.getEvent(n)!;
      expect(e.format("sighash")).toBe(J_EVENT_SIGNATURES[n]);
      expect(jEventTopic(n)).toBe(e.topicHash);
    }
  });
  test("MATCH: AccountSettled -- contract TokenSettlement.ondelta is Int512 (int256 high, uint256 low); rewrite signature and topic0 equal the contract's", () => {
    const e = DEPOSITORY.getEvent("AccountSettled")!;
    expect(e.format("sighash")).toBe("AccountSettled((bytes32,bytes32,(uint256,uint256,uint256,uint256,(int256,uint256))[],uint256)[])");
    expect<string>(J_EVENT_SIGNATURES.AccountSettled).toBe(e.format("sighash"));
    expect(jEventTopic("AccountSettled")).toBe(e.topicHash);
  });
  test("MATCH: readJEvents decodes real contract AccountSettled logs (Int512 ondelta, og decodeInt512) and encodeAccountSettledData emits the contract layout (50 random)", () => {
    const I512 = [0n, 1n, -1n, -7n, (1n << 255n), -(1n << 256n) - 3n, (1n << 511n) - 1n, -(1n << 511n)];
    for (let i = 0; i < 50; i++) {
      const settled = arrOf(() => ({ left: W(pick(["11", "aa"])), right: W(pick(["22", "bb"])), tokens: arrOf(() => ({ tokenId: ru(), leftReserve: ru(), rightReserve: ru(), collateral: ru(), ondelta: pick(I512) })), nonce: ru() }));
      const log = DEPOSITORY.encodeEventLog("AccountSettled", [settled.map((r) => [r.left, r.right, r.tokens.map((t) => [t.tokenId, t.leftReserve, t.rightReserve, t.collateral, encodeInt512(t.ondelta)]), r.nonce])]);
      const parsed = DEPOSITORY.parseLog(log)!.args[0] as any[];
      const ogOndeltas = [...parsed].flatMap((r: any) => [...r[2]].map((t: any) => decodeInt512([t[4][0], t[4][1]])));
      const got = readJEvents([{ topics: log.topics, data: log.data }]);
      expect(got).toEqual([{ type: "AccountSettled", settled }]);
      expect(got.flatMap((g: any) => g.settled.flatMap((r: any) => r.tokens.map((t: any) => t.ondelta)))).toEqual(ogOndeltas);
      expect(encodeAccountSettledData(settled)).toBe(log.data);
    }
  });
  test("MATCH: readJEvents decodes contract-encoded HankoBatchProcessed / ReserveUpdated / DisputeStarted / DisputeFinalized logs (randomized, 50 each)", () => {
    for (let i = 0; i < 50; i++) {
      const b = () => W(pick(["11", "aB", "00", "ff"]));
      const u = () => pick([0n, 1n, (1n << 256n) - 1n, BigInt(ri(1e9))]);
      // og normalizers: a HankoBatchProcessed nonce is a safe integer >= 1 and a ReserveUpdated tokenId a safe integer (j-layer.test.ts covers the refusals).
      const s = () => pick([1n, BigInt(1 + ri(1e9)), BigInt(Number.MAX_SAFE_INTEGER)]);
      const h = DEPOSITORY.encodeEventLog("HankoBatchProcessed", [b(), b(), s()]);
      const r = DEPOSITORY.encodeEventLog("ReserveUpdated", [b(), s(), u()]);
      const lw = ri(2 ** 32), rw = ri(2 ** 32), start = BigInt(1 + ri(2 ** 40));
      const ds = [b(), b(), u(), rng() < 0.5, b(), b(), "0x" + "ab".repeat(ri(40)), "0x" + "cd".repeat(ri(3)), b(), start + BigInt(lw + rw), start, lw, rw] as const;
      const d = DEPOSITORY.encodeEventLog("DisputeStarted", [...ds]);
      const f = DEPOSITORY.encodeEventLog("DisputeFinalized", [b(), b(), u(), b(), b()]);
      const got = readJEvents([h, r, d, f].map((l) => ({ topics: l.topics, data: l.data })));
      expect(got.length).toBe(4);
      const parsed = [h, r, d, f].map((l) => DEPOSITORY.parseLog(l)!);
      const [gh, gr, gd, gf] = got as any[];
      expect([gh.entityId, gh.batchHash, gh.nonce]).toEqual([parsed[0]!.args[0].toLowerCase(), parsed[0]!.args[1].toLowerCase(), parsed[0]!.args[2]]);
      expect([gr.entity, gr.tokenId, gr.newBalance]).toEqual([parsed[1]!.args[0].toLowerCase(), parsed[1]!.args[1], parsed[1]!.args[2]]);
      const a = parsed[2]!.args;
      expect([gd.sender, gd.counterentity, gd.nonce, gd.proposerIsLeft, gd.proofbodyHash, gd.watchSeed, gd.starterInitialArguments, gd.starterCounterArguments, gd.starterCounterProofCommitment, gd.disputeTimeout, gd.disputeStartTimestamp, gd.leftResponseSeconds, gd.rightResponseSeconds])
        .toEqual([a[0].toLowerCase(), a[1].toLowerCase(), a[2], a[3], a[4].toLowerCase(), a[5].toLowerCase(), a[6], a[7], a[8].toLowerCase(), a[9], a[10], a[11], a[12]]);
      expect([gf.finalProofbodyHash, gf.finalizationEvidenceHash]).toEqual([parsed[3]!.args[3].toLowerCase(), parsed[3]!.args[4].toLowerCase()]);
    }
  });
});

describe("DisputeStarted clock validation (og j-event-payloads.ts assertRawEventSpecificFields)", () => {
  test("MATCH: a DisputeStarted log whose clock is not a positive safe-integer start + windows = timeout is refused by og ingress and by readJEvents", () => {
    const b = W("11");
    const MAX = BigInt(Number.MAX_SAFE_INTEGER);
    const ogAccepts = (log: { topics: readonly string[]; data: string }): boolean => {
      const args = DEPOSITORY.parseLog(log as any)!.args.toObject();
      // og ingress attaches the initial ProofBody from the batch calldata; the log itself does not carry it.
      const initialProofbody = { watchSeed: args.watchSeed, leftResponseSeconds: args.leftResponseSeconds, rightResponseSeconds: args.rightResponseSeconds, offdeltas: [], tokenIds: [], transformers: [] };
      try { return rawEventToJEvents({ name: "DisputeStarted", args: { ...args, initialProofbody }, blockNumber: 1, blockHash: W("01"), transactionHash: W("02"), logIndex: 0 } as any, b).length === 1; } catch { return false; }
    };
    const cases: [bigint, bigint, number, number][] = [[10n, 5n, 2, 3], [0n, 0n, 0, 0], [5n, 5n, 0, 0], [11n, 5n, 2, 3], [9n, 5n, 2, 3], [MAX, MAX - 7n, 3, 4], [MAX + 1n, MAX - 6n, 3, 4], [(1n << 256n) - 1n, 1n, 0, 0], [3n, 5n, 0, 0], [7n, 0n, 3, 4]];
    let accepted = 0;
    for (const [timeout, start, l, r] of cases) {
      const log = DEPOSITORY.encodeEventLog("DisputeStarted", [b, b, 1n, true, b, b, "0x", "0x", b, timeout, start, l, r]);
      const rwOk = (() => { try { return readJEvents([{ topics: log.topics, data: log.data }]).length === 1; } catch { return false; } })();
      expect(rwOk).toBe(ogAccepts(log));
      if (rwOk) accepted++;
    }
    expect(accepted).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------- batch / proof body / hanko payloads
const U256 = (1n << 256n) - 1n;
const rb32 = () => W(pick(["11", "22", "aa", "00", "fe"]));
const ru = () => pick([0n, 1n, U256, BigInt(ri(1e9))]);
const addr = () => pick([`0x${"ab".repeat(20)}`, "0x5FbDB2315678afecb367f032d93F642f64180aa3", `0x${"01".repeat(20)}`]);
const rbytes = () => "0x" + "5a".repeat(ri(70));
const arrOf = <X,>(f: () => X, max = 3): X[] => Array.from({ length: ri(max + 1) }, f);
const randProofBody = (offdeltas = true): ProofBody => {
  const n = ri(4);
  return { watchSeed: rb32(), leftResponseSeconds: BigInt(ri(2 ** 32)), rightResponseSeconds: BigInt(ri(2 ** 32)), offdeltas: offdeltas ? Array.from({ length: n }, () => pick([0n, -1n, 1n, -(1n << 255n), (1n << 255n) - 1n])) : [], tokenIds: offdeltas ? Array.from({ length: n }, () => BigInt(ri(100))) : [],
    transformers: arrOf(() => ({ transformerAddress: addr(), encodedBatch: rbytes(), allowances: arrOf(() => ({ deltaIndex: BigInt(ri(4)), rightAllowance: ru(), leftAllowance: ru() })) }), 2) };
};
const PROOF_BODY_TYPE = "tuple(bytes32 watchSeed,uint32 leftResponseSeconds,uint32 rightResponseSeconds,tuple(int256 high,uint256 low)[] offdeltas,uint256[] tokenIds,tuple(address transformerAddress,bytes encodedBatch,tuple(uint256 deltaIndex,uint256 rightAllowance,uint256 leftAllowance)[] allowances)[] transformers)";
const ogProofBody = (b: ProofBody) => ({ ...b, offdeltas: b.offdeltas.map(encodeInt512) });
const randBatch = (withSignedMoney: boolean): Batch => ({
  reserveToReserve: arrOf(() => ({ receivingEntity: rb32(), tokenId: ru(), amount: ru() })),
  reserveToCollateral: arrOf(() => ({ tokenId: ru(), receivingEntity: rb32(), pairs: arrOf(() => ({ entity: rb32(), amount: ru() })) })),
  collateralToReserve: arrOf(() => ({ counterparty: rb32(), tokenId: ru(), amount: ru(), nonce: ru(), sig: rbytes() })),
  settlements: withSignedMoney ? arrOf(() => ({ leftEntity: rb32(), rightEntity: rb32(), diffs: arrOf(() => ({ tokenId: ru(), leftDiff: pick([0n, 5n, -5n]), rightDiff: pick([0n, 3n, -3n]), collateralDiff: pick([0n, 2n]), ondeltaDiff: pick([0n, -1n]) })), forgiveDebtsInTokenIds: arrOf(ru), sig: rbytes(), nonce: ru() })) : [],
  disputeStarts: withSignedMoney ? arrOf(() => ({ counterentity: rb32(), nonce: ru(), proposerIsLeft: rng() < 0.5, proofbodyHash: rb32(), initialProofbody: randProofBody(), watchSeed: rb32(), sig: rbytes(), starterInitialArguments: rbytes(), starterCounterArguments: rbytes(), starterCounterProofCommitment: rb32() }), 1) : [],
  counterDisputes: withSignedMoney ? arrOf(() => ({ counterentity: rb32(), initialNonce: ru(), initialProofbodyHash: rb32(), counterNonce: ru(), proposerIsLeft: rng() < 0.5, counterProofbody: randProofBody(), sig: rbytes() }), 1) : [],
  disputeFinalizations: withSignedMoney ? arrOf(() => ({ counterentity: rb32(), initialNonce: ru(), finalNonce: ru(), proposerIsLeft: rng() < 0.5, initialProofbodyHash: rb32(), finalProofbody: randProofBody(), starterArguments: rbytes(), otherArguments: rbytes(), sig: rbytes(), startedByLeft: rng() < 0.5, cooperative: rng() < 0.5 }), 1) : [],
  externalTokenToReserve: arrOf(() => ({ entity: rb32(), contractAddress: addr(), externalTokenId: ru(), tokenType: BigInt(ri(3)), internalTokenId: ru(), amount: ru() })),
  reserveToExternalToken: arrOf(() => ({ receivingEntity: rb32(), tokenId: ru(), amount: ru() })),
  revealSecrets: arrOf(() => ({ transformer: addr(), secret: rb32() })),
  hashLadderRegistrations: arrOf(() => ({ counterpartyEntity: rb32(), targetRole: rng() < 0.5, fullHash: rb32(), partialRoot: rb32(), witness: { fillRatio: BigInt(ri(65536)), fullSecret: rb32(), reveals: [rb32(), rb32(), rb32(), rb32()] as const } })),
});
const ogBatch = (b: Batch): any => ({ ...b,
  disputeStarts: b.disputeStarts.map((d) => ({ ...d, initialProofbody: ogProofBody(d.initialProofbody) })),
  counterDisputes: b.counterDisputes.map((d) => ({ ...d, counterProofbody: ogProofBody(d.counterProofbody) })),
  disputeFinalizations: b.disputeFinalizations.map((d) => ({ ...d, finalProofbody: ogProofBody(d.finalProofbody) })),
  hashLadderRegistrations: b.hashLadderRegistrations.map((h) => ({ ...h, witness: { ...h.witness, reveals: [...h.witness.reveals] } })) });
const ogEncodeBatchNoLimit = (b: Batch): string => { try { return encodeJBatch(ogBatch(b)); } catch (e) { return "THROW:" + (e as Error).message; } };
describe("Depository Batch ABI", () => {
  test("MATCH: encodeBatch == og encodeJBatch for 200 random batches without settlements/disputes (reserve ops, C2R, external tokens, reveals, hash-ladder)", () => {
    let n = 0;
    for (let i = 0; i < 200; i++) {
      const b = randBatch(false);
      const og = ogEncodeBatchNoLimit(b);
      if (og.startsWith("THROW")) continue;
      n++;
      expect(encodeBatch(b)).toBe(og);
    }
    expect(n).toBeGreaterThan(150);
    expect(encodeBatch(emptyBatch())).toBe(encodeJBatch(createEmptyBatch()));
  });
  test("MATCH: encodeBatch == og encodeJBatch for 200 random batches with settlement diffs (SignedAmount) and dispute proof bodies (Int512 offdeltas)", () => {
    let wide = 0, checked = 0;
    for (let i = 0; i < 200; i++) {
      const b = randBatch(true);
      const og = ogEncodeBatchNoLimit(b);
      if (og.startsWith("THROW")) continue;
      checked++;
      if (b.settlements.some((s) => s.diffs.length > 0) || [...b.disputeStarts.map((d) => d.initialProofbody), ...b.counterDisputes.map((d) => d.counterProofbody), ...b.disputeFinalizations.map((d) => d.finalProofbody)].some((p) => p.offdeltas.length > 0)) wide++;
      expect(encodeBatch(b)).toBe(og);
    }
    expect(wide).toBeGreaterThan(50);
    expect(checked).toBeGreaterThan(100);
  });
  test("MATCH: encodeBatchHash (fixed domain keccak('XLN_DEPOSITORY_HANKO_V1')) == og computeBatchHankoHash (100 random)", () => {
    expect(DEPOSITORY_BATCH_HANKO_DOMAIN).toBe(keccak256Hex(new TextEncoder().encode("XLN_DEPOSITORY_HANKO_V1")));
    for (let i = 0; i < 100; i++) {
      const encodedBatch = encodeBatch(randBatch(true)), chainId = 1 + ri(1e6), depository = addr(), nonce = ru();
      expect(encodeBatchHash({ chainId, depository, encodedBatch, nonce: nonce.toString() })).toBe(computeBatchHankoHash(BigInt(chainId), depository, encodedBatch, nonce));
    }
  });
  test("MATCH: chainId 0, the zero depository and a bad-checksum depository are refused by og requireDepositoryDomain and by every rewrite depository digest", () => {
    const bad = [[0, addr()], [1, `0x${"00".repeat(20)}`], [1, "0x5fbDB2315678afecb367f032d93F642f64180aa3"], [-1, addr()]] as const;
    for (const [chainId, depository] of bad) {
      expect(() => computeBatchHankoHash(BigInt(chainId), depository, "0x", 1n)).toThrow();
      expect(() => encodeBatchHash({ chainId, depository, encodedBatch: "0x", nonce: "1" })).toThrow();
      expect(() => createDisputeProofHashWithNonce({ leftEntity: W("11"), rightEntity: W("22"), watchSeed: W("44") } as any, W("33"), { chainId, depositoryAddress: depository }, 1, true)).toThrow();
      expect(() => encodeDisputeProofHash({ messageType: 1, chainId, contractAddress: depository, accountKey: computeAccountKey(W("11"), W("22")), nonce: "1", proposerIsLeft: true, proofbodyHash: W("33"), watchSeed: W("44") })).toThrow();
      expect(() => createSettlementHashWithNonce({ leftEntity: W("11"), rightEntity: W("22") } as any, [], [], { chainId, depositoryAddress: depository }, 1)).toThrow();
      expect(() => encodeCooperativeUpdateHash({ messageType: 0, chainId, contractAddress: depository, accountKey: computeAccountKey(W("11"), W("22")), nonce: "1", diffs: [], forgiveDebtsInTokenIds: [] })).toThrow();
    }
  });
});

describe("ProofBody hash", () => {
  test("MATCH: proofBodyHash (Int512[] offdeltas) == og hashProofBodyStruct on 200 random bodies with tokens, incl. offdeltas beyond int256", () => {
    let n = 0;
    for (let i = 0; i < 200; i++) {
      const b0 = randProofBody();
      const b = { ...b0, offdeltas: b0.offdeltas.map((x) => (rng() < 0.3 ? pick([(1n << 511n) - 1n, -(1n << 511n), -(1n << 300n) + 5n, 1n << 256n]) : x)) };
      if (b.offdeltas.length > 0) n++;
      expect(proofBodyHash(b)).toBe(hashProofBodyStruct(ogProofBody(b) as any));
      expect(encodeProofBodyBytes(b)).toBe(ethers.AbiCoder.defaultAbiCoder().encode([PROOF_BODY_TYPE], [ogProofBody(b)]));
    }
    expect(n).toBeGreaterThan(100);
  });
  test("MATCH: offdeltas outside int512 are refused by both", () => {
    for (const x of [1n << 511n, -(1n << 511n) - 1n]) {
      const b = { ...randProofBody(false), offdeltas: [x], tokenIds: [1n] };
      expect(() => ogProofBody(b)).toThrow();
      expect(() => proofBodyHash(b)).toThrow();
    }
  });
  test("MATCH: token-free bodies (the only case where int256[] and Int512[] coincide: empty array) hash identically, incl. transformers", () => {
    for (let i = 0; i < 100; i++) { const b = randProofBody(false); expect(proofBodyHash(b)).toBe(hashProofBodyStruct(ogProofBody(b) as any)); }
  });
});

describe("dispute / cooperative-update hanko digests", () => {
  const domain = { chainId: 31337, depositoryAddress: "0x5FbDB2315678afecb367f032d93F642f64180aa3" };
  test("MATCH: encodeDisputeProofHash == og createDisputeProofHashWithNonce (200 random, mixed-case ids, max nonce)", () => {
    for (let i = 0; i < 200; i++) {
      const l = W(pick(["11", "aA", "Ff"])), r = W(pick(["22", "Bb", "00"])), nonce = pick([0, 1, Number.MAX_SAFE_INTEGER, ri(1e6)]), prop = rng() < 0.5, pbh = rb32(), seed = W(pick(["44", "Ee"]));
      const key = encodeAccountKey({ e1: l, e2: r }).lesserThenGreater;
      expect(key.toLowerCase()).toBe(computeAccountKey(l, r).toLowerCase());
      expect(encodeDisputeProofHash({ messageType: 1, chainId: domain.chainId, contractAddress: domain.depositoryAddress, accountKey: key, nonce: String(nonce), proposerIsLeft: prop, proofbodyHash: pbh, watchSeed: seed.toLowerCase() }))
        .toBe(createDisputeProofHashWithNonce({ leftEntity: l, rightEntity: r, watchSeed: seed } as any, pbh, domain, nonce, prop));
    }
  });
  test("MATCH: encodeAccountKey == og computeAccountKey (lowercase packed, mixed-case input); non-bytes32 input refused by both", () => {
    for (const [x, y] of [[W("AA"), W("bb")], [W("bb"), W("AA")], [W("00"), W("fF")], [W("Cd"), W("cD")], [`0X${"aa".repeat(32)}`, W("bb")]] as const) expect(encodeAccountKey({ e1: x, e2: y }).lesserThenGreater).toBe(computeAccountKey(x, y));
    for (const bad of ["0x1234", `0x${"aa".repeat(31)}`, "12"]) {
      expect(() => computeAccountKey(bad, W("bb"))).toThrow();
      expect(() => encodeAccountKey({ e1: bad, e2: W("bb") })).toThrow();
    }
  });
  test("MATCH: encodeCooperativeUpdateHash (SignedAmount diffs) == og createSettlementHashWithNonce on 100 random diff lists incl. ±(2^256-1); beyond that both refuse", () => {
    for (let i = 0; i < 100; i++) {
      const diffs = arrOf(() => ({ tokenId: ri(100), leftDiff: pick([0n, 5n, -5n, U256, -U256]), rightDiff: pick([0n, 3n, -3n]), collateralDiff: pick([0n, 2n, -2n]), ondeltaDiff: pick([0n, -1n, 1n]) }));
      const forgive = arrOf(() => ri(50)), nonce = ri(1e6), l = W("11"), r = W("22");
      const rwText = (ds: typeof diffs) => ({ messageType: 0, chainId: domain.chainId, contractAddress: domain.depositoryAddress, accountKey: computeAccountKey(l, r), nonce: String(nonce), diffs: ds.map((d) => ({ tokenId: String(d.tokenId), leftDiff: String(d.leftDiff), rightDiff: String(d.rightDiff), collateralDiff: String(d.collateralDiff), ondeltaDiff: String(d.ondeltaDiff) })), forgiveDebtsInTokenIds: forgive.map(String) });
      expect(encodeCooperativeUpdateHash(rwText(diffs))).toBe(createSettlementHashWithNonce({ leftEntity: l, rightEntity: r } as any, diffs, forgive, domain, nonce));
      for (const edge of [U256 + 1n, -U256 - 1n]) {
        const wide = [{ tokenId: 1, leftDiff: 0n, rightDiff: 0n, collateralDiff: 0n, ondeltaDiff: edge }];
        expect(() => createSettlementHashWithNonce({ leftEntity: l, rightEntity: r } as any, wide, forgive, domain, nonce)).toThrow();
        expect(() => encodeCooperativeUpdateHash(rwText(wide))).toThrow();
      }
    }
  });
  test("MATCH: encodeDisputeHash == keccak(solidityPacked(...)) with Account.sol _encodeDisputeHash layout and _argumentCommitment (100 random)", () => {
    const coder = ethers.AbiCoder.defaultAbiCoder();
    for (let i = 0; i < 100; i++) {
      const c = { nonce: String(ru()), startedByLeft: rng() < 0.5, initialProposerIsLeft: rng() < 0.5, timeout: String(ru()), leftResponseSeconds: ri(2 ** 32), rightResponseSeconds: ri(2 ** 32), proofbodyHash: rb32(), disputeStartTimestamp: String(ru()), starterInitialArguments: rbytes(), starterCounterArguments: rbytes(), starterCounterProofCommitment: rb32() };
      const commit = (a: string) => ethers.keccak256(coder.encode(["bytes", "bool", "uint256"], [a, c.startedByLeft, c.disputeStartTimestamp]));
      const sol = ethers.keccak256(ethers.solidityPacked(["uint256", "bool", "bool", "uint256", "uint32", "uint32", "bytes32", "uint256", "bytes32", "bytes32", "bytes32", "uint256", "bytes32", "bool"],
        [c.nonce, c.startedByLeft, c.initialProposerIsLeft, c.timeout, c.leftResponseSeconds, c.rightResponseSeconds, c.proofbodyHash, c.disputeStartTimestamp, commit(c.starterInitialArguments), commit(c.starterCounterArguments), c.starterCounterProofCommitment, 0, ethers.ZeroHash, false]));
      expect(encodeDisputeHash({ cases: [c] })[0]).toBe(sol);
    }
  });
});

// ---------------------------------------------------------------- hanko
const KEYS = ["0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6"];
const addrOf = (k: string) => new ethers.Wallet(k).address;
const idOf = (a: string) => ethers.zeroPadValue(a, 32).toLowerCase();
const ogVerify = (hanko: string, digest: string, target: string, registered?: string): string => {
  try { return verifyCanonicalHanko({ digest, hanko: hanko as any, expectedTargetEntityId: target, validateBoardAuthority: (id, bh) => registered !== undefined && id === target.toLowerCase() && bh === registered.toLowerCase() }).targetEntityId; }
  catch (e) { return "REJECT"; }
};
const rwVerify = (hanko: string, digest: string, target: string, registered?: string): string => { const r = verifyAccountHanko(hanko, digest, target, registered); return r.ok ? r.value.entityId : "REJECT"; };
const boardHashOf = (threshold: bigint, members: string[], weights: bigint[]) => ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["tuple(uint16,bytes32[],uint16[],uint32,uint32,uint32)"], [[threshold, members, weights, 0, 0, 0]])).toLowerCase();
describe("hanko", () => {
  test("MATCH: encodeLazyEntityId == og lazySingleSignerEntityId (mixed-case, lowercase addresses)", () => {
    for (const k of KEYS) { const a = addrOf(k); for (const v of [a, a.toLowerCase()]) expect(encodeLazyEntityId({ signer: v })).toBe(lazySingleSignerEntityId(v)); }
  });
  test("MATCH: 65-byte hanko entity (encodeHanko65) == og recoverShortHankoEntityId for v in {0,1,27,28}; both reject high-s", () => {
    for (let i = 0; i < 40; i++) {
      const digest = ethers.keccak256(ethers.toUtf8Bytes(String(i)));
      const sig = new ethers.Wallet(pick(KEYS)).signingKey.sign(digest);
      for (const v of [sig.v - 27, sig.v]) {
        const raw = ethers.concat([sig.r, sig.s, Uint8Array.of(v)]);
        expect(encodeHanko65({ hash: digest, hanko: raw, registration: null }).entityId).toBe(recoverShortHankoEntityId(raw, digest));
      }
      const n = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");
      const highS = ethers.concat([sig.r, ethers.toBeHex(n - BigInt(sig.s), 32), Uint8Array.of(sig.v === 27 ? 28 : 27)]);
      expect(() => recoverShortHankoEntityId(highS, digest)).toThrow();
      expect(encodeHanko65({ hash: digest, hanko: highS, registration: null }).valid).toBe(false);
    }
  });
  test("MATCH: encodeHankoEnvelope/packSignatures bytes == og encodeHankoEnvelope/packHankoSignatures for canonical inputs", () => {
    for (let i = 0; i < 30; i++) {
      const digest = ethers.keccak256(ethers.toUtf8Bytes("e" + i));
      const keys = KEYS.slice(0, 1 + ri(4));
      const sigs = keys.map((k) => { const s = new ethers.Wallet(k).signingKey.sign(digest); return ethers.getBytes(ethers.concat([s.r, s.s, Uint8Array.of(s.v)])); });
      const packedOg = packHankoSignatures(sigs);
      expect(ethers.hexlify(packSignatures(sigs.map((b) => ({ r: b.subarray(0, 32), s: b.subarray(32, 64), v: b[64]! }))))).toBe(packedOg);
      const claims = [{ entityId: W("cc"), entityIndexes: [0], weights: [1], threshold: 1, boardChangeDelay: 0, controlChangeDelay: ri(5), dividendChangeDelay: 0 }];
      const og = ogEncodeHankoEnvelope({ placeholders: [W("0a")], packedSignatures: packedOg, claims: claims.map((c) => ({ entityId: c.entityId, entityIndexes: c.entityIndexes.map(BigInt), weights: c.weights.map(BigInt), threshold: 1n, boardChangeDelay: 0n, controlChangeDelay: BigInt(c.controlChangeDelay), dividendChangeDelay: 0n })) as any, memberSignatures: [] });
      expect(encodeHankoEnvelope({ placeholders: [W("0a")], packedSignatures: ethers.getBytes(packedOg), claims, memberSignatures: [] })).toBe(og);
    }
  });
  test("MATCH: packSignatures refuses exactly what og packHankoSignatures refuses: v outside {27,28}, zero r or s, high-s (and packs the rest identically)", () => {
    const n = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141"), half = n >> 1n;
    const one = new Uint8Array(32).fill(1), zero = new Uint8Array(32);
    for (const [r, s, v] of [[one, wordOf(half + 1n), 27], [one, new Uint8Array(32).fill(0xff), 27], [one, one, 5], [one, one, 0], [one, one, 1], [zero, one, 27], [one, zero, 28], [one, wordOf(half), 28], [one, one, 27]] as const) {
      const raw = concat([r, s, Uint8Array.of(v)]);
      let og: string; try { og = packHankoSignatures([raw, raw]); } catch { og = "THROW"; }
      let rw: string; try { rw = ethers.hexlify(packSignatures([{ r, s, v }, { r, s, v }])); } catch { rw = "THROW"; }
      expect(rw).toBe(og);
    }
  });
  test("MATCH: verifyAccountHanko accept/reject + target == og verifyCanonicalHanko on 300 random board hankos (self-hash and registered boards, placeholders, mutations)", () => {
    const digest = ethers.keccak256(ethers.toUtf8Bytes("board-digest"));
    let accepted = 0, rejected = 0;
    for (let i = 0; i < 300; i++) {
      const size = 1 + ri(4);
      const members = KEYS.slice(0, size);
      const weights = members.map(() => BigInt(1 + ri(3)));
      const total = weights.reduce((a, b) => a + b, 0n);
      const threshold = pick([1n, total, 1n + BigInt(ri(Number(total))), total + 1n, 0n]);
      const signs = members.map(() => rng() < 0.6);
      const signerKeys = members.filter((_, j) => signs[j]);
      const placeholderIds = members.filter((_, j) => !signs[j]).map((k) => idOf(addrOf(k)));
      const ids = members.map((k) => idOf(addrOf(k)));
      let pIdx = 0, sIdx = 0;
      let entityIndexes = members.map((_, j) => BigInt(signs[j] ? placeholderIds.length + sIdx++ : pIdx++));
      let ws = [...weights];
      const mut = ri(8);
      if (mut === 1 && entityIndexes.length > 1) entityIndexes = [entityIndexes[0]!, entityIndexes[0]!, ...entityIndexes.slice(2)];
      if (mut === 2) ws = ws.map((w, j) => (j === 0 ? 0n : w));
      if (mut === 3) ws = ws.map((w, j) => (j === 0 ? 70000n : w));
      const board = boardHashOf(threshold <= 0xffffn ? threshold : 1n, ids, weights);
      const registered = mut === 4 ? W("ee") : undefined;
      const entityId = registered !== undefined ? W("ee") : mut === 5 ? W("cd") : board;
      let placeholders = placeholderIds;
      if (mut === 6) placeholders = [...placeholderIds, W("0f")];
      let hanko: string;
      try { hanko = encodeSignedHanko({ digest, privateKeys: signerKeys.map((k) => ethers.getBytes(k)), placeholders: placeholders as any, claims: [{ entityId, entityIndexes, weights: ws, threshold, boardChangeDelay: 0n, controlChangeDelay: 0n, dividendChangeDelay: 0n }] as any }); }
      catch { continue; }
      const target = mut === 7 ? W("99") : entityId;
      const regHash = registered !== undefined ? board : undefined;
      const og = ogVerify(hanko, digest, target, regHash), rw = rwVerify(hanko, digest, target, regHash);
      expect(rw).toBe(og);
      if (og === "REJECT") rejected++; else accepted++;
    }
    expect(accepted).toBeGreaterThan(10);
    expect(rejected).toBeGreaterThan(30);
  });
  test("MATCH: nested claim (entity A member of entity B) and unused-claim rejection agree", () => {
    const digest = ethers.keccak256(ethers.toUtf8Bytes("nested"));
    const [k0, k1] = KEYS as [string, string];
    const a0 = idOf(addrOf(k0)), a1 = idOf(addrOf(k1));
    const inner = boardHashOf(1n, [a0], [1n]);
    const outer = boardHashOf(2n, [a1, inner], [1n, 1n]);
    const good = encodeSignedHanko({ digest, privateKeys: [ethers.getBytes(k0), ethers.getBytes(k1)], placeholders: [], claims: [
      { entityId: inner, entityIndexes: [0n], weights: [1n], threshold: 1n, boardChangeDelay: 0n, controlChangeDelay: 0n, dividendChangeDelay: 0n },
      { entityId: outer, entityIndexes: [1n, 2n], weights: [1n, 1n], threshold: 2n, boardChangeDelay: 0n, controlChangeDelay: 0n, dividendChangeDelay: 0n }] as any });
    expect(rwVerify(good, digest, outer)).toBe(ogVerify(good, digest, outer));
    expect(rwVerify(good, digest, outer)).toBe(outer);
    const unused = encodeSignedHanko({ digest, privateKeys: [ethers.getBytes(k0), ethers.getBytes(k1)], placeholders: [], claims: [
      { entityId: inner, entityIndexes: [0n], weights: [1n], threshold: 1n, boardChangeDelay: 0n, controlChangeDelay: 0n, dividendChangeDelay: 0n },
      { entityId: boardHashOf(1n, [a1], [1n]), entityIndexes: [1n], weights: [1n], threshold: 1n, boardChangeDelay: 0n, controlChangeDelay: 0n, dividendChangeDelay: 0n }] as any });
    expect(ogVerify(unused, digest, boardHashOf(1n, [a1], [1n]))).toBe("REJECT");
    expect(rwVerify(unused, digest, boardHashOf(1n, [a1], [1n]))).toBe("REJECT");
  });
  test("MATCH: expected entity must be 0x+64 hex (og asHankoBytes32): decimal, short hex and padded forms are refused by both; mixed case and 0X accepted by both", () => {
    const digest = ethers.keccak256(ethers.toUtf8Bytes("lazy"));
    const a = addrOf(KEYS[0]!), lazy = lazySingleSignerEntityId(a);
    const hanko = encodeSignedHanko({ digest, privateKeys: [ethers.getBytes(KEYS[0]!)], placeholders: [], claims: [{ entityId: lazy, entityIndexes: [0n], weights: [1n], threshold: 1n, boardChangeDelay: 0n, controlChangeDelay: 0n, dividendChangeDelay: 0n }] as any });
    for (const target of [BigInt(lazy).toString(), `0x${BigInt(lazy).toString(16)}`.replace(/^0x0+/, "0x"), ` ${lazy}`, lazy.toUpperCase().replace(/^0X/, "0x"), lazy.replace(/^0x/, "0X"), "0x" + lazy.slice(3)]) {
      expect(rwVerify(hanko, digest, target)).toBe(ogVerify(hanko, digest, target));
    }
    expect(rwVerify(hanko, digest, lazy.toUpperCase().replace(/^0X/, "0x"))).toBe(lazy);
  });
  const ogLocal = (hanko: string, digest: string, registration: { encodedBoard: string; entityId: string } | null): string => {
    try {
      const board = registration === null ? undefined : ethers.keccak256(registration.encodedBoard).toLowerCase();
      return verifyCanonicalHanko({ digest, hanko: hanko as any, ...(registration === null ? {} : { expectedTargetEntityId: registration.entityId }), validateBoardAuthority: (id, bh) => registration !== null && id === registration.entityId.toLowerCase() && bh === board }).targetEntityId;
    } catch { return "REJECT"; }
  };
  const rwLocal = (hanko: string, digest: string, registration: { encodedBoard: string; entityId: string } | null): string => { const r = verifyHankoLocal(hanko, digest, registration); return r.ok && r.value.valid ? r.value.entityId : "REJECT"; };
  test("MATCH: verifyHankoLocal accept/reject + entity == og verifyCanonicalHanko on 300 random board hankos (no registration = no expected target; registration = registered board authority), incl. first-member placeholder, duplicate member, threshold > power", () => {
    const digest = ethers.keccak256(ethers.toUtf8Bytes("local-board"));
    const coder = ethers.AbiCoder.defaultAbiCoder();
    let accepted = 0, rejected = 0;
    for (let i = 0; i < 300; i++) {
      const members = KEYS.slice(0, 1 + ri(4));
      const ids = members.map((k) => idOf(addrOf(k)));
      const weights = members.map(() => BigInt(1 + ri(3)));
      const total = weights.reduce((x, y) => x + y, 0n);
      const threshold = pick([1n, total, 1n + BigInt(ri(Number(total))), total + 1n]);
      const signs = members.map(() => rng() < 0.6);
      const mut = ri(7);
      if (mut === 1) { ids[0] = W("ff"); signs[0] = false; }
      if (mut === 2 && ids.length > 1) { ids[1] = ids[0]!; signs[1] = false; signs[0] = false; }
      const placeholderIds = ids.filter((_, j) => !signs[j]);
      if (mut === 2 && ids.length > 1) placeholderIds.splice(1, 1);
      let pIdx = 0, sIdx = 0;
      const entityIndexes = ids.map((_, j) => BigInt(signs[j] ? placeholderIds.length + sIdx++ : mut === 2 && j === 1 ? 0 : pIdx++));
      const board = boardHashOf(threshold, ids, weights);
      const encodedBoard = coder.encode(["tuple(uint16,bytes32[],uint16[],uint32,uint32,uint32)"], [[threshold, ids, weights, 0, 0, 0]]);
      const registered = mut === 3 || mut === 4;
      const entityId = registered ? W("ee") : board;
      let hanko: string;
      try { hanko = encodeSignedHanko({ digest, privateKeys: members.filter((_, j) => signs[j]).map((k) => ethers.getBytes(k)), placeholders: placeholderIds as any, claims: [{ entityId, entityIndexes, weights, threshold, boardChangeDelay: 0n, controlChangeDelay: 0n, dividendChangeDelay: 0n }] as any }); }
      catch { continue; }
      const registration = registered ? { encodedBoard: mut === 4 ? coder.encode(["tuple(uint16,bytes32[],uint16[],uint32,uint32,uint32)"], [[1n, [W("01")], [1n], 0, 0, 0]]) : encodedBoard, entityId } : rng() < 0.5 ? null : { encodedBoard, entityId: board };
      const og = ogLocal(hanko, digest, registration), rw = rwLocal(hanko, digest, registration);
      expect(rw).toBe(og);
      if (og === "REJECT") rejected++; else accepted++;
    }
    expect(accepted).toBeGreaterThan(30);
    expect(rejected).toBeGreaterThan(30);
  });
  test("MATCH: verifyHankoLocal rejects a board whose first member is a non-address placeholder, like og verifyCanonicalHanko (HANKO_FIRST_MEMBER_EOA_REQUIRED) and HankoVerifier.sol InvalidHankoFirstMember", () => {
    const digest = ethers.keccak256(ethers.toUtf8Bytes("local"));
    const a0 = idOf(addrOf(KEYS[0]!));
    const ph = W("ff");
    const board = boardHashOf(1n, [ph, a0], [1n, 1n]);
    const hanko = encodeSignedHanko({ digest, privateKeys: [ethers.getBytes(KEYS[0]!)], placeholders: [ph] as any, claims: [{ entityId: board, entityIndexes: [0n, 1n], weights: [1n, 1n], threshold: 1n, boardChangeDelay: 0n, controlChangeDelay: 0n, dividendChangeDelay: 0n }] as any });
    expect(ogVerify(hanko, digest, board)).toBe("REJECT");
    expect(rwVerify(hanko, digest, board)).toBe("REJECT");
    expect(ogLocal(hanko, digest, null)).toBe("REJECT");
    expect(rwLocal(hanko, digest, null)).toBe("REJECT");
  });
});

// ---------------------------------------------------------------- entity state root / frame hash
const PA = (ns: string) => PersistentAccountStateMap.fromEntries(ns as any, new Map());
const SIGNER = `0x${"01".repeat(20)}`;
const CONFIG = { mode: "proposer-based" as const, threshold: 1n, validators: [SIGNER], shares: { [SIGNER]: 1n } };
const emptyAccountState = (self: string, peer: string): any => {
  const claims = { version: 1 as const, root: EMPTY_J_ROOT, count: 0n };
  return { domain: { chainId: 1, depositoryAddress: `0x${"ab".repeat(20)}` }, leftEntity: self, rightEntity: peer, watchSeed: W("44"), disputeConfig: { leftResponseSeconds: 1, rightResponseSeconds: 1 }, jNonce: 0, lastFinalizedJHeight: 0, leftPendingJClaims: claims, rightPendingJClaims: claims };
};
const ogAccounts = (self: string, replicas: [string, any][]) => PersistentEntityAccountMap.fromEntries(replicas, self, computeEntityAccountValueHash);
const ogReplica = (self: string, peer: string, extra: Record<string, unknown> = {}): any => ({ state: { ...emptyAccountState(self, peer), ...Object.fromEntries(["deltas", "locks", "pulls", "swapOffers", "subcontracts", "lendingIntents", "requestedRebalance", "requestedRebalanceFeeState", "rebalanceFeePolicies"].map((n) => [n, PA(n)])) },
  status: "active", currentHeight: 0, proofHeader: { fromEntity: self, toEntity: peer, nextProofNonce: 1 }, currentFrame: { stateHash: "" }, pendingWithdrawals: PA("pendingWithdrawals"), shadow: { rebalance: { policy: PA("rebalanceShadowPolicy"), submittedAtByToken: PA("rebalanceShadowSubmitted") } }, mempool: [], ...extra });
const rwAccount = (self: string, peer: string, extra: Record<string, unknown> = {}): any => ({ fromEntity: self, toEntity: peer, status: "active", currentHeight: 0, nextProofNonce: 1, currentFrameHash: "", pendingWithdrawals: W("00"), policyRoot: W("00"), submittedAtByTokenRoot: W("00"),
  state: { ...emptyAccountState(self, peer), deltas: new Map(), locks: new Map(), pulls: new Map(), swapOffers: new Map(), subcontracts: new Map(), lendingIntents: new Map(), requestedRebalance: new Map(), requestedRebalanceFeeState: new Map(), rebalanceFeePolicies: new Map() }, ...extra });
describe("entity state root", () => {
  test("MATCH (golden provenance): og computeCanonicalEntityConsensusStateHash reproduces the oracle's hardcoded 0x1a37f4d7... and 0x72ac0104... -- but only for a synthetic EntityState that has ONLY {config, accounts, paybook}", () => {
    const self = W("aa"), peer = W("bb");
    const empty: any = { config: CONFIG, accounts: ogAccounts(self, []), paybook: { entries: new Map(), feesEarned: 0n } };
    expect(computeCanonicalEntityConsensusStateHash(empty)).toBe("0x1a37f4d778a6abc66ac52c98367338a4d7dd3d9f92f2f365305a7154bfc6b9a4");
    expect(unwrap(entityStateRoot({ config: CONFIG, accounts: [] }))).toBe("0x1a37f4d778a6abc66ac52c98367338a4d7dd3d9f92f2f365305a7154bfc6b9a4");
    const one: any = { ...empty, accounts: ogAccounts(self, [[peer, ogReplica(self, peer)]]) };
    expect(computeCanonicalEntityConsensusStateHash(one)).toBe("0x72ac0104afdbba762c83b6e958f4a9ca787f1706e62f368aab62bfb635f35d2b");
    expect(unwrap(entityStateRoot({ config: CONFIG, accounts: [rwAccount(self, peer)] }))).toBe("0x72ac0104afdbba762c83b6e958f4a9ca787f1706e62f368aab62bfb635f35d2b");
  });
  test("DIVERGES: every real og EntityState carries more root sections (entityId, height, timestamp, reserves, nonces, profile, ...); each moves og's root, the rewrite has no input for them", () => {
    const self = W("aa");
    const base: any = { config: CONFIG, accounts: ogAccounts(self, []), paybook: { entries: new Map(), feesEarned: 0n } };
    const min = computeCanonicalEntityConsensusStateHash(base);
    for (const extra of [{ entityId: self }, { height: 3 }, { timestamp: 1_700_000_000_123 }, { reserves: new Map([[1, 5n]]) }, { lastFinalizedJHeight: 42 }]) {
      expect(computeCanonicalEntityConsensusStateHash({ ...base, ...extra })).not.toBe(min);
    }
    expect(computeCanonicalEntityConsensusStateHash({ ...base, paybook: { entries: new Map(), feesEarned: 12n } })).not.toBe(min); // rewrite hardwires feesEarned 0n
  });
  test("MATCH: entity account leaf == og for 50 random account scalars (status, heights, nonce, frame hash, withdrawals/shadow roots, random account state)", () => {
    const self = W("aa");
    for (let i = 0; i < 50; i++) {
      const peers = [...new Set(Array.from({ length: 1 + ri(3) }, () => W(pick(["bb", "cc", "dd", "0e"]))))];
      const og: [string, any][] = [], rw: any[] = [];
      for (const peer of peers) {
        const s = randState();
        const deltas = new Map([...s.deltas.values()].slice(0, 2).map((d, j) => [j + 1, { ...d, tokenId: j + 1 }] as const));
        const st = { ...s, deltas, requestedRebalance: new Map(), rebalanceFeePolicies: new Map(), leftEntity: self, rightEntity: peer };
        const status = pick(["active", "disputed"]), currentHeight = ri(100), nextProofNonce = 1 + ri(9), fh = W(pick(["12", "34"]));
        og.push([peer, { ...ogReplica(self, peer), state: toOgState(st), status, currentHeight, proofHeader: { fromEntity: self, toEntity: peer, nextProofNonce }, currentFrame: { stateHash: fh } }]);
        rw.push({ ...rwAccount(self, peer), state: st, status, currentHeight, nextProofNonce, currentFrameHash: fh });
      }
      const ogState: any = { config: CONFIG, accounts: ogAccounts(self, og), paybook: { entries: new Map(), feesEarned: 0n } };
      expect(unwrap(entityStateRoot({ config: CONFIG, accounts: rw }))).toBe(computeCanonicalEntityConsensusStateHash(ogState));
    }
  });
  test("MATCH: og leaf optional fields -- no currentFrame omits currentFrameHash, counterparty hanko digests, dispute fields, settlement hankos, shadow quote/request/rejected evidence -- on 100 random accounts", () => {
    const self = W("aa"), peer = W("bb");
    const optional: Record<string, () => unknown> = {
      publicPinned: () => rng() < 0.5, boardHankoRefreshMigration: () => ({ fromBoardHash: W("0c"), stage: ri(3) }), counterpartyBoardHankoRefresh: () => ({ hanko: "0x" + "ab".repeat(ri(6)), nonce: ri(9) }),
      counterpartyFrameHanko: () => "0x" + "cd".repeat(ri(40)), counterpartyDisputeProofHanko: () => "0x" + "ef".repeat(ri(40)), counterpartySettlementHanko: () => "0x" + "12".repeat(ri(40)),
      currentDisputeProofNonce: () => ri(100), currentDisputeProofProposerIsLeft: () => rng() < 0.5, currentDisputeProofBodyHash: () => W("3a"), currentDisputeHash: () => W("3b"),
      counterpartyDisputeProofNonce: () => ri(100), counterpartyDisputeProofProposerIsLeft: () => rng() < 0.5, counterpartyDisputeProofBodyHash: () => W("4a"), counterpartyDisputeHash: () => W("4b"),
      disputePrepare: () => ({ reason: pick(["timeout", "body_mismatch"]), atHeight: ri(50), nonce: BigInt(ri(9)) }), activeDispute: () => ({ startedByLeft: rng() < 0.5, initialNonce: ri(9), disputeTimeout: BigInt(ri(1e6)) }),
    };
    let compared = 0;
    for (let i = 0; i < 100; i++) {
      const committedFields = Object.fromEntries(Object.entries(optional).filter(() => rng() < 0.3).map(([k, f]) => [k, f()]));
      const hasFrame = rng() < 0.5, fh = W(pick(["12", "34"]));
      const activeQuote = rng() < 0.3 ? { quoteId: ri(99), feePpm: BigInt(ri(1000)) } : undefined, pendingRequest = rng() < 0.3 ? { tokenId: 1, amount: BigInt(ri(1e6)) } : undefined;
      const rejected = rng() < 0.3 ? { reason: "bad_frame", frame: { stateHash: W("5e") }, frameHanko: rng() < 0.5 ? "0xabcd" : undefined } : undefined;
      const settlementHankos = rng() < 0.3 ? { settlementHanko: "0x" + "77".repeat(3) } : undefined;
      const ogRep = ogReplica(self, peer, { ...committedFields, currentFrame: hasFrame ? { stateHash: fh } : undefined,
        shadow: { rebalance: { policy: PA("rebalanceShadowPolicy"), submittedAtByToken: PA("rebalanceShadowSubmitted"), ...(activeQuote ? { activeQuote } : {}), ...(pendingRequest ? { pendingRequest } : {}) }, ...(rejected ? { rejectedFrameEvidence: rejected } : {}) } });
      if (!hasFrame) delete ogRep.currentFrame;
      if (settlementHankos) ogRep.state.settlementWorkspace = { version: 1, status: "awaiting_counterparty", diffs: [], nonce: 1, rightHanko: settlementHankos.settlementHanko };
      const ogState: any = { config: CONFIG, accounts: ogAccounts(self, [[peer, ogRep]]), paybook: { entries: new Map(), feesEarned: 0n } };
      let og: string; try { og = computeCanonicalEntityConsensusStateHash(ogState); } catch { continue; }
      const rw = rwAccount(self, peer, { currentFrameHash: hasFrame ? fh : undefined, committed: committedFields, counterpartySettlementHankos: settlementHankos, activeQuote, pendingRequest,
        rejectedFrameEvidence: rejected ? { reason: rejected.reason, frameHash: rejected.frame.stateHash, frameHanko: rejected.frameHanko } : undefined });
      if (settlementHankos) continue; // a live workspace also moves og's accountStateRoot (H5, account-tx area); the leaf field itself is covered below
      expect(unwrap(entityStateRoot({ config: CONFIG, accounts: [rw] }))).toBe(og);
      compared++;
    }
    expect(compared).toBeGreaterThan(50);
  });
});

describe("entity account leaf, runtime side (H7)", () => {
  test("MATCH: installedAccount fills og's committed replica fields -- genesis commits og's empty currentFrame.stateHash; after a round the peer frame Hanko, our dispute draft and the peer dispute witness are committed as og replaceLocalDisputeDraft/storeCounterpartyDisputeHanko store them", () => {
    const door = (self: any) => ({ verify: hankoVerify, self, now: NOW });
    const run = (r: any, input: any, self: any) => { const out = applyAccountInput(r, input, door(self)); if (!out.ok) throw new Error(JSON.stringify(out.error, (_k, v) => (typeof v === "bigint" ? `${v}` : v))); return out.value; };
    const tx = { type: "set_credit_limit", tokenId: "0", limit: 7n } as any;
    const opened = unwrap(admit(genesisAB(), [tx]));
    const proposed: any = run(opened, proposeInput(opened, ALICE), ALICE).replica;
    const received: any = run(genesisAB(), offerOf(proposed, ALICE), BOB).replica;
    const acked = run(received, ackInput(received, BOB), BOB);
    const alice: any = run(proposed, acked.outputs.find((o: any) => o.kind === "ack"), ALICE).replica, bob: any = acked.replica;
    const leafRoot = (self: any, peer: any, child: any) => unwrap(entityStateRoot({ config: CONFIG, accounts: [unwrap(installedAccount(self, peer, child) as any)] }));
    const ogRoot = (self: string, peer: string, child: any, patch: Record<string, unknown> = {}) => {
      const view: any = unwrap(committedView(child.state) as any), localIsLeft = self === view.leftEntity;
      const ogRep: any = ogReplica(self, peer, { state: toOgState(view), currentHeight: Number(child.head.height), proofHeader: { fromEntity: self, toEntity: peer, nextProofNonce: child.dispute.nextProofNonce },
        currentFrame: { stateHash: child.head._tag === "genesis" ? "" : child.head.prevFrameHash } });
      if (child.head._tag === "installed") ogRep.counterpartyFrameHanko = localIsLeft ? child.head.certificate.right : child.head.certificate.left;
      const cur = child.dispute.current, cp = child.dispute.counterparty;
      if (cur) replaceLocalDisputeDraft(ogRep, { hash: cur.hash, nonce: cur.proofNonce, proofBodyHash: cur.proofBodyHash, proposerIsLeft: cur.proposerIsLeft });
      if (cp) storeCounterpartyDisputeHanko(ogRep, { hanko: cp.hanko, nonce: cp.proofNonce, hash: cp.hash, proofBodyHash: cp.proofBodyHash, proposerIsLeft: cp.proposerIsLeft });
      Object.assign(ogRep, patch);
      return computeCanonicalEntityConsensusStateHash({ config: CONFIG, accounts: ogAccounts(self, [[peer, ogRep]]), paybook: { entries: new Map(), feesEarned: 0n } } as any);
    };
    expect(leafRoot(ALICE, BOB, genesisAB())).toBe(ogRoot(ALICE, BOB, genesisAB()));
    expect([alice.head.height, alice.dispute.current !== undefined, alice.dispute.counterparty !== undefined, bob.dispute.counterparty !== undefined]).toEqual([1n, true, true, true]);
    expect(leafRoot(ALICE, BOB, alice)).toBe(ogRoot(ALICE, BOB, alice));
    expect(leafRoot(BOB, ALICE, bob)).toBe(ogRoot(BOB, ALICE, bob));
    expect(leafRoot(ALICE, BOB, alice)).not.toBe(leafRoot(ALICE, BOB, { ...alice, dispute: { nextProofNonce: alice.dispute.nextProofNonce } }));
    // og open-account.ts publicPinned (the opener's pin) and board-hanko-refresh.ts counterpartyBoardHankoRefresh are committed leaf fields
    const refresh = { activationJHeight: 7, activationLogIndex: 2, frameHeight: 1, frameHash: alice.head.prevFrameHash };
    expect(leafRoot(ALICE, BOB, { ...alice, publicPinned: true })).toBe(ogRoot(ALICE, BOB, alice, { publicPinned: true }));
    expect(leafRoot(ALICE, BOB, { ...alice, boardRefresh: refresh })).toBe(ogRoot(ALICE, BOB, alice, { counterpartyBoardHankoRefresh: refresh }));
    expect(leafRoot(ALICE, BOB, { ...alice, publicPinned: true })).not.toBe(leafRoot(ALICE, BOB, alice));
    // og applyAccountDisputeStarted: the disputed replica commits status and the activeDispute record in the leaf.
    const finality = { kind: "dispute_started", starterEntityId: BOB, initialProofbodyHash: W("5a"), initialNonce: 1, initialProposerIsLeft: true, disputeTimeout: 1_000 + 86_400 + 3_600, disputeStartTimestamp: 1_000,
      leftResponseSeconds: 86_400, rightResponseSeconds: 3_600, jNonce: 0, starterInitialArguments: "0x", starterCounterArguments: "0x", starterCounterProofCommitment: W("00"), observedBlockNumber: 7 };
    const disputed: any = run(alice, { kind: "external_finality", ...envelopeAB(BOB), finality }, ALICE).replica;
    expect(disputed._tag).toBe("disputed");
    expect(leafRoot(ALICE, BOB, disputed)).toBe(ogRoot(ALICE, BOB, disputed, { status: "disputed", activeDispute: disputed.active }));
    expect(leafRoot(ALICE, BOB, disputed)).not.toBe(ogRoot(ALICE, BOB, disputed, { status: "disputed" }));
  });
});

const ENTITY_CONTEXT = () => ({ version: 1, proposerReplicaId: `${W("aa")}:${SIGNER}`, entityId: W("aa"), proposerSignerId: SIGNER, parentFrameHash: W("22"), height: ri(100), gossipProfiles: [], peerAssertions: [], htlc: { version: 1, entries: [], originated: [] } });
const binVal = (d = 0): any => {
  const r = rng();
  if (d > 2 || r < 0.5) return pick([() => null, () => rng() < 0.5, () => ri(1e6), () => -1 - ri(100), () => 1.5, () => BigInt(ri(1e9)) * 1000000000000n, () => pick(["", "x", W("ab"), W("AB"), "0x" + "ab".repeat(16), "0x" + "ab".repeat(15), "0x" + "abc".repeat(11)])])();
  if (r < 0.75) return Array.from({ length: ri(4) }, () => binVal(d + 1));
  const o: Record<string, any> = {}; for (let k = ri(4); k > 0; k--) o[pick(["a", "b", "Z", "_x", "10"])] = binVal(d + 1); return o;
};
describe("entity frame hash", () => {
  test("MATCH: entityFrameHash == og createEntityFrameHashFromStateRoot on 200 random frames (plain txs, accountInput commitments, events, hex projection)", () => {
    for (let i = 0; i < 200; i++) {
      const txs = Array.from({ length: ri(4) }, () => (rng() < 0.4 ? { type: "accountInput", data: { kind: "ack", fromEntityId: W("aa"), toEntityId: W("bb"), x: binVal() } } : { type: pick(["openAccount", "directPayment", "extendCredit"]), data: { target: W("bb"), v: binVal() } }));
      const events = Array.from({ length: ri(3) }, () => binVal());
      const ctx = ENTITY_CONTEXT();
      const input = { prevFrameHash: W(pick(["22", "00"])), height: ri(1e6), timestamp: 1_700_000_000_000 + ri(1e9), txs, events, entityId: W("aa"), stateRoot: W(pick(["31", "ab"])), authorityRoot: W(pick(["32", "cd"])), entityContext: ctx };
      expect(unwrap(entityFrameHash(input as any))).toBe(createEntityFrameHashFromStateRoot(input.prevFrameHash, input.height, input.timestamp, txs as any, events as any, input.entityId, input.stateRoot, input.authorityRoot, ctx as any));
    }
  });
  test("MATCH: non-canonical numbers (-0, unsafe integers, NaN, Infinity) anywhere in events, txs or context are refused by both (og XLN_BINARY_CODEC_UNSUPPORTED)", () => {
    const og = (input: any) => { try { return createEntityFrameHashFromStateRoot(input.prevFrameHash, input.height, input.timestamp, input.txs, input.events, input.entityId, input.stateRoot, input.authorityRoot, input.entityContext); } catch { return "REJECT"; } };
    const rw = (input: any) => { const r = entityFrameHash(input); return r.ok ? r.value : "REJECT"; };
    for (const bad of [-0, 2 ** 53, -(2 ** 53), 1e21, NaN, Infinity, -Infinity]) {
      const base = { prevFrameHash: W("22"), height: 1, timestamp: 1, txs: [] as any[], events: [] as any[], entityId: W("aa"), stateRoot: W("31"), authorityRoot: W("32"), entityContext: ENTITY_CONTEXT() };
      for (const input of [{ ...base, events: [{ n: bad }] }, { ...base, txs: [{ type: "directPayment", data: { v: [bad] } }] }, { ...base, txs: [{ type: "accountInput", data: { x: bad } }] }, { ...base, entityContext: { ...base.entityContext, height: bad } }]) {
        expect(og(input)).toBe("REJECT");
        expect(rw(input)).toBe("REJECT");
      }
    }
    for (const fine of [0, -1, 1.5, 2 ** 53 - 1, -(2 ** 53) + 1, 1e-7]) {
      const input = { prevFrameHash: W("22"), height: 1, timestamp: 1, txs: [], events: [{ n: fine }], entityId: W("aa"), stateRoot: W("31"), authorityRoot: W("32"), entityContext: ENTITY_CONTEXT() };
      expect(rw(input)).toBe(og(input));
    }
  });
  test("MATCH: malformed or UPPERCASE stateRoot/authorityRoot are refused by both (og ENTITY_FRAME_STATE_ROOT_INVALID / AUTHORITY_ROOT_INVALID)", () => {
    const ctx = ENTITY_CONTEXT();
    for (const [stateRoot, authorityRoot] of [[W("AB"), W("32")], [W("31"), W("Cd")], ["0x1234", W("32")], [W("31"), "31".repeat(32)], [`0X${"31".repeat(32)}`, W("32")], [W("31"), W("32")]]) {
      let og: string; try { og = createEntityFrameHashFromStateRoot(W("22"), 1, 1, [], [], W("aa"), stateRoot!, authorityRoot!, ctx as any); } catch { og = "REJECT"; }
      const r = entityFrameHash({ prevFrameHash: W("22"), height: 1, timestamp: 1, txs: [], events: [], entityId: W("aa"), stateRoot: stateRoot!, authorityRoot: authorityRoot!, entityContext: ctx } as any);
      expect(r.ok ? r.value : "REJECT").toBe(og);
    }
  });
});

// ---------------------------------------------------------------- golden provenance (oracle.test.ts hardcodes)
const oracleSettlementTx = (settlementHash: string, settlementHanko: string, hanko: string) => ({ type: "settle_transition", data: { kind: "hanko", revision: 1, workspaceHash: W("61"), settlementNonce: 2, settlementHash, settlementHanko, postProof: { nonce: 3, proposerIsLeft: true, proofBodyHash: W("63"), disputeHash: W("64"), hanko } } });
const oracleAccountFixture = () => ({ height: 7, timestamp: 1_700_000_000_123, jHeight: 42, prevFrameHash: W("11"), accountStateRoot: W("33"), accountTxs: [{ type: "set_credit_limit", data: { tokenId: 1, amount: 1234n } }, { type: "direct_payment", data: { tokenId: 1, amount: 55n, nonce: "payment-1" } }] });
describe("golden hashes hardcoded in pure/oracle.test.ts: does og itself produce them?", () => {
  test("MATCH: settlement 0x31c1e688... and moved 0x2bbd9706... are og computeFrameHash outputs (og golden test only asserts equality/inequality, not these literals)", () => {
    const f = (h: string, q: string, p: string) => computeFrameHash({ ...oracleAccountFixture(), accountTxs: [oracleSettlementTx(h, q, p)], stateHash: "" } as any);
    expect(f(W("62"), "0xfirst-quorum", "0xfirst-proof-quorum")).toBe("0x31c1e688138ea34d358f85463110cac28bbb667cf756fd6d369aebff9c69330b");
    expect(f(W("62"), "0xsecond-quorum", "0xsecond-proof-quorum")).toBe("0x31c1e688138ea34d358f85463110cac28bbb667cf756fd6d369aebff9c69330b");
    expect(f(W("65"), "0xsecond-quorum", "0xsecond-proof-quorum")).toBe("0x2bbd97062af15e91acbf9af9973adbad7b3494d67f8c955d8ab9a5d2e8267cd4");
    expect(computeFrameHash({ ...oracleAccountFixture(), stateHash: "" } as any)).toBe("0x48209002630a2dae349c0ec270c3668afd11e7bad2970121e24d7af157fdc75b");
  });
  test("MATCH: j-claim frame 0x11cbf820... and pending root 0x32a2477f... are reproduced by og (computeFrameHash + computeAccountStateRoot + og j-claim accumulator + canonicalJurisdictionEventsHash)", () => {
    const left = W("11"), right = W("22");
    const id = unwrap(rwAccountId(unwrap(rwEntityId(left)), unwrap(rwEntityId(right))));
    const domain = { chainId: 31337, depositoryAddress: `0x${"44".repeat(20)}` };
    const terms = unwrap(accountTerms({ domain, watchSeed: W("55"), disputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 } }));
    const settled = (collateral: bigint, ondelta: bigint, nonce: bigint) => ({ left, right, tokens: [{ tokenId: 1n, leftReserve: 0n, rightReserve: 0n, collateral, ondelta }], nonce });
    const claim = (jHeight: bigint, block: string, collateral: bigint, ondelta: bigint, nonce: bigint) => ({ type: "j_event_claim" as const, jHeight, jBlockHash: block, events: [settled(collateral, ondelta, nonce)], observedAt: 1n });
    const clock = { timestamp: 1_700_000_000_123n, jHeight: 42n };
    const openReplica = unwrap(admit(unwrap(genesisReplica(id, terms)), [claim(7n, W("33"), 125n, 7n, 3n) as any]));
    const preview: any = unwrap(previewAccountProposal(openReplica, id.left, clock));
    const pending: any = unwrap(applyAccountBody(preview.draft.state, claim(8n, W("34"), 126n, 8n, 4n) as any, { byLeft: true, nowMs: 1n, jHeight: 42n, accountHeight: preview.frame.height }));
    expect(preview.frame.stateHash).toBe("0x11cbf8207b493f1595220c1d8760cfe3146ebbdbe298ed6b827c6c645919b5cc");

    // og side: events hash, j-claim accumulator
    const ogEvent = (c: bigint, o: bigint, n: number) => ({ type: "AccountSettled", data: { leftEntity: left, rightEntity: right, tokenId: 1, leftReserve: "0", rightReserve: "0", collateral: c.toString(), ondelta: o.toString(), nonce: n } });
    const e1 = canonicalJurisdictionEventsHash([ogEvent(125n, 7n, 3)] as any), e2 = canonicalJurisdictionEventsHash([ogEvent(126n, 8n, 4)] as any);
    const dom = { chainId: 31337, depositoryAddress: domain.depositoryAddress, leftEntity: left, rightEntity: right };
    const r1 = createAccountJClaimRecord(dom as any, "left", { jHeight: 7, jBlockHash: W("33"), eventsHash: e1 } as any);
    const r2 = createAccountJClaimRecord(dom as any, "left", { jHeight: 8, jBlockHash: W("34"), eventsHash: e2 } as any);
    const s1 = applyAccountJClaimInsert(createEmptyAccountJClaimAccumulator(), r1, { version: 1, nodes: [] });
    const store = new Map(s1.newNodes.map((n) => [n.hash, n.node]));
    const s2 = applyAccountJClaimInsert(s1.state, r2, createAccountJClaimProof(store as any, s1.state.root, r2));
    expect(unwrap(committed(preview.draft.state)).view.leftPendingJClaims.root).toBe(s1.state.root);
    expect(s2.state.root).toBe("0x32a2477f6813fa0bdc1362166cf00922afe29372c9b0cf7a591095d9df31f2e1");
    expect(unwrap(committed(pending.state)).view.leftPendingJClaims.root).toBe(s2.state.root);
    expect(EMPTY_J_ROOT).toBe(EMPTY_ACCOUNT_J_CLAIM_ROOT);

    // og account state root of the proposed state, then og frame hash of the proposed frame
    const view = unwrap(committed(preview.draft.state)).view;
    expect(computeAccountStateRoot(toOgState(view))).toBe(preview.frame.accountStateRoot);
    const ogFrame = { height: Number(preview.frame.height), timestamp: Number(preview.frame.timestamp), jHeight: Number(preview.frame.jHeight), prevFrameHash: preview.frame.prevFrameHash, accountStateRoot: preview.frame.accountStateRoot, stateHash: "",
      accountTxs: [{ type: "j_event_claim", data: { jHeight: 7, jBlockHash: W("33"), events: [ogEvent(125n, 7n, 3)], leftProof: { version: 1, nodes: [] }, rightProof: { version: 1, nodes: [] }, observedAt: 1 } }] };
    expect(computeFrameHash(ogFrame as any)).toBe("0x11cbf8207b493f1595220c1d8760cfe3146ebbdbe298ed6b827c6c645919b5cc");
  });
});

describe("rewrite-only canon text (hashEntityState / hashAccountState / encodeEntityTx) -- no og counterpart", () => {
  test("EXTRA (kept: hashEntityState / hashAccountState / encodeEntityTx depend on it; no og counterpart): canon() keeps Sets and byte arrays distinct from plain objects, as og's RLP codec does", () => {
    expect(canon(new Set([1, 2]))).not.toBe(canon({}));
    expect(canon(new Set([1, 2]))).toBe(canon(new Set([2, 1])));
    expect(canon(new Set([1, 2]))).not.toBe(canon([1, 2]));
    expect(canon(Uint8Array.of(1))).not.toBe(canon({ 0: 1 }));
    expect(canon(Uint8Array.of(1))).not.toBe(canon(Uint8Array.of(1, 0)));
    expect(hex(encodeAccountStateValue(new Set([1, 2])))).not.toBe(hex(encodeAccountStateValue({})));
  });
});
