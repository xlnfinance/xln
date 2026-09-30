import { describe, expect, test } from "bun:test";
// Cross-jurisdiction scenario differential (og core/scenarios/cross-j/node.ts): two chains, two Runtimes. The users
// (MM on the source chain, MMt on the target chain) live on one Runtime, their hubs (HubSrc, HubTgt) on another, and
// every Account message crosses between them through og's direct Runtime transport. Each Runtime is a lane of
// diff/lane.ts (og vs the rewrite, compared after every frame); the harness carries each lane's remote outputs into
// the other lane, og's envelopes into og's authenticated ingress and the rewrite's own outputs into the rewrite.
//
// The script is og's: hubs enabled, reserves funded, user->hub Accounts opened, hub credit extended, both users sign
// one cross-j route, the book owner clears it and the swap settles. Random steps (idle frames, credit, same-chain
// payments) interleave; every failure names the seed, the lane and the frame.
process.env["XLN_LOG_LEVEL"] = process.env["XLN_LOG_LEVEL"] ?? "error";
import { rmSync } from "fs";
import { join } from "path";
import { closeInfraDb, closeRuntimeDb, createEmptyEnv } from "../../core/runtime.ts";
import { registerSignerKey } from "../../core/account/crypto.ts";
import { dbRootPath } from "../../core/runtime/replica/platform.ts";
import { attachLiveJAdapter } from "../../core/runtime/j-submit/live-jadapters.ts";
import { createBrowserVMAdapter } from "../../core/jurisdiction/adapter/browservm/browservm.ts";
import { buildLocalEntityProfile } from "../../core/network/p2p/gossip/helper.ts";
import { buildCrossJurisdictionSwapSubmission } from "../../core/runtime/j-submit/api.ts";
import { DEFAULT_SPREAD_DISTRIBUTION } from "../../core/orderbook/types.ts";
import type { JAdapter } from "../../core/jurisdiction/adapter/types.ts";
import { unwrap } from "../xln_run.ts";
import { tracing } from "./scenario-trace.ts";
import { contractSet } from "./contracts.ts";
import { knownHalt } from "./departures.ts";
import { shimBatchSubmission, type Refusals } from "./fork-shim.ts";
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
  type Coverage,
  type Lane,
  type User,
} from "./lane.ts";
import {
  createRuntime,
  lazyBoardEntityId,
  stableJson,
  tokenId,
  type TokenId,
  type EntityId,
  type EntityTx,
  type ImportConfig,
  type RuntimeRoutes,
  type RuntimeTx,
} from "../xln.ts";

const DEFAULT_SEED = 0xc105;
const SEED = Number(process.env["SEEDX"] ?? DEFAULT_SEED);
const SEEDS = [SEED, SEED + 1, SEED + 2];
/** Rounds per seed: each round is one frame on each Runtime. */
const ROUNDS = 60;

const USDC = 1;
const WETH = 2;
const usd = (n: number): bigint => BigInt(n) * 10n ** 18n;
const usdc = (n: number): bigint => BigInt(n) * 10n ** 6n;
/** World Entities by index: the users' Runtime hosts 0 and 1, the hubs' Runtime 2 and 3. */
const MM = 0;
const MMT = 1;
const HUB_SRC = 2;
const HUB_TGT = 3;
const NAMES = ["MM", "MMt", "HubSrc", "HubTgt"];
const HOSTS = { users: [MM, MMT], hubs: [HUB_SRC, HUB_TGT] } as const;
/** Each Entity's chain: 0 the source, 1 the target. */
const CHAIN_OF = [0, 1, 0, 1];
const TOKEN_OF = [USDC, WETH, USDC, WETH];
/** The rewrite's typed token id of an Entity's token (og's wire keeps the number). */
const tokenOf = (x: number): TokenId => unwrap(tokenId(String(TOKEN_OF[x])));
const HUB_OF = [HUB_SRC, HUB_TGT, HUB_SRC, HUB_TGT];

type Chains = readonly [JAdapter, JAdapter];
type Coverages = { readonly coverage: Coverage; settled: boolean; materialized: boolean; readonly refusals: readonly string[]; readonly landed: readonly number[]; readonly unknownHalts: readonly string[] };

/** og's script: reserves move on each chain, the users sign one cross-j route, the book owner clears it, the swap settles. */
const SWAP: Script = { name: "swap", steps: ["enableHubs", "fund", "transfer", "broadcast", "open", "hubCredit", "swap", "clear"] };
/** Each user deposits collateral into its Account with its hub, and the batch lands: no swap. */
const DEPOSIT: Script = { name: "deposit", steps: ["enableHubs", "fund", "open", "hubCredit", "deposit", "depositBroadcast"] };
/** The deposits land first, then the swap is signed. */
const SWAP_AFTER_DEPOSIT: Script = { name: "swap-after-deposit", steps: ["enableHubs", "fund", "open", "hubCredit", "deposit", "depositBroadcast", "swap", "clear"] };
const LONE_LEG = "a lone cross-jurisdiction leg is retained, not halted on";

/** A named script: the name keeps one seed's run in each script on its own storage namespace. */
type Script = { readonly name: string; readonly steps: readonly string[] };
const runCrossJ = async (seed: number, script: Script): Promise<Coverages> => {
  const rand = prng(seed);
  const ri = (n: number): number => Math.floor(rand() * n);
  const tag = `SEEDX=0x${seed.toString(16)}`;
  const chains: Chains = [await bootChain(31337), await bootChain(31338)];
  const js = [jurisdictionOf(chains[0], "CrossJ Source"), jurisdictionOf(chains[1], "CrossJ Target")];
  // og's batches reach the fork's contracts through the shim on each chain's VM (every Runtime's view shares it), and a
  // batch either chain refuses fails the run: og logs it and carries on, which reads as agreement
  const refusalsOf = chains.map((chain) =>
    contractSet() === "contracts"
      ? shimBatchSubmission(chain.getBrowserVM(), BigInt(chain.chainId), chain.addresses.depository, KEYS)
      : Object.assign(() => [] as readonly string[], { landed: () => 0 }),
  ) satisfies Refusals[];
  const refusals = (): readonly string[] => refusalsOf.flatMap((r, i) => r().map((m) => `${tag} chain ${i}: ${m}`));
  const jOf = (x: number) => js[CHAIN_OF[x]!]!;
  const config = (x: number): ImportConfig => {
    const s = SIGNERS[x]!;
    const board = { mode: "proposer-based", threshold: 1n, validators: [s], shares: { [s]: 1n } };
    return { ...board, jurisdiction: jOf(x).J } as ImportConfig;
  };
  const ids = SIGNERS.slice(0, 4).map((_, x) => unwrap(lazyBoardEntityId(config(x))).toLowerCase() as EntityId);
  const coverage = emptyCoverage();
  const count = (kind: string): void => {
    coverage.actions[kind] = (coverage.actions[kind] ?? 0) + 1;
  };
  const namespaces: string[] = [];
  const accountWorkers: ReturnType<typeof holdAccountWorkers>[] = [];

  /** One Runtime: both chains bound through its own adapter view (og gives each Runtime its own watcher). */
  const host = async (name: string, hosted: readonly number[]) => {
    const ns = `scn-cj-${process.pid}-${script.name}-${name}-${seed.toString(16)}`;
    namespaces.push(ns);
    const env = createEmptyEnv(ns);
    env.scenarioMode = true;
    env.quietRuntimeLogs = true;
    env.state.timestamp = T0;
    env.runtimeConfig = { ...env.runtimeConfig, storage: { ...env.runtimeConfig?.storage, enabled: true } } as never;
    env.activeJurisdiction = js[0]!.J.name;
    accountWorkers.push(holdAccountWorkers(env));
    await js.reduce(async (prev, j, i) => {
      await prev;
      const chain = chains[i]!;
      env.state.jReplicas.set(j.J.name, treeClone(j.JREPLICA) as never);
      const vm = (chain as unknown as { getBrowserVM: () => unknown }).getBrowserVM();
      const cfg = { mode: "browservm", chainId: Number(chain.chainId) } as never;
      const view = await createBrowserVMAdapter(cfg, chain.provider as never, chain.signer as never, vm as never);
      attachLiveJAdapter(env, j.J.name, view);
      view.startWatching(env);
    }, Promise.resolve());
    hosted.forEach((x) => registerSignerKey(env, SIGNERS[x]!, Buffer.from(KEYS[x]!.slice(2), "hex")));
    return env;
  };
  const envU = await host("users", HOSTS.users);
  const envH = await host("hubs", HOSTS.hubs);
  const homeOf = (x: number) => ((HOSTS.users as readonly number[]).includes(x) ? envU : envH);
  const byId = (id: string): number => ids.indexOf(id.toLowerCase() as EntityId);
  /** The rewrite's transport view from one Runtime: every Entity hosted by the other one, at its verified signer. */
  const routesFrom = (self: typeof envU): RuntimeRoutes => {
    const remote = (e: string): number | undefined => {
      const x = byId(e);
      return x >= 0 && homeOf(x) !== self ? x : undefined;
    };
    const runtimeOf = (e: string): string | undefined => {
      const x = remote(e);
      return x === undefined ? undefined : homeOf(x).runtimeId;
    };
    return {
      verifiedProfileSigner: (e) => {
        const x = remote(e);
        return x === undefined ? undefined : SIGNERS[x];
      },
      verifiedRuntime: runtimeOf,
      resolvedRuntime: runtimeOf,
      crossJRuntime: (e) => {
        const x = byId(e);
        return x < 0 ? undefined : homeOf(x).runtimeId;
      },
    };
  };
  const lane = (name: string, env: typeof envU, hosted: readonly number[]): Lane =>
    createLane({
      tag: `${tag} ${name}`,
      env,
      runtime: {
        ...createRuntime(js.map((j) => j.JREPLICA), env.runtimeId),
        activeJurisdiction: js[0]!.J.name,
        timestamp: BigInt(T0),
      },
      ids,
      names: NAMES,
      coverage,
      keyed: new Set(hosted.map((x) => SIGNERS[x]!)),
      secrets: new Map(),
      // both Runtimes are connected for the whole run
      online: (x) => ids.includes(x.toLowerCase() as EntityId),
      routes: routesFrom(env),
    });
  const users = lane("users", envU, HOSTS.users);
  const hubs = lane("hubs", envH, HOSTS.hubs);

  type Profile = { entityId: string; runtimeId: string; runtimeEncPubKey: string; lastUpdated: number };
  type Gossip = { announce: (p: unknown) => void; getProfile: (id: string) => Profile | undefined };
  const gossipOf = (env: typeof envU): Gossip => (env as unknown as { gossip: Gossip }).gossip;
  /**
   * og's gossip between the two Runtimes: each Entity's current certified profile reaches the other Runtime, whose
   * transport then routes to it at the profile's runtime signer (og p2p rememberVerifiedProfileRoute).
   */
  const exchangeProfiles = (): void =>
    [0, 1, 2, 3].forEach((x) => {
      const home = homeOf(x);
      const away = home === envU ? envH : envU;
      const replica = [...home.state.eReplicas.values()].find((r) => r.entityId === ids[x]);
      if (replica === undefined) return;
      const profile = gossipOf(home).getProfile(ids[x]!) ?? buildLocalEntityProfile(home, replica.state);
      gossipOf(away).announce(treeClone(profile));
      const infra = away.infrastructure as unknown as { verifiedProfileRoutes?: Map<string, unknown> };
      infra.verifiedProfileRoutes ??= new Map();
      infra.verifiedProfileRoutes.set(ids[x]!, {
        runtimeId: profile.runtimeId,
        runtimeSignerId: SIGNERS[x],
        runtimeEncPubKey: profile.runtimeEncPubKey,
        lastUpdated: profile.lastUpdated,
      });
    });

  // ---- og state probes ----
  type OgAccount = {
    currentHeight: number;
    pendingFrame?: unknown;
    mempool: unknown[];
    state?: { swapOffers?: Map<string, { crossJurisdiction?: unknown }> };
  };
  type OgSwap = { status?: string; sourcePull?: unknown; targetPull?: unknown };
  type OgState = {
    accounts: Map<string, OgAccount>;
    crossJurisdictionSwaps?: Map<string, OgSwap>;
    profile?: { isHub?: boolean };
    orderbookExt?: unknown;
  };
  const ogState = (x: number): OgState | undefined =>
    [...homeOf(x).state.eReplicas.values()].find((r) => r.entityId === ids[x])?.state as unknown as OgState;
  const account = (x: number, y: number): OgAccount | undefined => ogState(x)?.accounts.get(ids[y]!);
  const settledAt = (x: number, y: number, height: number): boolean => {
    const a = account(x, y);
    return a !== undefined && a.pendingFrame === undefined && a.currentHeight >= height && a.mempool.length === 0;
  };
  const userAccountsSettled = (height: number): boolean =>
    HOSTS.users.every((u) => settledAt(u, HUB_OF[u]!, height) && settledAt(HUB_OF[u]!, u, height));

  // ---- actions ----
  const user = (entity: number, txs: readonly EntityTx[]): User => ({ entity, txs });
  const tx = (type: string, data: unknown): EntityTx => ({ type, data }) as unknown as EntityTx;
  const open = (u: number): EntityTx =>
    tx("openAccount", {
      targetEntityId: ids[HUB_OF[u]!]!,
      creditAmount: usd(100_000),
      tokenId: tokenOf(u),
      disputeConfig: { leftResponseSeconds: 60, rightResponseSeconds: 60 },
      accountDomain: { chainId: jOf(u).J.chainId, depositoryAddress: jOf(u).J.depositoryAddress },
      watchSeed: `0x${(u * 16 + HUB_OF[u]! + 1).toString(16).padStart(2, "0").repeat(32)}`,
    });
  const enableHub = (h: number): EntityTx[] => [
    tx("setHubConfig", {
      matchingStrategy: "amount",
      policyVersion: 1,
      routingFeePPM: 1,
      baseFee: 0n,
      swapTakerFeeBps: 1,
      rebalanceLiquidityFeeBps: 0n,
      rebalanceTimeoutMs: 60_000,
    }),
    tx("initOrderbookExt", {
      name: NAMES[h],
      spreadDistribution: treeClone(DEFAULT_SPREAD_DISTRIBUTION),
      referenceTokenId: USDC,
      usdQuoteAuthorityEntityId: ids[h],
      minTradeSize: 10n * 10n ** 18n,
      supportedPairs: ["1/2", "1/3", "2/3"],
    }),
  ];
  const orderId = `cross-j-scn-${seed.toString(16)}`;
  const state = {
    opened: false,
    credited: false,
    swapped: false,
    cleared: false,
    bookOwner: -1,
    materialized: false,
    settled: false,
    funded: false,
    transferred: false,
    deposited: false,
  };
  const swapOf = (x: number): OgSwap | undefined => ogState(x)?.crossJurisdictionSwaps?.get(orderId);
  /** og's clear precondition: both legs resting with their pulls, the source offer and the book order in place. */
  const restingOrder = (): boolean => {
    const src = swapOf(HUB_SRC);
    const tgt = swapOf(HUB_TGT);
    const offer = account(HUB_SRC, MM)?.state?.swapOffers?.get(orderId)?.crossJurisdiction !== undefined;
    return src?.status === "resting" && tgt?.status === "resting" && !!src.sourcePull && !!src.targetPull && offer;
  };
  type Step = { readonly users: User[]; readonly hubs: User[] };
  const none: Step = { users: [], hubs: [] };
  const extend = (from: number, to: number, amount: bigint): EntityTx =>
    tx("extendCredit", { counterpartyEntityId: ids[to]!, tokenId: tokenOf(from), amount });
  /** A same-chain payment in the payer's token (a user and its hub share one). */
  const pay = (from: number, to: number): EntityTx =>
    tx("directPayment", {
      targetEntityId: ids[to]!,
      tokenId: tokenOf(from),
      amount: usdc(1 + ri(50)),
      route: [ids[from]!, ids[to]!],
      deliveryMode: "direct",
    });
  const step = async (kind: string): Promise<Step | undefined> => {
    const u = HOSTS.users[ri(2)]!;
    const h = HUB_OF[u]!;
    switch (kind) {
      case "enableHubs":
        return { users: [], hubs: [user(HUB_SRC, enableHub(HUB_SRC)), user(HUB_TGT, enableHub(HUB_TGT))] };
      case "fund": {
        state.funded = true;
        // og's watchers see the mints and queue each Entity's J range for the next frame
        await [0, 1, 2, 3].reduce(async (prev, x) => {
          await prev;
          await chains[CHAIN_OF[x]!]!.debugFundReserves(ids[x]!, TOKEN_OF[x]!, usd(2_000_000));
        }, Promise.resolve());
        return none;
      }
      case "open":
        state.opened = true;
        return { users: [user(MM, [open(MM)]), user(MMT, [open(MMT)])], hubs: [] };
      case "hubCredit": {
        // og waits for the opened Accounts to settle before the hubs extend credit
        if (!state.opened || !userAccountsSettled(1)) return undefined;
        state.credited = true;
        const grant = (hub: number, to: number): User => user(hub, [extend(hub, to, usd(500_000))]);
        return { users: [], hubs: [grant(HUB_SRC, MM), grant(HUB_TGT, MMT)] };
      }
      case "transfer": {
        // a real reserve-to-reserve batch on each chain, so the contracts see og's submissions (og waits for idle Accounts)
        if (!state.funded) return undefined;
        state.transferred = true;
        const r2r = (x: number): EntityTx =>
          tx("r2r", { toEntityId: ids[HUB_OF[x]!]!, tokenId: TOKEN_OF[x]!, amount: usd(1_000) });
        return { users: [user(MM, [r2r(MM)]), user(MMT, [r2r(MMT)])], hubs: [] };
      }
      case "broadcast":
        return state.transferred ? { users: [user(MM, [tx("j_broadcast", {})]), user(MMT, [tx("j_broadcast", {})])], hubs: [] } : undefined;
      case "deposit": {
        // a reserve-to-collateral deposit into each user's Account with its hub (og waits for idle Accounts)
        if (!state.credited || !userAccountsSettled(2)) return undefined;
        state.deposited = true;
        const r2c = (x: number): EntityTx =>
          tx("r2c", { counterpartyId: ids[HUB_OF[x]!]!, tokenId: TOKEN_OF[x]!, amount: usd(1_000) });
        return { users: [user(MM, [r2c(MM)]), user(MMT, [r2c(MMT)])], hubs: [] };
      }
      case "depositBroadcast":
        return state.deposited ? { users: [user(MM, [tx("j_broadcast", {})]), user(MMT, [tx("j_broadcast", {})])], hubs: [] } : undefined;
      case "swap": {
        // og's MM signs only once the hubs' credit is committed and both Accounts are idle
        if (!state.credited || !userAccountsSettled(2)) return undefined;
        const { route } = buildCrossJurisdictionSwapSubmission(envU as never, {
          orderId,
          sourceUserEntityId: ids[MM]!,
          sourceHubEntityId: ids[HUB_SRC]!,
          targetHubEntityId: ids[HUB_TGT]!,
          targetUserEntityId: ids[MMT]!,
          sourceTokenId: USDC,
          sourceAmount: usdc(1_000),
          targetTokenId: WETH,
          targetAmount: usd(1_000),
          sourceUserSignerId: SIGNERS[MM]!,
          sourceHubSignerId: SIGNERS[HUB_SRC]!,
          targetHubSignerId: SIGNERS[HUB_TGT]!,
          targetUserSignerId: SIGNERS[MMT]!,
        } as never);
        state.swapped = true;
        state.bookOwner = byId(String((route as { bookOwnerEntityId: string }).bookOwnerEntityId));
        const prepare = tx("prepareCrossJurisdictionSwap", { route: treeClone(route) });
        return { users: [user(MMT, [prepare]), user(MM, [prepare])], hubs: [] };
      }
      case "clear": {
        if (!state.swapped || state.cleared || !restingOrder()) return undefined;
        state.cleared = true;
        const clear = tx("requestCrossJurisdictionClear", { orderId, cancelRemainder: true });
        return { users: [], hubs: [user(state.bookOwner, [clear])] };
      }
      case "userCredit":
        return account(u, h) === undefined
          ? undefined
          : { users: [user(u, [extend(u, h, usd(1 + ri(1_000)))])], hubs: [] };
      case "payToHub":
        return account(u, h) === undefined
          ? undefined
          : { users: [user(u, [pay(u, h)])], hubs: [] };
      case "payFromHub":
        return account(h, u) === undefined || !state.credited
          ? undefined
          : { users: [], hubs: [user(h, [pay(h, u)])] };
      default:
        return none;
    }
  };

  /** One round: a frame on the users' Runtime, its remote outputs to the hubs, a hubs frame, and back. */
  const round = async (s: Step, runtimeTxs: readonly [RuntimeTx[], RuntimeTx[]] = [[], []]): Promise<string[]> => {
    const u = await users.tick(runtimeTxs[0], s.users);
    hubs.deliver(users.drain());
    exchangeProfiles();
    const h = await hubs.tick(runtimeTxs[1], s.hubs);
    users.deliver(hubs.drain());
    exchangeProfiles();
    return [...u, ...h];
  };
  const random = ["idle", "idle", "idle", "idle", "idle", "userCredit", "payToHub", "payFromHub"];

  try {
    const imports = (hosted: readonly number[]): RuntimeTx[] =>
      hosted.map(
        (x): RuntimeTx =>
          ({
            type: "importReplica",
            entityId: ids[x]!,
            signerId: SIGNERS[x]!,
            data: { config: config(x), isProposer: true, entitySeed: `0x${String(x + 1).repeat(128)}` },
          }) as RuntimeTx,
      );
    const expectClean = (diffs: string[]): void => expect(diffs).toEqual([]);
    expectClean(await round(none, [imports(HOSTS.users), imports(HOSTS.hubs)]));
    const queue = [...script.steps];
    const rounds = Array.from({ length: ROUNDS }, (_, i) => i);
    await rounds.reduce(async (prev) => {
      await prev;
      if (coverage.halts > 0 || coverage.departures.length > 0 || state.settled) return;
      const kind = queue.length > 0 && rand() < 0.6 ? queue[0]! : random[ri(random.length)]!;
      const planned = await step(kind);
      if (planned !== undefined && queue[0] === kind) queue.shift();
      count(planned === undefined ? "idle" : kind);
      if (tracing()) console.log(`round ${users.frames()} ${kind}${planned === undefined ? " (skipped)" : ""}`);
      expectClean(await round(planned ?? none));
      const status = swapOf(HUB_SRC)?.status;
      state.materialized ||= swapOf(HUB_SRC)?.sourcePull !== undefined && swapOf(HUB_TGT)?.targetPull !== undefined;
      state.settled = status === "settled" || status === "cancelled";
    }, Promise.resolve());
    return { coverage, settled: state.settled, materialized: state.materialized, refusals: refusals(), landed: refusalsOf.map((r) => r.landed()),
      // a halt both sides share ends the run quietly; only a registered og halt (departures.ts) may do that here
      unknownHalts: coverage.haltTexts.filter((h) => knownHalt(h) === undefined),
    };
  } finally {
    await Promise.all(accountWorkers.map((workers) => workers.close()));
    await [envU, envH].reduce(async (prev, env) => {
      await prev;
      await closeRuntimeDb(env);
      await closeInfraDb(env);
    }, Promise.resolve());
    await chains[0].close();
    await chains[1].close();
    namespaces.forEach((ns) =>
      ["", "-storage-current", "-storage-previous", "-wal", "-history-views", "-events", "-infra"].forEach((suffix) =>
        rmSync(join(dbRootPath, ns) + suffix, { recursive: true, force: true }),
      ),
    );
  }
};

describe("scenario: a cross-jurisdiction swap across two Runtimes, og vs the rewrite, frame by frame", () => {
  const totals = { settled: 0 };
  const report = (r: Coverages, seed: number): void =>
    console.log(
      `seed 0x${seed.toString(16)}: ${r.coverage.frames} Runtime frames, materialized ${r.materialized},`,
      `settled ${r.settled}, batches landed ${stableJson(r.landed)}, halts ${stableJson(r.coverage.haltTexts)},`,
      `departures ${stableJson(r.coverage.departures)}, actions ${stableJson(r.coverage.actions)}`,
    );
  SEEDS.forEach((seed) => {
    test(`MATCH: cross-j swap, seed 0x${seed.toString(16)}`, async () => {
      const r = await runCrossJ(seed, SWAP);
      totals.settled += r.settled ? 1 : 0;
      report(r, seed);
      expect(r.coverage.frames).toBeGreaterThan(10);
      expect(r.refusals).toEqual([]);
      expect(r.unknownHalts).toEqual([]);
      // an empty refusal list proves nothing unless a batch reached each chain
      expect(r.landed.every((n) => n > 0)).toBe(true);
    }, 900_000);
  });
  test("a cross-j swap settles", () => {
    expect(totals.settled).toBeGreaterThan(0);
  });

  // A deposit sends the hub two Account messages in one Runtime frame (a collateral-claim proposal and, after the hub's
  // own proposal collides with it, the re-proposal one height up). og ships them as one input; the retained outbox the
  // rewrite commits holds two rows, which the lane batches the way og's dispatch does before comparing.
  const batched = { rows: 0 };
  SEEDS.forEach((seed) => {
    test(`MATCH: collateral deposits land on both chains, seed 0x${seed.toString(16)}`, async () => {
      const r = await runCrossJ(seed, DEPOSIT);
      batched.rows += r.coverage.actions["batchedRows"] ?? 0;
      report(r, seed);
      expect(r.refusals).toEqual([]);
      expect(r.unknownHalts).toEqual([]);
      expect(r.coverage.departures).toEqual([]);
      expect(r.coverage.accountTxs.has("j_event_claim")).toBe(true);
      expect(r.landed.every((n) => n > 0)).toBe(true);
    }, 900_000);
  });

  test("the deposits made the lane batch rows", () => {
    expect(batched.rows).toBeGreaterThan(0);
  });

  // With a deposit in flight on the target user's Account the swap's target leg waits behind it and the source leg is
  // ready alone: og halts at dispatch, the rewrite keeps the lone leg (departures.ts loneCrossJLeg).
  test("a swap signed after a deposit: og halts on a lone leg where the rewrite retains it", async () => {
    const runs = await SEEDS.reduce<Promise<readonly Coverages[]>>(
      async (done, seed) => [...(await done), await runCrossJ(seed, SWAP_AFTER_DEPOSIT)],
      Promise.resolve([]),
    );
    runs.forEach((r, i) => report(r, SEEDS[i]!));
    expect(runs.flatMap((r) => r.refusals)).toEqual([]);
    expect(runs.flatMap((r) => r.unknownHalts)).toEqual([]);
    expect(runs.flatMap((r) => r.coverage.departures).some((d) => d.endsWith(LONE_LEG))).toBe(true);
  }, 900_000);
});
