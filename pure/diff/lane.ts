// One Runtime lane of a scenario differential: an og Runtime (processRuntime over a real RuntimeReplica) and the
// rewrite's Runtime (runtimeWake + commitRuntimeFrame) driven with identical inputs, compared after every frame.
// diff/scenario.test.ts runs one lane; diff/scenario-cross-j.test.ts runs two, relaying each lane's remote outputs
// into the other the way og's direct Runtime transport does.
import { installContracts } from "./contracts.ts";
import {
  enqueueRuntimeInput,
  getRuntimeWalDb,
  handleInboundP2PEntityInputs,
  processRuntime,
} from "../../core/runtime.ts";
import { readStorageFrameRecord } from "../../core/storage/read/read.ts";
import {
  computeRuntimePostStateComponentDigests,
  prepareStorageCanonicalStateHashes,
} from "../../core/storage/hashes.ts";
import { buildStorageLiveReplicaMetaCommitment } from "../../core/storage/replica/replicas.ts";
import { buildReplayVerifiableRuntimePostStateView } from "../../core/storage/wal/snapshot.ts";
import { decodeBuffer } from "../../core/storage/codec/codec.ts";
import { projectCertifiedEntityFrameLinkIdentity } from "../../core/entity/consensus/frame/lineage.ts";
import { createJAdapter } from "../../core/jurisdiction/adapter/index.ts";
import { canonicalTsAccountWorkerCount, TsAccountWorkerAuthority } from "../../core/rscore/ts-worker/provider.ts";
import type { JAdapter } from "../../core/jurisdiction/adapter/types.ts";
import { deliveryAccepted } from "../../core/protocol/payments/delivery-result.ts";
import { ANVIL_KEYS, MORE_ANVIL_KEYS, signDigestHex, signerAddress, unwrap, verifiers } from "../xln_run.ts";
import { accountLines, inputsLine, routedLine, tracing } from "./scenario-trace.ts";
import { haltDeparture } from "./departures.ts";
import {
  canonicalEntityHashes,
  convertOutput,
  localNetworkOutputs,
  ok,
  processRuntimeFrame,
  recoverRawSigner,
  replicaKey,
  replicaMetaRows,
  replicaWakes,
  retireNetworkOutputs,
  routeKeyOf,
  runtimeComponentDigests,
  runtimeView,
  runtimeWake,
  signature,
  stableJson,
  wireEntityTx,
  type EntityId,
  type EntityOutput,
  type EntityTx,
  type JReplica,
  type NetworkOutput,
  type RoutedEntityInput,
  type Runtime,
  type RuntimeRoutes,
  type RuntimeTx,
  type SourceRuntimeFrame,
} from "../xln.ts";

export const T0 = 1_700_000_000_000;

/** Anvil account #3 (xln_run MORE_ANVIL_KEYS[0]): Entity D's signer, which the lane signs for with its own key. */
const EXTRA_KEY = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6";
const EXTRA_SIGNER = signerAddress(EXTRA_KEY);
/** Anvil accounts #4 and #5: the numbered Entities' sole validators (xln_run's verifiers sign for #3-#9). */
const NUMBERED_KEYS = MORE_ANVIL_KEYS.slice(1, 3);
export const KEYS = [...ANVIL_KEYS, EXTRA_KEY, ...NUMBERED_KEYS];
export const SIGNERS = KEYS.map((k) => signerAddress(k));
const sign: typeof verifiers.sign = (h, addr) =>
  addr.toLowerCase() === EXTRA_SIGNER
    ? ok(unwrap(signature(signDigestHex(h, EXTRA_KEY).slice(2))))
    : verifiers.sign(h, addr);
const verifyMember: typeof verifiers.verifyMember = (h, sig, addr) =>
  addr.toLowerCase() === EXTRA_SIGNER
    ? (recoverRawSigner(h, sig) ?? "").toLowerCase() === EXTRA_SIGNER
    : verifiers.verifyMember(h, sig, addr);
export const CRYPTO = { ...verifiers, sign, verifyMember };

/** og's in-memory EVM with the real Depository stack: the chain both sides observe. */
// Bun (1.3.11 and og CI's 1.4.0) segfaults when a Worker loads the native secp256k1 addon after an earlier Worker that
// loaded it was terminated, and the harness terminates og's Account workers (holdAccountWorkers). An empty prebuild dir
// makes node-gyp-build find no binary, so the secp256k1 package falls back to its own JS build (its index.js): the
// same API and deterministic signatures. og's crypto.ts already treats the addon as optional
process.env["SECP256K1_PREBUILD"] = process.env["SECP256K1_PREBUILD"] ?? "/nonexistent";

/**
 * og's Account worker pool for one Runtime, installed the way og installTsAccountWorkerAuthority
 * (rscore/ts-worker/provider.ts) does on the first frame, which then returns early. og keeps no handle on env, so its
 * own pool's threads (one per worker per Entity replica) live until the process exits; the harness closes this one
 * when it closes the Runtime. The harness never sets XLN_TS_ACCOUNT_WORKERS=0, og's inline mode.
 */
export const holdAccountWorkers = (
  env: ConstructorParameters<typeof TsAccountWorkerAuthority>[0],
): TsAccountWorkerAuthority => {
  const workers = new TsAccountWorkerAuthority(env, canonicalTsAccountWorkerCount());
  env.accountAuthorityExecutionMode = "cutover";
  env.accountAuthorityEntityStageProvider = workers.provider;
  return workers;
};

export const bootChain = async (chainId = 31337): Promise<JAdapter> => {
  installContracts();
  const chain = await createJAdapter({ mode: "browservm", chainId } as never);
  await chain.deployStack();
  chain.setQuietLogs?.(true);
  return chain;
};
export const jurisdictionOf = (chain: JAdapter, name = "Scn") => {
  const J = {
    name,
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

/** mulberry32. */
export const prng = (seed: number) => {
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
export const treeClone = <T>(v: T): T => {
  if (v === null || typeof v !== "object") return v;
  if (v instanceof Uint8Array) return new Uint8Array(v) as T;
  if (v instanceof Map) return new Map([...v].map(([k, x]) => [treeClone(k), treeClone(x)])) as T;
  if (v instanceof Set) return new Set([...v].map(treeClone)) as T;
  if (Array.isArray(v)) return v.map(treeClone) as T;
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, treeClone(x)])) as T;
};
/** Plain JSON view (bigints tagged), so og and rewrite values compare structurally. */
export const plain = (v: unknown): unknown => JSON.parse(stableJson(v));
/** The first differing leaves of two plain values, as `path: og=… rw=…`. */
export const leafDiffs = (
  a: unknown,
  b: unknown,
  at = "",
  out: string[] = [],
  limit = Number(process.env["SCN_DIFFS"] ?? 6),
): string[] => {
  if (out.length >= limit) return out;
  const both = a !== null && b !== null && typeof a === "object" && typeof b === "object";
  if (both) {
    const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
    keys.forEach((k) =>
      leafDiffs((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${at}.${k}`, out, limit),
    );
    return out;
  }
  const [x, y] = [stableJson(a), stableJson(b)];
  if (x !== y) out.push(`${at || "."}: og=${x.slice(0, 160)} rw=${y.slice(0, 160)}`);
  return out;
};

/**
 * One user input: the Entity it goes to and, when a member of a multi-signer board authors it, that member's index
 * into SIGNERS (og binds the command's signer as the author, e.g. vote.voter in entity/command/command-codec.ts).
 */
export type User = { readonly entity: number; readonly txs: readonly EntityTx[]; readonly signer?: number };
export type Coverage = {
  frames: number;
  entityFrames: number;
  /** Frames og halted on (a local bug by og's taxonomy) and the rewrite refused. */
  halts: number;
  /** og's failure text for each of those halts, in order. */
  haltTexts: string[];
  /** Frames og halted on where the rewrite departs on purpose (departures.ts); the two states differ from then on. */
  departures: string[];
  /** Disputes both sides saw finalized on chain (the Account stays frozen, its active dispute cleared). */
  disputesFinalized: number;
  actions: Record<string, number>;
  accountTxs: Set<string>;
  /** Entity tx kinds that were inputs of a frame both sides committed (whether their handler accepted or refused). */
  entityTxs: Set<string>;
};
export const emptyCoverage = (): Coverage => ({
  frames: 0,
  entityFrames: 0,
  halts: 0,
  haltTexts: [],
  departures: [],
  disputesFinalized: 0,
  actions: {},
  accountTxs: new Set(),
  entityTxs: new Set(),
});

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
type OgInput = {
  entityId: string;
  signerId: string;
  from?: string;
  entityTxs?: { type: string; data?: unknown }[];
  jPrefixAttestations?: Map<string, unknown>;
};
type OgMempool = { runtimeTxs: RuntimeTx[]; entityInputs: OgInput[] };
/** An og queued input's route and consensus shape: its lane, and what it carries at which height. */
const ogShape = (i: OgInput): string => {
  const o = i as OgInput & {
    proposedFrame?: { height: number };
    hashPrecommitFrame?: { height: number };
    hashPrecommits?: Map<string, unknown>;
  };
  const payload = (): string => {
    if (o.proposedFrame) return `proposal@${o.proposedFrame.height}`;
    if (o.hashPrecommits?.size) return `precommit@${o.hashPrecommitFrame?.height}:${[...o.hashPrecommits.keys()]}`;
    if (o.jPrefixAttestations) return `jPrefix:${[...o.jPrefixAttestations.keys()]}`;
    return `txs:${(o.entityTxs ?? []).map((tx) => tx.type)}`;
  };
  return `${o.entityId.toLowerCase()}:${o.signerId.toLowerCase()}:${o.from ?? "local"} ${payload()}`;
};
/** The rewrite's routed input in ogShape's terms. */
const rwShape = (r: RoutedEntityInput): string => {
  const i = r.input;
  const payload = (): string => {
    switch (i.kind) {
      case "proposal":
        return `proposal@${i.frame.height}`;
      case "precommit":
        return `precommit@${i.height}:${[...i.signatures.keys()]}`;
      case "jPrefixAttestations":
        return `jPrefix:${[...i.attestations.keys()]}`;
      case "txs":
        return `txs:${i.txs.map((tx) => tx.type)}`;
      default:
        return i.kind;
    }
  };
  return `${r.entityId.toLowerCase()}:${r.signerId.toLowerCase()}:${r.from ?? "local"} ${payload()}`;
};
type OgEnv = ReturnType<typeof import("../../core/runtime.ts").createEmptyEnv>;
/** One og direct-transport envelope (core/runtime/delivery/dispatch.ts). */
type OgEnvelope = {
  sourceRuntimeId: string;
  sourceRuntimeHeight: number;
  sourceRuntimeTimestamp: number;
  entityInputs: OgInput[];
};
/** What one lane's frame sent to another Runtime: og's envelopes and the rewrite's own remote inputs. */
export type Outgoing = { readonly og: readonly OgEnvelope[]; readonly rw: readonly Shipped[] };
/** One of the rewrite's remote rows, keyed by what og's envelope carries of it, and the input it arrives as. */
type Shipped = { readonly key: string; readonly input: RoutedEntityInput };
/** A wire tx as the transport compares it. */
const wireKey = (tx: unknown): string => stableJson(plain(tx));
/**
 * A value with every Map spelled out as its entries in order: stableJson alone reads a Map as `{}`, so rows differing
 * only in their J-prefix attestations (keyed by author) would share one key.
 */
const mapsSpelled = (v: unknown): unknown => {
  if (v instanceof Map) return { __map: [...v].map(([k, x]) => [mapsSpelled(k), mapsSpelled(x)]) };
  if (v === null || typeof v !== "object" || v instanceof Uint8Array) return v;
  if (Array.isArray(v)) return v.map(mapsSpelled);
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapsSpelled(x)]));
};
/** An output row as og's envelope carries it: its source frame and atomic cohort move to the envelope. */
const rowKey = (row: unknown): string => {
  const { sourceRuntimeFrame: _frame, atomicCrossJurisdictionPair: _pair, ...carried } = row as Record<string, unknown>;
  return stableJson(mapsSpelled(carried));
};

/** One local continuation under its og route key. */
type Slot = readonly [string, RoutedEntityInput];
/**
 * og dedupeEntityOutputs (the rewrite's dedupeNetwork) over the host's local continuations: outputs on one route key
 * share the first one's slot, a later one's txs appended, so the wakes several txs send one Entity are one input.
 */
const slotted = (continuations: readonly Slot[]): readonly RoutedEntityInput[] =>
  continuations
    .reduce<readonly Slot[]>((slots, [key, next]) => {
      const at = slots.findIndex(([k]) => k === key);
      if (at < 0) return [...slots, [key, next]];
      const first = slots[at]![1];
      const appended =
        first.input.kind === "txs" && next.input.kind === "txs" && next.input.txs.length > 0
          ? { ...first, input: { ...first.input, txs: [...first.input.txs, ...next.input.txs] } }
          : first;
      return slots.map((slot, i): Slot => (i === at ? [key, appended] : slot));
    }, [])
    .map(([, continuation]) => continuation);

/**
 * og's watcher input: a validator's own J-prefix attestation, keyed by the input's own signer (og
 * jurisdiction/adapter/events/history-ingress.ts). A board member's relay of it to the others (og
 * rebroadcastLocalAttestation in entity/consensus/j-prefix/prefix-input.ts) is keyed by its author, another member,
 * and is an Entity output like any other.
 */
const watched = (i: { signerId: string; jPrefixAttestations?: Map<string, unknown> }): boolean => {
  const authors = [...(i.jPrefixAttestations?.keys() ?? [])];
  return authors.length > 0 && authors.every((a) => a.toLowerCase() === i.signerId.toLowerCase());
};

export type LaneConfig = {
  /** Prefixes every difference (the seed, and the lane's name when there are several). */
  readonly tag: string;
  readonly env: OgEnv;
  readonly runtime: Runtime;
  /** Every Entity of the world by index, and its display name. */
  readonly ids: readonly EntityId[];
  readonly names: readonly string[];
  readonly coverage: Coverage;
  /** The signers whose keys this Runtime holds. */
  readonly keyed: ReadonlySet<string>;
  readonly secrets: ReadonlyMap<string, string>;
  /** og EntityRuntimeContext liveness. */
  readonly online: (entityId: string) => boolean;
  /** The rewrite's transport view of Entities hosted elsewhere (og verifiedProfileRoutes). */
  readonly routes?: RuntimeRoutes | undefined;
  /** Each Entity's own signer, as an index into SIGNERS (the Entity's own index when absent). */
  readonly signerOf?: (entity: number) => number;
};
export type Lane = {
  readonly env: OgEnv;
  readonly runtime: () => Runtime;
  /** Frames ticked so far. */
  readonly frames: () => number;
  /** Both clocks jump together (og advanceScenarioPastDisputeTimeout). */
  readonly jumpClock: (timestamp: number) => void;
  /** One Runtime frame on both sides; the differences found after it. */
  readonly tick: (runtimeTxs: readonly RuntimeTx[], users: readonly User[]) => Promise<string[]>;
  /** What the last frame sent to other Runtimes (drained). */
  readonly drain: () => Outgoing;
  /** Another Runtime's outputs arrive: og through its authenticated ingress, the rewrite as remote inputs. */
  readonly deliver: (sent: Outgoing) => void;
};

export const createLane = (cfg: LaneConfig): Lane => {
  const { env, ids, names, coverage, tag } = cfg;
  /** The signer a user input is submitted as: the chosen member, else the Entity's own signer. */
  const userSigner = (u: User): string => SIGNERS[u.signer ?? cfg.signerOf?.(u.entity) ?? u.entity]!;
  let rt = cfg.runtime;
  let frame = 0;
  let pending: readonly RoutedEntityInput[] = [];
  /** The inputs the rewrite's entity-height barrier requeued last frame: og holds them at the front of its mempool. */
  let deferred: readonly RoutedEntityInput[] = [];
  let arrived: readonly RoutedEntityInput[] = [];
  let sent: { og: OgEnvelope[]; rw: readonly Shipped[] } = { og: [], rw: [] };
  /**
   * The host's own queue for the next frame, as og's host loop builds it after a frame: the local continuations
   * (applyOutputPlan), then the plan-time wake (generateHookPings in planRuntimeFrameOutputs: due pings and J-submit
   * retries), then the frame's J-submit retries.
   */
  let own: { runtimeTxs: readonly RuntimeTx[]; pings: readonly RoutedEntityInput[]; local: Set<unknown> } = {
    runtimeTxs: [],
    pings: [],
    local: new Set(),
  };
  const localIds = (): Set<string> => new Set([...env.state.eReplicas.values()].map((r) => r.entityId.toLowerCase()));
  const keyed = (s: string): boolean => cfg.keyed.has(s.toLowerCase());
  const infrastructure = (env.infrastructure ?? {}) as {
    observeOnlineEntityIds?: (ids: readonly string[]) => Set<string>;
    directEntityInputsDispatch?: (target: string, envelope: OgEnvelope) => unknown;
  };
  infrastructure.observeOnlineEntityIds = (xs) => new Set(xs.map((x) => x.toLowerCase()).filter(cfg.online));
  // og's direct transport: every envelope is accepted and carried to its Runtime by the harness
  infrastructure.directEntityInputsDispatch = (_target, envelope) => {
    sent.og.push(treeClone(envelope));
    return deliveryAccepted();
  };
  env.infrastructure = infrastructure as never;
  const gossip = (env as unknown as { gossip?: { getProfile?: (id: string) => unknown } }).gossip;
  const profiles = (): unknown[] =>
    ids.flatMap((id) => {
      const p = gossip?.getProfile?.(id);
      return p === undefined ? [] : [treeClone(p)];
    });
  const ogMempool = (): OgMempool =>
    (env.runtimeMempool ?? { runtimeTxs: [], entityInputs: [] }) as unknown as OgMempool;
  /**
   * og's queued inputs in its own arrival order, rebuilt on the rewrite's side: the barrier's deferred inputs lead
   * (og applyEntityHeightDurabilityBarrier puts them ahead of its mempool), the watcher's attestations stand where og
   * queued them, a remote input (it carries its source Runtime) is the next one delivered, anything else is
   * the next local continuation we carry (which the previous frame already proved equal to og's).
   */
  const hostInputs = (carried: readonly RoutedEntityInput[]) => {
    const mempool = ogMempool();
    const attestation = (i: OgInput): RoutedEntityInput =>
      ({
        entityId: i.entityId as EntityId,
        signerId: i.signerId,
        input: { kind: "jPrefixAttestations", attestations: treeClone(i.jPrefixAttestations!) },
      }) as unknown as RoutedEntityInput;
    type Weave = { out: RoutedEntityInput[]; local: number; remote: number };
    const woven = mempool.entityInputs.slice(deferred.length).reduce<Weave>((acc, i) => {
      if (watched(i)) return { ...acc, out: [...acc.out, attestation(i)] };
      if (i.from !== undefined) {
        return { ...acc, out: [...acc.out, ...arrived.slice(acc.remote, acc.remote + 1)], remote: acc.remote + 1 };
      }
      return { ...acc, out: [...acc.out, ...carried.slice(acc.local, acc.local + 1)], local: acc.local + 1 };
    }, { out: [], local: 0, remote: 0 });
    const runtimeTxs = treeClone(mempool.runtimeTxs.filter((tx) => IO_TXS.has(tx.type)));
    const rest = [...carried.slice(woven.local), ...arrived.slice(woven.remote)];
    return { runtimeTxs, entityInputs: [...deferred, ...woven.out, ...rest] };
  };
  const ogEntityHeights = (): number =>
    [...env.state.eReplicas.values()].reduce((sum, r) => sum + Number(r.state.height), 0);

  /**
   * The rewrite's remote inputs of one frame, one per og output row: each row's txs are the typed txs of the outbox
   * that carry exactly its wire txs (og's dedupe keeps the latest of an Entity's outputs, so a row may skip an earlier
   * superseded one), with its source Runtime, addressed Runtime and source frame, as og's ingress stamps them.
   */
  const remoteInputs = (after: Runtime, outbox: readonly EntityOutput[], rows: readonly NetworkOutput[]) => {
    const local = localIds();
    const txsOf = (o: EntityOutput): readonly EntityTx[] => {
      if ("tx" in o) return [o.tx];
      return o.input.kind === "txs" ? o.input.txs : [];
    };
    type Typed = { readonly to: string; readonly key: string; readonly tx: EntityTx };
    const typed = outbox
      .filter((o) => !local.has(o.to.toLowerCase()))
      .flatMap((o) => txsOf(o).map((tx): Typed => ({ to: o.to.toLowerCase(), key: wireKey(wireEntityTx(tx)), tx })));
    /** The row's wire txs, each taken as the latest unused typed tx to its Entity with the same wire form. */
    const pick = (to: string, wire: readonly unknown[], used: ReadonlySet<Typed>): readonly Typed[] =>
      wire.reduce<readonly Typed[]>((taken, w) => {
        const key = wireKey(w);
        const match = typed.findLast((t) => t.to === to && t.key === key && !used.has(t) && !taken.includes(t));
        return match === undefined ? taken : [...taken, match];
      }, []);
    type Taken = { readonly used: ReadonlySet<Typed>; readonly out: readonly Shipped[] };
    const taken = rows.reduce<Taken>((acc, row) => {
      const to = String(row["entityId"]).toLowerCase();
      const wire = Array.isArray(row["entityTxs"]) ? (row["entityTxs"] as readonly unknown[]) : [];
      const picked = pick(to, wire, acc.used);
      const frame = row["sourceRuntimeFrame"] as unknown as SourceRuntimeFrame;
      const input: RoutedEntityInput = {
        entityId: to as EntityId,
        signerId: String(row["signerId"]),
        from: String(after.runtimeId ?? ""),
        runtimeId: String(row["runtimeId"]),
        sourceRuntimeFrame: frame,
        ...(row["atomicCrossJurisdictionPair"] === undefined
          ? {}
          : { atomicCrossJurisdictionPair: row["atomicCrossJurisdictionPair"] as never }),
        input: { kind: "txs", timestamp: BigInt(frame.timestamp), txs: picked.map((t) => t.tx) },
      };
      const shipped = { key: rowKey(row), input };
      const used = new Set([...acc.used, ...picked]);
      return { used, out: picked.length === 0 ? acc.out : [...acc.out, shipped] };
    }, { used: new Set(), out: [] });
    return taken.out;
  };

  const tick = async (runtimeTxs: readonly RuntimeTx[], users: readonly User[]): Promise<string[]> => {
    frame += 1;
    const label = `${tag} frame=${frame}`;
    const known = profiles();
    const entityInputs = users.map((u) => ({
      entityId: ids[u.entity]!,
      signerId: userSigner(u),
      entityTxs: treeClone(u.txs.map(wireEntityTx)),
    }));
    const host = hostInputs([...pending, ...own.pings]);
    arrived = [];
    if (runtimeTxs.length + users.length > 0) {
      enqueueRuntimeInput(env, { runtimeTxs: treeClone(runtimeTxs), entityInputs } as never);
    }
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
      signerId: userSigner(u),
      input: { kind: "txs", timestamp: BigInt(now), txs: u.txs },
    }));
    // og enqueueRuntimeInput appends after the local continuations the previous frame re-enqueued
    const queued = {
      runtimeTxs: [...own.runtimeTxs, ...host.runtimeTxs, ...runtimeTxs],
      entityInputs: [...host.entityInputs, ...userIn],
    };
    // og's host opens a frame only for work (hasRuntimeWork): with nothing queued, a hook must already be due at the
    // committed clock; once a frame opens, its wakes are generated at the frame's own timestamp
    const idle = queued.runtimeTxs.length + queued.entityInputs.length === 0;
    const due = runtimeWake(rt, Number(rt.timestamp), queued, keyed).input;
    const owed = replicaWakes(rt, Number(rt.timestamp), queued.entityInputs).length > 0;
    const opens = !idle || owed || due.runtimeTxs.length + due.entityInputs.length > 0;
    const quiet = { input: { runtimeTxs: [], entityInputs: [] }, local: new Set() };
    const wake = opens ? runtimeWake(rt, now, queued, keyed) : quiet;
    // og buildRuntimeFrameInput: the replicas' own proposal wakes follow everything queued
    const named = [...queued.entityInputs, ...wake.input.entityInputs];
    const automatic = opens ? replicaWakes(rt, now, named) : [];
    if (tracing()) console.log("INPUTS", inputsLine(queued.entityInputs));
    const input = {
      runtimeTxs: [...queued.runtimeTxs, ...wake.input.runtimeTxs],
      entityInputs: [...named, ...automatic],
      timestamp: BigInt(now),
    };
    const local = new Set([...wake.local, ...own.local, ...host.runtimeTxs] as never[]);
    const htlcInfra = () => ({
      profiles: known as never[],
      online: cfg.online,
      secretFor: (h: string) => cfg.secrets.get(h),
    });
    const runtimeSeed = (env as unknown as { runtimeSeed?: string }).runtimeSeed;
    // og admission signs every local tx into the replica's own Entity command (prepareLocallyAuthoredEntityTxs)
    const run = processRuntimeFrame(rt, input, { ...CRYPTO, local, htlcInfra, routes: cfg.routes, runtimeSeed });
    const committed = run.ok ? ok(run.value.commit) : run;
    if (ogHalt !== undefined && committed.ok) {
      // the rewrite may commit a frame og halts on only as a named departure, and only doing what it names
      const departure = haltDeparture(ogHalt);
      if (departure === undefined) return [`${label} og halted (${ogHalt}) but the rewrite committed`];
      const wrong = departure.instead(committed.value === null ? rt : committed.value.runtime);
      if (wrong !== null) return [`${label} ${departure.name}: ${wrong}`];
      coverage.departures.push(`${label} ${departure.name}`);
      return [];
    }
    if (ogHalt !== undefined && !committed.ok) {
      coverage.halts += 1;
      coverage.haltTexts.push(ogHalt);
      // both refuse the frame, and for the same reason: the rewrite's refusal code is og's halt text, or the whole
      // failure message og's Account worker wrapped into it (`...TS_ACCOUNT_WORKER_FATAL:<n>:<text>\n<stack>`)
      const refusal = String((committed.error as { code?: unknown }).code ?? "");
      const wrapped = [`:${refusal}\\n`, `:${refusal}\n`].some((w) => ogHalt.includes(w));
      const same = refusal === ogHalt || (refusal !== "" && wrapped);
      return same ? [] : [`${label} og halted (${ogHalt}) but the rewrite refused ${stableJson(committed.error)}`];
    }
    if (!committed.ok) return [`${label} rewrite refused the frame: ${stableJson(committed.error)}`];
    const c = committed.value;
    const after = c === null ? rt : c.runtime;
    const diffs: string[] = [];
    const cmp = (what: string, og: unknown, rw: unknown): void => {
      leafDiffs(plain(og), plain(rw), "", [], 1000)
        .slice(0, Number(process.env["SCN_DIFFS"] ?? 6))
        .forEach((d) => diffs.push(`${label} ${what}${d}`));
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
      cmp(`head[${names[ids.indexOf(r.entityId as EntityId)]}]`, head ?? null, mine?.certifiedFrameHead ?? null);
    });
    cmp(
      "components",
      computeRuntimePostStateComponentDigests(buildReplayVerifiableRuntimePostStateView(env as never)),
      unwrap(runtimeComponentDigests(runtimeView(after))),
    );
    cmp("advanced", rec !== undefined, c !== null);
    if (rec !== undefined && c !== null && !rec.materializedState) {
      cmp("postStateHash", rec.postStateHash, c.frame.postStateHash);
    }
    const planWake = c === null ? undefined : runtimeWake(after, Number(after.timestamp), undefined, keyed);
    const pings = planWake?.input.entityInputs ?? [];
    const pingWire = pings.map((p) => ({
      entityId: p.entityId,
      signerId: p.signerId,
      entityTxs: p.input.kind === "txs" ? p.input.txs.map(wireEntityTx) : [],
    }));
    // og's mempool leads with the inputs its barrier deferred, then the frame's routed continuations
    const rwDeferred = run.ok ? run.value.deferred : [];
    const ogQueue = ogMempool().entityInputs;
    cmp("deferred", ogQueue.slice(0, rwDeferred.length).map(ogShape), rwDeferred.map(rwShape));
    const ogRouted = ogQueue.slice(rwDeferred.length).filter((i) => !watched(i));
    const rwRouted = c === null ? [] : [...unwrap(localNetworkOutputs(c.runtime, c.outbox, cfg.routes)), ...pingWire];
    cmp("routed", ogRouted, rwRouted);
    // what og's transport carried off this frame is exactly the retained outbox the rewrite committed
    // og's envelope carries the source frame once, for all its rows
    const ogRemote = sent.og.flatMap((e) => e.entityInputs);
    const ogFrames = sent.og.flatMap((e) =>
      e.entityInputs.map(() => ({ height: e.sourceRuntimeHeight, timestamp: e.sourceRuntimeTimestamp })));
    const rwRows = c === null ? [] : c.runtimeOutputs;
    // og's dispatch regroups the rows into envelopes (atomic cross-j cohorts first): the same rows, in its order
    const sorted = (keys: readonly string[]): readonly unknown[] => [...keys].sort().map((k) => JSON.parse(k));
    cmp("remote", sorted(ogRemote.map(rowKey)), sorted(rwRows.map(rowKey)));
    const frames = (xs: readonly unknown[]): readonly string[] => xs.map((f) => stableJson(plain(f))).sort();
    cmp("remoteFrame", frames(ogFrames), frames(rwRows.map((row) => row["sourceRuntimeFrame"])));
    [...ogRouted, ...ogRemote].forEach((routed) =>
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
      input.entityInputs.forEach(({ input: i }) =>
        (i.kind === "txs" ? i.txs : []).forEach((tx) => coverage.entityTxs.add(tx.type)));
    }
    const ogQueued = ogMempool().runtimeTxs;
    const ownTxs = c === null ? own.runtimeTxs : [...planWake!.input.runtimeTxs, ...c.queuedRetries];
    cmp("queued", ogQueued.filter((tx) => !IO_TXS.has(tx.type)), ownTxs);
    // og's own queue precedes its I/O results: the post-commit submit and the watcher run after the host re-queues
    const firstIo = ogQueued.findIndex((tx) => IO_TXS.has(tx.type));
    cmp("queueOrder", ogQueued.slice(firstIo < 0 ? ogQueued.length : firstIo).every((tx) => IO_TXS.has(tx.type)), true);
    if (tracing() && diffs.length > 0) {
      console.log(`OG ROUTED ${routedLine(ogRouted)}\nRW ROUTED ${routedLine(rwRouted)}`);
      console.log(`OG REMOTE ${routedLine(ogRemote)}\nRW REMOTE ${routedLine(c?.runtimeOutputs ?? [])}`);
      if (c !== null && c.rejected.length > 0) console.log("RW REJECTED", stableJson(c.rejected).slice(0, 3000));
      const name = (id: string): string => names[ids.indexOf(id as EntityId)] ?? id.slice(-4);
      [...env.state.eReplicas.values()].forEach((r) => {
        const mine = after.entities.get(replicaKey(r.entityId as EntityId, r.signerId));
        const accounts = r.state.accounts as unknown as ReadonlyMap<string, Record<string, unknown>>;
        const diff = (og: unknown, rw: unknown) => leafDiffs(plain(og), plain(rw));
        accountLines(accounts, mine, name, name(r.entityId), diff).forEach((line) => console.log(line));
      });
    }
    // a frame that commits nothing re-enqueues nothing: og drained its mempool into the frame and keeps no input but
    // the ones its barrier deferred, which lead the next frame's queue either way
    deferred = rwDeferred;
    own =
      c === null
        ? { ...own, pings: [] }
        : { runtimeTxs: ownTxs, pings, local: new Set([...planWake!.local, ...c.queuedRetries]) };
    if (c === null) pending = [];
    (c?.jOutbox ?? []).forEach((j) =>
      j.jTxs.forEach((t) => coverage.accountTxs.add(`j:${(t as { type: string }).type}`)));
    if (c !== null) {
      const rows = c.runtimeOutputs;
      const shipped = remoteInputs(c.runtime, c.outbox, rows);
      // og's dispatch retires every output its transport accepted; the harness transport accepts them all
      rt = sent.og.length > 0 ? retireNetworkOutputs(c.runtime, () => true) : c.runtime;
      sent = { og: sent.og, rw: shipped };
      const localTo = localIds();
      // og's host re-enqueues its own continuations without transport provenance (no `from`), one per route key as its
      // output plan dedupes them (localNetworkOutputs), so the hostInputs weave pairs them one to one with og's queue
      const continuations = c.outbox
        .filter((o) => localTo.has(o.to.toLowerCase()))
        .map((o): Slot => {
          const { from: _local, ...routed } = unwrap(convertOutput(rt, o, o.to, rt.timestamp));
          const routedRows = unwrap(localNetworkOutputs(rt, [o], cfg.routes));
          const key = routedRows.map((row) => unwrap(routeKeyOf(row))).join("\n");
          return [key, routed];
        });
      pending = slotted(continuations);
    }
    return diffs;
  };

  const drain = (): Outgoing => {
    const out = sent;
    sent = { og: [], rw: [] };
    return out;
  };
  const deliver = (incoming: Outgoing): void => {
    incoming.og.forEach((envelope) => {
      const source = envelope.sourceRuntimeId;
      const verified = { envelopeSourceVerified: true, entityInputsValidated: true };
      handleInboundP2PEntityInputs(env, source, envelope as never, env.state.timestamp, verified as never);
    });
    // the rewrite's rows arrive in og's envelope order, each matched to the row og carried
    type Match = { readonly left: readonly Shipped[]; readonly out: readonly RoutedEntityInput[] };
    const ordered = incoming.og
      .flatMap((e) => e.entityInputs.map(rowKey))
      .reduce<Match>((acc, key) => {
        const at = acc.left.findIndex((x) => x.key === key);
        if (at < 0) return acc;
        return { left: acc.left.filter((_, i) => i !== at), out: [...acc.out, acc.left[at]!.input] };
      }, { left: incoming.rw, out: [] });
    arrived = [...arrived, ...ordered.out, ...ordered.left.map((x) => x.input)];
  };
  const jumpClock = (timestamp: number): void => {
    env.state.timestamp = timestamp;
    rt = { ...rt, timestamp: BigInt(timestamp) };
  };
  return { env, runtime: () => rt, frames: () => frame, jumpClock, tick, drain, deliver };
};
