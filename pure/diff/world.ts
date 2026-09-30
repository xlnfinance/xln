// One single-Runtime world for the runtime-loop differential: a live BrowserVM chain, og's Runtime (its live J
// adapter and watcher attached) and the rewrite's Runtime behind one lane, four board Entities with real keys, a 2-of-3
// board, two numbered Entities registered on chain, and readers of og's committed state that steps use for their
// preconditions. og and the rewrite agree on every root
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
import type { BrowserVMProvider } from "../../core/jurisdiction/adapter/browservm/browservm-provider.ts";
import {
  getCertifiedBoardNodeStore,
  getCertifiedBoardStackKey,
  resolveObserverCertifiedBoardRecord,
} from "../../core/jurisdiction/machine/board-registry/index.ts";
import { registrationEvidenceKey } from "../../core/jurisdiction/machine/registration-evidence/index.ts";
import { unwrap } from "../xln_run.ts";
import { contractSet } from "./contracts.ts";
import { shimBatchSubmission } from "./fork-shim.ts";
import {
  bootChain,
  createLane,
  emptyCoverage,
  holdAccountWorkers,
  jurisdictionOf,
  KEYS,
  prng,
  SIGNERS,
  T0,
  treeClone,
} from "./lane.ts";
import type { Coverage, Lane, User } from "./lane.ts";
import { createRuntime, htlcPaymentTxHash, lazyBoardEntityId, tokenId } from "../xln.ts";
import type { EntityId, EntityTx, ImportConfig, RuntimeTx } from "../xln.ts";

export const TOKEN = unwrap(tokenId("1"));
export const HUB = 1;
export const SPOKES = [0, 2, 3] as const;
/**
 * One Entity of the world: its board as indexes into SIGNERS in board order (board index 0 proposes), its threshold,
 * and its kind: numbered (registered on chain, so it holds a certified board record) or lazy (its id is its board
 * hash).
 */
type Member = {
  readonly name: string;
  readonly board: readonly number[];
  readonly threshold: bigint;
  readonly kind: "lazy" | "numbered";
};
const soleSigner = (name: string, signer: number, kind: Member["kind"]): Member => ({
  name,
  board: [signer],
  threshold: 1n,
  kind,
});
/** Two numbered 1-of-1 Entities, each over a signer of its own; each can target the other. */
export const NUMBERED = [4, 5] as const;
/** The 2-of-3 lazy board over SIGNERS 0, 1 and 2, signer 0 proposing; it joins only under WALK_BOARD (see below). */
export const BOARD = 6;
const MEMBERS: readonly Member[] = [
  soleSigner("A", 0, "lazy"),
  soleSigner("H", 1, "lazy"),
  soleSigner("C", 2, "lazy"),
  soleSigner("D", 3, "lazy"),
  soleSigner("N1", 4, "numbered"),
  soleSigner("N2", 5, "numbered"),
  { name: "B", board: [0, 1, 2], threshold: 2n, kind: "lazy" },
];
export const NAMES = MEMBERS.map((m) => m.name);
/** The most signers any Entity of this world has: the outer hanko check of its batches grows with it (see fork-shim-budget.test.ts). */
export const MAX_BOARD_SIGNERS = Math.max(...MEMBERS.map((m) => m.board.length));
/**
 * The 2-of-3 board is opt-in (WALK_BOARD=1). Its first Entity frame needs og's frame preparation
 * (runtime/mempool/entity-height-barrier.ts applyEntityHeightDurabilityBarrier: one merge group per certificate-carrying
 * replica lane in a Runtime frame, the rest requeued), which the rewrite runs as processRuntimeFrame.
 */
export const boardJoins = (): boolean => process.env["WALK_BOARD"] === "1";

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
  certifiedBoardState?: unknown;
};

export type World = {
  readonly tag: string;
  readonly lane: Lane;
  /**
   * The registration evidence frame openWorld commits before any import: its lane diffs, and a line for each numbered
   * Entity og holds no evidence for (og scenarios/harness/boot.ts REGISTER_ENTITY_AUTHORITY_EVIDENCE_MISSING). Empty
   * when both sides agree and the evidence is there; a caller treats it as its first setup frame.
   */
  readonly evidence: readonly string[];
  readonly chain: Awaited<ReturnType<typeof bootChain>>;
  readonly coverage: Coverage;
  readonly ids: readonly EntityId[];
  /** An Entity's board members, as indexes into SIGNERS in board order (index 0 proposes). */
  readonly signersOf: (x: number) => readonly number[];
  /** Whether an Entity's board has more than one member. */
  readonly multiSigner: (x: number) => boolean;
  /** The numbered Entities: registered on chain, so each holds a certified board record. */
  readonly numbered: readonly number[];
  /** The multi-signer Entities in this world (none unless WALK_BOARD). */
  readonly boards: readonly number[];
  /**
   * og finds Entity x's own certified board record in x's registry (og board-registry resolveObserverCertifiedBoardRecord):
   * a numbered Entity once its first J-prefix frame has committed the chain's board events; never a lazy one.
   */
  readonly certified: (x: number) => boolean;
  /** The world's own draws, in order: every random choice a run makes comes from here. */
  readonly rand: () => number;
  readonly ri: (n: number) => number;
  /** A user input to an Entity, submitted as `signer` (an index into SIGNERS; the Entity's proposer by default). */
  readonly user: (entity: number, txs: readonly EntityTx[], signer?: number) => User;
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
  /** Every Entity's replicas (one per board member) and the spokes' hub Accounts, as the next two frames. */
  readonly importAll: () => readonly [readonly RuntimeTx[], readonly User[]];
  /** Batches the chain refused (only with the fork's contracts, whose ABI og's submission is shimmed to). */
  readonly refusals: () => readonly string[];
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
  const accountWorkers = holdAccountWorkers(env);
  // og submits a sealed batch through its live adapter after the frame commits, and og's own watcher turns every
  // chain emission into its runtime mempool (observeJRange, the cursor, each validator's J-prefix attestation)
  attachLiveJAdapter(env, J.name, chain);
  chain.startWatching(env);
  const refusals = contractSet() === "contracts"
    ? shimBatchSubmission(chain.getBrowserVM(), BigInt(chain.chainId), chain.addresses.depository, KEYS)
    : () => [] as readonly string[];
  KEYS.forEach((k, i) => registerSignerKey(env, SIGNERS[i]!, Buffer.from(k.slice(2), "hex")));
  const members = boardJoins() ? MEMBERS : MEMBERS.slice(0, BOARD);
  /** og ConsensusConfig of Entity x: its board members, one share each, and its threshold. */
  const config = (x: number): ImportConfig => {
    const validators = members[x]!.board.map((i) => SIGNERS[i]!);
    const shares = Object.fromEntries(validators.map((s) => [s, 1n]));
    const threshold = members[x]!.threshold;
    return { mode: "proposer-based", threshold, validators, shares, jurisdiction: J } as ImportConfig;
  };
  // og scenarios/harness/boot.ts registerEntities: a numbered Entity's board is its sole validator, registered on
  // chain (browservm-provider registerEntitiesWithSigners); its id is its entity number as a 32-byte word. The
  // adapter's forward-declared BrowserVMProvider omits the method the class has.
  const browserVM = chain.getBrowserVM() as unknown as BrowserVMProvider;
  const soleKey = (x: number): { signerId: string; privateKey: string } => {
    const signer = members[x]!.board[0]!;
    return { signerId: SIGNERS[signer]!, privateKey: KEYS[signer]! };
  };
  const numbers = await browserVM.registerEntitiesWithSigners(NUMBERED.map(soleKey));
  const numberWord = (n: number): string => `0x${n.toString(16).padStart(64, "0")}`;
  const numberedIds = new Map<number, string>(NUMBERED.map((x, i) => [x, numberWord(numbers[i]!)]));
  const idOf = (m: Member, x: number): EntityId =>
    (m.kind === "numbered" ? numberedIds.get(x)! : unwrap(lazyBoardEntityId(config(x))).toLowerCase()) as EntityId;
  const ids = members.map(idOf);
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
    signerOf: (x) => members[x]!.board[0]!,
  });
  // og registerEntities: a numbered H0 never shares a Runtime frame with the evidence that authorizes it, so the
  // watcher's registration evidence (recordAuthenticatedJAuthority) commits in a frame of its own first
  await chain.pollNow?.();
  const evidenceDiffs = await lane.tick([], []);
  const stackKey = getCertifiedBoardStackKey(J);
  const held = env.infrastructure?.certifiedRegistrationEvidence;
  const missing = NUMBERED.filter((x) => held?.get(registrationEvidenceKey(stackKey, ids[x]!)) === undefined)
    .map((x) => `${tag} REGISTER_ENTITY_AUTHORITY_EVIDENCE_MISSING:${NAMES[x]}:${ids[x]}`);
  const evidence = [...evidenceDiffs, ...missing];

  const user = (entity: number, txs: readonly EntityTx[], signer?: number): User =>
    signer === undefined ? { entity, txs } : { entity, txs, signer };
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
  /** og importReplica: one replica per board member, all over the Entity's one seed; board index 0 proposes. */
  const importsOf = (x: number): readonly RuntimeTx[] =>
    members[x]!.board.map(
      (signer, at): RuntimeTx =>
        ({
          type: "importReplica",
          entityId: ids[x]!,
          signerId: SIGNERS[signer]!,
          data: { config: config(x), isProposer: at === 0, entitySeed: `0x${String(x + 1).repeat(128)}` },
        }) as RuntimeTx,
    );
  const importAll = (): readonly [readonly RuntimeTx[], readonly User[]] => [
    ids.flatMap((_, x) => importsOf(x)),
    SPOKES.map((s) => user(s, [open(s, HUB, BigInt(1 + ri(20_000)))])),
  ];
  const close = async (): Promise<void> => {
    await accountWorkers.close();
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
    evidence,
    chain,
    coverage,
    ids,
    signersOf: (x) => members[x]!.board,
    multiSigner: (x) => members[x]!.board.length > 1,
    numbered: NUMBERED,
    boards: members.flatMap((m, x) => (m.board.length > 1 ? [x] : [])),
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
    certified: (x) => {
      const state = ogState(x);
      return state !== undefined
        && resolveObserverCertifiedBoardRecord(state as never, getCertifiedBoardNodeStore(env as never), ids[x]!) !== null;
    },
    importAll,
    refusals,
    close,
  };
};
