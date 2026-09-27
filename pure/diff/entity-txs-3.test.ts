import { describe, expect, test } from "bun:test";
import { seedOf, seedTag } from "./seed.ts";
import {
  authorEntityTxs, buildCommand, certifiedBoardStackKey, checkCommand, configBoardHash, createEntity, entityId, entityTransactionAction, foldTxs, hashCommand, hashCommandTxs, hashEntityFrame,
  hashProposalAction, applyEntityInput, proposalId, tokenId, wireEntityTx, installedAccount, ZERO_WORD, genesisHost, applyHost, localProof, committedView, envelopeOf, prepareFrozen, ogProofBody, spawn, createRuntime, applyRuntime, convertOutput, replicaKey,
  applyBookCommand, bookCommitmentHash, bookOrders, createBook, type Book,
  type AccountReplica, type Address, type EntityCommand, type EntityError, type EntityId, type EntityReplica, type EntityState, type EntityTx, type Hash, type ProposalAction,
} from "../xln.ts";
import { ALICE, BOB, CAROL, NOW, TERMS, aliceAddr, bobAddr, carolAddr, crypto, genesisAB, hankoVerify, unwrap, verifiers } from "../xln_run.ts";
import { createAccountDisputeFinalityInput, createAccountDisputeStartedInput } from "../../core/account/input.ts";
import { applyAccountDisputeFinality, applyAccountDisputeStarted } from "../../core/account/settlement/j-finality.ts";
import { canonicalizeProofBodyStruct, handleDisputeStart, handlePrepareDispute } from "../../core/entity/tx/handlers/dispute/index.ts";
import { encodeCanonicalConsensusBytes } from "../../core/protocol/serialization/binary-codec.ts";
import { hashEntityCommand, hashEntityCommandTxs, UNREGISTERED_ENTITY_COMMAND_STACK_KEY } from "../../core/entity/command/command-codec.ts";
import { advanceEntityCommandNonce, assertSignedEntityCommand, getEntityCommandDisposition, resolveEntityCommandBoard } from "../../core/entity/command/index.ts";
import { buildEntityTransactionProposalAction, hashEntityProposalAction } from "../../core/entity/auth/authorization.ts";
import { generateProposalId } from "../../core/entity/tx/processing/proposals.ts";
import { handleChatEntityTx, handleChatMessageEntityTx, handleProfileUpdateEntityTx, handleProposeEntityTx, handleVoteEntityTx } from "../../core/entity/tx/handlers/system/basic.ts";
import { EntityCommandRejectionError } from "../../core/entity/tx/processing/invariant-errors.ts";
import { readEntityFrameEvents } from "../../core/entity/frame-events.ts";
import { getCertifiedBoardStackKey } from "../../core/jurisdiction/machine/board-registry/index.ts";
import { createEntityFrameHashFromStateRoot } from "../../core/entity/consensus/frame.ts";
import { buildHubRebalancePolicyTx, handleExtendCreditEntityTx, handleSetHubConfigEntityTx, handleSetRebalancePolicyEntityTx } from "../../core/entity/tx/handlers/account/lifecycle/admin.ts";
import { DEFAULT_ACCOUNT_TOKEN_IDS as OG_DEFAULT_TOKEN_IDS, resolveJurisdictionRebalanceDefaults } from "../../core/account/config/defaults.ts";
import { PersistentAccountStateMap } from "../../core/account/state/persistent-state-map.ts";
import { EntityAccountCandidateMap, PersistentEntityAccountMap } from "../../core/entity/state/persistent-account-map.ts";
import { handleLendingBorrowEntityTx, handleLendingClosePositionEntityTx } from "../../core/entity/tx/handlers/payments/lending.ts";
import * as ogBook from "../../core/orderbook/core.ts";
import { computeBookCommitmentHash } from "../../core/orderbook/commitment.ts";
import { rebuildOrderbookPairIndex } from "../../core/orderbook/order-index.ts";

/** og's committed Account collections are Patricia-backed maps; their commitment is `rootHash()`. */
const ogRootHash = (c: object): string => {
  if (!("rootHash" in c) || typeof c.rootHash !== "function") throw new Error("og collection has no rootHash");
  return String(c.rootHash());
};
let seed = seedOf(3);
const rng = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const ri = (n: number): number => Math.floor(rng() * n);
const pick = <T>(xs: readonly T[]): T => xs[ri(xs.length)] as T;
const SIGNERS = [aliceAddr, bobAddr, carolAddr] as const;
const JUR = TERMS.domain;
const env = { quietRuntimeLogs: true } as never;
const bytes = (v: unknown): string => Buffer.from(encodeCanonicalConsensusBytes(v)).toString("hex");
const signAs = (addr: Address) => (h: Hash) => crypto.sign(h, addr);
/** A teaching Entity whose id is its own config board hash (og lazy board, epoch 0). */
const lazyEntity = (members: readonly (readonly [Address, bigint])[], threshold: bigint): EntityReplica => {
  const seedOf = (id: EntityId) => unwrap(createEntity({ id, jurisdiction: JUR, threshold, members: new Map(members.map(([a, s]) => [a, { shares: s }])) }));
  return seedOf(unwrap(entityId(configBoardHash(seedOf(ALICE).state.quorum))));
};
const ogConfig = (s: EntityState) => {
  if (s.quorum._tag !== "teaching") throw new Error("teaching");
  const members = [...s.quorum.members];
  return { mode: "proposer-based" as const, threshold: s.quorum.threshold, validators: members.map(([a]) => a.toLowerCase()), shares: Object.fromEntries(members.map(([a, m]) => [a.toLowerCase(), m.shares])) };
};
/** og EntityState fields governance reads and writes. */
const ogState = (s: EntityState, timestamp: number): any => ({ entityId: s.id, config: ogConfig(s), proposals: new Map(), profile: { name: `Entity ${s.id.slice(-4)}`, avatar: "", bio: "", website: "" }, timestamp });
const wire = (tx: EntityTx): any => wireEntityTx(tx);
const tagOf = (e: unknown): "entity_command" | "entity_invariant" => (e instanceof EntityCommandRejectionError ? "entity_command" : "entity_invariant");
/** og applyNestedEntityTx (frame/application.ts) with og's own handlers: signed-command checks, disposition, the individual txs, approved collective txs, nonce advance. */
const ogApplyCommand = (before: any, command: unknown): { state: any } | { error: "entity_command" | "entity_invariant"; message: string } => {
  const st = structuredClone(before);
  try {
    const c = assertSignedEntityCommand(env, st, command);
    if (getEntityCommandDisposition(st, c) !== "next") return { state: st };
    let cur = st;
    const collective = (tx: any): void => {
      if (tx.type === "chatMessage") cur = handleChatMessageEntityTx(cur, tx, true).newState;
      else if (tx.type === "profile-update") cur = handleProfileUpdateEntityTx(env, cur, tx, true).newState;
      else throw new Error(`test: collective ${tx.type}`);
    };
    for (const tx of c.txs as any[]) {
      const r = tx.type === "propose" ? handleProposeEntityTx(env, cur, tx, true) : tx.type === "vote" ? handleVoteEntityTx(env, cur, tx, true) : handleChatEntityTx(cur, tx, true);
      cur = r.newState;
      for (const approved of r.approvedEntityTxs ?? []) collective(approved);
    }
    return { state: advanceEntityCommandNonce(cur, c) };
  } catch (e) {
    return { error: tagOf(e), message: String(e) };
  }
};

describe(seedTag("entity-txs-3: entityCommand codec and hashes (og command/command-codec.ts, auth/authorization.ts)"), () => {
  test("MATCH: hashEntityCommandTxs / hashEntityCommand / generateProposalId / stack keys over 200 random commands", () => {
    for (let i = 0; i < 200; i++) {
      const txs: EntityTx[] = Array.from({ length: 1 + ri(3) }, () => pick<EntityTx>([
        { type: "chat", data: { from: aliceAddr, message: `m${ri(99)}` } },
        { type: "vote", data: { proposalId: `prop_${ri(9)}`, voter: aliceAddr, choice: pick(["yes", "no"] as const), ...(rng() < 0.5 ? { comment: `c${ri(9)}` } : {}) } },
        { type: "propose", data: { proposer: aliceAddr, action: { type: "collective_message", data: { message: `x${ri(9)}` } } } },
      ]));
      expect(unwrap(hashCommandTxs(txs))).toBe(hashEntityCommandTxs(txs.map(wire)));
      const body = { version: 1 as const, entityId: `0x${ri(1e9).toString(16).padStart(64, "0")}`, stackKey: UNREGISTERED_ENTITY_COMMAND_STACK_KEY, boardHash: `0x${ri(1e9).toString(16).padStart(64, "1")}`, boardEpoch: ri(5),
        authorSignerId: aliceAddr.toLowerCase(), authorSigner: aliceAddr.toLowerCase(), nonce: BigInt(1 + ri(20)), txsHash: unwrap(hashCommandTxs(txs)), txs };
      expect(unwrap(hashCommand(body))).toBe(hashEntityCommand({ ...body, txs: txs.map(wire) }));
    }
    expect(certifiedBoardStackKey({ chainId: 31337, depositoryAddress: JUR.depositoryAddress, entityProviderAddress: "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512" }))
      .toBe(getCertifiedBoardStackKey({ chainId: 31337, depositoryAddress: JUR.depositoryAddress, entityProviderAddress: "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512" }));
    const r = lazyEntity([[aliceAddr, 1n], [bobAddr, 2n], [carolAddr, 1n]], 3n);
    const board = resolveEntityCommandBoard(env, ogState(r.state, 0));
    expect(configBoardHash(r.state.quorum)).toBe(board.boardHash);
    const action: ProposalAction = { type: "collective_message", data: { message: "hello" } };
    for (let n = 1n; n < 4n; n++) {
      const fence = n === 1n ? {} : { entityCommandNonces: { version: 1, boardHash: board.boardHash, boardEpoch: 0, bySigner: new Map([[bobAddr.toLowerCase(), { nonce: n - 1n, commandHash: `0x${"ab".repeat(32)}` }]]) } };
      expect(proposalId(unwrap(hashProposalAction(action)), bobAddr.toLowerCase(), board, n)).toBe(generateProposalId(env, action, bobAddr, { ...ogState(r.state, 0), ...fence }));
    }
  });
  test("MATCH: buildEntityTransactionProposalAction / hashEntityProposalAction over 150 random collective batches (numeric token ids on the wire)", () => {
    const tok = (n: number) => unwrap(tokenId(String(n)));
    for (let i = 0; i < 150; i++) {
      const txs: EntityTx[] = Array.from({ length: 1 + ri(3) }, () => pick<EntityTx>([
        { type: "chatMessage", data: { message: `n${ri(9)}`, timestamp: ri(100) } },
        { type: "extendCredit", data: { counterpartyEntityId: BOB, tokenId: tok(1 + ri(3)), amount: BigInt(ri(1000)) } },
        { type: "requestCollateral", data: { counterpartyEntityId: BOB, tokenId: tok(1 + ri(3)), amount: BigInt(ri(1000)), feeAmount: 1n, policyVersion: 1, ...(rng() < 0.5 ? { feeTokenId: tok(2) } : {}) } },
        { type: "profile-update", data: { profile: { entityId: ALICE, name: `n${ri(9)}` } } },
        { type: "openAccount", data: { targetEntityId: BOB, accountDomain: JUR, watchSeed: TERMS.watchSeed, disputeConfig: TERMS.disputeConfig, ...(rng() < 0.5 ? { tokenId: tok(2), creditAmount: 7n } : {}) } },
      ]));
      const action = unwrap(entityTransactionAction(txs)), og = buildEntityTransactionProposalAction(txs.map(wire));
      expect(action.type === "entity_transaction" ? action.data.actionHash : "").toBe(og.data.actionHash);
      expect(unwrap(hashProposalAction(action))).toBe(hashEntityProposalAction(og));
    }
    // a protocol or individual tx inside a collective action is og ENTITY_COLLECTIVE_ACTION_TX_FORBIDDEN
    const chat: EntityTx = { type: "chat", data: { from: aliceAddr, message: "x" } };
    expect(entityTransactionAction([chat])).toEqual({ ok: false, error: { _tag: "entity_invariant", reason: "ENTITY_COLLECTIVE_ACTION_TX_FORBIDDEN:chat" } });
    expect(() => buildEntityTransactionProposalAction([chat as never])).toThrow("ENTITY_COLLECTIVE_ACTION_TX_FORBIDDEN:chat");
  });
});

describe(seedTag("entity-txs-3: signed commands, propose and vote (og command/index.ts, system/basic.ts)"), () => {
  test("MATCH: 40 random governance runs (random board, 25 commands each, tampering) -- same accept / evict / refuse class, same proposals, nonces, events and profile as og", () => {
    let accepted = 0, rejected = 0, fatal = 0, executed = 0;
    for (let run = 0; run < 24; run++) {
      const n = 1 + ri(3), members = SIGNERS.slice(0, n).map((a) => [a, BigInt(1 + ri(3))] as const);
      const total = members.reduce((s, [, x]) => s + x, 0n), threshold = 1n + BigInt(ri(Number(total)));
      let r = lazyEntity(members, threshold);
      let og = ogState(r.state, 0);
      const history: EntityCommand[] = [];
      for (let step = 0; step < 20; step++) {
        const timestamp = NOW + BigInt(step);
        og = { ...og, timestamp: Number(timestamp) };
        const [author] = pick(members), who = author.toLowerCase();
        const proposals = [...((r.state.committed["proposals"] as ReadonlyMap<string, unknown> | undefined) ?? new Map()).keys()];
        const collective: EntityTx[] = Array.from({ length: 1 + ri(2) }, () => pick<EntityTx>([
          { type: "chatMessage", data: { message: `c${ri(9)}`, timestamp: ri(9) } },
          { type: "profile-update", data: { profile: { entityId: r.state.id, name: `N${ri(9)}`, ...(rng() < 0.3 ? { sectors: ["finance"] } : {}) } } },
        ]));
        const action: ProposalAction = rng() < 0.4 ? { type: "collective_message", data: { message: `msg${ri(9)}` } } : unwrap(entityTransactionAction(collective));
        const kind = ri(10);
        const txs: EntityTx[] = kind < 4 ? [{ type: "propose", data: { proposer: rng() < 0.05 ? pick(SIGNERS) : author, action } }]
          : kind < 8 ? [{ type: "vote", data: { proposalId: proposals.length > 0 && rng() < 0.9 ? pick(proposals) : "prop_missing", voter: author, choice: rng() < 0.7 ? "yes" : "no", ...(rng() < 0.3 ? { comment: "ok" } : {}) } }]
          : kind < 9 ? [{ type: "chat", data: { from: author, message: rng() < 0.1 ? "" : "hi" } }]
          : [{ type: "chatMessage", data: { message: "direct", timestamp: 1 } }];
        let command: EntityCommand;
        const built = buildCommand(r.state, author, txs, signAs(author));
        if (!built.ok) {
          // the author's own builder refuses what og's builder refuses (a collective tx in a command, a foreign author binding)
          expect(["entity_command", "entity_invariant"]).toContain(built.error._tag);
          const body = { version: 1 as const, entityId: r.state.id, stackKey: UNREGISTERED_ENTITY_COMMAND_STACK_KEY, boardHash: configBoardHash(r.state.quorum), boardEpoch: 0, authorSignerId: who, authorSigner: who, nonce: 1n, txsHash: unwrap(hashCommandTxs(txs)), txs };
          command = { ...body, signature: `0x${unwrap(crypto.sign(unwrap(hashCommand(body)) as Hash, author))}` };
        } else command = built.value;
        const tamper = ri(12);
        if (tamper === 0 && history.length > 0) command = pick(history); // an old slot: exact retry or a cancel
        if (tamper === 1) { const body = { ...command, nonce: command.nonce + 1n }; command = { ...body, signature: `0x${unwrap(crypto.sign(unwrap(hashCommand(body)) as Hash, author))}` }; }
        if (tamper === 2) { const other = pick(SIGNERS); command = { ...command, signature: `0x${unwrap(crypto.sign(unwrap(hashCommand(command)) as Hash, other))}` }; }
        if (tamper === 3) command = { ...command, boardHash: `0x${"11".repeat(32)}` };
        const ogOut = ogApplyCommand(og, wire({ type: "entityCommand", data: command }).data);
        const rw = foldTxs(r.state, r.accountReplicas, [{ type: "entityCommand", data: command }], { verify: hankoVerify, timestamp });
        if ("error" in ogOut) {
          expect(rw.ok ? "ok" : (rw.error as EntityError)._tag).toBe(ogOut.error);
          if (ogOut.error === "entity_command") rejected++; else fatal++;
          continue;
        }
        if (!rw.ok) throw new Error(`rewrite refused what og accepted: ${JSON.stringify(rw.error)} / ${JSON.stringify(txs.map((t) => t.type))}`);
        accepted++;
        const d = rw.value.draft;
        expect(bytes(d.state.committed["proposals"] ?? new Map())).toBe(bytes(ogOut.state.proposals));
        expect(bytes(d.state.committed["entityCommandNonces"] ?? null)).toBe(bytes(ogOut.state.entityCommandNonces ?? null));
        expect(d.events ?? []).toEqual(readEntityFrameEvents(ogOut.state) as never);
        if ((d.events ?? []).length > 0 && txs[0]?.type !== "chat") executed++;
        if (d.state.committed["profile"] !== undefined) expect(d.state.committed["profile"]).toEqual(ogOut.state.profile);
        history.push(command);
        r = { ...r, state: d.state };
        og = { ...ogOut.state, ...{ ["__xlnEntityFrameEvents"]: [] } };
      }
    }
    expect(accepted).toBeGreaterThan(100);
    expect(rejected).toBeGreaterThan(20);
    expect(fatal).toBeGreaterThan(20);
    expect(executed).toBeGreaterThan(10);
  }, 60_000);
  test("MATCH: og assertSignedEntityCommand accepts the rewrite's authorEntityTxs output; a 2-of-3 board's collective tx waits for a vote, then executes", () => {
    const r = lazyEntity([[aliceAddr, 1n], [bobAddr, 1n], [carolAddr, 1n]], 2n);
    const profile: EntityTx = { type: "profile-update", data: { profile: { entityId: r.state.id, name: "Board" } } };
    const authored = unwrap(authorEntityTxs(r.state, aliceAddr, [profile, { type: "chat", data: { from: aliceAddr, message: "hello" } }], signAs(aliceAddr)));
    expect(authored.map((t) => t.type)).toEqual(["entityCommand", "entityCommand"]);
    const [first, second] = authored as [Extract<EntityTx, { type: "entityCommand" }>, Extract<EntityTx, { type: "entityCommand" }>];
    expect(first.data.txs[0]?.type).toBe("propose");
    expect(first.data.nonce).toBe(1n);
    expect(second.data.nonce).toBe(2n);
    const ogAfterFirst = ogApplyCommand(ogState(r.state, Number(NOW)), wire(first).data);
    if ("error" in ogAfterFirst) throw new Error(ogAfterFirst.message);
    expect(() => assertSignedEntityCommand(env, ogAfterFirst.state, wire(second).data)).not.toThrow();
    const folded = unwrap(foldTxs(r.state, r.accountReplicas, authored, { verify: hankoVerify, timestamp: NOW })).draft;
    const pending = [...(folded.state.committed["proposals"] as ReadonlyMap<string, unknown>).keys()];
    expect(pending.length).toBe(1);
    expect(folded.state.committed["profile"]).toBeUndefined();
    expect(folded.events).toEqual([{ type: "text", validatorId: aliceAddr.toLowerCase(), message: "hello" }]);
    const vote = unwrap(authorEntityTxs(folded.state, bobAddr, [{ type: "vote", data: { proposalId: pending[0] as string, voter: bobAddr, choice: "yes" } }], signAs(bobAddr)));
    const voted = unwrap(foldTxs(folded.state, folded.accountReplicas, vote, { verify: hankoVerify, timestamp: NOW + 1n })).draft;
    expect((voted.state.committed["proposals"] as ReadonlyMap<string, unknown>).size).toBe(0);
    expect(voted.state.committed["profile"]).toMatchObject({ name: "Board" });
  });
  test("MATCH (og createEntityFrameHashFromStateRoot): a frame carrying a signed collective command hashes like og, its events included", () => {
    // [A, B] with threshold 1: A's own share executes the proposal at once, and the 2-member board holds the frame so it can be inspected
    const r = lazyEntity([[aliceAddr, 1n], [bobAddr, 1n]], 1n);
    const authored = unwrap(authorEntityTxs(r.state, aliceAddr, [{ type: "profile-update", data: { profile: { entityId: r.state.id, name: "Solo" } } }, { type: "chatMessage", data: { message: "note", timestamp: 1 } }], signAs(aliceAddr)));
    const p = unwrap(applyEntityInput(r, { kind: "txs", timestamp: NOW, txs: [...authored, { type: "chatMessage", data: { message: "raw", timestamp: 2 } }] }, { ...verifiers, self: r.state.id, signerId: aliceAddr })).replica;
    if (p._tag !== "proposed") throw new Error("phase");
    expect(p.draft.state.committed["profile"]).toMatchObject({ name: "Solo" });
    const ogOut = ogApplyCommand(ogState(r.state, Number(NOW)), wire(authored[0] as EntityTx).data);
    if ("error" in ogOut) throw new Error(ogOut.message);
    handleChatMessageEntityTx(ogOut.state, { type: "chatMessage", data: { message: "raw", timestamp: 2 } } as never, true);
    const ogEvents = readEntityFrameEvents(ogOut.state);
    expect(p.frame.events).toEqual(ogEvents as never);
    expect(bytes(p.draft.state.committed["entityCommandNonces"])).toBe(bytes(ogOut.state.entityCommandNonces));
    expect<string>(unwrap(hashEntityFrame(p.frame))).toBe(createEntityFrameHashFromStateRoot("genesis", 1, Number(NOW), p.frame.txs.map(wire), ogEvents, r.state.id, p.frame.stateRoot, p.frame.authorityRoot, p.frame.entityContext as never));
  });
  test("MATCH: plain propose / vote outside a command are og ENTITY_COMMAND_REQUIRED (a plain Error: the input is refused)", () => {
    const r = lazyEntity([[aliceAddr, 1n]], 1n);
    const out = foldTxs(r.state, r.accountReplicas, [{ type: "propose", data: { proposer: aliceAddr, action: { type: "collective_message", data: { message: "m" } } } }], { verify: hankoVerify, timestamp: NOW });
    expect(out).toEqual({ ok: false, error: { _tag: "entity_invariant", reason: "ENTITY_COMMAND_REQUIRED:propose" } });
    // og with a non-lazy Entity id and no certified board record: ENTITY_COMMAND_CERTIFIED_BOARD_REQUIRED
    const numbered = unwrap(createEntity({ id: ALICE, jurisdiction: JUR, threshold: 1n, members: new Map([[bobAddr, { shares: 1n }]]) }));
    expect(buildCommand(numbered.state, bobAddr, [{ type: "chat", data: { from: bobAddr, message: "x" } }], signAs(bobAddr))).toEqual({ ok: false, error: { _tag: "entity_invariant", reason: `ENTITY_COMMAND_CERTIFIED_BOARD_REQUIRED:${ALICE}` } });
    expect(() => resolveEntityCommandBoard(env, ogState(numbered.state, 0))).toThrow(`ENTITY_COMMAND_CERTIFIED_BOARD_REQUIRED:${ALICE}`);
    void checkCommand;
  });
});

describe(seedTag("entity-txs-3: frame events (og frame-events.ts, certified in the Entity frame hash)"), () => {
  test("MATCH: extendCredit and lending entity txs record og's status events", () => {
    const a = lazyEntity([[aliceAddr, 1n]], 1n);
    const opened = unwrap(applyEntityInput(a, { kind: "txs", timestamp: NOW, txs: [{ type: "openAccount", data: { targetEntityId: BOB, accountDomain: JUR, watchSeed: TERMS.watchSeed, disputeConfig: TERMS.disputeConfig } }] }, { ...verifiers, self: a.state.id, signerId: aliceAddr })).replica;
    const tok = unwrap(tokenId("1"));
    const cases: readonly [EntityTx, (s: any) => any][] = [
      [{ type: "extendCredit", data: { counterpartyEntityId: BOB, tokenId: tok, amount: 55n } }, (s) => handleExtendCreditEntityTx(s, { type: "extendCredit", data: { counterpartyEntityId: BOB, tokenId: 1, amount: 55n } } as never, true)],
      [{ type: "lendingBorrow", data: { requestId: "borrow-00000000000000a1", hubEntityId: BOB, tokenId: tok, amount: 9n, termId: "1d" } }, (s) => handleLendingBorrowEntityTx(s, { type: "lendingBorrow", data: { requestId: "borrow-00000000000000a1", hubEntityId: BOB, tokenId: 1, amount: 9n, termId: "1d" } } as never, true)],
      [{ type: "lendingClosePosition", data: { hubEntityId: BOB, positionId: "lend-00000000000000c3" } }, (s) => handleLendingClosePositionEntityTx(s, { type: "lendingClosePosition", data: { hubEntityId: BOB, positionId: "lend-00000000000000c3" } } as never, true)],
    ];
    for (const [tx, ogRun] of cases) {
      const d = unwrap(foldTxs(opened.state, opened.accountReplicas, [tx], { verify: hankoVerify, timestamp: NOW + 1n })).draft;
      const ogS: any = { entityId: a.state.id, config: ogConfig(a.state), accounts: new Map([[BOB, { state: { deltas: new Map([[1, {}]]) } }]]) };
      ogRun(ogS);
      expect(d.events).toEqual(readEntityFrameEvents(ogS) as never);
    }
  });
});

// ---- H7-b shadow rebalance policy, setHubConfig, setRebalancePolicy (og lifecycle/open-account.ts, lifecycle/admin.ts, request-collateral.ts) ----
const openTx = (extra: Record<string, unknown> = {}, target: EntityId = BOB): EntityTx =>
  ({ type: "openAccount", data: { targetEntityId: target, accountDomain: JUR, watchSeed: TERMS.watchSeed, disputeConfig: TERMS.disputeConfig, ...extra } }) as EntityTx;
const ogPolicyRoot = (entries: readonly (readonly [number, unknown])[]): string => PersistentAccountStateMap.fromEntries("rebalanceShadowPolicy", entries as never).rootHash();
const ogThrows = <T>(f: () => T): { ok: true; value: T } | { ok: false; reason: string } => { try { return { ok: true, value: f() }; } catch (e) { return { ok: false, reason: (e as Error).message }; } };
const reasonOf = (e: EntityError): string => (e._tag === "entity_invariant" ? e.reason : e._tag);

describe(seedTag("entity-txs-3: shadow rebalance policy root (og seedOpenAccountPolicies, createInboundAccountState)"), () => {
  test("MATCH: openAccount seeds og's policy map (requested policy, jurisdiction whole-USD defaults, token decimals); the leaf policyRoot equals og's PersistentAccountStateMap root, 120 random cases", () => {
    const a = lazyEntity([[aliceAddr, 1n]], 1n);
    for (let i = 0; i < 120; i++) {
      const usd = rng() < 0.4 ? undefined : { r2cRequestSoftLimit: pick([0, 1, 250.7, 500, -3]), hardLimit: pick([1, 900, 10_000, 250]), maxFee: pick([0, 15, 2.5, -1]) };
      const tok = 1 + ri(6), requested = tok <= 5 && rng() < 0.5 ? { r2cRequestSoftLimit: BigInt(pick([-1, 0, 5, 100])), hardLimit: BigInt(pick([4, 100, 500])), maxAcceptableFee: BigInt(pick([-2, 0, 9])) } : undefined;
      const state: EntityState = { ...a.state, jurisdictionConfig: { entityProviderAddress: "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512", ...(usd === undefined ? {} : { rebalancePolicyUsd: usd }) } };
      const rw = foldTxs(state, a.accountReplicas, [openTx({ tokenId: unwrap(tokenId(String(tok))), ...(requested === undefined ? {} : { rebalancePolicy: requested }) })], { verify: hankoVerify, timestamp: NOW });
      const og = ogThrows(() => {
        if (requested !== undefined && (requested.r2cRequestSoftLimit <= 0n || requested.hardLimit < requested.r2cRequestSoftLimit || requested.maxAcceptableFee < 0n)) throw new Error(`REBALANCE_POLICY_INVALID:token=${tok}`);
        const jur = usd === undefined ? undefined : { rebalancePolicyUsd: usd };
        return ogPolicyRoot([...new Set([tok, ...OG_DEFAULT_TOKEN_IDS])].map((t) => [t, requested !== undefined && t === tok ? requested : resolveJurisdictionRebalanceDefaults(jur as never, t)] as const));
      });
      if (!og.ok) { expect(rw.ok ? "ok" : reasonOf(rw.error)).toBe(og.reason); continue; }
      const child = unwrap(rw).draft.accountReplicas.get(BOB);
      if (child === undefined) throw new Error("no account");
      expect(unwrap(installedAccount(state.id, BOB, child)).policyRoot).toBe(og.value);
    }
  });
  test("MATCH: the inbound peer seeds og's defaults for DEFAULT_ACCOUNT_TOKEN_IDS and both policy maps survive the Account phase changes", () => {
    const alice = unwrap(createEntity({ id: ALICE, jurisdiction: JUR, threshold: 1n, members: new Map([[aliceAddr, { shares: 1n }]]) }));
    const bob = unwrap(createEntity({ id: BOB, jurisdiction: JUR, threshold: 1n, members: new Map([[bobAddr, { shares: 1n }]]) }));
    let rt = spawn(spawn(createRuntime(), alice), bob);
    const run = (entityInputs: Parameters<typeof applyRuntime>[1]["entityInputs"]) => { const out = unwrap(applyRuntime(rt, { runtimeTxs: [], entityInputs }, verifiers)); rt = out.runtime; return out.outbox; };
    const outbox = run([{ entityId: ALICE, signerId: aliceAddr, input: { kind: "txs", timestamp: NOW, txs: [openTx()] } }]);
    const back = run(outbox.map((o) => unwrap(convertOutput(rt, o, ALICE, NOW + 2n))));
    run(back.map((o) => unwrap(convertOutput(rt, o, BOB, NOW + 3n))));
    const defaults = ogPolicyRoot(OG_DEFAULT_TOKEN_IDS.map((t) => [t, resolveJurisdictionRebalanceDefaults(undefined, t)] as const));
    for (const [self, peer, signer] of [[ALICE, BOB, aliceAddr], [BOB, ALICE, bobAddr]] as const) {
      const child = rt.entities.get(replicaKey(self, signer))?.accountReplicas.get(peer);
      if (child === undefined) throw new Error("no account");
      expect(child._tag).toBe("open");
      expect(unwrap(installedAccount(self, peer, child)).policyRoot).toBe(defaults);
    }
  });
});

describe(seedTag("entity-txs-3: setHubConfig / setRebalancePolicy (og lifecycle/admin.ts)"), () => {
  const PEER2 = `0x${"ab".repeat(32)}` as EntityId;
  const withDeltas = (d: { readonly accountReplicas: ReadonlyMap<EntityId, AccountReplica> }, tokens: ReadonlyMap<EntityId, readonly number[]>): Map<EntityId, AccountReplica> =>
    new Map([...d.accountReplicas].map(([peer, c]) => [peer, { ...c, state: { ...c.state, account: { ...c.state.account, deltas: new Map((tokens.get(peer) ?? []).map((t) => { const k = unwrap(tokenId(String(t))); return [k, { tokenId: k, collateral: 0n, ondelta: 0n, offdelta: 0n, leftCreditLimit: 0n, rightCreditLimit: 0n }]; })) } } } as AccountReplica]));
  test("MATCH: buildHubConfig validation, committed config, isHub profile, event and the per-Account per-token rebalance_policy queue equal og handleSetHubConfigEntityTx over 150 random chained configs", () => {
    const a = lazyEntity([[aliceAddr, 1n]], 1n);
    const opened = unwrap(foldTxs(a.state, a.accountReplicas, [openTx(), openTx({}, PEER2)], { verify: hankoVerify, timestamp: NOW })).draft;
    const tokens = new Map<EntityId, readonly number[]>([[BOB, [3, 1]], [PEER2, [2]]]);
    let state = opened.state;
    const replicas = withDeltas(opened, tokens);
    let ogS: any = { ...ogState(state, 1), accounts: new Map([...tokens].map(([peer, ts]) => [peer, { state: { deltas: new Map(ts.map((t) => [t, {}])) } }])) };
    let checked = 0;
    for (let i = 0; i < 150; i++) {
      const data = {
        ...(rng() < 0.3 ? { hubName: pick([" hub ", "", "H2"]) } : {}), ...(rng() < 0.4 ? { matchingStrategy: pick(["amount", "time", "fee"] as const) } : {}),
        ...(rng() < 0.4 ? { policyVersion: pick([0, 1, 2, 3, 5, 1.5, i]) } : {}), ...(rng() < 0.3 ? { routingFeePPM: ri(100) } : {}), ...(rng() < 0.3 ? { baseFee: BigInt(ri(9)) } : {}),
        ...(rng() < 0.4 ? { swapTakerFeeBps: pick([-5, 0, 7, 20_000, 3.7]) } : {}), ...(rng() < 0.2 ? { disputeAutoFinalizeMode: pick(["auto", "ignore"] as const) } : {}),
        ...(rng() < 0.5 ? { rebalanceLiquidityFeeBps: pick([-1n, 0n, 1n, 25n, 10_000n, 10_001n]) } : {}), ...(rng() < 0.08 ? { rebalanceGasFee: 1n } : {}), ...(rng() < 0.05 ? { c2rWithdrawSoftLimit: 2n } : {}),
      };
      const rw = foldTxs(state, replicas, [{ type: "setHubConfig", data }], { verify: hankoVerify, timestamp: NOW });
      const og = ogThrows(() => handleSetHubConfigEntityTx(env, structuredClone(ogS), { type: "setHubConfig", data } as never, true));
      if (!og.ok) { expect(rw.ok ? "ok" : reasonOf(rw.error)).toBe(og.reason); continue; }
      const d = unwrap(rw).draft;
      expect<unknown>(d.state.committed["hubRebalanceConfig"]).toEqual(og.value.newState.hubRebalanceConfig);
      expect((d.state.committed["profile"] as { isHub?: boolean }).isHub).toBe(true);
      expect(d.events).toEqual(readEntityFrameEvents(og.value.newState) as never);
      const queued = [...d.accountReplicas].sort(([x], [y]) => (x < y ? -1 : 1)).flatMap(([peer, c]) => c.mempool.slice(replicas.get(peer)?.mempool.length ?? 0).map((t) => ({ accountId: peer, tx: t })));
      expect(queued.map(({ accountId, tx }) => ({ accountId, tx: { type: tx.type, data: { ...(tx as any), type: undefined, tokenId: Number((tx as any).tokenId) } } })))
        .toEqual((og.value.accountTxs ?? []).map(({ accountId, tx }: any) => ({ accountId, tx: { type: tx.type, data: { ...tx.data, type: undefined } } })));
      expect(d.outputs.filter((o) => !("tx" in o)).length).toBe(og.value.outputs.length);
      // og admission dedups identical lifecycle txs later (local-tx-admission.ts); start each round from the opened mempools
      state = d.state; ogS = { ...og.value.newState, __xlnEntityFrameEvents: undefined }; checked++;
    }
    expect(checked).toBeGreaterThan(40);
  }, 60_000);
  test("MATCH: setRebalancePolicy updates the leaf policy (og applyAccountEnvelopeUpdate) and, without a hub config, checkAutoRebalance queues og's request_collateral, 300 random Accounts", () => {
    const a = lazyEntity([[aliceAddr, 1n]], 1n);
    const opened = unwrap(foldTxs(a.state, a.accountReplicas, [openTx()], { verify: hankoVerify, timestamp: NOW })).draft;
    const base = opened.accountReplicas.get(BOB);
    if (base === undefined) throw new Error("no account");
    const selfIsLeft = base.state.account.id.left === a.state.id;
    let queuedAny = 0;
    for (let i = 0; i < 300; i++) {
      const tok = pick([1, 2, 3]), k = unwrap(tokenId(String(tok)));
      const delta = { tokenId: k, collateral: BigInt(ri(3) * 1000), ondelta: BigInt(ri(5) * 400 - 800), offdelta: BigInt(ri(5) * 500 - 1000), leftCreditLimit: 0n, rightCreditLimit: 0n };
      const fee = rng() < 0.85 ? { policyVersion: 1 + ri(3), baseFee: BigInt(ri(40)), liquidityFeeBps: BigInt(pick([0, 10, 100, 5000])), gasFee: BigInt(ri(20)), updatedAt: 1 } : undefined;
      const requested = rng() < 0.15 ? 5n : 0n, queuedReq = rng() < 0.1, pending = rng() < 0.1;
      const policy = { r2cRequestSoftLimit: BigInt(pick([-1, 0, 100, 700, 2000])), hardLimit: BigInt(pick([100, 700, 5000])), maxAcceptableFee: BigInt(pick([-1, 0, 30, 500, 10_000])) };
      const deltas = rng() < 0.9 ? new Map([[k, delta]]) : new Map();
      const body = { ...base.state, account: { ...base.state.account, deltas }, feePolicies: fee === undefined ? new Map() : new Map([[k, selfIsLeft ? { right: fee } : { left: fee }]]), requested: requested > 0n ? new Map([[k, requested]]) : new Map() };
      const mempool = queuedReq ? [{ type: "request_collateral", tokenId: k, amount: 1n, feeAmount: 0n, policyVersion: 1 } as never] : [];
      const child = { ...base, _tag: pending ? "proposed" : "open", state: body, mempool } as AccountReplica;
      const tx: EntityTx = { type: "setRebalancePolicy", data: { counterpartyEntityId: BOB, tokenId: k, ...policy } };
      const rw = foldTxs(opened.state, new Map([[BOB, child]]), [tx], { verify: hankoVerify, timestamp: NOW });
      const ogAcc: any = {
        state: { leftEntity: base.state.account.id.left, rightEntity: base.state.account.id.right, deltas: PersistentAccountStateMap.fromEntries("deltas", [...deltas].map(([t, d]) => [Number(t), { ...d, tokenId: Number(t), leftAllowance: 0n, rightAllowance: 0n, leftHold: 0n, rightHold: 0n }]) as never),
          requestedRebalance: PersistentAccountStateMap.fromEntries("requestedRebalance", [...body.requested].map(([t, v]) => [Number(t), v]) as never), rebalanceFeePolicies: PersistentAccountStateMap.fromEntries("rebalanceFeePolicies", [...body.feePolicies].map(([t, v]) => [Number(t), v]) as never) },
        shadow: { rebalance: { policy: PersistentAccountStateMap.fromEntries("rebalanceShadowPolicy", [...(base.rebalancePolicy ?? new Map())] as never), submittedAtByToken: PersistentAccountStateMap.empty("rebalanceShadowSubmitted") } }, pendingWithdrawals: PersistentAccountStateMap.empty("pendingWithdrawals"), proofHeader: { fromEntity: a.state.id, toEntity: BOB, nextProofNonce: 1 }, currentHeight: 0, status: "active",
        mempool: mempool.map((m: any) => ({ type: m.type, data: { ...m, tokenId: Number(m.tokenId) } })), ...(pending ? { pendingFrame: {} } : {}),
      };
      // og writes Accounts only through the frame's candidate map (getEntityAccountForWrite)
      const ogS: any = { entityId: a.state.id, config: ogConfig(a.state), accounts: new EntityAccountCandidateMap(PersistentEntityAccountMap.fromEntries([[BOB, ogAcc]], a.state.id, () => ZERO_WORD as never)) };
      const og = ogThrows(() => handleSetRebalancePolicyEntityTx(env, ogS, { type: "setRebalancePolicy", data: { counterpartyEntityId: BOB, tokenId: tok, ...policy } } as never, true));
      if (!og.ok) { expect(rw.ok ? "ok" : reasonOf(rw.error)).toBe(og.reason); continue; }
      const d = unwrap(rw).draft, after = d.accountReplicas.get(BOB);
      if (after === undefined) throw new Error("no account");
      const ogAfter = og.value.newState.accounts.get(BOB);
      if (ogAfter === undefined) throw new Error("og lost the account");
      expect(unwrap(installedAccount(a.state.id, BOB, after)).policyRoot).toBe(ogRootHash(ogAfter.shadow.rebalance.policy));
      // the same Entity frame proposes the queued request as the next Account frame (og proposePendingAccountFrames)
      const queued = after._tag === "proposed" && child._tag === "open" ? after.candidate.frame.txs : after.mempool.slice(mempool.length);
      expect(queued.map((t: any) => ({ type: t.type, data: { ...t, type: undefined, tokenId: Number(t.tokenId), feeTokenId: Number(t.feeTokenId) } })))
        .toEqual((og.value.accountTxs ?? []).map(({ tx }) => ({ type: tx.type, data: { ...tx.data, type: undefined } })));
      expect(d.outputs.filter((o) => !("tx" in o)).length).toBe(og.value.outputs.length);
      queuedAny += og.value.accountTxs?.length ?? 0;
    }
    expect(queuedAny).toBeGreaterThan(5);
  });
  test("MATCH: a hub's openAccount queues og buildHubRebalancePolicyTx per token between the add_deltas and the credit line", () => {
    const a = lazyEntity([[aliceAddr, 1n]], 1n);
    const hub = unwrap(foldTxs(a.state, a.accountReplicas, [{ type: "setHubConfig", data: { rebalanceLiquidityFeeBps: 7n } }], { verify: hankoVerify, timestamp: NOW })).draft;
    const d = unwrap(foldTxs(hub.state, hub.accountReplicas, [openTx({ tokenId: unwrap(tokenId("2")), creditAmount: 9n })], { verify: hankoVerify, timestamp: NOW + 1n })).draft;
    const child = d.accountReplicas.get(BOB);
    if (child === undefined || child._tag !== "proposed") throw new Error("no proposal");
    const cfg = hub.state.committed["hubRebalanceConfig"] as never, ids = [2, 1, 3];
    const og = [...ids.map((t) => ({ type: "add_delta", data: { tokenId: t } })), ...ids.map((t) => buildHubRebalancePolicyTx(cfg, t)), { type: "set_credit_limit", data: { tokenId: 2, amount: 9n } }];
    expect(child.candidate.frame.txs.map((t: any) => ({ type: t.type, data: { ...t, type: undefined, tokenId: Number(t.tokenId), ...(t.limit === undefined ? {} : { limit: undefined, amount: t.limit }) } })))
      .toEqual(og.map((t: any) => ({ type: t.type, data: { ...t.data, type: undefined } })));
  });
  test("MATCH: setRebalancePolicy on a missing Account is og's no-op", () => {
    const a = lazyEntity([[aliceAddr, 1n]], 1n);
    const d = unwrap(foldTxs(a.state, a.accountReplicas, [{ type: "setRebalancePolicy", data: { counterpartyEntityId: BOB, tokenId: unwrap(tokenId("1")), r2cRequestSoftLimit: -1n, hardLimit: 0n, maxAcceptableFee: 0n } }], { verify: hankoVerify, timestamp: NOW })).draft;
    const og = handleSetRebalancePolicyEntityTx(env, { entityId: a.state.id, accounts: new Map() } as never, { type: "setRebalancePolicy", data: { counterpartyEntityId: BOB, tokenId: 1, r2cRequestSoftLimit: -1n, hardLimit: 0n, maxAcceptableFee: 0n } } as never, true);
    expect([d.outputs.length, d.accountReplicas.size]).toEqual([og.outputs.length, 0]);
  });
});

describe(seedTag("entity-txs-3: J7 dispute J events reach the Account (og j-events.ts applyDisputeStartedJEvent / applyDisputeFinalizedJEvent)"), () => {
  /** og applyStartedDisputeAccountInput / resolveFinalizationEvidence (no evidence rows) field mapping, then og's own envelope builders and Account finality. */
  const ogAccount = (jNonce: number): any => ({
    state: { leftEntity: lower(ALICE), rightEntity: lower(BOB), domain: { ...TERMS.domain }, disputeConfig: { ...TERMS.disputeConfig }, jNonce, deltas: PersistentAccountStateMap.empty("deltas"), locks: PersistentAccountStateMap.empty("locks"),
      swapOffers: PersistentAccountStateMap.empty("swapOffers"), pulls: PersistentAccountStateMap.empty("pulls") },
    status: "active", mempool: [], proofHeader: { fromEntity: lower(ALICE), toEntity: lower(BOB), nextProofNonce: 1 },
  });
  const lower = (s: string): string => s.toLowerCase();
  test("MATCH: 120 random DisputeStarted / DisputeFinalized events: the account resolution, the frozen proof-body check and the resulting Account finality equal og's", () => {
    const host0 = unwrap(genesisHost(ALICE, genesisAB()) as any) as any;
    const proof: any = unwrap(localProof(unwrap(committedView(host0.account.state))) as any);
    const L = BigInt(TERMS.disputeConfig.leftResponseSeconds), R = BigInt(TERMS.disputeConfig.rightResponseSeconds);
    let started = 0, finalized = 0;
    for (let i = 0; i < 120; i++) {
      const [sender, counterentity] = pick([[BOB, ALICE], [ALICE, BOB], [CAROL, ALICE], [ALICE, CAROL]] as const);
      const goodHash = rng() < 0.85, nonce = BigInt(ri(6)), t0 = BigInt(1_000 + ri(50)), skew = rng() < 0.15 ? 1n : 0n, jNonce0 = ri(4);
      const bodyHash = goodHash ? proof.bodyHash : `0x${"9".repeat(64)}`;
      const host = { ...host0, account: { ...host0.account, state: { ...host0.account.state, jNonce: jNonce0 } } };
      const ctx = { timestamp: NOW, jHeight: 0n };
      if (rng() < 0.5) {
        const event = { type: "DisputeStarted", sender, counterentity, nonce, proposerIsLeft: rng() < 0.5, proofbodyHash: bodyHash, watchSeed: TERMS.watchSeed, starterInitialArguments: "0x", starterCounterArguments: "0x",
          starterCounterProofCommitment: ZERO_WORD, disputeTimeout: t0 + L + R + skew, disputeStartTimestamp: t0, leftResponseSeconds: L, rightResponseSeconds: R, initialProofbody: proof.body, batchNonce: ri(3) };
        const rw = applyHost(host, { layer: "j", tx: { type: "j_event", blockNumber: 7, event } } as any, ctx, hankoVerify);
        const og = ogThrows(() => {
          const counterparty = lower(sender) === lower(ALICE) ? lower(counterentity) : lower(sender);
          if (counterparty !== lower(BOB)) return undefined;
          if (!goodHash) throw new Error("DISPUTE_FROZEN_ACCOUNT_STATE_MISMATCH");
          const acc = ogAccount(jNonce0);
          const input: any = createAccountDisputeStartedInput(acc.state, lower(ALICE), { kind: "dispute_started", starterEntityId: lower(sender), initialProofbodyHash: bodyHash, initialNonce: Number(nonce), initialProposerIsLeft: event.proposerIsLeft,
            disputeTimeout: Number(event.disputeTimeout), disputeStartTimestamp: Number(t0), leftResponseSeconds: Number(L), rightResponseSeconds: Number(R), jNonce: Number(nonce), starterInitialArguments: "0x", starterCounterArguments: "0x",
            starterCounterProofCommitment: ZERO_WORD, observedBlockNumber: 7, batchNonce: event.batchNonce } as any);
          applyAccountDisputeStarted(acc, input.finality);
          return { input, acc };
        });
        if (!og.ok) { expect(rw.ok).toBe(false); continue; }
        const after: any = unwrap(rw as any);
        if (og.value === undefined) { expect(after.state.account).toBe(host.account); continue; }
        expect(after.state.account._tag).toBe("disputed");
        expect(after.state.account.active).toEqual(og.value.acc.activeDispute);
        expect(after.state.account.state.jNonce).toBe(og.value.acc.state.jNonce);
        expect(envelopeOf(host.account.state.terms, { self: ALICE, peer: BOB, left: true })).toMatchObject({ fromEntityId: og.value.input.fromEntityId, toEntityId: og.value.input.toEntityId, domain: og.value.input.domain, disputeConfig: og.value.input.disputeConfig });
        started++;
      } else {
        const initialProofbodyHash = rng() < 0.5 ? bodyHash : `0x${"8".repeat(64)}`;
        const event = { type: "DisputeFinalized", sender, counterentity, nonce, finalProofbodyHash: bodyHash, finalizationEvidenceHash: ZERO_WORD, finalProofbody: proof.body, initialProofbodyHash };
        const rw = applyHost(host, { layer: "j", tx: { type: "j_event", blockNumber: 7, event } } as any, ctx, hankoVerify);
        const og = ogThrows(() => {
          const counterparty = lower(sender) === lower(ALICE) ? lower(counterentity) : lower(sender);
          if (counterparty !== lower(BOB)) return undefined;
          if (!goodHash) throw new Error("DISPUTE_FROZEN_ACCOUNT_STATE_MISMATCH");
          const eventJNonce = bodyHash.toLowerCase() === initialProofbodyHash.toLowerCase() ? Number(nonce) + 1 : Number(nonce);
          const acc = ogAccount(jNonce0), input: any = createAccountDisputeFinalityInput(acc.state, lower(ALICE), Math.max(jNonce0, eventJNonce), proof.body.tokenIds.map(Number));
          applyAccountDisputeFinality(acc, input.finality.finalizedJNonce, input.finality.finalizedTokenIds);
          return { input, acc };
        });
        if (!og.ok) { expect(rw.ok).toBe(false); continue; }
        const after: any = unwrap(rw as any);
        if (og.value === undefined) { expect(after.state.account).toBe(host.account); continue; }
        expect([after.state.account._tag, after.state.account.state.jNonce, after.state.account.dispute.nextProofNonce]).toEqual([og.value.acc.status, og.value.acc.state.jNonce, og.value.acc.proofHeader.nextProofNonce]);
        finalized++;
      }
    }
    expect(Math.min(started, finalized)).toBeGreaterThan(10);
  });
});

describe(seedTag("entity-txs-3: prepareDispute / disputeStart (og entity/tx/handlers/dispute)"), () => {
  const PA = (name: Parameters<typeof PersistentAccountStateMap.empty>[0]) => PersistentAccountStateMap.empty(name);
  /** An og Account the dispute handlers can claim through the frame's candidate map: no witnesses, no orders. */
  const ogAcc = (status: string, disputePrepare?: unknown): any => ({
    state: { leftEntity: lowerId(ALICE), rightEntity: lowerId(BOB), domain: { ...TERMS.domain }, watchSeed: TERMS.watchSeed, disputeConfig: { ...TERMS.disputeConfig }, jNonce: 0,
      deltas: PA("deltas"), locks: PA("locks"), swapOffers: PA("swapOffers"), pulls: PA("pulls"), requestedRebalance: PA("requestedRebalance"), requestedRebalanceFeeState: PA("requestedRebalanceFeeState"), rebalanceFeePolicies: PA("rebalanceFeePolicies") },
    status, mempool: [], currentHeight: 0, proofHeader: { fromEntity: lowerId(ALICE), toEntity: BOB, nextProofNonce: 1 }, pendingWithdrawals: PA("pendingWithdrawals"),
    shadow: { rebalance: { policy: PA("rebalanceShadowPolicy"), submittedAtByToken: PA("rebalanceShadowSubmitted") } }, ...(disputePrepare === undefined ? {} : { disputePrepare }),
  });
  const lowerId = (s: string): string => s.toLowerCase();
  const ogEntity = (a: EntityState, ts: number, account?: any): any => ({ entityId: a.id, timestamp: ts, config: ogConfig(a), accounts: new EntityAccountCandidateMap(PersistentEntityAccountMap.fromEntries(account === undefined ? [] : [[BOB, account]], a.id, () => ZERO_WORD as never)) });
  const run = async (og: () => Promise<any>): Promise<{ ok: true; state: any } | { ok: false; reason: string }> => { try { return { ok: true, state: (await og()).newState }; } catch (e) { return { ok: false, reason: String((e as Error).message) }; } };
  test("MATCH: 60 random prepare / start calls on missing, open, preparing (cooldown) and disputed Accounts: og's status events, disputePrepare leaf, jBatchState and Account status", async () => {
    const a = lazyEntity([[aliceAddr, 1n]], 1n);
    const opened = unwrap(foldTxs(a.state, a.accountReplicas, [openTx()], { verify: hankoVerify, timestamp: NOW })).draft;
    const base = opened.accountReplicas.get(BOB);
    if (base === undefined) throw new Error("no account");
    const openChild = { ...base, _tag: "open" } as AccountReplica;
    let checked = 0, missingHanko = 0;
    for (let i = 0; i < 60; i++) {
      const ts = 1_000_000 + ri(5_000), kind = pick(["missing", "open", "preparing", "disputed"] as const), readyAfter = ts + pick([-10, 0, 1, 2_500]);
      const prepare = { startedAt: ts - 100, readyAfter, reason: "r", startIntent: { description: pick(["", "why"]) } };
      const rwChild: AccountReplica | undefined = kind === "missing" ? undefined : kind === "open" ? openChild : kind === "preparing" ? prepareFrozen(openChild as never, prepare, { _tag: "not_attempted" })
        : ({ ...openChild, _tag: "disputed", mempool: [] } as unknown as AccountReplica);
      const tx: EntityTx = rng() < 0.6
        ? { type: "prepareDispute", data: { counterpartyEntityId: BOB, ...(rng() < 0.5 ? { description: pick(["", "late peer"]) } : {}), ...(rng() < 0.5 ? { minCooldownMs: pick([0, 1, 1_500, -3, 2.7]) } : {}) } }
        : { type: "disputeStart", data: { counterpartyEntityId: BOB, ...(rng() < 0.5 ? { description: "d" } : {}) } };
      const rw = foldTxs(opened.state, new Map(rwChild === undefined ? [] : [[BOB, rwChild]]), [tx], { verify: hankoVerify, timestamp: BigInt(ts) });
      const ogS = ogEntity(a.state, ts, kind === "missing" ? undefined : ogAcc(kind === "open" ? "active" : kind === "preparing" ? "dispute_preparing" : "disputed", kind === "preparing" ? prepare : undefined));
      const og = await run(() => (tx.type === "prepareDispute" ? handlePrepareDispute(ogS, wire(tx) as never, env, [], true) : handleDisputeStart(ogS, wire(tx) as never, env, [], true)));
      if (!og.ok) { expect(rw.ok ? "ok" : reasonOf(rw.error)).toBe(og.reason); continue; }
      const d = unwrap(rw).draft;
      expect(d.events).toEqual(readEntityFrameEvents(og.state) as never);
      expect(d.state.committed["jBatchState"]).toEqual(og.state.jBatchState);
      if ((d.events ?? []).some((e) => e.message.startsWith("❌ Missing counterparty dispute hanko"))) missingHanko++;
      const ogAfter = og.state.accounts.get(BOB), after = d.accountReplicas.get(BOB);
      if (ogAfter === undefined || after === undefined) { expect(after).toEqual(ogAfter); continue; }
      expect({ active: "active", dispute_preparing: "preparing", disputed: "disputed" }[ogAfter.status as string]).toBe(after._tag === "proposed" ? "active" : after._tag === "open" ? "active" : after._tag);
      expect(unwrap(installedAccount(a.state.id, BOB, after)).committed?.["disputePrepare"]).toEqual(ogAfter.disputePrepare);
      checked++;
    }
    expect([checked > 30, missingHanko > 3]).toEqual([true, true]);
  }, 60_000);
  test("MATCH: 40 random prepareDispute calls on an Account with resting orders: og removeDisputedAccountOrdersFromBook takes exactly its rows off the hub book, with og's count message", async () => {
    const a = lazyEntity([[aliceAddr, 1n]], 1n);
    const opened = unwrap(foldTxs(a.state, a.accountReplicas, [openTx()], { verify: hankoVerify, timestamp: NOW })).draft;
    const openChild = { ...opened.accountReplicas.get(BOB)!, _tag: "open" } as AccountReplica;
    const T = (n: number) => unwrap(tokenId(String(n)));
    const hubProfile = { entityId: a.state.id, name: "hub", spreadDistribution: { makerBps: 0, takerBps: 10_000, hubBps: 0, makerReferrerBps: 0, takerReferrerBps: 0 }, referenceTokenId: 1, usdQuoteAuthorityEntityId: `0x${"99".repeat(32)}`, minTradeSize: 0n, supportedPairs: ["1/2"] };
    let removedTotal = 0, untouched = 0;
    for (let i = 0; i < 40; i++) {
      const ts = 1_000_000 + ri(5_000), offerIds = Array.from({ length: ri(4) }, (_, k) => `o${i}-${k}`);
      const offers = new Map(offerIds.map((offerId) => [offerId, { offerId, giveTokenId: T(2), giveTokenDecimals: 18, giveAmount: 10n ** 18n, wantTokenId: T(1), wantTokenDecimals: 6, wantAmount: 2_500n * 10n ** 6n, maxFee: 0n,
        minNetReceive: 2_500n * 10n ** 6n, priceTicks: 25_000_000n, makerIsLeft: BOB.toLowerCase() === String(openChild.state.account.id.left).toLowerCase(), createdHeight: 1, quantizedGive: 10n ** 18n, quantizedWant: 2_500n * 10n ** 6n }]));
      // the hub book: some of the Account's orders rest (others already filled), beside other owners' rows
      const withExt = rng() < 0.85, rwBooks = new Map<string, Book>(), ogBooks = new Map<string, unknown>();
      if (withExt) for (const pair of ["1/2", "1/3"].slice(0, 1 + ri(2))) {
        const params = { bucketWidthTicks: 10_000n, maxOrders: 10_000, stpPolicy: 1 as const };
        let og = ogBook.createBook(params), rw = unwrap(createBook(params));
        const rows = [...offerIds.filter(() => rng() < 0.6).map((id) => [BOB, `${BOB}:${id}`]), ...Array.from({ length: ri(3) }, (_, k) => [CAROL, `${CAROL}:x${i}-${pair}-${k}`])];
        for (const [ownerId, orderId] of rows) {
          if (rwBooks.get("1/2")?.orders.has(orderId!) || (pair !== "1/2" && ri(2) === 0)) continue;
          const cmd = { kind: 0 as const, ownerId: ownerId!, orderId: orderId!, side: ri(2) as 0 | 1, tif: 0 as const, postOnly: false, priceTicks: BigInt(95 + ri(10)) * 250_000n, qtyLots: BigInt(1 + ri(9)) };
          og = ogBook.applyCommand(og, cmd).state; rw = unwrap(applyBookCommand(rw, cmd)).state;
        }
        rwBooks.set(pair, rw); ogBooks.set(pair, og);
      }
      const rwState: EntityState = withExt ? { ...opened.state, orderbookExt: { books: rwBooks, pairDimensions: new Map(), referrals: new Map(), hubProfile } } : opened.state;
      const rwChild = { ...openChild, state: { ...openChild.state, offers } } as AccountReplica;
      const tx: EntityTx = { type: "prepareDispute", data: { counterpartyEntityId: BOB, minCooldownMs: 60_000 } };
      const rw = foldTxs(rwState, new Map([[BOB, rwChild]]), [tx], { verify: hankoVerify, timestamp: BigInt(ts) });
      const ogAccount = ogAcc("active");
      ogAccount.state.swapOffers = PersistentAccountStateMap.fromEntries("swapOffers", [...offers].map(([id, o]) => [id, { ...o, giveTokenId: 2, wantTokenId: 1 }]));
      const ogS = ogEntity(a.state, ts, ogAccount);
      if (withExt) { ogS.orderbookExt = { books: ogBooks, orderPairs: new Map(), pairDimensions: new Map(), referrals: new Map(), hubProfile }; rebuildOrderbookPairIndex(ogS.orderbookExt); }
      const og = await run(() => handlePrepareDispute(ogS, wire(tx) as never, env, [], true));
      if (!og.ok) { expect(rw.ok ? "ok" : reasonOf(rw.error)).toBe(og.reason); continue; }
      const d = unwrap(rw).draft;
      expect(d.events).toEqual(readEntityFrameEvents(og.state) as never);
      const removed = (d.events ?? []).find((e) => e.message.startsWith("⚔️ Dispute removed"));
      if (removed === undefined) untouched++; else removedTotal += Number(removed.message.split(" ")[3]);
      if (!withExt) { expect(d.state.orderbookExt).toBeUndefined(); continue; }
      expect([...d.state.orderbookExt!.books.keys()].sort()).toEqual([...og.state.orderbookExt.books.keys()].sort());
      for (const [pairId, book] of d.state.orderbookExt!.books) {
        expect([i, pairId, bookCommitmentHash(book)]).toEqual([i, pairId, computeBookCommitmentHash(og.state.orderbookExt.books.get(pairId))]);
        expect(bookOrders(book).map((o) => o.orderId)).toEqual(ogBook.getBookOrders(og.state.orderbookExt.books.get(pairId)).map((o: any) => o.orderId));
      }
      expect(d.accountReplicas.get(BOB)?._tag).toBe("preparing");
    }
    expect([removedTotal > 10, untouched > 3]).toEqual([true, true]);
  }, 60_000);
  test("MATCH: ogProofBody equals og canonicalizeProofBodyStruct over random offdeltas, token ids and allowances", () => {
    for (let i = 0; i < 100; i++) {
      const body = { watchSeed: TERMS.watchSeed, leftResponseSeconds: BigInt(ri(99)), rightResponseSeconds: BigInt(ri(99)), offdeltas: Array.from({ length: ri(4) }, () => BigInt(ri(1e6)) * (rng() < 0.5 ? -1n : 1n) * (rng() < 0.2 ? 1n << 300n : 1n)),
        tokenIds: Array.from({ length: ri(3) }, () => BigInt(ri(9))), transformers: Array.from({ length: ri(2) }, () => ({ transformerAddress: `0x${"12".repeat(20)}`, encodedBatch: "0x00", allowances: [{ deltaIndex: 0n, rightAllowance: BigInt(ri(9)), leftAllowance: BigInt(ri(9)) }] })) };
      expect(ogProofBody(body)).toEqual(canonicalizeProofBodyStruct({ ...body, offdeltas: body.offdeltas.map((v) => ({ high: v >> 256n, low: v & ((1n << 256n) - 1n) })) }, ALICE, BOB, "t") as never);
    }
  });
});
