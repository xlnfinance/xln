import { describe, expect, test } from "bun:test";
import { lcg31, seedOf, seedTag, untilCovered } from "./seed.ts";
import {
  applyBoardRegistryEvent, boardProof, emptyBoardRegistry, EMPTY_CERTIFIED_BOARD_ROOT, hashBoardNode, lookupBoardRecord, reachableBoardNodes, verifyBoardProof, advanceBoardFinality, boardStackKey,
  applyBoardJEvent, applyEntityInput, assertBoardAuthority, admit, applyAccountInput, tokenId, type DoorContext, type EntityId, type ProposedAccount, type Verify, boardProposalHash, verifyAccountHanko, applyEntityProviderActionJEvent, foldTxs, hashEntityFrame, buildCommand, createEntity, entityId, entityRootOf, quorumBoardHash, quorumHanko,
  type Address, type BoardNodes, type CertifiedBoardNode, type CertifiedBoardRegistryState, type EntityState, type EntityTx, type Hash, type JEvent,
} from "../xln.ts";
import { ALICE, BOB, NOW, ackInput, aliceAddr, bobAddr, carolAddr, crypto, envelopeAB, genesisAB, hankoVerify, offerOf, proposeInput, unwrap, verifiers } from "../xln_run.ts";
import { assertEntityConfigBoardAuthority, buildQuorumHanko } from "../../core/hanko/signing.ts";
import { handleEntityProviderActivateBoard, handleEntityProviderProposeControlBoard } from "../../core/entity/tx/handlers/control-board-proposal.ts";
import { handleEntityProviderCancelAction, handleEntityProviderReleaseControlShares, handleEntityProviderTransfer } from "../../core/entity/tx/handlers/entity-provider-action.ts";
import { applyEntityProviderActionCancelled, applyEntityProviderActionExecuted } from "../../core/entity/tx/j-events-entity-provider-action.ts";
import { applyCertifiedBoardJEvent } from "../../core/entity/tx/j-events-board.ts";
import { readEntityFrameEventMessages } from "../../core/entity/frame-events.ts";
import { buildEntityHashesToSign } from "../../core/entity/consensus/input/hanko-witness.ts";
import { computeEntityProfileHash } from "../../core/entity/profile/profile-descriptor.ts";
import { resolveEntityCommandBoard } from "../../core/entity/command/index.ts";
import { computeCanonicalEntityConsensusStateHash, computeEntityAccountValueHash } from "../../core/entity/consensus/state-root.ts";
import { PersistentEntityAccountMap } from "../../core/entity/state/persistent-account-map.ts";
import { PersistentEntityCollectionMap } from "../../core/entity/state/persistent-collection-map.ts";
import {
  advanceCertifiedBoardFinality, applyCertifiedBoardRegistryEvent, collectReachableCertifiedBoardNodes, createCertifiedBoardProof, getCertifiedBoardStackKey, lookupCertifiedBoardRecord, verifyCertifiedBoardProof,
} from "../../core/jurisdiction/machine/board-registry/index.ts";

let seed = seedOf(11);
const rng = (): number => { seed = lcg31(seed); return seed / 0x7fffffff; };
const ri = (n: number): number => Math.floor(rng() * n);
const pick = <T>(xs: readonly T[]): T => xs[ri(xs.length)] as T;
const word = (n: bigint | number): string => `0x${BigInt(n).toString(16).padStart(64, "0")}`;
const rword = (): string => `0x${Array.from({ length: 64 }, () => "0123456789abcdef"[ri(16)]).join("")}`;
const msg = (f: () => unknown): { ok: true; value: any } | { ok: false; code: string } => { try { return { ok: true, value: f() }; } catch (e) { return { ok: false, code: (e as Error).message }; } };
const JUR = { name: "j", chainId: 31337, depositoryAddress: "0x5fbdb2315678afecb367f032d93f642f64180aa3", entityProviderAddress: "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512" };

type OgEvent = { type: string; blockNumber: number; blockHash: string; transactionHash: string; logIndex: number; data: Record<string, string> };
const toRewrite = (e: OgEvent): JEvent => {
  const meta = { blockNumber: e.blockNumber, blockHash: e.blockHash, transactionHash: e.transactionHash, logIndex: e.logIndex };
  if (e.type === "FoundationBootstrapped") return { type: e.type, recipient: e.data["recipient"] ?? "", boardHash: e.data["boardHash"] ?? "", controlTokenId: 1n, dividendTokenId: 2n, meta };
  if (e.type === "EntityRegistered") return { type: e.type, entityId: e.data["entityId"] ?? "", entityNumber: BigInt(e.data["entityNumber"] ?? "0"), boardHash: e.data["boardHash"] ?? "", meta };
  if (e.type === "BoardActivated") return { type: e.type, entityId: e.data["entityId"] ?? "", previousBoardHash: e.data["previousBoardHash"] ?? "", newBoardHash: e.data["newBoardHash"] ?? "", previousBoardValidUntil: BigInt(e.data["previousBoardValidUntil"] ?? "0"), meta };
  return { type: "ReserveUpdated", entity: word(2), tokenId: 1n, newBalance: 5n, meta };
};

describe(seedTag("certified-board registry (og jurisdiction/machine/board-registry)"), () => {
  test("MATCH: stack key validation equals og getCertifiedBoardStackKey", () => {
    const cases = [JUR, { ...JUR, chainId: 0 }, { ...JUR, depositoryAddress: "0x5FbDB2315678afecb367f032d93F642f64180aa3" }, { ...JUR, depositoryAddress: "0x5fbdb2315678afecb367f032d93f642f64180aa" },
      { ...JUR, entityProviderAddress: "E7f1725E7734CE288F8367e1Bb143E90bb3F0512" }, { ...JUR, entityProviderAddress: "0xE7f1725E7734ce288F8367e1Bb143E90bb3F0512" }, { ...JUR, chainId: 1.5 }];
    for (const j of cases) {
      const og = msg(() => getCertifiedBoardStackKey(j)), mine = boardStackKey(j);
      expect(mine.ok ? { ok: true, value: mine.value } : { ok: false, code: mine.error.code }).toEqual(og);
    }
  });

  test("MATCH: 150 random event sequences give og's registry state, nodes, errors, lookups and proofs", () => {
    for (let run = 0; run < 150; run += 1) {
      const ids = [2n, 3n, 4n, 5n, 1000n].map(word), boards = new Map<string, string>();
      let ogState: any, ogNodes = new Map<string, any>(), state: CertifiedBoardRegistryState | undefined, nodes: BoardNodes = new Map();
      let height = 5 + ri(3);
      const deployment = rng() < 0.5 ? height : undefined, jur = { ...JUR, ...(deployment === undefined ? {} : { entityProviderDeploymentBlock: deployment }) };
      const events: OgEvent[] = [];
      for (let i = 0; i < 14; i += 1) {
        const r = rng(), log = ri(3), blockNumber = rng() < 0.08 ? 0 : height, bh = rng() < 0.03 ? "0x12" : rword();
        const base = { blockNumber, blockHash: bh, transactionHash: rword(), logIndex: rng() < 0.03 ? -1 : log };
        if (i === 0 || r < 0.08) events.push({ ...base, type: "FoundationBootstrapped", data: { recipient: "0x" + "11".repeat(20), boardHash: rword(), controlTokenId: "1", dividendTokenId: "2" } });
        else if (r < 0.45) {
          const id = pick(ids), board = rng() < 0.05 ? "0xzz" : rword();
          events.push({ ...base, type: "EntityRegistered", data: { entityId: id, entityNumber: rng() < 0.06 ? "7" : BigInt(id).toString(), boardHash: board } });
        } else if (r < 0.92) {
          const id = pick(ids), prev = boards.get(id) ?? rword(), next = rword();
          events.push({ ...base, type: "BoardActivated", data: { entityId: id, previousBoardHash: rng() < 0.1 ? rword() : prev, newBoardHash: next, previousBoardValidUntil: String(rng() < 0.06 ? 0 : 1_700_000_000 + ri(1000)) } });
        } else events.push({ ...base, type: "ReserveUpdated", data: {} });
        if (rng() < 0.2) events.push({ ...(events[events.length - 1] as OgEvent) });
        if (rng() < 0.7) height += 1 + ri(2);
        else if (rng() < 0.1) height = Math.max(1, height - 2);
        for (const e of events.splice(0)) {
          const og = msg(() => applyCertifiedBoardRegistryEvent(ogState, ogNodes, jur as any, e as any));
          const mine = applyBoardRegistryEvent(state, nodes, jur, toRewrite(e));
          expect(mine.ok ? "ok" : mine.error.code).toBe(og.ok ? "ok" : og.code);
          if (!og.ok || !mine.ok) continue;
          expect(mine.value.state).toEqual(og.value.state);
          expect(new Set(mine.value.newNodes.keys())).toEqual(new Set(og.value.newNodes.keys()));
          ogState = og.value.state; state = mine.value.state;
          for (const [h, n] of og.value.newNodes) ogNodes.set(h, n);
          nodes = new Map([...nodes, ...mine.value.newNodes]);
          for (const [h, n] of mine.value.newNodes) expect(hashBoardNode(n)).toEqual({ ok: true, value: h });
          if (e.type === "BoardActivated" && e.data["entityId"] !== undefined) boards.set(e.data["entityId"], e.data["newBoardHash"] ?? "");
          if (e.type === "EntityRegistered" && e.data["entityId"] !== undefined) boards.set(e.data["entityId"], e.data["boardHash"] ?? "");
        }
      }
      if (state === undefined) continue;
      for (const id of [...ids, word(1), word(99)]) {
        const og = lookupCertifiedBoardRecord(ogNodes, ogState.boardRegistryRoot, ogState.stackKey, id), mine = lookupBoardRecord(nodes, state.boardRegistryRoot, state.stackKey, id);
        expect(mine).toEqual({ ok: true, value: og });
        const ogProof = createCertifiedBoardProof(ogNodes, ogState, id), proof = boardProof(nodes, state, id);
        expect(proof).toEqual({ ok: true, value: ogProof as any });
        expect(verifyBoardProof(state.boardRegistryRoot, ogProof as any)).toEqual({ ok: true, value: verifyCertifiedBoardProof(ogState.boardRegistryRoot, ogProof) });
      }
      const reach = reachableBoardNodes(nodes, [state.boardRegistryRoot]);
      expect(reach.ok && new Set(reach.value.keys())).toEqual(new Set(collectReachableCertifiedBoardNodes(ogNodes, [ogState.boardRegistryRoot]).keys()));
    }
  }, 40_000);

  test("MATCH: tampered proofs, finality advance and empty registries refuse like og", () => {
    const empty = emptyBoardRegistry(JUR);
    expect(empty.ok && empty.value.boardRegistryRoot).toBe(EMPTY_CERTIFIED_BOARD_ROOT);
    let ogState: any, state: CertifiedBoardRegistryState | undefined, nodes: BoardNodes = new Map();
    const ogNodes = new Map<string, any>();
    const seq: OgEvent[] = [
      { type: "FoundationBootstrapped", blockNumber: 3, blockHash: word(31), transactionHash: word(32), logIndex: 0, data: { recipient: "0x" + "11".repeat(20), boardHash: word(900), controlTokenId: "1", dividendTokenId: "2" } },
      ...[2n, 3n, 4n].map((n, i): OgEvent => ({ type: "EntityRegistered", blockNumber: 4, blockHash: word(41), transactionHash: word(42 + i), logIndex: i, data: { entityId: word(n), entityNumber: n.toString(), boardHash: word(800n + n) } })),
    ];
    for (const e of seq) {
      const og = applyCertifiedBoardRegistryEvent(ogState, ogNodes, JUR as any, e as any); ogState = og.state; for (const [h, n] of og.newNodes) ogNodes.set(h, n);
      const mine = applyBoardRegistryEvent(state, nodes, JUR, toRewrite(e)); if (!mine.ok) throw new Error(mine.error.code); state = mine.value.state; nodes = new Map([...nodes, ...mine.value.newNodes]);
    }
    if (state === undefined) throw new Error("state");
    const proof = createCertifiedBoardProof(ogNodes, ogState, word(3));
    const tampered = [
      { ...proof, version: 2 }, { ...proof, nodes: [] }, { ...proof, nodes: [...proof.nodes, proof.nodes[0]] }, { ...proof, nodes: proof.nodes.slice(1) }, { ...proof, entityId: "0x12" },
      { ...proof, nodes: proof.nodes.map((n: any) => (n.type === "branch" ? { ...n, bit: 300 } : n)) }, { ...proof, nodes: proof.nodes.map((n: any) => (n.type === "leaf" ? { ...n, record: { ...n.record, boardEpoch: 9 } } : n)) },
    ];
    for (const p of tampered) {
      const og = msg(() => verifyCertifiedBoardProof(ogState.boardRegistryRoot, p as any)), mine = verifyBoardProof(state.boardRegistryRoot, p as any);
      expect(mine.ok ? { ok: true, value: mine.value } : { ok: false, code: mine.error.code }).toEqual(og);
    }
    for (const [h, bh, root] of [[7, word(1), word(2)], [2, word(1), word(2)], [7, "0x1", word(2)], [8, word(3), "bad"]] as const) {
      const og = msg(() => advanceCertifiedBoardFinality(ogState, JUR as any, h, bh, root)), mine = advanceBoardFinality(state, JUR, h, bh, root);
      expect(mine.ok ? { ok: true, value: mine.value } : { ok: false, code: mine.error.code }).toEqual(og);
      if (og.ok && mine.ok) { ogState = og.value; state = mine.value; }
    }
    const corrupt: Map<string, CertifiedBoardNode> = new Map([...nodes].map(([h, n]) => [h, n.type === "leaf" ? { ...n, record: { ...n.record, logIndex: n.record.logIndex + 1 } } : n]));
    const ogCorrupt = new Map([...ogNodes].map(([h, n]) => [h, n.type === "leaf" ? { ...n, record: { ...n.record, logIndex: n.record.logIndex + 1 } } : n]));
    const og = msg(() => lookupCertifiedBoardRecord(ogCorrupt, ogState.boardRegistryRoot, ogState.stackKey, word(2))), mine = lookupBoardRecord(corrupt, state.boardRegistryRoot, state.stackKey, word(2));
    expect(mine.ok ? { ok: true, value: mine.value } : { ok: false, code: mine.error.code }).toEqual(og);
  });
});

// ---- ER-4b: quorum board binding (og hanko/signing.ts assertQuorumBoardBinding) ----
const toOgEvent = (e: JEvent): any => {
  const { meta, type, ...data } = e as any;
  const text = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]));
  return { type, blockNumber: meta.blockNumber, blockHash: meta.blockHash, transactionHash: meta.transactionHash, logIndex: meta.logIndex, data: text };
};
const JCONF = { entityProviderAddress: JUR.entityProviderAddress };
const OG_J = { name: "j", chainId: JUR.chainId, depositoryAddress: JUR.depositoryAddress, entityProviderAddress: JUR.entityProviderAddress };
const DOMAIN = { chainId: JUR.chainId, depositoryAddress: JUR.depositoryAddress };
const foundation: JEvent = { type: "FoundationBootstrapped", recipient: "0x" + "11".repeat(20), boardHash: word(900), controlTokenId: 1n, dividendTokenId: 2n, meta: { blockNumber: 2, blockHash: word(21), transactionHash: word(22), logIndex: 0 } };
const registered = (id: string, board: string, block = 3, log = 0): JEvent => ({ type: "EntityRegistered", entityId: id, entityNumber: BigInt(id), boardHash: board, meta: { blockNumber: block, blockHash: word(30 + block), transactionHash: word(40 + block + log), logIndex: log } });
/** Both sides observe the same board events: the rewrite through applyBoardJEvent, og through applyCertifiedBoardRegistryEvent on an og node store. */
const observe = (state: EntityState, events: readonly JEvent[]): { state: EntityState; ogRegistry: any; ogNodes: Map<string, any> } => {
  let s = state, ogRegistry: any;
  const ogNodes = new Map<string, any>();
  for (const [i, e] of events.entries()) {
    s = unwrap(applyBoardJEvent(s, e, e.meta?.blockNumber ?? i)).state;
    const og = applyCertifiedBoardRegistryEvent(ogRegistry, ogNodes, OG_J as any, toOgEvent(e));
    ogRegistry = og.state;
    for (const [h, n] of og.newNodes) ogNodes.set(h, n);
  }
  return { state: s, ogRegistry, ogNodes };
};
const ogConfigOf = (s: EntityState, withJ: boolean) => {
  if (s.quorum._tag !== "teaching") throw new Error("teaching");
  const members = [...s.quorum.members];
  return { mode: "proposer-based" as const, threshold: s.quorum.threshold, validators: members.map(([a]) => a.toLowerCase()), shares: Object.fromEntries(members.map(([a, m]) => [a.toLowerCase(), m.shares])), ...(withJ ? { jurisdiction: OG_J } : {}) };
};
const reasonOf = (r: { ok: boolean; error?: unknown }): string => (r.ok ? "ok" : String((r.error as { reason?: string }).reason ?? (r.error as { _tag: string })._tag));

describe(seedTag("ER-4b: quorum board binding (og assertQuorumBoardBinding)"), () => {
  const SIGNERS = [aliceAddr, bobAddr, carolAddr] as const;
  test("MATCH: 200 random boards x {lazy id, certified match, certified mismatch, unregistered, no registry, no jurisdiction} give og's assertEntityConfigBoardAuthority verdict", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const n = 1 + ri(3), members = [...SIGNERS].sort(() => rng() - 0.5).slice(0, n).map((a) => [a, BigInt(1 + ri(3))] as const);
      const power = members.reduce((t, [, s]) => t + s, 0n), threshold = BigInt(1 + ri(Number(power)));
      const authority = { _tag: "teaching" as const, threshold, members: new Map(members.map(([a, s]) => [a, { shares: s }])) }, board = quorumBoardHash(authority);
      const mode = pick(["lazy", "match", "mismatch", "unregistered", "noRegistry", "noJurisdiction"] as const), numbered = word(2 + ri(8));
      const id = mode === "lazy" ? board : numbered, withJ = mode !== "noJurisdiction";
      const base = unwrap(createEntity({ id: unwrap(entityId(id)), jurisdiction: DOMAIN, threshold, members: authority.members, ...(withJ ? { jurisdictionConfig: JCONF } : {}) }));
      const events = mode === "noRegistry" || mode === "noJurisdiction" ? [] : [foundation, ...(mode === "unregistered" ? [registered(word(99), rword())] : [registered(numbered, mode === "match" ? board : rword())])];
      const { state, ogRegistry, ogNodes } = observe(base.state, events);
      const config = ogConfigOf(state, withJ), ogState = { entityId: id, config, ...(ogRegistry === undefined ? {} : { certifiedBoardState: ogRegistry }) };
      let og = "ok";
      try { await assertEntityConfigBoardAuthority({ infrastructure: { certifiedBoardNodes: ogNodes } } as never, id, config as never, ogState as never); } catch (e) { og = (e as Error).message; }
      expect(reasonOf(assertBoardAuthority(state))).toBe(og);
      seen.add(og.split(/[: ]/)[0] ?? og);
    }
    expect(seen.size).toBeGreaterThanOrEqual(4);
  });

  test("MATCH: a certified numbered 2-of-3 Entity builds og's buildQuorumHanko over its registry; an uncertified one refuses", async () => {
    const members = new Map(SIGNERS.map((a) => [a, { shares: 1n }] as const)), authority = { _tag: "teaching" as const, threshold: 2n, members };
    const id = word(7), digest = word(12345);
    const base = unwrap(createEntity({ id: unwrap(entityId(id)), jurisdiction: DOMAIN, threshold: 2n, members, jurisdictionConfig: JCONF }));
    const { state, ogRegistry, ogNodes } = observe(base.state, [foundation, registered(id, quorumBoardHash(authority))]);
    const sigs = new Map([bobAddr, carolAddr].map((s) => [s, unwrap(crypto.sign(digest as Hash, s))] as const));
    const ogSigs = [...sigs].map(([s, g]) => ({ signerId: s.toLowerCase(), signature: g.startsWith("0x") ? g : `0x${g}` }));
    const og = await buildQuorumHanko({ infrastructure: { certifiedBoardNodes: ogNodes } } as never, id, digest, ogSigs, ogConfigOf(state, true) as never, { entityId: id, config: ogConfigOf(state, true), certifiedBoardState: ogRegistry } as never);
    expect(unwrap(quorumHanko(state, digest, sigs))).toBe(og);
    let ogRefusal = "ok";
    try { await buildQuorumHanko({} as never, id, digest, ogSigs, ogConfigOf(base.state, true) as never, { entityId: id, config: ogConfigOf(base.state, true) } as never); } catch (e) { ogRefusal = (e as Error).message; }
    expect(reasonOf(quorumHanko(base.state, digest, sigs))).toBe(ogRefusal);
  });

  test("MATCH: a numbered 1-of-1 Entity proposes only once its EntityRegistered is certified for its config board (og selectProposableEntityTxs SELF_BOARD_CERTIFICATION_REQUIRED)", () => {
    const id = unwrap(entityId(word(5))), members = new Map([[aliceAddr, { shares: 1n }]]);
    const base = unwrap(createEntity({ id, jurisdiction: DOMAIN, threshold: 1n, members, jurisdictionConfig: JCONF }));
    const chat: EntityTx = { type: "chat", data: { from: aliceAddr, message: "hi" } };
    const run = (r: typeof base) => applyEntityInput(r, { kind: "txs", timestamp: 10n, txs: [chat] }, { ...verifiers, self: id, signerId: aliceAddr });
    // og: an uncertified board (no registry, or a registry certifying another board) selects nothing; the tx stays queued, no frame
    const queuedOnly = (r: ReturnType<typeof run>) => (r.ok ? [r.value.replica._tag, r.value.replica.head.height, r.value.replica.mempool.length, r.value.outputs.length] : reasonOf(r));
    expect(queuedOnly(run(base))).toEqual(["open", 0n, 1, 0]);
    const certified = run({ ...base, state: observe(base.state, [foundation, registered(id, quorumBoardHash({ _tag: "teaching", threshold: 1n, members }))]).state });
    expect(certified.ok && certified.value.replica.head.height).toBe(1n);
    expect(queuedOnly(run({ ...base, state: observe(base.state, [foundation, registered(id, word(4242))]).state }))).toEqual(["open", 0n, 1, 0]);
  });
});

describe(seedTag("certifiedBoardState in the Entity root (og state-root.ts ENTITY_STATE_ROOT_FIELDS)"), () => {
  test("MATCH: the committed registry section moves the root exactly as og's computeCanonicalEntityConsensusStateHash", () => {
    const members = new Map([[aliceAddr, { shares: 1n }]]), id = unwrap(entityId(word(6)));
    const base = unwrap(createEntity({ id, jurisdiction: DOMAIN, threshold: 1n, members, jurisdictionConfig: JCONF }));
    const { state, ogRegistry } = observe(base.state, [foundation, registered(id, word(77))]);
    const ogOf = (extra: Record<string, unknown>): any => ({
      entityId: id, height: 0, timestamp: 0, accounts: PersistentEntityAccountMap.fromEntries([], id, computeEntityAccountValueHash),
      config: { mode: "proposer-based", threshold: 1n, validators: [aliceAddr], shares: { [aliceAddr]: 1n }, jurisdiction: { address: "", ...OG_J } },
      paybook: { entries: PersistentEntityCollectionMap.empty("paybookHashlock"), feesEarned: 0n }, ...extra,
    });
    const withJ = { ...state, jurisdictionConfig: { entityProviderAddress: JUR.entityProviderAddress } };
    const rootOf = (s: EntityState) => unwrap(entityRootOf(s, new Map()));
    const ogJ = ogOf({}).config.jurisdiction;
    expect(rootOf({ ...withJ, committed: {} })).toBe(computeCanonicalEntityConsensusStateHash({ ...ogOf({}), config: { ...ogOf({}).config, jurisdiction: ogJ } }));
    expect(rootOf(withJ)).toBe(computeCanonicalEntityConsensusStateHash(ogOf({ certifiedBoardState: ogRegistry })));
    expect(rootOf(withJ)).not.toBe(rootOf({ ...withJ, committed: {} }));
  });
});

describe(seedTag("entity command board from the certified registry (og resolveEntityCommandBoard)"), () => {
  test("MATCH: a certified numbered Entity signs commands at its record's epoch; a registry board that is not the config board refuses", () => {
    const members = new Map([[bobAddr, { shares: 1n }]]), id = word(8), board = quorumBoardHash({ _tag: "teaching", threshold: 1n, members });
    const base = unwrap(createEntity({ id: unwrap(entityId(id)), jurisdiction: DOMAIN, threshold: 1n, members, jurisdictionConfig: JCONF }));
    const activated = (next: string): JEvent => ({ type: "BoardActivated", entityId: id, previousBoardHash: word(55), newBoardHash: next, previousBoardValidUntil: 1_800_000_000n, meta: { blockNumber: 9, blockHash: word(91), transactionHash: word(92), logIndex: 1 } });
    for (const next of [board, word(66)]) {
      const { state, ogRegistry, ogNodes } = observe(base.state, [foundation, registered(id, word(55)), activated(next)]);
      let og: any;
      try { og = resolveEntityCommandBoard({ infrastructure: { certifiedBoardNodes: ogNodes } } as never, { entityId: id, config: ogConfigOf(state, true), certifiedBoardState: ogRegistry } as never); } catch (e) { og = (e as Error).message; }
      const built = buildCommand(state, bobAddr, [{ type: "chat", data: { from: bobAddr, message: "x" } }], (d) => crypto.sign(d, bobAddr));
      if (typeof og === "string") expect(reasonOf(built)).toBe(og);
      else expect(built.ok && { boardHash: built.value.boardHash, boardEpoch: built.value.boardEpoch }).toEqual({ boardHash: og.boardHash, boardEpoch: og.boardEpoch });
    }
  });
});

describe(seedTag("EntityProvider actions (og entity/tx/handlers/entity-provider-action.ts, j-events-entity-provider-action.ts, j-events-board.ts)"), () => {
  const EP_J = { ...JCONF, name: "j" };
  const ogEnv = (nodes: Map<string, any>): any => ({
    state: { jReplicas: new Map([["j", { name: "j", chainId: JUR.chainId, depositoryAddress: JUR.depositoryAddress, entityProviderAddress: JUR.entityProviderAddress, contracts: { depository: JUR.depositoryAddress, entityProvider: JUR.entityProviderAddress } }]]) },
    infrastructure: { certifiedBoardNodes: nodes },
  });
  const ogStateOf = (s: EntityState, ogRegistry: any, action: any, timestamp: number): any => ({
    entityId: s.id, height: 0, timestamp, config: { ...ogConfigOf(s, true), jurisdiction: { ...OG_J, ...(s.jurisdictionConfig?.name === undefined ? { name: undefined } : {}) } },
    certifiedBoardState: ogRegistry, accounts: PersistentEntityAccountMap.fromEntries([], s.id, computeEntityAccountValueHash), ...(action === undefined ? {} : { entityProviderActionState: action }),
  });
  const cloneAction = (a: any): any => (a === undefined ? undefined : { ...a });
  const og = (f: () => any): { ok: true; value: any } | { ok: false; code: string } => { try { return { ok: true, value: f() }; } catch (e) { return { ok: false, code: (e as Error).message }; } };
  const ADDRS = ["0x" + "b1".repeat(20), "0x" + "00".repeat(20), "0xzz", "0xB1b1B1B1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1", "c2".repeat(20), " 0x" + "c3".repeat(20)];
  const setup = (id: string, jconf: typeof EP_J | typeof JCONF = EP_J) => {
    const members = new Map([[bobAddr, { shares: 1n }]]), board = quorumBoardHash({ _tag: "teaching", threshold: 1n, members });
    const base = unwrap(createEntity({ id: unwrap(entityId(id)), jurisdiction: DOMAIN, threshold: 1n, members, jurisdictionConfig: jconf }));
    return { board, ...observe(base.state, [foundation, registered(id, board)]) };
  };

  test("MATCH: 40 random runs of transfer / release / cancel / receipts / board activations give og's verdicts, action state, J outputs, hashesToSign and messages", () => {
    const seen = new Map<string, number>();
    for (let run = 0; run < 40; run += 1) {
      const id = word(8 + run);
      let { state, ogRegistry, ogNodes, board } = setup(id);
      let ogAction: any, block = 10, t = 1_000;
      const env = ogEnv(ogNodes);
      for (let step = 0; step < 14; step += 1) {
        t += 1 + ri(5);
        const pending = (state.committed["entityProviderActionState"] as any)?.pending, confirmed: bigint = (state.committed["entityProviderActionState"] as any)?.confirmedNonce ?? 0n;
        const r = rng();
        const ogS = ogStateOf(state, ogRegistry, cloneAction(ogAction), t);
        let mine: { ok: boolean; error?: unknown; state?: EntityState; hashes?: unknown; jOutputs?: unknown; messages?: string[] }, ogR: ReturnType<typeof og>;
        if (r < 0.55) {
          const tx: EntityTx = rng() < 0.5
            ? { type: "entityProviderTransfer", data: { to: pick(ADDRS), tokenId: pick([1n, 7n, -1n, 0n]), amount: pick([11n, 0n, 5n, -2n, 99n]) } }
            : { type: "entityProviderReleaseControlShares", data: { recipientAddress: pick(ADDRS), controlAmount: pick([0n, 3n, -1n]), dividendAmount: pick([0n, 4n]), purpose: pick(["", "payout", "x".repeat(1025), 5 as unknown as string]) } };
          ogR = og(() => (tx.type === "entityProviderTransfer" ? handleEntityProviderTransfer : handleEntityProviderReleaseControlShares)(ogS, tx as any, env, true));
          const f = foldTxs(state, new Map(), [tx], { verify: verifiers.verify, timestamp: BigInt(t) });
          mine = f.ok ? { ok: true, state: f.value.draft.state, hashes: f.value.draft.hashes, jOutputs: f.value.draft.jOutputs, messages: (f.value.draft.events ?? []).map((e) => e.message) } : f;
        } else if (r < 0.7) {
          const tx: EntityTx = { type: "entityProviderCancelAction", data: { actionHash: rng() < 0.75 && pending !== undefined ? pending.actionHash : pick([rword(), ""]) } };
          ogR = og(() => handleEntityProviderCancelAction(ogS, tx as any, env, true));
          const f = foldTxs(state, new Map(), [tx], { verify: verifiers.verify, timestamp: BigInt(t) });
          mine = f.ok ? { ok: true, state: f.value.draft.state, hashes: f.value.draft.hashes, jOutputs: f.value.draft.jOutputs, messages: (f.value.draft.events ?? []).map((e) => e.message) } : f;
        } else if (r < 0.88) {
          const executed = rng() < 0.5, nonce = confirmed + (rng() < 0.85 ? 1n : 2n);
          const x = pending === undefined ? { hash: rword(), kind: 0 as const } : pending.payload.kind === "cancelPendingAction" ? { hash: pending.payload.cancel.cancelledActionHash, kind: pending.payload.cancel.cancelledActionKind } : { hash: pending.actionHash, kind: pending.payload.kind === "entityTransferTokens" ? 0 as const : 1 as const };
          const hash = rng() < 0.85 ? x.hash : rword(), kind = rng() < 0.9 ? x.kind : (1 - x.kind) as 0 | 1, cancelHash = pending?.payload.kind === "cancelPendingAction" && rng() < 0.85 ? pending.actionHash : rword();
          const event: JEvent = executed ? { type: "EntityProviderActionExecuted", entityId: id, actionNonce: nonce, actionHash: hash, actionKind: kind } : { type: "EntityProviderActionCancelled", entityId: id, actionNonce: nonce, cancelledActionHash: hash, cancelledActionKind: kind, cancelHash };
          ogR = og(() => (executed ? applyEntityProviderActionExecuted(ogS, { entityId: id, actionNonce: nonce, actionHash: hash, actionKind: kind }, block) : applyEntityProviderActionCancelled(ogS, { entityId: id, actionNonce: nonce, cancelledActionHash: hash, cancelledActionKind: kind, cancelHash }, block)));
          const a = applyEntityProviderActionJEvent(state, event, block);
          mine = a.ok ? { ok: true, state: a.value.state, messages: a.value.events.map((e) => e.message) } : a;
        } else {
          block += 1;
          const next = rword();
          const event: JEvent = { type: "BoardActivated", entityId: id, previousBoardHash: board, newBoardHash: next, previousBoardValidUntil: 1_800_000_000n, meta: { blockNumber: block, blockHash: word(5000 + block), transactionHash: word(6000 + block), logIndex: 0 } };
          ogR = og(() => applyCertifiedBoardJEvent({ newState: ogS, event: toOgEvent(event), env, blockNumber: block, dirtyAccounts: new Set() } as any));
          const a = applyBoardJEvent(state, event, block);
          mine = a.ok ? { ok: true, state: a.value.state, messages: a.value.events.map((e) => e.message) } : a;
          if (a.ok) board = next;
        }
        expect(mine.ok ? "ok" : reasonOf(mine)).toBe(ogR.ok ? "ok" : ogR.code);
        const verdict = mine.ok ? `ok:${(mine.messages ?? []).map((m) => m.split(" ")[1]).join(",")}` : reasonOf(mine).split(":")[0] as string;
        seen.set(verdict, (seen.get(verdict) ?? 0) + 1);
        if (!mine.ok || !ogR.ok || mine.state === undefined) continue;
        if (ogR.value?.hashesToSign !== undefined) {
          // og's handler call has no frame: og applyEntityFrame appends the 'profile' hash after the txs (consensus-final.test.ts)
          expect(((mine.hashes ?? []) as { type: string }[]).filter((h) => h.type !== "profile")).toEqual(ogR.value.hashesToSign);
          expect(mine.jOutputs).toEqual(ogR.value.jOutputs);
        }
        expect(mine.messages).toEqual(readEntityFrameEventMessages(ogS));
        expect(mine.state.committed["entityProviderActionState"]).toEqual(ogS.entityProviderActionState);
        state = mine.state; ogAction = ogS.entityProviderActionState; ogRegistry = ogS.certifiedBoardState;
      }
    }
    // the runs reach accepted actions, cancels and receipts, board-activation expiry and the main refusals
    for (const v of ["ok:EntityProvider", "ok:BOARD,Pending", "ENTITY_PROVIDER_ACTION_PENDING", "ENTITY_PROVIDER_ACTION_CANCEL_PENDING_MISSING", "ENTITY_PROVIDER_ACTION_EVENT_NONCE_MISMATCH"]) expect(seen.get(v) ?? 0).toBeGreaterThan(0);
  });

  test("MATCH: a missing jurisdiction name, a lazy (uncertified) Entity and a committed pending intent refuse / commit like og", () => {
    const tx: EntityTx = { type: "entityProviderTransfer", data: { to: ADDRS[0] as string, tokenId: 1n, amount: 2n } };
    const unnamed = setup(word(70), JCONF);
    const ogUnnamed = og(() => handleEntityProviderTransfer(ogStateOf(unnamed.state, unnamed.ogRegistry, undefined, 5), tx as any, ogEnv(unnamed.ogNodes), true));
    expect(reasonOf(foldTxs(unnamed.state, new Map(), [tx], { verify: verifiers.verify, timestamp: 5n }))).toBe(ogUnnamed.ok ? "ok" : ogUnnamed.code);
    const members = new Map([[bobAddr, { shares: 1n }]]), lazy = quorumBoardHash({ _tag: "teaching", threshold: 1n, members });
    const lazyState = unwrap(createEntity({ id: unwrap(entityId(lazy)), jurisdiction: DOMAIN, threshold: 1n, members, jurisdictionConfig: EP_J })).state;
    const ogLazy = og(() => handleEntityProviderTransfer(ogStateOf(lazyState, undefined, undefined, 5), tx as any, ogEnv(new Map()), true));
    expect(reasonOf(foldTxs(lazyState, new Map(), [tx], { verify: verifiers.verify, timestamp: 5n }))).toBe(ogLazy.ok ? "ok" : ogLazy.code);
    // the pending intent is committed in the Entity root exactly as og commits entityProviderActionState
    const { state, ogRegistry, ogNodes } = setup(word(71));
    const ogS = ogStateOf(state, ogRegistry, undefined, 5);
    handleEntityProviderTransfer(ogS, tx as any, ogEnv(ogNodes), true);
    const folded = unwrap(foldTxs(state, new Map(), [tx], { verify: verifiers.verify, timestamp: 5n })).draft.state;
    const rootOf = (s: EntityState) => unwrap(entityRootOf({ ...s, timestamp: 5n }, new Map()));
    const ogRoot = (extra: Record<string, unknown>) => computeCanonicalEntityConsensusStateHash({
      entityId: state.id, height: 0, timestamp: 5, accounts: PersistentEntityAccountMap.fromEntries([], state.id, computeEntityAccountValueHash),
      config: { mode: "proposer-based", threshold: 1n, validators: [bobAddr.toLowerCase()], shares: { [bobAddr.toLowerCase()]: 1n }, jurisdiction: OG_J },
      paybook: { entries: PersistentEntityCollectionMap.empty("paybookHashlock"), feesEarned: 0n }, certifiedBoardState: ogRegistry, ...extra,
    } as any);
    expect(rootOf(folded)).toBe(ogRoot({ entityProviderActionState: ogS.entityProviderActionState }));
    expect(rootOf(folded)).not.toBe(rootOf(state));
  });

  test("MATCH: the frame manifest signs the action hash beside the frame hash (og buildEntityHashesToSign)", () => {
    const members = new Map([[aliceAddr, { shares: 1n }], [bobAddr, { shares: 1n }]]), id = word(72);
    const replica = unwrap(createEntity({ id: unwrap(entityId(id)), jurisdiction: DOMAIN, threshold: 2n, members, jurisdictionConfig: EP_J }));
    const { state } = observe(replica.state, [foundation, registered(id, quorumBoardHash({ _tag: "teaching", threshold: 2n, members }))]);
    const tx: EntityTx = { type: "entityProviderTransfer", data: { to: ADDRS[0] as string, tokenId: 1n, amount: 2n } };
    const p = unwrap(applyEntityInput({ ...replica, state }, { kind: "txs", timestamp: 9n, txs: [tx] }, { ...verifiers, self: state.id, signerId: aliceAddr })).replica;
    if (p._tag !== "proposed") throw new Error("phase");
    const action = (p.draft.state.committed["entityProviderActionState"] as any).pending;
    const frameHash = unwrap(hashEntityFrame(p.frame));
    // og appendFinalProfileHash: the genesis frame also signs the profile descriptor hash (og's genesis profile is all empty text)
    const profile = computeEntityProfileHash({ entityId: id, entityEncryptionPublicKey: "", profile: { name: "", isHub: false, avatar: "", bio: "", website: "" }, accounts: new Map(), config: { jurisdiction: { ...OG_J, ...EP_J } } } as never);
    expect<readonly unknown[]>(p.frame.hashesToSign).toEqual(buildEntityHashesToSign(id, 1, frameHash, [{ hash: action.actionHash, type: "entityProviderAction", context: `entityProviderAction:${id.slice(-4)}:entityTransferTokens:nonce:1` }, { hash: profile, type: "profile", context: `profile:${profile}` }]));
    expect(p.frame.hashesToSign.length).toBe(3);
  });
});

describe(seedTag("CONTROL board proposal and activation (og entity/tx/handlers/control-board-proposal.ts)"), () => {
  const EP_J = { ...JCONF, name: "j" };
  const og = async (f: () => any): Promise<{ ok: true; value: any } | { ok: false; code: string }> => { try { return { ok: true, value: await f() }; } catch (e) { return { ok: false, code: (e as Error).message }; } };
  const realVerify = (d: string, hanko: string, entity: string, authority?: { readonly registeredBoardHash?: string | undefined }): boolean => verifyAccountHanko(hanko, d, entity, authority?.registeredBoardHash).ok;
  test("MATCH: random proposals (targets, board hashes, nonces, supporter consents) and activations give og's verdicts, proposal hash, J outputs and messages", async () => {
    const S = word(80), T = word(81), U = word(82), X = word(83);
    const one = new Map([[bobAddr, { shares: 1n }]]), three = new Map([aliceAddr, bobAddr, carolAddr].map((a) => [a, { shares: 1n }] as const));
    const uAuthority = { _tag: "teaching" as const, threshold: 2n, members: three };
    const base = unwrap(createEntity({ id: unwrap(entityId(S)), jurisdiction: DOMAIN, threshold: 1n, members: one, jurisdictionConfig: EP_J }));
    const uBase = unwrap(createEntity({ id: unwrap(entityId(U)), jurisdiction: DOMAIN, threshold: 2n, members: three, jurisdictionConfig: JCONF }));
    const events = [foundation, registered(S, quorumBoardHash({ _tag: "teaching", threshold: 1n, members: one }), 3, 0), registered(T, word(777), 3, 1), registered(U, quorumBoardHash(uAuthority), 3, 2)];
    const { state, ogRegistry, ogNodes } = observe(base.state, events);
    const uState = observe(uBase.state, events).state;
    const env: any = { state: { jReplicas: new Map([["j", { name: "j", chainId: JUR.chainId, depositoryAddress: JUR.depositoryAddress, entityProviderAddress: JUR.entityProviderAddress, contracts: { depository: JUR.depositoryAddress, entityProvider: JUR.entityProviderAddress } }]]) }, infrastructure: { certifiedBoardNodes: ogNodes } };
    const ogState = (): any => ({ entityId: S, height: 0, timestamp: 77, config: ogConfigOf(state, true), certifiedBoardState: ogRegistry, accounts: PersistentEntityAccountMap.fromEntries([], S, computeEntityAccountValueHash) });
    const consent = (digest: string, signers: readonly Address[]): string => unwrap(quorumHanko(uState, digest, new Map(signers.map((a) => [a, unwrap(crypto.sign(digest as Hash, a))] as const))));
    const seen = new Set<string>(), wanted = ["entityProviderProposeControlBoard:ok", "entityProviderActivateBoard:ok", "entityProviderProposeControlBoard:CONTROL_BOARD_PROPOSAL_SUPPORTER_HANKO_INVALID", "entityProviderProposeControlBoard:CONTROL_BOARD_PROPOSAL_TARGET_AUTHORITY_MISSING", "consents:2"];
    for (let i = 0, more = untilCovered(60, () => wanted.every((v) => seen.has(v))); more(i); i += 1) {
      const activate = rng() < 0.2;
      const target = pick([T, T, T, X, U, "0x12", T.toUpperCase().replace("0X", "0x")]);
      let tx: EntityTx;
      if (activate) tx = { type: "entityProviderActivateBoard", data: { targetEntityId: target } };
      else {
        const nonce = pick([1n, 2n, 0n, -1n]), newBoardHash = pick([word(4242), "0x1234", word(99).toUpperCase().replace("0X", "0x")]);
        const probe = target.length !== 66 || newBoardHash.length !== 66 ? word(1) : boardProposalHash({ chainId: BigInt(JUR.chainId), entityProviderAddress: JUR.entityProviderAddress, boardEpoch: 0n, entityId: target.toLowerCase(), newBoardHash: newBoardHash.toLowerCase(), authority: 1, actionNonce: nonce > 0n ? nonce : 1n });
        const supporterVotes = pick([[], [{ entityId: U, hankoSignature: consent(probe, [aliceAddr, carolAddr]) }], [{ entityId: U, hankoSignature: consent(probe, [bobAddr, carolAddr]).slice(0, -2) + "00" }], [{ entityId: U, hankoSignature: consent(word(1), [aliceAddr, bobAddr]) }],
          [{ entityId: S, hankoSignature: "0x" }], [{ entityId: X, hankoSignature: "0x" }], [{ entityId: U, hankoSignature: consent(probe, [aliceAddr, carolAddr]) }, { entityId: U, hankoSignature: "0x" }]]);
        tx = { type: "entityProviderProposeControlBoard", data: { targetEntityId: target, newBoardHash, actionNonce: nonce, ...(rng() < 0.2 && supporterVotes.length === 0 ? {} : { supporterVotes }) } };
      }
      const ogS = ogState();
      const ogR = await og(() => (activate ? handleEntityProviderActivateBoard(ogS, tx as any, env, true) : handleEntityProviderProposeControlBoard(ogS, tx as any, env, true)));
      const f = foldTxs(state, new Map(), [tx], { verify: realVerify, timestamp: 77n });
      expect(f.ok ? "ok" : reasonOf(f)).toBe(ogR.ok ? "ok" : ogR.code);
      seen.add(`${tx.type}:${ogR.ok ? "ok" : ogR.code.split(":")[0]}`);
      if (!f.ok || !ogR.ok) continue;
      expect(f.value.draft.jOutputs).toEqual(ogR.value.jOutputs);
      // og's handler call has no frame: og applyEntityFrame appends the 'profile' hash after the txs (consensus-final.test.ts)
      expect((f.value.draft.hashes ?? []).filter((h) => h.type !== "profile")).toEqual(ogR.value.hashesToSign ?? []);
      expect((f.value.draft.events ?? []).map((e) => e.message)).toEqual(readEntityFrameEventMessages(ogS));
      seen.add(`consents:${(ogR.value.jOutputs[0].jTxs[0].data.supporterVotes ?? []).length}`);
    }
    for (const v of wanted) expect([v, seen.has(v)]).toEqual([v, true]);
  }, 30_000);
});

describe(seedTag("AC-13b receiving side: the Entity supplies counterpartyCertifiedBoard from its registry (og input-phases.ts)"), () => {
  test("MATCH: a board_hanko_refresh for a committed Account is checked against the sender's certified board record; without one the Account refuses (og CERTIFIED_BOARD_MISSING)", () => {
    const door = (self: EntityId): DoorContext => ({ verify: hankoVerify, self, now: NOW });
    const a0 = unwrap(admit(genesisAB(), [{ type: "add_delta", tokenId: unwrap(tokenId("1")) }]));
    const proposed = unwrap(applyAccountInput(a0, proposeInput(a0, ALICE), door(ALICE))).replica as ProposedAccount;
    const received = unwrap(applyAccountInput(genesisAB(), offerOf(proposed, ALICE), door(BOB))).replica;
    const alice = unwrap(applyAccountInput(proposed, ackInput(received, BOB), door(ALICE))).replica;
    if (alice.head._tag !== "installed") throw new Error("not committed");
    const frameHash = alice.head.prevFrameHash;
    const base = unwrap(createEntity({ id: ALICE, jurisdiction: DOMAIN, threshold: 1n, members: new Map([[aliceAddr, { shares: 1n }]]), jurisdictionConfig: JCONF })).state;
    const activated: JEvent = { type: "BoardActivated", entityId: BOB, previousBoardHash: word(500), newBoardHash: word(900), previousBoardValidUntil: 1_800_000_000n, meta: { blockNumber: 7, blockHash: word(71), transactionHash: word(72), logIndex: 2 } };
    const certified = observe(base, [foundation, registered(BOB, word(500)), activated]).state;
    const input = { kind: "board_hanko_refresh" as const, ...envelopeAB(BOB), height: 1n, frameHash, frameHanko: `0x${"ab".repeat(40)}`, boardActivationJHeight: 7, boardActivationLogIndex: 2 };
    const seen: unknown[] = [];
    const verify: Verify = (_d, _h, _e, authority) => { seen.push(authority); return true; };
    const run = (state: EntityState) => foldTxs(state, new Map([[BOB, alice]]), [{ type: "accountInput", data: input }], { verify, timestamp: NOW });
    const refused = run(base);
    expect(refused.ok).toBe(false);
    expect(JSON.stringify(refused.ok ? null : refused.error)).toContain("certified_board_missing");
    const accepted = run(certified);
    expect(accepted.ok).toBe(true);
    expect(seen).toEqual([{ registeredBoardHash: word(900), allowPreviousBoard: false }]);
    expect(accepted.ok && accepted.value.draft.accountReplicas.get(BOB)?.boardRefresh).toEqual({ activationJHeight: 7, activationLogIndex: 2, frameHeight: 1, frameHash });
  });
});
