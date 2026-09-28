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
// Admission signs local txs into Entity commands (og prepareLocallyAuthoredEntityTxs), so the harness uses real keys.
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
import { getTokenCapacity } from "../../core/pathfinding/capacity.ts";
import { createJAdapter } from "../../core/jurisdiction/adapter/index.ts";
import type { JAdapter } from "../../core/jurisdiction/adapter/types.ts";
import { attachLiveJAdapter } from "../../core/runtime/j-submit/live-jadapters.ts";
import { ANVIL_KEYS, signDigestHex, signerAddress, unwrap, verifiers } from "../xln_run.ts";
import { accountLines, inputsLine, routedLine, tracing } from "./scenario-trace.ts";
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
/** og's in-memory EVM with the real Depository stack: the chain both sides observe. */
const bootChain = async (): Promise<JAdapter> => {
  const chain = await createJAdapter({ mode: "browservm", chainId: 31337 } as never);
  await chain.deployStack();
  chain.setQuietLogs?.(true);
  return chain;
};
const jurisdictionOf = (chain: JAdapter) => {
  const J = {
    name: "Scn",
    address: "browservm://",
    chainId: Number(chain.chainId),
    depositoryAddress: chain.addresses.depository.toLowerCase(),
    entityProviderAddress: chain.addresses.entityProvider.toLowerCase(),
    entityProviderDeploymentBlock: chain.entityProviderDeploymentBlock,
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
    watcherConfirmationDepth: chain.getFinalityDepth!(),
    entityProviderDeploymentBlock: J.entityProviderDeploymentBlock,
    contracts: {
      depository: J.depositoryAddress,
      entityProvider: J.entityProviderAddress,
      account: chain.addresses.account.toLowerCase(),
      deltaTransformer: chain.addresses.deltaTransformer.toLowerCase(),
    },
  };
  return { J, JREPLICA };
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
  if (out.length >= Number(process.env["SCN_DIFFS"] ?? 6)) return out;
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
type Coverage = {
  frames: number;
  entityFrames: number;
  /** Frames og halted on (a local bug by og's taxonomy) and the rewrite refused. */
  halts: number;
  /** Disputes both sides saw finalized on chain (the Account stays frozen, its active dispute cleared). */
  disputesFinalized: number;
  actions: Record<string, number>;
  accountTxs: Set<string>;
};

/** A scenario's steps: the script it works through in order (each step when its preconditions hold), and the mix. */
type Plan = {
  readonly name: string;
  readonly script: readonly string[];
  readonly random: readonly string[];
  readonly frames: number;
};
const HUB_PLAN: Plan = {
  name: "hub",
  script: ["fund", "r2c", "hubCredit", "hubCredit", "payToHub", "payFromHub", "htlc", "overHtlc", "jReserve",
    "spokeOpen", "twoSenders"],
  random: ["idle", "idle", "idle", "hubCredit", "spokeCredit", "payToHub", "payFromHub", "htlc", "jReserve",
    "twoSenders", "r2c"],
  frames: FRAMES,
};
/**
 * og's unilateral dispute (core/scenarios/disputes/lifecycle.ts): a spoke freezes its hub Account and broadcasts the
 * disputeStart, both sides observe DisputeStarted, the clocks jump past the challenge window, and the deadline hook
 * finalizes on chain; the frozen Account then refuses business traffic from either side.
 */
const DISPUTE_PLAN: Plan = {
  name: "dispute",
  script: ["fund", "hubCredit", "payFromHub", "payToHub", "dispute", "disputeBroadcast", "disputeTimeout",
    "payToHub", "payFromHub"],
  random: ["idle", "idle", "idle", "idle", "hubCredit", "spokeCredit", "payToHub", "payFromHub", "r2c"],
  // the challenge window, the deadline hook, the finalize batch and its J range each take frames of their own
  frames: 2 * FRAMES,
};

const runScenario = async (seed: number, plan: Plan): Promise<Coverage> => {
  const rand = prng(seed);
  const ri = (n: number): number => Math.floor(rand() * n);
  const tag = `SEEDX=0x${seed.toString(16)}`;
  const chain = await bootChain();
  const { J, JREPLICA } = jurisdictionOf(chain);
  const ns = `scn-diff-${process.pid}-${plan.name}-${seed.toString(16)}`;
  const env = createEmptyEnv(ns);
  env.scenarioMode = true;
  env.quietRuntimeLogs = true;
  env.state.timestamp = T0;
  env.runtimeConfig = { ...env.runtimeConfig, storage: { ...env.runtimeConfig?.storage, enabled: true } } as never;
  env.activeJurisdiction = J.name;
  env.state.jReplicas.set(J.name, treeClone(JREPLICA) as never);
  // og submits a sealed batch through its live adapter after the frame commits, and og's own watcher turns every
  // chain emission into its runtime mempool (observeJRange, the cursor, each validator's J-prefix attestation)
  attachLiveJAdapter(env, J.name, chain);
  chain.startWatching(env);
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
  const coverage: Coverage = {
    frames: 0,
    entityFrames: 0,
    halts: 0,
    disputesFinalized: 0,
    actions: {},
    accountTxs: new Set(),
  };
  const count = (kind: string): void => {
    coverage.actions[kind] = (coverage.actions[kind] ?? 0) + 1;
  };
  let rt: Runtime = { ...createRuntime([JREPLICA], env.runtimeId), activeJurisdiction: J.name, timestamp: BigInt(T0) };
  let pending: readonly RoutedEntityInput[] = [];
  /**
   * The host's own queue for the next frame, as og's host loop builds it after a frame: the plan-time wake
   * (generateHookPings in planRuntimeOutputs: due pings and J-submit retries), then the frame's J-submit retries.
   */
  let own: { runtimeTxs: readonly RuntimeTx[]; pings: readonly RoutedEntityInput[]; local: Set<unknown> } = {
    runtimeTxs: [],
    pings: [],
    local: new Set(),
  };
  /** og's watcher input: an attestation lane, which no single-signer Entity routes to itself. */
  const watched = (i: { jPrefixAttestations?: Map<string, unknown> }): boolean => (i.jPrefixAttestations?.size ?? 0) > 0;
  /** Runtime txs only og's I/O makes: its watcher's observations and cursor, and its adapter's submit results. */
  const IO_TXS = new Set([
    "observeJRange",
    "advanceJWatcherCursor",
    "recordAuthenticatedJAuthority",
    "rewindJHistory",
    "recordJSubmitResult",
    "recordEntityProviderActionSubmitResult",
    "recordGovernanceJSubmitResult",
  ]);
  type OgMempool = {
    runtimeTxs: RuntimeTx[];
    entityInputs: {
      entityId: string;
      signerId: string;
      entityTxs?: { type: string; data?: unknown }[];
      jPrefixAttestations?: Map<string, unknown>;
    }[];
  };
  const ogMempool = (): OgMempool => (env.runtimeMempool ?? { runtimeTxs: [], entityInputs: [] }) as unknown as OgMempool;
  /** What og's I/O queued: the rewrite's host would observe the same chain and hand it the same, as local inputs. */
  /**
   * og's queued inputs in its own arrival order: the watcher's attestations stand where og queued them among the
   * routed outputs we carry (which the previous frame already proved equal to og's).
   */
  const hostInputs = (carried: readonly RoutedEntityInput[]): { runtimeTxs: RuntimeTx[]; entityInputs: RoutedEntityInput[] } => {
    const mempool = ogMempool();
    const attestation = (i: OgMempool["entityInputs"][number]): RoutedEntityInput =>
      ({
        entityId: i.entityId as EntityId,
        signerId: i.signerId,
        input: { kind: "jPrefixAttestations", attestations: treeClone(i.jPrefixAttestations!) },
      }) as unknown as RoutedEntityInput;
    const woven = mempool.entityInputs.reduce<{ out: RoutedEntityInput[]; next: number }>(
      (acc, i) =>
        watched(i)
          ? { out: [...acc.out, attestation(i)], next: acc.next }
          : { out: [...acc.out, ...carried.slice(acc.next, acc.next + 1)], next: acc.next + 1 },
      { out: [], next: 0 },
    );
    const runtimeTxs = treeClone(mempool.runtimeTxs.filter((tx) => IO_TXS.has(tx.type)));
    return { runtimeTxs, entityInputs: [...woven.out, ...carried.slice(woven.next)] };
  };
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
    const host = hostInputs([...own.pings, ...pending]);
    if (runtimeTxs.length + users.length > 0) enqueueRuntimeInput(env, { runtimeTxs: treeClone(runtimeTxs), entityInputs } as never);
    const [h0, e0] = [env.state.height, ogEntityHeights()];
    const ogHalt = await processRuntime(env).then(
      () => undefined,
      (e: unknown) => String((e as { cause?: { message?: string } }).cause?.message ?? (e as Error).message),
    );
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
    const queued = {
      runtimeTxs: [...own.runtimeTxs, ...host.runtimeTxs, ...runtimeTxs],
      entityInputs: [...host.entityInputs, ...userIn],
    };
    const wake = runtimeWake(rt, now, queued, (s) => keyed.has(s.toLowerCase()));
    if (tracing()) console.log("INPUTS", inputsLine(queued.entityInputs));
    const input = {
      runtimeTxs: [...queued.runtimeTxs, ...wake.input.runtimeTxs],
      entityInputs: [...queued.entityInputs, ...wake.input.entityInputs],
      timestamp: BigInt(now),
    };
    const local = new Set([...wake.local, ...own.local, ...host.runtimeTxs] as never[]);
    const htlcInfra = () => ({
      profiles: known as never[],
      online: (x: string) => localIds().has(x.toLowerCase()),
      secretFor: (h: string) => secrets.get(h),
    });
    // og admission signs every local tx into the replica's own Entity command (prepareLocallyAuthoredEntityTxs)
    const committed = commitRuntimeFrame(rt, input, { ...CRYPTO, local, htlcInfra });
    if (ogHalt !== undefined) {
      coverage.halts += 1;
      return committed.ok ? [`${label} og halted (${ogHalt}) but the rewrite committed`] : [];
    }
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
    const planWake = c === null ? undefined : runtimeWake(after, Number(after.timestamp), undefined, (s) => keyed.has(s.toLowerCase()));
    const pings = planWake?.input.entityInputs ?? [];
    const pingWire = pings.map((p) => ({
      entityId: p.entityId,
      signerId: p.signerId,
      entityTxs: p.input.kind === "txs" ? p.input.txs.map(wireEntityTx) : [],
    }));
    const ogRouted = ogMempool().entityInputs.filter((i) => !watched(i));
    cmp("routed", ogRouted, c === null ? [] : [...pingWire, ...unwrap(localNetworkOutputs(c.runtime, c.outbox))]);
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
    const ogQueued = ogMempool().runtimeTxs;
    const ownTxs = c === null ? own.runtimeTxs : [...planWake!.input.runtimeTxs, ...c.queuedRetries];
    cmp("queued", ogQueued.filter((tx) => !IO_TXS.has(tx.type)), ownTxs);
    // og's own queue precedes its I/O results: the post-commit submit and the watcher run after the host re-queues
    const firstIo = ogQueued.findIndex((tx) => IO_TXS.has(tx.type));
    cmp("queueOrder", ogQueued.slice(firstIo < 0 ? ogQueued.length : firstIo).every((tx) => IO_TXS.has(tx.type)), true);
    if (tracing() && diffs.length > 0) {
      const rwRouted = c === null ? [] : [...pingWire, ...unwrap(localNetworkOutputs(c.runtime, c.outbox))];
      console.log(`OG ROUTED ${routedLine(ogRouted)}\nRW ROUTED ${routedLine(rwRouted)}`);
      if (c !== null && c.rejected.length > 0) console.log("RW REJECTED", stableJson(c.rejected).slice(0, 3000));
      const name = (id: string): string => NAMES[ids.indexOf(id as EntityId)] ?? id.slice(-4);
      [...env.state.eReplicas.values()].forEach((r) => {
        const mine = after.entities.get(replicaKey(r.entityId as EntityId, r.signerId));
        const accounts = r.state.accounts as unknown as ReadonlyMap<string, Record<string, unknown>>;
        const diff = (og: unknown, rw: unknown) => leafDiffs(plain(og), plain(rw));
        accountLines(accounts, mine, name, name(r.entityId), diff).forEach((line) => console.log(line));
      });
    }
    if (c !== null) {
      own = { runtimeTxs: ownTxs, pings, local: new Set([...planWake!.local, ...c.queuedRetries]) };
    }
    (c?.jOutbox ?? []).forEach((j) => j.jTxs.forEach((t) => coverage.accountTxs.add(`j:${(t as { type: string }).type}`)));
    if (c !== null) {
      rt = c.runtime;
      // og's host re-enqueues its own continuations without transport provenance: no `from`
      pending = c.outbox.map((o) => {
        const { from: _local, ...routed } = unwrap(convertOutput(rt, o, o.to, rt.timestamp));
        return routed;
      });
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
  const ogState = (x: number): { reserves?: Map<number, bigint>; accounts?: Map<string, unknown>; jBatchState?: unknown } | undefined =>
    [...env.state.eReplicas.values()].find((r) => r.entityId === ids[x])?.state as never;
  /** The token reserve og's Entity has observed on chain (the same state the rewrite holds: roots agree). */
  const reserveOf = (x: number): bigint => ogState(x)?.reserves?.get(1) ?? 0n;
  const hasAccount = (x: number, y: number): boolean => ogState(x)?.accounts?.has(ids[y]!) ?? false;
  type OgAccount = {
    status?: string;
    counterpartyDisputeProofHanko?: string;
    activeDispute?: { disputeTimeout: number };
  };
  const ogAccount = (x: number, y: number): OgAccount | undefined =>
    ogState(x)?.accounts?.get(ids[y]!) as OgAccount | undefined;
  const batchOf = (x: number): { batch?: { disputeStarts?: unknown[] }; sentBatch?: unknown } | undefined =>
    ogState(x)?.jBatchState as never;
  /** The spoke that froze its hub Account (one dispute per run). */
  let disputing: number | undefined;
  const spoke = (): number => SPOKES[ri(SPOKES.length)]!;
  const amount = (max: number): bigint => BigInt(1 + ri(max));
  /** One scripted or random step: its Runtime txs and user inputs (a J range only on a quiescent frame). */
  const step = async (kind: string): Promise<{ runtimeTxs: RuntimeTx[]; users: User[] } | undefined> => {
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
      case "fund": {
        // og's watcher sees the mints and queues each Entity's J range for the next frame
        await chain.debugFundReservesBatch(ids.map((entityId) => ({ entityId, tokenId: 1, amount: 10n ** 9n })));
        return { runtimeTxs: [], users: [] };
      }
      case "r2c": {
        // a party moves reserve it holds into its hub Account's collateral and seals the batch for the chain (an
        // r2c og refuses leaves no batch, and og halts on the j_broadcast: that edge has its own step)
        const from = rand() < 0.5 ? s : HUB;
        const to = from === HUB ? s : HUB;
        const moved = amount(50_000);
        // og throws (a halt) on a j_broadcast while the party's last batch is still unconfirmed
        const sealed = (ogState(from)?.jBatchState as { sentBatch?: unknown } | undefined)?.sentBatch !== undefined;
        if (!hasAccount(from, to) || reserveOf(from) < moved || sealed) return undefined;
        const r2c = { type: "r2c", data: { counterpartyId: ids[to]!, tokenId: 1, amount: moved } };
        return { runtimeTxs: [], users: [user(from, [r2c, { type: "j_broadcast", data: {} }] as EntityTx[])] };
      }
      case "haltingBroadcast": {
        // og throws a plain Error on a j_broadcast with no batch: a local bug, so both Runtimes must halt
        const idle = [...ids.keys()].find((x) => ogState(x)?.jBatchState === undefined);
        return idle === undefined
          ? undefined
          : { runtimeTxs: [], users: [user(idle, [{ type: "j_broadcast", data: {} }] as EntityTx[])] };
      }
      case "dispute": {
        // a spoke whose hub Account holds the hub's dispute-proof Hanko freezes it; og auto-drafts the disputeStart
        const ready = SPOKES.filter((x) => {
          const a = ogAccount(x, HUB);
          const free = batchOf(x)?.sentBatch === undefined;
          return a?.counterpartyDisputeProofHanko !== undefined && (a.status ?? "active") === "active" && free;
        });
        if (disputing !== undefined || ready.length === 0) return undefined;
        disputing = ready[ri(ready.length)]!;
        const prepare = { type: "prepareDispute", data: { counterpartyEntityId: ids[HUB]!, description: "scn" } };
        return { runtimeTxs: [], users: [user(disputing, [prepare] as EntityTx[])] };
      }
      case "disputeBroadcast": {
        // the drafted disputeStart goes to the chain; og's watcher then feeds DisputeStarted to both sides
        const drafted = disputing === undefined ? undefined : batchOf(disputing);
        if (drafted === undefined || drafted.sentBatch !== undefined) return undefined;
        if ((drafted.batch?.disputeStarts?.length ?? 0) === 0) return undefined;
        return { runtimeTxs: [], users: [user(disputing!, [{ type: "j_broadcast", data: {} }] as EntityTx[])] };
      }
      case "disputeTimeout": {
        // both clocks jump to the end of the challenge window (og advanceScenarioPastDisputeTimeout); og's live
        // submit stamps chain blocks with the Runtime clock, so the deadline hook's finalize lands after it
        const timeout = disputing === undefined ? undefined : ogAccount(disputing, HUB)?.activeDispute?.disputeTimeout;
        if (timeout === undefined || env.state.timestamp >= Number(timeout) * 1000) return undefined;
        env.state.timestamp = Number(timeout) * 1000;
        rt = { ...rt, timestamp: BigInt(env.state.timestamp) };
        return { runtimeTxs: [], users: [] };
      }
      case "jReserve": {
        await chain.debugFundReserves(ids[ri(4)]!, 1, BigInt(1 + ri(1_000_000)));
        return { runtimeTxs: [], users: [] };
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
    const { random } = plan;
    const queue = [...plan.script];
    // a halted og Runtime refuses every later frame, so a halt ends the run
    while (coverage.frames < plan.frames && frame < 3 * plan.frames && coverage.halts === 0) {
      const kind = queue.length > 0 && rand() < 0.6 ? queue[0]! : random[ri(random.length)]!;
      const planned = await step(kind);
      const chosen = planned ?? { runtimeTxs: [], users: [] };
      if (planned !== undefined && queue[0] === kind) queue.shift();
      count(planned === undefined ? "idle" : kind);
      if (tracing()) console.log(`frame ${frame + 1} ${kind}${planned === undefined ? " (skipped)" : ""}`);
      expectClean(await tick(chosen.runtimeTxs, chosen.users));
    }
    // last, the halt: og refuses the frame and stays halted, so nothing can follow it
    const halting = coverage.halts === 0 ? await step("haltingBroadcast") : undefined;
    count(halting === undefined ? "idle" : "haltingBroadcast");
    if (halting !== undefined) expectClean(await tick(halting.runtimeTxs, halting.users));
    const closed = (x: number, y: number): boolean => {
      const a = ogAccount(x, y);
      return a?.status === "disputed" && a.activeDispute === undefined;
    };
    coverage.disputesFinalized = disputing !== undefined && closed(disputing, HUB) && closed(HUB, disputing) ? 1 : 0;
    return coverage;
  } finally {
    await closeRuntimeDb(env);
    await closeInfraDb(env);
    await chain.close();
    ["", "-storage-current", "-storage-previous", "-wal", "-history-views", "-events", "-infra"].forEach((suffix) =>
      rmSync(join(dbRootPath, ns) + suffix, { recursive: true, force: true }),
    );
  }
};

describe("scenario: og processRuntime vs the rewrite's Runtime, frame by frame", () => {
  const totals = { frames: 0, halts: 0, accountTxs: new Set<string>() };
  SEEDS.forEach((seed) => {
    test(`MATCH: hub world, seed 0x${seed.toString(16)} (${FRAMES} frames)`, async () => {
      const c = await runScenario(seed, HUB_PLAN);
      totals.frames += c.frames;
      totals.halts += c.halts;
      c.accountTxs.forEach((t) => totals.accountTxs.add(t));
      console.log(
        `seed 0x${seed.toString(16)}: ${c.frames} Runtime frames, ${c.entityFrames} Entity frames,`,
        `actions ${stableJson(c.actions)}, Account txs ${[...c.accountTxs].sort().join(",")}`,
      );
      expect(c.frames).toBeGreaterThan(FRAMES / 2);
    }, 600_000);
  });
  test("the seeded scenarios cover 50+ committed Runtime frames, a multi-hop HTLC and a halt", () => {
    expect(totals.frames).toBeGreaterThanOrEqual(50);
    expect(totals.halts).toBeGreaterThan(0);
    expect(totals.accountTxs.has("htlc_lock")).toBe(true);
  });
});

describe("scenario: a unilateral dispute, og vs the rewrite, frame by frame", () => {
  const finalized = { count: 0 };
  SEEDS.forEach((seed) => {
    test(`MATCH: dispute lifecycle, seed 0x${seed.toString(16)}`, async () => {
      const c = await runScenario(seed, DISPUTE_PLAN);
      finalized.count += c.disputesFinalized;
      console.log(`seed 0x${seed.toString(16)}: ${c.frames} Runtime frames, finalized ${c.disputesFinalized}, actions ${stableJson(c.actions)}`);
      expect(c.frames).toBeGreaterThan(FRAMES / 2);
    }, 600_000);
  });
  test("a dispute reaches DisputeFinalized on chain", () => {
    expect(finalized.count).toBeGreaterThan(0);
  });
});
