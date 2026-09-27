import { describe, expect, test } from "bun:test";
// Scenario-level differential: one multi-entity world (three spokes around a hub) driven frame by frame through og's
// real Runtime processor (processRuntime = createRuntimeProcessor, core/runtime/composition.ts) and through the
// rewrite's Runtime entry (runtimeWake + commitRuntimeFrame), with identical inputs and timestamps. After every frame
// the state roots, the replica meta rows, the certified Entity heads, the Runtime component digests, the WAL
// postStateHash and the routed local outputs must agree.
//
// Seeds: a fixed default, overridden by SEEDX (decimal or 0x-hex); every failure names the seed and the frame.
//
// Not compared, by design:
// - the WAL row's own frameHash: og's row carries entityContextRefs (its replay-context index), which the rewrite's
//   StorageFrame does not model, so the two row hashes differ by construction;
// - postStateHash on a frame og materializes (a storage checkpoint: og's first frame), where og hashes the
//   materialized snapshot instead.
// Scheduling kept outside the frame function: og's host loop (prioritizeJEventFrame) runs a frame's j_event inputs
// alone and defers every other input; the scenario delivers a J range only on a quiescent frame, where that split
// is a no-op. An HTLC is only sent over lanes the gossip profiles advertise: og's quote throws (a Runtime halt, not a
// refusal) on an unadvertised lane.
// The rewrite runs with authorCommands (og prepareLocallyAuthoredEntityTxs): the harness signs with real keys.
process.env["XLN_LOG_LEVEL"] = process.env["XLN_LOG_LEVEL"] ?? "error";
import { rmSync } from "fs";
import { join } from "path";
import {
  closeInfraDb,
  closeRuntimeDb,
  createEmptyEnv,
  enqueueRuntimeInput,
  getRuntimeWalDb,
  processRuntime,
} from "../../core/runtime.ts";
import { readStorageFrameRecord } from "../../core/storage/read/read.ts";
import { registerSignerKey } from "../../core/account/crypto.ts";
import { dbRootPath } from "../../core/runtime/replica/platform.ts";
import {
  computeRuntimePostStateComponentDigests,
  prepareStorageCanonicalStateHashes,
} from "../../core/storage/hashes.ts";
import { buildStorageLiveReplicaMetaCommitment } from "../../core/storage/replica/replicas.ts";
import { buildReplayVerifiableRuntimePostStateView } from "../../core/storage/wal/snapshot.ts";
import { decodeBuffer } from "../../core/storage/codec/codec.ts";
import { projectCertifiedEntityFrameLinkIdentity } from "../../core/entity/consensus/frame/lineage.ts";
import { withDeterministicHtlcTestSecret } from "../../core/protocol/htlc/test-secret-capability.ts";
import { markLocalJAuthorityRuntimeTx } from "../../core/jurisdiction/machine/registration-evidence/index.ts";
import {
  compareCanonicalJurisdictionEvents,
  normalizeJurisdictionEvent,
} from "../../core/jurisdiction/machine/events/event-normalization.ts";
import {
  canonicalJurisdictionEventsHash,
  getJEventJurisdictionRef,
} from "../../core/jurisdiction/machine/event-observation.ts";
import {
  EMPTY_J_HISTORY_ROOT,
  buildJEventRangeDigest,
  canonicalJEventRangeHash,
  foldJHistoryRoot,
} from "../../core/jurisdiction/machine/history-consensus/index.ts";
import { getTokenCapacity } from "../../core/pathfinding/capacity.ts";
import { ANVIL_KEYS, signDigestHex, signerAddress, unwrap, verifiers } from "../xln_run.ts";
import {
  canonicalEntityHashes,
  commitRuntimeFrame,
  convertOutput,
  createRuntime,
  htlcPaymentTxHash,
  lazyBoardEntityId,
  ok,
  recoverRawSigner,
  signature,
  localNetworkOutputs,
  replicaKey,
  replicaMetaRows,
  runtimeComponentDigests,
  runtimeView,
  runtimeWake,
  stableJson,
  tokenId,
  wireEntityTx,
  type EntityId,
  type EntityTx,
  type ImportConfig,
  type JReplica,
  type RoutedEntityInput,
  type Runtime,
  type RuntimeTx,
} from "../xln.ts";

const DEFAULT_SEED = 0x5ce7a1;
const SEED = Number(process.env["SEEDX"] ?? DEFAULT_SEED);
const SEEDS = [SEED, SEED + 1, SEED + 2];
/** Committed Runtime frames per seed (idle ticks that commit nothing do not count). */
const FRAMES = 20;
const T0 = 1_700_000_000_000;
const J = {
  name: "Scn",
  address: "rpc://scn",
  chainId: 31337,
  depositoryAddress: `0x${"d1".repeat(20)}`,
  entityProviderAddress: `0x${"e1".repeat(20)}`,
};
const JREPLICA: JReplica = {
  name: J.name,
  blockNumber: 0n,
  stateRoot: null,
  mempool: [],
  blockDelayMs: 0,
  lastBlockTimestamp: 0,
  position: { x: 0, y: 0, z: 0 },
  rpcs: [J.address],
  chainId: J.chainId,
  contracts: {
    depository: J.depositoryAddress,
    entityProvider: J.entityProviderAddress,
    account: `0x${"a1".repeat(20)}`,
    deltaTransformer: `0x${"f1".repeat(20)}`,
  },
};
const TOKEN = unwrap(tokenId("1"));
const HUB = 1;
const SPOKES = [0, 2, 3];
const NAMES = ["A", "H", "C", "D"];
/** Anvil account #3: xln_run keys only #0-#2, so D's signer signs through the scenario's own member signer. */
const EXTRA_KEY = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6";
const EXTRA_SIGNER = signerAddress(EXTRA_KEY);
const KEYS = [...ANVIL_KEYS, EXTRA_KEY];
const sign: typeof verifiers.sign = (h, addr) =>
  addr.toLowerCase() === EXTRA_SIGNER
    ? ok(unwrap(signature(signDigestHex(h, EXTRA_KEY).slice(2))))
    : verifiers.sign(h, addr);
const verifyMember: typeof verifiers.verifyMember = (h, sig, addr) =>
  addr.toLowerCase() === EXTRA_SIGNER
    ? (recoverRawSigner(h, sig) ?? "").toLowerCase() === EXTRA_SIGNER
    : verifiers.verifyMember(h, sig, addr);
const CRYPTO = { ...verifiers, sign, verifyMember };

/** mulberry32. */
const prng = (seed: number) => {
  let s = seed >>> 0;
  return (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
/** A tree deep copy (Bun's structuredClone mis-decodes repeated references, e.g. the shared jurisdiction object). */
const treeClone = <T>(v: T): T => {
  if (v === null || typeof v !== "object") return v;
  if (v instanceof Uint8Array) return new Uint8Array(v) as T;
  if (v instanceof Map) return new Map([...v].map(([k, x]) => [treeClone(k), treeClone(x)])) as T;
  if (v instanceof Set) return new Set([...v].map(treeClone)) as T;
  if (Array.isArray(v)) return v.map(treeClone) as T;
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, treeClone(x)])) as T;
};
/** Plain JSON view (bigints tagged), so og and rewrite values compare structurally. */
const plain = (v: unknown): unknown => JSON.parse(stableJson(v));
/** The first differing leaves of two plain values, as `path: og=… rw=…`. */
const leafDiffs = (a: unknown, b: unknown, at = "", out: string[] = []): string[] => {
  if (out.length >= 6) return out;
  const both = a !== null && b !== null && typeof a === "object" && typeof b === "object";
  if (both) {
    const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
    keys.forEach((k) =>
      leafDiffs((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${at}.${k}`, out),
    );
    return out;
  }
  const [x, y] = [stableJson(a), stableJson(b)];
  if (x !== y) out.push(`${at || "."}: og=${x.slice(0, 160)} rw=${y.slice(0, 160)}`);
  return out;
};

type User = { readonly entity: number; readonly txs: readonly EntityTx[] };
type Coverage = { frames: number; entityFrames: number; actions: Record<string, number>; accountTxs: Set<string> };

const runScenario = async (seed: number): Promise<Coverage> => {
  const rand = prng(seed);
  const ri = (n: number): number => Math.floor(rand() * n);
  const tag = `SEEDX=0x${seed.toString(16)}`;
  const ns = `scn-diff-${process.pid}-${seed.toString(16)}`;
  const env = createEmptyEnv(ns);
  env.scenarioMode = true;
  env.quietRuntimeLogs = true;
  env.state.timestamp = T0;
  env.runtimeConfig = { ...env.runtimeConfig, storage: { ...env.runtimeConfig?.storage, enabled: true } } as never;
  env.activeJurisdiction = J.name;
  env.state.jReplicas.set(J.name, treeClone(JREPLICA) as never);
  // og's deterministic scenario harness (scenarios/harness/helpers.ts): every simulated peer is hosted here, so an
  // Entity is online exactly when this Runtime holds a replica of it
  const localIds = (): Set<string> => new Set([...env.state.eReplicas.values()].map((r) => r.entityId.toLowerCase()));
  const infrastructure = (env.infrastructure ?? {}) as {
    observeOnlineEntityIds?: (ids: readonly string[]) => Set<string>;
  };
  infrastructure.observeOnlineEntityIds = (xs) =>
    new Set(xs.map((x) => x.toLowerCase()).filter((x) => localIds().has(x)));
  env.infrastructure = infrastructure as never;
  const signers = KEYS.map((k) => signerAddress(k));
  KEYS.forEach((k, i) => registerSignerKey(env, signers[i]!, Buffer.from(k.slice(2), "hex")));
  const config = (s: string): ImportConfig =>
    ({ mode: "proposer-based", threshold: 1n, validators: [s], shares: { [s]: 1n }, jurisdiction: J }) as ImportConfig;
  const ids = signers.map((s) => unwrap(lazyBoardEntityId(config(s))).toLowerCase() as EntityId);
  const keyed = new Set(signers);
  const secrets = new Map<string, string>();
  const gossip = (env as unknown as { gossip?: { getProfile?: (id: string) => unknown } }).gossip;
  const profiles = (): unknown[] =>
    ids.flatMap((id) => {
      const p = gossip?.getProfile?.(id);
      return p === undefined ? [] : [treeClone(p)];
    });
  const coverage: Coverage = { frames: 0, entityFrames: 0, actions: {}, accountTxs: new Set() };
  const count = (kind: string): void => {
    coverage.actions[kind] = (coverage.actions[kind] ?? 0) + 1;
  };
  let rt: Runtime = { ...createRuntime([JREPLICA], env.runtimeId), activeJurisdiction: J.name, timestamp: BigInt(T0) };
  let pending: RoutedEntityInput[] = [];
  let frame = 0;

  const ogEntityHeights = (): number =>
    [...env.state.eReplicas.values()].reduce((sum, r) => sum + Number(r.state.height), 0);
  /** One Runtime frame on both sides; returns the differences found after it. */
  const tick = async (runtimeTxs: readonly RuntimeTx[], users: readonly User[]): Promise<string[]> => {
    frame += 1;
    const label = `${tag} frame=${frame}`;
    const known = profiles();
    const entityInputs = users.map((u) => ({
      entityId: ids[u.entity]!,
      signerId: signers[u.entity]!,
      entityTxs: treeClone(u.txs.map(wireEntityTx)),
    }));
    const ogTxs = treeClone(runtimeTxs).map((tx) =>
      tx.type === "observeJRange" ? markLocalJAuthorityRuntimeTx(tx as never) : tx,
    );
    if (runtimeTxs.length + users.length > 0) enqueueRuntimeInput(env, { runtimeTxs: ogTxs, entityInputs } as never);
    const [h0, e0] = [env.state.height, ogEntityHeights()];
    await processRuntime(env);
    const rec =
      env.state.height > h0
        ? ((await readStorageFrameRecord(getRuntimeWalDb(env), env.state.height)) ?? undefined)
        : undefined;
    coverage.entityFrames += ogEntityHeights() - e0;

    const now = Number(rt.timestamp) + 100;
    const userIn: RoutedEntityInput[] = users.map((u) => ({
      entityId: ids[u.entity]!,
      signerId: signers[u.entity]!,
      input: { kind: "txs", timestamp: BigInt(now), txs: u.txs },
    }));
    // og enqueueRuntimeInput appends after the local continuations the previous frame re-enqueued
    const queued = { runtimeTxs, entityInputs: [...pending, ...userIn] };
    const wake = runtimeWake(rt, now, queued, (s) => keyed.has(s.toLowerCase()));
    const input = {
      runtimeTxs: [...runtimeTxs, ...wake.input.runtimeTxs],
      entityInputs: [...queued.entityInputs, ...wake.input.entityInputs],
      timestamp: BigInt(now),
    };
    const local = new Set([...wake.local, ...runtimeTxs.filter((tx) => tx.type === "observeJRange")]);
    const htlcInfra = () => ({
      profiles: known as never[],
      online: (x: string) => localIds().has(x.toLowerCase()),
      secretFor: (h: string) => secrets.get(h),
    });
    // og admission signs every local tx into the replica's own Entity command (prepareLocallyAuthoredEntityTxs)
    const committed = commitRuntimeFrame(rt, input, { ...CRYPTO, local, htlcInfra, authorCommands: true });
    if (!committed.ok) return [`${label} rewrite refused the frame: ${stableJson(committed.error)}`];
    const c = committed.value;
    const after = c === null ? rt : c.runtime;
    const diffs: string[] = [];
    const cmp = (what: string, og: unknown, rw: unknown): void => {
      leafDiffs(plain(og), plain(rw)).forEach((d) => diffs.push(`${label} ${what}${d}`));
    };
    cmp("height", env.state.height, Number(after.height));
    cmp("timestamp", env.state.timestamp, Number(after.timestamp));
    cmp(
      "entityHashes",
      prepareStorageCanonicalStateHashes(env as never, [], null).canonicalEntityHashes,
      unwrap(canonicalEntityHashes(after)),
    );
    const ogMeta = buildStorageLiveReplicaMetaCommitment(env as never).entries;
    const rwMeta = unwrap(replicaMetaRows(after));
    cmp("metaRows", ogMeta.length, rwMeta.length);
    ogMeta.forEach((row, i) =>
      cmp(`meta[${i}]`, decodeBuffer(row.value), decodeBuffer(Buffer.from(rwMeta[i]?.value ?? new Uint8Array()))),
    );
    [...env.state.eReplicas.values()].forEach((r) => {
      const mine = after.entities.get(replicaKey(r.entityId as EntityId, r.signerId));
      const head = r.certifiedFrameHead ? projectCertifiedEntityFrameLinkIdentity(r.certifiedFrameHead) : undefined;
      cmp(`head[${NAMES[ids.indexOf(r.entityId as EntityId)]}]`, head ?? null, mine?.certifiedFrameHead ?? null);
    });
    cmp(
      "components",
      computeRuntimePostStateComponentDigests(buildReplayVerifiableRuntimePostStateView(env as never)),
      unwrap(runtimeComponentDigests(runtimeView(after))),
    );
    cmp("advanced", rec !== undefined, c !== null);
    if (rec !== undefined && c !== null && !rec.materializedState)
      cmp("postStateHash", rec.postStateHash, c.frame.postStateHash);
    const ogRouted = env.runtimeMempool?.entityInputs ?? [];
    cmp("routed", ogRouted, c === null ? [] : unwrap(localNetworkOutputs(c.runtime, c.outbox)));
    ogRouted.forEach((routed) =>
      (routed.entityTxs ?? []).forEach((tx) => {
        const proposal =
          tx.type === "accountInput"
            ? (tx.data as { proposal?: { frame: { accountTxs: { type: string }[] } } }).proposal
            : undefined;
        proposal?.frame.accountTxs.forEach((a) => coverage.accountTxs.add(a.type));
      }),
    );
    if (rec !== undefined) coverage.frames += 1;
    if (c !== null) {
      rt = c.runtime;
      pending = c.outbox.map((o) => unwrap(convertOutput(rt, o, o.to, rt.timestamp)));
    }
    return diffs;
  };

  // ---- actions ----
  const user = (entity: number, txs: readonly EntityTx[]): User => ({ entity, txs });
  const open = (from: number, to: number, credit: bigint): EntityTx =>
    ({
      type: "openAccount",
      data: {
        targetEntityId: ids[to]!,
        creditAmount: credit,
        tokenId: TOKEN,
        disputeConfig: { leftResponseSeconds: 60, rightResponseSeconds: 60 },
        accountDomain: { chainId: J.chainId, depositoryAddress: J.depositoryAddress },
        watchSeed: `0x${(from * 16 + to + 1).toString(16).padStart(2, "0").repeat(32)}`,
      },
    }) as EntityTx;
  const extend = (from: number, to: number, amount: bigint): EntityTx => ({
    type: "extendCredit",
    data: { counterpartyEntityId: ids[to]!, tokenId: TOKEN, amount },
  });
  const direct = (from: number, to: number, amount: bigint): EntityTx => ({
    type: "directPayment",
    data: { targetEntityId: ids[to]!, tokenId: TOKEN, amount, route: [ids[from]!, ids[to]!], deliveryMode: "direct" },
  });
  const htlc = (from: number, to: number, amount: bigint): EntityTx => {
    const secret = `0x${Array.from({ length: 8 }, () =>
      ri(2 ** 32)
        .toString(16)
        .padStart(8, "0"),
    ).join("")}`;
    const raw = {
      type: "htlcPayment" as const,
      data: {
        targetEntityId: ids[to]!,
        tokenId: 1,
        amount,
        maxSenderDebit: amount * 2n + 10n,
        route: [ids[from]!, ids[HUB]!, ids[to]!],
        deliveryMode: "instant" as const,
      },
    };
    const tx = withDeterministicHtlcTestSecret(raw as never, secret) as unknown as Extract<
      EntityTx,
      { type: "htlcPayment" }
    >;
    secrets.set(unwrap(htlcPaymentTxHash(tx)), secret);
    return tx;
  };
  const jRef = getJEventJurisdictionRef(J as never);
  let words = 0;
  const jWord = (): string => `0x${seed.toString(16).padStart(16, "0")}${(++words).toString(16).padStart(48, "0")}`;
  /** A watcher page (observeJRange) and the signed J range (j_event) carrying one block of ReserveUpdated events. */
  const reserveRange = (entity: number, balance: bigint): [RuntimeTx, EntityTx] => {
    const state = [...env.state.eReplicas.values()].find((r) => r.entityId === ids[entity])!.state as unknown as {
      lastFinalizedJHeight?: number;
      jHistoryFinality?: { eventHistoryRoot: string };
    };
    const baseHeight = Number(state.lastFinalizedJHeight ?? 0);
    const blockNumber = baseHeight + 1;
    const blockHash = jWord();
    const raw = { type: "ReserveUpdated", data: { entity: ids[entity]!, tokenId: 1, newBalance: balance.toString() } };
    const event = normalizeJurisdictionEvent({
      ...raw,
      blockNumber,
      blockHash,
      transactionHash: jWord(),
      logIndex: 0,
    } as never)!;
    const events = [event].sort(compareCanonicalJurisdictionEvents);
    const block = { blockNumber, blockHash, eventsHash: canonicalJurisdictionEventsHash(events), events };
    const eventHistoryRoot = foldJHistoryRoot(state.jHistoryFinality?.eventHistoryRoot ?? EMPTY_J_HISTORY_ROOT, [
      { jurisdictionRef: jRef, jHeight: blockNumber, jBlockHash: blockHash, eventsHash: block.eventsHash },
    ]);
    const rangeHash = canonicalJEventRangeHash(jRef, [block] as never);
    const range = {
      entityId: ids[entity]!,
      jurisdictionRef: jRef,
      signerId: signers[entity]!,
      baseHeight,
      scannedThroughHeight: blockNumber,
      tipBlockHash: blockHash,
      eventHistoryRoot,
      rangeHash,
    };
    const signature = signDigestHex(buildJEventRangeDigest(range), KEYS[entity]!);
    const observe = {
      type: "observeJRange",
      data: {
        entityId: ids[entity]!,
        signerId: signers[entity]!,
        jurisdictionRef: jRef,
        scannedThroughHeight: blockNumber,
        tipBlockHash: blockHash,
        blocks: [
          { jurisdictionRef: jRef, jHeight: blockNumber, jBlockHash: blockHash, events, eventsHash: block.eventsHash },
        ],
      },
    } as unknown as RuntimeTx;
    const jEvent = {
      type: "j_event",
      data: {
        from: signers[entity]!,
        jurisdictionRef: jRef,
        baseHeight,
        scannedThroughHeight: blockNumber,
        observedAt: blockNumber,
        tipBlockHash: blockHash,
        blocks: [block],
        eventHistoryRoot,
        rangeHash,
        signature,
      },
    } as unknown as EntityTx;
    return [observe, jEvent];
  };

  type ProfileRow = { counterpartyId: string; tokenCapacities: unknown };
  const rowsOf = (x: number): ProfileRow[] =>
    (gossip?.getProfile?.(ids[x]!) as { accounts?: ProfileRow[] } | undefined)?.accounts ?? [];
  const row = (x: number, y: number): ProfileRow | undefined =>
    rowsOf(x).find((r) => r.counterpartyId.toLowerCase() === ids[y]);
  /** og hopCapacity: the lane's own row, else its mirror, advertising the token (og throws, halting, otherwise). */
  const advertised = (x: number, y: number): boolean => {
    const lane = row(x, y) ?? row(y, x);
    return lane !== undefined && getTokenCapacity(lane.tokenCapacities as never, 1) !== null;
  };
  const routable = (from: number, to: number): boolean => advertised(from, HUB) && advertised(HUB, to);
  const spoke = (): number => SPOKES[ri(SPOKES.length)]!;
  const amount = (max: number): bigint => BigInt(1 + ri(max));
  /** One scripted or random step: its Runtime txs and user inputs (a J range only on a quiescent frame). */
  const step = (kind: string): { runtimeTxs: RuntimeTx[]; users: User[] } | undefined => {
    const s = spoke();
    const other = SPOKES.filter((x) => x !== s)[ri(2)]!;
    switch (kind) {
      case "hubCredit":
        return { runtimeTxs: [], users: [user(HUB, [extend(HUB, s, amount(20_000))])] };
      case "spokeCredit":
        return { runtimeTxs: [], users: [user(s, [extend(s, HUB, amount(20_000))])] };
      case "payToHub":
        return { runtimeTxs: [], users: [user(s, [direct(s, HUB, amount(600))])] };
      case "payFromHub":
        return { runtimeTxs: [], users: [user(HUB, [direct(HUB, s, amount(600))])] };
      case "htlc":
        return routable(s, other) ? { runtimeTxs: [], users: [user(s, [htlc(s, other, amount(300))])] } : undefined;
      case "overHtlc":
        // beyond any capacity: og refuses the only frame tx and its deferred flush evicts it from the mempool
        return routable(s, other) ? { runtimeTxs: [], users: [user(s, [htlc(s, other, 10n ** 12n)])] } : undefined;
      case "spokeOpen":
        return { runtimeTxs: [], users: [user(0, [open(0, 2, amount(5_000))])] };
      case "twoSenders":
        return {
          runtimeTxs: [],
          users: [user(s, [direct(s, HUB, amount(200))]), user(other, [extend(other, HUB, amount(3_000))])],
        };
      case "jReserve": {
        if (pending.length > 0) return undefined;
        const entity = ri(4);
        const [observe, range] = reserveRange(entity, BigInt(1 + ri(1_000_000)));
        return { runtimeTxs: [observe], users: [user(entity, [range])] };
      }
      default:
        return { runtimeTxs: [], users: [] };
    }
  };

  try {
    const imports = signers.map(
      (s, i): RuntimeTx =>
        ({
          type: "importReplica",
          entityId: ids[i]!,
          signerId: s,
          data: { config: config(s), isProposer: true, entitySeed: `0x${String(i + 1).repeat(128)}` },
        }) as RuntimeTx,
    );
    const expectClean = (diffs: string[]): void => expect(diffs).toEqual([]);
    expectClean(await tick(imports, []));
    expectClean(
      await tick(
        [],
        SPOKES.map((s) => user(s, [open(s, HUB, amount(20_000))])),
      ),
    );
    const script = [
      "hubCredit",
      "hubCredit",
      "payToHub",
      "payFromHub",
      "htlc",
      "overHtlc",
      "jReserve",
      "spokeOpen",
      "twoSenders",
    ];
    const random = [
      "idle",
      "idle",
      "idle",
      "hubCredit",
      "spokeCredit",
      "payToHub",
      "payFromHub",
      "htlc",
      "jReserve",
      "twoSenders",
    ];
    const queue = [...script];
    while (coverage.frames < FRAMES && frame < 3 * FRAMES) {
      const kind = queue.length > 0 && rand() < 0.6 ? queue[0]! : random[ri(random.length)]!;
      const planned = step(kind);
      const chosen = planned ?? { runtimeTxs: [], users: [] };
      if (planned !== undefined && queue[0] === kind) queue.shift();
      count(planned === undefined ? "idle" : kind);
      expectClean(await tick(chosen.runtimeTxs, chosen.users));
    }
    return coverage;
  } finally {
    await closeRuntimeDb(env);
    await closeInfraDb(env);
    ["", "-storage-current", "-storage-previous", "-wal", "-history-views", "-events", "-infra"].forEach((suffix) =>
      rmSync(join(dbRootPath, ns) + suffix, { recursive: true, force: true }),
    );
  }
};

describe("scenario: og processRuntime vs the rewrite's Runtime, frame by frame", () => {
  const totals = { frames: 0, accountTxs: new Set<string>() };
  SEEDS.forEach((seed) => {
    test(`MATCH: hub world, seed 0x${seed.toString(16)} (${FRAMES} frames)`, async () => {
      const c = await runScenario(seed);
      totals.frames += c.frames;
      c.accountTxs.forEach((t) => totals.accountTxs.add(t));
      console.log(
        `seed 0x${seed.toString(16)}: ${c.frames} Runtime frames, ${c.entityFrames} Entity frames,`,
        `actions ${stableJson(c.actions)}, Account txs ${[...c.accountTxs].sort().join(",")}`,
      );
      expect(c.frames).toBeGreaterThan(FRAMES / 2);
    }, 600_000);
  });
  test("the seeded scenarios cover 50+ committed Runtime frames and a multi-hop HTLC", () => {
    expect(totals.frames).toBeGreaterThanOrEqual(50);
    expect(totals.accountTxs.has("htlc_lock")).toBe(true);
  });
});
