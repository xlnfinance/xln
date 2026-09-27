import { describe, expect, test } from "bun:test";
import { lcg31, seedOf, seedTag, untilCovered } from "./seed.ts";
import {
  handleLendingBorrowEntityTx, handleLendingClosePositionEntityTx, handleLendingOfferEntityTx, handleLendingRepayEntityTx,
} from "../../core/entity/tx/handlers/payments/lending.ts";
import {
  applyEntityInput, createEntity, isLeft, mapSet, ownWire, retireNetworkOutputs, tokenId, wireOf, zeroDelta,
  type AccountReplica, type EntityId, type EntityTx, type OpenEntity, type WireAccountTx,
} from "../xln.ts";
import { ALICE, BOB, CAROL, NOW, TERMS, aliceAddr, unwrap, verifiers } from "../xln_run.ts";

// seeded rng for randomized comparisons
let seed = seedOf(11);
const rng = (): number => { seed = lcg31(seed); return seed / 0x7fffffff; };
const ri = (n: number): number => Math.floor(rng() * n);
const pick = <T>(xs: readonly T[]): T => xs[ri(xs.length)] as T;
const hex16 = (): string => Array.from({ length: 16 }, () => "0123456789abcdef"[ri(16)]).join("");

const T1 = unwrap(tokenId("1")), T2 = unwrap(tokenId("2"));
const openTo = (target: EntityId): EntityTx =>
  ({ type: "openAccount", data: { targetEntityId: target, accountDomain: { ...TERMS.domain }, watchSeed: TERMS.watchSeed, disputeConfig: { ...TERMS.disputeConfig } } }) as EntityTx;

/** A 1-of-1 ALICE with a committed Account to BOB whose token 1 row is funded on ALICE's side. */
const fundedHubAccount = (): OpenEntity => {
  const created = unwrap(createEntity({ id: ALICE, jurisdiction: TERMS.domain, threshold: 1n, members: new Map([[aliceAddr, { shares: 1n }]]) }));
  const signed = unwrap(applyEntityInput(created, { kind: "txs", timestamp: NOW, txs: [openTo(BOB)] }, { ...verifiers, self: ALICE, signerId: aliceAddr })).replica;
  // og: the Account a signed command opens proposes its first frame in the Runtime's account work at H+1
  const opened = unwrap(applyEntityInput(signed, { kind: "txs", timestamp: NOW, txs: [] }, { ...verifiers, self: ALICE, signerId: aliceAddr, lane: "account-work" })).replica;
  if (opened._tag !== "open") throw new Error(opened._tag);
  const child = opened.accountReplicas.get(BOB);
  if (child === undefined) throw new Error("no account");
  const left = isLeft(ALICE, { left: ALICE < BOB ? ALICE : BOB, right: ALICE < BOB ? BOB : ALICE } as never);
  const row = { ...zeroDelta(T1), collateral: 1_000_000n, ondelta: left ? 1_000_000n : 0n };
  const account = { ...child.state.account, deltas: new Map([[T1, row]]) };
  const funded = { ...child, mempool: [], state: { ...child.state, account } } as AccountReplica;
  return { ...opened, accountReplicas: mapSet(opened.accountReplicas, BOB, funded), state: { ...opened.state, accounts: mapSet(opened.state.accounts, BOB, account) } };
};

type Og = { readonly ok: true; readonly accountTx: unknown; readonly accountId: string; readonly outputs: unknown } | { readonly ok: false; readonly code: string };
const runOg = (tx: { readonly type: string; readonly data: Record<string, unknown> }): Og => {
  const ogState = { entityId: ALICE, config: { validators: [aliceAddr] }, accounts: new Map([[BOB.toLowerCase(), { state: { deltas: new Map([[1, {}]]) } }]]) };
  const ogTx = { type: tx.type, data: { ...tx.data, ...("tokenId" in tx.data ? { tokenId: Number(tx.data["tokenId"]) } : {}) } };
  const handler = { lendingOffer: handleLendingOfferEntityTx, lendingBorrow: handleLendingBorrowEntityTx, lendingRepay: handleLendingRepayEntityTx, lendingClosePosition: handleLendingClosePositionEntityTx }[tx.type];
  if (handler === undefined) throw new Error(tx.type);
  try {
    const out = (handler as (s: unknown, t: unknown, m: boolean) => { outputs: unknown; accountTxs: { accountId: string; tx: unknown }[] })(ogState, ogTx, true);
    const [queued] = out.accountTxs;
    if (queued === undefined) throw new Error("og queued nothing");
    return { ok: true, accountTx: queued.tx, accountId: queued.accountId, outputs: out.outputs };
  } catch (e) {
    return { ok: false, code: String((e as Error).message).split(/[:\s]/)[0] ?? "" };
  }
};
let hubAccount: OpenEntity | undefined;
const runRewrite = (tx: EntityTx) => applyEntityInput((hubAccount ??= fundedHubAccount()), { kind: "txs", timestamp: NOW + 1n, txs: [tx] }, { ...verifiers, self: ALICE, signerId: aliceAddr });

describe(seedTag("runtime-2: entity lending (ER-17, og payments/lending.ts)"), () => {
  const randomTx = (): EntityTx => {
    const hub = pick<string>([BOB, BOB, BOB, BOB.toUpperCase().replace("0X", "0x"), ` ${BOB} `, CAROL, ""]);
    const id = (prefix: string): string => pick([`${prefix}-${hex16()}`, `${prefix}-${hex16()}`, `${prefix}-${hex16().toUpperCase()}`, `${prefix}-${hex16().slice(1)}`, `lend-${hex16()}`, `loan-${hex16()}`, "x"]);
    const amount = pick([0n, -1n, 1n, 5n, 1000n]);
    const termId = pick(["1h", "1d", "1m", "1y", ""]);
    const bps = pick([0, 1, 99, 10_000, 10_001, -1, 2.5]);
    const tk = pick([T1, T1, T1, T2]);
    const kind = ri(4);
    if (kind === 0) return { type: "lendingOffer", data: { positionId: id("lend"), hubEntityId: hub, tokenId: tk, amount, termId, interestBps: bps } };
    if (kind === 1) return { type: "lendingBorrow", data: { requestId: id("borrow"), hubEntityId: hub, tokenId: tk, amount, termId, ...(rng() < 0.3 ? {} : { maxInterestBps: bps }) } };
    if (kind === 2) return { type: "lendingRepay", data: { hubEntityId: hub, loanId: id("loan"), tokenId: tk, amount } };
    return { type: "lendingClosePosition", data: { hubEntityId: hub, positionId: id("lend") } };
  };

  test("MATCH: 400 random lendingOffer/Borrow/Repay/ClosePosition -- same accept/refuse code as og, same queued Account tx on the hub Account, same wake to validators[0]", () => {
    let accepted = 0, refused = 0;
    for (let i = 0; i < 400; i++) {
      const tx = randomTx(), og = runOg(tx), rw = runRewrite(tx);
      if (!og.ok) {
        // og throws a plain Error: the whole input is refused (not an evict-and-retry reject disposition).
        expect(rw.ok).toBe(false);
        if (!rw.ok) expect(rw.error._tag === "lending_entity" ? rw.error.reason : rw.error._tag).toBe(og.code);
        refused++;
        continue;
      }
      // og local admission (local-tx-admission.ts) queues without applying, and so does the rewrite's admitAt: a repay without capacity is queued here too
      if (!rw.ok) throw new Error(`rewrite refused an og-accepted lending tx: ${JSON.stringify(rw.error)}`);
      const hub = rw.value.replica.accountReplicas.get(BOB);
      const queued = hub?.mempool.at(-1);
      expect(og.accountId).toBe(BOB.toLowerCase());
      expect(queued === undefined ? undefined : ownWire(wireOf(queued as WireAccountTx))).toEqual(og.accountTx as never);
      expect(rw.value.outputs).toEqual([{ to: ALICE, signerId: aliceAddr, input: { kind: "txs", timestamp: NOW + 1n, txs: [] } }]);
      expect(og.outputs).toEqual([{ entityId: ALICE, signerId: aliceAddr, entityTxs: [] }]);
      accepted++;
    }
    expect(accepted).toBeGreaterThan(20);
    expect(refused).toBeGreaterThan(100);
  }, 30_000);

  test("MATCH: a lendingOffer for a token the hub Account has not enabled is og LENDING_TOKEN_NOT_ENABLED; the missing hub is LENDING_HUB_ACCOUNT_MISSING", () => {
    const offer = (patch: Record<string, unknown>): EntityTx => ({ type: "lendingOffer", data: { positionId: `lend-${"a".repeat(16)}`, hubEntityId: BOB, tokenId: T1, amount: 5n, termId: "1d", interestBps: 50, ...patch } }) as EntityTx;
    for (const [patch, code] of [[{ tokenId: T2 }, "LENDING_TOKEN_NOT_ENABLED"], [{ hubEntityId: CAROL }, "LENDING_HUB_ACCOUNT_MISSING"], [{ interestBps: 10_001 }, "LENDING_INVALID_INTEREST_BPS"]] as const) {
      const og = runOg(offer(patch)), rw = runRewrite(offer(patch));
      expect(og).toEqual({ ok: false, code });
      expect(rw.ok ? "accepted" : rw.error._tag === "lending_entity" ? rw.error.reason : rw.error._tag).toBe(code);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------
// og RuntimeInput / RuntimeTx, merge, and the Runtime WAL commitments (og core/runtime + core/storage), each run against live og.
// ---------------------------------------------------------------------------------------------------------------------------------------
import { assertRuntimeTxCapabilitiesAuthorized } from "../../core/runtime/tx/internal-tx-auth.ts";
import { createCheckpointBarrierRuntimeTx } from "../../core/runtime/checkpoint/barrier.ts";
import { markLocalRuntimeAdapterCommandTx } from "../../core/runtime/command/frontier-auth.ts";
import { applyRuntimeAdapterCommandMarker } from "../../core/runtime/command/frontier.ts";
import { mergeEntityInputs as ogMergeEntityInputs } from "../../core/entity/consensus/input/merge.ts";
import { computeRuntimePostStateComponentDigests, computeStorageFrameHash, computeStoragePostStateHash } from "../../core/storage/hashes.ts";
import { computeCanonicalRuntimeStateHash } from "../../core/storage/canonical-hash.ts";
import { computeStorageReplicaMetaDigest } from "../../core/storage/replica/replica-meta-digest.ts";
import { prepareRuntimeOutputRows } from "../../core/storage/wal/outbox-payload.ts";
import { encodeBuffer } from "../../core/storage/codec/codec.ts";
import { encodeBoard, hashBoard } from "../../core/entity/factory.ts";
import { deriveEntityEncryptionPrivateKey } from "../../core/runtime/registration/entity-creation/crypto.ts";
import { deriveEntityEncryptionPublicKey } from "../../core/entity/auth/crypto.ts";
import {
  applyRuntime, applyRuntimeTx, canonicalRuntimeStateHash, commitRuntimeFrame, createRuntime, entityEncryptionPublicKey, lazyBoardEntityId,
  mergeEntityInputs, recoverRuntime, replicaKey, replicaMetaDigest, runtimeComponentDigests, runtimeOutputsDigest, runtimeTxAuthorized,
  storageFrameHash, storagePostStateHash, ZERO_FRAME_HASH,
  type Binary, type EntityFrame, type EntityFrameHash, type ImportConfig, type RoutedEntityInput, type Runtime, type RuntimeTx, type Signature,
  type StorageFrame,
} from "../xln.ts";
import { bobAddr, carolAddr } from "../xln_run.ts";

const ogThrowCode = (f: () => unknown): string | null => { try { f(); return null; } catch (e) { return String((e as Error).message).split(":")[0] ?? ""; } };
const rwCode = (r: { readonly ok: boolean; readonly error?: unknown }): string | null => {
  if (r.ok) return null;
  const e = r.error as { _tag: string; code?: string; reason?: string };
  return String(e.code ?? e.reason ?? e._tag).split(":")[0] ?? "";
};
const hex = (bytes: number): string => `0x${Array.from({ length: bytes * 2 }, () => "0123456789abcdef"[ri(16)]).join("")}`;

const ALL_RUNTIME_TX_TYPES: readonly RuntimeTx["type"][] = [
  "checkpointBarrier", "recordRuntimeAdapterCommand", "recordNumberedRegistrationIntent", "resolveNumberedRegistrationIntent", "recordAuthenticatedJAuthority",
  "importReplica", "observeJRange", "advanceJWatcherCursor", "rewindJHistory", "retryJSubmit", "recordJSubmitResult", "retryEntityProviderAction",
  "recordEntityProviderActionSubmitResult", "recordGovernanceJSubmitResult", "importJ", "completeImportJ",
];

describe(seedTag("runtime-2: og RuntimeTx capability authorization (og runtime/tx/internal-tx-auth.ts)"), () => {
  test("MATCH: every og RuntimeTx kind -- external ingress refused with og's code, replay admitted, importReplica/importJ unguarded", () => {
    for (const type of ALL_RUNTIME_TX_TYPES) {
      const tx = { type, data: {} } as unknown as RuntimeTx;
      expect(rwCode(runtimeTxAuthorized(tx, {}))).toBe(ogThrowCode(() => assertRuntimeTxCapabilitiesAuthorized(tx as never, false)));
      expect(rwCode(runtimeTxAuthorized(tx, { replay: true }))).toBe(ogThrowCode(() => assertRuntimeTxCapabilitiesAuthorized(tx as never, true)));
    }
  });

  test("MATCH: a locally created checkpoint barrier / adapter-command marker is admitted; a structurally equal copy from ingress is not", () => {
    const barrier = createCheckpointBarrierRuntimeTx() as unknown as RuntimeTx;
    const command = markLocalRuntimeAdapterCommandTx({ type: "recordRuntimeAdapterCommand", data: { laneId: hex(32), sequence: 1, commandId: "cmd-0123456789abcdef", inputHash: hex(32), expiresAtMs: null } }) as unknown as RuntimeTx;
    for (const tx of [barrier, command]) {
      const copy = JSON.parse(JSON.stringify(tx)) as RuntimeTx;
      expect(ogThrowCode(() => assertRuntimeTxCapabilitiesAuthorized(tx as never))).toBeNull();
      expect(rwCode(runtimeTxAuthorized(tx, { local: new Set([tx]) }))).toBeNull();
      const ogCopy = ogThrowCode(() => assertRuntimeTxCapabilitiesAuthorized(copy as never));
      expect(ogCopy).not.toBeNull();
      expect(rwCode(runtimeTxAuthorized(copy, { local: new Set([tx]) }))).toBe(ogCopy);
    }
  });

  test("MATCH (og validateRuntimeInputShapeAndLimits): a checkpoint barrier must stand alone in its Runtime input", () => {
    const barrier = createCheckpointBarrierRuntimeTx() as unknown as RuntimeTx;
    const local = { ...verifiers, local: new Set([barrier]) };
    const alone = unwrap(applyRuntime(createRuntime(), { runtimeTxs: [barrier], entityInputs: [] }, local));
    expect(alone.runtime.height).toBe(1n);
    expect(alone.advanced).toBe(true);
    expect(rwCode(applyRuntime(createRuntime(), { runtimeTxs: [barrier, barrier], entityInputs: [] }, local))).toBe("CHECKPOINT_BARRIER_NOT_ALONE");
    // og advanceAppliedRuntimeFrame: an input with no work leaves the height alone.
    expect(unwrap(applyRuntime(createRuntime(), { runtimeTxs: [], entityInputs: [] }, verifiers)).runtime.height).toBe(0n);
  });
});

describe(seedTag("runtime-2: recordRuntimeAdapterCommand frontier (og runtime/command/frontier.ts)"), () => {
  test("MATCH: 600 random adapter-command markers -- same accept/refuse code and same frontier map as og applyRuntimeAdapterCommandMarker", () => {
    const lanes = [hex(32), hex(32), hex(32)];
    let rt: Runtime = createRuntime();
    let ogFrontiers = new Map<string, unknown>();
    let accepted = 0;
    for (let i = 0; i < 600; i++) {
      const timestamp = Number(rt.timestamp) + ri(40), height = Number(rt.height) + ri(2);
      const data = {
        laneId: pick([...lanes, ...lanes, (lanes[0] ?? "").toUpperCase().replace("0X", "0x"), "0x12", ""]),
        sequence: pick([1, 1, 2, 3, 0, -1, 1.5]) + (rng() < 0.5 ? 0 : ri(3)),
        commandId: pick(["cmd-0123456789abcdef", "cmd:ABC.def_0123456789", "short", " cmd-0123456789abcdef "]),
        inputHash: pick([hex(32), hex(32), "0xnothex"]),
        expiresAtMs: pick([null, null, timestamp + ri(80), 0, -5]),
      };
      const at: Runtime = { ...rt, timestamp: BigInt(timestamp), height: BigInt(height) };
      const env = { state: { timestamp, height }, infrastructure: { runtimeAdapterCommandFrontiers: new Map(ogFrontiers) } };
      const og = ogThrowCode(() => applyRuntimeAdapterCommandMarker(env as never, data as never));
      const rw = applyRuntimeTx(at, { type: "recordRuntimeAdapterCommand", data }, { replay: true });
      expect(rwCode(rw)).toBe(og);
      if (rw.ok) {
        // og throws out of the Runtime frame, so a refused marker changes nothing; an admitted one commits og's pruned map.
        ogFrontiers = env.infrastructure.runtimeAdapterCommandFrontiers;
        expect(Object.fromEntries(rw.value.adapterFrontiers)).toEqual(Object.fromEntries(ogFrontiers) as never);
        rt = rw.value;
        accepted++;
      } else rt = at;
    }
    expect(accepted).toBeGreaterThan(10);
  });
});

describe(seedTag("runtime-2: mergeEntityInputs (og entity/consensus/input/merge.ts)"), () => {
  const ENTITIES = [ALICE, BOB] as const, SIGNERS = [aliceAddr, bobAddr] as const;
  const ORIGINS = [undefined, undefined, "0x" + "77".repeat(20), "0x" + "88".repeat(20)] as const;
  const frames = new Map<string, EntityFrame>();
  const frameOf = (height: number, variant: number): EntityFrame => {
    const key = `${height}:${variant}`, held = frames.get(key);
    if (held !== undefined) return held;
    const frame = { height: BigInt(height), prevFrameHash: ZERO_FRAME_HASH, timestamp: BigInt(variant), txs: [], events: [], stateRoot: hex(32), authorityRoot: hex(32), entityContext: { entityId: ALICE }, hashesToSign: [] } as unknown as EntityFrame;
    frames.set(key, frame);
    return frame;
  };
  const credit = (n: number): EntityTx => ({ type: "extendCredit", data: { counterpartyEntityId: CAROL, tokenId: T1, amount: BigInt(n) } });
  const sig = (s: string): Signature => s as Signature;
  type Gen = { readonly rw: RoutedEntityInput; readonly og: Record<string, unknown> };
  const randomInput = (): Gen => {
    const entityId = pick(ENTITIES), signerId = pick(SIGNERS), from = pick(ORIGINS), kind = ri(10);
    const base = { entityId, signerId, ...(from === undefined ? {} : { from }) };
    if (kind < 5) {
      const txs = rng() < 0.15 ? [] : Array.from({ length: 1 + ri(2) }, () => credit(ri(3)));
      return { rw: { ...base, input: { kind: "txs", timestamp: NOW, txs } }, og: { ...base, entityTxs: txs } };
    }
    if (kind < 8) {
      const height = 1 + ri(2), frameHash = pick(["0x" + "aa".repeat(32), "0x" + "bb".repeat(32)]) as EntityFrameHash;
      const signatures = new Map<string, readonly Signature[]>(Array.from({ length: 1 + ri(2) }, () => {
        const who = pick<string>([aliceAddr, bobAddr, carolAddr, aliceAddr.toUpperCase().replace("0X", "0x")]);
        return [who, [sig(pick(["0xs1", "0xs1", "0xs2"]))]] as const;
      }));
      return { rw: { ...base, input: { kind: "precommit", height: BigInt(height), frameHash, signatures } }, og: { ...base, hashPrecommits: new Map([...signatures].map(([k, v]) => [k, [...v]])), hashPrecommitFrame: { height, frameHash } } };
    }
    const height = 1 + ri(2), variant = ri(2), frame = frameOf(height, variant);
    return { rw: { ...base, input: { kind: "proposal", frame, signatures: new Map() } }, og: { ...base, proposedFrame: { hash: `frame-${height}-${variant}`, height } } };
  };
  const summaryRw = (i: RoutedEntityInput): unknown => ({
    e: i.entityId.toLowerCase(), s: i.signerId.toLowerCase(), from: i.from ?? "",
    body: i.input.kind === "proposal" ? `frame-${i.input.frame.height}-${Number(i.input.frame.timestamp)}`
      : i.input.kind === "precommit" ? [...i.input.signatures].map(([k, v]) => [k, [...v]])
      : i.input.kind === "txs" ? i.input.txs.map((tx) => (tx.type === "extendCredit" ? Number(tx.data.amount) : -1))
      : `unexpected ${i.input.kind} input`,
  });
  const summaryOg = (i: Record<string, unknown>): unknown => {
    const pre = i["hashPrecommits"] as Map<string, string[]> | undefined, frame = i["proposedFrame"] as { hash: string } | undefined;
    return {
      e: String(i["entityId"]).toLowerCase(), s: String(i["signerId"]).toLowerCase(), from: i["from"] ?? "",
      body: frame !== undefined ? frame.hash : pre !== undefined && pre.size > 0 ? [...pre]
        : ((i["entityTxs"] as EntityTx[] | undefined) ?? []).map((tx) => (tx.type === "extendCredit" ? Number(tx.data.amount) : -1)),
    };
  };

  test("MATCH: 500 random batches of txs / precommit / proposal lanes -- same merged lanes in the same order, same equivocation refusals as og", () => {
    let merges = 0, refusals = 0, conflicts = 0;
    for (let i = 0, more = untilCovered(500, () => merges > 50 && refusals > 5 && conflicts > 5); more(i); i++) {
      const gens = Array.from({ length: 1 + ri(7) }, randomInput);
      let ogOut: Record<string, unknown>[] | undefined;
      const ogErr = ogThrowCode(() => { ogOut = ogMergeEntityInputs(gens.map((g) => g.og) as never) as never; });
      const rw = mergeEntityInputs(gens.map((g) => g.rw));
      expect(rwCode(rw)).toBe(ogErr);
      if (!rw.ok || ogOut === undefined) { refusals++; continue; }
      expect(rw.value.map(summaryRw)).toEqual(ogOut.map(summaryOg));
      if (rw.value.length < gens.length) merges++;
      if (new Set(rw.value.map((x) => `${x.entityId}:${x.signerId}:${x.from ?? ""}:${x.input.kind}`)).size < rw.value.length) conflicts++;
    }
    expect(merges).toBeGreaterThan(50);
    expect(refusals).toBeGreaterThan(5);
    expect(conflicts).toBeGreaterThan(5);
  });
});

describe(seedTag("runtime-2: Runtime WAL commitments (og storage/hashes.ts, canonical-hash.ts, replica-meta-digest.ts, wal/outbox-payload.ts)"), () => {
  const entityHashes = () => Array.from({ length: ri(4) }, () => ({ entityId: pick([hex(32), hex(32).toUpperCase().replace("0X", "0x")]), hash: hex(32), cellCount: 1 + ri(3) }));
  const randomBinary = (depth = 0): Binary => {
    const k = ri(depth > 2 ? 4 : 7);
    if (k === 0) return BigInt(ri(1_000_000)) * (rng() < 0.3 ? -1n : 1n);
    if (k === 1) return pick(["", "a", hex(4), "xln"]);
    if (k === 2) return pick<Binary>([true, false, null, 0, 7, 1 << 20]);
    if (k === 3) return pick([hex(16), hex(20), hex(32), "0x"]); // og hex-string extension; the rewrite Binary carries no raw byte arrays
    if (k === 4) return Array.from({ length: ri(4) }, () => randomBinary(depth + 1));
    if (k === 5) return new Map(Array.from({ length: ri(3) }, () => [pick(["k", "z", "a", hex(2)]), randomBinary(depth + 1)] as [Binary, Binary]));
    return Object.fromEntries(Array.from({ length: ri(4) }, () => [pick(["b", "a", "zz", "kind", "m"]), randomBinary(depth + 1)]));
  };

  test("MATCH: 300 random canonical Runtime state hashes equal og computeCanonicalRuntimeStateHash", () => {
    for (let i = 0; i < 300; i++) {
      const height = ri(1000), timestamp = 1_700_000_000_000 + ri(1_000_000), rows = entityHashes();
      expect(canonicalRuntimeStateHash(height, timestamp, rows)).toBe(computeCanonicalRuntimeStateHash(height, timestamp, rows));
    }
  });

  test("MATCH: 300 random component views / post-state oracles / replica-meta digests / output digests equal og", () => {
    for (let i = 0; i < 300; i++) {
      const view = Object.fromEntries(Array.from({ length: ri(4) }, () => [pick(["infrastructure", "jReplicas", "gossip", "zeta"]), randomBinary()]));
      const components = unwrap(runtimeComponentDigests(view));
      expect(components).toEqual(computeRuntimePostStateComponentDigests(view));
      const meta = Array.from({ length: ri(4) }, () => ({ key: Uint8Array.from({ length: 1 + ri(8) }, () => ri(256)), value: Uint8Array.from({ length: ri(8) }, () => ri(256)) }));
      const metaDigest = unwrap(replicaMetaDigest(meta));
      expect(metaDigest).toBe(computeStorageReplicaMetaDigest(meta));
      const outputs = Array.from({ length: ri(4) }, () => ({ entityId: hex(32), signerId: hex(20), entityTxs: [randomBinary()] }));
      const og = prepareRuntimeOutputRows(ri(100), outputs as never).commitment;
      const digest = unwrap(runtimeOutputsDigest(outputs.map((o) => encodeBuffer(o, { omitSymbolKeys: true }))));
      expect(digest).toBe(og.digest as string);
      const input = { height: ri(100), timestamp: ri(1_000_000), replicaMetaDigest: metaDigest, runtimeComponentDigests: components, runtimeOutputCount: og.count, runtimeOutputsDigest: digest };
      expect(unwrap(storagePostStateHash(input))).toBe(computeStoragePostStateHash(input));
    }
  });

  test("MATCH: 300 random WAL rows -- storageFrameHash equals og computeStorageFrameHash (frameHash excluded, Entity hashes normalized and sorted)", () => {
    for (let i = 0; i < 300; i++) {
      const frame: StorageFrame = {
        height: 1 + ri(100), timestamp: ri(1_000_000), prevFrameHash: pick([ZERO_FRAME_HASH, hex(32)]), frameHash: pick([undefined, hex(32)]),
        replicaMetaDigest: hex(32), postStateHash: hex(32), materializedState: rng() < 0.5,
        canonicalStateHash: pick([undefined, hex(32)]), canonicalEntityHashes: pick([undefined, entityHashes()]),
        runtimeInput: randomBinary(), runtimeOutputCount: ri(5), runtimeOutputsDigest: hex(32),
        touchedEntities: [hex(32)], touchedAccounts: [], touchedBookEntities: [],
      };
      const clean = Object.fromEntries(Object.entries(frame).filter(([, v]) => v !== undefined));
      expect(unwrap(storageFrameHash(frame))).toBe(computeStorageFrameHash(clean as never));
    }
  });
});

const JUR_NAME = "local";
const importConfigOf = (validators: readonly string[], shares: Record<string, bigint>, threshold: bigint): ImportConfig => ({
  mode: "proposer-based", threshold, validators, shares,
  jurisdiction: { name: JUR_NAME, chainId: TERMS.domain.chainId, depositoryAddress: TERMS.domain.depositoryAddress, entityProviderAddress: "0x" + "e1".repeat(20) },
});
const SEED = "0x" + "5e".repeat(64);
/** secp256k1 generator G (private key 1), compressed: og resolveValidatorAddress derives its address. */
const COMPRESSED = "0x0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";

describe(seedTag("runtime-2: importReplica board authority (og runtime/tx/tx-handlers.ts importReplicaRuntimeTx)"), () => {
  test("MATCH: 600 random boards -- lazyBoardEntityId equals og hashBoard(encodeBoard(config)) and refuses exactly when og throws", () => {
    let accepted = 0;
    for (let i = 0; i < 600; i++) {
      const pool = [aliceAddr, aliceAddr, bobAddr, carolAddr, hex(32), "not-an-address", COMPRESSED, aliceAddr.toLowerCase(), "0x" + [...aliceAddr.slice(2)].map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())).join("")];
      const validators = Array.from({ length: 1 + ri(3) }, () => pick<string>(pool));
      const shares = Object.fromEntries(validators.filter(() => rng() < 0.95).map((v) => [pick([v, v, v, v.toUpperCase().replace("0X", "0x")]), pick([1n, 1n, 2n, 0n, 70_000n])]));
      const config = importConfigOf(validators, shares, pick([1n, 1n, 2n, 3n, 0n, 70_000n]));
      let og: string | undefined;
      const ogErr = ogThrowCode(() => { og = hashBoard(encodeBoard(config as never)); });
      const rw = lazyBoardEntityId(config);
      expect(rw.ok).toBe(ogErr === null);
      if (rw.ok) { expect(rw.value).toBe(og ?? ""); accepted++; }
    }
    expect(accepted).toBeGreaterThan(20);
  });

  test("MATCH: the Entity encryption public key is og X25519(HKDF-SHA256(seed, entityId, 'xln:entity-encryption:v1'))", () => {
    for (let i = 0; i < 30; i++) {
      const seed = hex(64), entity = hex(32);
      const priv = deriveEntityEncryptionPrivateKey(Uint8Array.from(Buffer.from(seed.slice(2), "hex")), entity);
      expect(entityEncryptionPublicKey(seed, entity)).toBe(deriveEntityEncryptionPublicKey(priv, entity));
    }
  });

  test("MATCH (og importReplica order): identity, jurisdiction, board membership, proposer flag, lazy id, seed, then genesis replica", () => {
    const rt = createRuntime([JUR_NAME]);
    const config = importConfigOf([aliceAddr, bobAddr], { [aliceAddr]: 1n, [bobAddr]: 1n }, 2n);
    const id = unwrap(lazyBoardEntityId(config));
    const tx = (patch: Partial<{ entityId: string; signerId: string; isProposer: boolean; entitySeed: string }>): RuntimeTx =>
      ({ type: "importReplica", entityId: patch.entityId ?? id, signerId: patch.signerId ?? aliceAddr, data: { config, isProposer: patch.isProposer ?? true, entitySeed: patch.entitySeed ?? SEED } });
    const code = (t: RuntimeTx, at: Runtime = rt): string | null => rwCode(applyRuntimeTx(at, t, {}));
    expect(code(tx({ entityId: "" }))).toBe("IMPORT_REPLICA_INVALID_ID");
    // og requireRuntimeJurisdictionConfigByName: no J replica of that name (runtime-j.test.ts runs this against og).
    expect(code(tx({}), createRuntime())).toBe("ENTITY_JURISDICTION_UNAVAILABLE");
    expect(code(tx({ signerId: carolAddr }))).toBe("IMPORT_REPLICA_SIGNER_NOT_ON_BOARD");
    expect(code(tx({ isProposer: false }))).toBe("IMPORT_REPLICA_PROPOSER_FLAG_INVALID");
    expect(code(tx({ signerId: bobAddr }))).toBe("IMPORT_REPLICA_PROPOSER_FLAG_INVALID");
    expect(code(tx({ entityId: "0x" + "00".repeat(31) + "07" }))).toBe("NUMBERED_REPLICA_REGISTRATION_EVIDENCE_MISSING");
    expect(code(tx({ entityId: hex(32) }))).toBe("IMPORT_REPLICA_LAZY_BOARD_ID_MISMATCH");
    expect(code(tx({ entitySeed: "0x1234" }))).toBe("IMPORT_REPLICA_ENTITY_SEED_INVALID");
    const imported = unwrap(applyRuntimeTx(rt, tx({}), {}));
    const replica = imported.entities.get(replicaKey(id as EntityId, aliceAddr));
    expect(replica?.state.committed["entityEncryptionPublicKey"]).toBe(entityEncryptionPublicKey(SEED, id));
    expect(imported.encryptionSeeds.get(id.toLowerCase())).toBe(SEED);
    // A sibling validator replica with another seed derives another key: og IMPORT_REPLICA_ENTITY_ENCRYPTION_PUBLIC_KEY_MISMATCH.
    expect(code(tx({ signerId: bobAddr, isProposer: false, entitySeed: "0x" + "6f".repeat(64) }), imported)).toBe("IMPORT_REPLICA_ENTITY_ENCRYPTION_PUBLIC_KEY_MISMATCH");
    expect(code(tx({ signerId: bobAddr, isProposer: false }), imported)).toBeNull();
  });
});

describe(seedTag("runtime-2: WAL frame commit and recover (og storage write + read/verify.ts + replay)"), () => {
  test("MATCH: a committed WAL row chains from og ZERO_FRAME_HASH and its frameHash / canonicalStateHash recompute under og's functions; tampering is refused", () => {
    // og resolveEntityProposerId: BOB has no local replica and no certified Account route yet, so its verified gossip profile names the signer
    // og retains a remote output only once its Runtime resolves (og resolveRuntimeIdForEntity), else ROUTE_TARGET_RUNTIME_UNKNOWN
    const BOB_RT = "0x" + "b0".repeat(20);
    const ctx = { ...verifiers, routes: { verifiedProfileSigner: (e: string) => (e === BOB.toLowerCase() ? bobAddr.toLowerCase() : undefined), resolvedRuntime: (e: string) => (e === BOB.toLowerCase() ? BOB_RT : undefined) } };
    const config = importConfigOf([aliceAddr], { [aliceAddr]: 1n }, 1n);
    const id = unwrap(lazyBoardEntityId(config)) as EntityId;
    const importTx: RuntimeTx = { type: "importReplica", entityId: id, signerId: aliceAddr, data: { config, isProposer: true, entitySeed: SEED } };
    const start = createRuntime([JUR_NAME]);
    const first = unwrap(commitRuntimeFrame(start, { runtimeTxs: [importTx], entityInputs: [], timestamp: NOW }, ctx));
    if (first === null) throw new Error("no frame");
    expect(first.frame.prevFrameHash).toBe(ZERO_FRAME_HASH);
    expect(first.frame.height).toBe(1);
    const { frameHash, ...rest } = first.frame;
    expect(computeStorageFrameHash(rest as never)).toBe(frameHash ?? "");
    expect(computeCanonicalRuntimeStateHash(first.frame.height, first.frame.timestamp, (first.frame.canonicalEntityHashes ?? []) as never)).toBe(first.frame.canonicalStateHash ?? "");
    // A frame that did no work writes no row (og advanceAppliedRuntimeFrame).
    expect(unwrap(commitRuntimeFrame(first.runtime, { runtimeTxs: [], entityInputs: [] }, ctx))).toBeNull();
    const second = unwrap(commitRuntimeFrame(first.runtime, { runtimeTxs: [], entityInputs: [{ entityId: id, signerId: aliceAddr, input: { kind: "txs", timestamp: NOW + 1n, txs: [openTo(BOB)] } }] }, ctx));
    if (second === null) throw new Error("no frame");
    // og SIGNER_RESOLUTION_FAILED: no local replica, no certified route, no gossip profile
    expect(String(rwCode(commitRuntimeFrame(first.runtime, { runtimeTxs: [], entityInputs: [{ entityId: id, signerId: aliceAddr, input: { kind: "txs", timestamp: NOW + 1n, txs: [openTo(BOB)] } }] }, verifiers)))).toStartWith("SIGNER_RESOLUTION_FAILED");
    expect(second.frame.prevFrameHash).toBe(frameHash ?? "");
    expect(rwCode(commitRuntimeFrame(first.runtime, { runtimeTxs: [], entityInputs: [{ entityId: id, signerId: aliceAddr, input: { kind: "txs", timestamp: NOW + 1n, txs: [openTo(BOB)] } }] }, { ...verifiers, routes: { verifiedProfileSigner: ctx.routes.verifiedProfileSigner } }))).toStartWith("ROUTE_TARGET_RUNTIME_UNKNOWN");
    // og commits only the retained network outbox: the remote proposal to BOB, bound to BOB's Runtime and stamped with its source frame
    expect(first.runtimeOutputs).toEqual([]);
    expect(second.runtimeOutputs.map((o) => [o["entityId"], o["runtimeId"], o["sourceRuntimeFrame"]])).toEqual([[BOB, BOB_RT, { height: 2, timestamp: Number(NOW + 1n) }]]);
    expect(second.frame.runtimeOutputCount).toBe(1);

    const frames = [first.frame, second.frame], inputs = [first.applied, second.applied], outbox = [...first.outbox, ...second.outbox];
    expect(unwrap(recoverRuntime(start, frames, inputs, outbox, ctx)).runtime.frameHash).toBe(second.frame.frameHash ?? "");
    // with og's per-frame rows, replay binds the recorded Runtime routes instead of live routing
    expect(unwrap(recoverRuntime(start, frames, inputs, outbox, { ...verifiers }, [first.runtimeOutputs, second.runtimeOutputs])).runtime.pendingNetworkOutputs).toEqual(second.runtimeOutputs);
    // A transport accepts the proposal between frames (og dispatchEntityOutputs retirement): the next frame commits without it, and only replay
    // seeded from the recorded rows (og selectRetainedRecoveryOutbox) reproduces that frame.
    const carolConfig = importConfigOf([carolAddr], { [carolAddr]: 1n }, 1n), carolId = unwrap(lazyBoardEntityId(carolConfig)) as EntityId;
    const third = unwrap(commitRuntimeFrame(retireNetworkOutputs(second.runtime, () => true), { runtimeTxs: [{ type: "importReplica", entityId: carolId, signerId: carolAddr, data: { config: carolConfig, isProposer: true, entitySeed: SEED } }], entityInputs: [] }, ctx));
    if (third === null) throw new Error("no frame");
    expect(third.runtimeOutputs).toEqual([]);
    const all = [...frames, third.frame], allInputs = [...inputs, third.applied], allOutbox = [...outbox, ...third.outbox];
    expect(unwrap(recoverRuntime(start, all, allInputs, allOutbox, ctx, [first.runtimeOutputs, second.runtimeOutputs, third.runtimeOutputs])).runtime.frameHash).toBe(third.frame.frameHash ?? "");
    expect(rwCode(recoverRuntime(start, all, allInputs, allOutbox, ctx))).toBe("STORAGE_REPLAY_POST_STATE_MISMATCH");
    const refuse = (f: readonly StorageFrame[], i = inputs): string | null => rwCode(recoverRuntime(start, f, i, outbox, ctx));
    expect(refuse([second.frame], [second.applied])).toBe("STORAGE_VERIFY_FRAME_HEIGHT_MISMATCH");
    expect(refuse([first.frame, { ...second.frame, prevFrameHash: hex(32) }])).toBe("STORAGE_VERIFY_FRAME_CHAIN_BROKEN");
    expect(refuse([first.frame, { ...second.frame, canonicalStateHash: hex(32) }])).toBe("STORAGE_VERIFY_CANONICAL_HASH_MISMATCH");
    expect(refuse([first.frame, { ...second.frame, postStateHash: hex(32) }])).toBe("STORAGE_VERIFY_FRAME_HASH_MISMATCH");
    // A row whose own hash is consistent but whose replay diverges (tampered post-state oracle, rehashed) is og's replay mismatch.
    const forged = { ...second.frame, postStateHash: hex(32) };
    expect(refuse([first.frame, { ...forged, frameHash: unwrap(storageFrameHash(forged)) }])).toBe("STORAGE_REPLAY_POST_STATE_MISMATCH");
    expect(refuse([first.frame])).toBe("STORAGE_VERIFY_FRAME_INPUT_MISSING");
  });
});
