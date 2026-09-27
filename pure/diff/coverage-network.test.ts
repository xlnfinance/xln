// Coverage: the retained network outbox merging two deliveries of one Account proposal (og runtime/delivery
// mergeAccountProposalOutput through applyRecoveryRuntimeOutputPlan) against live og. The same live frame from A to
// B leaves in several outputs, retained from earlier Runtime frames and new, carrying different Hanko evidence: the
// outbox keeps the one with more evidence, else the newer source frame, else the canonically smaller envelope.
import { describe, expect, test } from "bun:test";
import { applyRecoveryRuntimeOutputPlan as ogOutputPlan } from "../../core/runtime/delivery/recovery-output.ts";
import { encodeBuffer as ogEncodeBuffer } from "../../core/storage/codec/codec.ts";
import {
  applyRuntime, createRuntime, entityId, lazyBoardEntityId, networkOutboxStep,
  type EntityReplica, type EntityTx, type NetworkOutput, type RoutedEntityInput, type Runtime, type RuntimeRoutes, type RuntimeTx,
} from "../xln.ts";
import { TERMS, aliceAddr, bobAddr, carolAddr, unwrap, verifiers } from "../xln_run.ts";

// ---- seeded randomness: SEEDX overrides the fixed seed, and every failure names the seed ----
const SEED = process.env["SEEDX"] ? Number(process.env["SEEDX"]) : 0x0e7c0;
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
/** og's typed shells are built from plain data; this is the one place a shell is given its og type. */
const asOg = <T,>(shell: unknown): T => shell as T;
const W = (b: string): string => `0x${b.repeat(32)}`;

// ---- A (local) holds a live proposed frame to B (remote, on runtime RT1) ----
const J = "local";
const SELF = `0x${"5e".repeat(20)}`;
const RT1 = `0x${"a1".repeat(20)}`;
const RT2 = `0x${"a2".repeat(20)}`;
const cfg = (a: string) => ({
  mode: "proposer-based" as const, threshold: 1n, validators: [a], shares: { [a]: 1n },
  jurisdiction: { name: J, chainId: TERMS.domain.chainId, depositoryAddress: TERMS.domain.depositoryAddress, entityProviderAddress: `0x${"e1".repeat(20)}` },
});
const A = unwrap(entityId(unwrap(lazyBoardEntityId(asOg(cfg(aliceAddr))))));
const B = unwrap(entityId(unwrap(lazyBoardEntityId(asOg(cfg(bobAddr))))));
const NOW = 1_700_000_000_000n;
const imported = (id: string, signer: string): RuntimeTx =>
  asOg({ type: "importReplica", entityId: id, signerId: signer, data: { config: cfg(signer), isProposer: true, entitySeed: `0x${"5e".repeat(64)}` } });
type Fixture = { readonly rt: Runtime; readonly height: number; readonly stateHash: string };
const fixture = (): Fixture => {
  const booted = unwrap(applyRuntime(createRuntime([J], SELF), { runtimeTxs: [imported(A, aliceAddr), imported(B, bobAddr)], entityInputs: [], timestamp: NOW }, verifiers)).runtime;
  const openTx = asOg<EntityTx>({ type: "openAccount", data: { targetEntityId: B, accountDomain: TERMS.domain, watchSeed: TERMS.watchSeed, disputeConfig: TERMS.disputeConfig } });
  const open: RoutedEntityInput = { entityId: A, signerId: aliceAddr, input: { kind: "txs", timestamp: NOW + 1n, txs: [openTx] } };
  const opened = unwrap(applyRuntime(booted, { runtimeTxs: [], entityInputs: [open] }, verifiers)).runtime;
  const alice = [...opened.entities.values()].find((r: EntityReplica) => r.state.id === A);
  const account = alice?.accountReplicas.get(B);
  if (account === undefined || account._tag !== "proposed") throw new Error("fixture: A's Account to B is not proposing");
  const frame = account.candidate.frame;
  // B lives on another Runtime: drop its local replica so its outputs route remotely
  const rt = { ...opened, entities: new Map([...opened.entities].filter(([, r]) => r.state.id !== B)) };
  return { rt, height: Number(frame.height), stateHash: frame.stateHash };
};
const FX = fixture();
const OG_REPLICAS = new Map([[`${A}:${aliceAddr}`, {
  entityId: A, state: { accounts: new Map([[B.toLowerCase(), { pendingFrame: { height: FX.height, stateHash: FX.stateHash } }]]) },
}]]);

// ---- one delivery of the live proposal, with or without each Hanko ----
const proposalOutput = (retained: boolean): NetworkOutput => {
  const frame = { height: FX.height, timestamp: 5, jHeight: 0, prevFrameHash: W("01"), stateHash: FX.stateHash, accountStateRoot: W("02"), byLeft: true, accountTxs: [] };
  const proposal = {
    frame,
    ...(rng() < 0.6 ? { frameHanko: `0x${pick(["aa", "ab"]).repeat(40)}` } : {}),
    ...(rng() < 0.4 ? { disputeHanko: { hash: W("0d"), hanko: `0x${"bb".repeat(40)}` } } : {}),
  };
  const tx = { type: "accountInput", data: { fromEntityId: A, toEntityId: B, kind: "ack_frame", proposal } };
  const source = retained
    ? { runtimeId: pick([RT1, RT1, RT2]), sourceRuntimeFrame: { height: Number(FX.rt.height) - 1 - ri(2), timestamp: pick([7, 8]) } }
    : rng() < 0.2 ? { sourceRuntimeFrame: { height: Number(FX.rt.height), timestamp: Number(FX.rt.timestamp) } } : {};
  return asOg<NetworkOutput>({ entityId: B, signerId: bobAddr.toLowerCase(), entityTxs: [tx], ...source });
};
const rows = (outputs: readonly unknown[]): readonly string[] =>
  outputs.map((o) => Buffer.from(ogEncodeBuffer(o, { omitSymbolKeys: true })).toString("hex"));
type Outcome = { readonly ok: true; readonly rows: readonly string[] } | { readonly ok: false; readonly code: string };
/** og's routing seams: B resolves to RT1, A and C are local. */
const OG_DEPS = {
  ensureRuntimeInfrastructure: (env: { infrastructure?: object }) => (env.infrastructure ??= {}),
  getP2P: () => ({ getVerifiedRuntimeRoute: () => null, enqueueEntityInputsDelivery: () => ({ ok: true }) }),
  enqueueRuntimeInputs: () => undefined,
  extractEntityId: (k: string) => k.split(":")[0],
  hasLocalSignerForEntity: (_: unknown, e: string) => e.toLowerCase() === A.toLowerCase(),
  hasLocalSignerForEntitySigner: (_: unknown, e: string, s: string) => e.toLowerCase() === A.toLowerCase() && s.toLowerCase() === aliceAddr.toLowerCase(),
  resolveSoleLocalSignerForEntity: (_: unknown, e: string) => (e.toLowerCase() === A.toLowerCase() ? aliceAddr.toLowerCase() : null),
  resolveRuntimeIdForEntity: (_: unknown, e: string) => (e.toLowerCase() === B.toLowerCase() ? RT1 : null),
  resolveRuntimeIdForCrossJurisdictionEntity: () => null,
};
const ROUTES: RuntimeRoutes = {
  verifiedProfileSigner: () => undefined, verifiedRuntime: () => undefined,
  resolvedRuntime: (e) => (e.toLowerCase() === B.toLowerCase() ? RT1 : undefined), crossJRuntime: () => undefined,
};
const ogOutcome = (prior: readonly NetworkOutput[], outs: readonly NetworkOutput[]): Outcome => {
  const env = {
    runtimeId: SELF, state: { height: Number(FX.rt.height), timestamp: Number(FX.rt.timestamp), eReplicas: OG_REPLICAS },
    gossip: { getProfile: () => null }, pendingNetworkOutputs: structuredClone(prior), warn() {}, error() {}, info() {},
  };
  try {
    ogOutputPlan(asOg(env), asOg(structuredClone(outs)), asOg(OG_DEPS), () => undefined);
    return { ok: true, rows: rows(env.pendingNetworkOutputs) };
  } catch (e) {
    return { ok: false, code: String((e as Error).message) };
  }
};
const rwOutcome = (prior: readonly NetworkOutput[], outs: readonly NetworkOutput[]): Outcome => {
  const mine = networkOutboxStep({ ...FX.rt, pendingNetworkOutputs: prior }, outs, ROUTES);
  if (!mine.ok) return { ok: false, code: (mine.error as { readonly code?: string }).code ?? mine.error._tag };
  return { ok: true, rows: rows(mine.value) };
};

describe("coverage-network: one Account proposal delivered twice merges by evidence (og mergeAccountProposalOutput)", () => {
  test("MATCH: 300 random outboxes of retained and new deliveries of one live proposal -- og's retained outbox", () => {
    const kept = new Map<string, number>();
    for (let n = 0; n < 300; n++) {
      const prior = Array.from({ length: ri(3) }, () => proposalOutput(true));
      const outs = Array.from({ length: 1 + ri(3) }, () => proposalOutput(false));
      const og = ogOutcome(prior, outs);
      const label = `seed=${SEED} case=${n}`;
      expect([label, rwOutcome(prior, outs)]).toEqual([label, og]);
      const k = og.ok ? `rows:${og.rows.length}` : og.code.split(":")[0] ?? "";
      kept.set(k, (kept.get(k) ?? 0) + 1);
    }
    // several deliveries collapse into fewer retained rows
    const summary = `seed=${SEED} ${JSON.stringify([...kept])}`;
    expect([summary, kept.has("rows:1")]).toEqual([summary, true]);
  });
});
