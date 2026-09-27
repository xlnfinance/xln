// Differential tests: og Entity -> Entity command lane, cross-j Entity txs, gossip pathfinding vs pure/xln.ts.
// Every test is "MATCH:" and runs og live on the same (seeded random) input.
import { describe, expect, test } from "bun:test";
import { seedOf, seedTag } from "./seed.ts";
import { x25519 } from "@noble/curves/ed25519";
import { buildNetworkGraph as ogBuildGraph } from "../../core/pathfinding/graph.ts";
import { PathFinder } from "../../core/pathfinding/pathfinding.ts";
import * as ogAdmission from "../../core/entity/paybook/payment-admission.ts";
import { withDeterministicHtlcTestSecret } from "../../core/protocol/htlc/test-secret-capability.ts";
import { ALICE, BOB, CAROL, NOW, TERMS, aliceAddr, bobAddr, carolAddr, unwrap, verifiers, withTestJurisdiction } from "../xln_run.ts";
import {
  applyRuntime, convertOutput, createEntity, createRuntime, findPaths, isLeft, materializeOriginated, replicaId, replicaKey, spawn, stableJson, tokenId,
  type Address, type Binary, type EntityId, type EntityReplica, type EntityTx, type RoutedEntityInput, type Runtime,
} from "../xln.ts";

const rng = (base: number) => {
  let seed = seedOf(base);
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
type Rand = () => number;
const pick = <T,>(r: Rand, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
const int = (r: Rand, n: number): number => Math.floor(r() * n);
const hex = (r: Rand, bytes: number): string => "0x" + Array.from({ length: bytes }, () => int(r, 256).toString(16).padStart(2, "0")).join("");
const ogTry = <T,>(f: () => T): { ok: true; value: T } | { ok: false } => { try { return { ok: true, value: f() }; } catch { return { ok: false }; } };
const ogTryAsync = async <T,>(f: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> => { try { return { ok: true, value: await f() }; } catch { return { ok: false }; } };
const same = (og: { ok: boolean; value?: unknown }, rw: { ok: boolean; value?: unknown }, label: string): void => {
  expect(`${label}:${rw.ok}`).toBe(`${label}:${og.ok}`);
  if (og.ok && rw.ok) expect(stableJson(rw.value)).toBe(stableJson(og.value));
};

// ---- og pathfinding/{graph,pathfinding}.ts ----
const randomProfiles = (r: Rand, ids: readonly string[], tokenId: number): Binary[] => {
  const out = ids.map((id) => {
    const accounts = ids.filter((peer) => peer !== id && r() < 0.35).map((peer) => {
      const rows: [number | string, unknown][] = [];
      if (r() < 0.9) rows.push([r() < 0.1 ? String(tokenId) : tokenId, { inCapacity: BigInt(pick(r, [0, 0, 50, 1_000, int(r, 1e6)])), outCapacity: BigInt(pick(r, [0, 50, 1_000, int(r, 1e6)])) }]);
      if (r() < 0.3) rows.push([tokenId + 1, { inCapacity: 10n, outCapacity: 10n }]);
      const tokenCapacities = r() < 0.2 ? Object.fromEntries(rows.map(([k, v]) => [String(k), v])) : new Map(rows);
      return { counterpartyId: r() < 0.03 ? hex(r, 32) : peer, domain: TERMS.domain, tokenCapacities };
    });
    const isHub = r() < 0.4;
    const metadata: Record<string, unknown> = { isHub, baseFee: BigInt(pick(r, [0, 0, 1, 7, -2])) };
    if (r() < 0.9) metadata.routingFeePPM = pick(r, [0, 1, 100, 5000, 999_999, -5, Number.NaN]);
    return { entityId: id, name: r() < 0.1 ? "  " : id.slice(-4), entityEncryptionPublicKey: "", metadata, accounts };
  });
  return (r() < 0.1 ? [...out, { ...out[0]!, metadata: { ...out[0]!.metadata, routingFeePPM: 7 } }] : out) as unknown as Binary[];
};

describe(seedTag("entity-lane: gossip pathfinding (og pathfinding/graph.ts, pathfinding.ts, network/p2p/gossip findPaths)"), () => {
  test("MATCH: buildNetworkGraph + PathFinder.findRoutes on 400 random gossip graphs (hub metadata, mirrored rows, funding first hop, capacities, fees)", () => {
    const r = rng(41);
    let found = 0;
    for (let i = 0; i < 400; i++) {
      const ids = Array.from({ length: 2 + int(r, 6) }, () => hex(r, 32)), tk = pick(r, [1, 2]);
      const profiles = randomProfiles(r, ids, tk), amount = BigInt(pick(r, [1, 10, 100, 1000, int(r, 1e6)]));
      const source = ids[0]!, target = r() < 0.05 ? source : r() < 0.05 ? hex(r, 32) : ids[ids.length - 1]!;
      const funding = r() < 0.2 ? pick(r, ids) : undefined;
      const map = new Map<string, unknown>();
      for (const p of profiles as unknown as { entityId: string }[]) map.set(p.entityId, p);
      const og = ogTry(() => new PathFinder(ogBuildGraph(map as never, tk, funding ? { sourceEntityId: source, accountId: funding } : undefined)).findRoutes(source, target, amount, tk, 100, funding));
      const rw = findPaths(profiles, source, target, amount, tk, funding);
      same(og, rw, `routes${i}`);
      if (og.ok && og.value.length > 0) found++;
    }
    expect(found).toBeGreaterThan(40);
  });
});

// ---- htlcPayment with an empty route (og infra-context.ts resolveRoute) ----
const ENTITY_KEYS = new Map([ALICE, BOB, CAROL].map((id, i) => { const priv = new Uint8Array(32).fill(i + 7); return [id, { priv: "0x" + Buffer.from(priv).toString("hex"), pub: "0x" + Buffer.from(x25519.getPublicKey(priv)).toString("hex") }] as const; }));
const SIGNERS = new Map<EntityId, Address>([[ALICE, aliceAddr], [BOB, bobAddr], [CAROL, carolAddr]]);
const entityOf = (id: EntityId) => unwrap(createEntity({ id, jurisdiction: TERMS.domain, threshold: 1n, members: new Map([[SIGNERS.get(id)!, { shares: 1n }]]), committed: { entityEncryptionPublicKey: ENTITY_KEYS.get(id)!.pub } }));
const inputOf = (id: EntityId, txs: EntityTx[], timestamp: bigint): RoutedEntityInput => ({ entityId: id, signerId: SIGNERS.get(id)!, input: { kind: "txs", timestamp, txs } });
/** og requireEntityEncryptionPrivateKey + assertEntityEncryptionKeypair run on every proposal and replay: every validator holds its Entity's key. */
const withKeys = (ctx: any): typeof verifiers => ({ ...ctx, htlcInfra: (id: EntityId) => {
  const given = ctx.htlcInfra?.(id), key = ENTITY_KEYS.get(id)?.priv;
  return given?.encryptionPrivateKey !== undefined || key === undefined ? given : { profiles: [], ...given, encryptionPrivateKey: key };
} });
const quiet = (start: Runtime, first: RoutedEntityInput[], ctx: object = verifiers): Runtime => {
  let rt = start, clock = NOW;
  const queue = [...first];
  for (let n = 0; queue.length > 0; n++) {
    if (n > 200) throw new Error("no quiescence");
    const input = queue.shift() as RoutedEntityInput;
    const out = unwrap(applyRuntime(rt, { runtimeTxs: [], entityInputs: [input] }, withKeys(ctx)));
    if (out.rejected.length > 0) throw new Error(JSON.stringify(out.rejected, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
    rt = out.runtime; clock += 1n;
    for (const o of out.outbox) {
      if ("input" in o && o.input.kind === "txs" && o.input.txs.length === 0 && o.to === input.entityId) continue;
      queue.push(unwrap(convertOutput(rt, o, input.entityId, clock)));
    }
  }
  return rt;
};
const open = (to: EntityId, creditAmount?: bigint): EntityTx => ({ type: "openAccount", data: { targetEntityId: to, accountDomain: { ...TERMS.domain }, watchSeed: TERMS.watchSeed, disputeConfig: { ...TERMS.disputeConfig }, ...(creditAmount === undefined ? {} : { creditAmount, tokenId: unwrap(tokenId("1")) }) } } as EntityTx);
const network = (): Runtime => {
  let rt = spawn(spawn(spawn(withTestJurisdiction(createRuntime()), entityOf(ALICE)), entityOf(BOB)), entityOf(CAROL));
  rt = quiet(rt, [inputOf(BOB, [open(ALICE, 1000n), open(CAROL)], NOW)]);
  return quiet(rt, [inputOf(CAROL, [{ type: "extendCredit", data: { counterpartyEntityId: BOB, tokenId: unwrap(tokenId("1")), amount: 1000n } }], NOW + 100n)]);
};
const replicaOf = (rt: Runtime, id: EntityId): EntityReplica => rt.entities.get(replicaKey(id, SIGNERS.get(id)!))!;
const profile = (id: EntityId, accounts: readonly { counterpartyId: string; domain: unknown; tokenCapacities: Map<number, { inCapacity: bigint; outCapacity: bigint }> }[], meta: object = {}): Binary =>
  ({ entityId: id, entityEncryptionPublicKey: ENTITY_KEYS.get(id)!.pub, name: id.slice(-4), metadata: { isHub: false, routingFeePPM: 100, baseFee: 0n, ...meta }, accounts }) as unknown as Binary;
const caps = (inC: bigint, outC: bigint) => new Map([[1, { inCapacity: inC, outCapacity: outC }]]);
const baseProfiles = (): Binary[] => [
  profile(ALICE, []), profile(BOB, [{ counterpartyId: ALICE, domain: TERMS.domain, tokenCapacities: caps(1000n, 0n) }, { counterpartyId: CAROL, domain: TERMS.domain, tokenCapacities: caps(0n, 1000n) }], { routingFeePPM: 5000, baseFee: 1n, isHub: true }), profile(CAROL, []),
];
const ogStateOf = (r: EntityReplica, timestamp: number) => ({
  entityId: r.state.id, timestamp, lastFinalizedJHeight: 0, entityEncryptionPublicKey: String(r.state.committed["entityEncryptionPublicKey"]), paybook: { entries: new Map(), feesEarned: 0n },
  accounts: new Map([...r.accountReplicas].map(([peer, c]) => { const id = replicaId(c); return [peer, { status: "active", state: { domain: c.state.terms.domain, leftEntity: id.left, rightEntity: id.right, deltas: new Map() } }]; })),
});
/** og gossip getNetworkGraph().findPaths over the same profile map, as infra-context.ts resolveRoute calls it. */
const ogResolve = (profiles: readonly Binary[], source: string) => async (tx: { data: { targetEntityId: string; amount: bigint; tokenId: number } }): Promise<readonly string[]> => {
  const m = new Map<string, unknown>();
  for (const p of profiles as unknown as { entityId: string }[]) m.set(p.entityId, p);
  const routes = new PathFinder(ogBuildGraph(m as never, tx.data.tokenId)).findRoutes(source, tx.data.targetEntityId, tx.data.amount, tx.data.tokenId, 100);
  const path = routes[0]?.path;
  if (!path) throw new Error(`HTLC_PAYMENT_ROUTE_NOT_FOUND:${source}:${tx.data.targetEntityId}`);
  return path;
};

describe(seedTag("entity-lane: htlcPayment route discovery (og infra-context.ts resolveRoute)"), () => {
  const rt = network(), alice = replicaOf(rt, ALICE), ts = Number(NOW + 1000n);
  const view = { id: ALICE, timestamp: ts, jHeight: 0, encryptionKey: ENTITY_KEYS.get(ALICE)!.pub, paybook: { entries: new Map(), feesEarned: 0n }, replicas: alice.accountReplicas };
  test("MATCH: materializeOriginatedHtlcPayments with an empty route resolves og's route on 150 random profile sets and payments", async () => {
    const r = rng(43);
    let accepted = 0;
    for (let i = 0; i < 150; i++) {
      const profiles = baseProfiles() as any[];
      const mut = int(r, 10);
      if (mut === 1) profiles[1] = { ...profiles[1], metadata: { ...profiles[1].metadata, routingFeePPM: pick(r, [0, 1, 999_999]), baseFee: BigInt(int(r, 50)) } };
      if (mut === 2) profiles[1] = { ...profiles[1], accounts: profiles[1].accounts.slice(0, 1) };
      if (mut === 3) profiles[1] = { ...profiles[1], name: " " };
      if (mut === 4) profiles.pop();
      if (mut === 5) profiles[1] = { ...profiles[1], accounts: [profiles[1].accounts[0], { ...profiles[1].accounts[1], tokenCapacities: caps(0n, BigInt(int(r, 200))) }] };
      if (mut === 6) profiles[0] = { ...profiles[0], accounts: [{ counterpartyId: CAROL, domain: TERMS.domain, tokenCapacities: caps(0n, 5000n) }] };
      const over: Record<string, unknown> = { route: [] };
      const m2 = int(r, 10);
      if (m2 === 1) over.amount = BigInt(int(r, 3000)) + 1n;
      if (m2 === 2) over.targetEntityId = "0x" + CAROL.slice(2).toUpperCase();
      if (m2 === 3) over.tokenId = 2;
      if (m2 === 4) over.targetEntityId = ALICE;
      const secret = hex(r, 32);
      let tx = { type: "htlcPayment", data: { targetEntityId: CAROL, tokenId: 1, amount: 100n, maxSenderDebit: 5000n, deliveryMode: "instant", ...over } } as any;
      const registered = ogTry(() => withDeterministicHtlcTestSecret(tx, secret));
      if (registered.ok) tx = registered.value;
      const ogHash = ogTry(() => ogAdmission.hashRawHtlcPaymentTx(tx));
      const og = await ogTryAsync(() => ogAdmission.materializeOriginatedHtlcPayments({ state: ogStateOf(alice, ts) as never, proposalTxs: [tx], profiles: profiles as never, height: 1, resolveRoute: ogResolve(profiles, ALICE) as never }));
      const rw = materializeOriginated(view, profiles, [tx], { profiles, secretFor: (h) => (ogHash.ok && h === ogHash.value && registered.ok ? secret : undefined) });
      same(og, rw.refused.size === 0 ? { ok: true, value: rw.originated } : { ok: false }, `mat${i}`);
      if (og.ok) accepted++;
    }
    expect(accepted).toBeGreaterThan(40);
  });

  test("MATCH: Alice pays Carol with no route; the frame routes Alice -> Bob -> Carol like og and settles, Bob earning og's quoted fee", () => {
    const secret = "0x" + "42".repeat(32), profiles = baseProfiles();
    const tx = withDeterministicHtlcTestSecret({ type: "htlcPayment", data: { targetEntityId: CAROL, tokenId: 1, amount: 100n, maxSenderDebit: 200n, route: [], deliveryMode: "instant" } } as never, secret) as unknown as EntityTx;
    const txHash = ogAdmission.hashRawHtlcPaymentTx(tx as never);
    const ctx = { ...verifiers, htlcInfra: (id: EntityId) => ({ profiles, online: () => true, encryptionPrivateKey: ENTITY_KEYS.get(id)!.priv, ...(id === ALICE ? { secretFor: (h: string) => (h === txHash ? secret : undefined) } : {}) }) };
    const done = quiet(network(), [inputOf(ALICE, [tx], NOW + 1000n)], ctx);
    for (const id of [ALICE, BOB, CAROL]) expect([...(replicaOf(done, id).state.paybook?.entries ?? new Map()).keys()]).toEqual([]);
    const m = new Map<string, unknown>((profiles as unknown as { entityId: string }[]).map((p) => [p.entityId, p]));
    const route = new PathFinder(ogBuildGraph(m as never, 1)).findRoutes(ALICE, CAROL, 100n, 1)[0]!;
    expect(route.path).toEqual([ALICE, BOB, CAROL]);
    expect(replicaOf(done, BOB).state.paybook?.feesEarned).toBe(route.totalFee);
    const d = replicaOf(done, BOB).accountReplicas.get(CAROL)!.state.account.deltas.get(unwrap(tokenId("1")))!;
    expect(d.offdelta + d.ondelta).toBe(isLeft(BOB, replicaId(replicaOf(done, BOB).accountReplicas.get(CAROL)!)) ? -100n : 100n);
  });
});

// ---- og entity/tx/handlers/cross-j/setup.ts: prepare / materialize / register, collections and the runtimeOutput lane ----
import * as ogSetup from "../../core/entity/tx/handlers/cross-j/setup.ts";
import * as ogCrossIndex from "../../core/extensions/cross-j/index.ts";
import { MalformedEntityFrameInputError } from "../../core/entity/tx/processing/invariant-errors.ts";
import { readEntityFrameEvents } from "../../core/entity/frame-events.ts";
import { ensureEntityCollectionCandidate, entityCollectionCommitment as ogCollectionCommitment } from "../../core/entity/state/persistent-collection-map.ts";
import { assertRuntimeOutputAuthorization } from "../../core/entity/auth/authorization.ts";
import { materializeCommittedEntityOutputs } from "../../core/entity/consensus/output/publication.ts";
import { appendDefaultProposerCrossJMaterializations, selectCrossJCommitPhaseTxs, selectCrossJOpeningAccountProposalTxs } from "../../core/entity/transition/cross-j-proposer-materialization.ts";
import {
  accountId as rwAccountId, applyEntityInput, crossMaterialize, crossPrepare, crossRegister, entityCollectionCommitment, genesisReplica, holds, prepareCrossRoute, runtimeOutputAuthError,
  type AccountReplica, type CrossEntityView, type CrossRoute, type CrossSetup, type Domain, type EntityError, type EntityState, type Result, type TokenId,
} from "../xln.ts";

const J1: Domain = { chainId: 1, depositoryAddress: "0x" + "11".repeat(20) }, J2: Domain = { chainId: 31337, depositoryAddress: "0x" + "ab".repeat(20) };
const S1 = `stack:1:${J1.depositoryAddress}`, S2 = `stack:31337:${J2.depositoryAddress}`;
const U1 = ("0x" + "01".repeat(32)) as EntityId, H1 = ("0x" + "02".repeat(32)) as EntityId, H2 = ("0x" + "03".repeat(32)) as EntityId, U2 = ("0x" + "04".repeat(32)) as EntityId;
const SIGNER: Readonly<Record<string, string>> = { [U1]: "0x" + "a1".repeat(20), [H1]: "0x" + "a2".repeat(20), [H2]: "0x" + "a3".repeat(20), [U2]: "0x" + "a4".repeat(20) };
const signerOf = (e: string): string => { const s = SIGNER[e]; if (s === undefined) throw new Error(`no signer for ${e}`); return s; };
const T0 = 1_700_000_050_000, RUNTIME_SEED = "0x" + "5e".repeat(32), CLOCK60 = { leftResponseSeconds: 60, rightResponseSeconds: 60 };
const PEER: Readonly<Record<string, EntityId>> = { [U1]: H1, [H1]: U1, [H2]: U2, [U2]: H2 };
const JUR: Readonly<Record<string, Domain>> = { [U1]: J1, [H1]: J1, [H2]: J2, [U2]: J2 };

const baseRoute = (r: Rand): CrossRoute => ({
  orderId: `order-${int(r, 1e6)}`, makerEntityId: U1, hubEntityId: H1,
  source: { jurisdiction: S1, entityId: U1, counterpartyEntityId: H1, tokenId: pick(r, [1, 1, 3, 2]), amount: pick(r, [10n ** 6n, 5n * 10n ** 9n, 7n * 10n ** 12n, BigInt(1 + int(r, 1e9))]) },
  target: { jurisdiction: S2, entityId: H2, counterpartyEntityId: U2, tokenId: pick(r, [1, 2, 3, 4]), amount: pick(r, [10n ** 6n, 10n ** 18n, 7n * 10n ** 12n, BigInt(1 + int(r, 1e9))]) },
  sourceDisputeConfig: CLOCK60, targetDisputeConfig: CLOCK60, status: "intent", createdAt: T0 - 1000, updatedAt: T0 - 1000, expiresAt: T0 + 60_000,
  sourceSignerId: signerOf(U1), sourceHubSignerId: signerOf(H1), targetHubSignerId: signerOf(H2), targetSignerId: signerOf(U2),
});
type AcctSpec = { readonly disputeConfig: { leftResponseSeconds: number; rightResponseSeconds: number }; readonly collateral: bigint; readonly ondelta: bigint; readonly leftCredit: bigint; readonly rightCredit: bigint; readonly pulls: readonly { pullId: string; fullHash: string; partialRoot: string; orderId?: string }[] };
const acct = (self: EntityId, spec: AcctSpec): { rw: AccountReplica; og: unknown } => {
  const peer = PEER[self]!, id = unwrap(rwAccountId(self, peer)), g = unwrap(genesisReplica(id, { ...TERMS, domain: JUR[self]!, disputeConfig: spec.disputeConfig }));
  const deltas = new Map([1, 2, 3, 4].map((t) => { const tk = String(t) as TokenId; return [tk, { tokenId: tk, collateral: spec.collateral, ondelta: spec.ondelta, offdelta: 0n, leftCreditLimit: spec.leftCredit, rightCreditLimit: spec.rightCredit }] as const; }));
  const pulls = new Map(spec.pulls.map((p) => [p.pullId, { pullId: p.pullId, tokenId: 1, amount: 1n, claimedRatio: 0, claimedAmount: 0n, fullHash: p.fullHash, partialRoot: p.partialRoot, crossJurisdiction: { orderId: p.orderId ?? "other", routeHash: "0x" + "00".repeat(32), leg: "source" as const }, createdHeight: 1, createdTimestamp: 1 }]));
  const rw = { ...g, state: { ...g.state, account: { ...g.state.account, deltas }, pulls } } as AccountReplica;
  const left = id.left, right = id.right;
  const og = {
    status: "active", mempool: [],
    state: { domain: JUR[self], leftEntity: left, rightEntity: right, disputeConfig: spec.disputeConfig, pulls: new Map([...pulls].map(([k, p]) => [k, { ...p }])),
      deltas: new Map([...deltas].map(([tk, d]) => [Number(tk), { ...d, tokenId: Number(tk), leftAllowance: 0n, rightAllowance: 0n, leftHold: holds(rw.state, tk, true), rightHold: holds(rw.state, tk, false) }])) },
  };
  return { rw, og };
};
type Fixture = { readonly self: EntityId; readonly validators: readonly string[]; readonly account?: AcctSpec | undefined; readonly swaps?: ReadonlyMap<string, CrossRoute> | undefined; readonly auths?: ReadonlyMap<string, CrossRoute> | undefined; readonly jurisdictionName?: string; readonly ext?: { readonly books: Map<string, { lastAcceptedUsdAskPriceTicks: bigint }>; readonly hubProfile: { referenceTokenId: number } } };
const viewOf = (f: Fixture): CrossEntityView => {
  const a = f.account === undefined ? undefined : acct(f.self, f.account);
  return { id: f.self, timestamp: T0, validators: f.validators, jurisdiction: JUR[f.self]!, jurisdictionName: f.jurisdictionName ?? "J-local", replicas: new Map(a === undefined ? [] : [[PEER[f.self]!, a.rw]]), swaps: f.swaps, auths: f.auths, ext: f.ext as never };
};
const ogCollection = (m: ReadonlyMap<string, CrossRoute> | undefined): unknown => {
  if (m === undefined) return undefined;
  const c = ensureEntityCollectionCandidate(undefined, ogCrossIndex.cloneCrossJurisdictionRoute as never) as Map<string, unknown>;
  for (const [k, v] of m) c.set(k, ogCrossIndex.cloneCrossJurisdictionRoute(v as never));
  return c;
};
const ogStateOfFixture = (f: Fixture): any => {
  const a = f.account === undefined ? undefined : acct(f.self, f.account), j = JUR[f.self]!;
  return {
    entityId: f.self, timestamp: T0, config: { mode: "proposer-based", threshold: 1n, validators: [...f.validators], shares: Object.fromEntries(f.validators.map((v) => [v, 1n])), jurisdiction: { name: f.jurisdictionName ?? "J-local", chainId: j.chainId, depositoryAddress: j.depositoryAddress } },
    accounts: new Map(a === undefined ? [] : [[PEER[f.self]!, a.og]]),
    ...(f.ext === undefined ? {} : { orderbookExt: f.ext }), ...(f.swaps === undefined ? {} : { crossJurisdictionSwaps: ogCollection(f.swaps) }), ...(f.auths === undefined ? {} : { crossJurisdictionAuthorizations: ogCollection(f.auths) }),
  };
};
const entriesOf = (m: unknown): unknown => (m === undefined ? null : [...(m as Map<string, unknown>).entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
const ogAcctTx = (t: any): unknown => {
  const { type, ...data } = t;
  return type === "cross_pull_lock" ? { type, data: { ...data, tokenId: Number(data.tokenId) } } : { type, data: { ...data, giveTokenId: Number(data.giveTokenId), wantTokenId: Number(data.wantTokenId) } };
};
type Outcome = { kind: "ok"; messages: unknown; swaps: unknown; auths: unknown; outputs: unknown; accountTxs: unknown; roots: unknown } | { kind: "reject" | "fatal"; message: string };
const ogOutcome = (f: () => { newState: any; outputs: any[]; accountTxs?: any[] }): Outcome => {
  try {
    const res = f(), s = res.newState, root = (m: unknown) => (m === undefined ? null : ogCollectionCommitment(m as never));
    return { kind: "ok", messages: readEntityFrameEvents(s), swaps: entriesOf(s.crossJurisdictionSwaps), auths: entriesOf(s.crossJurisdictionAuthorizations),
      outputs: res.outputs.map((o) => ({ entityId: o.entityId, signerId: o.signerId, txs: o.entityTxs })), accountTxs: (res.accountTxs ?? []).map((t) => ({ accountId: t.accountId, tx: t.tx })),
      roots: [root(s.crossJurisdictionSwaps), root(s.crossJurisdictionAuthorizations)] };
  } catch (e) {
    return e instanceof MalformedEntityFrameInputError ? { kind: "reject", message: e.rejection } : { kind: "fatal", message: (e as Error).message };
  }
};
const rwOutcome = (r: Result<CrossSetup, EntityError>): Outcome => {
  if (!r.ok) return r.error._tag === "cross_j_entity" ? { kind: "reject", message: r.error.reason } : { kind: "fatal", message: r.error._tag === "entity_invariant" ? r.error.reason : r.error._tag };
  const s = r.value, root = (m: ReadonlyMap<string, CrossRoute> | undefined) => (m === undefined ? null : unwrap(entityCollectionCommitment(new Map([...m].map(([k, v]) => [k, v as unknown as Binary])))));
  return { kind: "ok", messages: s.messages.map((message) => ({ type: "status", message })), swaps: entriesOf(s.swaps), auths: entriesOf(s.auths),
    outputs: s.outputs, accountTxs: s.accountTxs.map((t) => ({ accountId: t.accountId, tx: ogAcctTx(t.tx) })), roots: [root(s.swaps), root(s.auths)] };
};
const ogEnv = { state: { timestamp: T0 }, runtimeSeed: RUNTIME_SEED } as never;
const MUT = { mutableFrameState: true } as never;
const expectSame = (og: Outcome, rw: Outcome, label: string): void => { expect(`${label}:${stableJson(rw)}`).toBe(`${label}:${stableJson(og)}`); };

/**
 * The prepared form of a route, or the route itself when it cannot be prepared (a mutated route: an expired
 * expiresAt, a foreign jurisdiction, ...; og buildPreparedCrossJurisdictionRoute throws the same code). A node
 * only ever stores or forwards a prepared route that preparation accepted.
 */
const preparedOr = (route: CrossRoute): CrossRoute => { const p = prepareCrossRoute(route, { runtimeSeed: RUNTIME_SEED, now: T0 }); return p.ok ? p.value : route; };
/** One random corruption of the route a handler sees. */
const mutateRoute = (r: Rand, route: CrossRoute): CrossRoute => {
  const k = int(r, 22);
  if (k === 0) return { ...route, expiresAt: T0 - 1 };
  if (k === 1) { const { sourceSignerId: _, ...rest } = route; return rest as CrossRoute; }
  if (k === 2) { const { targetSignerId: _, ...rest } = route; return rest as CrossRoute; }
  if (k === 3) return { ...route, source: { ...route.source, jurisdiction: S2 } };
  if (k === 4) return { ...route, source: { ...route.source, jurisdiction: "bogus" } };
  if (k === 5) return { ...route, riskMode: "credit_line" };
  if (k === 6) return { ...route, routeHash: "0x" + "ee".repeat(32) };
  if (k === 7) return { ...route, sourceDisputeConfig: { leftResponseSeconds: 61, rightResponseSeconds: 60 } };
  if (k === 8) return { ...route, sourceHubSignerId: "0x" + "99".repeat(20) };
  if (k === 9) return { ...route, status: pick(r, ["resting", "cancelled", "target_prepared"] as const) };
  if (k === 10) return { ...route, targetDisputeConfig: { leftResponseSeconds: -1, rightResponseSeconds: 60 } };
  if (k === 11) return { ...route, target: { ...route.target, jurisdiction: S1 } };
  return route;
};

describe(seedTag("entity-lane: cross-j setup handlers (og entity/tx/handlers/cross-j/setup.ts)"), () => {
  test("MATCH: prepareCrossJurisdictionSwap at the source user, target user, source hub and a stranger on 400 random routes, accounts, validators and stored routes", () => {
    const r = rng(51), kinds = new Map<string, number>();
    for (let i = 0; i < 400; i++) {
      const self = pick(r, [U1, U2, H1, H1, H2]);
      let route = baseRoute(r);
      if (r() < 0.5) route = mutateRoute(r, route);
      const canon = ogTry(() => ogCrossIndex.withCanonicalCrossJurisdictionRouteHash(route as never) as unknown as CrossRoute);
      const stored = (): ReadonlyMap<string, CrossRoute> | undefined => {
        if (!canon.ok || r() < 0.5) return undefined;
        const c = canon.value, k = int(r, 5);
        const v: CrossRoute = k === 0 ? c : k === 1 ? { ...c, memo: "different" } : k === 2 ? { ...c, status: "cancelled" } : k === 3 ? preparedOr(c) : { ...preparedOr(c), routeHash: "0x" + "dd".repeat(32) };
        return new Map([[c.orderId, v]]);
      };
      const fixture: Fixture = {
        self, validators: r() < 0.1 ? ["0x" + "77".repeat(20)] : r() < 0.1 ? [] : [signerOf(self), ...(r() < 0.3 ? ["0x" + "78".repeat(20)] : [])],
        ...(r() < 0.9 ? { account: { disputeConfig: r() < 0.9 ? CLOCK60 : { leftResponseSeconds: 60, rightResponseSeconds: 30 }, collateral: 0n, ondelta: 0n, leftCredit: 0n, rightCredit: 0n, pulls: [] } } : {}),
        ...(self === H1 ? { swaps: stored() } : { auths: stored() }),
        ...(r() < 0.2 ? { jurisdictionName: "other-name" } : {}),
      };
      // a prepared payload over the user lane (hub) or at a user
      if (r() < 0.15 && canon.ok) route = preparedOr(canon.value);
      if (r() < 0.05 && route.sourcePull !== undefined) { const { targetPull: _, ...rest } = route; route = rest as CrossRoute; }
      const og = ogOutcome(() => ogSetup.handlePrepareCrossJurisdictionSwapEntityTx(ogEnv, ogStateOfFixture(fixture), { type: "prepareCrossJurisdictionSwap", data: { route } } as never, MUT) as never);
      const rw = rwOutcome(crossPrepare(viewOf(fixture), route));
      expectSame(og, rw, `prepare${i}`);
      kinds.set(og.kind, (kinds.get(og.kind) ?? 0) + 1);
      if (og.kind === "ok") for (const m of og.messages as { message: string }[]) kinds.set(m.message.replace(/order-\d+ /, "").replace(/:.*/, ""), 1);
      else kinds.set(og.message.replace(/:.*/, ""), 1);
    }
    expect(kinds.get("ok") ?? 0).toBeGreaterThan(150);
    expect(kinds.get("fatal") ?? 0).toBeGreaterThan(10);
    // every og branch the fixtures can reach was reached
    for (const m of ["🌉 Cross-j swap authorized by source user", "🌉 Cross-j swap authorized by target user", "🌉 Cross-j swap auth retry re-emitted by source user", "🌉 Cross-j swap awaiting source-hub proposer commitments",
      "🌉 Cross-j prepare already materialized; replay ignored", "❌ Cross-j prepare wrong source hub", "❌ Cross-j prepare invalid route", "❌ Cross-j prepare blocked", "❌ Cross-j prepare expired",
      "❌ Cross-j prepare rejected", "CROSS_J_USER_AUTH_CONFLICT", "CROSS_J_RAW_PREPARE_CONFLICT", "CROSS_J_RAW_PREPARE_AFTER_MATERIALIZATION", "CROSS_J_USER_AUTH_PREPARED_FORBIDDEN"]) expect(`${m}:${kinds.has(m)}`).toBe(`${m}:true`);
  });

  test("MATCH: materializeCrossJurisdictionSwap by the default proposer on 300 random stored intents, proposer ids, prepared routes and USD caps (orderbookExt-priced non-stable legs)", () => {
    const r = rng(52), kinds = new Map<string, number>();
    // og internalUsdPrice: a non-stable leg is priced at the hub's last accepted authority ask against its reference token
    const extOf = () => r() < 0.3 ? undefined : { hubProfile: { referenceTokenId: pick(r, [1, 1, 1, 3, 2]) }, books: new Map([2, 4].map((t) => [`1/${t}`, { lastAcceptedUsdAskPriceTicks: pick(r, [0n, 10_000n, 25_000_000n, 10n ** 12n, 10n ** 20n, 10n ** 20n]) }])) };
    for (let i = 0; i < 300; i++) {
      const base = baseRoute(r), intent = ogCrossIndex.withCanonicalCrossJurisdictionRouteHash(base as never) as unknown as CrossRoute;
      const k = int(r, 8);
      const storedRoute: CrossRoute = k === 0 ? { ...intent, memo: "x" } : k === 1 ? { ...intent, status: "cancelled" } : k === 2 ? unwrap(prepareCrossRoute(intent, { runtimeSeed: RUNTIME_SEED, now: T0 })) : intent;
      const stored = r() < 0.08 ? undefined : new Map([[intent.orderId, storedRoute]]);
      let prepared: CrossRoute = unwrap(prepareCrossRoute(intent, { runtimeSeed: RUNTIME_SEED, now: T0 }));
      const t = int(r, 10);
      if (t === 0) prepared = { ...prepared, updatedAt: T0 + 40_000 };
      if (t === 1) prepared = { ...prepared, sourcePull: { ...prepared.sourcePull!, amount: prepared.sourcePull!.amount + 1n } };
      if (t === 2) prepared = { ...prepared, targetPull: { ...prepared.targetPull!, fullHash: "0x" + "12".repeat(32) } };
      if (t === 3) prepared = { ...prepared, sourcePull: { ...prepared.sourcePull!, pullId: "0x" + "34".repeat(32) } };
      const fixture: Fixture = {
        self: H1, validators: [signerOf(H1)], swaps: stored, ...(() => { const ext = extOf(); return ext === undefined ? {} : { ext }; })(),
        ...(r() < 0.95 ? { account: { disputeConfig: r() < 0.93 ? CLOCK60 : { leftResponseSeconds: 60, rightResponseSeconds: 1 }, collateral: 0n, ondelta: 0n, leftCredit: 0n, rightCredit: 0n, pulls: [] } } : {}),
      };
      const proposerSignerId = r() < 0.9 ? signerOf(H1) : "0x" + "66".repeat(20);
      const data = { proposerSignerId, route: prepared };
      const og = ogOutcome(() => ogSetup.handleMaterializeCrossJurisdictionSwapEntityTx(ogEnv, ogStateOfFixture(fixture), { type: "materializeCrossJurisdictionSwap", data } as never, MUT) as never);
      const rw = rwOutcome(crossMaterialize(viewOf(fixture), data));
      expectSame(og, rw, `materialize${i}`);
      kinds.set(og.kind, (kinds.get(og.kind) ?? 0) + 1);
      if (og.kind === "ok") for (const m of og.messages as { message: string }[]) if (m.message.includes("CROSS_J_BOOK_USD_CAP_EXCEEDED")) kinds.set(`cap:${Number(intent.source.tokenId) === 2 ? "priced" : "stable"}`, 1);
    }
    expect(kinds.get("ok") ?? 0).toBeGreaterThan(100);
    expect([kinds.has("cap:priced"), kinds.has("cap:stable")]).toEqual([true, true]);
  });

  test("MATCH: registerCrossJurisdictionSwap at both hubs and a user on 300 random resting routes, pull pre-checks, capacities and stored routes", () => {
    const r = rng(53), kinds = new Map<string, number>(), seen = new Set<string>();
    for (let i = 0; i < 300; i++) {
      const intent = ogCrossIndex.withCanonicalCrossJurisdictionRouteHash(baseRoute(r) as never) as unknown as CrossRoute;
      const prepared = unwrap(prepareCrossRoute(intent, { runtimeSeed: RUNTIME_SEED, now: T0 }));
      let route: CrossRoute = { ...prepared, status: pick(r, ["resting", "resting", "resting", "partially_filled", "target_prepared"] as const) };
      if (r() < 0.25) route = mutateRoute(r, route);
      const self = pick(r, [H1, H1, H2, H2, U1]);
      const k = int(r, 6);
      const swaps = self !== H1 || k === 0 ? undefined : new Map([[intent.orderId, k === 1 ? { ...prepared, status: "cancelled" as const } : k === 2 ? { ...prepared, routeHash: "0x" + "dd".repeat(32) } : k === 3 ? intent : prepared]]);
      const pulls = r() < 0.15 ? [{ pullId: r() < 0.5 ? prepared.sourcePull!.pullId : prepared.targetPull!.pullId, fullHash: "0x" + "56".repeat(32), partialRoot: "0x" + "57".repeat(32) }]
        : r() < 0.1 ? [{ pullId: "other", fullHash: prepared.sourcePull!.fullHash, partialRoot: "0x" + "58".repeat(32) }] : [];
      const big = 10n ** 30n;
      const fixture: Fixture = {
        self, validators: [signerOf(self)], swaps,
        ...(r() < 0.95 ? { account: { disputeConfig: CLOCK60, collateral: pick(r, [0n, big]), ondelta: pick(r, [0n, big, -big]), leftCredit: pick(r, [0n, big, 10n]), rightCredit: pick(r, [0n, big, 10n]), pulls } } : {}),
      };
      const og = ogOutcome(() => ogSetup.handleRegisterCrossJurisdictionSwapEntityTx(ogEnv, ogStateOfFixture(fixture), { type: "registerCrossJurisdictionSwap", data: { route } } as never, MUT) as never);
      const rw = rwOutcome(crossRegister(viewOf(fixture), route));
      expectSame(og, rw, `register${i}`);
      kinds.set(og.kind, (kinds.get(og.kind) ?? 0) + 1);
      if (og.kind === "ok") for (const m of og.messages as { message: string }[]) seen.add(m.message.replace(/order-\d+/, "ID").split(":")[0]!);
    }
    expect(kinds.get("ok") ?? 0).toBeGreaterThan(200);
    expect([...seen].some((m) => m.includes("rejected before Account queue"))).toBe(true);
  });
});

// ---- og certified Entity -> Entity lane: publication, runtimeOutput authorization, default-proposer materialization ----
import { selectCommitPhaseTxs, stackIdOf, type EntityOutput } from "../xln.ts";

/** An og EntityState for a live og call, read from a rewrite replica at a frame timestamp. */
const ogEntityState = (r: EntityReplica, timestamp: number): any => {
  const signer = r.signerId.toLowerCase();
  return {
    entityId: r.state.id, timestamp, config: { mode: "proposer-based", threshold: 1n, validators: [signer], shares: { [signer]: 1n }, jurisdiction: { chainId: r.state.jurisdiction.chainId, depositoryAddress: r.state.jurisdiction.depositoryAddress } },
    accounts: new Map([...r.accountReplicas].map(([peer, c]) => {
      const id = replicaId(c);
      return [peer, { status: "active", mempool: [], state: { domain: c.state.terms.domain, leftEntity: id.left, rightEntity: id.right, disputeConfig: c.state.terms.disputeConfig, pulls: new Map(c.state.pulls ?? []),
        deltas: new Map([...c.state.account.deltas].map(([tk, d]) => [Number(tk), { ...d, tokenId: Number(tk), leftAllowance: 0n, rightAllowance: 0n, leftHold: holds(c.state, tk, true), rightHold: holds(c.state, tk, false) }])) } }];
    })),
    ...(r.state.crossJurisdictionSwaps === undefined ? {} : { crossJurisdictionSwaps: ogCollection(r.state.crossJurisdictionSwaps) }),
    ...(r.state.crossJurisdictionAuthorizations === undefined ? {} : { crossJurisdictionAuthorizations: ogCollection(r.state.crossJurisdictionAuthorizations) }),
  };
};
const runtimeOutputsOf = (outbox: readonly EntityOutput[]): unknown[] =>
  outbox.flatMap((o) => ("input" in o && o.input.kind === "txs" && o.input.txs.length === 1 && o.input.txs[0]!.type === "runtimeOutput" ? [{ entityId: o.to, signerId: o.signerId.toLowerCase(), entityTxs: o.input.txs }] : []));
const wakesOf = (outbox: readonly EntityOutput[]): unknown[] =>
  outbox.flatMap((o) => ("input" in o && o.input.kind === "txs" && o.input.txs.length === 0 ? [{ entityId: o.to, signerId: o.signerId.toLowerCase(), entityTxs: [] }] : []));
const routeOf = (o: EntityOutput): RoutedEntityInput => {
  if (!("input" in o)) throw new Error("not an Entity input");
  return { entityId: o.to, signerId: o.signerId, input: o.input };
};

describe(seedTag("entity-lane: certified Entity -> Entity lane (og consensus/output/publication.ts, auth/authorization.ts, transition/cross-j-proposer-materialization.ts)"), () => {
  test("MATCH: a user authorization reaches the source hub as a runtimeOutput, the default proposer materializes it, and the hub registers its own leg, frame by frame against og", () => {
    // ALICE is the source user, BOB the source hub (their Account is live); the target leg names two remote Entities on another stack
    const H2x = ("0x" + "03".repeat(32)) as EntityId, U2x = ("0x" + "04".repeat(32)) as EntityId, ogEnvAt = (timestamp: number) => ({ state: { timestamp }, runtimeSeed: RUNTIME_SEED }) as never;
    let rt = network();
    const t0 = Number(rt.timestamp) + 10_000;
    const route: CrossRoute = {
      orderId: "lane-1", makerEntityId: ALICE, hubEntityId: BOB,
      source: { jurisdiction: stackIdOf(TERMS.domain), entityId: ALICE, counterpartyEntityId: BOB, tokenId: 1, amount: 100n },
      target: { jurisdiction: S1, entityId: H2x, counterpartyEntityId: U2x, tokenId: 2, amount: 10n ** 18n },
      sourceDisputeConfig: TERMS.disputeConfig, targetDisputeConfig: CLOCK60, status: "intent", createdAt: t0, updatedAt: t0, expiresAt: t0 + 3_600_000,
      sourceSignerId: aliceAddr.toLowerCase(), sourceHubSignerId: bobAddr.toLowerCase(), targetHubSignerId: signerOf(H2), targetSignerId: signerOf(U2),
    };
    const ctx = { ...verifiers, runtimeSeed: RUNTIME_SEED, htlcInfra: (id: EntityId) => ({ profiles: [], encryptionPrivateKey: ENTITY_KEYS.get(id)?.priv }) } as typeof verifiers;
    const apply = (inputs: RoutedEntityInput[]) => { const s = unwrap(applyRuntime(rt, { runtimeTxs: [], entityInputs: inputs }, ctx)); expect(s.rejected).toEqual([]); return s; };

    // 1. ALICE authorizes as the source user. The committed command targets BOB's replica of this Runtime, so og drains it in the same Runtime
    //    frame (drainImmediateCrossJurisdictionOutputs): nothing leaves in the outbox, BOB stores the raw intent and wakes its default proposer.
    const alice0 = replicaOf(rt, ALICE), bob0 = replicaOf(rt, BOB), a = apply([inputOf(ALICE, [{ type: "prepareCrossJurisdictionSwap", data: { route } } as EntityTx], BigInt(t0))]);
    const ta = Number(a.runtime.timestamp), ogA = ogSetup.handlePrepareCrossJurisdictionSwapEntityTx(ogEnvAt(ta), ogEntityState(alice0, ta), { type: "prepareCrossJurisdictionSwap", data: { route } } as never, MUT);
    expect(readEntityFrameEvents(ogA.newState).map((e: any) => e.message)).toEqual([`🌉 Cross-j swap lane-1 authorized by source user`]);
    const commands = materializeCommittedEntityOutputs(ogA.outputs as never, ALICE, aliceAddr.toLowerCase(), true) as unknown as { entityId: string; signerId: string; entityTxs: EntityTx[] }[];
    expect(commands.map((o) => [o.entityId.toLowerCase(), o.signerId.toLowerCase()])).toEqual([[BOB.toLowerCase(), bobAddr.toLowerCase()]]);
    expect(runtimeOutputsOf(a.outbox)).toEqual([]);
    expect(stableJson(entriesOf(replicaOf(a.runtime, ALICE).state.crossJurisdictionAuthorizations))).toBe(stableJson(entriesOf(ogA.newState.crossJurisdictionAuthorizations)));
    const outTx = commands[0]!.entityTxs[0] as Extract<EntityTx, { type: "runtimeOutput" }>, ogBob0 = ogEntityState(bob0, ta);
    expect(ogTry(() => assertRuntimeOutputAuthorization(outTx.data.sourceEntityId, outTx.data.sourceSignerId, outTx.data.targetEntityId, outTx.data.entityTxs as never, ogBob0)).ok).toBe(true);
    expect(runtimeOutputAuthError(bob0.state, outTx.data)).toBe(null);
    const ogB = ogSetup.handlePrepareCrossJurisdictionSwapEntityTx(ogEnvAt(ta), ogBob0, outTx.data.entityTxs[0] as never, MUT);
    expect(stableJson(entriesOf(replicaOf(a.runtime, BOB).state.crossJurisdictionSwaps))).toBe(stableJson(entriesOf(ogB.newState.crossJurisdictionSwaps)));
    expect(stableJson(wakesOf(a.outbox))).toBe(stableJson(materializeCommittedEntityOutputs(ogB.outputs as never, BOB, bobAddr.toLowerCase(), true)));
    rt = a.runtime;

    // 2. The wake, one Entity at a time (applyEntityInput): og appends the proposer's materialization at admission; the frame emits both hubs' register commands
    const ectx = (id: EntityId) => ({ ...ctx, self: id, signerId: SIGNERS.get(id)!, htlc: { profiles: [], encryptionPrivateKey: ENTITY_KEYS.get(id)?.priv } }) as never;
    const wake = a.outbox.find((o) => wakesOf([o]).length === 1)!, tc = t0 + 20_000, bob1 = replicaOf(rt, BOB);
    const c = unwrap(applyEntityInput(bob1, { kind: "txs", timestamp: BigInt(tc), txs: [] }, ectx(BOB)));
    const ogBob1 = ogEntityState(bob1, tc), added = appendDefaultProposerCrossJMaterializations(ogEnvAt(tc), { entityId: BOB, signerId: bobAddr.toLowerCase(), state: ogBob1, mempool: [] } as never, []);
    expect(added.map((t) => t.type)).toEqual(["materializeCrossJurisdictionSwap"]);
    const ogC = ogSetup.handleMaterializeCrossJurisdictionSwapEntityTx(ogEnvAt(tc), ogBob1, added[0] as never, MUT);
    expect(stableJson(runtimeOutputsOf(c.outputs))).toBe(stableJson(materializeCommittedEntityOutputs(ogC.outputs as never, BOB, bobAddr.toLowerCase(), true)));
    expect(stableJson(entriesOf(c.replica.state.crossJurisdictionSwaps))).toBe(stableJson(entriesOf(ogC.newState.crossJurisdictionSwaps)));

    // 3. BOB's own register command: authorized as the source hub's self edge and registered. A registration is a cross-j setup phase, so og
    //    proposes no Account frame in it (prepareEntityFrameWorkingSet crossJSetupPhase): the legs wait in the ALICE Account mempool like og's.
    const self = c.outputs.find((o) => o.to === BOB && runtimeOutputsOf([o]).length === 1)!, td = tc + 10_000;
    if (!("input" in self) || self.input.kind !== "txs") throw new Error("expected a signed txs input to BOB");
    const reg = self.input.txs[0] as Extract<EntityTx, { type: "runtimeOutput" }>, ogBob2 = ogEntityState(c.replica, td);
    expect(ogTry(() => assertRuntimeOutputAuthorization(reg.data.sourceEntityId, reg.data.sourceSignerId, reg.data.targetEntityId, reg.data.entityTxs as never, ogBob2)).ok).toBe(true);
    expect(runtimeOutputAuthError(c.replica.state, reg.data)).toBe(null);
    const d = unwrap(applyEntityInput(c.replica, { kind: "txs", timestamp: BigInt(td), txs: [reg] }, ectx(BOB)));
    const ogD = ogSetup.handleRegisterCrossJurisdictionSwapEntityTx(ogEnvAt(td), ogBob2, reg.data.entityTxs[0] as never, MUT);
    expect(stableJson(entriesOf(d.replica.state.crossJurisdictionSwaps))).toBe(stableJson(entriesOf(ogD.newState.crossJurisdictionSwaps)));
    const child = d.replica.accountReplicas.get(ALICE)!;
    expect(child._tag).toBe("open");
    const queued = ("mempool" in child ? child.mempool : []).filter((t) => t.type === "cross_pull_lock" || t.type === "swap_offer");
    expect((ogD.accountTxs ?? []).length).toBe(2);
    expect(stableJson(queued.map(ogAcctTx))).toBe(stableJson((ogD.accountTxs ?? []).map((t: any) => t.tx)));

    // 4. Through the Runtime the registration commits, then og's Account work proposes the legs at H+1 in the same frame; the opening cohort needs
    //    the sibling hub's replica, which this Runtime does not host: og selectCrossJOpeningAccountProposalTxs halts, and so does the frame.
    const account = { mempool: (ogD.accountTxs ?? []).map((t: any) => t.tx), proofHeader: { fromEntity: BOB, toEntity: ALICE } };
    const ogHalt = ogTry(() => selectCrossJOpeningAccountProposalTxs({ state: { eReplicas: new Map() } } as never, ogBob2 as never, account as never));
    expect(ogHalt.ok).toBe(false);
    let ogMessage = "";
    try { selectCrossJOpeningAccountProposalTxs({ state: { eReplicas: new Map() } } as never, ogBob2 as never, account as never); } catch (e) { ogMessage = (e as Error).message; }
    const refused = applyRuntime(rt, { runtimeTxs: [], entityInputs: [routeOf(wake)] }, ctx);
    expect(refused.ok).toBe(false);
    const code = refused.ok ? "" : String((refused.error as { code?: string }).code);
    expect(code.startsWith("RUNTIME_CROSS_J_LOCAL_EVENT_NOT_COMMITTED:")).toBe(true);
    expect(code.split("detail=")[1]!.split(":")[0]).toBe(ogMessage.split(":")[0]);
  });

  test("MATCH: assertRuntimeOutputAuthorization on 400 random runtimeOutput envelopes (source, signer, target, tx kinds, self edges, stored routes)", () => {
    const r = rng(61), outcomes = new Map<string, number>();
    const ids = [U1, H1, H2, U2, ("0x" + "09".repeat(32)) as EntityId];
    for (let i = 0; i < 400; i++) {
      const route = ogCrossIndex.withCanonicalCrossJurisdictionRouteHash(baseRoute(r) as never) as unknown as CrossRoute;
      const target = pick(r, ids), source = r() < 0.2 ? target : pick(r, ids);
      const signer = r() < 0.7 ? (SIGNER[source] ?? "0x" + "55".repeat(20)) : pick(r, ["0x" + "55".repeat(20), "", signerOf(H1)]);
      const kind = int(r, 7);
      const txs: EntityTx[] = kind === 0 ? [] : kind === 1 ? [{ type: "prepareCrossJurisdictionSwap", data: { route } } as EntityTx] : kind === 2 ? [{ type: "registerCrossJurisdictionSwap", data: { route } } as EntityTx]
        : kind === 3 ? [{ type: "chat", data: { from: "x", message: "hi" } } as EntityTx] : kind === 4 ? [{ type: "accountInput", data: {} } as unknown as EntityTx]
        : kind === 5 ? [{ type: "prepareDispute", data: { counterpartyEntityId: U1 } } as EntityTx] : [{ type: "registerCrossJurisdictionSwap", data: { route } } as EntityTx, { type: "prepareCrossJurisdictionSwap", data: { route } } as EntityTx];
      const validators = [SIGNER[target] ?? "0x" + "56".repeat(20)];
      const ogState = { entityId: target, config: { mode: "proposer-based", threshold: 1n, validators, shares: { [validators[0]!]: 1n } } };
      const rwState = { id: target, quorum: unwrap(createEntity({ id: target, jurisdiction: TERMS.domain, threshold: 1n, members: new Map([[validators[0] as Address, { shares: 1n }]]) })).state.quorum } as unknown as EntityState;
      const data = { protocol: "cross-j" as const, sourceEntityId: source, sourceSignerId: signer, targetEntityId: r() < 0.9 ? target : U2, entityTxs: txs };
      const og = (() => { try { assertRuntimeOutputAuthorization(data.sourceEntityId, data.sourceSignerId, data.targetEntityId, data.entityTxs as never, ogState as never); return null; } catch (e) { return (e as Error).message; } })();
      expect(`${i}:${runtimeOutputAuthError(rwState, data)}`).toBe(`${i}:${og}`);
      outcomes.set(og === null ? "ok" : og.replace(/:.*/, ""), 1);
    }
    expect(outcomes.has("ok")).toBe(true);
    expect(outcomes.size).toBeGreaterThan(6);
  });

  test("MATCH: selectCrossJCommitPhaseTxs defers cross-j setup beside an Account transition", () => {
    const setup = { type: "materializeCrossJurisdictionSwap", data: { proposerSignerId: "x", route: { orderId: "o" } } } as unknown as EntityTx;
    const transition = { type: "accountInput", data: {} } as unknown as EntityTx, chat = { type: "chat", data: { from: "a", message: "m" } } as EntityTx;
    for (const txs of [[setup], [transition, setup, chat], [chat, setup], [transition, chat]]) {
      expect(stableJson(selectCommitPhaseTxs(txs))).toBe(stableJson(selectCrossJCommitPhaseTxs(txs as never).txs));
    }
  });
});
