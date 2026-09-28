import { describe, expect, test } from "bun:test";
import { lcg31, seedOf, seedTag, untilCovered } from "./seed.ts";
// Runtime transport, scheduling and events, each run against live og (core/runtime, core/entity, core/account).
import { applyRuntimeTx as ogApplyRuntimeTx } from "../../core/runtime/tx/tx-handlers.ts";
import { computeCanonicalEntityConsensusStateHash } from "../../core/entity/consensus/state-root.ts";
import { encodeBoard, hashBoard } from "../../core/entity/factory.ts";
import { createDefaultDelta } from "../../core/account/state/delta.ts";
import { handleJEventClaim } from "../../core/account/tx/handlers/j-events/claim.ts";
import { prepareAccountJClaimTx } from "../../core/account/j-claims/j-claim-transition.ts";
import { createAccountJClaimSession } from "../../core/account/j-claims/j-claim-session.ts";
import { createEmptyAccountJClaimAccumulator } from "../../core/account/j-claims/j-claim-accumulator.ts";
import { applyAccountTxMutation } from "../../core/account/tx/mutation.ts";
import { beginAccountTransition, accountTransitionView, commitAccountTransition, discardAccountTransition } from "../../core/account/state/candidate-overlay.ts";
import { PersistentAccountStateMap } from "../../core/account/state/persistent-state-map.ts";
import {
  accountId, accountRuntimeEvents, accountTxMessages, accountTerms, applyAccountBody, applyRuntime, applyRuntimeTx, committed, convertOutput, createEntity, createRuntime, lazyBoardEntityId, spawn, entityId as rwEntityId, entityRootOf, genesisAccount, genesisAccountBody, replicaKey,
  UNNAMED_PAIRS, type AccountBody, type Address, type EntityId, type EntityTx, type FoldCtx, type RoutedEntityInput, type ImportConfig, type JReplica, type Runtime, type RuntimeTx,
} from "../xln.ts";
import { ALICE, BOB, CAROL, NOW, TERMS, UNREGISTERED_J, aliceAddr, bobAddr, unwrap, verifiers, genesisAB, proposeInput, offerOf, ackInput, hankoVerify } from "../xln_run.ts";
import { admit, applyAccountInput, type AccountReplica, type AccountInput, type OpenAccount, type WireAccountTx } from "../xln.ts";
import { runPostFrameAutoRebalanceCheck } from "../../core/account/consensus/helpers.ts";
import { runtimeWake, entityEncryptionPublicKey, crontabOf, initCrontab, scheduleHook, withCrontab, ZERO_WORD, type Crontab, type EntityReplica, type ScheduledHook } from "../xln.ts";
import { createDueScheduledWakeInputs, assertScheduledWakeTxAuthorized } from "../../core/runtime/mempool/scheduled-wake.ts";
import { EntityAccountCandidateMap, PersistentEntityAccountMap } from "../../core/entity/state/persistent-account-map.ts";
import { initJBatch as ogInitJBatch } from "../../core/jurisdiction/machine/batch/index.ts";
import { assertFrameJPrefix as ogAssertFrameJPrefix, buildCertifiedJPrefixTx as ogBuildCertifiedJPrefixTx, buildLocalJPrefixAttestation as ogBuildLocalJPrefixAttestation, hashJPrefixAttestation as ogHashJPrefixAttestation,
  mergeJPrefixAttestations as ogMergeJPrefixAttestations, verifyOutOfRoundJPrefixAttestation as ogVerifyOutOfRound, buildJPrefixCertificate as ogBuildJPrefixCertificate } from "../../core/jurisdiction/machine/history/j-prefix-consensus.ts";
import { getJEventRangeValidationError as ogRangeValidationError, pruneFinalizedValidatorJHistory as ogPruneJHistory } from "../../core/jurisdiction/machine/local-history/index.ts";
import { createEntityFrameHashFromStateRoot as ogEntityFrameHash } from "../../core/entity/consensus/frame.ts";
import { mergeEntityInputs as ogMergeEntityInputs } from "../../core/entity/consensus/input/merge.ts";
import { getEntityMempoolAdmissionError as ogMempoolAdmission } from "../../core/entity/consensus/replica-validation.ts";
import { selectCrossJOpeningAccountProposalTxs as ogOpeningSelection } from "../../core/entity/transition/cross-j-proposer-materialization.ts";
import { collectReadyLocalAccountWorkTargets as ogReadyAccountWork } from "../../core/runtime/admit/entity-input-output.ts";
import { isProposalDeferrableEntityInput as ogDeferrable } from "../../core/entity/consensus/input/consensus.ts";
import { selectPotentialCrossJAccountInputPairs as ogPotentialPairs, selectMatchedCrossJAccountInputPairs as ogMatchedPairs } from "../../core/runtime/delivery/topology/entity-routing.ts";
import { markPotentialAtomicCrossJInputPairs as ogMarkPotential, admitAtomicCrossJAccountInputs as ogAdmitAtomic } from "../../core/runtime/frame/cross-j/atomic-admission.ts";
import { markCommittedAtomicCrossJAckOutputs as ogMarkAckOutputs } from "../../core/runtime/frame/cross-j/evidence.ts";
import { buildStorageLiveReplicaMetaCommitment as ogReplicaMeta } from "../../core/storage/replica/replicas.ts";
import { buildCertifiedEntityFrameLink as ogCertifiedLink } from "../../core/entity/consensus/frame/lineage.ts";
import { buildEntityFrameAuthority as ogFrameAuthority, computeEntityFrameAuthorityRoot as ogFrameAuthorityRoot } from "../../core/entity/consensus/state-root.ts";
import { buildQuorumHanko as ogQuorumHanko } from "../../core/hanko/signing.ts";
import { buildEntityLeaderVoteBody as ogVoteBody, buildPreparedFrameEvidence as ogPreparedEvidence } from "../../core/entity/consensus/leader/index.ts";
import { applyEntityInput as applyEntityInputRw, localTimeoutVote, quorumBoardHash, type EntityInput } from "../xln.ts";
import { crypto } from "../xln_run.ts";
import { encodeBuffer as ogEncodeBuffer } from "../../core/storage/codec/codec.ts";
import { prepareRuntimeOutputRows as ogOutputRows } from "../../core/storage/wal/outbox-payload.ts";
import { runtimeOutputRows, runtimeOutputsDigest } from "../xln.ts";
import { normalizeJurisdictionEvent, compareCanonicalJurisdictionEvents } from "../../core/jurisdiction/machine/events/event-normalization.ts";
import { canonicalJurisdictionEventsHash, getJEventJurisdictionRef } from "../../core/jurisdiction/machine/event-observation.ts";
import { verifyAccountSignature as ogVerifyAccountSignature, registerSignerKey } from "../../core/account/crypto.ts";
import { FailureDispositionError } from "../../core/protocol/errors/failure-taxonomy.ts";
import { entityRequiresJPrefixCertificate, buildLocalJPrefixAttestation, buildCertifiedJPrefixTx, mergeJPrefixAttestations, verifyOutOfRoundJPrefixAttestation, assertFrameJPrefix, jPrefixAttestationHash, jPrefixVerify, jEventRangeLocalHistoryError,
  type JPrefixAttestation, type JPrefixCrypto, type JPrefixFailure, type JPrefixRound, type JPrefixView, type ValidatorJHistory, type ValidatorJBlock, type EntityState,
  hashEntityFrame, wireEntityTx, mergeEntityInputs, canon, crossOpeningSelection, readyAccountWorkTargets, potentialCrossPairs, markPotentialCrossPairs, matchedCrossPairs, admitAtomicCrossPairs, markCommittedAckOutputs, replicaMetaRows, replicaMetaDigest, type EntityFrame, type EntityOutput } from "../xln.ts";
import { anvilKey, signDigestHex, carolAddr } from "../xln_run.ts";

let seed = seedOf(71);
const rng = (): number => { seed = lcg31(seed); return seed / 0x7fffffff; };
const ri = (n: number): number => Math.floor(rng() * n);
const pick = <T>(xs: readonly T[]): T => xs[ri(xs.length)] as T;
const rwCode = (r: { readonly ok: boolean; readonly error?: unknown }): string | null => {
  if (r.ok) return null;
  const e = r.error as { _tag: string; code?: string };
  return String(e.code ?? e._tag).split(":")[0] ?? "";
};
const ogCode = (e: unknown): string => String((e as Error).message).split(":")[0] ?? "";
/** A tree deep copy (Bun's structuredClone mis-decodes repeated references). */
const treeClone = <T>(v: T): T => {
  if (v === null || typeof v !== "object") return v;
  if (v instanceof Uint8Array) return new Uint8Array(v) as T;
  if (v instanceof Map) return new Map([...v].map(([k, x]) => [treeClone(k), treeClone(x)])) as T;
  if (v instanceof Set) return new Set([...v].map(treeClone)) as T;
  if (Array.isArray(v)) return v.map(treeClone) as T;
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, treeClone(x)])) as T;
};
type OgEnv = { state: { jReplicas: Map<string, unknown>; eReplicas: Map<string, unknown>; timestamp: number; height: number }; infrastructure: Record<string, unknown>; activeJurisdiction?: string };
const ogEnv = (): OgEnv => ({ state: { jReplicas: new Map(), eReplicas: new Map(), timestamp: 1_700_000_000_000, height: 0 }, infrastructure: {} });
const runOg = async (env: OgEnv, tx: unknown): Promise<string | null> => {
  try { await ogApplyRuntimeTx(env as never, treeClone(tx) as never, { isReplay: true }); return null; } catch (e) { return ogCode(e); }
};

// ---- R2-6b / RG-1: the importReplica genesis replica (og buildGenesisReplica) ----
const SEED = "0x" + "5e".repeat(64);
describe(seedTag("runtime-final: importReplica genesis (og tx-handlers.ts buildGenesisReplica)"), () => {
  test("MATCH (randomized): profile name, swap pairs, crontab and position -- the genesis Entity root equals og computeCanonicalEntityConsensusStateHash", async () => {
    let imported = 0;
    for (let run = 0; run < 24; run++) {
      const env = ogEnv();
      const name = pick(["Local", "Tron", "rpc2", "Base"]), chainId = pick([31337, 31338, 8453]);
      const replica = { name, blockNumber: 0n, stateRoot: null, mempool: [], blockDelayMs: 300, lastBlockTimestamp: 0, position: { x: 0, y: 50, z: 0 }, rpcs: ["http://rpc.example/"], chainId,
        entityProviderDeploymentBlock: pick([1, 9]), contracts: { depository: "0x5fbdb2315678afecb367f032d93f642f64180aa3", entityProvider: "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512", account: "0x" + "12".repeat(20), deltaTransformer: "0x" + "34".repeat(20) } };
      env.state.jReplicas.set(name, treeClone(replica));
      let rt: Runtime = { ...createRuntime([treeClone(replica) as unknown as JReplica]), timestamp: 1_700_000_000_000n };
      const config = { mode: "proposer-based", threshold: 1n, validators: [aliceAddr, bobAddr], shares: { [aliceAddr]: 1n, [bobAddr]: 1n }, jurisdiction: { name } } as unknown as ImportConfig;
      const entityId = hashBoard(encodeBoard(config as never)).toLowerCase();
      const profileName = pick<string | undefined>([undefined, "", "  ", " Hub One ", "alice"]);
      const position = pick<unknown>([undefined, { x: 1, y: 2, z: 3 }, { x: 1, y: 2, z: 3, jurisdiction: "Other" }]);
      const tx = { type: "importReplica", entityId, signerId: aliceAddr, data: { config, isProposer: true, entitySeed: SEED, ...(profileName === undefined ? {} : { profileName }), ...(position === undefined ? {} : { position }) } } as unknown as RuntimeTx;
      const og = await runOg(env, tx);
      const rw = applyRuntimeTx(rt, tx, { replay: true });
      expect(rwCode(rw)).toBe(og);
      if (!rw.ok) continue;
      rt = rw.value;
      imported++;
      const ogReplica = env.state.eReplicas.get(`${entityId}:${aliceAddr.toLowerCase()}`) as { state: unknown; position?: unknown } | undefined;
      const mine = rt.entities.get(replicaKey(entityId as EntityId, aliceAddr));
      if (ogReplica === undefined || mine === undefined) throw new Error("replica missing");
      expect(unwrap(entityRootOf(mine.state, mine.accountReplicas))).toBe(computeCanonicalEntityConsensusStateHash(ogReplica.state as never));
      expect(rt.replicaLocal.get(replicaKey(entityId as EntityId, aliceAddr))?.position ?? null).toEqual((ogReplica.position ?? null) as never);
      // The sibling validator joins the same genesis Entity.
      const bobPosition = pick<unknown>([undefined, { x: 4, y: 5, z: 6 }]);
      const bobTx = { type: "importReplica", entityId, signerId: bobAddr, data: { config, isProposer: false, entitySeed: SEED, ...(bobPosition === undefined ? {} : { position: bobPosition }) } } as unknown as RuntimeTx;
      expect(rwCode(applyRuntimeTx(rt, bobTx, { replay: true }))).toBe(await runOg(env, bobTx));
      rt = unwrap(applyRuntimeTx(rt, bobTx, { replay: true }));
      const ogBob = env.state.eReplicas.get(`${entityId}:${bobAddr.toLowerCase()}`) as { state: unknown; position?: unknown };
      const bob = rt.entities.get(replicaKey(entityId as EntityId, bobAddr));
      if (bob === undefined) throw new Error("replica missing");
      expect(unwrap(entityRootOf(bob.state, bob.accountReplicas))).toBe(computeCanonicalEntityConsensusStateHash(ogBob.state as never));
      expect(rt.replicaLocal.get(replicaKey(entityId as EntityId, bobAddr))?.position ?? null).toEqual((ogBob.position ?? null) as never);
      // og reuseExistingReplica: re-importing the uncertified Entity normalizes its swap pairs, here from a snapshot restored without them
      const aliceKey = replicaKey(entityId as EntityId, aliceAddr), ogAlice = env.state.eReplicas.get(`${entityId}:${aliceAddr.toLowerCase()}`) as { state: Record<string, unknown> };
      delete ogAlice.state["swapTradingPairs"];
      const erased = { ...rt, entities: new Map([...rt.entities].map(([k, r]) => [k, k === aliceKey ? { ...r, state: { ...r.state, swapPairs: UNNAMED_PAIRS } } : r])) } as Runtime;
      expect(rwCode(applyRuntimeTx(erased, tx, { replay: true }))).toBe(await runOg(env, tx));
      const again = unwrap(applyRuntimeTx(erased, tx, { replay: true })).entities.get(aliceKey)!;
      expect(unwrap(entityRootOf(again.state, again.accountReplicas))).toBe(computeCanonicalEntityConsensusStateHash(ogAlice.state as never));
    }
    expect(imported).toBeGreaterThan(20);
  });
});

// ---- Account runtime events (og EntityCandidateEffect runtimeEvent from the Account machine) ----
const word = (byte: string): string => `0x${byte.repeat(32)}`;
const A = word("11"), B = word("22"), DEP = `0x${"ab".repeat(20)}`;
class PMap<K, V> extends Map<K, V> { put(k: K, v: V): this { this.set(k, v); return this; } del(k: K): void { this.delete(k); } }
const openBody = (credit = 10n ** 9n): { body: AccountBody; ctx: FoldCtx } => {
  const terms = unwrap(accountTerms({ domain: { chainId: 1, depositoryAddress: DEP }, watchSeed: word("44"), disputeConfig: { leftResponseSeconds: 1, rightResponseSeconds: 1 } } as never) as never) as never;
  const ctx: FoldCtx = { byLeft: true, nowMs: 1n, jHeight: 0n, accountHeight: 1n };
  let body = genesisAccountBody(genesisAccount(unwrap(accountId(unwrap(rwEntityId(A) as never), unwrap(rwEntityId(B) as never)) as never)), terms);
  for (const tokenId of ["1", "2"] as const) for (const byLeft of [true, false]) body = unwrap(applyAccountBody(body, { type: "set_credit_limit", tokenId, limit: credit } as never, { ...ctx, byLeft }) as never as { ok: true; value: { state: AccountBody } }).state;
  return { body, ctx };
};
const PA = (ns: string, m: ReadonlyMap<unknown, unknown> = new Map()) => PersistentAccountStateMap.fromEntries(ns as never, m as never);
/** og side: a persistent og Account replica seeded from the rewrite's committed view, run through og's transition overlay (as account-tx.test.ts ogHarness). */
const ogAccountHarness = (body: AccountBody) => {
  const v = (unwrap(committed(body) as never) as { view: Record<string, unknown> }).view;
  const state: Record<string, unknown> = { domain: v["domain"], leftEntity: v["leftEntity"], rightEntity: v["rightEntity"], watchSeed: v["watchSeed"], disputeConfig: v["disputeConfig"], jNonce: v["jNonce"], lastFinalizedJHeight: v["lastFinalizedJHeight"],
    leftPendingJClaims: v["leftPendingJClaims"], rightPendingJClaims: v["rightPendingJClaims"],
    ...Object.fromEntries(["deltas", "locks", "pulls", "swapOffers", "subcontracts", "lendingIntents", "requestedRebalance", "requestedRebalanceFeeState", "rebalanceFeePolicies"].map((n) => [n, PA(n, v[n] as ReadonlyMap<unknown, unknown>)])) };
  let replica: unknown = { state, status: "active", currentHeight: 0, proofHeader: { fromEntity: A, toEntity: B, nextProofNonce: 1 }, currentFrame: { stateHash: "" }, pendingWithdrawals: PA("pendingWithdrawals"),
    shadow: { rebalance: { policy: PA("rebalanceShadowPolicy"), submittedAtByToken: PA("rebalanceShadowSubmitted") } }, mempool: [] };
  return async (handler: (draft: never) => Promise<{ ok: boolean }> | { ok: boolean }): Promise<boolean> => {
    const overlay = beginAccountTransition(replica as never);
    let r: { ok: boolean };
    try { r = await handler(accountTransitionView(overlay) as never); } catch { r = { ok: false }; }
    if (!r.ok) { discardAccountTransition(overlay); return false; }
    replica = commitAccountTransition(overlay, "diff" as never).account;
    return true;
  };
};
const eventsOf = (effects: readonly { kind: string; eventName?: string; data?: unknown }[]): unknown[] => effects.filter((e) => e.kind === "runtimeEvent").map((e) => ({ eventName: e.eventName, data: e.data }));

describe(seedTag("runtime-final: Account runtime events (og account/tx/mutation.ts, j-events/claim.ts)"), () => {
  test("MATCH (randomized): request_collateral emits og's request_collateral_committed event from the local side", async () => {
    let emitted = 0;
    for (let run = 0; run < 12; run++) {
      const { body: start } = openBody();
      const og = ogAccountHarness(start);
      let body = start;
      for (let i = 0; i < 8; i++) {
        const byLeft = rng() < 0.5, tokenId = pick(["1", "2"]), amount = BigInt(ri(60)), fee = BigInt(ri(5)), ts = 10 + i;
        const tx = { type: "request_collateral", tokenId, amount, feeAmount: fee, policyVersion: 1, ...(rng() < 0.4 ? { feeTokenId: "2" } : {}) };
        const ogTx = { type: "request_collateral", data: { tokenId: Number(tokenId), amount, feeAmount: fee, policyVersion: 1, ...("feeTokenId" in tx ? { feeTokenId: 2 } : {}) } };
        const effects: { kind: string; eventName?: string; data?: unknown }[] = [];
        const ogOk = await og((acc) => applyAccountTxMutation(acc, ogTx as never, byLeft, ts, 1, false, undefined, undefined, undefined, effects as never) as never);
        const rw = applyAccountBody(body, tx as never, { byLeft, nowMs: BigInt(ts), jHeight: 1n, accountHeight: 1n }) as unknown as { ok: boolean; value: { state: AccountBody; effects: never[] } };
        expect(rw.ok).toBe(ogOk);
        if (!rw.ok) continue;
        body = rw.value.state;
        const mine = rw.value.effects.flatMap((e) => accountRuntimeEvents(A, B, e));
        expect(mine).toEqual(eventsOf(effects) as never);
        emitted += mine.length;
      }
    }
    expect(emitted).toBeGreaterThan(5);
  });

  test("MATCH (randomized): a bilaterally finalized j_event_claim emits og's account_settled_finalized_bilateral event; pending, stale and refused claims emit none", () => {
    const jurisdictions = { jReplicas: new Map([["j", { chainId: 1, contracts: { depository: DEP, entityProvider: `0x${"c1".repeat(20)}`, account: `0x${"c2".repeat(20)}`, deltaTransformer: `0x${"c3".repeat(20)}` } }]]) } as never;
    let finalized = 0;
    const seen = new Set<string>();
    for (let run = 0; run < 20; run++) {
      const state: Record<string, unknown> = { leftEntity: A, rightEntity: B, deltas: new PMap<number, unknown>([[1, { ...createDefaultDelta(1), leftCreditLimit: 10n ** 9n, rightCreditLimit: 10n ** 9n }], [2, { ...createDefaultDelta(2), leftCreditLimit: 10n ** 9n, rightCreditLimit: 10n ** 9n }]]),
        locks: new PMap(), swapOffers: new PMap(), requestedRebalance: new PMap(), requestedRebalanceFeeState: new PMap(), domain: { chainId: 1, depositoryAddress: DEP }, jNonce: 0, lastFinalizedJHeight: 0,
        leftPendingJClaims: createEmptyAccountJClaimAccumulator(), rightPendingJClaims: createEmptyAccountJClaimAccumulator() };
      const account = { proofHeader: { fromEntity: A, toEntity: B }, state, currentHeight: 1, shadow: { rebalance: { submittedAtByToken: new PMap() } } };
      const store = new Map<string, unknown>();
      let { body } = openBody();
      // Each claim is usually observed by both sides (finalizing it), sometimes by one side only or with different evidence.
      type Plan = { h: number; byLeft: boolean; rows: { tokenId: number; collateral: bigint; ondelta: bigint; nonce: number }[] };
      const plan: Plan[] = [];
      for (let i = 0; i < 4; i++) {
        const h = 1 + ri(6), byLeft = rng() < 0.5, nonce = 1 + ri(3);
        const rows = Array.from({ length: 1 + ri(2) }, (_, k) => ({ tokenId: pick([1, 2, 3]), collateral: BigInt(h * 10 + k), ondelta: BigInt(ri(5)), nonce }));
        plan.push({ h, byLeft, rows });
        if (rng() < 0.8) plan.push({ h, byLeft: !byLeft, rows: rng() < 0.85 ? rows : rows.map((r) => ({ ...r, collateral: r.collateral + 1n })) });
      }
      for (const { h, byLeft, rows } of plan) {
        const blk = word(h.toString(16).padStart(2, "0"));
        const ogTx = { type: "j_event_claim", data: { jHeight: h, jBlockHash: blk, events: rows.map((r) => ({ type: "AccountSettled", data: { leftEntity: A, rightEntity: B, tokenId: r.tokenId, leftReserve: "0", rightReserve: "0", collateral: r.collateral.toString(), ondelta: r.ondelta.toString(), nonce: r.nonce } })) } };
        const rwTx = { type: "j_event_claim", jHeight: BigInt(h), jBlockHash: blk, observedAt: 1n, events: rows.map((r) => ({ left: A, right: B, nonce: BigInt(r.nonce), tokens: [{ tokenId: BigInt(r.tokenId), leftReserve: 0n, rightReserve: 0n, collateral: r.collateral, ondelta: r.ondelta }] })) };
        const effects: { kind: string; eventName?: string; data?: unknown }[] = [];
        const before = { ...state, deltas: new PMap([...(state["deltas"] as Map<number, object>)].map(([k, v]) => [k, { ...v }])) };
        let ogOk = false, ogMessages: readonly string[] = [];
        try {
          const session = createAccountJClaimSession({ get: (x: string) => store.get(x) } as never);
          const prepared = prepareAccountJClaimTx(state as never, ogTx as never, { chainId: 1, depositoryAddress: DEP } as never, session);
          const res = handleJEventClaim(account as never, prepared as never, byLeft, 1, A, effects as never, jurisdictions, session) as { ok: boolean; events?: string[] };
          ogOk = res.ok; ogMessages = res.events ?? [];
          if (ogOk) for (const { hash, node } of session.changes()?.newNodes ?? []) store.set(hash, node);
        } catch { ogOk = false; }
        if (!ogOk) { Object.assign(state, before); effects.length = 0; }
        const rw = applyAccountBody(body, rwTx as never, { byLeft, nowMs: 1n, jHeight: 0n, accountHeight: 1n }) as unknown as { ok: boolean; value: { state: AccountBody; effects: never[] } };
        expect(rw.ok).toBe(ogOk);
        if (!rw.ok) continue;
        const prior = body;
        body = rw.value.state;
        const mine = rw.value.effects.flatMap((e) => accountRuntimeEvents(A, B, e));
        expect(mine).toEqual(eventsOf(effects) as never);
        // og claim.ts handler messages: retained / idempotent / stale / finalized bilaterally
        expect(accountTxMessages(prior, rwTx as never, { byLeft, nowMs: 1n, jHeight: 0n, accountHeight: 1n }, body, A)).toEqual(ogMessages as never);
        seen.add(ogMessages.join());
        finalized += mine.length;
      }
    }
    expect(finalized).toBeGreaterThan(5);
    expect(seen.size).toBeGreaterThanOrEqual(3);
  });
});

// ---- the Runtime event channel (og publishEntityCandidateEffects -> env.emit) ----
describe(seedTag("runtime-final: RuntimeStep.events (og observability/env-events.ts publishEntityCandidateEffects)"), () => {
  test("og semantics: runtime events publish only at commit, once on every committing validator replica (og installCommittedState), in commit order", () => {
    // A 2-of-2 Entity: the proposer's frame publishes nothing until the quorum commits it; then the proposer and the validator each publish its events.
    const members = new Map<Address, { shares: bigint }>([[aliceAddr, { shares: 1n }], [bobAddr, { shares: 1n }]]);
    const id = unwrap(lazyBoardEntityId({ mode: "proposer-based", threshold: 2n, validators: [aliceAddr, bobAddr], shares: { [aliceAddr]: 1n, [bobAddr]: 1n } } as never)) as EntityId;
    const SEED = `0x${"5a".repeat(64)}`;
    const replicaFor = (signerId: Address) => unwrap(createEntity({ id, jurisdiction: TERMS.domain, threshold: 2n, members, signerId, committed: { entityEncryptionPublicKey: entityEncryptionPublicKey(SEED, id) }, jurisdictionConfig: UNREGISTERED_J }));
    // og: every proposal and replay checks the validator's Entity key pair (the Runtime derives it from the retained seed)
    let rt: Runtime = { ...spawn(spawn(createRuntime(), replicaFor(aliceAddr)), replicaFor(bobAddr)), encryptionSeeds: new Map([[id, SEED]]) };
    const open = (to: EntityId): EntityTx => ({ type: "openAccount", data: { targetEntityId: to, accountDomain: { ...TERMS.domain }, watchSeed: TERMS.watchSeed, disputeConfig: { ...TERMS.disputeConfig } } } as EntityTx);
    const queue: RoutedEntityInput[] = [{ entityId: id, signerId: aliceAddr, input: { kind: "txs", timestamp: NOW, txs: [open(BOB), open(CAROL)] } }];
    const seen: { signer: string; commits: boolean; events: string[] }[] = [];
    // og admission signs the two collective opens into Alice's propose: frame 1 commits it pending, Bob's signed yes
    // executes both opens in frame 2
    for (let n = 0, voted = false; (queue.length > 0 || !voted) && n < 20; n++) {
      if (queue.length === 0) {
        const proposals = rt.entities.get(replicaKey(id, bobAddr))?.state.proposals as Map<string, unknown>;
        const [proposalId] = [...proposals.keys()];
        const vote: EntityTx = { type: "vote", data: { proposalId: proposalId ?? "", voter: bobAddr, choice: "yes" } };
        queue.push({ entityId: id, signerId: bobAddr, input: { kind: "txs", timestamp: NOW, txs: [vote] } });
        voted = true;
      }
      const input = queue.shift() as RoutedEntityInput;
      const before = rt.entities.get(replicaKey(id, input.signerId))?.head.height ?? 0n;
      const step = unwrap(applyRuntime(rt, { runtimeTxs: [], entityInputs: [input] }, verifiers));
      expect(step.rejected).toEqual([]);
      rt = step.runtime;
      const after = rt.entities.get(replicaKey(id, input.signerId))?.head.height ?? 0n;
      seen.push({ signer: input.signerId.toLowerCase(), commits: after > before, events: step.events.map((e) => `${e.eventName}:${String(e.data["counterpartyId"])}`) });
      for (const o of step.outbox) if ("input" in o && o.to === id) queue.push(unwrap(convertOutput(rt, o, id, NOW)));
    }
    const expected = [`AccountOpening:${BOB.toLowerCase()}`, `AccountOpening:${CAROL.toLowerCase()}`];
    expect(seen.filter((s) => !s.commits).every((s) => s.events.length === 0)).toBe(true);
    const bySigner = (a: unknown[], b: unknown[]) => String(a[0]).localeCompare(String(b[0]));
    const commits = seen.filter((s) => s.commits).map((s) => [s.signer, s.events]);
    // frame 1 (the pending propose) publishes nothing; frame 2's opens publish once on each committing replica; the
    // Account work frame that follows publishes nothing
    expect(commits.slice(0, 2).sort(bySigner)).toEqual([[aliceAddr.toLowerCase(), []], [bobAddr.toLowerCase(), []]].sort(bySigner));
    expect(commits.slice(2, 4).sort(bySigner)).toEqual([[aliceAddr.toLowerCase(), expected], [bobAddr.toLowerCase(), expected]].sort(bySigner));
    expect(commits.slice(4).map(([, events]) => events)).toEqual([[], []]);
  });
});

// ---- og account/consensus: Account frame messages and runPostFrameAutoRebalanceCheck ----
describe(seedTag("runtime-final: Account frame messages and the post-commit auto-rebalance (og account/consensus)"), () => {
  const said = (outputs: readonly { readonly kind: string }[]): string[] =>
    outputs.flatMap((o) => (o.kind === "message" && "message" in o && typeof o.message === "string" ? [o.message] : []));
  const door = (self: EntityId, autoRebalance: boolean) => ({ verify: hankoVerify, self, now: NOW, autoRebalance });
  test("MATCH (randomized): a full round says og's lines (`🚀`, handler lines + `🤝`, `✅`) and the ACK commit queues exactly og runPostFrameAutoRebalanceCheck's request_collateral", () => {
    let queued = 0, quiet = 0;
    for (let run = 0; run < 80; run++) {
      const g = genesisAB(), selfIsLeft = g.state.account.id.left === ALICE, tk = "1" as never;
      // usually Alice draws on Bob's credit (the side og rebalances), sometimes the other way
      const lean = (selfIsLeft ? 1n : -1n) * (rng() < 0.8 ? 1n : -1n), delta = { tokenId: tk, collateral: BigInt(ri(3) * 500), ondelta: BigInt(ri(3) * 100) * lean, offdelta: BigInt(ri(6) * 600) * lean, leftCreditLimit: 10_000n, rightCreditLimit: 10_000n };
      const fee = rng() < 0.85 ? { policyVersion: 1 + ri(3), baseFee: BigInt(ri(40)), liquidityFeeBps: BigInt(pick([0, 10, 100, 5000])), gasFee: BigInt(ri(20)), updatedAt: 1 } : undefined;
      const policy = { r2cRequestSoftLimit: BigInt(pick([0, 100, 700, 2000])), hardLimit: BigInt(pick([100, 700, 5000])), maxAcceptableFee: BigInt(pick([0, 30, 500, 10_000])) };
      const hub = rng() < 0.15;
      const body = { ...g.state, account: { ...g.state.account, deltas: new Map([[tk, delta]]) }, feePolicies: fee === undefined ? new Map() : new Map([[tk, selfIsLeft ? { right: fee } : { left: fee }]]) } as AccountBody;
      const alice = { ...g, state: body, rebalancePolicy: new Map([[1, policy]]) } as OpenAccount, bob = { ...g, state: body } as OpenAccount;
      const TX = { type: "set_credit_limit", tokenId: "2", limit: BigInt(1 + ri(9)) } as WireAccountTx;
      const queuedAlice = unwrap(admit(alice, [TX]) as never) as AccountReplica;
      const proposed = unwrap(applyAccountInput(queuedAlice, proposeInput(queuedAlice, ALICE) as AccountInput, door(ALICE, !hub)) as never) as { replica: AccountReplica; outputs: { kind: string }[] };
      if (proposed.replica._tag !== "proposed") throw new Error(proposed.replica._tag);
      expect(said(proposed.outputs)).toEqual(["🚀 Proposed frame 1 with 1 transactions"]);
      const received = unwrap(applyAccountInput(bob, offerOf(proposed.replica, ALICE) as AccountInput, door(BOB, true)) as never) as { replica: AccountReplica; outputs: { kind: string }[] };
      expect(said(received.outputs)).toEqual([]);
      const acked = unwrap(applyAccountInput(received.replica, ackInput(received.replica, BOB) as AccountInput, door(BOB, true)) as never) as { replica: AccountReplica; outputs: { kind: string }[] };
      // og: the receiver's replayed handler lines (proposer's side), then `🤝`; Bob has no rebalance policy, so nothing queues on his side
      expect(said(acked.outputs)).toEqual([...accountTxMessages(body, TX, { byLeft: selfIsLeft, nowMs: 0n, jHeight: 0n, accountHeight: 1n }, body, BOB), `🤝 Accepted frame 1 from Entity ${ALICE.slice(-4)}`]);
      const ack = acked.outputs.find((o) => o.kind === "ack") as AccountInput;
      const committedStep = unwrap(applyAccountInput(proposed.replica, ack, door(ALICE, !hub)) as never) as { replica: AccountReplica; outputs: { kind: string }[] };
      const after = committedStep.replica;
      if (after._tag !== "open") throw new Error(after._tag);
      // og side: the committed Account as og's post-ACK check sees it (pendingFrame cleared, nothing queued yet)
      const b = after.state, PAm = (ns: string, rows: readonly (readonly [unknown, unknown])[]) => PersistentAccountStateMap.fromEntries(ns as never, new Map(rows) as never);
      const ogAcc = {
        state: { leftEntity: b.account.id.left, rightEntity: b.account.id.right, deltas: PAm("deltas", [...b.account.deltas].map(([t, d]) => [Number(t), { ...d, tokenId: Number(t), leftAllowance: 0n, rightAllowance: 0n, leftHold: 0n, rightHold: 0n }])),
          requestedRebalance: PAm("requestedRebalance", [...b.requested].map(([t, v]) => [Number(t), v])), rebalanceFeePolicies: PAm("rebalanceFeePolicies", [...b.feePolicies].map(([t, v]) => [Number(t), v])) },
        shadow: { rebalance: { policy: PAm("rebalanceShadowPolicy", [[1, policy]]), submittedAtByToken: PAm("rebalanceShadowSubmitted", []) } }, pendingWithdrawals: PAm("pendingWithdrawals", []),
        proofHeader: { fromEntity: ALICE, toEntity: BOB, nextProofNonce: 1 }, currentHeight: 1, status: "active", mempool: [],
      };
      const og = runPostFrameAutoRebalanceCheck(ogAcc as never, ALICE, BOB, 1, hub, []) as unknown as { type: string; data: Record<string, unknown> }[];
      expect(after.mempool.map((t) => ({ type: t.type, data: { ...(t as Record<string, unknown>), type: undefined, tokenId: Number((t as { tokenId: string }).tokenId), feeTokenId: Number((t as { feeTokenId: string }).feeTokenId) } })))
        .toEqual(og.map((t) => ({ type: t.type, data: { ...t.data, type: undefined } })) as never);
      // og ack-commit.ts: `✅ Frame N confirmed and committed`, then `🔄 Auto-rebalance queued n tx(s) after ACK commit`
      expect(said(committedStep.outputs)).toEqual(["✅ Frame 1 confirmed and committed", ...(og.length > 0 ? [`🔄 Auto-rebalance queued ${og.length} tx(s) after ACK commit`] : [])]);
      if (og.length > 0) queued++; else quiet++;
    }
    expect(queued).toBeGreaterThan(5);
    expect(quiet).toBeGreaterThan(5);
  }, 40_000);
});

// ---- og runtime/mempool/wake.ts generateHookPings: the Runtime tick (scheduled-wake.ts createDueScheduledWakeInputs) ----
describe(seedTag("runtime-final: the Runtime tick's due wakes and leader timeout votes (og runtime/mempool/scheduled-wake.ts)"), () => {
  type Rep = { readonly entity: EntityId; readonly leader: boolean; readonly hooks: readonly ScheduledHook[]; readonly lastRun: number; readonly hub: boolean; readonly timestamp: number; readonly progress: number | undefined; readonly work: boolean; readonly queuedWake: boolean };
  const JUR = TERMS.domain;
  const crontabFor = (r: Rep): Crontab => r.hooks.reduce(scheduleHook, { ...initCrontab(), tasks: new Map([["hubRebalance", { method: "hubRebalance", intervalMs: 1000, lastRun: r.lastRun, enabled: true, params: {} }]]) });
  const CHAT = { type: "chat", data: { message: "hi" } } as unknown as EntityTx;
  const wakeTx = (signer: string) => ({ type: "scheduledWake", data: { version: 1, proposerSignerId: signer, dueAt: 1, jobs: [{ kind: "hook", id: "x", dueAt: 1 }] } }) as unknown as EntityTx;
  const rwReplica = (r: Rep): EntityReplica => {
    const jBatch = ogInitJBatch();
    const e = unwrap(createEntity({ id: r.entity, jurisdiction: JUR, threshold: 1n, members: new Map([[aliceAddr as never, { shares: 1n }], [bobAddr as never, { shares: 1n }]]), signerId: r.leader ? aliceAddr : bobAddr, timestamp: BigInt(r.timestamp),
      committed: { jBatchState: jBatch, ...(r.hub ? { hubRebalanceConfig: { disputeAutoFinalizeMode: "auto" } } : {}) } as never }));
    return { ...e, state: withCrontab(e.state, crontabFor(r)), mempool: [...(r.work ? [CHAT] : []), ...(r.queuedWake ? [wakeTx(r.leader ? aliceAddr : bobAddr)] : [])] } as EntityReplica;
  };
  const ogReplica = (r: Rep): any => {
    const c = crontabFor(r), signer = r.leader ? aliceAddr : bobAddr;
    return { entityId: r.entity, signerId: signer, mempool: [...(r.work ? [CHAT] : []), ...(r.queuedWake ? [wakeTx(signer)] : [])], ...(r.progress === undefined ? {} : { lastConsensusProgressAt: r.progress }),
      state: { entityId: r.entity, height: 0, timestamp: r.timestamp, prevFrameHash: "", lastFinalizedJHeight: 0, config: { mode: "proposer-based", threshold: 1n, validators: [aliceAddr.toLowerCase(), bobAddr.toLowerCase()], shares: { [aliceAddr.toLowerCase()]: 1n, [bobAddr.toLowerCase()]: 1n } },
        accounts: new EntityAccountCandidateMap(PersistentEntityAccountMap.fromEntries([], r.entity, () => ZERO_WORD as never)), paybook: { entries: new Map(), feesEarned: 0n }, crontabState: { tasks: c.tasks, hooks: new Map(c.hooks) }, jBatchState: ogInitJBatch(),
        ...(r.hub ? { hubRebalanceConfig: { disputeAutoFinalizeMode: "auto" } } : {}) } };
  };
  const shape = (entityId: string, signer: string, wake: unknown, vote: Record<string, unknown> | undefined) => ({ entity: entityId.toLowerCase(), signer: signer.toLowerCase(), wake,
    vote: vote === undefined ? undefined : { entityId: String(vote["entityId"]).toLowerCase(), targetHeight: Number(vote["targetHeight"]), previousFrameHash: vote["previousFrameHash"], fromView: vote["fromView"], toView: vote["toView"],
      previousLeaderId: String(vote["previousLeaderId"]).toLowerCase(), nextLeaderId: String(vote["nextLeaderId"]).toLowerCase(), voterId: String(vote["voterId"]).toLowerCase(), signature: vote["signature"] } });

  test("MATCH (randomized): 300 random Runtimes (leaders with due hooks and the hubRebalance task, validators with leader work and last progress, queued wakes and votes) -- og createDueScheduledWakeInputs, in og's (dueAt, entityId, signerId) order", () => {
    let wakes = 0, votes = 0, skipped = 0;
    for (let run = 0, more = untilCovered(300, () => wakes > 80 && votes > 80 && skipped > 10); more(run); run++) {
      const reps: Rep[] = [ALICE, BOB, CAROL].flatMap((entity) => (rng() < 0.3 ? [] : [true, false].filter(() => rng() < 0.6).map((leader): Rep => ({
        entity, leader, hooks: Array.from({ length: ri(3) }, (_, j) => ({ id: `hub-kick:${j}`, triggerAt: 900 + ri(20_000), type: "hub_rebalance_kick", data: { reason: "r", counterpartyId: BOB } }) as ScheduledHook),
        lastRun: pick([0, 5_000, 30_000]), hub: rng() < 0.3, timestamp: ri(8_000), progress: rng() < 0.5 ? undefined : ri(12_000), work: rng() < 0.7, queuedWake: rng() < 0.1,
      }))));
      const now = ri(26_000);
      const queuedVotes = reps.filter(() => rng() < 0.1).map((r) => ({ entityId: r.entity, signerId: r.leader ? aliceAddr : bobAddr }));
      const rt: Runtime = { ...reps.map(rwReplica).reduce(spawn, createRuntime()), replicaLocal: new Map(reps.flatMap((r) => (r.progress === undefined ? [] : [[replicaKey(r.entity, r.leader ? aliceAddr : bobAddr), { lastConsensusProgressAt: r.progress }] as const]))) };
      const queued = { runtimeTxs: [], entityInputs: queuedVotes.map((q) => ({ ...q, input: { kind: "leaderTimeoutVote" } })) } as never;
      const mine = runtimeWake(rt, now, queued).input.entityInputs.map((i) => shape(i.entityId, i.signerId, i.input.kind === "txs" ? (i.input.txs[0] as { data: unknown }).data : undefined, i.input.kind === "leaderTimeoutVote" ? { ...(i.input as { vote: Record<string, unknown> }).vote } : undefined));
      const env: any = { state: { eReplicas: new Map(reps.map((r) => [`${r.entity}:${r.leader ? aliceAddr : bobAddr}`, ogReplica(r)])) }, runtimeMempool: { entityInputs: queuedVotes.map((q) => ({ ...q, leaderTimeoutVote: {} })) } };
      const og = (createDueScheduledWakeInputs(env, now) as any[]).map((i) => shape(i.entityId, i.signerId, i.entityTxs?.[0]?.data, i.leaderTimeoutVote));
      expect(mine).toEqual(og as never);
      wakes += og.filter((i) => i.wake !== undefined).length; votes += og.filter((i) => i.vote !== undefined).length; skipped += queuedVotes.length;
    }
    expect([wakes > 80, votes > 80, skipped > 10]).toEqual([true, true, true]);
  });

  test("MATCH: a scheduledWake enters only as the tick's own marked tx -- og assertScheduledWakeTxAuthorized (SCHEDULED_WAKE_EXTERNAL_INGRESS_REJECTED); the tick's wake runs the due hook", () => {
    const rep: Rep = { entity: ALICE, leader: true, hooks: [{ id: "hub-kick:0", triggerAt: 1_000, type: "hub_rebalance_kick", data: { reason: "r", counterpartyId: BOB } } as ScheduledHook], lastRun: 0, hub: false, timestamp: 0, progress: undefined, work: false, queuedWake: false };
    // a single-member ALICE (its id is the board's), so the wake's frame commits
    const solo = unwrap(createEntity({ id: ALICE, jurisdiction: JUR, threshold: 1n, members: new Map([[aliceAddr as never, { shares: 1n }]]) }));
    const rt = spawn(createRuntime(), { ...solo, state: withCrontab(solo.state, crontabFor(rep)) } as EntityReplica);
    const tick = runtimeWake(rt, 2_000);
    expect(tick.input.entityInputs.length).toBe(1);
    const forged = applyRuntime(rt, { ...tick.input, entityInputs: tick.input.entityInputs.map((i) => ({ ...i, input: i.input.kind === "txs" ? { ...i.input, txs: i.input.txs.map((tx) => ({ ...tx })) } : i.input })) }, verifiers);
    const ogTx = { type: "scheduledWake", data: { version: 1, proposerSignerId: aliceAddr, dueAt: 1_000, jobs: [] } };
    let ogReason = "";
    try { assertScheduledWakeTxAuthorized(ogTx as never, false); } catch (e) { ogReason = ogCode(e); }
    expect([(forged as { error?: { _tag?: string } }).error?._tag, rwCode(forged as never)]).toEqual(["runtime_frame", ogReason]);
    const ogMarked = (createDueScheduledWakeInputs({ state: { eReplicas: new Map([["k", ogReplica(rep)]]) }, runtimeMempool: { entityInputs: [] } } as never, 2_000) as any[])[0].entityTxs[0];
    expect(() => assertScheduledWakeTxAuthorized(ogMarked, false)).not.toThrow();
    expect(() => assertScheduledWakeTxAuthorized(ogTx as never, true)).not.toThrow();
    expect(applyRuntime(rt, tick.input, { ...verifiers, replay: true }).ok).toBe(true);
    const step = unwrap(applyRuntime(rt, tick.input, { ...verifiers, local: tick.local }));
    expect(step.rejected).toEqual([]);
    expect([...crontabOf((step.runtime.entities.get(replicaKey(ALICE, aliceAddr)) as EntityReplica).state).hooks.keys()]).not.toContain("hub-kick:0");
  });
});

// ---- og jurisdiction/machine/history/j-prefix-consensus.ts: the per-frame J prefix (attestations, rounds, certificates, the frame rule) ----
describe(seedTag("runtime-final: the per-frame J prefix (og jurisdiction/machine/history/j-prefix-consensus.ts, local-history getJEventRangeValidationError)"), () => {
  const EP = "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512";
  const OG_J = { name: "j", chainId: TERMS.domain.chainId, depositoryAddress: TERMS.domain.depositoryAddress, entityProviderAddress: EP };
  const JREF = getJEventJurisdictionRef(OG_J);
  const V = [aliceAddr, bobAddr, carolAddr].map((a) => a.toLowerCase());
  const KEYS = new Map([[V[0], anvilKey(2)], [V[1], anvilKey(1)], [V[2], anvilKey(0)]]);
  const crypto: JPrefixCrypto = { verify: jPrefixVerify, sign: (signer, digest) => ({ ok: true, value: signDigestHex(digest, KEYS.get(signer) as string) }) as never };
  const ogEnv: any = { quietRuntimeLogs: true, runtimeSeed: `0x${"11".repeat(32)}` };
  // og signs with the validators' registered keys: the same keys the rewrite signs with, so signatures match byte for byte (RFC 6979)
  for (const [v, k] of KEYS) registerSignerKey(ogEnv, v as string, Buffer.from((k as string).slice(2), "hex"));
  const word = (): string => `0x${Array.from({ length: 64 }, () => "0123456789abcdef"[ri(16)]).join("")}`;
  const SEED_J = `0x${"6b".repeat(64)}`;
  type Outcome = { ok: true; value: unknown } | { ok: false; disposition: string; message: string };
  const ogDo = (f: () => unknown): Outcome => {
    try { return { ok: true, value: f() }; } catch (e) {
      const m = String((e as Error).message);
      return { ok: false, disposition: e instanceof FailureDispositionError ? e.disposition : /^J_HISTORY_(?:FINALITY|FINALIZED)_/.test(m) ? "halt" : "reject", message: m };
    }
  };
  const rwDo = (r: { ok: boolean; value?: unknown; error?: JPrefixFailure }): Outcome => (r.ok ? { ok: true, value: r.value } : { ok: false, disposition: (r.error as JPrefixFailure).disposition, message: (r.error as JPrefixFailure).message });
  const shape = (o: Outcome): unknown => (o.ok ? "ok" : { disposition: o.disposition, message: o.message });
  const unsigned = (a: any): any => (a === null || a === undefined ? a : JSON.parse(JSON.stringify(a)));
  type Fx = { view: JPrefixView; og: any; histories: Map<string, ValidatorJHistory>; L: number; H: number; parent: string; id: EntityId; created: EntityReplica };
  /** A random Entity (shares, threshold, certified anchor or registration base, height) and each validator's own J history over one shared chain, with gaps, lag and forks. */
  const fixture = (lazy = false): Fx => {
    const shares = V.map(() => BigInt(1 + ri(3))), total = shares.reduce((a, b) => a + b, 0n), threshold = BigInt(1 + ri(Number(total)));
    const L = 2 + ri(4), finality = rng() < 0.7, H = lazy ? 0 : ri(3), prev = word(), registered = rng() < 0.3;
    // a lazy Entity (id = its board hash) is its own certified authority, so it proposes from genesis
    const ID = lazy ? unwrap(lazyBoardEntityId({ mode: "proposer-based", threshold, validators: [aliceAddr, bobAddr, carolAddr], shares: { [aliceAddr]: shares[0], [bobAddr]: shares[1], [carolAddr]: shares[2] } } as never)) as EntityId : ALICE;
    const chainHash = new Map<number, string>(); for (let h = 0; h <= L + 8; h++) chainHash.set(h, word());
    const eventHeights = new Set(Array.from({ length: ri(4) }, () => L + 1 + ri(8)));
    const balance = new Map([...eventHeights].map((h) => [h, String(ri(900))]));
    const anchor = finality ? { jurisdictionRef: JREF, baseHeight: L - 1, finalizedThroughHeight: L, tipBlockHash: chainHash.get(L), eventHistoryRoot: word(), proposerSignerId: V[0], proposerSignature: "0x", entityHeight: Math.max(1, H) } : undefined;
    const jc = { name: "j", entityProviderAddress: EP, ...(finality ? {} : { entityProviderDeploymentBlock: L + 1 }), ...(registered ? { registrationBlock: 1 } : {}) };
    const members = new Map([aliceAddr, bobAddr, carolAddr].map((a, i) => [a, { shares: shares[i] as bigint }] as const));
    const created = unwrap(createEntity({ id: ID, jurisdiction: TERMS.domain, threshold, members: members as never, jurisdictionConfig: jc as never,
      committed: { lastFinalizedJHeight: L, ...(anchor ? { jHistoryFinality: anchor } : {}), ...(lazy ? { entityEncryptionPublicKey: entityEncryptionPublicKey(SEED_J, ID) } : {}) } as never }));
    const view: JPrefixView = { state: { ...created.state, height: BigInt(H) } as EntityState, head: { height: BigInt(H), prevFrameHash: prev as never } };
    const og = { entityId: ID, height: H, prevFrameHash: prev, lastFinalizedJHeight: L, ...(anchor ? { jHistoryFinality: anchor } : {}),
      config: { mode: "proposer-based", threshold, validators: [...V], shares: Object.fromEntries(V.map((v, i) => [v, shares[i]])), jurisdiction: { ...OG_J, ...(finality ? {} : { entityProviderDeploymentBlock: L + 1 }), ...(registered ? { registrationBlock: 1 } : {}) } } };
    const histories = new Map<string, ValidatorJHistory>();
    for (const v of V) {
      if (rng() < 0.08) continue;
      const scanned = L + ri(9), forkAt = rng() < 0.15 ? L + 1 + ri(8) : Infinity, forked = new Map<number, string>();
      const hashAt = (h: number): string => { if (h < forkAt) return chainHash.get(h) as string; if (!forked.has(h)) forked.set(h, word()); return forked.get(h) as string; };
      const blockHashes = new Map<number, string>(), eventBlocks = new Map<number, ValidatorJBlock>();
      for (let h = L; h <= scanned; h++) if (h === scanned || (h === L && finality) || rng() < 0.9) blockHashes.set(h, hashAt(h));
      for (const h of eventHeights) {
        if (h > scanned || rng() < 0.1) continue;
        const events = [normalizeJurisdictionEvent({ type: "ReserveUpdated", data: { entity: ID, tokenId: 1, newBalance: balance.get(h) }, blockNumber: h, blockHash: hashAt(h), transactionHash: `0x${String(h).padStart(64, "0")}`, logIndex: 0 } as never)!].sort(compareCanonicalJurisdictionEvents);
        eventBlocks.set(h, { jurisdictionRef: JREF, jHeight: h, jBlockHash: hashAt(h), eventsHash: canonicalJurisdictionEventsHash(events as never), events });
        blockHashes.set(h, hashAt(h));
      }
      let contiguous = L;
      while (contiguous < scanned && blockHashes.has(contiguous + 1)) contiguous++;
      histories.set(v, { jurisdictionRef: JREF, scannedThroughHeight: scanned, contiguousThroughHeight: contiguous, tipBlockHash: hashAt(scanned), eventBlocks, blockHashes });
    }
    return { view, og, histories, L, H, parent: H === 0 ? "genesis" : prev, id: ID, created };
  };
  const ogReplica = (fx: Fx, signer: string, round?: unknown): any => ({ signerId: signer, state: fx.og, jHistory: fx.histories.get(signer), ...(round ? { jPrefixRound: round } : {}) });
  /** Every validator's rewrite-built, really signed attestation (null or refused ones left out). */
  const attestationsOf = (fx: Fx): Map<string, JPrefixAttestation> => new Map(V.flatMap((v) => { const a = buildLocalJPrefixAttestation(fx.view, v, fx.histories.get(v), crypto); return a.ok && a.value !== null ? [[v, a.value] as const] : []; }));
  const tamper = (a: JPrefixAttestation): [string, JPrefixAttestation] => {
    const k = ri(6);
    if (k === 0) return [a.validatorId, { ...a, signature: `${a.signature.slice(0, -4)}${a.signature.slice(-4) === "0000" ? "1111" : "0000"}` }];
    if (k === 1) return [a.validatorId, { ...a, targetEntityHeight: a.targetEntityHeight + 1 }];
    if (k === 2) return [a.validatorId, { ...a, headers: a.headers.map((h, i) => (i === a.headers.length - 1 ? { ...h, jBlockHash: word() } : h)) }];
    if (k === 3) return [V[(V.indexOf(a.validatorId) + 1) % 3] as string, a];
    if (k === 4) return [a.validatorId, { ...a, baseHeight: a.baseHeight + 1 }];
    return [a.validatorId, { ...a, parentFrameHash: word() }];
  };

  test("MATCH (randomized): 400 local attestations -- og buildLocalJPrefixAttestation (budgeted claim, headers, base claims, sparse gaps, lag, refusals) and hashJPrefixAttestation", () => {
    const seen = new Map<string, number>();
    for (let run = 0; run < 400; run++) {
      const fx = fixture(), v = pick(V), clean = fx.histories.get(v), defect = clean === undefined ? 9 : ri(12);
      // defects: a history behind the certified base, a reorg at the certified anchor, a missing base header before the first anchor
      const h: ValidatorJHistory | undefined = clean === undefined || defect > 2 ? clean
        : defect === 0 ? { ...clean, scannedThroughHeight: fx.L - 1, contiguousThroughHeight: fx.L - 1, tipBlockHash: word(), blockHashes: new Map([[fx.L - 1, word()]]), eventBlocks: new Map() }
          : defect === 1 ? { ...clean, blockHashes: new Map([...clean.blockHashes].map(([k, x]) => [k, k === fx.L ? word() : x] as const)), ...(clean.scannedThroughHeight === fx.L ? { tipBlockHash: "" } : {}) }
            : { ...clean, blockHashes: new Map([...clean.blockHashes].filter(([k]) => k !== fx.L || k === clean.scannedThroughHeight)) };
      if (h !== undefined && h.tipBlockHash === "") continue;
      const mine = rwDo(buildLocalJPrefixAttestation(fx.view, v, h, crypto) as never), og = ogDo(() => ogBuildLocalJPrefixAttestation(ogEnv, ogReplica(fx, v) as never, h as never));
      expect(shape(mine)).toEqual(shape(og) as never);
      if (mine.ok && og.ok) {
        expect(unsigned(mine.value)).toEqual(unsigned(og.value));
        if (og.value !== null) expect<string>(unwrap(jPrefixAttestationHash(mine.value as never))).toBe(ogHashJPrefixAttestation(unsigned(og.value)));
      }
      const k = !mine.ok ? `err:${mine.message.split(":")[0]}` : mine.value === null ? "null" : (mine.value as JPrefixAttestation).scannedThroughHeight > fx.L ? "range" : "base";
      seen.set(k, (seen.get(k) ?? 0) + 1);
    }
    for (const k of ["range", "base", "null"]) expect(seen.get(k) ?? 0).toBeGreaterThan(10);
    expect([...seen.keys()].filter((k) => k.startsWith("err:")).length).toBeGreaterThan(0);
  }, 120_000);

  test("MATCH (randomized): 300 rounds -- og mergeJPrefixAttestations (verification, equivocation, the highest weighted common prefix and its certificate) over honest and tampered votes", () => {
    let certified = 0, refused = 0;
    for (let run = 0; run < 300; run++) {
      const fx = fixture(), honest = attestationsOf(fx);
      const incoming = new Map([...honest].map(([k, a]) => (rng() < 0.12 ? tamper(a) : [k, a] as [string, JPrefixAttestation])));
      const mine = rwDo(mergeJPrefixAttestations(fx.view, undefined, incoming, crypto) as never), og = ogDo(() => ogMergeJPrefixAttestations(ogEnv, fx.og, undefined, incoming as never));
      expect(shape(mine)).toEqual(shape(og) as never);
      if (!mine.ok || !og.ok) { refused++; continue; }
      const m = mine.value as JPrefixRound, o = og.value as any;
      expect([...m.attestations.keys()]).toEqual([...o.attestations.keys()]);
      expect(JSON.parse(JSON.stringify(m.certificate?.selected ?? null))).toEqual(JSON.parse(JSON.stringify(o.certificate?.selected ?? null)));
      expect([m.targetEntityHeight, m.parentFrameHash, m.jurisdictionRef, m.baseHeight]).toEqual([o.targetEntityHeight, o.parentFrameHash, o.jurisdictionRef, o.baseHeight]);
      if (m.certificate !== undefined) certified++;
      // a second, different vote from the same validator is equivocation; the same vote again is a no-op
      const [first] = honest.values();
      if (first !== undefined && m.attestations.has(first.validatorId)) {
        const again = new Map([[first.validatorId, first]]);
        expect(shape(rwDo(mergeJPrefixAttestations(fx.view, m, again, crypto) as never))).toEqual(shape(ogDo(() => ogMergeJPrefixAttestations(ogEnv, fx.og, o, again as never))) as never);
      }
    }
    expect([certified > 60, refused > 20]).toEqual([true, true]);
  }, 300_000);

  test("MATCH (randomized): 200 out-of-round votes -- og verifyOutOfRoundJPrefixAttestation (stale and future targets, authority, envelope, signature)", () => {
    const seen = new Set<string>();
    for (let run = 0; run < 200; run++) {
      const fx = fixture(), v = pick(V), shift = pick([-1, 1, 2]);
      if (fx.H + shift < 0) continue;
      const other: JPrefixView = { state: { ...fx.view.state, height: BigInt(fx.H + shift) }, head: { height: BigInt(fx.H + shift), prevFrameHash: word() as never } };
      const built = buildLocalJPrefixAttestation(other, v, fx.histories.get(v), crypto);
      if (!built.ok || built.value === null) continue;
      const raw = rng() < 0.2 ? tamper(built.value)[1] : built.value;
      const mine = rwDo(verifyOutOfRoundJPrefixAttestation(fx.view, raw, [fx.view.state.quorum], crypto) as never), og = ogDo(() => ogVerifyOutOfRound(ogEnv, fx.og, raw as never, [fx.og.config]));
      expect(shape(mine)).toEqual(shape(og) as never);
      seen.add(mine.ok ? "ok" : mine.message.split(":")[0] as string);
    }
    expect(seen.size).toBeGreaterThan(2);
  }, 120_000);

  test("MATCH (randomized): 300 frames -- og assertFrameJPrefix (certificate required, round, stronger local certificate, required local event, frozen base roll, range equals the certified prefix, proposer signature) and og getJEventRangeValidationError", () => {
    const seen = new Map<string, number>();
    for (let run = 0; run < 300; run++) {
      const fx = fixture(), votes = attestationsOf(fx);
      const rw = mergeJPrefixAttestations(fx.view, undefined, votes, crypto);
      const ogRound = ogDo(() => ogMergeJPrefixAttestations(ogEnv, fx.og, undefined, votes as never));
      if (!rw.ok || !ogRound.ok) continue;
      const proposer = V[0] as string, certificate = rw.value.certificate;
      let txs: EntityTx[] = [];
      if (certificate !== undefined && certificate.selected.scannedThroughHeight > fx.L) {
        const tx = buildCertifiedJPrefixTx(fx.view, fx.histories.get(proposer), certificate, proposer, crypto);
        const ogTx = ogDo(() => ogBuildCertifiedJPrefixTx(ogEnv, ogReplica(fx, proposer) as never, certificate as never, proposer));
        expect(shape(rwDo(tx as never))).toEqual(shape(ogTx) as never);
        if (tx.ok && ogTx.ok) expect(unsigned(tx.value.data)).toEqual(unsigned((ogTx.value as any).data));
        if (tx.ok) txs = [tx.value];
      }
      const variant = ri(8);
      if (variant === 1) txs = [];
      if (variant === 2) txs = [...txs, { type: "chat", data: { message: "x" } } as unknown as EntityTx];
      if (variant === 3 && txs[0] !== undefined) txs = [{ ...txs[0], data: { ...(txs[0] as { data: Record<string, unknown> }).data, from: V[1] } } as EntityTx];
      const frame = { height: variant === 4 ? fx.H + 2 : fx.H + 1, parentFrameHash: fx.parent, proposerSignerId: variant === 5 ? V[1] as string : proposer, txs, jPrefixCertificate: variant === 6 ? undefined : certificate };
      const ogFrame = { height: frame.height, parentFrameHash: frame.parentFrameHash, leader: { proposerSignerId: frame.proposerSignerId, view: 0 }, txs, ...(frame.jPrefixCertificate ? { jPrefixCertificate: frame.jPrefixCertificate } : {}) };
      const judge = pick(V), useRound = rng() < 0.7;
      const mine = rwDo(assertFrameJPrefix(fx.view, judge, useRound ? rw.value : undefined, fx.histories.get(judge), frame, crypto) as never);
      const og = ogDo(() => ogAssertFrameJPrefix(ogEnv, ogReplica(fx, judge, useRound ? ogRound.value : undefined), ogFrame as never));
      expect(shape(mine)).toEqual(shape(og) as never);
      const k = mine.ok ? "ok" : `${mine.disposition}:${mine.message.split(":")[0]}`;
      seen.set(k, (seen.get(k) ?? 0) + 1);
      // og getReplicaJRangeValidationError: each proposed range against the judge's own history
      for (const tx of txs) {
        if (tx.type !== "j_event") continue;
        const r = jEventRangeLocalHistoryError(fx.view.state, fx.histories.get(judge), tx.data as never), o = ogDo(() => ogRangeValidationError(fx.og, fx.histories.get(judge) as never, tx.data as never, proposer, (s: string, d: string, sig: string) => ogVerifyAccountSignature(ogEnv, s, d, sig)));
        expect(r.ok ? r.value : `halt:${(r.error as JPrefixFailure).message}`).toEqual((o.ok ? o.value : `halt:${o.message}`) as never);
      }
    }
    for (const k of ["ok", "reject:J_PREFIX_CERTIFICATE_MISSING", "reject:J_PREFIX_FRAME_ROUND_MISMATCH"]) expect(seen.get(k) ?? 0).toBeGreaterThan(0);
    expect(seen.size).toBeGreaterThan(5);
  }, 300_000);
  test("MATCH (randomized): 40 validator Runtimes run the J prefix through Entity consensus -- the committed frame's certificate, certified j_event and frame hash equal og's, every commit prunes the local history like og", () => {
    const allowed = new Set(["J_PREFIX_INVALID", "J_PREFIX_LOCAL_HISTORY_BEHIND", "J_PREFIX_STRONGER_LOCAL_CERTIFICATE", "J_PREFIX_REQUIRED_LOCAL_EVENT", "PROPOSAL_J_RANGE_MISMATCH", "PROPOSAL_J_PREFIX_HISTORY_WAIT", "COMMIT_J_PREFIX_HISTORY_WAIT", "COMMIT_J_RANGE_MISMATCH", "J_PREFIX_FUTURE_HEIGHT", "J_PREFIX_ROUND_FROZEN", "J_PREFIX_ATTESTATION_REJECTED"]);
    const plain = (v: unknown): unknown => (v === undefined ? v : JSON.parse(JSON.stringify(v, (_k, x) => (x instanceof Map ? [...x] : typeof x === "bigint" ? x.toString() : x))));
    let committedRuns = 0, ranged = 0, uncertified = 0;
    const seenCodes = new Map<string, number>();
    for (let run = 0; run < 40; run++) {
      const fx = fixture(true), id = fx.id;
      const signers = [aliceAddr, bobAddr, carolAddr] as Address[];
      let rt: Runtime = { ...signers.reduce((acc, s) => spawn(acc, { ...fx.created, signerId: s } as EntityReplica), createRuntime()), encryptionSeeds: new Map([[id, SEED_J]]),
        replicaLocal: new Map(signers.flatMap((s) => { const h = fx.histories.get(s.toLowerCase()); return h === undefined ? [] : [[replicaKey(id, s), { jHistory: h }] as const]; })) } as Runtime;
      const queue: RoutedEntityInput[] = [{ entityId: id, signerId: aliceAddr, input: { kind: "txs", timestamp: NOW, txs: [{ type: "chat", data: { from: aliceAddr.toLowerCase(), message: "j" } } as EntityTx] } }];
      const frames = new Map<string, EntityFrame>();
      for (let n = 0; queue.length > 0 && n < 80; n++) {
        const input = queue.shift() as RoutedEntityInput;
        const step = unwrap(applyRuntime(rt, { runtimeTxs: [], entityInputs: [input] }, verifiers));
        for (const e of step.rejected) {
          const code = e._tag === "j_prefix" ? (e as { code: string }).code : e._tag;
          seenCodes.set(code, (seenCodes.get(code) ?? 0) + 1);
          if (e._tag === "j_prefix") expect([run, code, (e as { message: string }).message, allowed.has(code)]).toEqual([run, code, (e as { message: string }).message, true]);
        }
        rt = step.runtime;
        for (const o of step.outbox as readonly EntityOutput[]) {
          if (!("input" in o) || o.to !== id) continue;
          if (o.input.kind === "proposal") frames.set(unwrap(hashEntityFrame(o.input.frame)), o.input.frame);
          queue.push(unwrap(convertOutput(rt, o, id, NOW)));
        }
      }
      const heads = signers.map((s) => rt.entities.get(replicaKey(id, s)) as EntityReplica);
      const committedHeads = heads.filter((r) => r.head.height >= 1n);
      if (committedHeads.length === 0) continue;
      committedRuns++;
      for (const r of committedHeads) {
        // this replica's committed chain, newest first (every committed frame was broadcast as a commit notification)
        const chain: EntityFrame[] = [];
        for (let hash = r.head.prevFrameHash as string; hash !== "genesis";) { const f = frames.get(hash); if (f === undefined) throw new Error(`run ${run}: frame ${hash} missing`); chain.push(f); hash = f.prevFrameHash; }
        expect(chain.length).toBe(Number(r.head.height));
        for (const frame of chain) {
          const cert = frame.jPrefixCertificate, range = frame.txs.find((tx) => tx.type === "j_event");
          // og createEntityFrameHashFromStateRoot: the certificate is in the frame hash
          expect<string>(unwrap(hashEntityFrame(frame))).toBe(ogEntityFrameHash(frame.prevFrameHash, Number(frame.height), Number(frame.timestamp), frame.txs.map(wireEntityTx) as never, frame.events as never, id, frame.stateRoot, frame.authorityRoot, frame.entityContext as never, cert as never));
          if (frame.height !== 1n) continue;
          // og assertFrameJPrefix: without a certificate (an unregistered Entity whose validators see no pending J event) no range is certified
          if (cert === undefined) { uncertified++; expect(range).toBeUndefined(); expect(entityRequiresJPrefixCertificate(fx.view.state)).toBe(false); continue; }
          // og's frame 1 and ours: the certificate is og buildJPrefixCertificate over its heads, the range og buildCertifiedJPrefixTx
          expect(plain(cert)).toEqual(plain(ogBuildJPrefixCertificate({ ...fx.og, height: 0 } as never, cert.attestations as never)));
          if (cert.selected.scannedThroughHeight > fx.L) {
            ranged++;
            expect(plain(range)).toEqual(plain(ogBuildCertifiedJPrefixTx(ogEnv, { ...ogReplica(fx, V[0] as string), state: { ...fx.og, height: 0 } }, cert as never, V[0] as string)));
          } else expect(range).toBeUndefined();
        }
        // the committed finality is the highest certified prefix; og finalizeCommitNotification prunes the local history to it at every commit
        const finalized = r.state.jFinality.height, before = fx.histories.get(r.signerId.toLowerCase());
        expect(finalized).toBe(Math.max(fx.L, ...chain.map((f) => f.jPrefixCertificate?.selected.scannedThroughHeight ?? 0)));
        if (before !== undefined) expect(plain(rt.replicaLocal.get(replicaKey(id, r.signerId))?.jHistory)).toEqual(plain(ogPruneJHistory(before as never, finalized)));
      }
    }
    expect(committedRuns).toBeGreaterThan(10);
    expect(ranged).toBeGreaterThan(3);
    expect(uncertified).toBeLessThan(committedRuns);
    expect([...seenCodes.keys()].filter((k) => allowed.has(k) && k !== "precommit_not_active").length).toBeGreaterThan(3);
  }, 300_000);
});

// ---- og runtime/tx/tx-handlers.ts rewindJHistoryRuntimeTx: a precommit cannot be revoked ----
describe(seedTag("runtime-final: rewindJHistory against a locked frame (og tx-handlers.ts J_HISTORY_SIGNED_LOCK_REORG)"), () => {
  test("MATCH (randomized): 200 rewinds -- og refuses exactly a height inside the range this validator's locked frame signed", async () => {
    const E = ALICE.toLowerCase(), A = aliceAddr.toLowerCase(), EP = "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512";
    const REF = `stack:${TERMS.domain.chainId}:${TERMS.domain.depositoryAddress.toLowerCase()}`;
    const hex32 = (): string => `0x${Array.from({ length: 64 }, () => "0123456789abcdef"[ri(16)]).join("")}`;
    const base0 = unwrap(createEntity({ id: ALICE, jurisdiction: TERMS.domain, threshold: 1n, members: new Map([[aliceAddr, { shares: 1n }]]), signerId: aliceAddr,
      jurisdictionConfig: { name: "Local", entityProviderAddress: EP, entityProviderDeploymentBlock: 0 }, committed: { lastFinalizedJHeight: 0 } }));
    const key = replicaKey(ALICE, aliceAddr), seen = new Map<string, number>();
    for (let run = 0; run < 200; run++) {
      const base = ri(4), scanned = base + 1 + ri(6), top = scanned + 2, locked = rng() < 0.8, tip = hex32();
      const history = { jurisdictionRef: REF, scannedThroughHeight: top, contiguousThroughHeight: top, tipBlockHash: tip, eventBlocks: new Map(), blockHashes: new Map([[top, tip]]) };
      const range = { type: "j_event", data: { baseHeight: base, scannedThroughHeight: scanned } };
      const env = ogEnv();
      env.state.eReplicas.set(`${E}:${A}`, { entityId: E, signerId: A, jHistory: treeClone(history),
        state: { entityId: E, config: { jurisdiction: { name: "Local", chainId: TERMS.domain.chainId, depositoryAddress: TERMS.domain.depositoryAddress, entityProviderAddress: EP, entityProviderDeploymentBlock: 0 } }, lastFinalizedJHeight: 0 },
        ...(locked ? { lockedFrame: { height: 1, hash: hex32(), txs: [treeClone(range)] } } : {}) });
      const replica = (locked ? { ...base0, _tag: "locked", frame: { height: 1n, prevFrameHash: "genesis", txs: [range] }, signatures: new Map(), draft: {} } : base0) as EntityReplica;
      const rt: Runtime = { ...createRuntime(), entities: new Map([[key, replica]]), replicaLocal: new Map([[key, { jHistory: history as never }]]) };
      const tx = { type: "rewindJHistory", data: { entityId: E, signerId: A, jurisdictionRef: REF, conflictingHeight: 1 + ri(top + 1), conflictingBlockHash: hex32() } };
      const og = await runOg(env, tx), rw = rwCode(applyRuntimeTx(rt, tx as unknown as RuntimeTx, { replay: true }));
      expect([run, rw]).toEqual([run, og]);
      seen.set(String(og), (seen.get(String(og)) ?? 0) + 1);
    }
    expect(seen.get("J_HISTORY_SIGNED_LOCK_REORG") ?? 0).toBeGreaterThan(30);
    expect(seen.get("null") ?? 0).toBeGreaterThan(30);
  });
});

// ---- og entity/consensus/input/merge.ts: every Entity-input lane (R2-5b) ----
describe(seedTag("runtime-final: Entity-input lanes (og input/merge.ts mergeEntityInputs)"), () => {
  const E2 = [ALICE, BOB], S2 = [aliceAddr, bobAddr], ORIGINS = [undefined, "rt-a", "rt-b"];
  const hex32 = (): string => `0x${Array.from({ length: 64 }, () => "0123456789abcdef"[ri(16)]).join("")}`;
  const credit = (n: number): EntityTx => ({ type: "extendCredit", data: { counterpartyEntityId: CAROL, tokenId: "1", amount: BigInt(n) } } as EntityTx);
  // drawn inside the test, from its own seed, so collecting this block never shifts the other tests' stream
  let RANGES: readonly string[] = [], SIGS: readonly string[] = [];
  const jEvent = (): EntityTx => ({ type: "j_event", data: { from: pick([aliceAddr, aliceAddr.toLowerCase()]), jurisdictionRef: "stack:1:0x00", baseHeight: 1, scannedThroughHeight: 2 + ri(2), tipBlockHash: RANGES[0], eventHistoryRoot: RANGES[1], rangeHash: pick(RANGES), signature: pick(SIGS), blocks: [ri(3)] } } as unknown as EntityTx);
  const wake = (): EntityTx => ({ type: "scheduledWake", data: { entityId: ALICE, wakeAt: pick([5, 5, 5, 6]) } } as unknown as EntityTx);
  const output = (): EntityTx => ({ type: "runtimeOutput", data: { protocol: "cross-j", sourceEntityId: BOB, sourceSignerId: bobAddr, targetEntityId: ALICE, entityTxs: [credit(ri(2))] } } as EntityTx);
  const vote = (entityId: string): Record<string, unknown> => ({ entityId, targetHeight: 1 + ri(2), previousFrameHash: "genesis", fromView: 0, toView: 1, previousLeaderId: aliceAddr.toLowerCase(), nextLeaderId: bobAddr.toLowerCase(), voterId: pick([aliceAddr, bobAddr]).toLowerCase(), signature: pick(["0x01", "0x02"]) });
  const frames = new Map<string, EntityFrame>();
  const frameOf = (height: number, variant: number): EntityFrame => {
    const key = `${height}:${variant}`;
    if (!frames.has(key)) frames.set(key, { height: BigInt(height), prevFrameHash: "genesis", timestamp: BigInt(variant), txs: [], events: [], stateRoot: hex32(), authorityRoot: hex32(), entityContext: { entityId: ALICE }, hashesToSign: [], leader: { proposerSignerId: aliceAddr, view: 0 } } as unknown as EntityFrame);
    return frames.get(key) as EntityFrame;
  };
  type Gen = { readonly rw: RoutedEntityInput; readonly og: Record<string, unknown> };
  const gen = (): Gen => {
    const entityId = pick(E2), signerId = pick(S2), from = pick(ORIGINS), base = { entityId, signerId, ...(from === undefined ? {} : { from }) }, k = ri(12);
    if (k < 6) {
      const txs = Array.from({ length: 1 + ri(3) }, () => pick([credit(ri(3)), jEvent(), jEvent(), wake(), output()]));
      // og: a runtimeOutput travels alone in its envelope
      const envelope = txs.some((tx) => tx.type === "runtimeOutput") ? [output()] : txs;
      return { rw: { ...base, input: { kind: "txs", timestamp: NOW, txs: envelope } }, og: { ...base, entityTxs: envelope } };
    }
    if (k < 9) {
      const v = vote(entityId);
      return { rw: { ...base, input: { kind: "leaderTimeoutVote", timestamp: NOW, vote: v as never } }, og: { ...base, leaderTimeoutVote: v } };
    }
    const height = 1 + ri(2), variant = ri(2), frame = frameOf(height, variant);
    return { rw: { ...base, input: { kind: "proposal", frame, signatures: new Map() } }, og: { ...base, proposedFrame: { hash: unwrap(hashEntityFrame(frame)), height } } };
  };
  const txSummary = (txs: readonly EntityTx[]): unknown => txs.map((tx) => tx.type === "extendCredit" ? `c${Number((tx.data as { amount: bigint }).amount)}` : tx.type === "j_event" ? `j${String((tx.data as Record<string, unknown>)["rangeHash"]).slice(2, 6)}${String((tx.data as Record<string, unknown>)["signature"]).slice(2, 6)}${String((tx.data as Record<string, unknown>)["scannedThroughHeight"])}${String((tx.data as Record<string, unknown>)["blocks"])}`
    : tx.type === "scheduledWake" ? `w${String((tx.data as Record<string, unknown>)["wakeAt"])}` : `o${Number(((tx.data as { entityTxs: readonly { data: { amount: bigint } }[] }).entityTxs[0]?.data.amount) ?? -1)}`);
  const sumRw = (i: RoutedEntityInput): unknown => ({ e: i.entityId.toLowerCase(), s: i.signerId.toLowerCase(), from: i.from ?? "",
    body: i.input.kind === "proposal" ? unwrap(hashEntityFrame(i.input.frame)) : i.input.kind === "leaderTimeoutVote" ? `v${canon(i.input.vote)}` : i.input.kind === "txs" ? txSummary(i.input.txs) : i.input.kind });
  const sumOg = (i: Record<string, unknown>): unknown => ({ e: String(i["entityId"]).toLowerCase(), s: String(i["signerId"]).toLowerCase(), from: i["from"] ?? "",
    body: i["proposedFrame"] !== undefined ? (i["proposedFrame"] as { hash: string }).hash : i["leaderTimeoutVote"] !== undefined ? `v${canon(i["leaderTimeoutVote"])}` : txSummary((i["entityTxs"] as EntityTx[] | undefined) ?? []) });

  test("MATCH (randomized): 600 batches with runtimeOutput envelopes, repeated J observations, scheduled wakes, timeout votes and proposals -- og's lanes, order and refusals", () => {
    const seen = new Map<string, number>();
    seed = seedOf(Number(process.env["LANES_SEED"] ?? 26));
    RANGES = [hex32(), hex32()]; SIGS = [hex32(), hex32()];
    for (let n = 0; n < 600; n++) {
      const gens = Array.from({ length: 1 + ri(8) }, gen);
      let ogOut: Record<string, unknown>[] | undefined, ogErr: string | null = null;
      try { ogOut = ogMergeEntityInputs(gens.map((g) => treeClone(g.og)) as never) as never; } catch (e) { ogErr = ogCode(e); }
      const rw = mergeEntityInputs(gens.map((g) => g.rw));
      expect([n, rwCode(rw)]).toEqual([n, ogErr]);
      const key = ogErr ?? (gens.length > (ogOut?.length ?? 0) ? "merged" : "kept");
      seen.set(key, (seen.get(key) ?? 0) + 1);
      if (rw.ok && ogOut !== undefined) expect([n, rw.value.map(sumRw)]).toEqual([n, ogOut.map(sumOg)]);
    }
    for (const k of ["merged", "kept", "SCHEDULED_WAKE_CONFLICTING_INPUTS", "ENTITY_LEADER_VOTE_EQUIVOCATION"]) expect([k, (seen.get(k) ?? 0) > 5]).toEqual([k, true]);
  });
});

// ---- og entity/transition/cross-j-proposer-materialization.ts selectCrossJOpeningAccountProposalTxs: one exact sibling opening cohort ----
describe(seedTag("runtime-final: cross-j opening cohort (og selectCrossJOpeningAccountProposalTxs)"), () => {
  test("MATCH (randomized): 800 Accounts with cross pull locks, cross swap offers and sibling replicas (pending cohorts, missing replicas and Accounts, bad roles) -- og's cohort, wait or halt", () => {
    seed = seedOf(57);
    const ids = Array.from({ length: 5 }, (_, i) => `0x${String(i + 1).repeat(64)}`), signers = ids.map((_, i) => `0x${String.fromCharCode(97 + i).repeat(40)}`);
    const seen = new Map<string, number>(), buckets = ["ordinary", "wait", "cohort"];
    for (let n = 0, more = untilCovered(800, () => buckets.every((k) => (seen.get(k) ?? 0) > 40)); more(n); n++) {
      const orderIds = ["ord-a", "ord-b", "Ord-C", "ord-d"].slice(0, 1 + ri(4));
      const routes = new Map(orderIds.map((orderId) => {
        const roles = [...ids].sort(() => rng() - 0.5).slice(0, 4), signer = (i: number): string => (rng() < 0.03 ? "" : signers[ids.indexOf(roles[i] as string)] as string);
        return [orderId, { orderId, source: { entityId: roles[0], counterpartyEntityId: roles[1] }, target: { entityId: roles[2], counterpartyEntityId: roles[3] },
          sourceSignerId: signer(0), sourceHubSignerId: signer(1), targetHubSignerId: signer(2), targetSignerId: signer(3) }] as const;
      }));
      // one tx in both shapes: the rewrite's flat Account tx and og's {type, data}
      const tx = (): { readonly rw: Record<string, unknown>; readonly og: Record<string, unknown> } => {
        const k = ri(10), orderId = pick(orderIds), route = routes.get(orderId), id = rng() < 0.01 ? "  " : pick([orderId, orderId.toUpperCase()]);
        if (k < 5) { const data = { pullId: `p${ri(9)}`, tokenId: "1", amount: 1n, fullHash: "0x", partialRoot: "0x", crossJurisdiction: { orderId: id, routeHash: "0x", leg: "source" }, crossJurisdictionRoute: route }; return { rw: { type: "cross_pull_lock", ...data }, og: { type: "cross_pull_lock", data } }; }
        if (k < 8) { const data = { offerId: orderId, crossJurisdiction: { ...route, orderId: id } }; return { rw: { type: "swap_offer", ...data }, og: { type: "swap_offer", data } }; }
        return { rw: { type: "add_delta", tokenId: "1" }, og: { type: "add_delta", data: { tokenId: 1 } } };
      };
      const txs = (max: number) => Array.from({ length: ri(max) }, tx);
      const local = pick(ids), peer = pick(ids.filter((x) => x !== local)), mempool = txs(6);
      const rwReplicas: unknown[] = [], ogReplicas = new Map<string, unknown>();
      for (const [i, e] of ids.entries()) {
        if (rng() < 0.15) continue;
        const signer = rng() < 0.1 ? signers[(i + 1) % signers.length] : signers[i];
        const rwAccounts = new Map<string, unknown>(), ogAccounts = new Map<string, unknown>();
        for (const other of ids) {
          if (other === e || rng() < 0.2) continue;
          const pending = rng() < 0.35 ? txs(5) : undefined, queued = txs(6);
          rwAccounts.set(other, pending === undefined ? { _tag: "open", mempool: queued.map((x) => x.rw) } : { _tag: "proposed", mempool: queued.map((x) => x.rw), candidate: { frame: { txs: pending.map((x) => x.rw) } } });
          ogAccounts.set(other, { mempool: queued.map((x) => x.og), ...(pending === undefined ? {} : { pendingFrame: { accountTxs: pending.map((x) => x.og) } }) });
        }
        rwReplicas.push({ state: { id: e }, signerId: signer, accountReplicas: rwAccounts });
        ogReplicas.set(`${e}:${signer}`, { entityId: e, signerId: signer, state: { entityId: e, accounts: ogAccounts } });
      }
      const [first, second] = [local, peer].sort();
      let og: string;
      try {
        const got = ogOpeningSelection({ state: { eReplicas: ogReplicas } } as never, { entityId: local } as never, { mempool: mempool.map((x) => x.og), proofHeader: { fromEntity: first, toEntity: second } } as never);
        og = got === undefined ? "ordinary" : got === null ? "wait" : `cohort:${(got as unknown[]).map((x) => mempool.findIndex((m) => m.og === x)).join(",")}`;
      } catch (e) { og = `halt:${String((e as Error).message).split(":")[0]}`; }
      const siblings = (entity: string, signer: string) => rwReplicas.find((r) => (r as { state: { id: string } }).state.id.toLowerCase() === entity && String((r as { signerId: string }).signerId).toLowerCase() === signer) as never;
      const rwResult = crossOpeningSelection({ id: local } as never, peer as never, mempool.map((x) => x.rw) as never, siblings);
      const rw = !rwResult.ok ? `halt:${String((rwResult.error as { reason?: string }).reason).split(":")[0]}` : rwResult.value === undefined ? "ordinary" : rwResult.value === null ? "wait"
        : `cohort:${rwResult.value.map((x) => mempool.findIndex((m) => m.rw === x)).join(",")}`;
      expect([n, rw]).toEqual([n, og]);
      const bucket = og.startsWith("cohort") ? "cohort" : og;
      seen.set(bucket, (seen.get(bucket) ?? 0) + 1);
    }
    for (const k of buckets) expect([k, (seen.get(k) ?? 0) > 40]).toEqual([k, true]);
    expect([...seen.keys()].filter((k) => k.startsWith("halt:")).length).toBeGreaterThan(2);
  });
});

// ---- og runtime/admit/entity-input-output.ts collectReadyLocalAccountWorkTargets: who gets the same-frame Account-work poke ----
describe(seedTag("runtime-final: local Account work (og entity-input-output.ts collectReadyLocalAccountWorkTargets)"), () => {
  test("MATCH (randomized): 300 Runtimes of 1-6 replicas (boards, failed-over leaders, frames in flight, queued or pending Accounts) -- og's targets and order", () => {
    seed = seedOf(83);
    const people = [aliceAddr, bobAddr, carolAddr].map((a) => a.toLowerCase());
    let nonEmpty = 0;
    for (let n = 0; n < 300; n++) {
      const rw: unknown[] = [], og: unknown[] = [];
      for (let k = 0; k < 1 + ri(6); k++) {
        const id = pick([ALICE, BOB, CAROL]), members = people.slice(0, 1 + ri(3)), shares = members.map(() => BigInt(1 + ri(3)));
        const base = unwrap(createEntity({ id, jurisdiction: TERMS.domain, threshold: 1n, members: new Map(members.map((m, i) => [m as Address, { shares: shares[i] as bigint }])) }));
        const signer = pick(members), active = rng() < 0.3 ? pick(members) : undefined, phase = pick(["open", "open", "open", "proposed", "locked"]);
        const rwAccounts = new Map<string, unknown>(), ogAccounts = new Map<string, unknown>();
        for (const peer of [ALICE, BOB, CAROL].filter((p) => p !== id)) {
          if (rng() < 0.3) continue;
          const queued = rng() < 0.5 ? 1 + ri(2) : 0, pending = rng() < 0.3;
          const txs = Array.from({ length: queued }, () => ({ type: "add_delta", tokenId: "1" }));
          rwAccounts.set(peer, { _tag: pending ? "proposed" : "open", mempool: txs });
          ogAccounts.set(peer.toLowerCase(), { status: "active", mempool: txs.map(() => ({ type: "add_delta", data: { tokenId: 1 } })), state: { locks: new Map() }, ...(pending ? { pendingFrame: { height: 1 } } : {}) });
        }
        const leaderState = active === undefined ? undefined : { activeValidatorId: active, view: 1, changedAtHeight: 0 };
        rw.push({ ...base, _tag: phase, signerId: signer, state: { ...base.state, ...(leaderState === undefined ? {} : { leaderState }) }, accountReplicas: rwAccounts });
        og.push({ entityId: id, signerId: signer, ...(phase === "proposed" ? { proposal: {} } : phase === "locked" ? { lockedFrame: {} } : {}),
          state: { entityId: id, config: { mode: "proposer-based", threshold: 1n, validators: members, shares: Object.fromEntries(members.map((m, i) => [m, shares[i]])) }, ...(leaderState === undefined ? {} : { leaderState }),
            accounts: { workKeys: () => ogAccounts.keys(), get: (key: string) => ogAccounts.get(key) } } });
      }
      const want = ogReadyAccountWork(og as never), got = readyAccountWorkTargets(rw as never);
      expect([n, got]).toEqual([n, want]);
      if (want.length > 0) nonEmpty += 1;
    }
    expect(nonEmpty).toBeGreaterThan(60);
  });
  test("MATCH: only a `txs` input defers its proposal to the frame's flush (og isProposalDeferrableEntityInput)", () => {
    const shapes: [string, Record<string, unknown>][] = [["txs", { entityTxs: [] }], ["proposal", { proposedFrame: {} }], ["precommit", { hashPrecommits: new Map([["a", []]]) }],
      ["jPrefixAttestations", { jPrefixAttestations: new Map() }], ["leaderTimeoutVote", { leaderTimeoutVote: {} }]];
    expect(shapes.map(([kind, og]) => [kind, ogDeferrable(og as never)])).toEqual(shapes.map(([kind]) => [kind, kind === "txs"]));
  });
});

// ---- og runtime/delivery/topology/entity-routing.ts + frame/cross-j/atomic-admission.ts: atomic cross-j Account pair admission ----
/** Random cross-j Account legs, in the rewrite's shape and og's, with transport provenance; plus a Runtime of replicas both implementations read. */
const crossWorld = () => {
  const ENTS = ["0x" + "a1".repeat(32), "0x" + "b2".repeat(32), "0x" + "c3".repeat(32), "0x" + "d4".repeat(32)] as const;
  const PEERS = ["0x" + "e5".repeat(32), "0x" + "f6".repeat(32)] as const;
  const SIGNERS = [aliceAddr.toLowerCase(), bobAddr.toLowerCase()] as const;
  const RUNTIMES = [undefined, "0x" + "11".repeat(20), "0x" + "22".repeat(20)] as const;
  const ORDERS = ["o1", "o2"] as const, RH: Record<string, string> = { o1: "0x" + "aa".repeat(32), o2: "0x" + "ab".repeat(32) };
  const FH: Record<string, string> = { o1: "0x" + "01".repeat(32), o2: "0x" + "02".repeat(32) }, PR: Record<string, string> = { o1: "0x" + "03".repeat(32), o2: "0x" + "04".repeat(32) };
  const route = (o: string, memo: string) => ({ orderId: o, routeHash: RH[o], status: "intent", makerEntityId: ENTS[0], hubEntityId: ENTS[1], sourceSignerId: "nobody", targetSignerId: "nobody",
    source: { jurisdiction: "j1", entityId: ENTS[0], counterpartyEntityId: PEERS[0], tokenId: 1, amount: 10n }, target: { jurisdiction: "j2", entityId: PEERS[1], counterpartyEntityId: ENTS[1], tokenId: 2, amount: 20n },
    sourcePull: { pullId: `sp-${o}`, tokenId: 1, amount: 10n, signedAmount: 10n, fullHash: FH[o], partialRoot: PR[o] }, targetPull: { pullId: `tp-${o}`, tokenId: 2, amount: 20n, signedAmount: -20n, fullHash: FH[o], partialRoot: PR[o] },
    createdAt: 0, updatedAt: 0, memo });
  const lock = (leg: "source" | "target", o: string) => ({ type: "cross_pull_lock", pullId: rng() < 0.08 ? "bad" : `${leg === "source" ? "sp" : "tp"}-${o}`, tokenId: "1", amount: 10n,
    fullHash: rng() < 0.08 ? FH.o2 : FH[o], partialRoot: PR[o], crossJurisdiction: { orderId: o, routeHash: rng() < 0.2 ? RH[o]!.toUpperCase().replace("0X", "0x") : RH[o], leg }, crossJurisdictionRoute: route(o, rng() < 0.08 ? "other" : "") });
  const close = (leg: "source" | "target", o: string) => ({ type: "cross_pull_close", pullId: `${leg === "source" ? "sp" : "tp"}-${o}`, binary: "0x",
    proof: { orderId: o, routeHash: RH[o], sourcePullId: `sp-${o}`, targetPullId: `tp-${o}`, fillRatio: rng() < 0.1 ? 2 : 1, cumulativeSourceAmount: 5n, cumulativeTargetAmount: 6n, binaryHash: "0xbb", closeMode: "full" } });
  const offer = (o: string) => ({ type: "swap_offer", offerId: `of-${o}`, crossJurisdiction: { orderId: o, routeHash: RH[o] } });
  type RwTx = Record<string, unknown> & { type: string };
  const frameTxs = (kind: string, orders: readonly string[]): RwTx[] => orders.flatMap((o): RwTx[] => kind === "source" ? [lock("source", o), ...(rng() < 0.85 ? [offer(o)] : [])] : kind === "target" ? [lock("target", o)]
    : kind === "both" ? [lock("source", o), offer(o), lock("target", o)] : kind === "closeS" ? [close("source", o)] : kind === "closeT" ? [close("target", o)] : [{ type: "add_delta", tokenId: "1" }]);
  const frames: { height: bigint; stateHash: string; prevFrameHash: string; txs: RwTx[] }[] = [];
  const frameOf = (kind: string, orders: readonly string[]) => {
    const f = { height: BigInt(1 + ri(3)), stateHash: "0x" + (frames.length + 16).toString(16).padStart(64, "0"), prevFrameHash: "0x" + "99".repeat(32), txs: frameTxs(kind, orders) };
    frames.push(f);
    return f;
  };
  const accountTx = (from: string, to: string, f: ReturnType<typeof frameOf>, ackOnly: boolean) => ({ type: "accountInput", data: ackOnly
    ? { kind: "ack", fromEntityId: from, toEntityId: to, height: f.height, frameHash: rng() < 0.9 ? f.stateHash : "0x" + "98".repeat(32) }
    : { kind: "ack_frame", fromEntityId: from, toEntityId: to, ack: null, frame: f } });
  type RwIn = { entityId: string; signerId: string; from?: string; runtimeId?: string; sourceRuntimeFrame?: { height: number; timestamp: number }; atomicCrossJurisdictionPair?: { phase: "proposal" | "ack"; pairKey: string }; input: { kind: "txs"; timestamp: bigint; txs: RwTx[] } };
  const provenance = () => {
    const from = pick([undefined, undefined, RUNTIMES[1], RUNTIMES[2], "not-a-runtime"]), frame = rng() < 0.6 ? pick([{ height: 1, timestamp: 10 }, { height: 2, timestamp: 20 }]) : undefined;
    return { ...(from === undefined ? {} : { from }), ...(rng() < 0.5 ? { runtimeId: pick([RUNTIMES[1], RUNTIMES[2]]) as string } : {}), ...(frame === undefined ? {} : { sourceRuntimeFrame: frame }) };
  };
  const leg = (entityId: string, kind: string, orders: readonly string[], prov: object, ackOnly = false): RwIn => {
    const f = frameOf(kind, orders), txs: RwTx[] = [accountTx(pick(PEERS), entityId, f, ackOnly)];
    if (rng() < 0.08) txs.push(accountTx(pick(PEERS), entityId, frameOf(pick(["source", "target", "none"]), orders), false));
    if (rng() < 0.2) txs.push({ type: "chat", data: { message: "hi" } } as never);
    // og never nests an accountInput in a runtimeOutput (RUNTIME_OUTPUT_NESTED_PROTOCOL_TX_FORBIDDEN): the envelope carries only ordinary txs
    const wrapped: RwTx[] = rng() < 0.15 ? [...txs, { type: "runtimeOutput", data: { protocol: "cross-j", sourceEntityId: pick(PEERS), sourceSignerId: SIGNERS[0], targetEntityId: entityId, entityTxs: [{ type: "chat", data: { message: "w" } }] } }] : txs;
    return { entityId, signerId: pick(SIGNERS), ...prov, input: { kind: "txs", timestamp: 0n, txs: wrapped } };
  };
  const inputs = (): RwIn[] => {
    const out: RwIn[] = [];
    for (let c = 0; c < 1 + ri(3); c++) {
      const orders = rng() < 0.7 ? ["o1"] : ["o1", "o2"], prov = provenance(), [a, b] = rng() < 0.9 ? [ENTS[ri(2)] as string, ENTS[2 + ri(2)] as string] : [ENTS[0], ENTS[0]];
      const [ka, kb] = pick([["source", "target"], ["target", "source"], ["both", "both"], ["closeS", "closeT"], ["closeT", "closeS"], ["closeS", "closeT"], ["source", "source"], ["none", "target"]]);
      const second = rng() < 0.85 ? prov : provenance(), ackPair = rng() < 0.15;
      out.push(leg(a, ka as string, orders, prov, ackPair), ...(rng() < 0.85 ? [leg(b, kb as string, orders, second, ackPair)] : []));
    }
    for (let k = 0; k < ri(2); k++) out.push({ entityId: pick(ENTS), signerId: pick(SIGNERS), ...provenance(), input: { kind: "txs", timestamp: 0n, txs: [{ type: "chat", data: { message: "x" } } as never] } });
    for (let k = out.length - 1; k > 0; k--) { const j = ri(k + 1); [out[k], out[j]] = [out[j] as RwIn, out[k] as RwIn]; }
    // transport markers: some inputs arrive already marked (a valid cohort key, a stale one, or an ACK cohort)
    if (rng() < 0.3) for (const i of out) if (rng() < 0.5) i.atomicCrossJurisdictionPair = { phase: pick(["proposal", "ack"] as const), pairKey: pick(["k1", "proposal\u0000open\u0000o1\u0000" + RH.o1]) };
    return out;
  };
  const ogTx = (tx: RwTx): unknown => {
    if (tx.type === "accountInput") {
      const d = tx["data"] as Record<string, unknown>;
      if (d["kind"] === "ack") return { type: "accountInput", data: { kind: "ack", fromEntityId: d["fromEntityId"], toEntityId: d["toEntityId"], ack: { height: Number(d["height"]), frameHash: d["frameHash"] } } };
      const f = d["frame"] as ReturnType<typeof frameOf>;
      return { type: "accountInput", data: { kind: "ack_frame", fromEntityId: d["fromEntityId"], toEntityId: d["toEntityId"], proposal: { frame: ogFrame(f) } } };
    }
    if (tx.type === "runtimeOutput") { const d = tx["data"] as Record<string, unknown>; return { type: "runtimeOutput", data: { ...d, entityTxs: (d["entityTxs"] as RwTx[]).map(ogTx) } }; }
    return tx;
  };
  const ogAccountTx = (tx: RwTx): unknown => { const { type, ...data } = tx; return { type, data }; };
  const ogFrame = (f: ReturnType<typeof frameOf>) => ({ height: Number(f.height), stateHash: f.stateHash, prevFrameHash: f.prevFrameHash, accountTxs: f.txs.map(ogAccountTx) });
  const ogIn = (i: RwIn) => { const { input, ...rest } = i; return { ...rest, entityTxs: input.txs.map(ogTx) }; };
  /** Replicas of every input's (Entity, signer): hub or not, heads and pending frames from the frame pool, authorizations, live pulls. */
  const runtime = (ins: readonly RwIn[], committedHeads = false) => {
    const rw = new Map<string, unknown>(), ogReplicas = new Map<string, unknown>();
    const auth = (o: string) => ({ ...route(o, ""), sourcePull: undefined, targetPull: undefined });
    const shared = new Map(ORDERS.map((o) => [o, auth(o)]));
    for (const i of ins) {
      const key = `${i.entityId}:${i.signerId}`;
      if (rw.has(key) || rng() < 0.08) continue;
      const hub = rng() < 0.35 || committedHeads, rwAccounts = new Map<string, unknown>(), ogAccounts = new Map<string, unknown>();
      for (const peer of PEERS) {
        // `committedHeads`: every Account head is a frame of the batch and nothing is pending, so ACK legs replay already-committed frames
        const acked = committedHeads ? frames.find((f) => ins.some((x) => x.entityId === i.entityId && x.input.txs.some((t) => t.type === "accountInput" && (t["data"] as Record<string, unknown>)["kind"] === "ack" && (t["data"] as Record<string, unknown>)["fromEntityId"] === peer && (t["data"] as Record<string, unknown>)["frameHash"] === f.stateHash))) : undefined;
        const head = acked ?? ((rng() < 0.3 || committedHeads) && frames.length > 0 ? pick(frames) : undefined), pending = rng() < 0.5 && !committedHeads && frames.length > 0 ? pick(frames) : undefined;
        const pulls = new Map(rng() < 0.2 ? [["p", { crossJurisdiction: { routeHash: pick([RH.o1, RH.o2, "0x" + "cc".repeat(32)]) }, fullHash: pick([FH.o1, FH.o2]), partialRoot: pick([PR.o1, PR.o2]) }]] : []);
        rwAccounts.set(peer, { _tag: pending ? "proposed" : "open", head: head ? { _tag: "installed", height: head.height, prevFrameHash: head.stateHash, ...(head.txs.some((t: RwTx) => t.type === "cross_pull_lock" || t.type === "cross_pull_close") ? { crossTxs: head.txs.filter((t: RwTx) => t.type === "cross_pull_lock" || t.type === "cross_pull_close") } : {}) } :{ _tag: "genesis", height: 0n, prevFrameHash: "genesis" }, ...(pending ? { candidate: { frame: pending } } : {}), state: { pulls } });
        ogAccounts.set(peer, { currentFrame: head ? ogFrame(head) : { height: 0, stateHash: "", prevFrameHash: "", accountTxs: [] }, ...(pending ? { pendingFrame: ogFrame(pending) } : {}), state: { pulls } });
      }
      const auths = new Map(ORDERS.flatMap((o) => { const r = rng(); return r < 0.3 ? [] : r < 0.8 ? [[o, shared.get(o)]] : r < 0.9 ? [[o, { ...auth(o), status: "resting" }]] : [[o, { ...auth(o), memo: "divergent" }]]; }) as [string, unknown][]);
      const state = { id: i.entityId, timestamp: 5n, hub: hub ? { _tag: "hub", config: {}, lending: undefined } : { _tag: "spoke" }, crossJurisdictionAuthorizations: auths };
      rw.set(key, { state, signerId: i.signerId, accountReplicas: rwAccounts });
      ogReplicas.set(key, { entityId: i.entityId, signerId: i.signerId, state: { entityId: i.entityId, timestamp: 5, profile: { isHub: hub }, accounts: ogAccounts, crossJurisdictionAuthorizations: auths } });
    }
    return { rw: { entities: rw, timestamp: 7n } as never, og: { state: { eReplicas: ogReplicas, timestamp: 7, height: 3 }, warn: () => undefined } as never };
  };
  return { inputs, ogIn, runtime, reset: () => { frames.length = 0; } };
};
/** One comparable row per input: Entity, marker, the Account legs it still carries. */
const crossInputView = (i: Record<string, unknown>) => {
  const txs = ("input" in i ? ((i["input"] as { txs: { type: string; data: Record<string, unknown> }[] }).txs) : (i["entityTxs"] as { type: string; data: Record<string, unknown> }[])) ?? [];
  const legs = txs.flatMap((tx) => (tx.type === "runtimeOutput" ? (tx.data["entityTxs"] as { type: string; data: Record<string, unknown> }[]) : [tx])).filter((tx) => tx.type === "accountInput").map((tx) => String(tx.data["fromEntityId"]) + ":" + String(tx.data["kind"]));
  return { entityId: i["entityId"], marker: (i["atomicCrossJurisdictionPair"] as object | undefined) ?? null, txs: txs.length, legs };
};
const crossPairView = (p: Record<string, unknown>) => {
  const frame = (f: Record<string, unknown>) => ({ ...f, height: Number(f["height"]) });
  return { ...p, ...(p["sourceAccountFrame"] ? { sourceAccountFrame: frame(p["sourceAccountFrame"] as Record<string, unknown>), targetAccountFrame: frame(p["targetAccountFrame"] as Record<string, unknown>) } : {}) };
};
describe(seedTag("runtime-final: atomic cross-j Account pair admission (og entity-routing.ts, atomic-admission.ts)"), () => {
  test("MATCH (randomized): 800 input batches -- og selectPotentialCrossJAccountInputPairs (both frame policies) and markPotentialAtomicCrossJInputPairs", () => {
    seed = seedOf(131);
    const w = crossWorld();
    let paired = 0, marked = 0;
    for (let n = 0; n < 800; n++) {
      w.reset();
      const ins = w.inputs(), ogs = ins.map(w.ogIn);
      for (const allow of [false, true]) {
        const want = ogPotentialPairs(ogs as never, { allowDifferentSourceRuntimeFrames: allow }), got = potentialCrossPairs(ins as never, { allowDifferentSourceRuntimeFrames: allow });
        expect([n, allow, got]).toEqual([n, allow, want]);
        paired += want.length;
      }
      const want = ogMarkPotential(ogs as never).map((i) => crossInputView(i as never)), got = markPotentialCrossPairs(ins as never).map((i) => crossInputView(i as never));
      expect([n, got]).toEqual([n, want]);
      marked += want.filter((i) => i.marker !== null).length;
    }
    expect(paired).toBeGreaterThan(300);
    expect(marked).toBeGreaterThan(100);
  });
  test("MATCH (randomized): 800 batches against a Runtime of hubs and spokes -- og selectMatchedCrossJAccountInputPairs (pairs, rejected legs with reason and detail, retained inputs)", () => {
    seed = seedOf(137);
    const w = crossWorld(), reasons = new Map<string, number>();
    let pairs = 0;
    for (let n = 0; n < 800; n++) {
      w.reset();
      const ins = w.inputs(), ogs = ins.map(w.ogIn), env = w.runtime(ins);
      const want = ogMatchedPairs(env.og, ogs as never), got = matchedCrossPairs(env.rw, ins as never);
      const legView = (l: { inputIndex: number; reason: string; detail: readonly string[]; accountInput: Record<string, unknown> }) => ({ inputIndex: l.inputIndex, reason: l.reason, detail: l.detail, from: l.accountInput["fromEntityId"], kind: l.accountInput["kind"] });
      expect([n, got.pairs.map((p) => crossPairView(p as never)), got.rejectedLegs.map((l) => legView(l as never)), got.inputs.map((i) => crossInputView(i as never))])
        .toEqual([n, want.pairs.map((p) => crossPairView(p as never)), want.rejectedLegs.map((l) => legView(l as never)), want.inputs.map((i) => crossInputView(i as never))]);
      pairs += want.pairs.length;
      for (const l of want.rejectedLegs) reasons.set(l.reason, (reasons.get(l.reason) ?? 0) + 1);
    }
    expect(pairs).toBeGreaterThan(40);
    expect([...reasons.keys()].sort()).toEqual(["atomic-group-invalid", "candidate-invalid", "multiple-candidates-per-input", "pair-match-failed"]);
    // og buildCrossJAckFrameCandidate over currentFrame.accountTxs: an exact replay of an already-committed ACK is a committed candidate only
    // when that committed frame holds a cross-j pull or close (the head keeps them as crossTxs)
    let replays = 0;
    for (let n = 0; n < 600; n++) {
      w.reset();
      const isAck = (i: { input: { txs: readonly Record<string, unknown>[] } }) => i.input.txs.some((t) => t["type"] === "accountInput" && (t["data"] as Record<string, unknown>)["kind"] === "ack");
      const ins = w.inputs().map((i) => (isAck(i) ? { ...i, atomicCrossJurisdictionPair: { phase: "ack" as const, pairKey: "k" } } : i)), ogs = ins.map(w.ogIn), env = w.runtime(ins, true);
      const want = ogMatchedPairs(env.og, ogs as never), got = matchedCrossPairs(env.rw, ins as never);
      const legView = (l: { inputIndex: number; reason: string; detail: readonly string[] }) => ({ inputIndex: l.inputIndex, reason: l.reason, detail: l.detail });
      expect([n, got.pairs.map((p) => crossPairView(p as never)), got.rejectedLegs.map((l) => legView(l as never)), got.inputs.map((i) => crossInputView(i as never))])
        .toEqual([n, want.pairs.map((p) => crossPairView(p as never)), want.rejectedLegs.map((l) => legView(l as never)), want.inputs.map((i) => crossInputView(i as never))]);
      replays += want.inputs.filter((i) => i.atomicCrossJurisdictionPair !== undefined).length;
    }
    expect(replays).toBeGreaterThan(20);
  });
  test("MATCH (randomized): 500 merged batches -- og admitAtomicCrossJAccountInputs (retry coalescing, stripped legs, pairs grouped first and marked; replay refuses)", () => {
    seed = seedOf(139);
    const w = crossWorld();
    let grouped = 0;
    for (let n = 0; n < 500; n++) {
      w.reset();
      const base = w.inputs();
      // a transport retry: the same marked cohort again from a later source frame
      const ins = rng() < 0.3 && base.length >= 2 ? [...base, ...base.slice(0, 2).map((i) => ({ ...i, sourceRuntimeFrame: { height: 9, timestamp: 90 } }))] : base;
      const ogs = ins.map(w.ogIn), env = w.runtime(ins);
      for (const replay of [false, true]) {
        let want: unknown;
        try { const r = ogAdmitAtomic(env.og, ogs as never, replay); want = { inputs: r.inputs.map((i) => crossInputView(i as never)), pairs: r.pairs.map((p) => crossPairView(p as never)) }; }
        catch (e) { want = ogCode(e); }
        const r = admitAtomicCrossPairs(env.rw, ins as never, replay);
        const got = r.ok ? { inputs: r.value.inputs.map((i) => crossInputView(i as never)), pairs: r.value.pairs.map((p) => crossPairView(p as never)) } : rwCode(r);
        expect<unknown>([n, replay, got]).toEqual([n, replay, want]);
        if (!replay && typeof want === "object" && (want as { pairs: unknown[] }).pairs.length > 0) grouped += 1;
      }
    }
    expect(grouped).toBeGreaterThan(20);
  });
  test("MATCH: the Runtime applies an admitted pair atomically -- a leg that cannot commit discards both, rejects the pair and re-applies the rest; a lone leg is stripped; replay refuses (og applyAtomicEntityInputPair)", () => {
    const solo = (id: EntityId, signer: string) => unwrap(createEntity({ id, jurisdiction: TERMS.domain, threshold: 1n, members: new Map([[signer as Address, { shares: 1n }]]), signerId: signer as Address, jurisdictionConfig: UNREGISTERED_J }));
    const rt = spawn(spawn(createRuntime(), solo(ALICE, aliceAddr)), solo(BOB, bobAddr));
    const proof = { orderId: "o1", routeHash: "0x" + "aa".repeat(32), sourcePullId: "sp-o1", targetPullId: "tp-o1", fillRatio: 1, cumulativeSourceAmount: 5n, cumulativeTargetAmount: 6n, binaryHash: "0xbb", closeMode: "full" };
    const leg = (to: EntityId, signer: string, pullId: string, n: number): RoutedEntityInput => ({ entityId: to, signerId: signer, input: { kind: "txs", timestamp: NOW, txs: [
      { type: "accountInput", data: { kind: "ack_frame", fromEntityId: CAROL, toEntityId: to, ack: null, frame: { height: 1n, stateHash: "0x" + String(n).repeat(64), prevFrameHash: "0x" + "99".repeat(32), txs: [{ type: "cross_pull_close", pullId, binary: "0x", proof }] } } } as never,
      { type: "chat", data: { from: signer.toLowerCase(), message: `m${n}` } } as never] } });
    const pair = [leg(ALICE, aliceAddr, "sp-o1", 1), leg(BOB, bobAddr, "tp-o1", 2)];
    const step = unwrap(applyRuntime(rt, { runtimeTxs: [], entityInputs: pair }, verifiers));
    expect(step.rejected.map((e) => rwCode({ ok: false, error: e }))).toEqual(["CROSS_J_ACCOUNT_PAIR_NOT_COMMITTED", "CROSS_J_ACCOUNT_PAIR_NOT_COMMITTED"]);
    expect(step.applied.entityInputs.map((i) => [i.entityId, i.input.kind === "txs" ? i.input.txs.map((tx) => tx.type) : [], i.atomicCrossJurisdictionPair ?? null])).toEqual([[ALICE, ["chat"], null], [BOB, ["chat"], null]]);
    expect(rwCode(applyRuntime(rt, { runtimeTxs: [], entityInputs: pair }, { ...verifiers, replay: true }))).toBe("RUNTIME_REPLAY_CROSS_J_ACCOUNT_PAIR_NOT_COMMITTED");
    // og prepareEntityInputIngress: a leg over the Entity mempool limit is a `rejected` outcome (ENTITY_MEMPOOL_ADMISSION_REJECTED), not a thrown
    // ingress error, so a remote or local pair is NOT_COMMITTED (never PROTOCOL_REJECTED)
    const bobKey = [...rt.entities.keys()].find((k) => rt.entities.get(k)!.state.id === BOB)!, bobR = rt.entities.get(bobKey)!;
    const fullMempool = Array.from({ length: 10_000 }, (_, i) => ({ type: "chat", data: { from: bobAddr.toLowerCase(), message: `q${i}` } })) as never[];
    expect(ogMempoolAdmission({ mempool: fullMempool } as never, { entityId: BOB, signerId: bobAddr, entityTxs: [{}, {}] } as never)).toStartWith("entity mempool admission overflow");
    const full = { ...rt, entities: new Map([...rt.entities, [bobKey, { ...bobR, mempool: fullMempool }]]) } as typeof rt;
    const remotePair = pair.map((l) => ({ ...l, from: "runtime-carol" }));
    for (const legs of [pair, remotePair]) {
      const fullStep = unwrap(applyRuntime(full, { runtimeTxs: [], entityInputs: legs }, verifiers));
      expect(fullStep.rejected.map((e) => rwCode({ ok: false, error: e }))).toContain("CROSS_J_ACCOUNT_PAIR_NOT_COMMITTED");
    }
    // a lone leg is no cohort: its Account leg is stripped before Account consensus (og CROSS_J_ACCOUNT_PAIR_STRUCTURAL_MISMATCH), a replay refuses the frame
    const lone = unwrap(applyRuntime(rt, { runtimeTxs: [], entityInputs: [pair[0] as RoutedEntityInput] }, verifiers));
    expect(lone.applied.entityInputs.map((i) => [i.entityId, i.input.kind === "txs" ? i.input.txs.map((tx) => tx.type) : []])).toEqual([[ALICE, ["chat"]]]);
    expect(rwCode(applyRuntime(rt, { runtimeTxs: [], entityInputs: [pair[0] as RoutedEntityInput] }, { ...verifiers, replay: true }))).toBe("RUNTIME_REPLAY_CROSS_J_ACCOUNT_PAIR_INVALID");
    // og entityInputMergeKey: a marked leg needs its transport frame
    const marked = { ...(pair[0] as RoutedEntityInput), atomicCrossJurisdictionPair: { phase: "proposal" as const, pairKey: "k" } };
    expect(() => ogMergeEntityInputs([{ entityId: ALICE, signerId: aliceAddr, entityTxs: [], atomicCrossJurisdictionPair: marked.atomicCrossJurisdictionPair }] as never)).toThrow("ENTITY_INPUT_ATOMIC_CROSS_J_SOURCE_FRAME_MISSING");
    expect(rwCode(applyRuntime(rt, { runtimeTxs: [], entityInputs: [marked] }, verifiers))).toBe("ENTITY_INPUT_ATOMIC_CROSS_J_SOURCE_FRAME_MISSING");
  });
  test("MATCH (randomized): 400 committed pairs and Runtime outboxes -- og markCommittedAtomicCrossJAckOutputs (exactly one distinct ACK output per leg gets the ACK marker)", () => {
    seed = seedOf(149);
    const ENTS = [ALICE, BOB, CAROL].map((e) => e.toLowerCase()), HASHES = ["0x" + "71".repeat(32), "0x" + "72".repeat(32)];
    let markedRuns = 0;
    for (let n = 0; n < 400; n++) {
      const expectation = () => { const [a, b] = [pick(ENTS), pick(ENTS)]; return { entityId: a, signerId: "s", counterpartyEntityId: b, height: BigInt(1 + ri(2)), stateHash: pick(HASHES) }; };
      const pairs = Array.from({ length: 1 + ri(2) }, (_, k) => ({ pairKey: `k${k}`, phase: pick(["proposal", "proposal", "ack"] as const), sourceInputIndex: 0, targetInputIndex: 1, sourceAccountFrame: expectation(), targetAccountFrame: expectation() }));
      const outbox = Array.from({ length: ri(6) }, () => {
        const from = pick(ENTS), to = pick(ENTS), height = BigInt(1 + ri(2)), frameHash = pick(HASHES).toUpperCase().replace("0X", "0x");
        const data = rng() < 0.6 ? { kind: "ack", fromEntityId: from, toEntityId: to, height, frameHash } : { kind: "ack_frame", fromEntityId: from, toEntityId: to, ack: rng() < 0.7 ? { height, frameHash } : null, frame: {} };
        return { to: rng() < 0.9 ? to : pick(ENTS), tx: { type: "accountInput", data } };
      }) as { to: string; tx: { type: string; data: object } }[];
      // the honest case: each committed leg's own ACK leaves once
      for (const p of pairs) for (const e of [p.sourceAccountFrame, p.targetAccountFrame]) if (rng() < 0.8) outbox.splice(ri(outbox.length + 1), 0, { to: e.counterpartyEntityId, tx: { type: "accountInput", data: { kind: "ack", fromEntityId: e.entityId, toEntityId: e.counterpartyEntityId, height: e.height, frameHash: e.stateHash } } });
      const ogOutbox = outbox.map((o) => { const d = o.tx.data as Record<string, unknown>; const ack = d["kind"] === "ack" ? { height: Number(d["height"]), frameHash: d["frameHash"] } : d["ack"] === null ? undefined : { height: Number((d["ack"] as { height: bigint }).height), frameHash: (d["ack"] as { frameHash: string }).frameHash };
        return { entityId: o.to, signerId: "s", entityTxs: [{ type: "accountInput", data: { kind: d["kind"], fromEntityId: d["fromEntityId"], toEntityId: d["toEntityId"], ...(ack === undefined ? {} : { ack }) } }] }; });
      const ogPairs = pairs.map((p) => ({ ...p, sourceAccountFrame: { ...p.sourceAccountFrame, height: Number(p.sourceAccountFrame.height) }, targetAccountFrame: { ...p.targetAccountFrame, height: Number(p.targetAccountFrame.height) } }));
      let want: unknown;
      try { ogMarkAckOutputs(ogOutbox as never, ogPairs as never); want = ogOutbox.map((o) => (o as { atomicCrossJurisdictionPair?: unknown }).atomicCrossJurisdictionPair ?? null); } catch (e) { want = ogCode(e); }
      const r = markCommittedAckOutputs(outbox as never, pairs as never);
      expect<unknown>([n, r.ok ? r.value.map((o) => o.atomicCrossJurisdictionPair ?? null) : rwCode(r)]).toEqual([n, want]);
      if (Array.isArray(want) && want.some((m) => m !== null)) markedRuns += 1;
    }
    expect(markedRuns).toBeGreaterThan(5);
  });
});

// ---- og storage/replica/replicas.ts buildStorageLiveReplicaMetaCommitment: the per-replica rows of the Runtime replica-meta digest ----
describe(seedTag("runtime-final: live replica-meta rows (og storage/replica/replicas.ts)"), () => {
  test("MATCH (randomized): 300 Runtimes -- rows (key and exact value bytes, leader votes, pending leader certificate and J-prefix round included) and digest equal og buildStorageLiveReplicaMetaCommitment", () => {
    seed = seedOf(151);
    const addrs = [aliceAddr, bobAddr, carolAddr].map((a) => a.toLowerCase()), word = (): string => "0x" + Array.from({ length: 32 }, () => ri(256).toString(16).padStart(2, "0")).join("");
    const body = (entity: string) => ({ entityId: entity.toLowerCase(), targetHeight: 1 + ri(5), previousFrameHash: word(), fromView: ri(3), toView: 1 + ri(3), previousLeaderId: pick(addrs), nextLeaderId: pick(addrs) });
    let withFields = 0;
    for (let n = 0; n < 300; n++) {
      let rt = createRuntime();
      const ogReplicas = new Map<string, unknown>();
      for (const entity of [ALICE, BOB, CAROL].filter(() => rng() < 0.7)) for (const signer of [aliceAddr, bobAddr].filter(() => rng() < 0.6)) {
        const e = unwrap(createEntity({ id: entity, jurisdiction: TERMS.domain, threshold: 1n, members: new Map([[aliceAddr as Address, { shares: 1n }], [bobAddr as Address, { shares: 1n }]]), signerId: signer as Address }));
        const height = ri(4), timestamp = ri(1_000_000), frameHash = word();
        const leaderVotes = rng() < 0.3 ? undefined : new Map(Array.from({ length: ri(3) }, () => { const voter = pick(addrs); return [voter, { ...body(entity), voterId: voter, signature: "0x" + "5a".repeat(65) }] as const; }));
        const pendingLeaderCertificate = rng() < 0.6 ? undefined : { ...body(entity), votes: new Map([[pick(addrs), "0x" + "6b".repeat(65)]]), ...(rng() < 0.5 ? { preparedFrameHash: word() } : {}) };
        const jPrefixRound = rng() < 0.6 ? undefined : { targetEntityHeight: height + 1, parentFrameHash: frameHash, jurisdictionRef: "0x" + "7c".repeat(20), baseHeight: ri(9),
          attestations: new Map([[pick(addrs), { version: 1, entityId: entity.toLowerCase(), targetEntityHeight: height + 1, jurisdictionRef: "0x" + "7c".repeat(20), baseHeight: 1, scannedThroughHeight: 2 + ri(3), tipBlockHash: word(), eventHistoryRoot: word(), signature: "0x" + "8d".repeat(65) }]]) };
        const r = { ...e, head: { height: BigInt(height), prevFrameHash: frameHash }, state: { ...e.state, height: BigInt(height), timestamp: BigInt(timestamp) },
          ...(leaderVotes === undefined ? {} : { leaderVotes }), ...(pendingLeaderCertificate === undefined ? {} : { pendingLeaderCertificate }), ...(jPrefixRound === undefined ? {} : { jPrefixRound }) } as unknown as EntityReplica;
        rt = spawn(rt, r);
        const key = [...rt.entities.keys()].find((k) => rt.entities.get(k) === r) as string;
        ogReplicas.set(key, { entityId: entity, signerId: signer, isProposer: String(r.state.quorum.proposer).toLowerCase() === signer.toLowerCase(),
          state: { entityId: entity, height, timestamp, prevFrameHash: height === 0 ? "" : frameHash }, ...(leaderVotes === undefined ? {} : { leaderVotes }),
          ...(pendingLeaderCertificate === undefined ? {} : { pendingLeaderCertificate }), ...(jPrefixRound === undefined ? {} : { jPrefixRound }) });
        if (leaderVotes !== undefined || pendingLeaderCertificate !== undefined || jPrefixRound !== undefined) withFields += 1;
      }
      const want = ogReplicaMeta({ state: { eReplicas: ogReplicas } } as never), rows = unwrap(replicaMetaRows(rt));
      const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
      expect([n, rows.map((row) => [hex(row.key), hex(row.value)])]).toEqual([n, want.entries.map((row) => [hex(row.key), hex(row.value)])]);
      expect(unwrap(replicaMetaDigest(rows))).toBe(want.digest);
    }
    expect(withFields).toBeGreaterThan(200);
  });
});

// ---- og frame/lineage.ts buildCertifiedEntityFrameLink + storage/replica/replicas.ts: certifiedFrameHeadDigest and og-wire leader votes in replica meta ----
describe(seedTag("runtime-final: certified frame head and og-wire leader votes in replica meta (og frame/lineage.ts, leader/index.ts, storage/replica/replicas.ts)"), () => {
  const sig0x = (s: string): string => (s.startsWith("0x") ? s : `0x${s}`);
  type Members = readonly (readonly [Address, bigint])[];
  const lazyEntity = (members: Members, threshold: bigint): EntityId => unwrap(rwEntityId(quorumBoardHash({ _tag: "teaching", threshold, members: new Map(members.map(([a, s]) => [a, { shares: s }])) })));
  const validator = (members: Members, threshold: bigint, signer: Address): EntityReplica =>
    unwrap(createEntity({ id: lazyEntity(members, threshold), jurisdiction: TERMS.domain, threshold, members: new Map(members.map(([a, s]) => [a, { shares: s }])), signerId: signer }));
  const ogConfig = (s: EntityState) => {
    const q = s.quorum as unknown as { threshold: bigint; members: ReadonlyMap<string, { shares: bigint }> }, m = [...q.members];
    return { mode: "proposer-based" as const, threshold: q.threshold, validators: m.map(([a]) => a.toLowerCase()), shares: Object.fromEntries(m.map(([a, x]) => [a.toLowerCase(), x.shares])) };
  };
  /** Deliver every Entity input until quiet, remembering each proposed frame by hash. */
  const drive = (reps: Map<string, EntityReplica>, queue: [string, EntityInput][], seen: Map<string, EntityFrame>): void => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      const [s, input] = next, r = reps.get(s);
      if (r === undefined) continue;
      const applied = applyEntityInputRw(r, input, { ...verifiers, self: r.state.id, signerId: s as Address });
      // a precommit that arrives after its frame committed is refused and changes nothing
      if (!applied.ok && applied.error._tag === "precommit_not_active") continue;
      const out = unwrap(applied);
      reps.set(s, out.replica);
      for (const o of out.outputs) if ("input" in o) {
        if (o.input.kind === "proposal") seen.set(unwrap(hashEntityFrame(o.input.frame)), o.input.frame);
        queue.push([o.signerId.toLowerCase(), o.input]);
      }
    }
  };
  /** og's EntityFrame for a rewrite frame: og wire txs, numeric height/timestamp, og leader, `collectedSigs` signed afresh per manifest entry. */
  const ogFrameOf = (f: EntityFrame, hash: string, signers: readonly string[], all: boolean) => ({
    height: Number(f.height), parentFrameHash: f.prevFrameHash, stateRoot: f.stateRoot, authorityRoot: f.authorityRoot, timestamp: Number(f.timestamp), entityContext: f.entityContext,
    txs: f.txs.map(wireEntityTx), events: f.events, hash, leader: { proposerSignerId: f.leader.proposerSignerId, view: f.leader.view }, hashesToSign: f.hashesToSign.map((h) => ({ ...h })),
    collectedSigs: new Map(signers.map((s) => [s, (all ? f.hashesToSign : f.hashesToSign.slice(0, 1)).map((h) => sig0x(unwrap(crypto.sign(h.hash as never, s as Address))))])),
  });
  const ogBase = (r: EntityReplica) => ({
    entityId: r.state.id, signerId: r.signerId.toLowerCase(), isProposer: String(r.state.quorum.proposer).toLowerCase() === r.signerId.toLowerCase(),
    state: { entityId: r.state.id, height: Number(r.state.height), timestamp: Number(r.state.timestamp), prevFrameHash: r.head.height === 0n ? "" : r.head.prevFrameHash },
  });
  const rowsOf = (rt: Runtime, ogReplicas: Map<string, unknown>) => {
    const want = ogReplicaMeta({ state: { eReplicas: ogReplicas } } as never), rows = unwrap(replicaMetaRows(rt));
    const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
    return { got: rows.map((row) => [hex(row.key), hex(row.value)]), want: want.entries.map((row) => [hex(row.key), hex(row.value)]), digest: unwrap(replicaMetaDigest(rows)), wantDigest: want.digest };
  };
  test("MATCH (randomized): 40 validator sets committing 1-3 frames -- each committed replica's row carries og's certifiedFrameHeadDigest (og buildCertifiedEntityFrameLink over og-rebuilt frame, Hanko and post authority)", async () => {
    seed = seedOf(157);
    let linked = 0;
    for (let n = 0; n < 40; n++) {
      const pool = [aliceAddr, bobAddr, carolAddr] as Address[], size = 2 + ri(2);
      const members: Members = pool.slice(0, size).map((a) => [a, BigInt(1 + ri(2))] as const);
      const total = members.reduce((t, [, s]) => t + s, 0n), threshold = 1n + BigInt(ri(Number(total)));
      const reps = new Map(members.map(([a]) => [a.toLowerCase(), validator(members, threshold, a)] as const)), seen = new Map<string, EntityFrame>();
      const ceo = String((reps.values().next().value as EntityReplica).state.quorum.proposer).toLowerCase();
      for (let k = 1, frames = 1 + ri(3); k <= frames; k++)
        drive(reps, [[ceo, { kind: "txs", timestamp: NOW + BigInt(k), txs: Array.from({ length: 1 + ri(2) }, (_, i) => ({ type: "chat", data: { from: ceo, message: `m${n}.${k}.${i}` } }) as EntityTx) }]], seen);
      let rt = createRuntime();
      const ogReplicas = new Map<string, unknown>();
      for (const r of reps.values()) {
        rt = spawn(rt, r);
        const key = [...rt.entities.keys()].find((k) => rt.entities.get(k) === r) as string;
        const base = { ...ogBase(r), ...(r.leaderVotes === undefined ? {} : { leaderVotes: new Map() }) };
        if (r.head.height === 0n) { ogReplicas.set(key, base); continue; }
        const hash = r.head.prevFrameHash, f = seen.get(hash);
        if (f === undefined) throw new Error("frame not seen");
        const config = ogConfig(r.state), post = { entityId: r.state.id, height: Number(f.height), prevFrameHash: hash, config, ...(r.state.leaderState === undefined ? {} : { leaderState: r.state.leaderState }) };
        const authority = ogFrameAuthority(post as never);
        expect(ogFrameAuthorityRoot(authority)).toBe(f.authorityRoot);
        expect(ogEntityFrameHash(f.prevFrameHash, Number(f.height), Number(f.timestamp), f.txs.map(wireEntityTx) as never, f.events as never, r.state.id, f.stateRoot, f.authorityRoot, f.entityContext as never)).toBe(hash);
        // the signer set is the replica's own collected set; every signature is re-signed here
        const signers = [...((r as unknown as { certifiedFrameHead: { collectedSigs: Map<string, unknown> } }).certifiedFrameHead.collectedSigs.keys())];
        const frame = ogFrameOf(f, hash, signers, true);
        const hanko = await ogQuorumHanko({} as never, r.state.id, hash, signers.map((s) => ({ signerId: s, signature: (frame.collectedSigs.get(s) as string[])[0] as string })), config);
        const link = ogCertifiedLink(r.state.id, { ...frame, hankos: [hanko] } as never, post as never, { stateRoot: f.stateRoot, authority });
        ogReplicas.set(key, { ...base, certifiedFrameHead: link });
        linked += 1;
      }
      const { got, want, digest, wantDigest } = rowsOf(rt, ogReplicas);
      expect([n, got]).toEqual([n, want]);
      expect(digest).toBe(wantDigest);
    }
    expect(linked).toBeGreaterThan(60);
  }, 60_000);
  test("MATCH: a 3-of-3 frame locked at B and C, A silent -- B's and C's timeout votes carry the prepared frame; the leaderVotes rows equal og's (og buildPreparedFrameEvidence on the EntityFrame wire)", () => {
    const members: Members = [[aliceAddr as Address, 1n], [bobAddr as Address, 1n], [carolAddr as Address, 1n]];
    const [a, b, c] = members.map(([s]) => s.toLowerCase()) as [string, string, string];
    const reps = new Map(members.map(([s]) => [s.toLowerCase(), validator(members, 3n, s)] as const)), seen = new Map<string, EntityFrame>();
    // A proposes; its proposal reaches B and C, their precommits never reach A
    const ceo = unwrap(applyEntityInputRw(reps.get(a) as EntityReplica, { kind: "txs", timestamp: NOW, txs: [{ type: "chat", data: { from: a, message: "held" } } as EntityTx] }, { ...verifiers, self: (reps.get(a) as EntityReplica).state.id, signerId: a as Address }));
    reps.set(a, ceo.replica);
    const proposals = ceo.outputs.flatMap((o) => ("input" in o && o.input.kind === "proposal" ? [[o.signerId.toLowerCase(), o.input] as [string, EntityInput]] : []));
    expect(proposals.length).toBe(2);
    for (const [s, input] of proposals) { const r = reps.get(s) as EntityReplica; reps.set(s, unwrap(applyEntityInputRw(r, input, { ...verifiers, self: r.state.id, signerId: s as Address })).replica); }
    expect([reps.get(b)?._tag, reps.get(c)?._tag]).toEqual(["locked", "locked"]);
    const at = NOW + 10_000n, quiet = new Map([...reps].filter(([k]) => k !== a));
    for (const s of [b, c]) {
      const vote = localTimeoutVote(quiet.get(s) as EntityReplica, at);
      if (vote === undefined) throw new Error("no vote");
      drive(quiet, [[s, vote]], seen);
    }
    const genesis = reps.get(a) as EntityReplica, view = { entityId: genesis.state.id, height: 0, prevFrameHash: "genesis", config: ogConfig(genesis.state) };
    let rt = createRuntime(), prepared = 0;
    const ogReplicas = new Map<string, unknown>();
    for (const [s, r0] of [...reps].map(([s, r]) => [s, quiet.get(s) ?? r] as const)) {
      rt = spawn(rt, r0);
      const key = [...rt.entities.keys()].find((k) => rt.entities.get(k) === r0) as string;
      const votes = r0.leaderVotes === undefined ? undefined : new Map([...r0.leaderVotes].map(([voter, v]) => {
        const pf = v.preparedFrame;
        const evidence = pf === undefined ? undefined : ogPreparedEvidence(ogFrameOf(pf.frame, unwrap(hashEntityFrame(pf.frame)), [...pf.signatures.keys()], true) as never);
        if (evidence !== undefined) prepared += 1;
        return [voter, { ...ogVoteBody(view as never), voterId: v.voterId, signature: sig0x(v.signature), ...(evidence === undefined ? {} : { preparedFrame: evidence }) }] as const;
      }));
      ogReplicas.set(key, { ...ogBase(r0), ...(votes === undefined ? {} : { leaderVotes: votes }) });
      expect(s).toBe(r0.signerId.toLowerCase());
    }
    const { got, want, digest, wantDigest } = rowsOf(rt, ogReplicas);
    expect(got).toEqual(want);
    expect(digest).toBe(wantDigest);
    expect(prepared).toBe(4);
  });
});

// ---- og storage/wal/outbox-payload.ts prepareRuntimeOutputRows: each outbox row is og's RoutedEntityInput wire (entity/types.ts EntityInput) ----
describe(seedTag("runtime-final: outbox rows on og's RoutedEntityInput wire (og storage/wal/outbox-payload.ts, delivery/entity-output-signer.ts)"), () => {
  const sig0x = (s: string): string => (s.startsWith("0x") ? s : `0x${s}`);
  type Members = readonly (readonly [Address, bigint])[];
  const lazyEntity = (members: Members, threshold: bigint): EntityId => unwrap(rwEntityId(quorumBoardHash({ _tag: "teaching", threshold, members: new Map(members.map(([a, s]) => [a, { shares: s }])) })));
  const validator = (members: Members, threshold: bigint, signer: Address): EntityReplica =>
    unwrap(createEntity({ id: lazyEntity(members, threshold), jurisdiction: TERMS.domain, threshold, members: new Map(members.map(([a, s]) => [a, { shares: s }])), signerId: signer }));
  const ogConfig = (s: EntityState) => {
    const q = s.quorum as unknown as { threshold: bigint; members: ReadonlyMap<string, { shares: bigint }> }, m = [...q.members];
    return { mode: "proposer-based" as const, threshold: q.threshold, validators: m.map(([a]) => a.toLowerCase()), shares: Object.fromEntries(m.map(([a, x]) => [a.toLowerCase(), x.shares])) };
  };
  /** og's EntityFrame for a rewrite frame, `collectedSigs` re-signed per manifest entry for the given signers. */
  const ogFrameOf = (f: EntityFrame, signers: readonly string[]) => ({
    height: Number(f.height), parentFrameHash: f.prevFrameHash, stateRoot: f.stateRoot, authorityRoot: f.authorityRoot, timestamp: Number(f.timestamp), entityContext: f.entityContext,
    txs: f.txs.map(wireEntityTx), events: f.events, hash: unwrap(hashEntityFrame(f)), leader: { proposerSignerId: f.leader.proposerSignerId, view: f.leader.view }, hashesToSign: f.hashesToSign.map((h) => ({ ...h })),
    collectedSigs: new Map(signers.map((s) => [s, f.hashesToSign.map((h) => sig0x(unwrap(crypto.sign(h.hash as never, s as Address))))])),
  });
  /** og RoutedEntityInput for one rewrite output, built from og's own builders (vote body, prepared evidence, quorum Hanko). */
  const ogOutput = async (o: EntityOutput, state: EntityState, signerOf: (to: string) => string): Promise<unknown> => {
    const marker = o.atomicCrossJurisdictionPair === undefined ? {} : { atomicCrossJurisdictionPair: { ...o.atomicCrossJurisdictionPair } };
    if (!("input" in o)) return { entityId: o.to, signerId: signerOf(o.to), entityTxs: [wireEntityTx(o.tx)], ...marker };
    const i = o.input, base = { entityId: o.to, signerId: o.signerId.toLowerCase(), ...marker };
    if (i.kind === "txs") return { ...base, entityTxs: i.txs.map(wireEntityTx) };
    if (i.kind === "precommit") return { ...base, hashPrecommitFrame: { height: Number(i.height), frameHash: i.frameHash }, hashPrecommits: new Map([...i.signatures].map(([k, v]) => [k, v.map(sig0x)])) };
    if (i.kind === "proposal") {
      const frame = ogFrameOf(i.frame, [...i.signatures.keys()]);
      const hankos = i.hankos === undefined ? undefined : [await ogQuorumHanko({} as never, state.id, frame.hash, [...frame.collectedSigs].map(([s, v]) => ({ signerId: s, signature: v[0] as string })), ogConfig(state))];
      return { ...base, proposedFrame: { ...frame, ...(hankos === undefined ? {} : { hankos }) } };
    }
    if (i.kind === "leaderTimeoutVote") {
      const v = i.vote, pf = v.preparedFrame, view = { entityId: state.id, height: 0, prevFrameHash: "genesis", config: ogConfig(state) };
      return { ...base, leaderTimeoutVote: { ...ogVoteBody(view as never), voterId: v.voterId, signature: sig0x(v.signature), ...(pf === undefined ? {} : { preparedFrame: ogPreparedEvidence(ogFrameOf(pf.frame, [...pf.signatures.keys()]) as never) }) } };
    }
    throw new Error(`lane ${i.kind}`);
  };
  const expectRows = async (rt: Runtime, outbox: readonly EntityOutput[], stateOf: (o: EntityOutput) => EntityState, signerOf: (to: string) => string): Promise<void> => {
    const og = await Promise.all(outbox.map((o) => ogOutput(o, stateOf(o), signerOf)));
    const rows = unwrap(runtimeOutputRows(rt, outbox)), hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
    expect(rows.map(hex)).toEqual(og.map((x) => hex(ogEncodeBuffer(x, { omitSymbolKeys: true }))));
    expect(sig0x(unwrap(runtimeOutputsDigest(rows)))).toBe(ogOutputRows(1, og as never).commitment.digest);
  };
  test("MATCH (randomized): 40 validator sets -- every Entity output (forwarded txs, proposals, precommits, commit notices with og's frame Hanko) encodes as og RoutedEntityInput; the outbox digest equals og prepareRuntimeOutputRows", async () => {
    seed = seedOf(163);
    let notices = 0, lanes = new Set<string>();
    for (let n = 0; n < 40; n++) {
      const pool = [aliceAddr, bobAddr, carolAddr] as Address[], size = 2 + ri(2);
      const members: Members = pool.slice(0, size).map((a) => [a, BigInt(1 + ri(2))] as const);
      const total = members.reduce((t, [, s]) => t + s, 0n), threshold = 1n + BigInt(ri(Number(total)));
      const reps = new Map(members.map(([a]) => [a.toLowerCase(), validator(members, threshold, a)] as const));
      const outbox: EntityOutput[] = [];
      const ceo = String((reps.values().next().value as EntityReplica).state.quorum.proposer).toLowerCase(), other = [...reps.keys()].find((k) => k !== ceo) as string;
      for (let k = 1, frames = 1 + ri(3); k <= frames; k++) {
        // a non-leader forwards its mempool to the leader; the leader proposes
        const first = rng() < 0.3 ? other : ceo;
        const queue: [string, EntityInput][] = [[first, { kind: "txs", timestamp: NOW + BigInt(k), txs: Array.from({ length: 1 + ri(2) }, (_, i) => ({ type: "chat", data: { from: first, message: `m${n}.${k}.${i}` } }) as EntityTx) }]];
        for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
          const [s, input] = next, r = reps.get(s);
          if (r === undefined) continue;
          const applied = applyEntityInputRw(r, input, { ...verifiers, self: r.state.id, signerId: s as Address });
          if (!applied.ok && applied.error._tag === "precommit_not_active") continue;
          const out = unwrap(applied);
          reps.set(s, out.replica);
          for (const o of out.outputs) {
            const marked = rng() < 0.15 ? { ...o, atomicCrossJurisdictionPair: { phase: pick(["proposal", "ack"] as const), pairKey: `k${ri(9)}` } } : o;
            outbox.push(marked);
            if ("input" in o) { queue.push([o.signerId.toLowerCase(), o.input]); lanes.add(o.input.kind); if (o.input.kind === "proposal" && o.input.hankos !== undefined) notices += 1; }
          }
        }
      }
      let rt = createRuntime();
      for (const r of reps.values()) rt = spawn(rt, r);
      const state = (reps.get(ceo) as EntityReplica).state;
      await expectRows(rt, outbox, () => state, () => { throw new Error("no account output"); });
    }
    expect([...lanes].sort()).toEqual(["precommit", "proposal", "txs"]);
    expect(notices).toBeGreaterThan(20);
  }, 120_000);
  test("MATCH: timeout votes with prepared frames and an Account message bound to the receiving replica's active leader (og resolveEntityProposerId) encode as og RoutedEntityInput", async () => {
    const members: Members = [[aliceAddr as Address, 1n], [bobAddr as Address, 1n], [carolAddr as Address, 1n]];
    const [a, b, c] = members.map(([s]) => s.toLowerCase()) as [string, string, string];
    const reps = new Map(members.map(([s]) => [s.toLowerCase(), validator(members, 3n, s)] as const));
    const ctxOf = (s: string) => ({ ...verifiers, self: (reps.get(s) as EntityReplica).state.id, signerId: s as Address });
    const ceo = unwrap(applyEntityInputRw(reps.get(a) as EntityReplica, { kind: "txs", timestamp: NOW, txs: [{ type: "chat", data: { from: a, message: "held" } } as EntityTx] }, ctxOf(a)));
    for (const o of ceo.outputs) if ("input" in o) { const s = o.signerId.toLowerCase(); reps.set(s, unwrap(applyEntityInputRw(reps.get(s) as EntityReplica, o.input, ctxOf(s))).replica); }
    const outbox: EntityOutput[] = [];
    for (const s of [b, c]) {
      const vote = localTimeoutVote(reps.get(s) as EntityReplica, NOW + 10_000n);
      if (vote === undefined) throw new Error("no vote");
      const out = unwrap(applyEntityInputRw(reps.get(s) as EntityReplica, vote, ctxOf(s)));
      reps.set(s, out.replica);
      outbox.push(...out.outputs);
    }
    expect(outbox.filter((o) => "input" in o && o.input.kind === "leaderTimeoutVote" && o.input.vote.preparedFrame !== undefined).length).toBe(4);
    let rt = createRuntime();
    for (const r of reps.values()) rt = spawn(rt, r);
    await expectRows(rt, outbox, () => (reps.get(a) as EntityReplica).state, () => { throw new Error("no account output"); });
    // an Account opening from solo ALICE to solo BOB: the Account message binds BOB's active leader
    const solo = (id: EntityId, signer: string) => unwrap(createEntity({ id, jurisdiction: TERMS.domain, threshold: 1n, members: new Map([[signer as Address, { shares: 1n }]]), signerId: signer as Address, jurisdictionConfig: UNREGISTERED_J }));
    const ab = spawn(spawn(createRuntime(), solo(ALICE, aliceAddr)), solo(BOB, bobAddr));
    const open: EntityTx = { type: "openAccount", data: { targetEntityId: BOB, accountDomain: { ...TERMS.domain }, watchSeed: TERMS.watchSeed, disputeConfig: { ...TERMS.disputeConfig } } } as EntityTx;
    const step = unwrap(applyRuntime(ab, { runtimeTxs: [], entityInputs: [{ entityId: ALICE, signerId: aliceAddr, input: { kind: "txs", timestamp: NOW, txs: [open] } }] }, verifiers));
    const accountOut = step.outbox.filter((o) => !("input" in o));
    expect(accountOut.length).toBe(1);
    await expectRows(step.runtime, step.outbox, () => (step.runtime.entities.values().next().value as EntityReplica).state, (to) => (to === BOB ? bobAddr.toLowerCase() : ""));
  });
});
