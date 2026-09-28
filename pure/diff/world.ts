// One single-Runtime world for the runtime-loop differential: a live BrowserVM chain, og's Runtime (its live J
// adapter and watcher attached) and the rewrite's Runtime behind one lane, four board Entities with real keys, and
// readers of og's committed state that steps use for their preconditions. og and the rewrite agree on every root
// after each frame (the lane checks it), so a precondition read from og holds for the rewrite too.
process.env["XLN_LOG_LEVEL"] = process.env["XLN_LOG_LEVEL"] ?? "error";
import { rmSync } from "fs";
import { join } from "path";
import { closeInfraDb, closeRuntimeDb, createEmptyEnv } from "../../core/runtime.ts";
import { registerSignerKey } from "../../core/account/crypto.ts";
import { dbRootPath } from "../../core/runtime/replica/platform.ts";
import { withDeterministicHtlcTestSecret } from "../../core/protocol/htlc/test-secret-capability.ts";
import { getTokenCapacity } from "../../core/pathfinding/capacity.ts";
import { attachLiveJAdapter } from "../../core/runtime/j-submit/live-jadapters.ts";
import { unwrap } from "../xln_run.ts";
import { bootChain, createLane, emptyCoverage, jurisdictionOf, KEYS, prng, SIGNERS, T0, treeClone } from "./lane.ts";
import type { Coverage, Lane, User } from "./lane.ts";
import { createRuntime, htlcPaymentTxHash, lazyBoardEntityId, tokenId } from "../xln.ts";
import type { EntityId, EntityTx, ImportConfig, RuntimeTx } from "../xln.ts";

export const TOKEN = unwrap(tokenId("1"));
export const HUB = 1;
export const SPOKES = [0, 2, 3] as const;
export const NAMES = ["A", "H", "C", "D"];

type ProfileRow = { counterpartyId: string; tokenCapacities: unknown };
/** og's committed Account, as far as steps read it. */
export type OgAccount = {
  status?: string;
  counterpartyDisputeProofHanko?: string;
  activeDispute?: { disputeTimeout: number };
  state?: {
    leftEntity?: string;
    settlementWorkspace?: { workspaceHash: string; status: string; lastModifiedByLeft: boolean; executorIsLeft: boolean };
  };
};
export type OgBatch = { batch?: { disputeStarts?: unknown[] }; sentBatch?: unknown };
type OgEntityState = {
  reserves?: Map<number, bigint>;
  accounts?: Map<string, OgAccount>;
  jBatchState?: OgBatch;
};

export type World = {
  readonly tag: string;
  readonly lane: Lane;
  readonly chain: Awaited<ReturnType<typeof bootChain>>;
  readonly coverage: Coverage;
  readonly ids: readonly EntityId[];
  /** The world's own draws, in order: every random choice a run makes comes from here. */
  readonly rand: () => number;
  readonly ri: (n: number) => number;
  readonly user: (entity: number, txs: readonly EntityTx[]) => User;
  readonly open: (from: number, to: number, credit: bigint) => EntityTx;
  readonly extend: (from: number, to: number, amount: bigint) => EntityTx;
  readonly direct: (from: number, to: number, amount: bigint) => EntityTx;
  readonly htlc: (from: number, to: number, amount: bigint) => EntityTx;
  /** og hopCapacity through the hub: both lanes advertise the token (og's quote throws, a halt, otherwise). */
  readonly routable: (from: number, to: number) => boolean;
  readonly ogState: (x: number) => OgEntityState | undefined;
  readonly ogAccount: (x: number, y: number) => OgAccount | undefined;
  readonly hasAccount: (x: number, y: number) => boolean;
  /** The token reserve og's Entity has observed on chain. */
  readonly reserveOf: (x: number) => bigint;
  readonly batchOf: (x: number) => OgBatch | undefined;
  /** Every Entity's replica and the spokes' hub Accounts, as the first two frames. */
  readonly importAll: () => readonly [readonly RuntimeTx[], readonly User[]];
  readonly close: () => Promise<void>;
};

export const openWorld = async (seed: number, name: string): Promise<World> => {
  const rand = prng(seed);
  const ri = (n: number): number => Math.floor(rand() * n);
  const tag = `WALK_SEED=0x${seed.toString(16)}`;
  const chain = await bootChain();
  const { J, JREPLICA } = jurisdictionOf(chain);
  const ns = `scn-diff-${process.pid}-${name}-${seed.toString(16)}`;
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
  KEYS.forEach((k, i) => registerSignerKey(env, SIGNERS[i]!, Buffer.from(k.slice(2), "hex")));
  const config = (s: string): ImportConfig =>
    ({ mode: "proposer-based", threshold: 1n, validators: [s], shares: { [s]: 1n }, jurisdiction: J }) as ImportConfig;
  const ids = SIGNERS.map((s) => unwrap(lazyBoardEntityId(config(s))).toLowerCase() as EntityId);
  const secrets = new Map<string, string>();
  const gossip = (env as unknown as { gossip?: { getProfile?: (id: string) => unknown } }).gossip;
  const coverage = emptyCoverage();
  // og's deterministic scenario harness (scenarios/harness/helpers.ts): every simulated peer is hosted here, so an
  // Entity is online exactly when this Runtime holds a replica of it
  const online = (x: string): boolean =>
    [...env.state.eReplicas.values()].some((r) => r.entityId.toLowerCase() === x.toLowerCase());
  const lane = createLane({
    tag,
    env,
    runtime: { ...createRuntime([JREPLICA], env.runtimeId), activeJurisdiction: J.name, timestamp: BigInt(T0) },
    ids,
    names: NAMES,
    coverage,
    keyed: new Set(SIGNERS),
    secrets,
    online,
  });

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
  const extend = (_from: number, to: number, amount: bigint): EntityTx => ({
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
  const rowsOf = (x: number): ProfileRow[] =>
    (gossip?.getProfile?.(ids[x]!) as { accounts?: ProfileRow[] } | undefined)?.accounts ?? [];
  const row = (x: number, y: number): ProfileRow | undefined =>
    rowsOf(x).find((r) => r.counterpartyId.toLowerCase() === ids[y]);
  const advertised = (x: number, y: number): boolean => {
    const lane = row(x, y) ?? row(y, x);
    return lane !== undefined && getTokenCapacity(lane.tokenCapacities as never, 1) !== null;
  };
  const routable = (from: number, to: number): boolean => advertised(from, HUB) && advertised(HUB, to);
  const ogState = (x: number): OgEntityState | undefined =>
    [...env.state.eReplicas.values()].find((r) => r.entityId === ids[x])?.state as never;
  const ogAccount = (x: number, y: number): OgAccount | undefined => ogState(x)?.accounts?.get(ids[y]!);
  const importAll = (): readonly [readonly RuntimeTx[], readonly User[]] => [
    SIGNERS.map(
      (s, i): RuntimeTx =>
        ({
          type: "importReplica",
          entityId: ids[i]!,
          signerId: s,
          data: { config: config(s), isProposer: true, entitySeed: `0x${String(i + 1).repeat(128)}` },
        }) as RuntimeTx,
    ),
    SPOKES.map((s) => user(s, [open(s, HUB, BigInt(1 + ri(20_000)))])),
  ];
  const close = async (): Promise<void> => {
    await closeRuntimeDb(env);
    await closeInfraDb(env);
    await chain.close();
    ["", "-storage-current", "-storage-previous", "-wal", "-history-views", "-events", "-infra"].forEach((suffix) =>
      rmSync(join(dbRootPath, ns) + suffix, { recursive: true, force: true }),
    );
  };
  return {
    tag,
    lane,
    chain,
    coverage,
    ids,
    rand,
    ri,
    user,
    open,
    extend,
    direct,
    htlc,
    routable,
    ogState,
    ogAccount,
    hasAccount: (x, y) => ogState(x)?.accounts?.has(ids[y]!) ?? false,
    reserveOf: (x) => ogState(x)?.reserves?.get(1) ?? 0n,
    batchOf: (x) => ogState(x)?.jBatchState,
    importAll,
    close,
  };
};
