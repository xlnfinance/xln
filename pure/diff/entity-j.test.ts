import { describe, expect, test } from "bun:test";
import { seedOf, seedTag, untilCovered } from "./seed.ts";
import {
  createEntity, foldTxs, initJBatch, sentOf, setRebalanceSubmittedAt, contractBatch, encodeBatch,
  type AccountReplica, type EntityId, type EntityState, type EntityTx,
} from "../xln.ts";
import { ALICE, BOB, CAROL, TERMS, aliceAddr, genesisAB, signedTxs, unwrap, verifiers } from "../xln_run.ts";
import { handleR2R } from "../../core/entity/tx/handlers/j-batch/r2r.ts";
import { handleR2E } from "../../core/entity/tx/handlers/j-batch/r2e.ts";
import { handleE2R } from "../../core/entity/tx/handlers/j-batch/e2r.ts";
import { handleR2C } from "../../core/entity/tx/handlers/j-batch/r2c.ts";
import { handleJBroadcast } from "../../core/entity/tx/handlers/j-batch/j-broadcast.ts";
import { handleJRebroadcast } from "../../core/entity/tx/handlers/j-batch/j-rebroadcast.ts";
import { handleJAbortSentBatch } from "../../core/entity/tx/handlers/j-batch/j-abort-sent-batch.ts";
import { handleJClearBatch } from "../../core/entity/tx/handlers/j-batch/j-clear-batch.ts";
import { handleMintReserves } from "../../core/entity/tx/handlers/j-batch/mint-reserves.ts";
import { encodeJBatch as ogEncodeJBatch } from "../../core/jurisdiction/machine/batch/index.ts";
import { readEntityFrameEvents } from "../../core/entity/frame-events.ts";
import { EntityAccountCandidateMap } from "../../core/entity/state/persistent-account-map.ts";
import { PersistentAccountStateMap } from "../../core/account/state/persistent-state-map.ts";
import { ethers } from "ethers";
import { applyRuntimeTx as ogApplyRuntimeTx } from "../../core/runtime/tx/tx-handlers.ts";
import { buildNumberedRegistrationRequest, computeNumberedRegistrationRequestHash, encodeNumberedRegistrationCalldata } from "../../core/runtime/registration/numbered-registration-codec.ts";
import { buildCertifiedRegistrationEvidence, computeRegistrationEvidenceHash } from "../../core/jurisdiction/machine/registration-evidence/index.ts";
import { computeCanonicalReceiptsRoot, createCanonicalReceiptProofs } from "../../core/jurisdiction/machine/receipt-codec/index.ts";
import { deriveSignerKeySync, registerSignerKey } from "../../core/account/crypto.ts";
import { createEmptyEnv } from "../../core/runtime/composition.ts";
import { buildReplayVerifiableRuntimePostStateView } from "../../core/storage/wal/snapshot.ts";
import { computeRuntimePostStateComponentDigests } from "../../core/storage/hashes.ts";
import { EntityProvider__factory } from "../../contracts/typechain-types/index.ts";
import { applyRuntimeTx, createRuntime, numberedRegistrationCalldata, parseEvmTx, runtimeComponentDigests, runtimeView, stableJson, type JReplica, type Runtime, type RuntimeTx } from "../xln.ts";
import { bobAddr } from "../xln_run.ts";
import { normalizeJurisdictionEvent, compareCanonicalJurisdictionEvents } from "../../core/jurisdiction/machine/events/event-normalization.ts";
import { canonicalJurisdictionEventsHash, getJEventJurisdictionRef } from "../../core/jurisdiction/machine/event-observation.ts";
import { EMPTY_J_HISTORY_ROOT as OG_EMPTY_ROOT, foldJHistoryRoot as ogFoldRoot, canonicalJEventRangeHash, buildJEventRangeDigest } from "../../core/jurisdiction/machine/history-consensus/index.ts";
import { applyJEvent as ogApplyJEvent } from "../../core/entity/tx/j-events.ts";
import { applyEntityTx as ogApplyEntityTx } from "../../core/entity/tx/apply.ts";
import { anvilKey, signDigestHex } from "../xln_run.ts";
import { getBoardHandoverFrameConfig } from "../../core/entity/consensus/authority/board-handover.ts";
import { handleBoardHandoverEntityTx } from "../../core/entity/tx/handlers/board-handover.ts";
import { encodeBoard, hashBoard } from "../../core/entity/factory.ts";
import { carolAddr } from "../xln_run.ts";
import { ogJb, ogOf } from "./og-state.ts";

const prng = (base: number) => { let seed = seedOf(base); return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const rng = prng(0xe7_1a);
const ri = (n: number) => Math.floor(rng() * n);
const pick = <X,>(xs: readonly X[]): X => xs[ri(xs.length)] as X;
const DEP = TERMS.domain.depositoryAddress, EP = "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512", OTHER = `0x${"aa".repeat(32)}`, EXT = `0x${"00".repeat(12)}${"bb".repeat(20)}`;
const TOKEN_CONTRACT = "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0";
const OG_J = { name: "j", chainId: TERMS.domain.chainId, depositoryAddress: DEP, entityProviderAddress: EP };
const env: any = { quietRuntimeLogs: true, state: { jReplicas: new Map([["j", { name: "j", chainId: OG_J.chainId, contracts: { depository: DEP, entityProvider: EP }, rpcs: [] }]]) } };

/** ALICE's Entity (one validator) with an Account to BOB and random reserves; `named` puts the J replica name in its config. */
const aliceEntity = (reserves: ReadonlyMap<number, bigint>, named = true): EntityState => unwrap(createEntity({
  id: ALICE, jurisdiction: TERMS.domain, threshold: 1n, members: new Map([[aliceAddr, { shares: 1n }]]),
  jurisdictionConfig: { ...(named ? { name: "j" } : {}), entityProviderAddress: EP }, committed: { reserves: new Map(reserves) },
})).state;
/** og EntityState around the rewrite's committed jBatchState and reserves, with its Accounts behind a candidate-map shell. */
const ogState = (s: EntityState, replicas: ReadonlyMap<EntityId, AccountReplica>, timestamp: number): any => {
  const accounts = new Map([...replicas].map(([peer, c]) => [peer as string, {
    status: c._tag === "disputed" ? "disputed" : "active", state: { jNonce: c.state.jNonce },
    shadow: { rebalance: { submittedAtByToken: PersistentAccountStateMap.fromEntries("rebalanceShadowSubmitted", [...(c.state.submittedAt ?? new Map<number, number>())].map(([t, at]) => [t, at] as const)) } },
  }]));
  const shell = Object.assign(Object.create(EntityAccountCandidateMap.prototype), { get: (id: string) => accounts.get(id), getForWrite: (id: string) => accounts.get(id), has: (id: string) => accounts.has(id), keys: () => accounts.keys() });
  const jb = ogJb(s);
  return {
    entityId: s.id, timestamp, config: { mode: "proposer-based", threshold: 1n, validators: [aliceAddr.toLowerCase()], shares: { [aliceAddr.toLowerCase()]: 1n }, jurisdiction: s.jurisdictionConfig?.name === undefined ? { ...OG_J, name: undefined } : OG_J },
    reserves: new Map(s.treasury.reserves), accounts: shell, ...(jb === undefined ? {} : { jBatchState: structuredClone(jb) }),
  };
};
const messages = (state: any): string[] => readEntityFrameEvents(state).map((e: any) => e.message);
const ogRun = async (f: () => Promise<any>): Promise<{ ok: true; value: any } | { ok: false; code: string }> => { try { return { ok: true, value: await f() }; } catch (e) { return { ok: false, code: (e as Error).message }; } };

const randomTx = (s: EntityState): EntityTx => {
  const tokenId = pick([1, 2, 3, 0, -1]), amount = pick([1n, 5n, 40n, 400n, 0n, -3n]), sent = sentOf(s.jBatch) !== undefined;
  const r = rng();
  if (r < 0.2) return { type: "r2r", data: { toEntityId: pick([BOB, OTHER, CAROL]), tokenId: Math.max(1, tokenId), amount: amount > 0n ? amount : 7n } };
  if (r < 0.3) return { type: "r2e", data: { receivingEntity: EXT, tokenId: Math.max(1, tokenId), amount: amount > 0n ? amount : 3n } };
  if (r < 0.37) return { type: "e2r", data: { contractAddress: pick([TOKEN_CONTRACT, TOKEN_CONTRACT.toLowerCase(), "0x9fe46736679d2D9a65F0992F2272dE9f3c7fa6e0", `0x${"00".repeat(20)}`, "0x12"]), amount, ...(rng() < 0.5 ? { internalTokenId: 1, tokenType: 0, externalTokenId: 0n } : {}) } };
  if (r < 0.55) return { type: "r2c", data: { counterpartyId: pick([BOB, BOB, CAROL, ALICE]), tokenId, amount, ...(rng() < 0.2 ? { receivingEntityId: pick([OTHER, ALICE, ALICE.toUpperCase().replace("0X", "0x")]) } : {}), ...(rng() < 0.1 ? { rebalanceQuoteId: 5, rebalanceFeeAmount: 1n, rebalanceFeeTokenId: 1 } : {}) } };
  if (r < 0.72) return { type: "j_broadcast", data: rng() < 0.2 ? { feeOverrides: { gasBumpBps: 500 } } : {} };
  if (r < 0.8) return { type: "j_rebroadcast", data: rng() < 0.5 ? { gasBumpBps: pick([0, 1250, 30_000, -4]) } : {} };
  if (r < 0.88 && sent) return { type: "j_abort_sent_batch", data: { ...(rng() < 0.6 ? { requeueToCurrent: rng() < 0.6 } : {}), ...(rng() < 0.5 ? { reason: "stuck" } : {}) } };
  if (r < 0.93) return { type: "j_clear_batch", data: rng() < 0.5 ? { reason: "manual" } : {} };
  return { type: "mintReserves", data: { tokenId: Math.max(1, tokenId), amount: amount > 0n ? amount : 9n } };
};
const ogHandler = (tx: EntityTx, st: any): Promise<any> => {
  const t = tx as any;
  switch (tx.type) {
    case "r2r": return handleR2R(st, t, true);
    case "r2e": return handleR2E(st, t, true);
    case "e2r": return handleE2R(st, t, true);
    case "r2c": return handleR2C(env, st, t, true);
    case "j_broadcast": return handleJBroadcast(st, t, env, true);
    case "j_rebroadcast": return handleJRebroadcast(st, t, env, true);
    case "j_abort_sent_batch": return handleJAbortSentBatch(st, t, env, true);
    case "j_clear_batch": return handleJClearBatch(st, t, env, true);
    case "mintReserves": return handleMintReserves(st, t, env, true);
    default: throw new Error(`test: ${tx.type}`);
  }
};
const ogJTxOf = (out: any): any => out.jOutputs?.[0]?.jTxs?.[0];

describe(seedTag("entity-j: Entity-level J-batch txs on the committed jBatchState (og entity/tx/handlers/j-batch/*)"), () => {
  test("MATCH: 40 random runs of r2r / r2e / e2r / r2c / j_broadcast / j_rebroadcast / j_abort_sent_batch / j_clear_batch / mintReserves give og's verdict, jBatchState, messages, J outputs and jBatch hashes to sign", async () => {
    const seen = new Map<string, number>();
    for (let run = 0; run < 40; run++) {
      let state = aliceEntity(new Map([[1, BigInt(ri(200))], [2, BigInt(ri(60))]]), rng() < 0.9);
      let replicas: ReadonlyMap<EntityId, AccountReplica> = new Map([[BOB, genesisAB() as AccountReplica]]);
      if (rng() < 0.5) replicas = new Map([[BOB, { ...replicas.get(BOB)!, state: setRebalanceSubmittedAt(replicas.get(BOB)!.state, 1, 77) } as AccountReplica]]);
      let t = 1_000;
      for (let step = 0; step < 12; step++) {
        t += 1 + ri(9);
        const tx = randomTx(state), og = ogState(state, replicas, t);
        const ogR = await ogRun(() => ogHandler(tx, og));
        const f = foldTxs(state, replicas, signedTxs(state, aliceAddr, [tx]), { verify: verifiers.verify, timestamp: BigInt(t) });
        const key = `${tx.type}:${ogR.ok ? "ok" : "refused"}`;
        seen.set(key, (seen.get(key) ?? 0) + 1);
        expect(f.ok).toBe(ogR.ok);
        if (!ogR.ok || !f.ok) { expect(f.ok ? "" : (f.error as any).reason).toBe(ogR.ok ? "" : ogR.code); continue; }
        const d = f.value.draft, ogOut = ogR.value;
        expect((d.events ?? []).map((e) => e.message)).toEqual(messages(ogOut.newState));
        expect(ogJb(d.state)).toEqual(ogOut.newState.jBatchState);
        const ogTx = ogJTxOf(ogOut), myTx: any = d.jOutputs?.[0]?.jTxs[0];
        expect(myTx === undefined).toBe(ogTx === undefined);
        if (ogTx !== undefined) {
          expect(d.jOutputs![0]!.jurisdictionName).toBe(ogOut.jOutputs[0].jurisdictionName);
          expect(myTx).toEqual(ogTx);
          if (myTx.type === "batch") expect(myTx.data.encodedBatch).toBe(ogEncodeJBatch(ogTx.data.batch));
        }
        // og's handler call has no frame: og applyEntityFrame appends the 'profile' hash after the txs (consensus-final.test.ts)
        expect((d.hashes ?? []).filter((h) => h.type !== "profile")).toEqual(ogOut.hashesToSign ?? []);
        // Account latches the abort / clear release (og applyEntityAccountEnvelopeUpdate setRebalanceSubmittedAt)
        const ogSubmitted = [...ogOut.newState.accounts.get(BOB).shadow.rebalance.submittedAtByToken.keys()].sort();
        expect([...(d.accountReplicas.get(BOB)!.state.submittedAt ?? new Map()).keys()].sort()).toEqual(ogSubmitted);
        state = d.state;
        replicas = d.accountReplicas;
      }
    }
    for (const k of ["r2r:ok", "r2r:refused", "r2c:ok", "e2r:ok", "e2r:refused", "j_broadcast:ok", "j_broadcast:refused", "j_rebroadcast:ok", "j_abort_sent_batch:ok", "j_clear_batch:ok", "mintReserves:ok"]) expect(seen.get(k) ?? 0).toBeGreaterThan(0);
  }, 120_000);

  test("MATCH: contractBatch reproduces og encodeJBatch bytes for og-shaped committed batches (numeric rows, Int512 proof bodies)", () => {
    for (let i = 0; i < 60; i++) {
      const body = { watchSeed: `0x${"11".repeat(32)}`, leftResponseSeconds: 86400, rightResponseSeconds: 3600, offdeltas: [{ high: -1n, low: (1n << 256n) - BigInt(1 + ri(50)) }, { high: 0n, low: BigInt(ri(99)) }], tokenIds: [1n, 2n], transformers: [] };
      const b: any = {
        reserveToReserve: [{ receivingEntity: OTHER, tokenId: 1 + ri(3), amount: BigInt(ri(99)) }], reserveToCollateral: rng() < 0.5 ? [] : [{ tokenId: 1, receivingEntity: ALICE, pairs: [{ entity: BOB, amount: 5n }] }],
        collateralToReserve: [{ counterparty: BOB, tokenId: 2, amount: 3n, nonce: 1 + ri(9), sig: "0x12" }], settlements: [{ leftEntity: ALICE, rightEntity: BOB, diffs: [{ tokenId: 1, leftDiff: -3n, rightDiff: 3n, collateralDiff: 0n, ondeltaDiff: -3n }], forgiveDebtsInTokenIds: [2], sig: "0x34", nonce: 4 }],
        disputeStarts: [{ counterentity: BOB, nonce: 2, proposerIsLeft: true, proofbodyHash: `0x${"22".repeat(32)}`, initialProofbody: body, watchSeed: body.watchSeed, sig: "0x56", starterInitialArguments: "0x", starterCounterArguments: "0x", starterCounterProofCommitment: `0x${"00".repeat(32)}` }],
        counterDisputes: [], disputeFinalizations: [{ counterentity: BOB, initialNonce: 2, finalNonce: 3, proposerIsLeft: false, initialProofbodyHash: `0x${"22".repeat(32)}`, finalProofbody: body, starterArguments: "0x", otherArguments: "0x", sig: "0x", startedByLeft: true, cooperative: false, submitNotBeforeTimestamp: 9 }],
        externalTokenToReserve: [{ entity: ALICE, contractAddress: TOKEN_CONTRACT, externalTokenId: 0n, tokenType: 0, internalTokenId: 1, amount: 4n }], reserveToExternalToken: [], revealSecrets: [],
        hashLadderRegistrations: [{ counterpartyEntity: BOB, targetRole: false, fullHash: `0x${"33".repeat(32)}`, partialRoot: `0x${"44".repeat(32)}`, witness: { fillRatio: ri(1000), fullSecret: `0x${"55".repeat(32)}`, reveals: [1, 2, 3, 4].map((n) => `0x${String(n).repeat(64)}`) } }],
      };
      expect(encodeBatch(contractBatch(b))).toBe(ogEncodeJBatch(b));
    }
  });

  test("MATCH: j_broadcast refusals (no jBatchState, pending sentBatch) and notes (empty, unnamed jurisdiction) are og's", async () => {
    const replicas: ReadonlyMap<EntityId, AccountReplica> = new Map([[BOB, genesisAB() as AccountReplica]]);
    const fresh = aliceEntity(new Map([[1, 100n]]));
    const cases: EntityState[] = [fresh, { ...fresh, jBatch: initJBatch() }, aliceEntity(new Map([[1, 100n]]), false)];
    const queued = unwrap(foldTxs(cases[2]!, replicas, signedTxs(cases[2]!, aliceAddr, [{ type: "r2r", data: { toEntityId: OTHER, tokenId: 1, amount: 5n } }]), { verify: verifiers.verify, timestamp: 5n })).draft.state;
    cases.push(queued);
    for (const s of cases) {
      const og = ogState(s, replicas, 9), ogR = await ogRun(() => handleJBroadcast(og, { type: "j_broadcast", data: {} }, env, true));
      const f = foldTxs(s, replicas, signedTxs(s, aliceAddr, [{ type: "j_broadcast", data: {} }]), { verify: verifiers.verify, timestamp: 9n });
      expect(f.ok).toBe(ogR.ok);
      if (!f.ok || !ogR.ok) { expect((f as any).error.reason).toBe((ogR as any).code); continue; }
      expect((f.value.draft.events ?? []).map((e) => e.message)).toEqual(messages(ogR.value.newState));
    }
  });
});

// ---- RJ-9: og runtime/registration/numbered-registration-{codec,intent}.ts over ethers Transaction.from ----
const nrng = prng(0x9e_91);
const nri = (n: number) => Math.floor(nrng() * n);
const npick = <X,>(xs: readonly X[]): X => xs[nri(xs.length)] as X;
const nhex = (bytes: number): string => `0x${Array.from({ length: bytes * 2 }, () => "0123456789abcdef"[nri(16)]).join("")}`;
const SECP_N = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
const wallets = [1, 2, 3].map((i) => new ethers.Wallet(`0x${String(i).padStart(2, "0").repeat(32)}`));
const other = (w: ethers.Wallet): ethers.Wallet => { const o = wallets.find((x) => x !== w); if (o === undefined) throw new Error("one wallet only"); return o; };
/** A random signed transaction of type 0 (EIP-155 or pre-155), 1 or 2, serialized by ethers. */
const signedTx = (over: { to?: string; data?: string; chainId?: bigint; nonce?: number; value?: bigint; type?: number; wallet?: ethers.Wallet } = {}): string => {
  const type = over.type ?? npick([0, 0, 1, 2, 2]), chainId = over.chainId ?? npick([31337n, 1n, 0n, 8453n]);
  const fees = type === 2 ? { maxPriorityFeePerGas: BigInt(nri(3)) * 1_000_000_000n, maxFeePerGas: 3_000_000_000n + BigInt(nri(1000)) } : { gasPrice: BigInt(nri(4)) * 1_000_000_000n };
  const tx = ethers.Transaction.from({
    type, chainId: type === 0 ? chainId : chainId === 0n ? 1n : chainId, nonce: over.nonce ?? npick([0, 1, 127, 128, 70_000]), gasLimit: 21_000n + BigInt(nri(500_000)),
    to: over.to ?? npick([EP, nhex(20), TOKEN_CONTRACT]), value: over.value ?? npick([0n, 0n, 1n, 10n ** 18n]), data: over.data ?? npick(["0x", nhex(1), nhex(4 + nri(60))]),
    ...fees, ...(type !== 0 && nri(3) === 0 ? { accessList: [{ address: nhex(20), storageKeys: Array.from({ length: nri(3) }, () => nhex(32)) }] } : {}),
  });
  tx.signature = (over.wallet ?? npick(wallets)).signingKey.sign(tx.unsignedHash);
  return tx.serialized;
};
/** Flip one random bit of a copy (the byte index is drawn before the bit). */
const flipByte = (b: Uint8Array): string => { const i = nri(b.length); b[i] = (b[i] ?? 0) ^ (1 << nri(8)); return ethers.hexlify(b); };
/** One structural mutation of a serialized transaction, at the RLP-field level or on the raw bytes. */
const mutateTx = (raw: string): string => { try { return mutateFields(raw); } catch { return flipByte(ethers.getBytes(raw).slice()); } };
const mutateFields = (raw: string): string => {
  const bytes = ethers.getBytes(raw), typed = bytes[0]! < 0x7f, prefix = typed ? ethers.hexlify(bytes.slice(0, 1)) : "0x";
  let decoded: unknown;
  try { decoded = ethers.decodeRlp(typed ? bytes.slice(1) : bytes); } catch { decoded = null; }
  if (!Array.isArray(decoded) || decoded.length < 6 || decoded.some((f) => typeof f !== "string" && !Array.isArray(f))) return flipByte(new Uint8Array(bytes));
  const fields = decoded as any[], sig = fields.length - 3;
  const encode = (fs: unknown[]): string => ethers.concat([prefix, ethers.encodeRlp(fs as never)]);
  const big = (h: string): bigint => (h === "0x" ? 0n : BigInt(h)), be = (n: bigint): string => (n === 0n ? "0x" : ethers.toBeHex(n));
  const set = (i: number, v: unknown): string => { const fs = [...fields]; fs[i] = v; return encode(fs); };
  switch (nri(17)) {
    case 0: return flipByte(new Uint8Array(bytes));
    case 1: return ethers.hexlify(bytes.slice(0, Math.max(1, bytes.length - 1 - nri(4))));
    case 2: return ethers.concat([raw, npick(["0x00", "0x80", "0xc0"])]);
    case 3: { const i = nri(typed ? 7 : 5); return set(i, ethers.concat(["0x00", fields[i]])); }
    case 4: return typed ? set(sig, npick(["0x02", "0x00", "0x01", "0x"])) : set(6, be(npick([0n, 1n, 27n, 28n, 29n, 35n, 36n, big(fields[6]) + 2n, big(fields[6]) - 2n])));
    case 5: return set(sig + 1, "0x");
    case 6: return set(sig + 2, "0x");
    case 7: { const s = SECP_N - big(fields[sig + 2]), v = typed ? (fields[sig] === "0x" ? "0x01" : "0x") : be(big(fields[6]) ^ 1n); const fs = [...fields]; fs[sig] = v; fs[sig + 2] = be(s); return encode(fs); }
    case 8: return set(sig + 2, be(big(fields[sig + 2]) | (1n << 255n)));
    case 9: return set(sig + 1, be(npick([SECP_N, SECP_N + 1n, 1n << 256n])));
    case 10: { const i = typed ? (bytes[0] === 2 ? 5 : 4) : 3; return set(i, npick(["0x", nhex(19), nhex(21)])); }
    case 11: { const i = typed ? (bytes[0] === 2 ? 7 : 6) : 5; return set(i, [fields[i]]); }
    case 12: return encode(nri(2) === 0 ? [...fields, "0x"] : fields.slice(0, -1));
    case 13: return encode(fields.slice(0, sig));
    case 14: if (typed) { const i = bytes[0] === 2 ? 8 : 7; return set(i, npick([[[nhex(20), [nhex(31)]]], [[nhex(19), []]], [[nhex(20), [], "0x"]], [nhex(20)], [[nhex(20), nhex(32)]]])); } return set(0, fields[0]);
    case 15: if (bytes[0] === 2) { const fs = [...fields]; fs[2] = be(big(fields[3]) + 1n); return encode(fs); } return raw;
    default: return ethers.concat([npick(["0x05", "0x7f", "0x00", "0x01", "0x02"]), bytes.slice(1)]);
  }
};
const ethersView = (raw: string): unknown => {
  try {
    const t = ethers.Transaction.from(raw), hash = t.hash;
    let from: string | null;
    try { from = t.from?.toLowerCase() ?? null; } catch { from = "ERR"; }
    return { type: t.type, hash, from, chainId: t.chainId, nonce: t.nonce, to: t.to?.toLowerCase() ?? null, value: t.value, data: t.data.toLowerCase() };
  } catch { return "REFUSED"; }
};
const rewriteView = (raw: string): unknown => {
  const r = parseEvmTx(raw);
  if (!r.ok) return "REFUSED";
  const t = r.value;
  return { type: t.type, hash: t.hash, from: t.from === null ? null : t.from.ok ? t.from.value : "ERR", chainId: t.chainId, nonce: t.nonce, to: t.to, value: t.value, data: t.data };
};

describe(seedTag("entity-j RJ-9: signed EVM transaction parser (ethers v6 Transaction.from)"), () => {
  test("MATCH (randomized): legacy EIP-155 / pre-155, EIP-2930 and EIP-1559 transactions and their mutations -- same refusal, hash, sender, chain, nonce, to, value, data", () => {
    let accepted = 0, refused = 0, mutated = 0;
    for (let i = 0; i < 1500; i++) {
      let raw = signedTx();
      for (let m = nri(3); m > 0; m--) { raw = mutateTx(raw); mutated++; }
      const og = ethersView(raw);
      expect(rewriteView(raw)).toEqual(og);
      if (og === "REFUSED") refused++; else accepted++;
    }
    expect(accepted).toBeGreaterThan(400);
    expect(refused).toBeGreaterThan(200);
    expect(mutated).toBeGreaterThan(1000);
  }, 120_000);
  test("MATCH: registerNumberedEntitiesBatch(bytes[]) calldata is og encodeNumberedRegistrationCalldata", () => {
    const iface = EntityProvider__factory.createInterface();
    for (let i = 0; i < 40; i++) {
      const boards = Array.from({ length: 1 + nri(4) }, () => nhex(1 + nri(300)));
      expect(numberedRegistrationCalldata(boards)).toBe(iface.encodeFunctionData("registerNumberedEntitiesBatch", [boards]).toLowerCase());
    }
  });
});

describe(seedTag("entity-j RJ-9: durable numbered-registration intents (og numbered-registration-intent.ts)"), () => {
  const iface = EntityProvider__factory.createInterface();
  const NDEP = "0x5fbdb2315678afecb367f032d93f642f64180aa3", CHAIN = 31337, SEED = `0x${"5e".repeat(64)}`;
  const word = (n: number): string => `0x${n.toString(16).padStart(64, "0")}`;
  const clone = <T,>(v: T): T => {
    if (v === null || typeof v !== "object") return v;
    if (v instanceof Uint8Array) return new Uint8Array(v) as T;
    if (v instanceof Map) return new Map([...v].map(([k, x]) => [clone(k), clone(x)])) as T;
    if (Array.isArray(v)) return v.map(clone) as T;
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)])) as T;
  };
  const code = (e: unknown): string => String((e as Error).message).split(":")[0] ?? "";
  const runOg = async (env: any, tx: unknown): Promise<string | null> => { try { await ogApplyRuntimeTx(env, clone(tx) as never, { isReplay: true }); return null; } catch (e) { return code(e); } };
  const rwCode = (r: { readonly ok: boolean; readonly error?: unknown }): string | null => (r.ok ? null : String((r.error as { code?: string; _tag: string }).code ?? (r.error as { _tag: string })._tag).split(":")[0] ?? "");
  /** Runtime tx on both sides: the same decision (a raw-tx parse refusal is og's ethers message, compared as a refusal) and the same intent store. */
  const both = async (env: any, rt: Runtime, tx: unknown): Promise<{ rt: Runtime; og: string | null }> => {
    const og = await runOg(env, tx);
    const rw = applyRuntimeTx(rt, tx as RuntimeTx, { replay: true });
    const rc = rwCode(rw);
    // og's own crash on a malformed field (an ethers parse error, a TypeError on a null seed) is compared as a refusal.
    if (og !== null && !/^[A-Z0-9_]+$/.test(og)) expect(rc).not.toBeNull();
    else expect(rc).toBe(og);
    const next = rw.ok ? rw.value : rt;
    const held = env.infrastructure.numberedRegistrationIntents as Map<string, unknown> | undefined;
    expect(stableJson([...next.numberedRegistrationIntents])).toBe(stableJson([...(held ?? new Map())]));
    // The durable post-state view commits the intent store exactly as og does.
    const ogOnly = { state: { jReplicas: env.state.jReplicas, eReplicas: new Map(), timestamp: 0, height: 0 }, infrastructure: held !== undefined && held.size > 0 ? { numberedRegistrationIntents: held } : {}, runtimeId: env.runtimeId };
    const rwOnly = { ...createRuntime([...next.jReplicas.values()], next.runtimeId), numberedRegistrationIntents: next.numberedRegistrationIntents };
    expect(unwrap(runtimeComponentDigests(runtimeView(rwOnly)))).toEqual(computeRuntimePostStateComponentDigests(buildReplayVerifiableRuntimePostStateView(ogOnly as never)) as never);
    return { rt: next, og };
  };

  test("MATCH (randomized): record / repeat / conflict / quarantine / complete intents with certified evidence and imported replicas -- same decisions and the same durable store", async () => {
    const tally = { recorded: 0, refused: 0, completed: 0, quarantined: 0 };
    const refusals = new Set<string>();
    for (let run = 0, more = untilCovered(40, () => tally.recorded > 6 && tally.refused > 6 && tally.completed > 2 && refusals.size > 8); more(run); run++) {
      const seed = `entity-j-numbered-${run}`, env = createEmptyEnv(seed) as any;
      registerSignerKey(env, env.runtimeId, deriveSignerKeySync(seed, "1"));
      const replica = { name: "Local", blockNumber: 7n, stateRoot: null, mempool: [], blockDelayMs: 300, lastBlockTimestamp: 0, position: { x: 0, y: 50, z: 0 }, chainId: CHAIN, contracts: { depository: NDEP, entityProvider: EP }, watcherConfirmationDepth: 0, entityProviderDeploymentBlock: 1 };
      env.state.jReplicas.set("Local", replica);
      let rt: Runtime = createRuntime([clone(replica) as unknown as JReplica], env.runtimeId);
      const jurisdiction = { address: NDEP, name: "Local", chainId: CHAIN, depositoryAddress: NDEP, entityProviderAddress: EP };
      const payer = npick(wallets), local = aliceAddr.toLowerCase();
      const definitions = Array.from({ length: 1 + nri(3) }, (_, i) => {
        const validators = npick([[aliceAddr, bobAddr], [aliceAddr], [bobAddr, aliceAddr], [bobAddr]]);
        const owned = validators.includes(aliceAddr) && nri(4) > 0;
        return { name: `numbered-${run}-${i}`, validators, threshold: BigInt(1 + nri(validators.length)), ...(owned ? { localSignerId: aliceAddr, entitySeed: SEED } : { localSignerId: null, entitySeed: null }) };
      });
      const request: any = buildNumberedRegistrationRequest(env, { ...(nri(2) === 0 ? { intentId: nhex(32) } : {}), jurisdiction, payerSignerId: payer.address, entities: definitions });
      const sign = (req: any, over: Parameters<typeof signedTx>[0] = {}): { raw: string; hash: string; nonce: number } => {
        const nonce = over.nonce ?? nri(20), raw = signedTx({ to: EP, data: encodeNumberedRegistrationCalldata(req), chainId: BigInt(CHAIN), value: 0n, wallet: payer, nonce, ...over });
        return { raw, hash: ethers.keccak256(raw), nonce };
      };
      const pendingOf = (req: any, over: Parameters<typeof signedTx>[0] = {}): any => { const t = sign(req, over); return { status: "pending", request: req, requestHash: (() => { try { return computeNumberedRegistrationRequestHash(req); } catch { return nhex(32); } })(), rawTransaction: t.raw, transactionHash: t.hash, transactionNonce: t.nonce }; };
      let pending = pendingOf(request);
      // One defect in the intent: the request, its hash, or the signed transaction.
      const defect = nri(34);
      if (defect === 0) pending = { ...pending, requestHash: nhex(32) };
      else if (defect === 1) pending = { ...pending, transactionHash: nhex(32) };
      else if (defect === 2) pending = { ...pending, transactionNonce: pending.transactionNonce + 1 };
      else if (defect === 3) pending = { ...pendingOf(request, { to: nhex(20) }) };
      else if (defect === 4) pending = { ...pendingOf(request, { wallet: other(payer) }) };
      else if (defect === 5) pending = { ...pendingOf(request, { data: nhex(40) }) };
      else if (defect === 6) pending = { ...pendingOf(request, { chainId: npick([1n, 0n]), type: 0 }) };
      else if (defect === 7) pending = { ...pendingOf(request, { value: 1n }) };
      else if (defect === 8) pending = { ...pending, rawTransaction: npick(["0xzz", `${pending.rawTransaction}0`, "0x", `0x${"00".repeat(262_200)}`]) };
      else if (defect === 9) pending = { ...pending, rawTransaction: mutateTx(pending.rawTransaction) };
      else {
        // Request defects are re-hashed and re-signed, so the request check itself refuses them.
        const req = clone(request);
        const e = req.entities[nri(req.entities.length)];
        if (defect === 10) req.version = 2;
        else if (defect === 11) req.stackKey = nhex(32);
        else if (defect === 12) req.intentId = req.intentId.toUpperCase().replace("0X", "0x");
        else if (defect === 13) e.name = npick(["", "x".repeat(257)]);
        else if (defect === 14) e.encodedBoard = `${e.encodedBoard}00`;
        else if (defect === 15) e.boardHash = nhex(32);
        else if (defect === 16) { e.localSignerId = e.localSignerId === null ? local : null; }
        else if (defect === 17) e.entitySeed = e.localSignerId === null ? SEED : SEED.toUpperCase().replace("0X", "0x");
        else if (defect === 18) e.position = { x: 1, y: Number.NaN, z: 0 };
        else if (defect === 19) req.payerSignerId = npick([payer.address, "0x12"]);
        else if (defect === 20) req.entities = [];
        else if (defect === 21) e.config.jurisdiction = { ...e.config.jurisdiction, depositoryAddress: nhex(20) };
        pending = pendingOf(req);
      }
      let step = await both(env, rt, { type: "recordNumberedRegistrationIntent", data: pending });
      rt = step.rt;
      if (step.og !== null) { tally.refused++; refusals.add(step.og); continue; }
      tally.recorded++;
      // A repeat is a no-op; another transaction for the same intent, or another payload under its id, is refused.
      const repeat = nri(4);
      if (repeat === 0) rt = (await both(env, rt, { type: "recordNumberedRegistrationIntent", data: clone(pending) })).rt;
      else if (repeat === 1) { const again = pendingOf(pending.request, { nonce: pending.transactionNonce + 1 }); refusals.add(String((await both(env, rt, { type: "recordNumberedRegistrationIntent", data: again })).og)); }
      else if (repeat === 2) {
        const req = clone(pending.request);
        req.entities[0].name = `${req.entities[0].name}-renamed`;
        refusals.add(String((await both(env, rt, { type: "recordNumberedRegistrationIntent", data: pendingOf(req) })).og));
      }
      const identity = { intentId: pending.request.intentId, requestHash: pending.requestHash, transactionHash: pending.transactionHash };
      if (nri(4) === 0) {
        const tweak = nri(5);
        const res = { kind: "quarantined", ...identity, ...(tweak === 0 ? { transactionHash: nhex(32) } : tweak === 1 ? { intentId: nhex(32) } : {}), reason: "mined_revert:status=0" };
        step = await both(env, rt, { type: "resolveNumberedRegistrationIntent", data: res });
        rt = step.rt;
        if (step.og === null) tally.quarantined++; else refusals.add(step.og);
        continue;
      }
      // Registration: certified evidence for each board, then the local validator's replica import.
      const results: any[] = [];
      for (const [i, planned] of pending.request.entities.entries()) {
        const entityNumber = 2 + i, entityId = word(entityNumber), height = 5 + i, blockHash = word(height * 7 + 1);
        const registered = nri(12) === 0 ? nhex(32) : planned.boardHash;
        const encoded = iface.encodeEventLog(iface.getEvent("EntityRegistered"), [entityId, BigInt(entityNumber), registered]);
        const receipt = { transactionHash: pending.transactionHash, transactionIndex: 0, blockNumber: height, blockHash, type: 2, status: 1, cumulativeGasUsed: 21_000, logsBloom: `0x${"00".repeat(256)}`,
          logs: [{ address: EP, topics: encoded.topics, data: encoded.data, blockNumber: height, blockHash, transactionHash: pending.transactionHash, transactionIndex: 0, logIndex: 0 }] };
        const root = await computeCanonicalReceiptsRoot([receipt]), proof = (await createCanonicalReceiptProofs([receipt], root)).get(0) as object;
        const log = { address: EP, topics: encoded.topics.map((t) => t.toLowerCase()), data: encoded.data.toLowerCase(), blockNumber: height, blockHash, transactionHash: pending.transactionHash, transactionIndex: 0, logIndex: 0, index: 0, receiptProof: { ...proof, receiptLogIndex: 0 } };
        const evidence = buildCertifiedRegistrationEvidence(env, replica as never, "EntityRegistered", log as never, { observedThroughHeight: height, observedTipBlockHash: blockHash, observedHeadHeight: height, confirmationDepth: 0 });
        if (nri(10) > 0) {
          const tx = { type: "recordAuthenticatedJAuthority", data: evidence };
          expect(await runOg(env, tx)).toBeNull();
          rt = unwrap(applyRuntimeTx(rt, tx as unknown as RuntimeTx, { replay: true }));
        }
        if (planned.localSignerId !== null && nri(8) > 0) {
          const tx = { type: "importReplica", entityId, signerId: aliceAddr, data: { config: planned.config, isProposer: planned.config.validators[0].toLowerCase() === local, entitySeed: SEED } };
          const og = await runOg(env, tx), rw = applyRuntimeTx(rt, tx as unknown as RuntimeTx, { replay: true });
          expect(rwCode(rw)).toBe(og);
          if (rw.ok) rt = rw.value;
        }
        const tweak = nri(16);
        results.push({ entityNumber, entityId: tweak === 0 ? entityId.toUpperCase().replace("0X", "0x") : entityId, registrationBlock: height, evidenceHash: tweak === 1 ? nhex(32) : computeRegistrationEvidenceHash(evidence) });
      }
      const tweak = nri(10);
      const res = { kind: "completed", ...identity, ...(tweak === 0 ? { requestHash: nhex(32) } : {}), results: tweak === 1 ? results.slice(1) : results };
      step = await both(env, rt, { type: "resolveNumberedRegistrationIntent", data: res });
      rt = step.rt;
      if (step.og !== null) { refusals.add(step.og); continue; }
      tally.completed++;
      // A completed intent: the same completion again is a no-op; a quarantine no longer finds a pending intent.
      rt = (await both(env, rt, { type: "resolveNumberedRegistrationIntent", data: clone(res) })).rt;
      refusals.add(String((await both(env, rt, { type: "resolveNumberedRegistrationIntent", data: { kind: "quarantined", ...identity, reason: "late" } })).og));
    }
    expect(tally.recorded).toBeGreaterThan(6);
    expect(tally.refused).toBeGreaterThan(6);
    expect(tally.completed).toBeGreaterThan(2);
    expect(refusals.size).toBeGreaterThan(8);
  }, 120_000);
});

// ---- og entity/tx/j-events.ts applyJEvent: the Entity-certified J range ----
const jrng = prng(0x1e_7e);
const jri = (n: number) => Math.floor(jrng() * n);
const jpick = <X,>(xs: readonly X[]): X => xs[jri(xs.length)] as X;
const jword = (): string => `0x${Array.from({ length: 64 }, () => "0123456789abcdef"[jri(16)]).join("")}`;
const JREF = getJEventJurisdictionRef(OG_J);
const ALICE_SIGNER = aliceAddr.toLowerCase();
/** A raw watcher event touching ALICE (or not), given the Entity's pending sent batch for HankoBatchProcessed. */
const rawJEvent = (sent: any): { type: string; data: Record<string, unknown> } => {
  const r = jrng(), tokenId = jpick([1, 2]), pair = jpick([[ALICE, BOB], [BOB, ALICE], [BOB, OTHER]]) as [string, string];
  if (r < 0.22) return { type: "ReserveUpdated", data: { entity: jpick([ALICE, ALICE, BOB]), tokenId, newBalance: String(jri(900)) } };
  if (r < 0.37) return { type: "DebtCreated", data: { debtor: pair[0], creditor: pair[1], tokenId, amount: String(jpick([1, 7, 40, 0])), debtIndex: jri(2) } };
  if (r < 0.45) return { type: "DebtEnforced", data: { debtor: pair[0], creditor: pair[1], tokenId, amountPaid: String(jri(9)), remainingAmount: String(jri(9)), newDebtIndex: jri(3) } };
  if (r < 0.5) return { type: "DebtForgiven", data: { debtor: pair[0], creditor: pair[1], tokenId, amountForgiven: String(1 + jri(9)), debtIndex: jri(2) } };
  if (r < 0.72) return { type: "AccountSettled", data: { leftEntity: pair[0], rightEntity: pair[1], tokenId, leftReserve: String(jri(500)), rightReserve: String(jri(500)), collateral: String(jri(300) * 10 ** 6), ondelta: String(jri(50) - 20), nonce: 1 + jri(4) } };
  if (r > 0.86) {
    const base = { entityId: jpick([ALICE, ALICE, BOB]), owner: jpick([ALICE_SIGNER, ALICE_SIGNER, ALICE_SIGNER, bobAddr.toLowerCase()]) }, token = jpick([TOKEN_CONTRACT.toLowerCase(), TOKEN_CONTRACT.toLowerCase(), EP]);
    if (jrng() < 0.45) return { type: "ExternalWalletSnapshot", data: { ...base, ...(jrng() < 0.5 ? { nativeBalance: String(jri(1e6)) } : {}), tokenBalances: [{ tokenAddress: token, ...(jrng() < 0.5 ? { tokenId: 1 } : {}), balance: String(jri(500)) }], allowances: jrng() < 0.6 ? [{ tokenAddress: token, spender: DEP, allowance: String(jri(99)) }] : [] } };
    const r2 = jrng();
    return { type: "ExternalWalletDelta", data: { ...base, tokenAddress: token, ...(jrng() < 0.3 ? { tokenId: 2 } : {}), ...(r2 < 0.7 ? { balanceDelta: String(jri(60) - 30) } : {}), ...(r2 > 0.4 ? { spender: jpick([DEP, EP]), allowance: String(jri(50)) } : {}) } };
  }
  return { type: "HankoBatchProcessed", data: { entityId: jpick([ALICE, ALICE, OTHER]), batchHash: sent && jrng() < 0.7 ? sent.batchHash : jword(), nonce: sent ? jpick([sent.entityNonce, sent.entityNonce, sent.entityNonce + 1, Math.max(1, sent.entityNonce - 1)]) : 1 + jri(3) } };
};
/** ALICE's proposer-signed range over (base, scanned] from og's own canonicalisation, hashing and signing inputs; `defect` breaks one envelope field. */
const signedRange = (ogSt: any, finalized: number, sent: any, defect: string): Record<string, unknown> => {
  const stale = defect === "stale", baseHeight = stale ? Math.max(0, finalized - 2) : defect === "ahead" ? finalized + 1 : finalized;
  const scannedThroughHeight = stale ? Math.max(1, finalized) : baseHeight + 1 + jri(4);
  const heights = [...new Set(Array.from({ length: jri(3) }, () => baseHeight + 1 + jri(scannedThroughHeight - baseHeight)))].sort((a, b) => a - b);
  const blocks = heights.map((blockNumber) => {
    const blockHash = jword();
    const events = Array.from({ length: 1 + jri(3) }, (_, logIndex) => normalizeJurisdictionEvent({ ...rawJEvent(sent), blockNumber, blockHash, transactionHash: jword(), logIndex })!).sort(compareCanonicalJurisdictionEvents);
    return { blockNumber, blockHash, eventsHash: canonicalJurisdictionEventsHash(events), events };
  });
  const tipBlockHash = jword(), jurisdictionRef = defect === "jurisdiction" ? "other-j" : JREF;
  const prefix = blocks.filter((b) => b.blockNumber > Number(ogSt.lastFinalizedJHeight ?? 0));
  const eventHistoryRoot = defect === "root" ? jword() : ogFoldRoot(ogSt.jHistoryFinality?.eventHistoryRoot ?? OG_EMPTY_ROOT, prefix.map((b) => ({ jurisdictionRef, jHeight: b.blockNumber, jBlockHash: b.blockHash, eventsHash: b.eventsHash })));
  const rangeHash = canonicalJEventRangeHash(jurisdictionRef, blocks), from = defect === "from" ? bobAddr.toLowerCase() : ALICE_SIGNER;
  const digest = buildJEventRangeDigest({ entityId: ALICE, jurisdictionRef, signerId: from, baseHeight, scannedThroughHeight, tipBlockHash, eventHistoryRoot, rangeHash });
  const signature = signDigestHex(digest, anvilKey(defect === "signature" ? 1 : 2));
  return { from, jurisdictionRef, baseHeight, scannedThroughHeight, observedAt: defect === "observed" ? scannedThroughHeight + 1 : scannedThroughHeight, tipBlockHash, blocks,
    eventHistoryRoot, rangeHash: defect === "rangeHash" ? jword() : rangeHash, signature };
};

describe(seedTag("entity-j: Entity-level j_event (og entity/tx/j-events.ts applyJEvent)"), () => {
  test("MATCH (randomized): signed ranges of reserve / debt / AccountSettled / HankoBatchProcessed events and envelope defects -- same verdict, reserves, debts, jBatchState, certified J head, board finality, messages, dirty Accounts and follow-up outputs", async () => {
    const seen = new Map<string, number>();
    const wanted = ["clean:ok", "stale:ok", "ahead:refused", "jurisdiction:refused", "root:refused", "from:refused", "signature:refused", "rangeHash:refused",
      "RESERVE", "DEBT:", "DEBT PAID", "DEBT FORGIVEN", "OBSERVED", "jBatch finalized", "quarantined", "snapshot | Block", "delta | Block",
      "DEBT_LEDGER_DIVERGENCE", "DEBT_CREATED_AMOUNT_INVALID", "EXTERNAL_WALLET_BASELINE_MISSING", "EXTERNAL_WALLET_OWNER_NOT_SIGNER"];
    for (let run = 0, more = untilCovered(45, () => wanted.every((k) => (seen.get(k) ?? 0) > 0)); more(run); run++) {
      const reserve1 = BigInt(jri(200)), reserve2 = BigInt(jri(60));
      let state = aliceEntity(new Map([[1, reserve1], [2, reserve2]]));
      let replicas: ReadonlyMap<EntityId, AccountReplica> = new Map([[BOB, genesisAB() as AccountReplica]]);
      let t = 1_000;
      // a sent batch to settle against, when the reserve covers the r2r
      if (jrng() < 0.6 && reserve1 >= 5n) state = unwrap(foldTxs(state, replicas, signedTxs(state, aliceAddr, [{ type: "r2r", data: { toEntityId: OTHER, tokenId: 1, amount: 5n } }, { type: "j_broadcast", data: {} }]), { verify: verifiers.verify, timestamp: BigInt(t) })).draft.state;
      let carry: any = { height: 0, lastFinalizedJHeight: 0 };
      for (let step = 0; step < 8; step++) {
        t += 1 + jri(9);
        const og: any = { ...ogState(state, replicas, t), ...structuredClone(carry) };
        const finalized = state.jFinality.height, sent = ogJb(state)?.sentBatch;
        const defect = jrng() < 0.7 ? "" : jpick(["stale", "ahead", "jurisdiction", "root", "from", "signature", "observed", "rangeHash"]);
        const data = signedRange(og, finalized, sent, defect);
        const before = 0;
        const ogR = await ogRun(() => ogApplyJEvent(og, data as any, { quietRuntimeLogs: true } as any, {} as any, [], true));
        const f = foldTxs(state, replicas, [{ type: "j_event", data: data as never }], { verify: verifiers.verify, timestamp: BigInt(t) });
        const key = `${defect || "clean"}:${ogR.ok ? "ok" : "refused"}`;
        seen.set(key, (seen.get(key) ?? 0) + 1);
        if (!ogR.ok) seen.set(ogR.code.split(/[: ]/)[0]!, (seen.get(ogR.code.split(/[: ]/)[0]!) ?? 0) + 1);
        expect([defect, f.ok, f.ok ? "" : (f.error as any).reason]).toEqual([defect, ogR.ok, ogR.ok ? "" : ogR.code]);
        if (!ogR.ok || !f.ok) { expect(f.ok ? "" : (f.error as any).reason).toBe(ogR.ok ? "" : ogR.code); continue; }
        const d = f.value.draft, out = ogR.value, next = out.newState, c = ogOf(d.state);
        // og handleJEventEntityTx (tx/apply.ts): JEventReceived per event (or one liveness event) ahead of applyJEvent's own runtime events (runtime-final.md RF-6)
        const ogFull = await ogRun(() => ogApplyEntityTx({ quietRuntimeLogs: true, state: { timestamp: t, height: 0, eReplicas: new Map(), jReplicas: new Map() } } as any, { ...ogState(state, replicas, t), ...structuredClone(carry) }, { type: "j_event", data } as any, { mutableFrameState: true } as any));
        if (!ogFull.ok) throw new Error(ogFull.code);
        if (ogFull.ok) expect(stableJson(d.runtimeEvents ?? [])).toBe(stableJson(ogFull.value.candidateEffects.filter((e: any) => e.kind === "runtimeEvent").map((e: any) => ({ eventName: e.eventName, data: e.data }))));
        // og routes a proposal's `🚀 Proposed frame` in proposePendingAccountFrames, after applyEntityTx; foldTxs runs that phase too
        expect((d.events ?? []).map((e) => e.message).filter((m) => !m.startsWith("🚀 Proposed frame "))).toEqual(messages(next).slice(before));
        for (const m of messages(next)) for (const k of ["RESERVE", "DEBT:", "DEBT PAID", "DEBT FORGIVEN", "OBSERVED", "jBatch finalized", "quarantined", "snapshot | Block", "delta | Block"]) if (m.includes(k)) seen.set(k, (seen.get(k) ?? 0) + 1);
        expect(c["reserves"]).toEqual(next.reserves);
        expect(Number(c["lastFinalizedJHeight"] ?? 0)).toBe(Number(next.lastFinalizedJHeight ?? 0));
        expect(c["jHistoryFinality"]).toEqual(next.jHistoryFinality);
        expect(c["certifiedBoardState"]).toEqual(next.certifiedBoardState);
        expect(ogJb(d.state)).toEqual(next.jBatchState);
        // og keeps a debt ledger only while it holds a debt: absent and empty commit different roots
        expect(c["outDebtsByToken"]).toEqual(next.outDebtsByToken);
        expect(c["inDebtsByToken"]).toEqual(next.inDebtsByToken);
        expect(c["externalWallet"]).toEqual(next.externalWallet);
        expect([...(d.touched ?? [])].sort()).toEqual([...out.dirtyAccounts].sort());
        // the Accounts' own frame proposals are the Entity frame's later step in og; the j_event outputs are the self j_broadcast follow-ups
        const selfOutputs = d.outputs.filter((o: any) => o.input !== undefined).map((o: any) => ({ entityId: o.to, signerId: String(o.signerId).toLowerCase(), types: o.input.txs.map((x: any) => x.type) }));
        expect(selfOutputs).toEqual(out.outputs.map((o: any) => ({ entityId: o.entityId, signerId: String(o.signerId).toLowerCase(), types: o.entityTxs.map((x: any) => x.type) })));
        state = d.state;
        replicas = d.accountReplicas;
        carry = { height: 0, lastFinalizedJHeight: next.lastFinalizedJHeight, jHistoryFinality: next.jHistoryFinality, certifiedBoardState: next.certifiedBoardState, ...(next.outDebtsByToken ? { outDebtsByToken: next.outDebtsByToken } : {}), ...(next.inDebtsByToken ? { inDebtsByToken: next.inDebtsByToken } : {}), ...(next.externalWallet ? { externalWallet: next.externalWallet } : {}) };
      }
    }
    for (const k of wanted) expect([k, seen.get(k) ?? 0]).not.toEqual([k, 0]);
  }, 120_000);
});

// ---- og board-handover.ts (consensus/authority + tx/handlers): [j_event with the Entity's own BoardActivated chain, boardHandover] ----
const NUM = `0x${"0".repeat(63)}2` as EntityId;
/** ALICE's proposer-signed range for `entityId` with one block per event list, above the certified head. */
const rangeFor = (entityId: string, og: any, eventLists: readonly (readonly { type: string; data: Record<string, unknown> }[])[]): Record<string, unknown> => {
  const baseHeight = Number(og.lastFinalizedJHeight ?? 0), scannedThroughHeight = baseHeight + Math.max(1, eventLists.length);
  const blocks = eventLists.map((raw, i) => {
    const blockNumber = baseHeight + 1 + i, blockHash = jword();
    const events = raw.map((e, logIndex) => normalizeJurisdictionEvent({ ...e, blockNumber, blockHash, transactionHash: jword(), logIndex })!).sort(compareCanonicalJurisdictionEvents);
    return { blockNumber, blockHash, eventsHash: canonicalJurisdictionEventsHash(events), events };
  });
  const tipBlockHash = jword();
  const eventHistoryRoot = ogFoldRoot(og.jHistoryFinality?.eventHistoryRoot ?? OG_EMPTY_ROOT, blocks.map((b) => ({ jurisdictionRef: JREF, jHeight: b.blockNumber, jBlockHash: b.blockHash, eventsHash: b.eventsHash })));
  const rangeHash = canonicalJEventRangeHash(JREF, blocks);
  const digest = buildJEventRangeDigest({ entityId, jurisdictionRef: JREF, signerId: ALICE_SIGNER, baseHeight, scannedThroughHeight, tipBlockHash, eventHistoryRoot, rangeHash });
  return { from: ALICE_SIGNER, jurisdictionRef: JREF, baseHeight, scannedThroughHeight, observedAt: scannedThroughHeight, tipBlockHash, blocks, eventHistoryRoot, rangeHash, signature: signDigestHex(digest, anvilKey(2)) };
};
const ogBoardHash = (config: any): string => { try { return hashBoard(encodeBoard(config)).toLowerCase(); } catch { return jword(); } };
/** A new board and the frame defect to put around it. */
const handoverCase = (variant: string): { board: any; activationFor: (oldHash: string, newHash: string) => { type: string; data: Record<string, unknown> }[] } => {
  const pool = [aliceAddr, bobAddr, carolAddr].map((a) => a.toLowerCase()), validators = pool.filter(() => jrng() < 0.6);
  if (validators.length === 0) validators.push(pool[1]!);
  if (variant === "bobFirst" && validators[0] !== pool[1]) { const i = validators.indexOf(pool[1]!); if (i >= 0) validators.splice(i, 1); validators.unshift(pool[1]!); }
  const shares: Record<string, bigint> = Object.fromEntries(validators.map((v) => [v, BigInt(1 + jri(3))]));
  const total = Object.values(shares).reduce((a, b) => a + b, 0n);
  let board: any = { mode: "proposer-based", threshold: BigInt(1 + jri(Number(total))), validators, shares };
  // EJ-R5: a nested Entity validator (og toBoardEntityId of a 32-byte id); og encodeBoard requires the proposer (validators[0]) to be an EOA
  if (variant === "nested" || variant === "nestedFirst") {
    const nested = jword().toLowerCase(), eoa = pool[jri(3)]!, vs = variant === "nested" ? [eoa, nested] : [nested, eoa];
    board = { mode: "proposer-based", threshold: BigInt(1 + jri(2)), validators: vs, shares: { [eoa]: 1n, [nested]: 1n } };
  }
  if (variant === "upper") { const up = ethers.getAddress(validators[0]!), { [validators[0]!]: s, ...rest } = shares; board = { ...board, validators: [up, ...validators.slice(1)], shares: { ...rest, [up]: s } }; }
  if (variant === "shareUpper") { const { [validators[0]!]: s, ...rest } = shares; board = { ...board, shares: { ...rest, [validators[0]!.toUpperCase().replace("0X", "0x")]: s } }; }
  if (variant === "gossip") board = { ...board, mode: "gossip-based" };
  if (variant === "threshold0") board = { ...board, threshold: 0n };
  if (variant === "thresholdHigh") board = { ...board, threshold: total + 1n };
  if (variant === "dup") board = { ...board, validators: [...validators, validators[0]!] };
  if (variant === "outsider") board = { ...board, shares: { ...shares, [`0x${"ab".repeat(20)}`]: 1n } };
  if (variant === "noShares") board = { ...board, shares: [] };
  const act = (entityId: string, previousBoardHash: string, newBoardHash: string) => ({ type: "BoardActivated", data: { entityId, previousBoardHash, newBoardHash, previousBoardValidUntil: String(1_700_000_000 + jri(99)) } });
  return {
    board, activationFor: (oldHash, newHash) => {
      if (variant === "noActivation") return [{ type: "ReserveUpdated", data: { entity: NUM, tokenId: 1, newBalance: "5" } }];
      if (variant === "badPrev") return [act(NUM, jword(), newHash)];
      if (variant === "hashMismatch") return [act(NUM, oldHash, jword())];
      if (variant === "chain2") { const mid = jword(); return [act(NUM, oldHash, mid), act(NUM, mid, newHash)]; }
      return [act(NUM, oldHash, newHash)];
    },
  };
};

describe(seedTag("entity-j RJ-10: boardHandover (og board-handover.ts, frame config derived inside consensus)"), () => {
  test("MATCH (randomized): certified BoardActivated handovers and their defects -- same frame authority verdict, handler verdict, new board, leader and certified registry", async () => {
    const variants = ["ok", "ok", "chain2", "bobFirst", "badPrev", "hashMismatch", "noActivation", "upper", "shareUpper", "gossip", "threshold0", "thresholdHigh", "dup", "outsider", "noShares", "shapeAlone", "shapeReversed", "twice", "unregistered", "wrongRegistration", "nested", "nestedFirst"];
    const seen = new Map<string, number>();
    for (let run = 0; run < 66; run++) {
      const variant = variants[run % variants.length]!;
      let state = unwrap(createEntity({ id: NUM, jurisdiction: TERMS.domain, threshold: 1n, members: new Map([[aliceAddr, { shares: 1n }]]), jurisdictionConfig: { name: "j", entityProviderAddress: EP }, committed: { reserves: new Map([[1, 10n]]) } })).state;
      const replicas: ReadonlyMap<EntityId, AccountReplica> = new Map();
      const ogEnv: any = { quietRuntimeLogs: true, infrastructure: {} };
      let carry: any = { height: 0, lastFinalizedJHeight: 0 };
      const ogFresh = (t: number): any => ({ ...ogState(state, replicas, t), ...structuredClone(carry) });
      const oldHash = ogBoardHash(ogFresh(1).config);
      if (variant !== "unregistered") {
        const og = ogFresh(10), registered = variant === "wrongRegistration" ? jword() : oldHash;
        const data = rangeFor(NUM, og, [[{ type: "FoundationBootstrapped", data: { recipient: aliceAddr, boardHash: jword(), controlTokenId: "1", dividendTokenId: "2" } }, { type: "EntityRegistered", data: { entityId: NUM, entityNumber: "2", boardHash: registered } }]]);
        const ogR = await ogRun(() => ogApplyJEvent(og, data as any, ogEnv, {} as any, [], true));
        const f = foldTxs(state, replicas, [{ type: "j_event", data: data as never }], { verify: verifiers.verify, timestamp: 10n });
        expect([f.ok, f.ok ? "" : (f.error as any).reason]).toEqual([ogR.ok, ogR.ok ? "" : (ogR as any).code]);
        if (!f.ok || !ogR.ok) continue;
        expect(ogOf(f.value.draft.state)["certifiedBoardState"]).toEqual(ogR.value.newState.certifiedBoardState);
        state = f.value.draft.state;
        carry = { ...carry, lastFinalizedJHeight: ogR.value.newState.lastFinalizedJHeight, jHistoryFinality: ogR.value.newState.jHistoryFinality, certifiedBoardState: ogR.value.newState.certifiedBoardState };
      }
      const { board, activationFor } = handoverCase(variant);
      const og = ogFresh(20), range = { type: "j_event", data: rangeFor(NUM, og, [activationFor(oldHash, ogBoardHash(board))]) }, handover = { type: "boardHandover", data: { board } };
      const txs: any[] = variant === "shapeAlone" ? [handover] : variant === "shapeReversed" ? [handover, range] : variant === "twice" ? [range, handover, handover] : [range, handover];
      const ogR = await ogRun(async () => {
        const authorized = getBoardHandoverFrameConfig(ogEnv, og, txs);
        const j = await ogApplyJEvent(og, txs[0].data, ogEnv, {} as any, [], true);
        return handleBoardHandoverEntityTx(j.newState, txs[1], ogEnv, true, authorized ?? undefined).newState;
      });
      const f = foldTxs(state, replicas, txs, { verify: verifiers.verify, timestamp: 20n });
      const key = `${variant}:${ogR.ok ? "ok" : "refused"}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
      expect([variant, f.ok, f.ok ? "" : (f.error as any).reason]).toEqual([variant, ogR.ok, ogR.ok ? "" : (ogR as any).code]);
      if (!f.ok || !ogR.ok) continue;
      const next = ogR.value, s = f.value.draft.state, q: any = s.quorum;
      expect(f.value.evicted).toEqual([]);
      expect([...q.members.keys()].map((a: string) => a.toLowerCase())).toEqual(next.config.validators);
      expect(Object.fromEntries([...q.members].map(([a, m]: any) => [a.toLowerCase(), m.shares]))).toEqual(next.config.shares);
      expect(q.threshold).toBe(next.config.threshold);
      expect(s.leaderState).toEqual(next.leaderState);
      expect(ogOf(s)["certifiedBoardState"]).toEqual(next.certifiedBoardState);
      expect(s.jFinality.height).toBe(next.lastFinalizedJHeight);
    }
    for (const k of ["ok:ok", "chain2:ok", "bobFirst:ok", "badPrev:refused", "hashMismatch:refused", "noActivation:refused", "upper:refused", "gossip:refused", "threshold0:refused", "shapeAlone:refused", "twice:refused", "unregistered:refused", "wrongRegistration:refused", "nested:ok", "nestedFirst:refused"]) expect(seen.get(k) ?? 0).toBeGreaterThan(0);
  }, 120_000);
});
