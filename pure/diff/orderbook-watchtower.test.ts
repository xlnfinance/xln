// Differential tests: og watchtower (core/watchtower/{http,store}, core/storage/recovery/bundle) and og orderbook (core/orderbook,
// entity swap requests) vs the pure rewrite. "MATCH:" tests run og live on the same input.
import { describe, expect, test } from "bun:test";
import { seedOf, seedTag, untilCovered } from "./seed.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ethers } from "ethers";
import { Level } from "level";
import { createWatchtowerStore } from "../../core/watchtower/store/index.ts";
import { handleTowerAppointment } from "../../core/watchtower/http.ts";
import { buildTowerAppointmentOwnerMessage, computeEncryptedRuntimeRecoveryEnvelopeHash, computeTowerLastResortPayloadDigest } from "../../core/storage/recovery/bundle/crypto.ts";
import { serializeTaggedJson } from "../../core/protocol/serialization/index.ts";
import * as ogBook from "../../core/orderbook/core.ts";
import { computeBookCommitmentHash } from "../../core/orderbook/commitment.ts";
import { handleCancelSwapRequest, handlePlaceSwapOfferRequest } from "../../core/entity/tx/handlers/payments/swap-requests.ts";
import { ALICE, BOB, CAROL, NOW, TERMS, aliceAddr, unwrap, unwrapErr, verifiers } from "../xln_run.ts";
import {
  decodeTowerLookupDoc, hexToBytes, isEthersAddress, recoverPersonalMessage, signPersonalMessage, towerEnvelopeHash, towerPayloadDigest, upsertTowerAppointment, upsertTowerRecoveryArchive,
  verifyTowerAppointment, verifyTowerReceiptSignature, applyEntityInput, admitAt, createEntity, tokenId, type EntityTx, type WireAccountTx,
  applyBookCommand, bestAsk, bestBid, bookCommitmentHash, bookOrders, bookOrdersOutsidePriceRange, bookSideLevels, createBook, map, materializeCommittedRemainder, recordAcceptedUsdAskPrice, reduceBookOrderQuantity, resumeCrossedBook,
  type TowerAppointmentV1, type TowerLookupDoc, type TowerStoreConfig, type TowerWrite, type Result, type TowerError,
} from "../xln.ts";

const prng = (base: number) => { let seed = seedOf(base); return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const TOWER_KEY = ethers.keccak256(ethers.toUtf8Bytes("pure:tower"));
const hex = (rand: () => number, bytes: number): string => `0x${Array.from({ length: bytes }, () => Math.floor(rand() * 256).toString(16).padStart(2, "0")).join("")}`;
type Json = Record<string, unknown>;

/** A live og store on a scratch LevelDB plus the rewrite's threaded lookup documents, driven by the same appointment bodies. */
const lockstep = (opts: { readonly maxBundles?: number; readonly maxBytes?: number } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "pure-tower-"));
  const now = Date.now();
  const store = createWatchtowerStore({ dbPath: join(dir, "db"), towerId: "tower-1", towerPrivateKey: TOWER_KEY, now: () => now, ...(opts.maxBundles ? { maxBundlesPerLookupKey: opts.maxBundles } : {}), ...(opts.maxBytes ? { maxStoredBytesPerLookupKey: opts.maxBytes } : {}) });
  const cfg: TowerStoreConfig = { towerId: store.towerId, towerPrivateKey: hexToBytes(TOWER_KEY), maxBundlesPerLookupKey: store.maxBundlesPerLookupKey, maxStoredBytesPerLookupKey: store.maxStoredBytesPerLookupKey, receiptTtlMs: 365 * 24 * 60 * 60 * 1000, now };
  const docs = new Map<string, TowerLookupDoc>();
  const run = async (body: unknown): Promise<{ og: Json; pure: Result<TowerWrite, TowerError> }> => {
    const og = JSON.parse(await (await handleTowerAppointment(new Request("http://tower/appointment", { method: "POST", body: JSON.stringify(body) }), store)).text()) as Json;
    const parsed: unknown = JSON.parse(JSON.stringify(body));
    const key = (Array.isArray(parsed) ? (parsed[0] as Json | undefined)?.["lookupKey"] : (parsed as Json | null)?.["lookupKey"]) as string | undefined;
    const existing = key === undefined ? undefined : docs.get(String(key).trim().toLowerCase());
    const pure: Result<TowerWrite, TowerError> = Array.isArray(parsed)
      ? parsed.length !== 2 ? { ok: false, error: { _tag: "tower", code: "TOWER_ARCHIVE_PAIR_INVALID" } } : (() => {
          const a = verifyTowerAppointment(parsed[0], Date.now());
          if (!a.ok) return a;
          const b = verifyTowerAppointment(parsed[1], Date.now());
          return b.ok ? upsertTowerRecoveryArchive(cfg, [a.value, b.value], existing) : b;
        })()
      : (() => { const a = verifyTowerAppointment(parsed, Date.now()); return a.ok ? upsertTowerAppointment(cfg, a.value, existing) : a; })();
    if (pure.ok) {
      // the rewrite reads its own document back through og's stored-doc decoder, as og's store does
      const decoded = decodeTowerLookupDoc(serializeTaggedJson(pure.value.doc), pure.value.doc.lookupKey);
      if (!decoded.ok) throw new Error(`decode ${decoded.error.code}`);
      docs.set(pure.value.doc.lookupKey, decoded.value);
    }
    return { og, pure };
  };
  const expectSame = (r: { og: Json; pure: Result<TowerWrite, TowerError> }, label: string): void => {
    if (r.og["ok"] === true) {
      expect([label, r.pure.ok]).toEqual([label, true]);
      if (r.pure.ok) expect(JSON.parse(serializeTaggedJson(r.pure.value.receipt))).toEqual(r.og["receipt"] as Json);
    } else {
      expect([label, r.pure.ok]).toEqual([label, false]);
      const code = String(r.og["error"]);
      if (!r.pure.ok) expect([label, r.pure.error.code]).toEqual([label, code.startsWith("TOWER_") ? code : "TOWER_APPOINTMENT_SIGNATURE_UNREADABLE"]);
    }
  };
  /** og's persisted document for `lookupKey` must decode and equal the rewrite's. */
  const compareDocs = async (): Promise<void> => {
    await store.close();
    const db = new Level<string, string>(join(dir, "db"), { valueEncoding: "utf8" });
    for (const [key, doc] of docs) {
      const raw = await db.get(`lookup:${key}`);
      const decoded = decodeTowerLookupDoc(raw, key);
      expect(decoded.ok).toBe(true);
      if (decoded.ok) expect(serializeTaggedJson(decoded.value)).toBe(serializeTaggedJson(doc));
      expect(raw).toBe(serializeTaggedJson(doc));
    }
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { store, cfg, now, run, expectSame, compareDocs, docs };
};

const owner = (i: number) => new ethers.Wallet(ethers.keccak256(ethers.toUtf8Bytes(`pure:tower:owner:${i}`)));
const lookupKeyOf = (i: number) => ethers.keccak256(ethers.toUtf8Bytes(`pure:lookup:${i}`));
const encryptedRemedy = serializeTaggedJson({ type: "tower_encrypted_payload", version: 1, alg: "watch-seed-aes-256-gcm", iv: "0x0102", ciphertext: "0x0304" });
const payload = (seq: number): Json => ({
  triggerHint: "dispute", watch: { rpcUrl: "https://rpc.example", chainId: 1, depositoryAddress: "0x5FbDB2315678afecb367f032d93F642f64180aa3", watchedEntityId: ethers.ZeroHash.replace(/0$/, "1"), counterentity: ethers.ZeroHash.replace(/0$/, "2") },
  encryptedRemedy, actionKind: "counter_dispute_only", appointmentSequence: seq, proofNonce: 1, proofBodyHash: ethers.keccak256("0x01"), responseMode: "last_resort", lastResortWindowSeconds: 60,
});
type Spec = { readonly ownerIndex?: number; readonly lookup?: number; readonly slot?: number; readonly mode?: string; readonly signedAt: number; readonly height?: number; readonly createdAt?: number; readonly ciphertext?: string; readonly kind?: "snapshot" | "journal_tail"; readonly base?: number; readonly payload?: Json };
/** og client shape: bundle, owner proof over og's own buildTowerAppointmentOwnerMessage, signed by the owner wallet. */
const appointment = (s: Spec): Json => {
  const w = owner(s.ownerIndex ?? 0), lookupKey = lookupKeyOf(s.lookup ?? 0), mode = s.mode ?? "blind_backup";
  const bundle: Json = { version: 1, runtimeId: w.address.toLowerCase(), lookupKey, height: s.height ?? 5, createdAt: s.createdAt ?? 100, bundleHash: ethers.keccak256(ethers.toUtf8Bytes(`b${s.height ?? 5}`)), iv: "0x00112233", ciphertext: s.ciphertext ?? "0xdeadbeef", ...(s.kind ? { kind: s.kind } : {}), ...(s.base !== undefined ? { baseRuntimeHeight: s.base } : {}) };
  const message = buildTowerAppointmentOwnerMessage(w.address.toLowerCase(), mode as never, lookupKey, s.slot ?? 0, bundle as never, s.signedAt, s.payload as never);
  return { type: "tower_appointment", version: 1, towerMode: mode, lookupKey, slot: s.slot ?? 0, bundle, ownerProof: { runtimeId: w.address.toLowerCase(), signedAt: s.signedAt, signature: w.signMessageSync(message) }, ...(s.payload ? { lastResortPayload: s.payload } : {}) };
};

describe(seedTag("orderbook-watchtower: watchtower (ER-24)"), () => {
  test("MATCH (og crypto.ts + ethers): envelope hash, payload digest, EIP-191 sign/recover, isAddress", () => {
    const rand = prng(7);
    for (let i = 0; i < 40; i++) {
      const bundle = { version: 1 as const, runtimeId: hex(rand, 20), lookupKey: hex(rand, 32), height: Math.floor(rand() * 1e6), createdAt: Math.floor(rand() * 1e12), bundleHash: hex(rand, 32), iv: hex(rand, 12), ciphertext: hex(rand, 1 + Math.floor(rand() * 40)), ...(rand() < 0.5 ? { kind: "journal_tail" as const, baseRuntimeHeight: 3 } : {}) };
      expect(towerEnvelopeHash(bundle)).toBe(computeEncryptedRuntimeRecoveryEnvelopeHash(bundle));
      const p = payload(i + 1) as never;
      expect(towerPayloadDigest(p)).toBe(computeTowerLastResortPayloadDigest(p));
      const key = hex(rand, 32), message = `m${i}|${hex(rand, 8)}`;
      const sig = signPersonalMessage(message, hexToBytes(key));
      expect(sig).toBe(new ethers.Wallet(key).signMessageSync(message));
      expect(recoverPersonalMessage(message, sig)).toBe(ethers.verifyMessage(message, sig).toLowerCase());
      const compact = ethers.Signature.from(sig).compactSerialized;
      expect(recoverPersonalMessage(message, compact)).toBe(ethers.verifyMessage(message, compact).toLowerCase());
      for (const v of [0, 1, 2, 26, 29, 35, 36, 200]) {
        const variant = `${sig.slice(0, 130)}${v.toString(16).padStart(2, "0")}`;
        let ogRecovered: string | undefined;
        try { ogRecovered = ethers.verifyMessage(message, variant).toLowerCase(); } catch { ogRecovered = undefined; }
        expect([v, recoverPersonalMessage(message, variant)]).toEqual([v, ogRecovered]);
      }
      const addr = new ethers.Wallet(key).address;
      for (const candidate of [addr, addr.toLowerCase(), addr.slice(2), addr.replace(/[a-f]/, (c) => c.toUpperCase()), addr.toUpperCase().replace("0X", "0x"), ethers.getIcapAddress(addr), ethers.getIcapAddress(addr).replace(/.$/, "0"), "0x123"])
        expect([candidate, isEthersAddress(candidate)]).toEqual([candidate, ethers.isAddress(candidate)]);
    }
  }, 30_000);

  test("MATCH (og http.ts handleTowerAppointment + store upsertAppointment): verify, stale/replay store checks, retention, signed receipts, persisted document", async () => {
    const ls = lockstep();
    const base = ls.now - 10_000;
    const cases: readonly [string, unknown][] = [
      ["blind slot 0", appointment({ signedAt: base })],
      ["same bytes replay (idempotent)", appointment({ signedAt: base })],
      ["older signedAt: stale", appointment({ signedAt: base - 1 })],
      ["same signedAt, other ciphertext: replay mismatch", appointment({ signedAt: base, ciphertext: "0xbeef" })],
      ["newer signedAt, new bytes", appointment({ signedAt: base + 1, ciphertext: "0xbeef", height: 6 })],
      ["slot 1", appointment({ signedAt: base + 2, slot: 1, height: 4 })],
      ["slot 2 (retention cut at 3)", appointment({ signedAt: base + 3, slot: 2, height: 9 })],
      ["journal tail", appointment({ signedAt: base + 4, slot: 3, kind: "journal_tail", base: 5, height: 7 })],
      ["delayed last resort", appointment({ signedAt: base + 5, mode: "delayed_last_resort", payload: payload(3) })],
      ["delayed without payload", appointment({ signedAt: base + 6, mode: "delayed_last_resort" })],
      ["blind with payload", appointment({ signedAt: base + 6, payload: payload(3) })],
      ["delayed payload bad rpc", appointment({ signedAt: base + 7, mode: "delayed_last_resort", payload: { ...payload(4), watch: { ...(payload(4)["watch"] as Json), rpcUrl: "ftp://x" } } })],
      ["delayed payload chainId 0", appointment({ signedAt: base + 7, mode: "delayed_last_resort", payload: { ...payload(4), watch: { ...(payload(4)["watch"] as Json), chainId: 0 } } })],
      ["delayed payload bad checksum", appointment({ signedAt: base + 7, mode: "delayed_last_resort", payload: { ...payload(4), watch: { ...(payload(4)["watch"] as Json), depositoryAddress: "0x5fbDB2315678afecb367f032d93F642f64180aa3" } } })],
      ["delayed payload remedy in clear", appointment({ signedAt: base + 7, mode: "delayed_last_resort", payload: { ...payload(4), encryptedRemedy: "{\"type\":\"counter_dispute_remedy\"}" } })],
      ["delayed payload sequence 0", appointment({ signedAt: base + 7, mode: "delayed_last_resort", payload: payload(0) })],
      ["mode invalid", appointment({ signedAt: base + 8, mode: "watch" })],
      ["other runtime on the same lookup key", appointment({ signedAt: base + 9, ownerIndex: 1 })],
      ["second lookup key", appointment({ signedAt: base + 9, ownerIndex: 1, lookup: 1 })],
      ["clock skew > 24h", appointment({ signedAt: ls.now - 25 * 60 * 60 * 1000, lookup: 1, ownerIndex: 1 })],
      ["empty ciphertext", appointment({ signedAt: base + 10, ciphertext: "0x", lookup: 1, ownerIndex: 1 })],
    ];
    const outcomes: string[] = [];
    for (const [label, body] of cases) { const r = await ls.run(body); ls.expectSame(r, label); outcomes.push(r.og["ok"] === true ? "ok" : String(r.og["error"]).split(":")[0] ?? ""); }
    expect(outcomes.slice(0, 11)).toEqual(["ok", "ok", "TOWER_APPOINTMENT_STALE", "TOWER_APPOINTMENT_REPLAY_MISMATCH", "ok", "ok", "ok", "ok", "ok", "TOWER_LAST_RESORT_PAYLOAD_MISSING", "TOWER_BACKUP_LAST_RESORT_PAYLOAD_FORBIDDEN"]);
    expect(outcomes.slice(17)).toEqual(["TOWER_LOOKUP_RUNTIME_ID_MISMATCH", "ok", "TOWER_APPOINTMENT_STALE", "TOWER_BUNDLE_CIPHERTEXT_EMPTY"]);
    const valid = appointment({ signedAt: base + 20, lookup: 1, ownerIndex: 1, slot: 4 });
    const mutate = (f: (a: Json) => void): Json => { const a = structuredClone(valid); f(a); return a; };
    const broken: readonly [string, unknown][] = [
      ["extra field", mutate((a) => { a["extra"] = 1; })],
      ["ownerProof field missing", mutate((a) => { delete (a["ownerProof"] as Json)["signedAt"]; })],
      ["bundle extra", mutate((a) => { (a["bundle"] as Json)["x"] = 1; })],
      ["lookup key uppercase in bundle", mutate((a) => { (a["bundle"] as Json)["lookupKey"] = String(a["lookupKey"]).toUpperCase().replace("0X", "0x"); })],
      ["lookup key uppercase (normalized)", mutate((a) => { a["lookupKey"] = String(a["lookupKey"]).toUpperCase().replace("0X", "0x"); })],
      ["wrong signer", mutate((a) => { (a["ownerProof"] as Json)["signature"] = owner(0).signMessageSync("x"); })],
      ["garbage signature", mutate((a) => { (a["ownerProof"] as Json)["signature"] = "0x1234"; })],
      ["signedAt zero", mutate((a) => { (a["ownerProof"] as Json)["signedAt"] = 0; })],
      ["version 2", mutate((a) => { a["version"] = 2; })],
      ["bundle version 2", mutate((a) => { (a["bundle"] as Json)["version"] = 2; })],
      ["compression br", mutate((a) => { (a["bundle"] as Json)["compression"] = "br"; })],
      ["non-hex iv", mutate((a) => { (a["bundle"] as Json)["iv"] = "0xzz"; })],
      ["archive of one", [valid]],
      ["null", null],
      ["valid slot 4", valid],
    ];
    for (const [label, body] of broken) ls.expectSame(await ls.run(body), label);
    const snap = appointment({ signedAt: base + 30, lookup: 2, ownerIndex: 2, slot: 0, kind: "snapshot", height: 10 });
    const tail = appointment({ signedAt: base + 30, lookup: 2, ownerIndex: 2, slot: 0, kind: "journal_tail", base: 10, height: 12 });
    ls.expectSame(await ls.run([snap, tail]), "archive pair");
    ls.expectSame(await ls.run([tail, snap]), "archive pair reversed");
    ls.expectSame(await ls.run([snap, appointment({ signedAt: base + 31, lookup: 2, ownerIndex: 2, slot: 0, kind: "journal_tail", base: 10, height: 12 })]), "archive pair signedAt differ");
    await ls.compareDocs();
  });

  test("MATCH (randomized): 120 appointments over 3 lookup keys, bundle cap 2 and a 3.5 KB quota", async () => {
    for (const [seed, opts] of [[11, { maxBundles: 2 }], [12, { maxBytes: 3500 }]] as const) {
      const ls = lockstep(opts), rand = prng(seed), base = ls.now - 100_000;
      const seen = new Set<string>(), wanted = ["ok", "TOWER_APPOINTMENT_STALE", "TOWER_APPOINTMENT_REPLAY_MISMATCH"];
      for (let i = 0, more = untilCovered(60, () => wanted.every((k) => seen.has(k))); more(i); i++) {
        const lookup = Math.floor(rand() * 3), delayed = rand() < 0.25;
        const spec: Spec = {
          ownerIndex: rand() < 0.05 ? 9 : lookup, lookup, slot: Math.floor(rand() * 3), signedAt: base + Math.floor(rand() * 20), height: Math.floor(rand() * 8), createdAt: Math.floor(rand() * 4),
          ciphertext: hex(rand, 1 + Math.floor(rand() * (rand() < 0.1 ? 600 : 8))), ...(rand() < 0.3 ? { kind: "journal_tail" as const, base: 1 } : {}),
          ...(delayed ? { mode: "delayed_last_resort", payload: payload(1 + Math.floor(rand() * 5)) } : {}),
        };
        const r = await ls.run(appointment(spec));
        ls.expectSame(r, `seed ${seed} step ${i}`);
        seen.add(r.og["ok"] === true ? "ok" : String(r.og["error"]).split(":")[0] ?? "");
      }
      expect(wanted.filter((k) => !seen.has(k))).toEqual([]);
      await ls.compareDocs();
    }
  }, 40_000);

  test("MATCH: the receipt og signs verifies against og's tower address", async () => {
    const ls = lockstep();
    const r = await ls.run(appointment({ signedAt: ls.now }));
    const receipt = r.og["receipt"] as never;
    expect(verifyTowerReceiptSignature(receipt, ls.store.signerAddress).ok).toBe(true);
    expect(verifyTowerReceiptSignature({ ...(receipt as Json), sequence: 2 } as never, ls.store.signerAddress).ok).toBe(false);
    expect(verifyTowerReceiptSignature(receipt, owner(0).address).ok).toBe(false);
    await ls.compareDocs();
  });

  test("the rewrite keeps no account-level recovery bundle: og ships only EncryptedRuntimeRecoveryBundleV1", async () => {
    const xln = await import("../xln.ts");
    expect("acceptBundle" in xln || "acceptReceipt" in xln || "acceptAppointment" in xln).toBe(false);
    const probe: TowerAppointmentV1 | undefined = undefined;
    expect(probe).toBeUndefined();
  });
});

describe(seedTag("orderbook-watchtower: entity swap requests (og payments/swap-requests.ts)"), () => {
  const ctx = { ...verifiers, self: ALICE, signerId: aliceAddr };
  const openBob: EntityTx = { type: "openAccount", data: { targetEntityId: BOB, accountDomain: { ...TERMS.domain }, watchSeed: TERMS.watchSeed, disputeConfig: { ...TERMS.disputeConfig } } };
  const signed = () => unwrap(applyEntityInput(unwrap(createEntity({ id: ALICE, jurisdiction: TERMS.domain, threshold: 1n, members: new Map([[aliceAddr, { shares: 1n }]]) })), { kind: "txs", timestamp: NOW, txs: [openBob] }, ctx)).replica;
  // og: the Account a signed command opens proposes its first frame in the Runtime's account work at H+1
  const opened = () => unwrap(applyEntityInput(signed(), { kind: "txs", timestamp: NOW, txs: [] }, { ...ctx, lane: "account-work" })).replica;
  const ogState = (accounts: readonly string[]) => ({ entityId: ALICE, accounts: new Map(accounts.map((a) => [a, { state: {} }])), config: { validators: [aliceAddr] } }) as never;
  /** og AccountTx `{type, data}` (numeric token ids) as the rewrite's flat wire tx. */
  const rwAccountTx = (t: { type: string; data: Record<string, unknown> }): WireAccountTx =>
    ({ type: t.type, ...t.data, ...(typeof t.data["giveTokenId"] === "number" ? { giveTokenId: String(t.data["giveTokenId"]), wantTokenId: String(t.data["wantTokenId"]) } : {}) }) as never;
  /** The entity tx must enqueue exactly og's Account tx: the same verdict and replica as admitting og's tx on the same Account directly. */
  const sameAsOg = (entityTx: EntityTx, ogTx: { type: string; data: Record<string, unknown> }): string => {
    const base = opened(), child = base.accountReplicas.get(BOB);
    if (child === undefined) throw new Error("no account");
    const direct = admitAt(child, [rwAccountTx(ogTx)], ALICE, { timestamp: 0n, jHeight: 0n }, verifiers.verify);
    const via = applyEntityInput(base, { kind: "txs", timestamp: NOW + 1n, txs: [entityTx] }, ctx);
    expect(via.ok).toBe(direct.ok);
    if (direct.ok && via.ok) {
      expect(via.value.replica.accountReplicas.get(BOB)?.mempool).toEqual(direct.value.mempool);
      return "queued";
    }
    if (!direct.ok && !via.ok) expect(via.error).toEqual(direct.error);
    return "refused";
  };
  test("MATCH: placeSwapOffer / proposeCancelSwap build og's exact Account tx for the counterparty Account and wake validators[0]; a missing Account halts", () => {
    const rand = prng(3), verdicts = new Set<string>();
    for (let i = 0; i < 30; i++) {
      const withPrice = rand() < 0.5, withTif = rand() < 0.5, tif = Math.floor(rand() * 3) as 0 | 1 | 2;
      const data = { counterpartyEntityId: BOB, offerId: `o${i}`, giveTokenId: 1, giveTokenDecimals: 18, giveAmount: BigInt(1 + Math.floor(rand() * 1e9)) * 10n ** 15n, wantTokenId: 2, wantTokenDecimals: 18, wantAmount: BigInt(1 + Math.floor(rand() * 1e9)) * 10n ** 15n, maxFee: 0n, minNetReceive: 1n, ...(withPrice ? { priceTicks: 12345n } : {}), ...(withTif ? { timeInForce: tif } : {}) };
      const og = handlePlaceSwapOfferRequest(ogState([BOB]), { type: "placeSwapOffer", data } as never, { mutableFrameState: true } as never);
      expect(og.outputs).toEqual([{ entityId: ALICE, signerId: aliceAddr, entityTxs: [] }]);
      expect(og.accountTxs?.length).toBe(1);
      verdicts.add(sameAsOg({ type: "placeSwapOffer", data: { ...data, giveTokenId: unwrap(tokenId("1")), wantTokenId: unwrap(tokenId("2")) } }, og.accountTxs?.[0]?.tx as never));
      const cancel = handleCancelSwapRequest(ogState([BOB]), { type: "proposeCancelSwap", data: { counterpartyEntityId: BOB, offerId: `o${i}` } } as never, { mutableFrameState: true } as never);
      verdicts.add(sameAsOg({ type: "proposeCancelSwap", data: { counterpartyEntityId: BOB, offerId: `o${i}` } }, cancel.accountTxs?.[0]?.tx as never));
    }
    // og applyAccountEnqueue queues every swap request without validating it (diff/book-admission.test.ts); refusals happen at proposal
    expect([...verdicts]).toEqual(["queued"]);
    expect(() => handlePlaceSwapOfferRequest(ogState([]), { type: "placeSwapOffer", data: { counterpartyEntityId: CAROL } } as never, { mutableFrameState: true } as never)).toThrow("SWAP_REQUEST_ACCOUNT_MISSING");
    expect(() => handleCancelSwapRequest(ogState([]), { type: "proposeCancelSwap", data: { counterpartyEntityId: CAROL, offerId: "x" } } as never, { mutableFrameState: true } as never)).toThrow("SWAP_REQUEST_ACCOUNT_MISSING");
    expect(unwrapErr(applyEntityInput(opened(), { kind: "txs", timestamp: NOW + 1n, txs: [{ type: "proposeCancelSwap", data: { counterpartyEntityId: CAROL, offerId: "x" } }] }, ctx))).toEqual({ _tag: "swap_request_account_missing", target: CAROL });
  }, 30_000);
});

describe(seedTag("orderbook-watchtower: price-page order book (og orderbook/core.ts, commitment.ts)"), () => {
  const owners = ["alice", "bob", "carol", "dave"];
  type Out = { state: any; events: unknown } | null;
  /** One random command stream through og and the rewrite: same events (or the same refusal) and the same book commitment after every step. */
  const stream = (seed: number, steps: number, params: { maxOrders: number; stpPolicy: 0 | 1 }, withOptions: boolean) => {
    const rand = prng(seed), ri = (n: number) => Math.floor(rand() * n);
    let og = ogBook.createBook({ bucketWidthTicks: 1n, ...params });
    let rw = unwrap(createBook({ bucketWidthTicks: 1n, ...params }));
    const kinds = new Set<string>();
    for (let i = 0; i < steps; i++) {
      const live = ogBook.getBookOrders(og), pick = live[ri(Math.max(1, live.length))];
      const suspended = withOptions && ri(4) === 0 ? new Set(live.filter(() => ri(3) === 0).map((o) => o.orderId)) : undefined;
      const cancelSalt = ri(7), multiple = BigInt(1 + ri(3));
      const options = withOptions ? {
        ...(suspended ? { suspendedOrderIds: suspended } : {}),
        ...(ri(3) === 0 ? { makerDisposition: (m: { orderId: string }) => { const h = [...m.orderId].reduce((a, c) => a + c.charCodeAt(0), cancelSalt); return h % 5 === 0 ? "cancel" as const : h % 5 === 1 ? "suspended" as const : "eligible" as const; } } : {}),
        ...(ri(3) === 0 ? { executionPriceTicksForMatch: (maker: bigint, taker: bigint) => (maker + taker) / 2n } : {}),
        ...(ri(3) === 0 ? { executionQtyMultipleAtPrice: () => multiple } : {}),
      } : {};
      const roll = ri(20);
      let ogOut: Out | Error, rwOut: Result<Out, unknown>;
      const run = (f: () => Out): Out | Error => { try { return f(); } catch (e) { return e as Error; } };
      if (roll < 13 || live.length === 0) {
        const cmd = { kind: 0 as const, ownerId: owners[ri(4)] as string, orderId: ri(15) === 0 && pick ? pick.orderId : `o${seed}-${i}`, side: ri(2) as 0 | 1, tif: [0, 0, 0, 1, 2][ri(5)] as 0 | 1 | 2, postOnly: ri(6) === 0, priceTicks: BigInt(ri(25) === 0 ? 0 : 95 + ri(11)), qtyLots: BigInt(ri(30) === 0 ? 0 : 1 + ri(12)) };
        ogOut = run(() => ogBook.applyCommand(og, cmd, options)); rwOut = applyBookCommand(rw, cmd, options); kinds.add("place");
      } else if (roll < 16) {
        const cmd = { kind: 1 as const, ownerId: ri(5) === 0 ? "mallory" : pick?.ownerId ?? "x", orderId: ri(8) === 0 ? "missing" : pick?.orderId ?? "x" };
        ogOut = run(() => ogBook.applyCommand(og, cmd)); rwOut = applyBookCommand(rw, cmd); kinds.add("cancel");
      } else if (roll === 16) {
        const cmd = { kind: 2 as const, ownerId: "alice", orderId: "x", newPriceTicks: null, qtyDeltaLots: 1n };
        ogOut = run(() => ogBook.applyCommand(og, cmd)); rwOut = applyBookCommand(rw, cmd);
      } else if (roll === 17) {
        // a committed remainder may cross the book; the resume pass then settles it
        const o = { orderId: `r${seed}-${i}`, ownerId: owners[ri(4)] as string, side: ri(2) as 0 | 1, priceTicks: BigInt(95 + ri(11)), qtyLots: BigInt(1 + ri(9)) };
        ogOut = run(() => ({ state: ogBook.materializeCommittedRemainder(og, o), events: [] })); rwOut = map(materializeCommittedRemainder(rw, o), (state) => ({ state, events: [] })); kinds.add("remainder");
      } else if (roll === 18) {
        ogOut = run(() => ogBook.resumeCrossedBook(og, options)); rwOut = resumeCrossedBook(rw, options); kinds.add("resume");
      } else if (pick && ri(2) === 0) {
        const next = BigInt(ri(Number(pick.qtyLots) + 1));
        ogOut = run(() => ({ state: ogBook.reduceBookOrderQuantity(og, pick.orderId, next), events: [] })); rwOut = map(reduceBookOrderQuantity(rw, pick.orderId, next), (state) => ({ state, events: [] }));
      } else {
        const price = BigInt(ri(4) === 0 ? 0 : 90 + ri(20));
        ogOut = run(() => ({ state: ogBook.recordAcceptedUsdAskPrice(og, price), events: [] })); rwOut = map(recordAcceptedUsdAskPrice(rw, price), (state) => ({ state, events: [] }));
      }
      if (ogOut instanceof Error) { expect([i, rwOut.ok, ogOut.message]).toEqual([i, false, rwOut.ok ? "" : (rwOut.error as { code: string }).code]); kinds.add("error"); continue; }
      expect([i, rwOut.ok]).toEqual([i, true]);
      if (!rwOut.ok) continue;
      if (ogOut === null || rwOut.value === null) { expect([i, rwOut.value]).toEqual([i, ogOut]); continue; }
      expect([i, rwOut.value.events]).toEqual([i, ogOut.events]);
      og = ogOut.state; rw = rwOut.value.state;
      expect([i, bookCommitmentHash(rw)]).toEqual([i, computeBookCommitmentHash(og)]);
      expect(bookOrders(rw)).toEqual(ogBook.getBookOrders(og));
      for (const side of [0, 1] as const) expect(bookSideLevels(rw, side, 6)).toEqual(ogBook.getBookSideLevels(og, side, 6));
      expect([bestBid(rw), bestAsk(rw)]).toEqual([ogBook.getBestBid(og), ogBook.getBestAsk(og)]);
      expect(unwrap(bookOrdersOutsidePriceRange(rw, 98n, 102n))).toEqual([...ogBook.bookOrdersOutsidePriceRange(og, 98n, 102n)]);
    }
    return kinds;
  };
  test("MATCH: 6 random streams of 400 commands (GTC/IOC/FOK, post-only, STP, dispositions, cancels, remainders, resume, reductions): same events and book commitment", () => {
    const kinds = new Set<string>();
    for (const [seed, params, opts] of [[1, { maxOrders: 1000, stpPolicy: 1 }, false], [2, { maxOrders: 1000, stpPolicy: 0 }, false], [3, { maxOrders: 12, stpPolicy: 1 }, false], [4, { maxOrders: 1000, stpPolicy: 1 }, true], [5, { maxOrders: 1000, stpPolicy: 0 }, true], [6, { maxOrders: 40, stpPolicy: 1 }, true]] as const)
      for (const k of stream(seed, 400, params, opts)) kinds.add(k);
    expect([...kinds].sort()).toEqual(["cancel", "error", "place", "remainder", "resume"]);
  }, 30_000);
  test("MATCH: deep FIFO pages (> 16 orders at one price) and the empty book root", () => {
    const og0 = ogBook.createBook({ bucketWidthTicks: 1n, maxOrders: 500, stpPolicy: 1 });
    expect(bookCommitmentHash(unwrap(createBook({ bucketWidthTicks: 1n, maxOrders: 500, stpPolicy: 1 })))).toBe(computeBookCommitmentHash(og0));
    let og = og0, rw = unwrap(createBook({ bucketWidthTicks: 1n, maxOrders: 500, stpPolicy: 1 }));
    for (let i = 0; i < 70; i++) {
      const cmd = { kind: 0 as const, ownerId: `m${i % 3}`, orderId: `d${i}`, side: 1 as const, tif: 0 as const, postOnly: false, priceTicks: BigInt(100 + (i % 2)), qtyLots: BigInt(1 + (i % 5)) };
      const o = ogBook.applyCommand(og, cmd), r = unwrap(applyBookCommand(rw, cmd));
      og = o.state; rw = r.state;
      expect(bookCommitmentHash(rw)).toBe(computeBookCommitmentHash(og));
    }
    for (const [i, qty] of [[0, 17n], [1, 60n], [2, 3n]] as const) {
      const cmd = { kind: 0 as const, ownerId: "taker", orderId: `t${i}`, side: 0 as const, tif: 1 as const, postOnly: false, priceTicks: 101n, qtyLots: qty };
      const o = ogBook.applyCommand(og, cmd), r = unwrap(applyBookCommand(rw, cmd));
      expect(r.events).toEqual(o.events);
      og = o.state; rw = r.state;
      expect(bookCommitmentHash(rw)).toBe(computeBookCommitmentHash(og));
    }
  });
});
