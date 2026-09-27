import { describe, expect, test } from "bun:test";
import { lcg31, seedOf, seedTag } from "./seed.ts";
import {
  buildEntityLeaderCertificate, buildEntityLeaderVoteBody, getEntityLeaderOrder, getEntityLeaderState, getEntityLeaderTimeoutMs, getNextEntityFailoverLeader, hashEntityLeaderVoteBody,
} from "../../core/entity/consensus/leader/index.ts";
import { expectedCommittedLeaderState, verifyEntityLeaderCertificate } from "../../core/entity/consensus/leader/certificates.ts";
import { buildEntityFrameAuthority, computeEntityFrameAuthorityRoot } from "../../core/entity/consensus/state-root.ts";
import {
  address, admit, applyAccountInput, certifiedBy, tokenId, type AccountReplica, type BoardRefresh, type BoardRefreshRefusal, type CertifiedBoard, type DoorContext, type EntityId, type HankoAuthority, type ProposedAccount, type Verify,
  entityId, applyEntityInput as applyEntityInputAt, quorumBoardHash, buildLeaderCertificate, quorumHanko, type Hash, createEntity, hashEntityFrame, hashLeaderVote, leaderOrder, leaderStateOf, leaderTimeoutMs, leaderVoteBody, localTimeoutVote, nextFailoverLeader,
  applyRuntime, convertOutput, createRuntime, isLeft, replicaId, replicaKey, spawn, wireTx, type Runtime, type RoutedEntityInput,
  type Address, type EntityFrame, type EntityFrameHash, type EntityInput, type EntityOutput, type EntityReplica, type EntityState, type EntityTx, type LeaderCertificate, type LeaderState, type LeaderVote,
} from "../xln.ts";
import { ALICE, BOB, CAROL, NOW, TERMS, ackInput, aliceAddr, bobAddr, carolAddr, crypto, envelopeAB, genesisAB, hankoVerify, offerOf, partyIn, proposeInput, unwrap, verifiers } from "../xln_run.ts";
import { handleBoardHankoRefresh } from "../../core/account/consensus/incoming/board-hanko-refresh.ts";
import { createEntityFrameHashFromStateRoot } from "../../core/entity/consensus/frame.ts";
import { handleDirectPaymentEntityTx } from "../../core/entity/tx/handlers/payments/direct-payment.ts";
import { handleChatEntityTx, handleChatMessageEntityTx, handleProfileUpdateEntityTx } from "../../core/entity/tx/handlers/system/basic.ts";
import { readEntityFrameEvents } from "../../core/entity/frame-events.ts";
import { handleRequestCollateralEntityTx } from "../../core/entity/tx/handlers/account/lifecycle/admin.ts";
import { buildQuorumHanko, getEntityConfigBoardHash } from "../../core/hanko/signing.ts";
import type { ConsensusConfig } from "../../core/entity/types";
import { consensusBytes, ogAfterCommands, ogAuthored, ogCommandState, wired } from "./og-author.ts";
import { ogOf, withOg } from "./og-state.ts";

// og leader failover (core/entity/consensus/leader/*): view change, timeout votes and certificates (ER-18)
const A = aliceAddr, B = bobAddr, C = carolAddr;
const JUR = TERMS.domain;
// og buildQuorumHanko binds the Hanko to the lazy board of the config (assertQuorumBoardBinding): the Entity id is that board hash
const ENTITY = unwrap(entityId(await getEntityConfigBoardHash({} as never, { threshold: 2n, validators: [A, B, C].map((a) => a.toLowerCase()), shares: Object.fromEntries([A, B, C].map((a) => [a.toLowerCase(), 1n])) })));
let seed = seedOf(11);
const rng = (): number => { seed = lcg31(seed); return seed / 0x7fffffff; };
const ri = (n: number): number => Math.floor(rng() * n);
const addr = (i: number): Address => unwrap(address(`0x${(i + 16).toString(16).padStart(2, "0").repeat(20)}`));
const word = (i: number): string => `0x${(i + 1).toString(16).padStart(64, "0")}`;
/** og assertQuorumBoardBinding: an Entity without a certified registry is its own lazy board id (ENTITY for the 2-of-3 [A,B,C] board). */
const lazyId = (members: readonly (readonly [Address, bigint])[], threshold: bigint): EntityId => unwrap(entityId(quorumBoardHash({ _tag: "teaching", threshold, members: new Map(members.map(([a, s]) => [a, { shares: s }])) })));
/** og admission authors openAccount only under a jurisdiction (og materializeLocallyAuthoredEntityTx); unregistered, so no J-prefix certificate is needed. */
const UNREGISTERED_J = { entityProviderAddress: `0x${"ee".repeat(20)}` };
const teaching = (members: readonly (readonly [Address, bigint])[], threshold: bigint, signerId?: Address) =>
  unwrap(createEntity({ id: lazyId(members, threshold), jurisdiction: JUR, threshold, members: new Map(members.map(([a, s]) => [a, { shares: s }])), jurisdictionConfig: UNREGISTERED_J, ...(signerId === undefined ? {} : { signerId }) }));
const ctx = (signerId: Address) => ({ ...verifiers, self: ENTITY, signerId });
/** The fixture ctx names ENTITY; another fixture board is its own lazy id, so that placeholder resolves to the replica. */
const applyEntityInput: typeof applyEntityInputAt = (r, input, c) => applyEntityInputAt(r, input, c.self === ENTITY ? { ...c, self: r.state.id } : c);
const ogConfigOf = (s: EntityState) => {
  if (s.quorum._tag !== "teaching") throw new Error("teaching");
  const members = [...s.quorum.members];
  // og reads only the stack fields (chain, depository, EntityProvider) of the configured jurisdiction
  const ogJ = (ep: string) => ({ ...s.jurisdiction, entityProviderAddress: ep }) as unknown as ConsensusConfig["jurisdiction"];
  const jurisdiction = s.jurisdictionConfig === undefined ? {} : { jurisdiction: ogJ(s.jurisdictionConfig.entityProviderAddress) };
  return { mode: "proposer-based" as const, threshold: s.quorum.threshold, validators: members.map(([a]) => a.toLowerCase()), shares: Object.fromEntries(members.map(([a, m]) => [a.toLowerCase(), m.shares])), ...jurisdiction };
};
const ogView = (s: EntityState, height: bigint, prevFrameHash: string): any =>
  ({ entityId: s.id, height: Number(height), prevFrameHash, config: ogConfigOf(s), ...(s.leaderState === undefined ? {} : { leaderState: s.leaderState }) });
const ogSig = (s: string): string => (s.startsWith("0x") ? s : `0x${s}`);
const ogCert = (c: LeaderCertificate): any => ({ ...c, votes: new Map([...c.votes].map(([k, s]) => [k, ogSig(s)])) });
const inputsFor = (outputs: readonly EntityOutput[], signer: Address): EntityInput[] => outputs.flatMap((o) => ("input" in o && o.signerId.toLowerCase() === signer.toLowerCase() ? [o.input] : []));
const openBob: EntityTx = { type: "openAccount", data: { targetEntityId: BOB, accountDomain: { ...TERMS.domain }, watchSeed: TERMS.watchSeed, disputeConfig: { ...TERMS.disputeConfig } } };

describe(seedTag("entity-consensus-2: leader order, views and vote bodies (ER-18)"), () => {
  test("MATCH: getEntityLeaderOrder / getEntityLeaderState / getNextEntityFailoverLeader / buildEntityLeaderVoteBody / hashEntityLeaderVoteBody over 60 random configs and leader states", () => {
    for (let i = 0; i < 60; i++) {
      const ids = [...new Set(Array.from({ length: 1 + ri(5) }, () => ri(8)))].map(addr), shares = ids.map(() => BigInt(1 + ri(4)));
      const total = shares.reduce((a, b) => a + b, 0n), threshold = 1n + BigInt(ri(Number(total)));
      const r = teaching(ids.map((a, j) => [a, shares[j] ?? 1n] as const), threshold);
      const order = leaderOrder(r.state.quorum);
      const leaderState: LeaderState | undefined = rng() < 0.3 ? undefined : { activeValidatorId: order[ri(order.length)] ?? "", view: ri(6), changedAtHeight: ri(4) };
      const height = BigInt(ri(4)), prev = height === 0n ? "genesis" : word(i);
      const state: EntityState = { ...r.state, ...(leaderState === undefined ? {} : { leaderState }) };
      const view = ogView(state, height, prev);
      expect(order).toEqual(getEntityLeaderOrder(view.config));
      expect(leaderStateOf(state)).toEqual(getEntityLeaderState(view));
      expect(nextFailoverLeader(state)).toBe(getNextEntityFailoverLeader(view));
      const body = leaderVoteBody(state, { height, prevFrameHash: prev as EntityFrameHash });
      expect(body).toEqual(buildEntityLeaderVoteBody(view));
      expect(unwrap(hashLeaderVote(body))).toBe(hashEntityLeaderVoteBody(buildEntityLeaderVoteBody(view)));
    }
  });
  test("MATCH: getEntityLeaderTimeoutMs = min(60s, 10s * max(1, floor(view)))", () => {
    for (const v of [0, 0.5, 1, 2, 3, 5.9, 6, 7, 100]) expect(leaderTimeoutMs(v)).toBe(getEntityLeaderTimeoutMs(v));
  });
});

describe(seedTag("entity-consensus-2: timeout certificate and certified view change (ER-18)"), () => {
  // [A, B, C] equal shares, threshold 2: A (the CEO) goes silent, B and C time out, B (order[1]) proposes at view 1
  const members = [[A, 1n], [B, 1n], [C, 1n]] as const;
  const run = () => {
    const step = (r: EntityReplica, input: EntityInput, signer: Address) => unwrap(applyEntityInput(r, input, ctx(signer)));
    let b = step(teaching(members, 2n, B), { kind: "txs", timestamp: NOW, txs: [openBob] }, B).replica;
    let c = step(teaching(members, 2n, C), { kind: "txs", timestamp: NOW, txs: [openBob] }, C).replica;
    const at = NOW + 10_000n;
    const bVote = step(b, localTimeoutVote(b, at) ?? (() => { throw new Error("no vote"); })(), B);
    b = bVote.replica;
    const cSawB = step(c, inputsFor(bVote.outputs, C)[0] as EntityInput, C);
    c = cSawB.replica;
    const cVote = step(c, localTimeoutVote(c, at) ?? (() => { throw new Error("no vote"); })(), C);
    c = cVote.replica;
    const bCertified = step(b, inputsFor(cVote.outputs, B).find((x) => x.kind === "leaderTimeoutVote") as EntityInput, B);
    return { b: bCertified.replica, c, bVote, cVote, bCertified, step };
  };
  test("MATCH: votes are og-signed timeout votes; the certificate equals og buildEntityLeaderCertificate and og verifyEntityLeaderCertificate accepts B's frame leader", () => {
    const { b, bVote, cVote } = run();
    const vB = (inputsFor(bVote.outputs, C)[0] as Extract<EntityInput, { kind: "leaderTimeoutVote" }>).vote;
    const vC = (inputsFor(cVote.outputs, B).find((x) => x.kind === "leaderTimeoutVote") as Extract<EntityInput, { kind: "leaderTimeoutVote" }>).vote;
    const genesis = teaching(members, 2n).state;
    const view = ogView(genesis, 0n, "genesis");
    expect({ ...vB, signature: "" }).toEqual({ ...buildEntityLeaderVoteBody(view), voterId: B.toLowerCase(), signature: "" });
    expect(b._tag).toBe("proposed");
    if (b._tag !== "proposed") return;
    const frame = b.frame, cert = frame.leader.certificate;
    if (cert === undefined) throw new Error("no certificate");
    expect(frame.leader.proposerSignerId).toBe(B.toLowerCase());
    expect(frame.leader.view).toBe(1);
    const votes = new Map<string, any>([[B, { ...vB, signature: ogSig(vB.signature) }], [C, { ...vC, signature: ogSig(vC.signature) }]]);
    expect(ogCert(cert)).toEqual(buildEntityLeaderCertificate(buildEntityLeaderVoteBody(view), votes));
    expect(buildLeaderCertificate(leaderVoteBody(genesis, { height: 0n, prevFrameHash: "genesis" as EntityFrameHash }), new Map<string, LeaderVote>([[B, vB], [C, vC]]))).toEqual(cert);
    const ogFrame = { height: 1, leader: { proposerSignerId: frame.leader.proposerSignerId, view: frame.leader.view, certificate: ogCert(cert) } };
    expect(verifyEntityLeaderCertificate({} as never, view, ogFrame as never)).toBe(true);
    // og: the frame commits the certified leader (expectedCommittedLeaderState) and the authority root binds it
    const leaderState = expectedCommittedLeaderState(view, ogFrame as never);
    expect(b.draft.state.leaderState).toEqual(leaderState);
    expect(frame.authorityRoot).toBe(computeEntityFrameAuthorityRoot(buildEntityFrameAuthority({ config: view.config, leaderState } as never)));
    // a certificate short of quorum is refused by og and by the rewrite's own validation
    const short = { ...ogFrame, leader: { ...ogFrame.leader, certificate: { ...ogCert(cert), votes: new Map([[B.toLowerCase(), ogSig(vB.signature)]]) } } };
    expect(verifyEntityLeaderCertificate({} as never, view, short as never)).toBe(false);
  });
  test("MATCH: C signs and commits the certified frame, B commits with leaderState {B, view 1, changedAtHeight 1}; the stale CEO A accepts the certified proposal and follows B", async () => {
    const { b, c, bCertified, step } = run();
    const proposalToC = inputsFor(bCertified.outputs, C).find((x) => x.kind === "proposal") as EntityInput;
    const cLocked = step(c, proposalToC, C);
    expect(cLocked.replica._tag).toBe("open"); // the proposer's bundle plus C's own reach threshold 2: og handleHashPrecommits commits at once
    expect(cLocked.replica.state.leaderState).toEqual({ activeValidatorId: B.toLowerCase(), view: 1, changedAtHeight: 1 });
    const bCommitted = step(b, inputsFor(cLocked.outputs, B).find((x) => x.kind === "precommit") as EntityInput, B);
    expect(bCommitted.replica._tag).toBe("open");
    expect(bCommitted.replica.state.leaderState).toEqual({ activeValidatorId: B.toLowerCase(), view: 1, changedAtHeight: 1 });
    // og admission signed B's openBob into B's own propose: the certified frame commits it pending a second yes
    if (b._tag !== "proposed") throw new Error("phase");
    const ogTxs = ogAuthored(teaching(members, 2n, B).state, B, [openBob]);
    expect(wired(b.frame.txs)).toEqual(ogTxs);
    const governance = ogAfterCommands(ogCommandState(teaching(members, 2n, B).state, { timestamp: Number(b.frame.timestamp) }), ogTxs);
    expect(consensusBytes(bCommitted.replica.state.committed["proposals"])).toBe(consensusBytes(governance.proposals));
    expect(bCommitted.replica.state.accounts.has(BOB)).toBe(false);
    // C's signed yes reaches B (the view-1 leader) and executes the open in frame 2; og account work at H+1 then proposes
    // the Account frame, which frame 3's manifest signs
    const [proposalId] = [...governance.proposals.keys()] as string[];
    const vote: EntityTx = { type: "vote", data: { proposalId: proposalId ?? "", voter: C, choice: "yes" } };
    const cVoted = step(cLocked.replica, { kind: "txs", timestamp: NOW + 20_000n, txs: [vote] }, C);
    // C's own signed openBob (its admission before the view change) still waits in its mempool ahead of the vote
    expect(wired(cVoted.replica.mempool)).toEqual(ogAuthored(cLocked.replica.state, C, [...cLocked.replica.mempool, vote]));
    const forwarded = inputsFor(cVoted.outputs, B)[0] as EntityInput;
    const bFrame2 = step(bCommitted.replica, forwarded, B);
    const cFrame2 = step(cVoted.replica, inputsFor(bFrame2.outputs, C).find((x) => x.kind === "proposal") as EntityInput, C);
    const bOpened = step(bFrame2.replica, inputsFor(cFrame2.outputs, B).find((x) => x.kind === "precommit") as EntityInput, B);
    expect(bOpened.replica._tag).toBe("open");
    expect(bOpened.replica.state.accounts.has(BOB)).toBe(true);
    const bWork = unwrap(applyEntityInput(bOpened.replica, { kind: "txs", timestamp: NOW + 20_000n, txs: [] }, { ...ctx(B), lane: "account-work" }));
    if (bWork.replica._tag !== "proposed") throw new Error("phase");
    expect(bWork.replica.frame.hashesToSign.some((h) => h.type === "accountFrame" && h.context === `account:${BOB.slice(-8)}:frame:1`)).toBe(true);
    const cFrame3 = step(cFrame2.replica, inputsFor(bWork.outputs, C).find((x) => x.kind === "proposal") as EntityInput, C);
    const bCommitted3 = step(bWork.replica, inputsFor(cFrame3.outputs, B).find((x) => x.kind === "precommit") as EntityInput, B);
    // og buildQuorumHanko over the B and C manifest signatures of the Account frame is exactly the Hanko B sends
    const sent = bCommitted3.outputs.find((o) => "tx" in o && o.tx.data.kind === "ack_frame");
    if (sent === undefined || !("tx" in sent) || sent.tx.data.kind !== "ack_frame") throw new Error("no account frame");
    const digest = sent.tx.data.frame.stateHash, config = ogConfigOf(b.state);
    const sigs = [B, C].map((s) => ({ signerId: s.toLowerCase(), signature: ogSig(unwrap(crypto.sign(digest as Hash, s))) }));
    expect(sent.tx.data.frameHanko).toBe(await buildQuorumHanko({} as never, ENTITY, digest, sigs, config));
    expect(unwrap(quorumHanko(b.state, digest, new Map([[B, unwrap(crypto.sign(digest as Hash, B))], [C, unwrap(crypto.sign(digest as Hash, C))]])))).toBe(sent.tx.data.frameHanko);
    const a = step(teaching(members, 2n, A), inputsFor(bCertified.outputs, A).find((x) => x.kind === "proposal") as EntityInput, A);
    expect(a.replica._tag).toBe("open");
    expect(a.replica.state.leaderState).toEqual({ activeValidatorId: B.toLowerCase(), view: 1, changedAtHeight: 1 });
  });
  test("MATCH (og assertEntityLeaderVoteMatchesState): a vote for the wrong view is refused (ENTITY_LEADER_VOTE_STALE_OR_INVALID)", () => {
    const b = teaching(members, 2n, B);
    const vote = localTimeoutVote(unwrap(applyEntityInput(b, { kind: "txs", timestamp: NOW, txs: [openBob] }, ctx(B))).replica, NOW);
    if (vote === undefined || vote.kind !== "leaderTimeoutVote") throw new Error("no vote");
    const stale = { ...vote, local: false, vote: { ...vote.vote, voterId: C.toLowerCase(), toView: 2 } };
    expect(applyEntityInput(b, stale, ctx(B)).ok).toBe(false);
    expect(() => buildEntityLeaderVoteBody(ogView(b.state, 0n, "genesis")).toView === 2 || (() => { throw new Error("ENTITY_LEADER_VOTE_STALE_OR_INVALID"); })()).toThrow();
  });
  test("MATCH (og nextReplicaDeadline): only a non-leader with leader work votes; the CEO never times itself out", () => {
    const a = teaching(members, 2n, A);
    const withWork = unwrap(applyEntityInput(teaching(members, 2n, B), { kind: "txs", timestamp: NOW, txs: [openBob] }, ctx(B))).replica;
    expect(localTimeoutVote(teaching(members, 2n, B), NOW)).toBeUndefined();
    expect(localTimeoutVote(withWork, NOW)).toBeDefined();
    expect(localTimeoutVote(a, NOW)).toBeUndefined();
  });
});

describe(seedTag("entity-consensus-2: account Hankos through hashesToSign (ER-4)"), () => {
  test("MATCH (og proposePendingAccountFrames + buildQuorumHanko): the view-1 frame signs the Account frame as a secondary hash and the committed Account carries the quorum Hanko", () => {
    // A's share alone passes its signed propose of openBob, so frame 1 opens the Account; og account work proposes the
    // Account frame at H+1, and that frame's manifest signs it
    const members = [[A, 2n], [B, 1n], [C, 1n]] as const;
    const b0 = teaching(members, 2n, B);
    const opening = unwrap(applyEntityInput(teaching(members, 2n, A), { kind: "txs", timestamp: NOW, txs: [openBob] }, ctx(A))).replica;
    if (opening._tag !== "proposed") throw new Error("phase");
    expect(opening.frame.hashesToSign.some((h) => h.type === "accountFrame")).toBe(false);
    const opened = unwrap(applyEntityInput(opening, { kind: "txs", timestamp: NOW, txs: [] }, ctx(A))).replica;
    expect(opened._tag).toBe("open");
    expect(opened.state.accounts.has(BOB)).toBe(true);
    const f = unwrap(applyEntityInput(opened, { kind: "txs", timestamp: NOW, txs: [] }, { ...ctx(A), lane: "account-work" })).replica;
    if (f._tag !== "proposed") throw new Error("phase");
    const frame: EntityFrame = f.frame;
    expect(frame.hashesToSign.map((h) => h.type)).toEqual(["entityFrame", ...frame.hashesToSign.slice(1).map((h) => h.type)]);
    expect(frame.hashesToSign.some((h) => h.type === "accountFrame" && h.context === `account:${BOB.slice(-8)}:frame:1`)).toBe(true);
    expect(frame.hashesToSign[0]?.hash).toBe(unwrap(hashEntityFrame(frame)));
    expect(b0._tag).toBe("open");
  });
});

describe(seedTag("entity-consensus-2: board Hanko refresh and the previous-board grace (AC-13)"), () => {
  // Alice's Account with Bob at height 1, committed through the ordinary propose / ack_frame / ack exchange
  const committedAlice = (): AccountReplica => {
    const door = (self: EntityId): DoorContext => ({ verify: hankoVerify, self, now: NOW });
    const a0 = unwrap(admit(genesisAB(), [{ type: "add_delta", tokenId: unwrap(tokenId("1")) }]));
    const proposed = unwrap(applyAccountInput(a0, proposeInput(a0, ALICE), door(ALICE))).replica as ProposedAccount;
    const received = unwrap(applyAccountInput(genesisAB(), offerOf(proposed, ALICE), door(BOB))).replica;
    return unwrap(applyAccountInput(proposed, ackInput(received, BOB), door(ALICE))).replica;
  };
  const BOARD: CertifiedBoard = { boardHash: word(900), activatedAtJHeight: 7, logIndex: 2 };
  const CODES: Record<BoardRefreshRefusal, string> = {
    party_mismatch: "PARTY_MISMATCH", activation_height: "ACTIVATION_HEIGHT_INVALID", activation_log_index: "ACTIVATION_LOG_INDEX_INVALID", certified_board_missing: "CERTIFIED_BOARD_MISSING",
    activation_mismatch: "ACTIVATION_MISMATCH", activation_order: "ACTIVATION_ORDER_INVALID", height_mismatch: "HEIGHT_MISMATCH", frame_hash_mismatch: "FRAME_HASH_MISMATCH",
    frame_hanko_missing: "FRAME_HANKO_MISSING", frame_hanko_invalid: "FRAME_HANKO_INVALID", dispute_mismatch: "DISPUTE_MISMATCH",
  };
  test("MATCH (og incoming/board-hanko-refresh.ts handleBoardHankoRefresh): 800 random refreshes -- same verdict, same refusal, same installed frame Hanko and refresh record, frame Hanko checked under the current board only", async () => {
    const alice = committedAlice();
    if (alice._tag !== "open" || alice.head._tag !== "installed") throw new Error("not committed");
    const head = alice.head, frameHash = head.prevFrameHash, peerDispute = alice.dispute.counterparty;
    const verdicts = { accepted: 0, rejected: new Set<string>() };
    for (let i = 0; i < 800; i++) {
      const pick = <X>(xs: readonly X[]): X => xs[ri(xs.length)] as X;
      const board = rng() < 0.1 ? undefined : BOARD;
      const aH = pick([7, 7, 7, 6, 0, 8]), aL = pick([2, 2, 2, 1, 3, -1]);
      const prev: BoardRefresh | undefined = pick([undefined, undefined, { activationJHeight: 7, activationLogIndex: 2, frameHeight: 1, frameHash }, { activationJHeight: 6, activationLogIndex: 9, frameHeight: 1, frameHash }, { activationJHeight: 7, activationLogIndex: 1, frameHeight: 1, frameHash: word(5) }]);
      const height = pick([1n, 1n, 1n, 2n, 0n]), hash = pick([frameHash, frameHash, frameHash.toUpperCase().replace("0X", "0x"), word(3), "junk"]);
      const hanko = pick([`0x${"ab".repeat(40)}`, `0x${"cd".repeat(40)}`, "", "0xbad0"]);
      const from = rng() < 0.08 ? ALICE : BOB;
      const dispute = rng() < 0.25 && peerDispute !== undefined ? { ...peerDispute, proofNonce: peerDispute.proofNonce + (rng() < 0.5 ? 0 : 1) } : undefined;
      const seen: HankoAuthority[] = [];
      const verify: Verify = (_d, h, _e, authority) => { if (authority !== undefined) seen.push(authority); return h !== "0xbad0" && h.length > 0; };
      const input = { kind: "board_hanko_refresh" as const, ...envelopeAB(from), height, frameHash: hash, frameHanko: hanko, boardActivationJHeight: aH, boardActivationLogIndex: aL, ...(dispute === undefined ? {} : { disputeHanko: { ...dispute, proofNonce: dispute.proofNonce } }) };
      // a dispute Hanko that passes the tuple match reaches og's full witness validation (Account state); keep to the tuple-level verdicts here
      if (dispute !== undefined && dispute.proofNonce === peerDispute?.proofNonce) continue;
      const rw = applyAccountInput({ ...alice, ...(prev === undefined ? {} : { boardRefresh: prev }) }, input, { verify, self: ALICE, now: NOW, ...(board === undefined ? {} : { counterpartyBoard: board }) });
      const account: any = {
        proofHeader: { fromEntity: ALICE, toEntity: BOB }, currentHeight: 1, currentFrame: { height: 1, stateHash: frameHash }, counterpartyFrameHanko: certifiedBy(head.certificate, partyIn(alice, ALICE)).peer,
        ...(prev === undefined ? {} : { counterpartyBoardHankoRefresh: prev }),
        ...(peerDispute === undefined ? {} : { counterpartyDisputeHash: peerDispute.hash, counterpartyDisputeProofBodyHash: peerDispute.proofBodyHash, counterpartyDisputeProofNonce: peerDispute.proofNonce, counterpartyDisputeProofProposerIsLeft: peerDispute.proposerIsLeft }),
      };
      const ogSeen: unknown[] = [];
      const og = await handleBoardHankoRefresh(account, {
        kind: "board_hanko_refresh", fromEntityId: from, toEntityId: from === BOB ? ALICE : BOB,
        boardHankoRefresh: { height: Number(height), frameHash: hash, frameHanko: hanko, ...(dispute === undefined ? {} : { disputeHanko: dispute }), boardActivationJHeight: aH, boardActivationLogIndex: aL },
      } as never, {
        ...(board === undefined ? {} : { counterpartyCertifiedBoard: board }),
        verifyHanko: async (h: string, _hash: string, entity: string, authority: unknown) => { ogSeen.push(authority); return { valid: h !== "0xbad0" && h.length > 0, entityId: entity }; },
      } as never);
      if (og === undefined) throw new Error("not a refresh");
      if (!og.ok) {
        const message = String((og as any).rejection.message);
        expect(rw.ok).toBe(false);
        if (rw.ok) continue;
        if (rw.error._tag !== "board_hanko_refresh") throw new Error(`${rw.error._tag} vs ${message}`);
        verdicts.rejected.add(rw.error.reason);
        expect(message.startsWith(from === ALICE ? "ACCOUNT_BOARD_HANKO_REFRESH_PARTY_MISMATCH" : `ACCOUNT_BOARD_HANKO_REFRESH_${CODES[rw.error.reason]}`)).toBe(true);
        continue;
      }
      expect(rw.ok).toBe(true);
      if (!rw.ok) continue;
      const after = rw.value.replica;
      expect(after.head._tag === "installed" ? certifiedBy(after.head.certificate, partyIn(after, ALICE)).peer : undefined).toBe(account.counterpartyFrameHanko);
      expect(after.boardRefresh).toEqual(account.counterpartyBoardHankoRefresh);
      // og returns accountInputApplied({ events }) and nothing to send; the status line is the Account's message output
      expect(rw.value.outputs).toEqual(((og as any).events as string[]).map((message) => ({ kind: "message", message })));
      expect(seen).toEqual(ogSeen as HankoAuthority[]);
      expect(seen).toEqual([{ registeredBoardHash: BOARD.boardHash, allowPreviousBoard: false }]);
      verdicts.accepted += 1;
    }
    expect(verdicts.accepted).toBeGreaterThan(10);
    expect(verdicts.rejected.size).toBeGreaterThan(7);
  });
  test("MATCH (og ack-commit.ts allowPreviousBoard: true, preflight.ts false): ACK Hankos are checked with the previous-board grace, a fresh frame's Hanko without it", () => {
    const seen: [string, HankoAuthority | undefined][] = [];
    const door = (self: EntityId): DoorContext => ({ verify: (d, h, e, authority) => { seen.push([e.toLowerCase() === ALICE.toLowerCase() ? "alice" : "bob", authority]); return hankoVerify(d, h, e); }, self, now: NOW, counterpartyBoard: BOARD });
    const a0 = unwrap(admit(genesisAB(), [{ type: "add_delta", tokenId: unwrap(tokenId("1")) }]));
    const proposed = unwrap(applyAccountInput(a0, proposeInput(a0, ALICE), { verify: hankoVerify, self: ALICE, now: NOW })).replica as ProposedAccount;
    seen.length = 0;
    const received = unwrap(applyAccountInput(genesisAB(), offerOf(proposed, ALICE), door(BOB))).replica;
    expect(seen.filter(([who]) => who === "alice").map(([, a]) => a?.allowPreviousBoard)).toContain(false); // the frame Hanko: og preflight.ts
    seen.length = 0;
    unwrap(applyAccountInput(proposed, ackInput(received, BOB), door(ALICE)));
    const frameChecks = seen.filter(([who]) => who === "bob").map(([, a]) => a);
    expect(frameChecks).toContainEqual({ registeredBoardHash: BOARD.boardHash, allowPreviousBoard: true }); // og ack-commit.ts
  });
});

describe(seedTag("entity-consensus-2: entity txs chat, chatMessage, requestCollateral, profile-update"), () => {
  const single = () => teaching([[A, 1n]], 1n, A);
  const opened = () => unwrap(applyEntityInput(single(), { kind: "txs", timestamp: NOW, txs: [openBob] }, ctx(A))).replica;
  test("MATCH (og handleProfileUpdateEntityTx): 300 random updates -- same refusal or the same committed profile", () => {
    const kinds = [undefined, null, "company", "person", "robot"], sectorSets = [undefined, [], ["finance"], ["energy", "finance"], ["finance", "energy"], ["finance", "finance"], ["mining"], ["commerce", "education", "energy", "finance", "media"]];
    const texts = [undefined, "", "  Hub  ", "x"];
    for (let i = 0; i < 300; i++) {
      const pick = <X>(xs: readonly X[]): X => xs[ri(xs.length)] as X;
      const hubbed = rng() < 0.5, prev = { name: pick(["Old", ""]), isHub: hubbed, ...(rng() < 0.5 ? { entityKind: "company" } : {}), ...(rng() < 0.5 ? { sectors: ["media"] } : {}), avatar: "a", bio: "b", website: "w" };
      const r = teaching([[A, 1n]], 1n, A);
      // og setHubConfig commits the config with the profile's hub flag
      const base = { ...r, state: withOg(r.state, { profile: prev, ...(hubbed ? { hubRebalanceConfig: { matchingStrategy: "amount", policyVersion: 1 } } : {}) }) } as EntityReplica;
      const profile: Record<string, unknown> = { entityId: rng() < 0.05 ? BOB : r.state.id };
      for (const [k, v] of [["name", pick(texts)], ["entityKind", pick(kinds)], ["sectors", pick(sectorSets)], ["avatar", pick(texts)], ["bio", pick(texts)], ["website", pick(texts)]] as const) if (v !== undefined) profile[k] = v;
      const tx = { type: "profile-update", data: { profile } } as EntityTx;
      let ogProfile: unknown, ogError: string | undefined;
      try { ogProfile = handleProfileUpdateEntityTx({} as never, { entityId: r.state.id, profile: structuredClone(prev) } as never, tx as never, true).newState.profile; } catch (e) { ogError = String(e); }
      const rw = applyEntityInput(base, { kind: "txs", timestamp: NOW, txs: [tx] }, ctx(A));
      if (ogError !== undefined) { expect(rw.ok).toBe(false); continue; }
      const committed = ogOf(unwrap(rw).replica.state)["profile"];
      expect(JSON.parse(JSON.stringify(committed))).toEqual(JSON.parse(JSON.stringify(ogProfile)));
    }
  }, 30_000);
  test("MATCH (og handleRequestCollateralEntityTx): a missing Account is a no-op; otherwise the request_collateral Account tx is queued and proposed in the same frame", () => {
    const tx = (to: EntityId): EntityTx => ({ type: "requestCollateral", data: { counterpartyEntityId: to, tokenId: unwrap(tokenId("1")), amount: 50n, feeTokenId: unwrap(tokenId("1")), feeAmount: 2n, policyVersion: 1 } });
    const og = handleRequestCollateralEntityTx({ entityId: ENTITY, accounts: new Map([[BOB, {}]]), config: { validators: [A] } } as never, { type: "requestCollateral", data: { counterpartyEntityId: BOB, tokenId: 1, amount: 50n, feeTokenId: 1, feeAmount: 2n, policyVersion: 1 } } as never, true);
    expect(og.accountTxs).toEqual([{ accountId: BOB, tx: { type: "request_collateral", data: { tokenId: 1, amount: 50n, feeTokenId: 1, feeAmount: 2n, policyVersion: 1 } } }]);
    const missing = handleRequestCollateralEntityTx({ entityId: ENTITY, accounts: new Map(), config: { validators: [A] } } as never, { type: "requestCollateral", data: { counterpartyEntityId: BOB, tokenId: 1, amount: 50n, feeAmount: 2n, policyVersion: 1 } } as never, true);
    expect(missing.outputs).toEqual([]);
    const none = unwrap(applyEntityInput(single(), { kind: "txs", timestamp: NOW, txs: [tx(BOB)] }, ctx(A)));
    expect(none.outputs).toEqual([]);
    expect(none.replica.head.height).toBe(1n);
  });
  test("MATCH (og createEntityFrameHashFromStateRoot): chat, chatMessage, requestCollateral and profile-update txs hash into the frame exactly as og's wire txs", () => {
    const r = opened(), pair = teaching([[A, 1n], [B, 1n]], 2n, A);
    const listFor = (id: EntityId): EntityTx[] => [
      { type: "chat", data: { from: A, message: "hello" } },
      { type: "chatMessage", data: { message: "note", timestamp: 5, metadata: { type: "info", height: 2 } } },
      { type: "profile-update", data: { profile: { entityId: id, name: "Hub", sectors: ["finance"] } } },
    ];
    const list = listFor(r.state.id), pairList = listFor(pair.state.id);
    const p = unwrap(applyEntityInput(r, { kind: "txs", timestamp: NOW + 1n, txs: list }, ctx(A)));
    expect(p.replica.head.height).toBe(2n);
    expect(ogOf(p.replica.state)["profile"]).toMatchObject({ name: "Hub", sectors: ["finance"] });
    // a held 2-of-2 proposal exposes the frame: its hash is og's over og's wire txs (numeric token ids, the same data keys)
    const pairTxs: EntityTx[] = [...pairList, { type: "requestCollateral", data: { counterpartyEntityId: BOB, tokenId: unwrap(tokenId("1")), amount: 5n, feeTokenId: unwrap(tokenId("2")), feeAmount: 1n, policyVersion: 1 } }];
    const held = unwrap(applyEntityInput(pair, { kind: "txs", timestamp: NOW, txs: pairTxs }, ctx(A))).replica;
    if (held._tag !== "proposed") throw new Error("phase");
    const f = held.frame;
    // og admission: the chat is A's command, the collective txs A's propose (pending B's yes on this 2-of-2 board)
    const ogTxs = ogAuthored(pair.state, A, pairTxs);
    expect(wired(f.txs)).toEqual(ogTxs);
    // og frame events: the chat text event (the pending proposal executes nothing), as og's handlers record them
    const ogState = ogAfterCommands(ogCommandState(pair.state, { timestamp: Number(NOW) }), ogTxs);
    const ogEvents = readEntityFrameEvents(ogState);
    expect(f.events).toEqual(ogEvents as never);
    expect<string>(unwrap(hashEntityFrame(f))).toBe(createEntityFrameHashFromStateRoot("genesis", 1, Number(NOW), ogTxs as never, ogEvents, pair.state.id, f.stateRoot, f.authorityRoot, f.entityContext as never));
  });
});

describe(seedTag("entity-consensus-2: publicPinned (H7)"), () => {
  test("MATCH (og resolveOpenAccountPublicPin): the opener pins unless pinPublic is false; the leaf commits it (hashes.test.ts H7 compares the root with og)", () => {
    const open = (extra: Record<string, unknown>): EntityTx => ({ type: "openAccount", data: { targetEntityId: BOB, accountDomain: { ...TERMS.domain }, watchSeed: TERMS.watchSeed, disputeConfig: { ...TERMS.disputeConfig }, ...extra } } as EntityTx);
    const run = (tx: EntityTx) => unwrap(applyEntityInput(teaching([[A, 1n]], 1n, A), { kind: "txs", timestamp: NOW, txs: [tx] }, ctx(A))).replica.accountReplicas.get(BOB);
    expect(run(open({}))?.publicPinned).toBe(true);
    expect(run(open({ pinPublic: false }))?.publicPinned).toBeUndefined();
  });
});

describe(seedTag("entity-consensus-2: trusted gateway payments (ER-15)"), () => {
  // three single-signer Entities on one runtime; every output is delivered until the network is quiet
  const party = (id: EntityId, signer: Address) => unwrap(createEntity({ id, jurisdiction: JUR, threshold: 1n, members: new Map([[signer, { shares: 1n }]]), jurisdictionConfig: UNREGISTERED_J }));
  const signers = new Map<EntityId, Address>([[ALICE, A], [BOB, B], [CAROL, C]]);
  const quiet = (start: Runtime, first: RoutedEntityInput[]): Runtime => {
    let rt = start, clock = NOW;
    const queue = [...first];
    for (let n = 0; queue.length > 0; n++) {
      if (n > 200) throw new Error("no quiescence");
      const input = queue.shift() as RoutedEntityInput;
      const out = unwrap(applyRuntime(rt, { runtimeTxs: [], entityInputs: [input] }, verifiers));
      if (out.rejected.length > 0) throw new Error(JSON.stringify(out.rejected, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
      rt = out.runtime;
      clock += 1n;
      for (const o of out.outbox) {
        if ("input" in o && o.input.kind === "txs" && o.input.txs.length === 0 && o.to === input.entityId) continue; // og processingTrigger wake: this loop drains anyway
        queue.push(unwrap(convertOutput(rt, o, input.entityId, clock)));
      }
    }
    return rt;
  };
  const create = (id: EntityId, txs: EntityTx[], timestamp: bigint = NOW): RoutedEntityInput => ({ entityId: id, signerId: signers.get(id) as Address, input: { kind: "txs", timestamp, txs } });
  const open = (to: EntityId, creditAmount?: bigint): EntityTx => ({ type: "openAccount", data: { targetEntityId: to, accountDomain: { ...TERMS.domain }, watchSeed: TERMS.watchSeed, disputeConfig: { ...TERMS.disputeConfig }, ...(creditAmount === undefined ? {} : { creditAmount, tokenId: unwrap(tokenId("1")) }) } } as EntityTx);
  const offdelta = (rt: Runtime, self: EntityId, peer: EntityId): bigint | undefined => rt.entities.get(replicaKey(self, signers.get(self) as Address))?.accountReplicas.get(peer)?.state.account.deltas.get(unwrap(tokenId("1")))?.offdelta;
  test("MATCH (og direct-payment.ts requireTrustedPaymentGateway + applyDirectPaymentForwardFollowups): Alice pays Carol through gateway Bob; Bob forwards the committed first leg once", async () => {
    let rt = spawn(spawn(spawn(createRuntime(), party(ALICE, A)), party(BOB, B)), party(CAROL, C));
    rt = quiet(rt, [create(BOB, [open(ALICE, 100n), open(CAROL)])]);
    rt = quiet(rt, [create(CAROL, [{ type: "extendCredit", data: { counterpartyEntityId: BOB, tokenId: unwrap(tokenId("1")), amount: 100n } }], NOW + 100n)]);
    const pay = (route: readonly EntityId[], gateway?: EntityId, deliveryMode: "direct" | "trusted" = "trusted"): EntityTx =>
      ({ type: "directPayment", data: { targetEntityId: CAROL, tokenId: unwrap(tokenId("1")), amount: 10n, route, deliveryMode, ...(gateway === undefined ? {} : { trustedGatewayEntityId: gateway }) } });
    // og TRUSTED_PAYMENT_GATEWAY_INVALID: the declared gateway must be route[1] of an exact 3-hop route
    for (const bad of [pay([ALICE, BOB, CAROL], CAROL), pay([ALICE, BOB, CAROL]), pay([ALICE, CAROL], BOB), pay([ALICE, BOB, CAROL], BOB, "direct")]) {
      expect(unwrap(applyRuntime(rt, { runtimeTxs: [], entityInputs: [create(ALICE, [bad], NOW + 200n)] }, verifiers)).rejected.length).toBe(1);
    }
    // the first leg Alice proposes is og's buildNextHopPayment account tx, byte for byte on the wire
    const first = unwrap(applyRuntime(rt, { runtimeTxs: [], entityInputs: [create(ALICE, [pay([ALICE, BOB, CAROL], BOB)], NOW + 300n)] }, verifiers)).outbox.find((o) => "tx" in o && o.tx.data.kind === "ack_frame");
    if (first === undefined || !("tx" in first) || first.tx.data.kind !== "ack_frame") throw new Error("no first leg");
    const aliceAccount = rt.entities.get(replicaKey(ALICE, A))?.accountReplicas.get(BOB) as AccountReplica;
    const wire = unwrap(wireTx(first.tx.data.frame.txs[0] as never, replicaId(aliceAccount), isLeft(ALICE, replicaId(aliceAccount))));
    const og = await handleDirectPaymentEntityTx({} as never, { entityId: ALICE, accounts: new Map([[BOB, {}]]), config: { validators: [A] } } as never,
      { type: "directPayment", data: { targetEntityId: CAROL, tokenId: 1, amount: 10n, route: [ALICE, BOB, CAROL], deliveryMode: "trusted", trustedGatewayEntityId: BOB } } as never, [], true);
    expect(wire).toEqual(og.accountTxs?.[0]?.tx as never);
    rt = quiet(rt, [create(ALICE, [pay([ALICE, BOB, CAROL], BOB)], NOW + 300n)]);
    const aliceBob = offdelta(rt, ALICE, BOB), bobCarol = offdelta(rt, BOB, CAROL);
    expect(aliceBob === 10n || aliceBob === -10n).toBe(true);
    expect(bobCarol === 10n || bobCarol === -10n).toBe(true);
    expect(offdelta(rt, BOB, ALICE)).toBe(aliceBob);
    expect(offdelta(rt, CAROL, BOB)).toBe(bobCarol);
    expect(rt.entities.get(replicaKey(BOB, B))?.accountReplicas.get(CAROL)?._tag).toBe("open");
  });
});
