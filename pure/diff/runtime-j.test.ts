import { describe, expect, test } from "bun:test";
import { lcg31, seedOf, seedTag, untilCovered } from "./seed.ts";
// og Runtime J subsystems (core/runtime/j-submit, core/runtime/registration, core/jurisdiction), each run against live og.
import { applyRuntimeTx as ogApplyRuntimeTx } from "../../core/runtime/tx/tx-handlers.ts";
import { buildJurisdictionImportRequestHash } from "../../core/runtime/j-submit/jurisdiction-import.ts";
import { buildReplayVerifiableRuntimePostStateView } from "../../core/storage/wal/snapshot.ts";
import { computeRuntimePostStateComponentDigests } from "../../core/storage/hashes.ts";
import { encodeBoard, hashBoard } from "../../core/entity/factory.ts";
import { buildJSubmitAttemptId, registerPendingCommittedJOutbox, splitJOutboxForDurableSubmit } from "../../core/runtime/j-submit/j-submit-state.ts";
import { assertProposeAccountsNowTxAuthorized } from "../../core/runtime/mempool/propose-accounts-now.ts";
import { buildEntityProviderActionAttemptId } from "../../core/runtime/registration/entity-provider-action-submit-state.ts";
import { classifyRuntimeJBatchFailure } from "../../core/protocol/errors/failure-taxonomy.ts";
import { canonicalDisputeFinalizationEvidenceHash, canonicalJurisdictionEventsHash } from "../../core/jurisdiction/machine/event-observation.ts";
import { buildCertifiedRegistrationEvidence, buildRegistrationEvidenceDigest } from "../../core/jurisdiction/machine/registration-evidence/index.ts";
import { computeCanonicalReceiptsRoot, createCanonicalReceiptProofs } from "../../core/jurisdiction/machine/receipt-codec/index.ts";
import { deriveSignerKeySync, registerSignerKey, signAccountFrame } from "../../core/account/crypto.ts";
import { createEmptyEnv } from "../../core/runtime/composition.ts";
import { EntityProvider__factory } from "../../jurisdictions/typechain-types/index.ts";
import {
  applyRuntime, applyRuntimeTx, classifyJBatchFailure, createEntity, createRuntime, epActionAttemptId, initJBatch, jSubmitAttemptId, jurisdictionImportRequestHash, registerPendingJOutbox, replicaKey, runtimeComponentDigests, runtimeView, splitJOutbox, stableJson,
  type Binary, type EntityId, type EntityReplica, type EntityTx, type ImportConfig, type JInput, type JReplica, type Runtime, type RuntimeTx,
} from "../xln.ts";
import { ALICE, TERMS, aliceAddr, bobAddr, unwrap, verifiers } from "../xln_run.ts";

let seed = seedOf(29);
const rng = (): number => { seed = lcg31(seed); return seed / 0x7fffffff; };
const ri = (n: number): number => Math.floor(rng() * n);
const pick = <T>(xs: readonly T[]): T => xs[ri(xs.length)] as T;
const hex = (bytes: number): string => `0x${Array.from({ length: bytes * 2 }, () => "0123456789abcdef"[ri(16)]).join("")}`;
const rwCode = (r: { readonly ok: boolean; readonly error?: unknown }): string | null => {
  if (r.ok) return null;
  const e = r.error as { _tag: string; code?: string };
  return String(e.code ?? e._tag).split(":")[0] ?? "";
};
const ogCode = (e: unknown): string => String((e as Error).message).split(":")[0] ?? "";
/** A tree deep copy. Bun's structuredClone mis-decodes repeated references (a shared array came back as 1n, a shared object as its sibling), so harness snapshots never share. */
const treeClone = <T>(v: T): T => {
  if (v === null || typeof v !== "object") return v;
  if (v instanceof Uint8Array) return new Uint8Array(v) as T;
  if (v instanceof Map) return new Map([...v].map(([k, x]) => [treeClone(k), treeClone(x)])) as T;
  if (v instanceof Set) return new Set([...v].map(treeClone)) as T;
  if (Array.isArray(v)) return v.map(treeClone) as T;
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, treeClone(x)])) as T;
};

// ---- a live og RuntimeReplica next to a rewrite Runtime ----
type OgEnv = { state: { jReplicas: Map<string, unknown>; eReplicas: Map<string, unknown>; timestamp: number; height: number }; infrastructure: Record<string, unknown>; runtimeId?: string; activeJurisdiction?: string; browserVMState?: unknown };
const ogEnv = (): OgEnv => ({ state: { jReplicas: new Map(), eReplicas: new Map(), timestamp: 1_700_000_000_000, height: 0 }, infrastructure: {} });
const runOg = async (env: OgEnv, tx: unknown): Promise<string | null> => {
  try { await ogApplyRuntimeTx(env as never, treeClone(tx) as never, { isReplay: true }); return null; } catch (e) { return ogCode(e); }
};
const ogDigests = (env: OgEnv): unknown => computeRuntimePostStateComponentDigests(buildReplayVerifiableRuntimePostStateView(env as never));
const rwDigests = (rt: Runtime): unknown => unwrap(runtimeComponentDigests(runtimeView(rt)));
type Pair = { env: OgEnv; rt: Runtime };
const newPair = (): Pair => ({ env: ogEnv(), rt: { ...createRuntime(), timestamp: 1_700_000_000_000n } });
/** Apply one RuntimeTx to both; the accept/reject decision and the post-state component digests must agree. */
const both = async (p: Pair, tx: RuntimeTx): Promise<string | null> => {
  const og = await runOg(p.env, tx);
  const rw = applyRuntimeTx(p.rt, tx, { replay: true });
  expect(rwCode(rw)).toBe(og);
  if (rw.ok) p.rt = rw.value;
  expect(rwDigests(p.rt)).toEqual(ogDigests(p.env) as never);
  return og;
};

const addr = (): string => hex(20);
const contractsOf = (): Record<string, string> => ({ depository: addr(), entityProvider: addr(), account: addr(), deltaTransformer: addr() });
const mangleContracts = (c: Record<string, string>): unknown => pick<unknown>([
  c, c, c, undefined, { ...c, account: undefined }, { ...c, depository: `0x${"00".repeat(20)}` }, { ...c, entityProvider: "0x1234" },
  { ...c, depository: (c["depository"] ?? "").toUpperCase().replace("0X", "0x") }, { ...c, deltaTransformer: `0xAb${(c["deltaTransformer"] ?? "").slice(4)}` },
  { ...c, account: (c["account"] ?? "").slice(2) },
]);
const randomRequest = (names: readonly string[]): Record<string, unknown> => {
  if (rng() < 0.55) {
    // Well-formed: a BrowserVM stack or one RPC stack with its full contracts and deployment block.
    const rpc = rng() < 0.5;
    return {
      name: pick(names), ticker: pick(["eth", "ETH"]), chainId: pick([31337, 8453]), rpcs: rpc ? [pick(["http://rpc.example:8545", "https://rpc.example/x"])] : [],
      ...(rpc ? { contracts: contractsOf(), entityProviderDeploymentBlock: pick([1, 7]) } : rng() < 0.5 ? { contracts: contractsOf() } : {}),
      ...(rng() < 0.3 ? { blockTimeMs: 12_000 } : {}), ...(rpc && rng() < 0.3 ? { rpcPolicy: "single" } : {}),
    };
  }
  const rpcs = pick<unknown>([[], [], ["http://rpc.example:8545"], ["https://rpc.example/x"], ["ws://rpc.example"], ["not a url"], ["http://a.example", "http://a.example"], ["http://a.example", "http://b.example"], [""], "http://x"]);
  const rpcBacked = Array.isArray(rpcs) && rpcs.length > 0;
  return {
    name: pick([...names, ...names, "", "x".repeat(129), ` ${names[0]} `]), ticker: pick(["eth", "ETH", "usd", "", "x".repeat(17)]),
    chainId: pick<unknown>([31337, 31337, 1, 8453, 0, -1, 1.5, "8453"]), rpcs,
    ...(rng() < (rpcBacked ? 0.85 : 0.2) ? { contracts: mangleContracts(contractsOf()) } : {}),
    ...(rng() < (rpcBacked ? 0.85 : 0.15) ? { entityProviderDeploymentBlock: pick<unknown>([1, 7, 100, 0, 2.5]) } : {}),
    ...(rng() < 0.3 ? { blockTimeMs: pick<unknown>([1000, 12_000, 0, -5, 1.5]) } : {}),
    ...(rng() < 0.2 ? { startAtCurrentBlock: pick<unknown>([true, false, "yes"]) } : {}),
    ...(rng() < 0.25 ? { rpcPolicy: pick<unknown>(["single", "failover", { mode: "quorum", min: 1 }, { mode: "quorum", min: 5 }, "other", null]) } : {}),
    ...(rng() < 0.1 ? { tokens: pick<unknown>([[], [{ symbol: "X", decimals: 18 }]]) } : {}),
  };
};
/** A result for a pending og import, mostly well-formed, sometimes answering the wrong intent or carrying bad fields. */
const randomResult = (pending: { importId: string; requestHash: string; request: Record<string, unknown> }): Record<string, unknown> => {
  const r = pending.request, browser = (r["rpcs"] as unknown[]).length === 0;
  const contracts = (r["contracts"] as Record<string, string> | undefined) ?? contractsOf();
  const token = (id: number): Record<string, unknown> => ({ symbol: "T", name: "Token", address: addr(), decimals: 18, tokenId: id, tokenType: 0, externalTokenId: 0n });
  const base: Record<string, unknown> = {
    importId: pending.importId, requestHash: pending.requestHash, name: r["name"], chainId: r["chainId"], ticker: r["ticker"], rpcs: r["rpcs"],
    ...(r["blockTimeMs"] !== undefined ? { blockTimeMs: r["blockTimeMs"] } : {}),
    blockNumber: pick(["0", "0", "12", "01", "-1", "x"]), stateRoot: browser ? pick([hex(32), hex(32), "0x12", null]) : pick([null, null, null, hex(32)]),
    watcherConfirmationDepth: pick<unknown>([0, 0, 2, -1, 1.5]), tokenRegistry: pick<unknown>([[], [], [token(2), token(1)], [token(1), token(1)], [{ ...token(1), tokenType: 3 }], [{ ...token(1), decimals: 256 }], [{ ...token(1), address: "0x12" }]]),
    entityProviderDeploymentBlock: pick<unknown>([r["entityProviderDeploymentBlock"] ?? 1, r["entityProviderDeploymentBlock"] ?? 1, 0]),
    contracts: pick<unknown>([contracts, contracts, contracts, contractsOf(), { ...contracts, account: undefined }]),
    ...(browser ? (rng() < 0.9 ? { browserVMState: { stateRoot: hex(32), trieData: [[hex(32), hex(8)]], nonce: 1 } } : {}) : rng() < 0.1 ? { browserVMState: { stateRoot: hex(32) } } : {}),
    ...(rng() < 0.1 ? { watcherReceiptCommitment: pick(["tron-rpc-attested", "other"]) } : {}),
  };
  if (rng() < 0.5) {
    const { watcherReceiptCommitment: _, ...rest } = base;
    return {
      ...rest, blockNumber: pick(["0", "12"]), stateRoot: browser ? hex(32) : null, watcherConfirmationDepth: pick([0, 2]), tokenRegistry: pick([[], [token(2), token(1)]]),
      entityProviderDeploymentBlock: r["entityProviderDeploymentBlock"] ?? 1, contracts,
      ...(browser ? { browserVMState: { stateRoot: hex(32), trieData: [[hex(32), hex(8)]], nonce: 1 } } : { browserVMState: undefined }),
    };
  }
  return pick([base, base, base, base, { ...base, importId: hex(32) }, { ...base, ticker: "OTHER" }, { ...base, rpcs: ["http://other.example/"] }]);
};

describe(seedTag("runtime-j: the J import registry (og runtime/j-submit/jurisdiction-import.ts)"), () => {
  test("MATCH: the importJ request hash is og buildJurisdictionImportRequestHash over the normalized request", () => {
    let hashed = 0;
    for (let i = 0; i < 300; i++) {
      const req = randomRequest(["Local", "Base"]);
      let og: string | null = null, ogErr: string | null = null;
      try { og = buildJurisdictionImportRequestHash(treeClone(req) as never); } catch (e) { ogErr = ogCode(e); }
      const rw = jurisdictionImportRequestHash(req as never);
      expect(rwCode(rw)).toBe(ogErr);
      if (rw.ok) { expect(rw.value).toBe(og ?? ""); hashed++; }
    }
    expect(hashed).toBeGreaterThan(30);
  });

  test("MATCH (randomized): importJ / completeImportJ / advanceJWatcherCursor sequences -- same decisions, same post-state component digests", async () => {
    let accepted = 0, installed = 0, cursors = 0;
    for (let run = 0; run < 60; run++) {
      const p = newPair(), names = pick([["Local"], ["Local", "Base"], ["Local", "Base", "Arb"]]);
      for (let step = 0; step < 14; step++) {
        const pending = [...((p.env.infrastructure["pendingJurisdictionImports"] as Map<string, never> | undefined)?.values() ?? [])];
        const replicas = [...p.env.state.jReplicas.values()] as { contracts?: { depository?: string }; chainId?: number; blockNumber: bigint }[];
        const roll = rng();
        if (roll < 0.45 || (pending.length === 0 && replicas.length === 0)) {
          if ((await both(p, { type: "importJ", data: randomRequest(names) } as never)) === null) accepted++;
        } else if (roll < 0.8 && pending.length > 0) {
          const before = p.env.state.jReplicas.size;
          await both(p, { type: "completeImportJ", data: randomResult(pick(pending)) } as never);
          if (p.env.state.jReplicas.size > before) installed++;
        } else if (roll < 0.9 && replicas.length > 0) {
          // A result replayed after its intent completed (og IMPORT_J_RESULT_STALE / existing-replica match).
          await both(p, { type: "completeImportJ", data: randomResult({ importId: hex(32), requestHash: hex(32), request: { name: pick(names), chainId: 31337, ticker: "ETH", rpcs: [] } }) } as never);
        } else {
          const target = replicas.length > 0 ? pick(replicas) : undefined;
          const data = {
            depositoryAddress: pick<unknown>([target?.contracts?.depository, target?.contracts?.depository?.toUpperCase().replace("0X", "0x"), addr(), undefined, ""]),
            chainId: pick<unknown>([target?.chainId, target?.chainId, 1, undefined, 0]), blockNumber: pick<unknown>([ri(50), ri(50), 0, -1, 2.5]),
          };
          if ((await both(p, { type: "advanceJWatcherCursor", data } as never)) === null) cursors++;
        }
      }
      expect(p.rt.activeJurisdiction).toBe(p.env.activeJurisdiction);
    }
    expect(accepted).toBeGreaterThan(40);
    expect(installed).toBeGreaterThan(10);
    expect(cursors).toBeGreaterThan(5);
  });
});

// ---- importReplica binds its jurisdiction through the J replica registry (og requireBoundEntityConfig) ----
const SEED = "0x" + "5e".repeat(64);
describe(seedTag("runtime-j: importReplica jurisdiction binding (og jurisdiction-runtime requireBoundEntityConfig)"), () => {
  test("MATCH (randomized): the named / active / stack-ref J replica completes the config; unavailable, incomplete and conflicting stacks are refused", async () => {
    let imported = 0;
    for (let run = 0; run < 80; run++) {
      const p = newPair();
      const stacks = Array.from({ length: 1 + ri(2) }, (_, i) => ({ name: ["Local", "Base"][i] ?? "Local", chainId: pick([31337, 8453]), contracts: contractsOf() }));
      for (const s of stacks) {
        const replica = { name: s.name, blockNumber: 0n, stateRoot: null, mempool: [], blockDelayMs: 300, lastBlockTimestamp: 0, position: { x: 0, y: 50, z: 0 }, rpcs: ["http://rpc.example/"], chainId: s.chainId, entityProviderDeploymentBlock: 1, contracts: s.contracts };
        const keep = rng() < 0.85;
        p.env.state.jReplicas.set(s.name, keep ? treeClone(replica) : { ...treeClone(replica), contracts: undefined, chainId: undefined });
        p.rt = { ...p.rt, jReplicas: new Map([...p.rt.jReplicas, [s.name, keep ? replica : { ...replica, contracts: undefined, chainId: undefined }]]) };
      }
      if (rng() < 0.3) { p.env.activeJurisdiction = stacks[0]?.name ?? ""; p.rt = { ...p.rt, activeJurisdiction: stacks[0]?.name }; }
      const s = pick(stacks);
      const jurisdiction = pick<unknown>([
        { name: s.name },
        { name: s.name.toLowerCase() },
        { name: "Nowhere" },
        { name: "" },
        undefined,
        { name: s.name, chainId: s.chainId, depositoryAddress: s.contracts.depository, entityProviderAddress: s.contracts.entityProvider },
        { name: s.name, chainId: 99, depositoryAddress: addr(), entityProviderAddress: addr() },
        { name: `stack:${s.chainId}:${s.contracts.depository}` },
        { name: `stack:${s.chainId}:${addr()}` },
      ]);
      for (const signer of rng() < 0.5 ? [aliceAddr] : [aliceAddr, bobAddr]) {
        const validators = [aliceAddr, bobAddr];
        const config = { mode: "proposer-based", threshold: 1n, validators, shares: { [aliceAddr]: 1n, [bobAddr]: 1n }, ...(jurisdiction === undefined ? {} : { jurisdiction }) } as unknown as ImportConfig;
        const entityId = hashBoard(encodeBoard(config as never)).toLowerCase();
        const tx = { type: "importReplica", entityId, signerId: signer, data: { config, isProposer: signer === aliceAddr, entitySeed: SEED } } as unknown as RuntimeTx;
        const og = await runOg(p.env, tx);
        const rw = applyRuntimeTx(p.rt, tx, { replay: true });
        expect(rwCode(rw)).toBe(og);
        if (!rw.ok) continue;
        p.rt = rw.value;
        imported++;
        const ogReplica = [...p.env.state.eReplicas.values()].find((r) => (r as { signerId: string }).signerId.toLowerCase() === signer.toLowerCase()) as { state: { config: { jurisdiction: Record<string, unknown> } } };
        const bound = ogReplica.state.config.jurisdiction;
        const mine = p.rt.entities.get(replicaKey(entityId as EntityId, signer));
        expect(mine?.state.jurisdiction.depositoryAddress.toLowerCase()).toBe(String(bound["depositoryAddress"]).toLowerCase());
        expect(mine?.state.jurisdiction.chainId).toBe(bound["chainId"] as number);
        expect(mine?.state.jurisdictionConfig?.entityProviderAddress.toLowerCase()).toBe(String(bound["entityProviderAddress"]).toLowerCase());
        expect(mine?.state.jurisdictionConfig?.name).toBe(bound["name"] as string);
      }
    }
    expect(imported).toBeGreaterThan(40);
  });
});

// ---- the J submit ledger (og runtime/j-submit/j-submit-state.ts + j-submit-result.ts), each step one og Runtime frame ----
type OgFrame = { code: string | null; jOutbox: unknown[]; retries: unknown[] };
/** og applyRuntimeTransactions + applyPreparedRuntimeFrame for one RuntimeTx: its J outputs split, durable ones registered; a failed frame leaves env as it was. */
const ogFrame = async (env: OgEnv, tx: unknown): Promise<OgFrame> => {
  const snapshot = treeClone(env);
  try {
    const out = await ogApplyRuntimeTx(env as never, treeClone(tx) as never, { isReplay: true });
    const split = splitJOutboxForDurableSubmit(out as never);
    registerPendingCommittedJOutbox(env as never, split.durable);
    return { code: null, jOutbox: [...((env.infrastructure["pendingCommittedJOutbox"] as unknown[] | undefined) ?? []), ...split.maintenance], retries: split.retries };
  } catch (e) {
    Object.assign(env, snapshot);
    return { code: ogCode(e), jOutbox: [], retries: [] };
  }
};
const rwFrame = (p: Pair, tx: RuntimeTx, now: number): { code: string | null; jOutbox: readonly JInput[]; retries: readonly RuntimeTx[] } => {
  const r = applyRuntime(p.rt, { runtimeTxs: [tx], entityInputs: [], timestamp: BigInt(now) }, { ...verifiers, replay: true });
  if (!r.ok) return { code: rwCode(r), jOutbox: [], retries: [] };
  p.rt = r.value.runtime;
  return { code: null, jOutbox: r.value.jOutbox, retries: r.value.queuedRetries };
};

describe(seedTag("runtime-j: the J submit ledger (og j-submit-state.ts / j-submit-result.ts)"), () => {
  test("MATCH (randomized): retryJSubmit / recordJSubmitResult frames -- same decisions, J outbox, pending attempts, replica ledgers and post-state digests", async () => {
    const E = ALICE.toLowerCase(), A = aliceAddr.toLowerCase(), B = bobAddr.toLowerCase();
    let retried = 0, recorded = 0;
    for (let run = 0; run < 40; run++) {
      const p = newPair();
      const base = unwrap(createEntity({ id: ALICE, jurisdiction: TERMS.domain, threshold: 1n, members: new Map([[aliceAddr, { shares: 1n }], [bobAddr, { shares: 1n }]]), signerId: aliceAddr }));
      const signers = [A, B];
      const hashes = [hex(32), hex(32)];
      let batchHash = hashes[0] ?? "", nonce = 1 + ri(3), generation = 1 + ri(2), leader = pick([A, A, B]), terminal = false, now = 1_700_000_000_000;
      const witnessed = new Set<string>();
      const sync = (): void => {
        const sentBatch = { batch: initJBatch().batch, batchHash, encodedBatch: "0x1234", entityNonce: nonce, firstSubmittedAt: 0, lastSubmittedAt: 0, submitAttempts: 0, ...(terminal ? { terminalFailure: { message: "consumed", failedAt: 1 } } : {}) };
        const jBatchState = { ...initJBatch(), sentBatch, broadcastCount: generation, status: "sent" };
        const witness = new Map([...witnessed].map((h) => [h, { hanko: `0x${"ab".repeat(40)}`, type: "jBatch" as const, entityHeight: 1, createdAt: 1 }]));
        for (const s of signers) {
          const ogKey = `${E}:${s}`, prior = p.env.state.eReplicas.get(ogKey) as { jSubmitState?: unknown } | undefined;
          p.env.state.eReplicas.set(ogKey, {
            entityId: E, signerId: s, hankoWitness: treeClone(witness), ...(prior?.jSubmitState ? { jSubmitState: prior.jSubmitState } : {}),
            state: { entityId: E, config: { validators: signers, shares: { [A]: 1n, [B]: 1n } }, leaderState: { activeValidatorId: leader, view: 0, changedAtHeight: 0 }, jBatchState: treeClone(jBatchState) },
          });
          const key = replicaKey(ALICE, s);
          const mine = { ...base, signerId: s === A ? aliceAddr : bobAddr, state: { ...base.state, leaderState: { activeValidatorId: leader, view: 0, changedAtHeight: 0 }, committed: { ...base.state.committed, jBatchState: jBatchState as unknown as Binary } } } as EntityReplica;
          const local = p.rt.replicaLocal.get(key) ?? {};
          p.rt = { ...p.rt, entities: new Map([...p.rt.entities, [key, mine]]), replicaLocal: new Map([...p.rt.replicaLocal, [key, { ...local, hankoWitness: witness }]]) };
        }
      };
      if (rng() < 0.9) witnessed.add(batchHash);
      sync();
      let lastResult: Record<string, unknown> | undefined;
      for (let step = 0; step < 16; step++) {
        const roll = rng();
        let tx: Record<string, unknown> | undefined;
        if (roll < 0.35) {
          tx = { type: "retryJSubmit", data: {
            entityId: pick([E, E, E, E.toUpperCase().replace("0X", "0x"), hex(32)]), signerId: pick([leader, leader, leader, A, B, leader.toUpperCase().replace("0X", "0x")]), jurisdictionName: pick(["Local", "Local", "local"]),
            batchHash: pick([batchHash, batchHash, batchHash, hex(32)]), entityNonce: pick([nonce, nonce, nonce, nonce + 1]), batchGeneration: pick([generation, generation, generation, generation + 1]),
            ...(rng() < 0.2 ? { feeOverrides: { gasBumpBps: 125 } } : {}),
          } };
        } else if (roll < 0.7) {
          const pending = ((p.env.infrastructure["pendingCommittedJOutbox"] ?? []) as { jurisdictionName: string; jTxs: { entityId: string; data: Record<string, unknown> }[] }[]).flatMap((i) => i.jTxs.map((t) => ({ j: i.jurisdictionName, t })));
          const target = pending.length > 0 && rng() < 0.85 ? pick(pending) : undefined;
          if (target === undefined && lastResult !== undefined && rng() < 0.6) {
            tx = { type: "recordJSubmitResult", data: rng() < 0.5 ? lastResult : { ...lastResult, message: "different" } };
          } else if (target !== undefined) {
            const a = target.t.data["runtimeSubmitAttempt"] as { attemptId: string; attemptNumber: number; attemptedAt: number; batchGeneration: number };
            const outcome = pick(["submitted", "eventBarrier", "transientFailure", "terminalFailure", "reconciled", "bogus"]);
            const failing = outcome === "transientFailure" || outcome === "terminalFailure";
            const message = failing ? pick(["nonce too low", "rpc down"]) : undefined;
            const data: Record<string, unknown> = {
              entityId: target.t.entityId, signerId: String(target.t.data["signerId"]), jurisdictionName: target.j, batchHash: String(target.t.data["batchHash"]), entityNonce: Number(target.t.data["entityNonce"]),
              batchGeneration: a.batchGeneration, attemptId: a.attemptId, attemptNumber: a.attemptNumber, attemptedAt: a.attemptedAt, outcome,
              ...(message !== undefined ? { message } : {}), ...(failing && rng() < 0.5 ? { adapterFailure: { category: pick(["transient", "terminal"]), code: "RPC", message: pick([message, "other"]) } } : {}),
              ...(outcome === "submitted" && rng() < 0.7 ? { txHash: hex(32) } : {}),
            };
            const corrupt = rng();
            if (corrupt < 0.1) data["attemptedAt"] = a.attemptedAt + 1;
            else if (corrupt < 0.15) data["attemptId"] = hex(32);
            else if (corrupt < 0.2) data["entityNonce"] = -1;
            tx = { type: "recordJSubmitResult", data };
          }
        } else if (roll < 0.8) {
          now += pick([0, 1_000, 61_000]);
        } else if (roll < 0.9) {
          // The chain retires / replaces the sealed batch (og JEvent), the leader changes, or the witness is lost.
          const change = rng();
          if (change < 0.4) { batchHash = hashes[1] ?? ""; generation += 1; if (rng() < 0.8) witnessed.add(batchHash); }
          else if (change < 0.6) terminal = !terminal;
          else if (change < 0.8) leader = leader === A ? B : A;
          else witnessed.clear();
          sync();
        } else {
          witnessed.add(batchHash);
          sync();
        }
        if (tx === undefined) continue;
        p.env.state.timestamp = now;
        const og = await ogFrame(p.env, tx);
        const rw = rwFrame(p, tx as unknown as RuntimeTx, now);
        expect(rw.code).toBe(og.code);
        if (og.code !== null) continue;
        if (tx["type"] === "recordJSubmitResult") { recorded++; lastResult = tx["data"] as Record<string, unknown>; } else if (og.jOutbox.length > 0) retried++;
        expect(stableJson(rw.jOutbox)).toBe(stableJson(og.jOutbox));
        expect(stableJson(rw.retries)).toBe(stableJson(og.retries));
        for (const s of signers) {
          const ogLocal = (p.env.state.eReplicas.get(`${E}:${s}`) as { jSubmitState?: unknown }).jSubmitState;
          expect(stableJson(p.rt.replicaLocal.get(replicaKey(ALICE, s))?.jSubmitState)).toBe(stableJson(ogLocal));
        }
        expect(rwDigests(p.rt)).toEqual(ogDigests(p.env) as never);
      }
    }
    expect(retried).toBeGreaterThan(20);
    expect(recorded).toBeGreaterThan(20);
  });

  test("MATCH: the J submit attempt id is og buildJSubmitAttemptId (signer / jurisdiction / generation scoped)", () => {
    for (let i = 0; i < 200; i++) {
      const id = { jurisdictionName: pick(["Local", " local ", ""]), entityId: pick([hex(32), ""]), signerId: pick([addr(), addr().toUpperCase().replace("0X", "0x"), ""]), entityNonce: pick([0, 3, -1, 1.5]), batchGeneration: pick([1, 2, 0]), batchHash: pick([hex(32), ""]), attemptNumber: pick([1, 7, 0]) };
      let og: string | null = null, ogErr: string | null = null;
      try { og = buildJSubmitAttemptId(id); } catch (e) { ogErr = ogCode(e); }
      const rw = jSubmitAttemptId(id);
      expect(rwCode(rw)).toBe(ogErr);
      if (rw.ok) expect(rw.value).toBe(og ?? "");
    }
  });
});

// ---- og runtime/mempool/propose-accounts-now.ts assertProposeAccountsNowTxAuthorized, run by og admission.ts for every EntityInput tx ----
describe(seedTag("runtime-j: proposeAccountsNow ingress (og propose-accounts-now.ts)"), () => {
  test("MATCH (randomized): an unmarked proposeAccountsNow outside replay refuses the whole Runtime frame; a local mark or replay admits it", () => {
    const LOCAL = Symbol.for("xln.runtime.propose-accounts-now.local");
    let refused = 0, admitted = 0;
    for (let i = 0; i < 200; i++) {
      const replay = rng() < 0.3;
      const txs: EntityTx[] = Array.from({ length: 1 + ri(3) }, () => (rng() < 0.5
        ? { type: "proposeAccountsNow", data: { version: 1, proposerSignerId: aliceAddr, counterparties: [hex(32)] } }
        : { type: "chat", data: { from: aliceAddr, message: "hi" } }) as unknown as EntityTx);
      const marked = txs.filter(() => rng() < 0.5);
      for (const tx of marked) Object.defineProperty(tx, LOCAL, { value: true, enumerable: false });
      let og: string | null = null;
      try { for (const tx of txs) assertProposeAccountsNowTxAuthorized(tx as never, replay); } catch (e) { og = ogCode(e); }
      const rw = applyRuntime(createRuntime(), { runtimeTxs: [], entityInputs: [{ entityId: ALICE, signerId: aliceAddr, input: { kind: "txs", timestamp: 1n, txs } }] }, { ...verifiers, replay, local: new Set(marked) });
      const code = rw.ok ? null : rwCode(rw);
      expect(code === "PROPOSE_ACCOUNTS_NOW_EXTERNAL_INGRESS_REJECTED" ? code : null).toBe(og);
      if (og === null) admitted++; else refused++;
    }
    expect(refused).toBeGreaterThan(30);
    expect(admitted).toBeGreaterThan(30);
  });
});

// ---- og j-submit-state.ts splitJOutboxForDurableSubmit / registerPendingCommittedJOutbox, governance-submit-state.ts, failure-taxonomy.ts ----
describe(seedTag("runtime-j: durable J outbox split and pending register (og j-submit-state.ts / governance-submit-state.ts)"), () => {
  test("MATCH (randomized): batches, governance proposals and maintenance jTxs split and register identically, across frames", () => {
    let durable = 0, retried = 0, refused = 0;
    for (let run = 0; run < 30; run++) {
      const env = ogEnv();
      let pending: readonly JInput[] = [];
      const seen: Record<string, unknown>[] = [];
      for (let step = 0; step < 10; step++) {
        const jOutbox = Array.from({ length: 1 + ri(2) }, () => ({ jurisdictionName: pick(["Local", "Local", "Other"]), jTxs: Array.from({ length: 1 + ri(2) }, (): Record<string, unknown> => {
          const roll = rng(), entityId = pick([ALICE.toLowerCase(), hex(32)]), signerId = pick([aliceAddr.toLowerCase(), aliceAddr.toLowerCase(), bobAddr.toLowerCase(), bobAddr.toLowerCase(), ""]), timestamp = pick([1_700_000_000_000, 1_700_000_060_000]);
          if (roll < 0.1 && seen.length > 0) { const again = treeClone(pick(seen)); if (rng() < 0.3) (again["data"] as Record<string, unknown>)["encodedBatch"] = "0xdead"; return again; }
          if (roll < 0.25) return { type: pick(["mint", "debtEnforcement", "entityProviderActivateBoard"]), entityId, data: { signerId }, timestamp };
          if (roll < 0.45) {
            const data: Record<string, unknown> = { targetEntityId: entityId, newBoardHash: hex(32), boardEpoch: 1n, actionNonce: BigInt(1 + ri(3)), proposalHash: pick([hex(32), hex(32), hex(32), "0x12"]), supporterVotes: [], signerId };
            const tx: Record<string, unknown> = { type: "entityProviderProposeControlBoard", entityId, data, timestamp };
            if (rng() < 0.1) data["runtimeSubmitAttempt"] = { attemptId: hex(32), attemptNumber: 1, attemptedAt: timestamp, eligibleAt: timestamp };
            return tx;
          }
          const batchHash = hex(32), entityNonce = 1 + ri(3), batchGeneration = pick([1, 2, 1, 2, 0]);
          const data: Record<string, unknown> = { batch: initJBatch().batch, batchHash, encodedBatch: "0x1234", entityNonce, batchGeneration, hankoSignature: "0xab", batchSize: 0, signerId };
          if (rng() < 0.6) {
            const attemptNumber = 1 + ri(2), id = jSubmitAttemptId({ jurisdictionName: "Local", entityId, signerId, entityNonce, batchGeneration, batchHash, attemptNumber });
            data["runtimeSubmitAttempt"] = { attemptId: id.ok && rng() < 0.95 ? id.value : hex(32), attemptNumber, attemptedAt: timestamp, batchGeneration: rng() < 0.95 ? batchGeneration : batchGeneration + 1 };
          }
          const tx = { type: "batch", entityId, data, timestamp };
          seen.push(tx);
          return tx;
        }) }));
        let ogOut: { maintenance: unknown[]; durable: unknown[]; retries: unknown[] } | null = null, ogErr: string | null = null;
        const before = treeClone(env.infrastructure);
        try {
          const split = splitJOutboxForDurableSubmit(treeClone(jOutbox) as never);
          registerPendingCommittedJOutbox(env as never, split.durable);
          ogOut = split;
        } catch (e) { ogErr = ogCode(e); env.infrastructure = before; }
        const rw = splitJOutbox(jOutbox as unknown as JInput[]);
        const reg = rw.ok ? registerPendingJOutbox(pending, rw.value.durable) : rw;
        expect(reg.ok ? null : rwCode(reg)).toBe(ogErr);
        if (!rw.ok || !reg.ok || ogOut === null) { refused++; continue; }
        pending = reg.value;
        durable += rw.value.durable.length; retried += rw.value.retries.length;
        expect(stableJson(rw.value.maintenance)).toBe(stableJson(ogOut.maintenance));
        expect(stableJson(rw.value.durable)).toBe(stableJson(ogOut.durable));
        expect(stableJson(rw.value.retries)).toBe(stableJson(ogOut.retries));
        expect(stableJson(pending)).toBe(stableJson(env.infrastructure["pendingCommittedJOutbox"] ?? []));
      }
    }
    expect(durable).toBeGreaterThan(20);
    expect(retried).toBeGreaterThan(20);
    expect(refused).toBeGreaterThan(20);
  });

  test("MATCH: the EntityProvider action attempt id is og buildEntityProviderActionAttemptId", () => {
    for (let i = 0; i < 200; i++) {
      const id = { jurisdictionName: pick(["Local", " local ", ""]), entityId: pick([hex(32), ""]), signerId: pick([addr(), ""]), actionHash: pick([hex(32), hex(32).toUpperCase().replace("0X", "0x"), "0x12", ""]), actionNonce: pick([1n, 5n, 0n, 1n << 256n]), generation: pick([1, 2, 0, 1.5]), attemptNumber: pick([1, 7, 0]) };
      let og: string | null = null, ogErr: string | null = null;
      try { og = buildEntityProviderActionAttemptId(id); } catch (e) { ogErr = ogCode(e); }
      const rw = epActionAttemptId(id);
      expect(rwCode(rw)).toBe(ogErr);
      if (rw.ok) expect(rw.value).toBe(og ?? "");
    }
  });

  test("MATCH: J batch failure classification is og classifyRuntimeJBatchFailure", () => {
    const codes = ["J_SUBMIT_TRANSIENT", "J_SUBMIT_FATAL", "j_submit_fatal", " J_SUBMIT_TRANSIENT ", "RPC", "", "NONCE_TOO_LOW", "E1"];
    for (const code of codes) for (const message of [undefined, "", "nonce too low", "rpc down"]) {
      expect(stableJson(classifyJBatchFailure(code, message))).toBe(stableJson(classifyRuntimeJBatchFailure(code, message)));
    }
  });
});

// ---- og runtime/tx/tx-handlers.ts observeJRange / rewindJHistory over jurisdiction/machine/local-history ----
describe(seedTag("runtime-j: validator J history (og tx-handlers.ts observeJRangeRuntimeTx / rewindJHistoryRuntimeTx, local-history)"), () => {
  const E = ALICE.toLowerCase(), A = aliceAddr.toLowerCase(), EP = "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512";
  const REF = `stack:${TERMS.domain.chainId}:${TERMS.domain.depositoryAddress.toLowerCase()}`;
  const proofBody = (): Record<string, unknown> => ({
    watchSeed: pick([hex(32), hex(32), ""]), leftResponseSeconds: pick([10, 10n, 10, -1]), rightResponseSeconds: 20,
    offdeltas: [pick([{ high: 0n, low: 5n }, [-1n, 3n], { high: 0n, low: 1n }, { high: 0n }])], tokenIds: [pick([1n, 2n, 1n, -1n])],
    transformers: pick([[], [], [{ transformerAddress: addr(), encodedBatch: "0x", allowances: [{ deltaIndex: 0n, rightAllowance: 1n, leftAllowance: 2n }] }], [{ transformerAddress: "" }]]),
  });
  const event = (h: number, chain: readonly string[]): Record<string, unknown> => {
    const meta = { blockNumber: pick([h, h, String(h)]), blockHash: chain[h], transactionHash: hex(32), logIndex: ri(4), ...(rng() < 0.2 ? { eventIndex: ri(2) } : {}) };
    const roll = rng();
    if (roll < 0.2) return { type: "ReserveUpdated", data: { entity: E, tokenId: pick([1, "2", 3n]), newBalance: pick(["100", 5n, "BigInt(7)"]) }, ...meta };
    if (roll < 0.35) return { type: "HankoBatchProcessed", data: { entityId: hex(32), batchHash: hex(32), nonce: pick([1, 2, 2, 0]) }, ...meta };
    if (roll < 0.5) return { type: "AccountSettled", data: { leftEntity: E, rightEntity: hex(32), tokenId: 1, leftReserve: "1", rightReserve: 2n, collateral: "3", ondelta: "-4", nonce: 1 }, ...meta };
    if (roll < 0.65) return { type: "DisputeStarted", data: {
      sender: E, counterentity: hex(32), nonce: "1", proposerIsLeft: true, proofbodyHash: hex(32), watchSeed: hex(32), starterInitialArguments: "0x", starterCounterArguments: "0x12", starterCounterProofCommitment: hex(32),
      initialProofbody: proofBody(), disputeTimeout: pick([1030, 1030, 1031]), disputeStartTimestamp: 1000, leftResponseSeconds: 10, rightResponseSeconds: 20, ...(rng() < 0.5 ? { batchNonce: 3 } : {}),
    }, ...meta };
    if (roll < 0.75) return { type: "ExternalWalletDelta", data: { entityId: E, owner: addr(), tokenAddress: addr(), ...(rng() < 0.8 ? { balanceDelta: "5" } : {}) }, ...meta };
    if (roll < 0.85) return { type: "SecretRevealed", data: { hashlock: hex(32), revealer: addr().toUpperCase().replace("0X", "0x"), secret: hex(32) }, ...meta };
    if (roll < 0.92) return { type: "EntityProviderActionExecuted", data: { entityId: hex(32), actionNonce: pick(["1", "0"]), actionHash: hex(32), actionKind: pick([0, 1, 2]) }, ...meta };
    return pick([{ type: "Unknown", data: {} }, { type: "ReserveUpdated", data: { entity: 5, tokenId: 1, newBalance: "1" } }]);
  };
  const evidence = (): Record<string, unknown> => ({ sender: E, counterentity: hex(32), initialNonce: 1n, finalNonce: 2, initialProofbodyHash: hex(32), finalProofbodyHash: hex(32), proposerIsLeft: true, leftArguments: "0x", rightArguments: "0x", startedByLeft: false, sig: "0x12" });
  const ogHash = (f: () => string): string => { try { return f(); } catch { return hex(32); } };
  const block = (h: number, chain: readonly string[], fork: readonly string[]): Record<string, unknown> => {
    const events = Array.from({ length: ri(3) }, () => event(h, chain)), proofs = rng() < 0.15 ? [evidence(), ...(rng() < 0.3 ? [evidence()] : [])] : [];
    return {
      jurisdictionRef: pick([REF, REF, REF, REF, REF, REF, REF.toUpperCase(), "stack:1:0x00"]), jHeight: h, jBlockHash: rng() < 0.9 ? chain[h] : fork[h], events,
      eventsHash: rng() < 0.92 ? ogHash(() => canonicalJurisdictionEventsHash(treeClone(events) as never)) : hex(32),
      ...(proofs.length > 0 ? { disputeFinalizationEvidence: proofs, disputeFinalizationEvidenceHash: rng() < 0.9 ? ogHash(() => canonicalDisputeFinalizationEvidenceHash(treeClone(proofs) as never)) : hex(32) } : {}),
    };
  };
  const view = (h: unknown): string => {
    const x = h as { eventBlocks: Map<number, unknown>; blockHashes: Map<number, string> } | undefined;
    return stableJson(x === undefined ? null : { ...x, eventBlocks: [...x.eventBlocks], blockHashes: [...x.blockHashes] });
  };

  test("MATCH (randomized): watcher pages, reorgs, certified-anchor advances and rewinds -- same decisions and the same local J history", async () => {
    let observed = 0, rewound = 0, refused = 0;
    for (let run = 0; run < 100; run++) {
      const p = newPair(), deployment = pick([0, 0, 5]), base = deployment > 1 ? deployment - 1 : 0, top = base + 12;
      const chain = Array.from({ length: top + 1 }, () => hex(32)), fork = Array.from({ length: top + 1 }, () => hex(32));
      const ogState: Record<string, unknown> = { entityId: E, config: { jurisdiction: { name: "Local", chainId: TERMS.domain.chainId, depositoryAddress: TERMS.domain.depositoryAddress, entityProviderAddress: EP, entityProviderDeploymentBlock: deployment } }, lastFinalizedJHeight: base };
      p.env.state.eReplicas.set(`${E}:${A}`, { entityId: E, signerId: A, state: ogState });
      const base0 = unwrap(createEntity({ id: ALICE, jurisdiction: TERMS.domain, threshold: 1n, members: new Map([[aliceAddr, { shares: 1n }]]), signerId: aliceAddr,
        jurisdictionConfig: { name: "Local", entityProviderAddress: EP, entityProviderDeploymentBlock: deployment }, committed: { lastFinalizedJHeight: base } }));
      const key = replicaKey(ALICE, aliceAddr);
      p.rt = { ...p.rt, entities: new Map([[key, base0 as EntityReplica]]) };
      let anchor = base;
      for (let step = 0; step < 14; step++) {
        const roll = rng();
        let tx: Record<string, unknown>;
        if (roll < 0.12 && anchor < top - 1) {
          // A committed Entity frame certifies a newer J head (og jHistoryFinality + lastFinalizedJHeight).
          anchor = anchor + 1 + ri(Math.min(3, top - anchor - 1));
          const finality = { finalizedThroughHeight: anchor, tipBlockHash: chain[anchor], jurisdictionRef: REF, eventHistoryRoot: hex(32) };
          ogState["lastFinalizedJHeight"] = anchor; ogState["jHistoryFinality"] = finality;
          const r = p.rt.entities.get(key) as EntityReplica;
          p.rt = { ...p.rt, entities: new Map([[key, { ...r, state: { ...r.state, committed: { ...r.state.committed, lastFinalizedJHeight: anchor, jHistoryFinality: finality } } } as EntityReplica]]) };
          continue;
        }
        if (roll < 0.8) {
          const scanned = Math.max(1, Math.min(top, anchor - 2 + ri(8))), from = Math.max(1, scanned - 4);
          const heights = Array.from({ length: scanned - from + 1 }, (_, i) => from + i).filter(() => rng() < 0.4);
          tx = { type: "observeJRange", data: {
            entityId: pick([E, E, E, E, E, E, E.toUpperCase().replace("0X", "0x"), hex(32)]), signerId: pick([A, A, A, A, A, A, bobAddr.toLowerCase()]), jurisdictionRef: pick([REF, REF, REF, REF, REF, REF.toUpperCase(), "", "stack:1:0x00"]),
            scannedThroughHeight: scanned, tipBlockHash: rng() < 0.9 ? chain[scanned] : fork[scanned],
            ...(rng() < 0.5 ? { headers: heights.filter(() => rng() < 0.5).map((h) => ({ jHeight: h, jBlockHash: rng() < 0.93 ? chain[h] : fork[h] })) } : {}),
            blocks: heights.map((h) => block(h, chain, fork)),
          } };
        } else {
          tx = { type: "rewindJHistory", data: { entityId: E, signerId: A, jurisdictionRef: pick([REF, REF, "stack:1:0x00"]), conflictingHeight: Math.max(1, anchor - 1 + ri(4)), conflictingBlockHash: hex(32) } };
        }
        const og = await runOg(p.env, treeClone(tx));
        const rw = applyRuntimeTx(p.rt, tx as unknown as RuntimeTx, { replay: true });
        expect(rwCode(rw)).toBe(og);
        if (rw.ok) p.rt = rw.value;
        if (og === null) { if (tx["type"] === "observeJRange") observed++; else rewound++; } else refused++;
        expect(view(p.rt.replicaLocal.get(key)?.jHistory)).toBe(view((p.env.state.eReplicas.get(`${E}:${A}`) as { jHistory?: unknown }).jHistory));
      }
    }
    expect(observed).toBeGreaterThan(60);
    expect(rewound).toBeGreaterThan(10);
    expect(refused).toBeGreaterThan(60);
  });
});

// ---- og tx-handlers.ts recordAuthenticatedJAuthority over jurisdiction/machine/registration-evidence + receipt-codec ----
describe(seedTag("runtime-j: receipt-proven registration evidence (og registration-evidence.ts recordAuthenticatedJAuthority)"), () => {
  const iface = EntityProvider__factory.createInterface();
  const DEP = "0x5fbdb2315678afecb367f032d93f642f64180aa3", EP = "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512", CHAIN = 31337;
  const word = (n: number): string => `0x${n.toString(16).padStart(64, "0")}`;
  const view = (m: ReadonlyMap<string, unknown> | undefined): string => stableJson([...(m ?? new Map())]);

  test("MATCH (randomized): MPT receipt proofs, raw-log binding, witness signatures, repeats and claim conflicts -- same decisions and the same evidence store", async () => {
    let stored = 0, repeated = 0, refused = 0;
    for (let run = 0; run < 12; run++) {
      const seed = `runtime-j-authority-${run}`, env = createEmptyEnv(seed) as unknown as OgEnv & { runtimeId: string; infrastructure: { certifiedRegistrationEvidence?: Map<string, unknown> } };
      registerSignerKey(env as never, env.runtimeId, deriveSignerKeySync(seed, "1"));
      const depth = pick([0, 2]);
      const replica = { name: "Local", blockNumber: 7n, stateRoot: null, mempool: [], blockDelayMs: 300, lastBlockTimestamp: 0, position: { x: 0, y: 50, z: 0 }, chainId: CHAIN, contracts: { depository: DEP, entityProvider: EP }, watcherConfirmationDepth: depth };
      env.state.jReplicas.set("Local", replica);
      let rt: Runtime = createRuntime([treeClone(replica) as unknown as JReplica], env.runtimeId);
      const submitted: Record<string, unknown>[] = [];
      for (let step = 0; step < 6; step++) {
        let evidence: Record<string, unknown> | undefined;
        if (submitted.length > 0 && rng() < 0.2) { evidence = treeClone(pick(submitted)); repeated++; }
        else {
          const source = rng() < 0.8 ? "EntityRegistered" : "FoundationBootstrapped", height = 5 + ri(20), entityNumber = 2 + ri(3), blockHash = word(height * 7 + 1);
          const encoded = source === "EntityRegistered" ? iface.encodeEventLog(iface.getEvent("EntityRegistered"), [word(entityNumber), BigInt(entityNumber), hex(32)])
            : iface.encodeEventLog(iface.getEvent("FoundationBootstrapped"), [env.runtimeId, hex(32), 2n, 3n]);
          const count = 1 + ri(20), target = ri(count), noise = ri(3);
          const receipts = Array.from({ length: count }, (_, i) => {
            const transactionHash = word(1000 + height * 64 + i);
            const logs = i === target
              ? [...Array.from({ length: noise }, () => ({ address: addr(), topics: [hex(32)], data: "0x" })), { address: EP, topics: encoded.topics, data: encoded.data }]
              : Array.from({ length: ri(2) }, () => ({ address: addr(), topics: [hex(32)], data: "0x12" }));
            return { transactionHash, transactionIndex: i, blockNumber: height, blockHash, type: pick([0, 2]), status: 1, cumulativeGasUsed: 21_000 * (i + 1), logsBloom: `0x${"00".repeat(256)}`,
              logs: logs.map((l, k) => ({ ...l, blockNumber: height, blockHash, transactionHash, transactionIndex: i, logIndex: k })) };
          });
          const root = await computeCanonicalReceiptsRoot(receipts as never), proofs = await createCanonicalReceiptProofs(receipts as never, root);
          const other = (target + 1 + ri(Math.max(1, count - 1))) % count, corrupt = rng();
          let proof = { ...(proofs.get(target) as { proofNodes: string[]; transactionIndex: number; encodedReceipt: string; receiptsRoot: string }), receiptLogIndex: noise };
          if (corrupt < 0.08 && count > 1) proof = { ...proof, ...(proofs.get(other) as object), receiptLogIndex: noise } as typeof proof;
          else if (corrupt < 0.16 && count > 1) proof = { ...proof, proofNodes: (proofs.get(other) as { proofNodes: string[] }).proofNodes };
          else if (corrupt < 0.22 && proof.proofNodes.length > 1) proof = { ...proof, proofNodes: proof.proofNodes.slice(0, -1) };
          else if (corrupt < 0.28) proof = { ...proof, receiptLogIndex: noise + 1 };
          const log = { address: EP, topics: encoded.topics.map((t) => t.toLowerCase()), data: encoded.data.toLowerCase(), blockNumber: height, blockHash, transactionHash: word(1000 + height * 64 + target), transactionIndex: target, logIndex: noise, index: noise, receiptProof: proof };
          try {
            evidence = buildCertifiedRegistrationEvidence(env as never, replica as never, source, log as never, { observedThroughHeight: height, observedTipBlockHash: blockHash, observedHeadHeight: height + depth, confirmationDepth: depth }) as unknown as Record<string, unknown>;
          } catch { continue; }
          const tweak = rng();
          if (tweak < 0.06) evidence = { ...evidence, witnessSignature: `${String(evidence["witnessSignature"]).slice(0, 10)}${String(evidence["witnessSignature"]).slice(10, 12) === "00" ? "11" : "00"}${String(evidence["witnessSignature"]).slice(12)}` };
          else if (tweak < 0.1) evidence = { ...evidence, topics: (evidence["topics"] as string[]).map((t) => t.toUpperCase().replace("0X", "0x")) };
          else if (tweak < 0.2) {
            // Re-signed but inconsistent: the witness signs over fields the receipt proof or the log decoding then refutes.
            const field = pick(["receiptsRoot", "boardHash", "entityId", "receiptLogIndex", "encodedReceipt"]);
            const value = field === "receiptLogIndex" ? Number(evidence["receiptLogIndex"]) + 1 : field === "encodedReceipt" ? `${String(evidence["encodedReceipt"])}00` : hex(32);
            evidence = { ...evidence, [field]: value };
            evidence["witnessSignature"] = signAccountFrame(env as never, env.runtimeId, buildRegistrationEvidenceDigest(evidence as never)).toLowerCase();
          }
          submitted.push(evidence);
        }
        const tx = { type: "recordAuthenticatedJAuthority", data: evidence };
        const og = await runOg(env, treeClone(tx));
        const rw = applyRuntimeTx(rt, tx as unknown as RuntimeTx, { replay: true });
        expect(rwCode(rw)).toBe(og);
        if (rw.ok) rt = rw.value;
        if (og === null) stored++; else refused++;
        expect(view(rt.registrationEvidence)).toBe(view(env.infrastructure.certifiedRegistrationEvidence));
        // The durable post-state view commits the evidence store exactly as og does.
        const held = env.infrastructure.certifiedRegistrationEvidence;
        const minimal: OgEnv = { state: { jReplicas: env.state.jReplicas, eReplicas: new Map(), timestamp: 0, height: 0 }, infrastructure: held !== undefined && held.size > 0 ? { certifiedRegistrationEvidence: held } : {}, runtimeId: env.runtimeId };
        expect(rwDigests(rt)).toEqual(ogDigests(minimal) as never);
      }
    }
    expect(stored).toBeGreaterThan(15);
    expect(refused).toBeGreaterThan(10);
    expect(repeated).toBeGreaterThan(3);
  });

  test("MATCH (randomized): a numbered importReplica needs registration evidence for its exact board (og assertNumberedReplicaImportAuthority)", async () => {
    let imported = 0, refused = 0;
    for (let run = 0, more = untilCovered(16, () => imported > 8 && refused > 8); more(run); run++) {
      const seed = `runtime-j-numbered-${run}`, env = createEmptyEnv(seed) as unknown as OgEnv & { runtimeId: string };
      registerSignerKey(env as never, env.runtimeId, deriveSignerKeySync(seed, "1"));
      const replica = { name: "Local", blockNumber: 7n, stateRoot: null, mempool: [], blockDelayMs: 300, lastBlockTimestamp: 0, position: { x: 0, y: 50, z: 0 }, chainId: CHAIN, contracts: { depository: DEP, entityProvider: EP }, watcherConfirmationDepth: 0, entityProviderDeploymentBlock: 1 };
      env.state.jReplicas.set("Local", replica);
      let rt: Runtime = createRuntime([treeClone(replica) as unknown as JReplica], env.runtimeId);
      const config = { mode: "proposer-based", threshold: 1n, validators: [aliceAddr, bobAddr], shares: { [aliceAddr]: 1n, [bobAddr]: 1n }, jurisdiction: { name: "Local" } } as unknown as ImportConfig;
      const bound = { ...config, jurisdiction: { name: "Local", chainId: CHAIN, depositoryAddress: DEP, entityProviderAddress: EP } };
      const boardHash = hashBoard(encodeBoard(bound as never)).toLowerCase(), entityNumber = 2 + ri(3);
      if (rng() < 0.8) {
        const registered = rng() < 0.75 ? boardHash : hex(32), height = 5 + ri(5), blockHash = word(height);
        const encoded = iface.encodeEventLog(iface.getEvent("EntityRegistered"), [word(entityNumber), BigInt(entityNumber), registered]);
        const receipt = { transactionHash: word(900 + height), transactionIndex: 0, blockNumber: height, blockHash, type: 2, status: 1, cumulativeGasUsed: 21_000, logsBloom: `0x${"00".repeat(256)}`,
          logs: [{ address: EP, topics: encoded.topics, data: encoded.data, blockNumber: height, blockHash, transactionHash: word(900 + height), transactionIndex: 0, logIndex: 0 }] };
        const root = await computeCanonicalReceiptsRoot([receipt] as never), proof = (await createCanonicalReceiptProofs([receipt] as never, root)).get(0) as object;
        const log = { address: EP, topics: encoded.topics.map((t) => t.toLowerCase()), data: encoded.data.toLowerCase(), blockNumber: height, blockHash, transactionHash: word(900 + height), transactionIndex: 0, logIndex: 0, index: 0, receiptProof: { ...proof, receiptLogIndex: 0 } };
        const evidence = buildCertifiedRegistrationEvidence(env as never, replica as never, "EntityRegistered", log as never, { observedThroughHeight: height, observedTipBlockHash: blockHash, observedHeadHeight: height, confirmationDepth: 0 });
        const tx = { type: "recordAuthenticatedJAuthority", data: evidence };
        expect(await runOg(env, treeClone(tx))).toBeNull();
        rt = unwrap(applyRuntimeTx(rt, tx as unknown as RuntimeTx, { replay: true }));
      }
      for (const signer of [aliceAddr, bobAddr]) {
        const entityId = pick([word(entityNumber), word(entityNumber), word(entityNumber), word(entityNumber + 7)]);
        const tx = { type: "importReplica", entityId, signerId: signer, data: { config, isProposer: signer === aliceAddr, entitySeed: SEED } } as unknown as RuntimeTx;
        const og = await runOg(env, tx);
        const rw = applyRuntimeTx(rt, tx, { replay: true });
        expect(rwCode(rw)).toBe(og);
        if (!rw.ok) { refused++; continue; }
        rt = rw.value;
        imported++;
        expect(rt.entities.get(replicaKey(entityId as EntityId, signer))?.state.jurisdictionConfig?.entityProviderAddress.toLowerCase()).toBe(EP);
      }
    }
    expect(imported).toBeGreaterThan(8);
    expect(refused).toBeGreaterThan(8);
  });
});
