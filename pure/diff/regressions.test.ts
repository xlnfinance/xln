// Regressions for the divergences reseeding the randomized MATCH tests exposed (review A0). Each test pins the exact
// input one reseeded run produced, runs og live on it and compares og's committed outcome with the rewrite's.
import { describe, expect, test } from "bun:test";

// ---- og ----
import { applyAccountEnqueue } from "../../core/account/input/local-tx-admission.ts";
import { PersistentAccountStateMap } from "../../core/account/state/persistent-state-map.ts";
import { buildEntityTransactionProposalAction, hashEntityProposalAction } from "../../core/entity/auth/authorization.ts";
import { accountHasProposableMempoolForEntity } from "../../core/entity/consensus/account/mempool-eligibility.ts";
import { EntityAccountCandidateMap, PersistentEntityAccountMap } from "../../core/entity/state/persistent-account-map.ts";
import { ensureEntityCollectionCandidate } from "../../core/entity/state/persistent-collection-map.ts";
import { handleSetRebalancePolicyEntityTx } from "../../core/entity/tx/handlers/account/lifecycle/admin.ts";
import { processOrderbookSwaps as ogProcessSwaps } from "../../core/entity/tx/handlers/account/orderbook/index.ts";
import { applyJEvent as ogApplyJEvent } from "../../core/entity/tx/j-events.ts";
import * as ogCrossIndex from "../../core/extensions/cross-j/index.ts";
import { canonicalJurisdictionEventsHash, getJEventJurisdictionRef } from "../../core/jurisdiction/machine/event-observation.ts";
import { compareCanonicalJurisdictionEvents, normalizeJurisdictionEvent } from "../../core/jurisdiction/machine/events/event-normalization.ts";
import {
  EMPTY_J_HISTORY_ROOT as OG_EMPTY_ROOT, buildJEventRangeDigest, canonicalJEventRangeHash, foldJHistoryRoot as ogFoldRoot,
} from "../../core/jurisdiction/machine/history-consensus/index.ts";
import { computeBookCommitmentHash } from "../../core/orderbook/commitment.ts";
import { rebuildOrderbookPairIndex } from "../../core/orderbook/order-index.ts";
import { markWorkingOrderbookOffer, normalizeSwapOfferForOrderbook } from "../../core/orderbook/swap-execution.ts";

// ---- rewrite ----
import {
  bookCommitmentHash, configBoardHash, createEntity, entityId, entityTransactionAction, foldTx, foldTxs, hashHtlcSecret, hashProposalAction,
  installedAccount, offersForMatching, processOrderbookSwaps, tokenId, wireEntityTx, wireOf,
  type AccountReplica, type BookTx, type EntityId, type EntityReplica, type EntityState, type EntityTx, type HtlcLock, type Hub, type HubAccount,
  type OrderbookExt, type SwapOffer, type SwapOfferEvent, type WireAccountTx,
} from "../xln.ts";
import { ALICE, BOB, NOW, TERMS, UNREGISTERED_J, aliceAddr, anvilKey, genesisAB, hankoVerify, signDigestHex, signedTxs, unwrap, verifiers } from "../xln_run.ts";

/** og's committed Account collections are Patricia-backed maps; their commitment is `rootHash()`. */
const ogRootHash = (c: object): string => {
  if (!("rootHash" in c) || typeof c.rootHash !== "function") throw new Error("og collection has no rootHash");
  return String(c.rootHash());
};

const tk = (n: number) => unwrap(tokenId(String(n)));
const W = (b: string) => ("0x" + b.repeat(32)) as EntityId;
const ogThrows = <T,>(f: () => T): { ok: true; value: T } | { ok: false; reason: string } => { try { return { ok: true, value: f() }; } catch (e) { return { ok: false, reason: (e as Error).message }; } };

// ============ SecretRevealed twice in one finalized range (disputes-final:419 at SEEDX=12345 case 105, 987654 case 70) ============
// og applyKnownHtlcSecret returns one htlc_resolve per event, so a secret revealed twice yields the same resolve twice;
// og's Account admission (local-tx-admission.ts) keeps lifecycle txs idempotent by exact payload, so the Account
// mempool holds it once. The rewrite's mempool must equal og's admitted mempool, not og's raw returned list.
describe("regressions: finalized SecretRevealed on the Entity", () => {
  const JEP = "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512", T0 = 1_700_000_050_000;
  const OG_J = { name: "j", chainId: TERMS.domain.chainId, depositoryAddress: TERMS.domain.depositoryAddress, entityProviderAddress: JEP };
  const JREF = getJEventJurisdictionRef(OG_J), SIGNER = aliceAddr.toLowerCase();
  const word = (b: string) => "0x" + b.repeat(32);
  /** ALICE's proposer-signed range, one block per event, above genesis. */
  const range = (events: readonly { type: string; data: Record<string, unknown> }[]): Record<string, unknown> => {
    const baseHeight = 0, scannedThroughHeight = events.length;
    const blocks = events.map((e, i) => {
      const blockNumber = i + 1, blockHash = word((0x10 + i).toString(16));
      const normalized = [normalizeJurisdictionEvent({ ...e, blockNumber, blockHash, transactionHash: word((0x40 + i).toString(16)), logIndex: 0 })!].sort(compareCanonicalJurisdictionEvents);
      return { blockNumber, blockHash, eventsHash: canonicalJurisdictionEventsHash(normalized), events: normalized };
    });
    const tipBlockHash = word("7e");
    const eventHistoryRoot = ogFoldRoot(OG_EMPTY_ROOT, blocks.map((b) => ({ jurisdictionRef: JREF, jHeight: b.blockNumber, jBlockHash: b.blockHash, eventsHash: b.eventsHash })));
    const rangeHash = canonicalJEventRangeHash(JREF, blocks);
    const digest = buildJEventRangeDigest({ entityId: ALICE, jurisdictionRef: JREF, signerId: SIGNER, baseHeight, scannedThroughHeight, tipBlockHash, eventHistoryRoot, rangeHash });
    return { from: SIGNER, jurisdictionRef: JREF, baseHeight, scannedThroughHeight, observedAt: scannedThroughHeight, tipBlockHash, blocks, eventHistoryRoot, rangeHash, signature: signDigestHex(digest, anvilKey(2)) };
  };
  const bookSlot = { getPaybookEntry: (s: any, h: string) => s.paybook.entries.get(h), getPaybookEntryForWrite: (s: any, h: string) => s.paybook.entries.get(h), addPaybookFees: (s: any, amount: bigint) => { s.paybook.feesEarned += amount; } };

  test("MATCH: a secret revealed twice in one range resolves its inbound lock once, as og's admitted Account mempool", async () => {
    const base = genesisAB(), left = base.state.account.id.left, aliceLeft = left.toLowerCase() === ALICE.toLowerCase();
    const secretA = word("39"), secretB = word("9a"), hashA = hashHtlcSecret(secretA)!, hashB = hashHtlcSecret(secretB)!;
    // an inbound lock under its own id and one keyed by its hashlock, as the generator built them
    const lockOf = (lockId: string, hashlock: string): HtlcLock => ({ lockId, hashlock, timelock: 1_800_000_000_000n, revealBeforeHeight: 99n, amount: 5n, tokenId: tk(1), senderIsLeft: !aliceLeft, createdHeight: 1n, createdTimestamp: 1n });
    const locks = new Map([["lock105_1", lockOf("lock105_1", hashA)], [hashB, lockOf(hashB, hashB)]]);
    const reveal = (secret: string, hashlock: string) => ({ type: "SecretRevealed", data: { hashlock, revealer: word("0f"), secret } });
    const data = range([reveal(secretA, hashA), reveal(secretB, hashB), reveal(secretA, hashA)]);
    // rewrite
    const created = unwrap(createEntity({ id: ALICE, jurisdiction: TERMS.domain, threshold: 1n, members: new Map([[aliceAddr, { shares: 1n }]]), jurisdictionConfig: { name: "j", entityProviderAddress: JEP } })).state;
    const rw: EntityState = { ...created, crossJurisdictionSwaps: new Map() as never, paybook: { entries: new Map(), feesEarned: 0n } };
    const replica = { ...base, state: { ...base.state, locks } } as AccountReplica;
    const draft = unwrap(foldTx(rw, new Map([[BOB, replica]]), { type: "j_event", data: data as never }, { verify: verifiers.verify, timestamp: BigInt(T0) }));
    const rwMempool = (draft.accountReplicas.get(BOB)!.mempool ?? []).map((t: any) => [t.type, t.lockId, t.secret]);
    // og: applyJEvent, then og's own Account admission of what it returned
    const ogLocks = new Map([...locks].map(([k, l]) => [k, { ...l, tokenId: 1 }]));
    const ogAccount: any = { status: "active", state: { jNonce: 0, leftEntity: left, rightEntity: base.state.account.id.right, locks: ogLocks, disputeConfig: { ...TERMS.disputeConfig } } };
    const accounts = new Map([[BOB as string, ogAccount]]);
    const shell = Object.assign(Object.create(EntityAccountCandidateMap.prototype), { get: (id: string) => accounts.get(id), getForWrite: (id: string) => accounts.get(id), has: (id: string) => accounts.has(id), keys: () => accounts.keys(), entries: () => accounts.entries(), values: () => accounts.values(), [Symbol.iterator]: () => accounts.entries() });
    const swaps = ensureEntityCollectionCandidate(undefined, ogCrossIndex.cloneCrossJurisdictionRoute as never);
    const og: any = { entityId: ALICE, timestamp: T0, height: 0, lastFinalizedJHeight: 0, config: { mode: "proposer-based", threshold: 1n, validators: [SIGNER], shares: { [SIGNER]: 1n }, jurisdiction: OG_J },
      reserves: new Map(), outDebtsByToken: new Map(), inDebtsByToken: new Map(), accounts: shell, crossJurisdictionSwaps: swaps, paybook: { entries: new Map(), feesEarned: 0n } };
    const applied = await ogApplyJEvent(og, data as never, { quietRuntimeLogs: true } as never, {} as never, [], true, bookSlot as never);
    const returned = applied.accountTxs.filter((t: any) => t.accountId === BOB);
    expect(returned.map((t: any) => t.tx.data.lockId)).toEqual(["lock105_1", hashB, "lock105_1"]);
    const admitted: any = { mempool: [], state: { domain: { ...TERMS.domain } }, proofHeader: { fromEntity: ALICE, toEntity: BOB } };
    applyAccountEnqueue(admitted, { kind: "enqueue", txs: returned.map((t: any) => t.tx) }, undefined as never);
    expect(rwMempool).toEqual(admitted.mempool.map((t: any) => [t.type, t.data.lockId, t.data.secret]));
  });
});

// ============ setRebalancePolicy next to a queued request (entity-txs-3:367 at SEEDX=987654 case 19) ============
// og's handler returns no new request (one is already queued for the token). The rewrite's Entity frame proposes the
// Account's queued request as the next Account frame, and so does og: its frame primes every Account whose mempool is
// proposable (primeEntityFrameAccountWork) before the txs run. The frame therefore carries the queued mempool plus
// og's returned txs, never a request the rewrite invented.
describe("regressions: setRebalancePolicy beside a queued request_collateral", () => {
  test("MATCH: og returns no request and primes the Account; the rewrite's proposed frame is exactly the queued mempool", () => {
    const seedOf = (id: EntityId) => unwrap(createEntity({ id, jurisdiction: TERMS.domain, threshold: 1n, members: new Map([[aliceAddr, { shares: 1n }]]), jurisdictionConfig: UNREGISTERED_J }));
    const a: EntityReplica = seedOf(unwrap(entityId(configBoardHash(seedOf(ALICE).state.quorum))));
    const openTx = { type: "openAccount", data: { targetEntityId: BOB, accountDomain: TERMS.domain, watchSeed: TERMS.watchSeed, disputeConfig: TERMS.disputeConfig } } as EntityTx;
    // og: a frame carries Alice's local txs as her signed Entity commands
    const opened = unwrap(foldTxs(a.state, a.accountReplicas, signedTxs(a.state, aliceAddr, [openTx]), { verify: hankoVerify, timestamp: NOW })).draft;
    const base = opened.accountReplicas.get(BOB)!;
    const selfIsLeft = base.state.account.id.left === a.state.id;
    const k = tk(2), delta = { tokenId: k, collateral: 0n, ondelta: -400n, offdelta: -500n, leftCreditLimit: 0n, rightCreditLimit: 0n };
    const fee = { policyVersion: 3, baseFee: 17n, liquidityFeeBps: 5000n, gasFee: 4n, updatedAt: 1 };
    const policy = { r2cRequestSoftLimit: 0n, hardLimit: 700n, maxAcceptableFee: 10_000n };
    const body = { ...base.state, account: { ...base.state.account, deltas: new Map([[k, delta]]) }, feePolicies: new Map([[k, selfIsLeft ? { right: fee } : { left: fee }]]), requested: new Map([[k, 5n]]) };
    const queuedTx = { type: "request_collateral", tokenId: k, amount: 1n, feeAmount: 0n, policyVersion: 1 } as never;
    const child = { ...base, _tag: "open", state: body, mempool: [queuedTx] } as AccountReplica;
    const tx: EntityTx = { type: "setRebalancePolicy", data: { counterpartyEntityId: BOB, tokenId: k, ...policy } };
    const d = unwrap(foldTxs(opened.state, new Map([[BOB, child]]), signedTxs(opened.state, aliceAddr, [tx]), { verify: hankoVerify, timestamp: NOW })).draft;
    const ogAcc: any = {
      state: { leftEntity: base.state.account.id.left, rightEntity: base.state.account.id.right,
        deltas: PersistentAccountStateMap.fromEntries("deltas", [[2, { ...delta, tokenId: 2, leftAllowance: 0n, rightAllowance: 0n, leftHold: 0n, rightHold: 0n }]] as never),
        requestedRebalance: PersistentAccountStateMap.fromEntries("requestedRebalance", [[2, 5n]] as never), rebalanceFeePolicies: PersistentAccountStateMap.fromEntries("rebalanceFeePolicies", [[2, selfIsLeft ? { right: fee } : { left: fee }]] as never) },
      shadow: { rebalance: { policy: PersistentAccountStateMap.fromEntries("rebalanceShadowPolicy", [...(base.rebalancePolicy ?? new Map())] as never), submittedAtByToken: PersistentAccountStateMap.empty("rebalanceShadowSubmitted") } },
      pendingWithdrawals: PersistentAccountStateMap.empty("pendingWithdrawals"), proofHeader: { fromEntity: a.state.id, toEntity: BOB, nextProofNonce: 1 }, currentHeight: 0, status: "active",
      mempool: [{ type: "request_collateral", data: { type: "request_collateral", tokenId: 2, amount: 1n, feeAmount: 0n, policyVersion: 1 } }],
    };
    const members = [...(a.state.quorum as { members: ReadonlyMap<string, { shares: bigint }> }).members];
    const ogConfig = { mode: "proposer-based", threshold: 1n, validators: members.map(([m]) => m.toLowerCase()), shares: Object.fromEntries(members.map(([m, x]) => [m.toLowerCase(), x.shares])) };
    const ogS: any = { entityId: a.state.id, config: ogConfig, accounts: new EntityAccountCandidateMap(PersistentEntityAccountMap.fromEntries([[BOB, ogAcc]], a.state.id, () => "0x" + "00".repeat(32) as never)) };
    const og = handleSetRebalancePolicyEntityTx({ quietRuntimeLogs: true } as never, ogS, { type: "setRebalancePolicy", data: { counterpartyEntityId: BOB, tokenId: 2, ...policy } } as never, true);
    expect(og.accountTxs).toEqual([]);
    const ogAfter = og.newState.accounts.get(BOB);
    if (ogAfter === undefined) throw new Error("og dropped the account");
    expect(accountHasProposableMempoolForEntity(ogAfter, a.state.id)).toBe(true);
    const after = d.accountReplicas.get(BOB)!;
    expect(unwrap(installedAccount(a.state.id, BOB, after)).policyRoot).toBe(ogRootHash(ogAfter.shadow.rebalance.policy));
    expect(after._tag).toBe("proposed");
    const proposed = after._tag === "proposed" ? after.candidate.frame.txs : [];
    const asOg = (t: any) => ({ type: t.type, tokenId: Number(t.tokenId), amount: t.amount, feeAmount: t.feeAmount, policyVersion: t.policyVersion });
    expect(proposed.map(asOg)).toEqual([...ogAfter.mempool, ...(og.accountTxs ?? []).map((x: any) => x.tx)].map((t: any) => asOg(t.data)));
  });
});

// ============ an out-of-band sweep with no accepted command on the pair (book-admission:369 at SEEDX=12345 stream 8/3) ============
// og sweeps a pair's resting rows outside the anchor band into its hot book once per pass, and publishes that book only
// when a command on the pair commits. A pass whose only offers on the pair are band-rejected updates no book there;
// the swept rows' resolves are queued and remove them when they commit.
describe("regressions: same-j sweep without a committed command", () => {
  const HUB = W("aa"), USERS = [W("0b"), W("cc"), W("0d"), W("ee")];
  const leftOf = (u: string) => (u < HUB ? u : HUB), rightOf = (u: string) => (u < HUB ? HUB : u);
  const toOgTx = (tx: WireAccountTx) => { const { type, ...data } = wireOf(tx) as { type: string }; return { type, data }; };
  const toOgOffer = (o: SwapOffer) => ({ ...o, giveTokenId: Number(o.giveTokenId), wantTokenId: Number(o.wantTokenId) });
  const hubProfile = { entityId: HUB, name: "hub", spreadDistribution: { makerBps: 0, takerBps: 10_000, hubBps: 0, makerReferrerBps: 0, takerReferrerBps: 0 }, referenceTokenId: 1, usdQuoteAuthorityEntityId: USERS[0]!, minTradeSize: 0n, supportedPairs: [] };
  type Truth = { offers: Map<string, Map<string, SwapOffer>> };
  const rwHub = (t: Truth, ext: OrderbookExt): Hub => ({ id: HUB, ext, takerFeeBps: 0, accounts: new Map(USERS.map((u): [string, HubAccount] => [u, { active: true, left: leftOf(u), right: rightOf(u), offers: t.offers.get(u)!, queued: [] }])) });
  const ogHub = (t: Truth, ext: any): any => ({
    entityId: HUB, hubRebalanceConfig: { swapTakerFeeBps: 0 }, orderbookExt: ext,
    accounts: new Map(USERS.map((u) => [u, { status: "active", mempool: [], state: { leftEntity: leftOf(u), rightEntity: rightOf(u), swapOffers: new Map([...t.offers.get(u)!].map(([id, o]) => [id, toOgOffer(o)])) } }])),
  });
  /** A GTC offer on pair 7/8 (both 6 decimals): `sell` asks base 7 for quote 8. */
  const offer = (offerId: string, u: string, sell: boolean, price: bigint, base: bigint, height: number): SwapOffer => {
    const quote = (base * price) / 10_000n;
    const [give, want, ga, wa] = sell ? [7, 8, base, quote] : [8, 7, quote, base];
    return { offerId, giveTokenId: tk(give), giveTokenDecimals: 6, giveAmount: ga, wantTokenId: tk(want), wantTokenDecimals: 6, wantAmount: wa, maxFee: 0n, minNetReceive: wa, priceTicks: price,
      timeInForce: 0, makerIsLeft: u < HUB, createdHeight: height, quantizedGive: ga, quantizedWant: wa };
  };
  const eventOf = (u: string, o: SwapOffer): SwapOfferEvent => ({ offerId: o.offerId, accountId: u, makerIsLeft: o.makerIsLeft, fromEntity: leftOf(u), toEntity: rightOf(u), createdHeight: o.createdHeight,
    giveTokenId: Number(o.giveTokenId), giveTokenDecimals: o.giveTokenDecimals, giveAmount: o.giveAmount, wantTokenId: Number(o.wantTokenId), wantTokenDecimals: o.wantTokenDecimals, wantAmount: o.wantAmount,
    maxFee: o.maxFee, minNetReceive: o.minNetReceive, priceTicks: o.priceTicks, timeInForce: 0 });

  test("MATCH: three passes on one pair (rest, raise the anchor, sweep with a band-rejected offer): same resolves and updated books as og", () => {
    const t: Truth = { offers: new Map(USERS.map((u) => [u, new Map()])) };
    let rwExt: OrderbookExt = { books: new Map(), pairDimensions: new Map(), referrals: new Map(), hubProfile };
    const ogExt: any = { books: new Map(), orderPairs: new Map(), pairDimensions: new Map(), referrals: new Map(), hubProfile };
    // pass 0: two bids rest (3800 is inside the band around 5000); pass 1: a bid at 6400 moves the anchor so 3800 falls
    // outside it; pass 2: an ask far outside the band touches the pair, sweeps 3800 and is itself rejected
    const passes: readonly (readonly [string, SwapOffer])[][] = [
      [[USERS[0]!, offer("b1", USERS[0]!, false, 5000n, 20_000n, 0)], [USERS[1]!, offer("b2", USERS[1]!, false, 3800n, 30_000n, 0)]],
      [[USERS[2]!, offer("b3", USERS[2]!, false, 6400n, 10_000n, 1)]],
      [[USERS[3]!, offer("a1", USERS[3]!, true, 20_000n, 10_000n, 2)]],
    ];
    const updated: string[][] = [];
    for (const [pass, placed] of passes.entries()) {
      for (const [u, o] of placed) t.offers.get(u)!.set(o.offerId, o);
      const hub = rwHub(t, rwExt), offers = unwrap(offersForMatching(hub, placed.map(([u, o]) => eventOf(u, o))));
      const ogOffers = offers.map((o) => markWorkingOrderbookOffer(normalizeSwapOfferForOrderbook({ ...o, accountOutputVerified: true } as never, o.accountId)));
      const ogMatch = ogProcessSwaps(ogHub(t, ogExt), ogOffers, { resumeSamePairIds: [] });
      const rwMatch = unwrap(processOrderbookSwaps(hub, offers, []));
      expect([pass, rwMatch.accountTxs.map(({ accountId, tx }: BookTx) => ({ accountId, tx: toOgTx(tx) }))]).toEqual([pass, ogMatch.accountTxs.map(({ accountId, tx }) => ({ accountId, tx }))]);
      expect([pass, [...rwMatch.books.keys()]]).toEqual([pass, ogMatch.bookUpdates.map((b) => b.pairId)]);
      for (const { pairId, book } of ogMatch.bookUpdates) expect([pass, pairId, bookCommitmentHash(rwMatch.books.get(pairId)!)]).toEqual([pass, pairId, computeBookCommitmentHash(book)]);
      updated.push([...rwMatch.books.keys()]);
      rwExt = { ...rwExt, books: new Map([...rwExt.books, ...rwMatch.books]), pairDimensions: rwMatch.pairDimensions };
      for (const { pairId, book } of ogMatch.bookUpdates) ogExt.books.set(pairId, book);
      rebuildOrderbookPairIndex(ogExt);
      if (pass === 2) {
        // the sweep queued b2's cancel and a1's band reject, yet the pair's committed book is untouched this pass
        expect(ogMatch.accountTxs.map(({ tx }: any) => [tx.data.offerId, tx.data.comment])).toEqual([["b2", "outside-anchor-band:3800"], ["a1", "outside-anchor-band:20000"]]);
      }
    }
    expect(updated).toEqual([["7/8"], ["7/8"], []]);
  });
});

// ============ og's own action hash over txs sharing object references (entity-txs-3:114 at SEEDX=12345 case 53) ============
// Not a divergence. The generator reuses one accountDomain / disputeConfig object across openAccount txs. og's
// assertEntityProposalAction re-hashes a structuredClone of the txs, and Bun's structuredClone mis-links repeated
// references that follow a bigint, so og refuses its own action. On the same values without shared references og and
// the rewrite agree on both hashes.
describe("regressions: collective action hash over the reseeded batch", () => {
  test("MATCH: requestCollateral + two openAccounts (fresh objects): same actionHash and proposal action hash as og", () => {
    const openAccount = (extra: Record<string, unknown>): EntityTx => ({ type: "openAccount", data: { targetEntityId: BOB, accountDomain: { ...TERMS.domain }, watchSeed: TERMS.watchSeed, disputeConfig: { ...TERMS.disputeConfig }, ...extra } }) as EntityTx;
    const txs: EntityTx[] = [
      { type: "requestCollateral", data: { counterpartyEntityId: BOB, tokenId: tk(1), amount: 711n, feeAmount: 1n, policyVersion: 1, feeTokenId: tk(2) } },
      openAccount({ tokenId: tk(2), creditAmount: 7n }),
      openAccount({}),
    ];
    const action = unwrap(entityTransactionAction(txs)), og = buildEntityTransactionProposalAction(txs.map((x) => wireEntityTx(x) as never));
    expect(action.type === "entity_transaction" ? action.data.actionHash : "").toBe(og.data.actionHash);
    expect(ogThrows(() => hashEntityProposalAction(og))).toEqual({ ok: true, value: unwrap(hashProposalAction(action)) });
  });
});
