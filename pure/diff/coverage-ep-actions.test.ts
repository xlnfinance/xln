// Coverage: the Runtime's EntityProvider action submit ledger and governance proposal attempts (og
// runtime/registration/entity-provider-action-submit-state.ts, entity-provider-action-submit-result.ts,
// governance-submit-state.ts) against live og, one og Runtime frame per RuntimeTx. A certified numbered Entity
// commits a pending EntityProvider action; its active leader retries it and the J adapter reports each attempt.
import { describe, expect, test } from "bun:test";
import { applyRuntimeTx as ogApplyRuntimeTx } from "../../core/runtime/tx/tx-handlers.ts";
import { registerPendingCommittedJOutbox, splitJOutboxForDurableSubmit } from "../../core/runtime/j-submit/j-submit-state.ts";
import { makeEntityProviderActionResultRuntimeTx } from "../../core/runtime/registration/entity-provider-action-submit-result.ts";
import { makeGovernanceSubmitResultRuntimeTx } from "../../core/runtime/registration/governance-submit-state.ts";
import {
  handleEntityProviderCancelAction, handleEntityProviderReleaseControlShares, handleEntityProviderTransfer,
} from "../../core/entity/tx/handlers/entity-provider-action.ts";
import { applyCertifiedBoardRegistryEvent } from "../../core/jurisdiction/machine/board-registry/index.ts";
import { applyCertifiedBoardJEvent } from "../../core/entity/tx/j-events-board.ts";
import { PersistentEntityAccountMap } from "../../core/entity/state/persistent-account-map.ts";
import { computeEntityAccountValueHash } from "../../core/entity/consensus/state-root.ts";
import {
  applyBoardJEvent, applyRuntime, createEntity, createRuntime, entityId, foldTxs, quorumBoardHash, registerPendingJOutbox,
  replicaKey, splitJOutbox, stableJson,
  type Binary, type EntityReplica, type EntityState, type EntityTx, type HankoWitness, type JEvent, type JInput,
  type Runtime, type RuntimeTx,
} from "../xln.ts";
import { aliceAddr, bobAddr, signedTxs, unwrap, verifiers } from "../xln_run.ts";
import { ogOf } from "./og-state.ts";

// ---- seeded randomness: SEEDX overrides the fixed seed, and every failure names the seed ----
const SEED = process.env["SEEDX"] ? Number(process.env["SEEDX"]) : 0xe9ac7;
const prng = (seed: number): (() => number) => {
  const state = { s: seed | 0 };
  return () => {
    state.s = (state.s + 0x6d2b79f5) | 0;
    const t1 = Math.imul(state.s ^ (state.s >>> 15), 1 | state.s);
    const t2 = (t1 + Math.imul(t1 ^ (t1 >>> 7), 61 | t1)) ^ t1;
    return ((t2 ^ (t2 >>> 14)) >>> 0) / 4294967296;
  };
};
const rng = prng(SEED);
const ri = (n: number): number => Math.floor(rng() * n);
const pick = <X,>(xs: readonly X[]): X => xs[ri(xs.length)] as X;
const tag = (run: number, step: number, what: string): string => `seed=${SEED} run=${run} step=${step} ${what}`;
/** Rewrite and og agree on one labelled value; the label carries the seed and case into the failure. */
const same = (label: string, rewrite: unknown, og: unknown): void => {
  expect([label, rewrite]).toEqual([label, og]);
};
/** og's typed shells are built from plain data; this is the one place a shell is given its og type. */
const asOg = <T,>(shell: unknown): T => shell as T;
const word = (n: number): string => `0x${n.toString(16).padStart(64, "0")}`;
const rword = (): string => `0x${Array.from({ length: 64 }, () => "0123456789abcdef"[ri(16)]).join("")}`;
/** A tree deep copy that never shares a node (og mutates what it is handed). */
const treeClone = <T,>(v: T): T => {
  if (v === null || typeof v !== "object") return v;
  if (v instanceof Map) return asOg<T>(new Map([...v].map(([k, x]) => [treeClone(k), treeClone(x)])));
  if (Array.isArray(v)) return asOg<T>(v.map(treeClone));
  return asOg<T>(Object.fromEntries(Object.entries(v).map(([k, x]) => [k, treeClone(x)])));
};

// ---- one jurisdiction "j", both engines ----
const JUR = { chainId: 31337, depositoryAddress: "0x5fbdb2315678afecb367f032d93f642f64180aa3", entityProviderAddress: "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512" };
const OG_J = { name: "j", ...JUR };
const DOMAIN = { chainId: JUR.chainId, depositoryAddress: JUR.depositoryAddress };
const J_REPLICA = {
  name: "j", blockNumber: 0n, stateRoot: null, mempool: [], blockDelayMs: 300, lastBlockTimestamp: 0, position: { x: 0, y: 50, z: 0 },
  rpcs: ["http://rpc.example/"], chainId: JUR.chainId, entityProviderDeploymentBlock: 1,
  contracts: { depository: JUR.depositoryAddress, entityProvider: JUR.entityProviderAddress },
};
const A = aliceAddr.toLowerCase();
const B = bobAddr.toLowerCase();
const T0 = 1_700_000_000_000;
const RETRY_MS = 30_000;

// ---- the certified board registry, observed by both ----
const meta = (block: number, log = 0) => ({ blockNumber: block, blockHash: word(3000 + block), transactionHash: word(4000 + block + log), logIndex: log });
const toOgEvent = (e: JEvent): unknown => {
  const { meta: m, type, ...data } = e as JEvent & { readonly meta: ReturnType<typeof meta> };
  const text = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]));
  return { type, ...m, data: text };
};
type OgRegistry = ReturnType<typeof applyCertifiedBoardRegistryEvent>["state"];
type OgNodes = Map<string, unknown>;
type Observed = { readonly state: EntityState; readonly registry: OgRegistry | undefined; readonly nodes: OgNodes };
// ---- a certified 2-signer Entity with one committed pending EntityProvider action ----
type ActionKind = "transfer" | "release" | "cancel";
type Fixture = Observed & { readonly id: string; readonly ogAction: unknown; readonly board: string };
const ogEntityState = (id: string, o: Observed, action: unknown, leader: string): Record<string, unknown> => ({
  entityId: id, height: 0, timestamp: T0,
  config: { mode: "proposer-based", threshold: 1n, validators: [A, B], shares: { [A]: 1n, [B]: 1n }, jurisdiction: OG_J },
  leaderState: { activeValidatorId: leader, view: 0, changedAtHeight: 0 },
  certifiedBoardState: treeClone(o.registry), accounts: PersistentEntityAccountMap.fromEntries([], id, computeEntityAccountValueHash),
  ...(action === undefined ? {} : { entityProviderActionState: treeClone(action) }),
});
/**
 * A board J event on both engines: the rewrite's applyBoardJEvent, og's applyCertifiedBoardJEvent (which also expires a
 * pending action a board activation outdates).
 */
const observe = <O extends Observed & { readonly id: string; readonly ogAction: unknown }>(o: O, e: JEvent, block: number): O => {
  const state = unwrap(applyBoardJEvent(o.state, e, block)).state;
  const ogState = ogEntityState(o.id, o, o.ogAction, A);
  const env = { infrastructure: { certifiedBoardNodes: new Map(o.nodes) } };
  applyCertifiedBoardJEvent(asOg({ newState: ogState, event: toOgEvent(e), env, blockNumber: block, dirtyAccounts: new Set() }));
  return {
    ...o, state, registry: asOg<OgRegistry>(ogState["certifiedBoardState"]), nodes: env.infrastructure.certifiedBoardNodes,
    ogAction: ogState["entityProviderActionState"],
  };
};
const ogHandlerEnv = (nodes: OgNodes): unknown => ({
  state: { jReplicas: new Map([["j", { ...OG_J, contracts: J_REPLICA.contracts }]]) }, infrastructure: { certifiedBoardNodes: nodes },
});
const TRANSFER: EntityTx = { type: "entityProviderTransfer", data: { to: `0x${"b1".repeat(20)}`, tokenId: 1n, amount: 11n } };
const RELEASE: EntityTx = {
  type: "entityProviderReleaseControlShares",
  data: { recipientAddress: `0x${"c2".repeat(20)}`, controlAmount: 3n, dividendAmount: 4n, purpose: "payout" },
};
/** Commit `txs` on both engines: the rewrite folds them, og runs its handlers on one mutable state. */
const commitActions = (fx: Fixture, txs: (s: EntityState) => readonly EntityTx[]): Fixture => {
  const ogState = ogEntityState(fx.id, fx, fx.ogAction, A);
  const env = ogHandlerEnv(fx.nodes);
  const planned = txs(fx.state);
  const handler = (t: EntityTx) =>
    t.type === "entityProviderTransfer" ? handleEntityProviderTransfer
      : t.type === "entityProviderReleaseControlShares" ? handleEntityProviderReleaseControlShares
        : handleEntityProviderCancelAction;
  for (const t of planned) handler(t)(asOg(ogState), asOg(t), asOg(env), true);
  // og: the frame carries Alice's signed command proposing the actions (1 of 2 shares meets the threshold)
  const folded = unwrap(foldTxs(fx.state, new Map(), signedTxs(fx.state, aliceAddr, planned), { verify: verifiers.verify, timestamp: BigInt(T0) }));
  return { ...fx, state: folded.draft.state, ogAction: ogState["entityProviderActionState"] };
};
type Pending = { readonly actionHash: string; readonly actionNonce: bigint; readonly generation: number };
const pendingOf = (s: EntityState): Pending | undefined =>
  (ogOf(s)["entityProviderActionState"] as { readonly pending?: Pending } | undefined)?.pending;
const fixture = (run: number, kind: ActionKind): Fixture => {
  const id = word(0x100 + run);
  const members = new Map([[aliceAddr, { shares: 1n }], [bobAddr, { shares: 1n }]]);
  const board = quorumBoardHash({ _tag: "teaching", threshold: 1n, members });
  const created = unwrap(createEntity({
    id: unwrap(entityId(id)), jurisdiction: DOMAIN, threshold: 1n, members, jurisdictionConfig: { name: "j", entityProviderAddress: JUR.entityProviderAddress },
  })).state;
  const foundation: JEvent = { type: "FoundationBootstrapped", recipient: `0x${"11".repeat(20)}`, boardHash: word(900), controlTokenId: 1n, dividendTokenId: 2n, meta: meta(2) };
  const registered: JEvent = { type: "EntityRegistered", entityId: id, entityNumber: BigInt(id), boardHash: board, meta: meta(3) };
  const bare: Fixture = { state: created, registry: undefined, nodes: new Map(), id, ogAction: undefined, board };
  const base = observe(observe(bare, foundation, 2), registered, 3);
  const first = commitActions(base, () => [kind === "release" ? RELEASE : TRANSFER]);
  if (kind !== "cancel") return first;
  return commitActions(first, (s) => [{ type: "entityProviderCancelAction", data: { actionHash: pendingOf(s)?.actionHash ?? "" } }]);
};

// ---- a live og Runtime beside a rewrite Runtime ----
type OgReplica = { entityId: string; signerId: string; state: Record<string, unknown>; hankoWitness?: Map<string, HankoWitness>; entityProviderActionSubmitState?: unknown };
type OgEnv = {
  state: { jReplicas: Map<string, unknown>; eReplicas: Map<string, OgReplica>; timestamp: number; height: number };
  infrastructure: { certifiedBoardNodes: OgNodes; pendingCommittedJOutbox?: unknown[] };
};
type Pair = { env: OgEnv; rt: Runtime };
type World = { leader: string; witnessed: boolean; fx: Fixture };
const witnessOf = (w: World): Map<string, HankoWitness> => {
  const hash = pendingOf(w.fx.state)?.actionHash;
  if (!w.witnessed || hash === undefined) return new Map();
  return new Map([[hash, { hanko: `0x${"ab".repeat(40)}`, type: "entityProviderAction", entityHeight: 1, createdAt: 1 }]]);
};
/** Write the world into both Runtimes, keeping each replica's local submit journal. */
const sync = (p: Pair, w: World): void => {
  for (const s of [A, B]) {
    const ogKey = `${w.fx.id}:${s}`;
    const prior = p.env.state.eReplicas.get(ogKey)?.entityProviderActionSubmitState;
    p.env.state.eReplicas.set(ogKey, {
      entityId: w.fx.id, signerId: s, state: ogEntityState(w.fx.id, w.fx, w.fx.ogAction, w.leader), hankoWitness: witnessOf(w),
      ...(prior === undefined ? {} : { entityProviderActionSubmitState: prior }),
    });
    const key = replicaKey(unwrap(entityId(w.fx.id)), s === A ? aliceAddr : bobAddr);
    const state = { ...w.fx.state, leaderState: { activeValidatorId: w.leader, view: 0, changedAtHeight: 0 } };
    const replica = asOg<EntityReplica>({ ...unwrap(createEntity({
      id: unwrap(entityId(w.fx.id)), jurisdiction: DOMAIN, threshold: 1n,
      members: new Map([[aliceAddr, { shares: 1n }], [bobAddr, { shares: 1n }]]), signerId: s === A ? aliceAddr : bobAddr,
    })), state });
    const local = p.rt.replicaLocal.get(key) ?? {};
    p.rt = {
      ...p.rt,
      entities: new Map([...p.rt.entities, [key, replica]]),
      replicaLocal: new Map([...p.rt.replicaLocal, [key, { ...local, hankoWitness: witnessOf(w) }]]),
    };
  }
  p.env.infrastructure.certifiedBoardNodes = w.fx.nodes;
};
const ogCode = (e: unknown): string => String((e as Error).message).split(":")[0] ?? "";
const rwCode = (e: unknown): string => {
  const r = e as { readonly _tag: string; readonly code?: string };
  return String(r.code ?? r._tag).split(":")[0] ?? "";
};
type Frame = { readonly code: string | null; readonly jOutbox: unknown };
/** og applyRuntimeTx + the durable J outbox split and register of its frame; a failed frame leaves env as it was. */
const ogFrame = async (env: OgEnv, tx: RuntimeTx): Promise<Frame> => {
  const snapshot = treeClone(env);
  const run = ogApplyRuntimeTx(asOg(env), asOg(treeClone(tx)), { isReplay: true });
  return Promise.resolve(run).then(
    (out) => {
      const split = splitJOutboxForDurableSubmit(asOg(out));
      registerPendingCommittedJOutbox(asOg(env), split.durable);
      return { code: null, jOutbox: [...(env.infrastructure.pendingCommittedJOutbox ?? []), ...split.maintenance] };
    },
    (e: unknown) => {
      Object.assign(env, snapshot);
      return { code: ogCode(e), jOutbox: [] };
    },
  );
};
const rwFrame = (p: Pair, tx: RuntimeTx, now: number): Frame => {
  const r = applyRuntime(p.rt, { runtimeTxs: [tx], entityInputs: [], timestamp: BigInt(now) }, { ...verifiers, replay: true });
  if (!r.ok) return { code: rwCode(r.error), jOutbox: [] };
  p.rt = r.value.runtime;
  return { code: null, jOutbox: r.value.jOutbox };
};
const pendingJTxs = (env: OgEnv): readonly { readonly j: string; readonly jTx: Record<string, unknown> }[] =>
  asOg<{ jurisdictionName: string; jTxs: Record<string, unknown>[] }[]>(env.infrastructure.pendingCommittedJOutbox ?? [])
    .flatMap((i) => i.jTxs.map((jTx) => ({ j: i.jurisdictionName, jTx })));

// ---- governance proposals seeded into both pending outboxes ----
const proposalJTx = (id: string, signer: string, now: number): Record<string, unknown> => ({
  type: "entityProviderProposeControlBoard", entityId: id,
  data: { targetEntityId: id, newBoardHash: rword(), boardEpoch: 1n, actionNonce: BigInt(1 + ri(3)), proposalHash: rword(), supporterVotes: [], signerId: signer },
  timestamp: now,
});
const seedGovernance = (p: Pair, jTxs: readonly Record<string, unknown>[]): void => {
  const jOutbox = [{ jurisdictionName: "j", jTxs }];
  const split = splitJOutboxForDurableSubmit(asOg(treeClone(jOutbox)));
  registerPendingCommittedJOutbox(asOg(p.env), split.durable);
  const mine = unwrap(splitJOutbox(asOg<JInput[]>(jOutbox)));
  p.rt = { ...p.rt, pendingCommittedJOutbox: unwrap(registerPendingJOutbox(p.rt.pendingCommittedJOutbox, mine.durable)) };
};

// ---- the adapter's reports ----
const OUTCOMES = ["submitted", "transientFailure", "terminalFailure", "reconciled"] as const;
type Outcome = (typeof OUTCOMES)[number];
const extraOf = (outcome: Outcome): Record<string, unknown> => {
  const failing = outcome === "transientFailure" || outcome === "terminalFailure";
  if (!failing) return outcome === "submitted" && rng() < 0.7 ? { txHash: rword() } : {};
  const message = pick(["nonce too low", "rpc down"]);
  const category = outcome === "transientFailure" ? "transient" : "terminal";
  return rng() < 0.5 ? { message } : { message, adapterFailure: { category, code: "RPC", message } };
};
/** A report on one pending attempt, sometimes naming the wrong attempt, identity or time. */
const reportOn = (target: { readonly j: string; readonly jTx: Record<string, unknown> }): RuntimeTx => {
  const outcome = pick(OUTCOMES);
  const governance = target.jTx["type"] === "entityProviderProposeControlBoard";
  const made = governance
    ? makeGovernanceSubmitResultRuntimeTx(target.j, asOg(treeClone(target.jTx)), outcome, extraOf(outcome))
    : makeEntityProviderActionResultRuntimeTx(asOg(treeClone(target.jTx)), target.j, outcome, extraOf(outcome));
  const data = { ...asOg<Record<string, unknown>>(made.data) };
  const corrupt = rng();
  const bad = corrupt < 0.06 ? { attemptedAt: Number(data["attemptedAt"]) + 1 }
    : corrupt < 0.1 ? { attemptId: rword() }
      : corrupt < 0.14 ? { signerId: B === data["signerId"] ? A : B }
        : corrupt < 0.17 ? { outcome: "bogus" }
          : corrupt < 0.2 ? { attemptNumber: 0 }
            : {};
  return asOg<RuntimeTx>({ type: made.type, data: { ...data, ...bad } });
};

describe("coverage-ep-actions: EntityProvider action retries and results, governance attempt results (og runtime/registration)", () => {
  test("MATCH: 36 random runs of retryEntityProviderAction / recordEntityProviderActionSubmitResult / recordGovernanceJSubmitResult frames -- same verdicts, J outbox, pending attempts and replica submit journals as og", async () => {
    const counts = new Map<string, number>();
    const bump = (k: string): void => { counts.set(k, (counts.get(k) ?? 0) + 1); };
    for (let run = 0; run < 36; run++) {
      const kind = pick<ActionKind>(["transfer", "transfer", "release", "cancel"]);
      const world: World = { leader: pick([A, A, B]), witnessed: rng() < 0.9, fx: fixture(run, kind) };
      const p: Pair = {
        env: { state: { jReplicas: new Map([["j", treeClone(J_REPLICA)]]), eReplicas: new Map(), timestamp: T0, height: 0 }, infrastructure: { certifiedBoardNodes: new Map() } },
        rt: { ...createRuntime(), timestamp: BigInt(T0), jReplicas: new Map([["j", asOg(J_REPLICA)]]) },
      };
      sync(p, world);
      if (rng() < 0.6) seedGovernance(p, Array.from({ length: 1 + ri(2) }, () => proposalJTx(world.fx.id, pick([A, B]), T0)));
      const state = { now: T0, last: undefined as RuntimeTx | undefined, block: 10 };
      for (let step = 0; step < 18; step++) {
        const roll = rng();
        const pending = pendingOf(world.fx.state);
        const targets = pendingJTxs(p.env);
        const tx: RuntimeTx | undefined = (() => {
          if (roll < 0.4 && pending !== undefined) {
            return {
              type: "retryEntityProviderAction",
              data: {
                entityId: pick([world.fx.id, world.fx.id, world.fx.id, rword()]), signerId: pick([world.leader, world.leader, A, B]),
                jurisdictionName: pick(["j", "j", "j", " J ", "x"]), actionHash: rng() < 0.9 ? pending.actionHash : rword(),
                actionNonce: rng() < 0.93 ? pending.actionNonce : pending.actionNonce + 1n, generation: rng() < 0.93 ? pending.generation : pending.generation + 1,
              },
            };
          }
          if (roll < 0.75 && targets.length > 0) return rng() < 0.12 && state.last !== undefined ? state.last : reportOn(pick(targets));
          return undefined;
        })();
        if (tx === undefined) {
          const change = rng();
          if (change < 0.5) state.now += pick([1_000, RETRY_MS - 1, RETRY_MS, 61_000]);
          else if (change < 0.7) world.leader = world.leader === A ? B : A;
          else if (change < 0.85) world.witnessed = !world.witnessed;
          else {
            // a board activation expires the pending intent it outdates, on both engines
            state.block += 1;
            const next = rword();
            const activated: JEvent = {
              type: "BoardActivated", entityId: world.fx.id, previousBoardHash: world.fx.board, newBoardHash: next,
              previousBoardValidUntil: 1_800_000_000n, meta: meta(state.block),
            };
            world.fx = { ...observe(world.fx, activated, state.block), board: next };
          }
          sync(p, world);
          continue;
        }
        p.env.state.timestamp = state.now;
        const og = await ogFrame(p.env, tx);
        const rw = rwFrame(p, tx, state.now);
        same(tag(run, step, `${tx.type} verdict`), rw.code, og.code);
        bump(`${tx.type}:${og.code ?? (stableJson(og.jOutbox) === "[]" ? "ok-empty" : "ok")}`);
        if (og.code !== null) continue;
        if (tx.type !== "retryEntityProviderAction") state.last = tx;
        same(tag(run, step, "jOutbox"), stableJson(rw.jOutbox), stableJson(og.jOutbox));
        same(tag(run, step, "pending"), stableJson(p.rt.pendingCommittedJOutbox), stableJson(p.env.infrastructure.pendingCommittedJOutbox ?? []));
        for (const s of [A, B]) {
          const key = replicaKey(unwrap(entityId(world.fx.id)), s === A ? aliceAddr : bobAddr);
          const ogLocal = p.env.state.eReplicas.get(`${world.fx.id}:${s}`)?.entityProviderActionSubmitState;
          same(tag(run, step, `journal ${s}`), stableJson(p.rt.replicaLocal.get(key)?.entityProviderActionSubmitState), stableJson(ogLocal));
        }
      }
    }
    const summary = `seed=${SEED} ${JSON.stringify([...counts].toSorted())}`;
    for (const k of [
      "retryEntityProviderAction:ok", "retryEntityProviderAction:ok-empty", "recordEntityProviderActionSubmitResult:ok",
      "recordGovernanceJSubmitResult:ok", "retryEntityProviderAction:ENTITY_PROVIDER_ACTION_NOT_ACTIVE_LEADER",
      "retryEntityProviderAction:ENTITY_PROVIDER_ACTION_COMMITTED_INTENT_MISMATCH",
      "retryEntityProviderAction:ENTITY_PROVIDER_ACTION_HANKO_WITNESS_MISSING",
      "recordGovernanceJSubmitResult:GOVERNANCE_SUBMIT_RESULT_IDENTITY_MISMATCH",
    ]) {
      same(`${summary} ${k}`, counts.has(k), true);
    }
  }, 120_000);
});
