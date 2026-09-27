import { describe, expect, test } from "bun:test";
import { seedOf, seedTag } from "./seed.ts";
import { x25519 } from "@noble/curves/ed25519";
import { getEntityLeaderOrder, getEntityLeaderState } from "../../core/entity/consensus/leader/index.ts";
import { calculateQuorumPower, isSingleSignerBoard } from "../../core/entity/consensus/replica-validation.ts";
import { validateConsensusConfig } from "../../core/entity/consensus/config-validation.ts";
import { buildEntityFrameAuthority, computeCanonicalEntityConsensusStateHash, computeEntityAccountValueHash, computeEntityFrameAuthorityRoot } from "../../core/entity/consensus/state-root.ts";
import { PersistentEntityAccountMap } from "../../core/entity/state/persistent-account-map.ts";
import { PersistentEntityCollectionMap } from "../../core/entity/state/persistent-collection-map.ts";
import { initCrontab } from "../../core/entity/scheduler/index.ts";
import { buildEntityHashesToSign } from "../../core/entity/consensus/input/hanko-witness.ts";
import { computeEntityProfileHash } from "../../core/entity/profile/profile-descriptor.ts";
import { createEntityFrameHashFromStateRoot } from "../../core/entity/consensus/frame.ts";
import { appendEntityMempoolTransactions } from "../../core/entity/consensus/input/admission.ts";
import {
  address, allowedProposer, applyEntityInput as applyEntityInputAt, applyRuntime, convertOutput, createEntity, createRuntime, entityRootOf, entityStateRoot,
  commitRuntimeFrame, entityId, hashEntityFrame, hashEntityState, isSingleSigner, quorumBoardHash, leaderOrder, recoverRuntime, replicaKey, spawn, signature, tokenId, ZERO_WORD,
  type Address, type EntityCommitted, type EntityFrame, type EntityId, type EntityInput, type EntityOutput, type EntityReplica, type EntityTx, type Precommits, type Signature,
} from "../xln.ts";
import { ALICE, BOB, CAROL, NOW, TERMS, TOKEN, ackInput, aliceAddr, genesisAB, bobAddr, carolAddr, proposeInput, signEntityFrame, signManifestAs, unwrap, unwrapErr, verifiers } from "../xln_run.ts";

const A = aliceAddr; // lexicographically lower (anvil-keyed: og quorum Hankos need real signatures)
const B = bobAddr; // lexicographically higher
const C = carolAddr;
const JUR = TERMS.domain;
const ogConfig = (validators: readonly string[], shares: Record<string, bigint>, threshold: bigint) =>
  ({ mode: "proposer-based" as const, threshold, validators: [...validators], shares });
/** og assertQuorumBoardBinding: an Entity without a certified board registry signs only as its lazy id (the hash of its own board). */
const lazyId = (members: readonly (readonly [Address, bigint])[], threshold: bigint): EntityId => unwrap(entityId(quorumBoardHash({ _tag: "teaching", threshold, members: new Map(members.map(([a, s]) => [a, { shares: s }])) })));
const teaching = (members: readonly (readonly [Address, bigint])[], threshold: bigint, signerId?: Address) =>
  unwrap(createEntity({ id: lazyId(members, threshold), jurisdiction: JUR, threshold, members: new Map(members.map(([a, s]) => [a, { shares: s }])), ...(signerId === undefined ? {} : { signerId }) }));
const ctx = (signerId: Address, extra: Partial<{ from: EntityId }> = {}) => ({ ...verifiers, self: ALICE, signerId, ...extra });
/** The fixture ctx names ALICE (the 1-of-1 lazy id); a multi-signer fixture Entity is its own lazy board id, so that placeholder resolves to the replica. */
const applyEntityInput: typeof applyEntityInputAt = (r, input, c) => applyEntityInputAt(r, input, c.self === ALICE ? { ...c, self: r.state.id } : c);
const openTo = (target: EntityId, extra: Record<string, unknown> = {}): EntityTx =>
  ({ type: "openAccount", data: { targetEntityId: target, accountDomain: { ...TERMS.domain }, watchSeed: TERMS.watchSeed, disputeConfig: { ...TERMS.disputeConfig }, ...extra } }) as EntityTx;
const open = openTo(BOB);
const txs = (list: readonly EntityTx[], timestamp = 1n): EntityInput => ({ kind: "txs", timestamp, txs: list });
const propose = (r: EntityReplica, signer: Address, list: readonly EntityTx[] = [open], timestamp = 1n) => applyEntityInput(r, txs(list, timestamp), ctx(signer));
const held = (r: EntityReplica): EntityFrame => { if (r._tag === "open") throw new Error("no frame"); return r.frame; };
const precommitOf = (frame: EntityFrame, signer: Address, sigs: readonly Signature[] = signManifestAs(frame, signer)): EntityInput =>
  ({ kind: "precommit", height: frame.height, frameHash: unwrap(hashEntityFrame(frame)), signatures: new Map([[signer.toLowerCase(), sigs]]) });
const consensusFor = (outputs: readonly EntityOutput[], signer: Address): EntityInput[] =>
  outputs.flatMap((o) => ("input" in o && o.signerId.toLowerCase() === signer.toLowerCase() ? [o.input] : []));

// og replica rng for randomized comparisons
let seed = seedOf(7);
const rng = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const ri = (n: number): number => Math.floor(rng() * n);
const addr = (i: number) => unwrap(address(`0x${(i + 16).toString(16).padStart(2, "0").repeat(20)}`));

describe(seedTag("entity-runtime: proposer selection (ER-1, ER-3)"), () => {
  test("MATCH: og proposer = validators[0] (positional CEO) for validators [B,A]; A's replica forwards its mempool to B", () => {
    const og = getEntityLeaderState({ entityId: ALICE, height: 0, prevFrameHash: "", config: ogConfig([B, A], { [B]: 1n, [A]: 1n }, 2n) } as never);
    expect(og.activeValidatorId).toBe(B);
    const rw = teaching([[B, 1n], [A, 1n]], 2n);
    expect(allowedProposer(rw.state.quorum)).toBe(B);
    expect(rw.signerId).toBe(B);
    expect(unwrap(propose(rw, B)).replica._tag).toBe("proposed");
    const validatorA = teaching([[B, 1n], [A, 1n]], 2n, A);
    const forwarded = unwrap(propose(validatorA, A));
    expect(forwarded.replica._tag).toBe("open");
    expect(forwarded.replica.mempool).toEqual([open]);
    expect(forwarded.outputs).toEqual([{ to: validatorA.state.id, signerId: B, input: txs([open]) }]);
  });
  test("MATCH: 40 random boards -- leader is og getEntityLeaderState(config).activeValidatorId", () => {
    for (let i = 0; i < 40; i++) {
      const n = 1 + ri(4), ids = [...new Set(Array.from({ length: n }, () => ri(8)))].map(addr), shares = ids.map(() => BigInt(1 + ri(5)));
      const total = shares.reduce((a, b) => a + b, 0n), threshold = 1n + BigInt(ri(Number(total)));
      const rw = teaching(ids.map((a, j) => [a, shares[j] ?? 1n] as const), threshold);
      const og = getEntityLeaderState({ entityId: ALICE, height: 0, prevFrameHash: "", config: ogConfig(ids, Object.fromEntries(ids.map((a, j) => [a, shares[j] ?? 1n])), threshold) } as never);
      expect(allowedProposer(rw.state.quorum).toLowerCase()).toBe(og.activeValidatorId);
      expect(isSingleSigner(rw.state.quorum)).toBe(isSingleSignerBoard(ogConfig(ids, Object.fromEntries(ids.map((a, j) => [a, shares[j] ?? 1n])), threshold)));
    }
  });
  test("MATCH (ER-18): og failover order sorts successors by shares desc (view change: diff/entity-consensus-2.test.ts)", () => {
    expect(getEntityLeaderOrder(ogConfig([B, A, C], { [B]: 1n, [A]: 1n, [C]: 5n }, 2n))).toEqual([B, C, A]);
    expect(leaderOrder(teaching([[B, 1n], [A, 1n], [C, 5n]], 2n).state.quorum)).toEqual([B, C, A]);
  });
  test("MATCH: runtime convertOutput routes an Account message to the receiver's validators[0]; a consensus output to its named validator", () => {
    const receiver = unwrap(createEntity({ id: BOB, jurisdiction: JUR, threshold: 2n, members: new Map([[B, { shares: 1n }], [A, { shares: 1n }]]) }));
    const rt = spawn(createRuntime(), receiver);
    expect([...rt.entities.keys()]).toEqual([replicaKey(BOB, B)]);
    const message = { to: BOB, tx: { type: "accountInput", data: {} } } as unknown as EntityOutput;
    const routed = unwrap(convertOutput(rt, message, ALICE, 1n));
    expect(routed.signerId).toBe(B);
    expect(getEntityLeaderState({ entityId: BOB, height: 0, prevFrameHash: "", config: ogConfig([B, A], { [B]: 1n, [A]: 1n }, 2n) } as never).activeValidatorId).toBe(B);
    const consensus = unwrap(convertOutput(rt, { to: BOB, signerId: A, input: txs([]) }, BOB, 1n));
    expect(consensus).toEqual({ entityId: BOB, signerId: A, input: txs([]) });
  });
});

describe(seedTag("entity-runtime: authority root (ER-2, H16)"), () => {
  test("MATCH: frame authorityRoot == og computeEntityFrameAuthorityRoot for 40 random positional validator sets", () => {
    for (let i = 0; i < 40; i++) {
      const ids = [0, 1, 2, 3, 4, 5, 6, 7].sort(() => rng() - 0.5).slice(0, 2 + ri(3)).map(addr), shares = ids.map(() => BigInt(1 + ri(0xffff)));
      const threshold = 1n + BigInt(ri(Math.min(0xffff, Number(shares.reduce((a, b) => a + b, 0n)))));
      const p = unwrap(propose(teaching(ids.map((a, j) => [a, shares[j] ?? 1n] as const), threshold), ids[0] ?? A));
      const og = computeEntityFrameAuthorityRoot(buildEntityFrameAuthority({ config: ogConfig(ids, Object.fromEntries(ids.map((a, j) => [a, shares[j] ?? 1n])), threshold) } as never));
      expect(held(p.replica).authorityRoot).toBe(og);
    }
  });
  test("MATCH: [B,A] commits positional order (leader B), never the sorted one", () => {
    const p = unwrap(propose(teaching([[B, 1n], [A, 1n]], 2n), B));
    const og = computeEntityFrameAuthorityRoot(buildEntityFrameAuthority({ config: ogConfig([B, A], { [B]: 1n, [A]: 1n }, 2n) } as never));
    expect(held(p.replica).authorityRoot).toBe(og);
    expect(og).not.toBe(computeEntityFrameAuthorityRoot(buildEntityFrameAuthority({ config: ogConfig([A, B], { [A]: 1n, [B]: 1n }, 2n) } as never)));
  });
});

// og EntityState for the same logical content; og collections on the og side, their committed (radix) form on the rewrite side
const EMPTY = { radix: 16 as const, leafCount: 0, root: ZERO_WORD };
const JCONF = { entityProviderAddress: `0x${"EE".repeat(20)}`, registrationBlock: 7, blockTimeMs: 1000 };
const ogJurisdiction = { name: "local", address: "http://127.0.0.1:8545", chainId: JUR.chainId, depositoryAddress: JUR.depositoryAddress, ...JCONF };
/** A real X25519 Entity keypair: og checks the validator's private key against the committed public key on every proposal. */
const KEY_PRIV = `0x${"12".repeat(32)}`, KEY_PUB = `0x${Buffer.from(x25519.getPublicKey(Buffer.from("12".repeat(32), "hex"))).toString("hex")}`;
const committedPair = (i: number): { og: Record<string, unknown>; rw: EntityCommitted } => {
  const nonces = new Map(Array.from({ length: ri(3) }, (_, j) => [`0x${(j + 1).toString(16).padStart(40, "0")}`, ri(9)] as const));
  const reserves = new Map(Array.from({ length: ri(3) }, (_, j) => [j + 1, BigInt(ri(1e9)) * 10n ** 12n] as const));
  const profile = { name: `Entity ${i}`, isHub: rng() < 0.5, avatar: "", bio: "", website: "" };
  const shared = { nonces, proposals: new Map(), reserves, lastFinalizedJHeight: ri(100), profile, entityEncryptionPublicKey: KEY_PUB, swapTradingPairs: [{ pairId: "1/2", baseTokenId: 1, quoteTokenId: 2 }] };
  const feesEarned = BigInt(ri(50));
  return {
    og: { ...shared, paybook: { entries: PersistentEntityCollectionMap.empty("paybookHashlock"), feesEarned }, crontabState: initCrontab(), deferredAccountProposals: PersistentEntityCollectionMap.empty(), crossJurisdictionBookAdmissions: PersistentEntityCollectionMap.empty() },
    rw: { ...shared, paybook: { entries: EMPTY, feesEarned }, crontabState: { tasks: initCrontab().tasks as never, hooks: EMPTY }, deferredAccountProposals: EMPTY, crossJurisdictionBookAdmissions: EMPTY },
  };
};
const ogEntityState = (r: EntityReplica, committed: Record<string, unknown>, jurisdiction?: unknown): any => {
  const members = [...(r.state.quorum._tag === "teaching" ? r.state.quorum.members : new Map())];
  return {
    entityId: r.state.id, height: Number(r.state.height), timestamp: Number(r.state.timestamp),
    config: { mode: "proposer-based", threshold: r.state.quorum._tag === "teaching" ? r.state.quorum.threshold : 0n, validators: members.map(([a]) => a), shares: Object.fromEntries(members.map(([a, m]) => [a, m.shares])), ...(jurisdiction === undefined ? {} : { jurisdiction }) },
    accounts: PersistentEntityAccountMap.fromEntries([], r.state.id, computeEntityAccountValueHash), ...committed,
  };
};

describe(seedTag("entity-runtime: entity state root commits every og field (H6)"), () => {
  test("MATCH: 30 random og-shaped EntityStates (entityId, height, timestamp, config+jurisdiction, nonces, reserves, profile, paybook, crontab, ...) == og computeCanonicalEntityConsensusStateHash", () => {
    for (let i = 0; i < 30; i++) {
      const { og, rw } = committedPair(i), withJ = rng() < 0.5;
      const ids = [...new Set([ri(8), ri(8)])].map(addr);
      const base = unwrap(createEntity({ id: ALICE, jurisdiction: JUR, threshold: 1n, members: new Map(ids.map((a) => [a, { shares: 1n }])), committed: rw, timestamp: BigInt(1_700_000_000_000 + ri(1e6)), ...(withJ ? { jurisdictionConfig: JCONF } : {}) }));
      const r = { ...base, state: { ...base.state, height: BigInt(ri(50)) } };
      expect(unwrap(entityRootOf(r.state, r.accountReplicas))).toBe(computeCanonicalEntityConsensusStateHash(ogEntityState(r, og, withJ ? ogJurisdiction : undefined)));
    }
  });
  test("MATCH: each og section moves the root on both sides; a field outside og's allowlist moves neither", () => {
    const r = teaching([[A, 1n]], 1n), og = ogEntityState(r, { paybook: { entries: PersistentEntityCollectionMap.empty("paybookHashlock"), feesEarned: 0n } });
    const rootRw = (committed: EntityCommitted) => unwrap(entityRootOf({ ...r.state, committed }, r.accountReplicas));
    expect(rootRw({})).toBe(computeCanonicalEntityConsensusStateHash(og));
    for (const [field, value] of [["reserves", new Map([[1, 5n]])], ["lastFinalizedJHeight", 42], ["profile", { name: "x" }], ["paybook", { entries: EMPTY, feesEarned: 12n }]] as const) {
      const ogValue = field === "paybook" ? { entries: PersistentEntityCollectionMap.empty("paybookHashlock"), feesEarned: 12n } : value;
      expect(rootRw({ [field]: value as never })).toBe(computeCanonicalEntityConsensusStateHash({ ...og, [field]: ogValue }));
      expect(rootRw({ [field]: value as never })).not.toBe(rootRw({}));
    }
    expect(rootRw({ notAField: 1 })).toBe(rootRw({}));
    expect(computeCanonicalEntityConsensusStateHash({ ...og, notAField: 1 })).toBe(computeCanonicalEntityConsensusStateHash(og));
  });
  test("MATCH: the minimal {config, accounts} input keeps the frozen goldens (backward compatible)", () => {
    const signer = `0x${"01".repeat(20)}`;
    expect(unwrap(entityStateRoot({ config: ogConfig([signer], { [signer]: 1n }, 1n), accounts: [] }))).toBe("0x1a37f4d778a6abc66ac52c98367338a4d7dd3d9f92f2f365305a7154bfc6b9a4");
  });
  test("MATCH: a proposed frame's stateRoot is og's root of the proposal state (height+1, frame timestamp, og crontab default) and its hash is og's frame hash", () => {
    const { og, rw } = committedPair(99);
    const { crontabState: _c, ...rwNoCron } = rw, { crontabState: _o, ...ogNoCron } = og;
    // og assertFrameJPrefix: every frame of a registered Entity needs a J-prefix certificate (runtime-final.test.ts), so this frame is an unregistered Entity's
    const { registrationBlock: _registered, ...unregistered } = JCONF, { registrationBlock: _ogRegistered, ...ogUnregistered } = ogJurisdiction;
    const r = unwrap(createEntity({ id: lazyId([[A, 1n], [B, 1n]], 2n), jurisdiction: JUR, threshold: 2n, members: new Map([[A, { shares: 1n }], [B, { shares: 1n }]]), committed: rwNoCron, timestamp: 50n, jurisdictionConfig: { ...unregistered, name: ogJurisdiction.name } }));
    const credit: EntityTx = { type: "extendCredit", data: { counterpartyEntityId: CAROL, tokenId: unwrap(tokenId("1")), amount: 5n } }; // no account: og no-op
    const p = unwrap(applyEntityInput(r, txs([credit], 40n), { ...ctx(A), htlc: { profiles: [], encryptionPrivateKey: KEY_PRIV } }));
    const frame = held(p.replica);
    expect(frame.timestamp).toBe(50n); // og resolveEntityProposalTimestamp = max(runtime, committed)
    const ogState = { ...ogEntityState({ ...r, state: { ...r.state, height: 1n, timestamp: 50n } }, { ...ogNoCron, crontabState: initCrontab() }, ogUnregistered), leaderState: { activeValidatorId: A.toLowerCase(), view: 0, changedAtHeight: 0 } }; // og proposal state records the proposer's leaderState
    expect(frame.stateRoot).toBe(computeCanonicalEntityConsensusStateHash(ogState));
    const ogTxs = [{ type: "extendCredit", data: { counterpartyEntityId: CAROL, tokenId: 1, amount: 5n } }];
    const ogHash = createEntityFrameHashFromStateRoot("genesis", 1, 50, ogTxs as never, [], r.state.id, frame.stateRoot, frame.authorityRoot, frame.entityContext as never);
    expect<string>(unwrap(hashEntityFrame(frame))).toBe(ogHash);
    // og appendFinalProfileHash: the genesis frame always signs the profile descriptor hash
    const profile = computeEntityProfileHash(ogState as never);
    expect<readonly unknown[]>(frame.hashesToSign).toEqual(buildEntityHashesToSign(r.state.id, 1, ogHash, [{ hash: profile, type: "profile", context: `profile:${profile}` }]));
  });
});

describe(seedTag("entity-runtime: quorum, precommits and commit (ER-4, ER-5, ER-8, ER-9)"), () => {
  test("MATCH: threshold is >= over summed shares; B's manifest precommit completes [A,B] 2-of-2", () => {
    const cfg = ogConfig([A, B], { [A]: 1n, [B]: 1n }, 2n);
    expect(calculateQuorumPower(cfg, [A]) >= cfg.threshold).toBe(false);
    expect(calculateQuorumPower(cfg, [A, B]) >= cfg.threshold).toBe(true);
    const p = unwrap(propose(teaching([[A, 1n], [B, 1n]], 2n), A));
    const r = p.replica;
    if (r._tag !== "proposed") throw new Error("phase");
    expect([...r.signatures.keys()]).toEqual([A.toLowerCase()]); // og collectedSigs starts with the proposer's own manifest
    expect(consensusFor(p.outputs, B)).toEqual([{ kind: "proposal", frame: r.frame, signatures: r.signatures }]);
    const two = unwrap(applyEntityInput(r, precommitOf(r.frame, B), ctx(A)));
    expect(two.replica._tag).toBe("open");
    expect(two.replica.state.accounts.has(BOB)).toBe(true);
    expect(consensusFor(two.outputs, B)[0]?.kind).toBe("proposal"); // og broadcastCommit
  });
  test("MATCH: shares weighting -- one heavy validator's precommit reaches threshold", () => {
    const p = unwrap(propose(teaching([[A, 1n], [B, 3n]], 3n), A));
    expect(unwrap(applyEntityInput(p.replica, precommitOf(held(p.replica), B), ctx(A))).replica._tag).toBe("open");
  });
  test("MATCH (og proposal/start.ts:611): a single-signer board self-signs and commits inside the proposing input", () => {
    expect(isSingleSignerBoard(ogConfig([A], { [A]: 1n }, 1n))).toBe(true);
    const p = unwrap(propose(teaching([[A, 1n]], 1n), A));
    expect(p.replica._tag).toBe("open");
    expect(p.replica.head.height).toBe(1n);
    expect(p.replica.state.accounts.has(BOB)).toBe(true);
    expect(p.replica.mempool).toEqual([]);
  });
  test("MATCH: a proposer whose own share reaches quorum (not single-signer) waits for the next input, then installs (og handleHashPrecommits runs on every input)", () => {
    const p = unwrap(propose(teaching([[A, 3n], [B, 1n]], 3n), A));
    expect(p.replica._tag).toBe("proposed");
    expect(unwrap(applyEntityInput(p.replica, txs([]), ctx(A))).replica._tag).toBe("open");
  });
  test("MATCH (og verifyHashPrecommitSignatures): one signature per manifest entry; a short bundle or a non-validator is refused", () => {
    const p = unwrap(propose(teaching([[A, 1n], [B, 1n]], 2n), A)), frame = held(p.replica);
    expect(unwrapErr(applyEntityInput(p.replica, precommitOf(frame, B, []), ctx(A)))._tag).toBe("invalid_signature");
    expect(unwrapErr(applyEntityInput(p.replica, precommitOf(frame, C), ctx(A)))._tag).toBe("unknown_member");
    expect(unwrapErr(applyEntityInput(p.replica, { ...precommitOf(frame, B), height: 2n } as EntityInput, ctx(A)))._tag).toBe("precommit_frame_mismatch");
  });
  test("MATCH (og uint16 caps): 60 random configs -- createEntity accepts exactly what og validateConsensusConfig accepts", () => {
    for (let i = 0; i < 60; i++) {
      const pickN = (): bigint => [0n, 1n, 2n, 0xfffen, 0xffffn, 0x10000n, 70_000n][ri(7)] ?? 1n;
      const ids = [...new Set([ri(6), ri(6)])].map(addr), shares = ids.map(pickN), threshold = pickN();
      const ogOk = (() => { try { validateConsensusConfig(ogConfig(ids, Object.fromEntries(ids.map((a, j) => [a, shares[j] ?? 1n])), threshold)); return true; } catch { return false; } })();
      const rw = createEntity({ id: ALICE, jurisdiction: JUR, threshold, members: new Map(ids.map((a, j) => [a, { shares: shares[j] ?? 1n }])) });
      expect(rw.ok).toBe(ogOk);
    }
    expect(() => validateConsensusConfig(ogConfig([A], { [A]: 70_000n }, 70_000n))).toThrow(/uint16/);
    expect(unwrapErr(createEntity({ id: ALICE, jurisdiction: JUR, threshold: 70_000n, members: new Map([[A, { shares: 70_000n }]]) }))._tag).toBe("bad_quorum");
  });
  test("MATCH (og PRECOMMIT_SIGNER_EQUIVOCATION): a second different bundle from the same signer is refused", () => {
    const anySig = { ...verifiers, verifyMember: () => true };
    const p = unwrap(propose(teaching([[A, 1n], [B, 1n], [C, 1n]], 3n), A)), frame = held(p.replica);
    const n = frame.hashesToSign.length, sigs = (x: string) => Array.from({ length: n }, () => unwrap(signature(x)));
    const first = unwrap(applyEntityInput(p.replica, precommitOf(frame, B, sigs("aa")), { ...anySig, self: ALICE, signerId: A }));
    expect(first.replica._tag).toBe("proposed");
    expect(unwrapErr(applyEntityInput(first.replica, precommitOf(frame, B, sigs("bb")), { ...anySig, self: ALICE, signerId: A }))._tag).toBe("precommit_signer_equivocation");
    expect(unwrap(applyEntityInput(first.replica, precommitOf(frame, B, sigs("aa")), { ...anySig, self: ALICE, signerId: A })).replica._tag).toBe("proposed");
  });
  test("MATCH (og precommit-input.ts:140): a precommit for the head height is PRECOMMIT_FRAME_NOT_ACTIVE; for an older height a no-op", () => {
    const r = teaching([[A, 1n], [B, 1n], [C, 1n]], 2n);
    const p = unwrap(propose(r, A)), frame1 = held(p.replica);
    const c1 = unwrap(applyEntityInput(p.replica, precommitOf(frame1, B), ctx(A)));
    expect(c1.replica._tag).toBe("open");
    const late = precommitOf(frame1, C);
    expect(unwrapErr(applyEntityInput(c1.replica, late, ctx(A)))._tag).toBe("precommit_not_active");
    const p2 = unwrap(applyEntityInput(c1.replica, txs([openTo(CAROL)], 2n), ctx(A)));
    const c2 = unwrap(applyEntityInput(p2.replica, precommitOf(held(p2.replica), B), ctx(A)));
    expect(c2.replica.head.height).toBe(2n);
    const noop = unwrap(applyEntityInput(c2.replica, late, ctx(A)));
    expect(noop.replica).toBe(c2.replica);
    expect(noop.outputs).toEqual([]);
  });
  test("MATCH: signer ids are case-insensitive (og trim+lowercase) for the replica address and precommit bundle keys", () => {
    const p = unwrap(propose(teaching([[A, 1n], [B, 1n]], 2n), A)), frame = held(p.replica);
    const upper = { ...precommitOf(frame, B), signatures: new Map([[B.toUpperCase().replace("0X", "0x"), signManifestAs(frame, B)]]) } as EntityInput;
    expect(unwrap(applyEntityInput(p.replica, upper, ctx(A.toUpperCase().replace("0X", "0x") as Address))).replica._tag).toBe("open");
  });
});

describe(seedTag("entity-runtime: validator replay (ER-6)"), () => {
  const board = (signer: Address) => teaching([[A, 1n], [B, 1n]], 2n, signer);
  test("MATCH: proposer -> proposal -> validator replays, signs, locks, reaches quorum, commits and broadcasts; both replicas end on the same state", () => {
    const leader = unwrap(propose(board(A), A, [open], 5n));
    const [proposal] = consensusFor(leader.outputs, B);
    if (proposal === undefined) throw new Error("no proposal");
    const validator = unwrap(applyEntityInput(board(B), proposal, ctx(B)));
    expect(validator.replica._tag).toBe("open"); // A's + B's signatures reach 2 of 2 in this same input
    const [precommit] = consensusFor(validator.outputs, A);
    const commitNote = consensusFor(validator.outputs, A)[1];
    expect(precommit?.kind).toBe("precommit");
    expect(commitNote?.kind).toBe("proposal");
    const leaderDone = unwrap(applyEntityInput(leader.replica, precommit as EntityInput, ctx(A)));
    expect(leaderDone.replica._tag).toBe("open");
    expect(hashEntityState(leaderDone.replica.state)).toBe(hashEntityState(validator.replica.state));
    expect(leaderDone.replica.head).toEqual(validator.replica.head);
    // og COMMIT_ALREADY_APPLIED: the late commit notices are no-ops on both sides
    expect(unwrap(applyEntityInput(leaderDone.replica, commitNote as EntityInput, ctx(A))).replica).toBe(leaderDone.replica);
    const back = consensusFor(leaderDone.outputs, B)[0];
    expect(unwrap(applyEntityInput(validator.replica, back as EntityInput, ctx(B))).replica).toBe(validator.replica);
  });
  test("MATCH: a 3-validator board -- the validator locks below quorum and a commit notice with a quorum installs its lock", () => {
    const three = (s: Address) => teaching([[A, 1n], [B, 1n], [C, 1n]], 3n, s);
    const leader = unwrap(propose(three(A), A));
    const vb = unwrap(applyEntityInput(three(B), consensusFor(leader.outputs, B)[0] as EntityInput, ctx(B)));
    expect(vb.replica._tag).toBe("locked");
    const vc = unwrap(applyEntityInput(three(C), consensusFor(leader.outputs, C)[0] as EntityInput, ctx(C)));
    expect(vc.replica._tag).toBe("locked");
    const withB = unwrap(applyEntityInput(leader.replica, consensusFor(vb.outputs, A)[0] as EntityInput, ctx(A)));
    const done = unwrap(applyEntityInput(withB.replica, consensusFor(vc.outputs, A)[0] as EntityInput, ctx(A)));
    expect(done.replica._tag).toBe("open");
    const note = consensusFor(done.outputs, B)[0] as EntityInput;
    const installed = unwrap(applyEntityInput(vb.replica, note, ctx(B)));
    expect(installed.replica._tag).toBe("open");
    expect(hashEntityState(installed.replica.state)).toBe(hashEntityState(done.replica.state));
  });
  test("MATCH (og PROPOSAL_*): a tampered proposal is refused -- recomputed hash, proposer signature, local manifest", () => {
    const leader = unwrap(propose(board(A), A));
    const proposal = consensusFor(leader.outputs, B)[0];
    if (proposal?.kind !== "proposal") throw new Error("no proposal");
    const moved = { ...proposal, frame: { ...proposal.frame, stateRoot: `0x${"ab".repeat(32)}` } };
    expect(unwrapErr(applyEntityInput(board(B), moved, ctx(B)))._tag).toBe("proposal_manifest");
    const resigned = (() => {
      const frame = { ...moved.frame, hashesToSign: [] };
      const h = unwrap(hashEntityFrame(frame));
      const f = { ...frame, hashesToSign: [{ hash: h, type: "entityFrame" as const, context: `entity:${board(B).state.id.slice(-4)}:frame:1` }] };
      return { ...proposal, frame: f, signatures: new Map([[A.toLowerCase(), signManifestAs(f, A)]]) } as EntityInput;
    })();
    expect(unwrapErr(applyEntityInput(board(B), resigned, ctx(B)))._tag).toBe("local_manifest_mismatch");
    const unsigned = { ...proposal, signatures: new Map() as Precommits };
    expect(unwrapErr(applyEntityInput(board(B), unsigned, ctx(B)))._tag).toBe("proposal_signature");
  });
  test("MATCH (og ENTITY_FRAME_TIMESTAMP_REGRESSION): a validator refuses a frame older than its committed clock", () => {
    const later = unwrap(createEntity({ id: lazyId([[A, 1n], [B, 1n]], 2n), jurisdiction: JUR, threshold: 2n, members: new Map([[A, { shares: 1n }], [B, { shares: 1n }]]), signerId: B, timestamp: 100n }));
    const leader = unwrap(propose(board(A), A, [open], 50n));
    expect(unwrapErr(applyEntityInput(later, consensusFor(leader.outputs, B)[0] as EntityInput, ctx(B)))._tag).toBe("frame_timestamp_regression");
  });
});

describe(seedTag("entity-runtime: mempool (ER-10, ER-21)"), () => {
  test("MATCH (og admission): txs arriving while a frame is proposed are queued and proposed after the commit", () => {
    const p = unwrap(propose(teaching([[A, 1n], [B, 1n]], 2n), A));
    const queued = unwrap(propose(p.replica, A, [openTo(CAROL)]));
    expect(queued.replica._tag).toBe("proposed");
    expect(queued.replica.mempool).toEqual([open, openTo(CAROL)]); // og keeps in-flight txs until they install
    const done = unwrap(applyEntityInput(queued.replica, precommitOf(held(queued.replica), B), ctx(A)));
    expect(done.replica.mempool).toEqual([openTo(CAROL)]);
    const next = unwrap(applyEntityInput(done.replica, txs([]), ctx(A)));
    expect(held(next.replica).txs).toEqual([openTo(CAROL)]);
  });
  test("MATCH (og appendEntityMempoolTransactions): exact accountInput retries collapse, other txs keep multiplicity", () => {
    const ai = { type: "accountInput", data: { kind: "ack", fromEntityId: BOB, toEntityId: ALICE, x: 1 } } as unknown as EntityTx;
    const credit: EntityTx = { type: "extendCredit", data: { counterpartyEntityId: BOB, tokenId: unwrap(tokenId("1")), amount: 1n } };
    const r = teaching([[B, 1n], [A, 1n]], 2n, A);
    const once = unwrap(applyEntityInput(r, txs([ai, credit, ai, credit]), ctx(A)));
    expect(once.replica.mempool).toEqual(appendEntityMempoolTransactions([], [ai, credit, ai, credit] as never) as never);
    expect(once.replica.mempool.length).toBe(3);
  });
  test("MATCH: a peer may deliver several Account inputs in one entity input; each must name the peer as sender", () => {
    const r = teaching([[B, 1n], [A, 1n]], 2n, A);
    const ai = (from: EntityId) => ({ type: "accountInput", data: { kind: "ack", fromEntityId: from, toEntityId: r.state.id, height: 1n } }) as unknown as EntityTx;
    expect(unwrap(applyEntityInput(r, txs([ai(BOB), { ...ai(BOB), data: { ...ai(BOB).data, height: 2n } } as EntityTx]), ctx(A, { from: BOB }))).replica.mempool.length).toBe(2);
    expect(unwrapErr(applyEntityInput(r, txs([ai(BOB), ai(CAROL)]), ctx(A, { from: BOB })))._tag).toBe("from_not_converted");
  });
});

describe(seedTag("entity-runtime: entity tx fold (ER-7, ER-12, ER-13, ER-14)"), () => {
  test("MATCH (og evict-and-retry): only the refused tx leaves the frame; the rest commits", () => {
    const bad: EntityTx = { type: "directPayment", data: { targetEntityId: CAROL, tokenId: unwrap(tokenId("1")), amount: 5n, route: [ALICE, CAROL], deliveryMode: "direct" } };
    const p = unwrap(propose(teaching([[A, 1n]], 1n), A, [open, bad]));
    expect(p.replica._tag).toBe("open");
    expect(p.replica.state.accounts.has(BOB)).toBe(true);
    expect(p.replica.mempool).toEqual([]);
    expect(unwrapErr(propose(teaching([[A, 1n]], 1n), A, [bad]))._tag).toBe("no_such_account");
  });
  test("MATCH (og OPEN_ACCOUNT_ALREADY_EXISTS, a plain Error): a duplicate openAccount refuses the whole input", () => {
    expect(unwrapErr(propose(teaching([[A, 1n]], 1n), A, [open, open]))._tag).toBe("account_exists");
  });
  test("MATCH (og open-account.ts:262 + proposePendingAccountFrames): openAccount seeds add_delta for tokenId + [1,3,2] and the credit line; the same Entity frame proposes them as the first Account frame", () => {
    const p = unwrap(propose(teaching([[A, 1n]], 1n), A, [openTo(BOB, { tokenId: unwrap(tokenId("5")), creditAmount: 9n })]));
    const child = p.replica.accountReplicas.get(BOB);
    expect(child?._tag).toBe("proposed");
    expect(child?.mempool).toEqual([]);
    expect(p.outputs.map((o) => ("tx" in o ? o.tx.data.kind : "consensus"))).toEqual(["ack_frame"]);
    const sent = p.outputs[0];
    if (sent === undefined || !("tx" in sent) || sent.tx.data.kind !== "ack_frame") throw new Error("no frame");
    expect(sent.tx.data.frame.height).toBe(1n);
    expect(sent.tx.data.frame.txs.map((t): [string, string | undefined] => [t.type, "tokenId" in t ? t.tokenId : undefined])).toEqual([["add_delta", "5"], ["add_delta", "1"], ["add_delta", "3"], ["add_delta", "2"], ["set_credit_limit", "5"]]);
  });
  test("MATCH (og direct-payment.ts): amount < 1 is a silent no-op, a non-bilateral direct route and a trusted route are refused, a paid hop queues a payment and wakes validators[0]", () => {
    const opened = unwrap(propose(teaching([[A, 1n]], 1n), A)).replica;
    const pay = (amount: bigint, route: readonly EntityId[] = [ALICE, BOB], deliveryMode: "direct" | "trusted" = "direct"): EntityTx => ({ type: "directPayment", data: { targetEntityId: route[route.length - 1] ?? BOB, tokenId: unwrap(tokenId("1")), amount, route, deliveryMode } });
    const zero = unwrap(propose(opened, A, [pay(0n)], 2n));
    expect(zero.replica.head.height).toBe(2n);
    expect(zero.outputs).toEqual([]);
    expect(unwrapErr(propose(opened, A, [pay(5n, [ALICE, BOB, CAROL])], 2n))._tag).toBe("payment_route");
    expect(unwrapErr(propose(opened, A, [pay(5n, [BOB, ALICE])], 2n))._tag).toBe("payment_route");
    // og local-tx-admission.ts queues without validation: an unfunded hop commits the Entity frame and is dropped when the Account frame is proposed
    const unfunded = unwrap(propose(opened, A, [pay(5n)], 2n));
    expect(unfunded.replica.head.height).toBe(2n);
    expect(unfunded.replica.accountReplicas.get(BOB)?.mempool.map((t) => t.type)).toEqual(["payment"]);
    expect(unfunded.outputs).toEqual([{ to: ALICE, signerId: A, input: txs([], 2n) }]);
    const credit: EntityTx = { type: "extendCredit", data: { counterpartyEntityId: BOB, tokenId: unwrap(tokenId("1")), amount: 5n } };
    const extended = unwrap(propose(opened, A, [credit], 2n));
    expect(extended.replica.accountReplicas.get(BOB)?.mempool.at(-1)).toEqual({ type: "set_credit_limit", tokenId: unwrap(tokenId("1")), limit: 5n });
    expect(extended.outputs).toEqual([{ to: ALICE, signerId: A, input: txs([], 2n) }]);
  });
  test("MATCH (og createInboundAccountState): the peer opens its side from the first Account frame; no openAccount output is needed", () => {
    const alice = unwrap(createEntity({ id: ALICE, jurisdiction: JUR, threshold: 1n, members: new Map([[aliceAddr, { shares: 1n }]]) }));
    const bob = unwrap(createEntity({ id: BOB, jurisdiction: JUR, threshold: 1n, members: new Map([[bobAddr, { shares: 1n }]]) }));
    let rt = spawn(spawn(createRuntime(), alice), bob);
    const run = (entityInputs: Parameters<typeof applyRuntime>[1]["entityInputs"]) => { const out = unwrap(applyRuntime(rt, { runtimeTxs: [], entityInputs }, verifiers)); expect(out.rejected).toEqual([]); rt = out.runtime; return out.outbox; };
    // og proposePendingAccountFrames: the openAccount frame itself proposes the first Account frame, Hanko'd through the manifest
    const outbox = run([{ entityId: ALICE, signerId: aliceAddr, input: txs([open], NOW) }]);
    expect(outbox.map((o) => ("tx" in o ? o.tx.data.kind : "consensus"))).toEqual(["ack_frame"]);
    const delivered = outbox.map((o) => unwrap(convertOutput(rt, o, ALICE, NOW + 2n)));
    expect(delivered[0]?.signerId).toBe(bobAddr);
    // og accountInput response: Bob opens the inbound Account, commits the frame and answers with the forced ACK in the same Entity frame
    const back = run(delivered);
    expect(back.map((o) => ("tx" in o ? o.tx.data.kind : "consensus"))).toEqual(["ack"]);
    expect(rt.entities.get(replicaKey(BOB, bobAddr))?.accountReplicas.get(ALICE)?._tag).toBe("open");
    expect(run(back.map((o) => unwrap(convertOutput(rt, o, BOB, NOW + 3n))))).toEqual([]);
    expect(rt.entities.get(replicaKey(ALICE, aliceAddr))?.accountReplicas.get(BOB)?._tag).toBe("open");
  });
  test("MATCH: runtime outbox preserves positional (input, then per-input) order, never sorted", () => {
    const e1 = teaching([[A, 1n]], 1n);
    const opened = unwrap(propose(e1, A, [openTo(CAROL), open])).replica;
    const pay = (to: EntityId): EntityTx => ({ type: "extendCredit", data: { counterpartyEntityId: to, tokenId: unwrap(tokenId("1")), amount: 1n } });
    const rt = spawn(createRuntime(), opened);
    const out = unwrap(applyRuntime(rt, { runtimeTxs: [], entityInputs: [{ entityId: ALICE, signerId: A, input: txs([pay(CAROL), pay(BOB)], 3n) }] }, verifiers));
    expect(out.rejected).toEqual([]);
    expect(out.outbox.length).toBe(2);
    expect(out.outbox.every((o) => "input" in o && o.signerId === A)).toBe(true);
  });
  test("MATCH (ER-25): a refused runtime input never stops the batch; an entity mismatch is 'wrong_entity'", () => {
    const r = teaching([[A, 1n]], 1n);
    expect(unwrapErr(applyEntityInput(r, txs([open]), { ...ctx(A), self: BOB }))._tag).toBe("wrong_entity");
    const rt = spawn(createRuntime(), r);
    // og mergeEntityInputs: two local lanes for one replica collapse into one input, so the duplicate refuses both; a lane from another origin stays
    // apart, but (og createDeferredProposalBatch) both lanes only fill the mempool and the replica proposes once, so the duplicate refuses that frame too.
    const merged = unwrap(applyRuntime(rt, { runtimeTxs: [], entityInputs: [{ entityId: ALICE, signerId: A, input: txs([open, open]) }, { entityId: ALICE, signerId: A, input: txs([open]) }] }, verifiers));
    expect(merged.rejected.map((e) => e._tag)).toEqual(["account_exists"]);
    expect(merged.runtime.entities.get(replicaKey(ALICE, A))?.state.accounts.has(BOB)).toBe(false);
    const out = unwrap(applyRuntime(rt, { runtimeTxs: [], entityInputs: [{ entityId: ALICE, signerId: A, input: txs([open, open]) }, { entityId: ALICE, signerId: A, from: "0x" + "77".repeat(20), input: txs([open]) }] }, verifiers));
    expect(out.rejected.map((e) => e._tag)).toEqual(["account_exists"]);
    expect(out.runtime.entities.get(replicaKey(ALICE, A))?.state.accounts.has(BOB)).toBe(false);
  });
  test("signEntityFrame still signs the entity frame hash (manifest head)", () => {
    const p = unwrap(propose(teaching([[A, 1n], [B, 1n]], 2n), A)), frame = held(p.replica);
    expect(signManifestAs(frame, A)[0]).toBe(signEntityFrame(frame, A));
  });
});

describe(seedTag("entity-runtime: runtime recovery (ER-23)"), () => {
  test("MATCH (og outbox-payload.ts ordered rows): recoverRuntime binds the persisted outbox positionally; a reordered outbox is refused", () => {
    const credit = (to: EntityId): EntityTx => ({ type: "extendCredit", data: { counterpartyEntityId: to, tokenId: unwrap(tokenId("1")), amount: 1n } });
    const alice = unwrap(propose(teaching([[A, 1n]], 1n), A, [open])).replica;
    const bob = unwrap(applyEntityInput(unwrap(createEntity({ id: BOB, jurisdiction: JUR, threshold: 1n, members: new Map([[B, { shares: 1n }]]) })), txs([openTo(ALICE)]), { ...ctx(B), self: BOB })).replica;
    const start = spawn(spawn(createRuntime(), alice), bob);
    const commit = unwrap(commitRuntimeFrame(start, { runtimeTxs: [], entityInputs: [{ entityId: ALICE, signerId: A, input: txs([credit(BOB)], 3n) }, { entityId: BOB, signerId: B, input: txs([credit(ALICE)], 3n) }] }, verifiers));
    if (commit === null) throw new Error("no frame");
    const outbox = commit.outbox;
    expect(outbox.map((o) => o.to)).toEqual([ALICE, BOB]);
    expect(unwrap(recoverRuntime(start, [commit.frame], [commit.applied], outbox, verifiers)).outbox).toEqual(outbox);
    expect(unwrapErr(recoverRuntime(start, [commit.frame], [commit.applied], [...outbox].reverse(), verifiers))).toEqual({ _tag: "runtime_frame", code: "STORAGE_RECOVERY_OUTBOX_MISMATCH" });
  });
});

