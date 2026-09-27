// Behavioural diff: the order of the committed-frame followups of one accountInput (og entity/tx/handlers/account/committed-input.ts
// applySuccessfulAccountInput: applyCommittedFrameTransactions frame by frame, then applyCommittedHtlcFollowups) vs pure/xln.ts committedFollowups.
// "MATCH:" tests run og live on the same inputs: our own frame the peer ACKed and the peer's frame we signed, both carrying lending, HTLC and
// same-j / cross-j swap txs, plus direct-payment forwards. They assert the same accept / refuse, returned Account txs in mempool order, the
// Account worklist order, runtime events, swap events, lending book and paybook.
import { describe, expect, test } from "bun:test";
import { seedOf, seedTag } from "./seed.ts";
import { x25519 } from "@noble/curves/ed25519";
import {
  EMPTY_HTLC_INFRA, accountId, committedFollowups, createEntity, crontabOf, withCrontab, type Crontab, encryptOpaqueHtlc, genesisReplica, hashHtlcSecret, htlcEnvelopeHash, isLeft, replicaId, tokenId, wireTx,
  type AccountFrame, type AccountReplica, type AccountTx, type Draft, type Effect, type EntityId, type LendingBook, type PaybookEntry, type PreparedHtlcEntry, type SwapOffer,
} from "../xln.ts";
import { ALICE, BOB, CAROL, TERMS, aliceAddr, unwrap } from "../xln_run.ts";
import { applySuccessfulAccountInput } from "../../core/entity/tx/handlers/account/committed-input.ts";
import { createBookIntentProgram, applyBookIntentProgram } from "../../core/entity/books/book-intents.ts";
import { PersistentAccountStateMap } from "../../core/account/state/persistent-state-map.ts";
import { admitLocalAccountTx } from "../../core/account/input/local-tx-admission.ts";
import { EntityAccountCandidateMap, PersistentEntityAccountMap } from "../../core/entity/state/persistent-account-map.ts";
import { ogOf } from "./og-state.ts";

let seed = seedOf(5150);
const rng = (): number => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const ri = (n: number): number => Math.floor(rng() * n);
const pick = <T,>(xs: readonly T[]): T => xs[ri(xs.length)] as T;
const hex = (n: number): string => "0x" + Array.from({ length: n }, () => ri(256).toString(16).padStart(2, "0")).join("");
const bytes = (n: number): Uint8Array => Uint8Array.from({ length: n }, () => ri(256));
const hex16 = (n: number): string => n.toString(16).padStart(16, "0");
const tk = (n: number) => unwrap(tokenId(String(n)));
const JUR = TERMS.domain;
const keyPair = () => { const priv = x25519.utils.randomPrivateKey(); priv.set(bytes(32)); return { priv: "0x" + Buffer.from(priv).toString("hex"), pub: "0x" + Buffer.from(x25519.getPublicKey(priv)).toString("hex") }; };
const RECIPIENT = keyPair();
const sortedJson = (v: unknown): string => JSON.stringify(v, function (_k, x) {
  if (typeof x === "bigint") return `${x}n`;
  if (x instanceof Map) return [...x].sort(([a], [b]) => (String(a) < String(b) ? -1 : 1));
  if (x !== null && typeof x === "object" && !Array.isArray(x)) return Object.fromEntries(Object.keys(x).filter((k) => x[k] !== undefined).sort().map((k) => [k, x[k]]));
  return x;
});
const PA = (name: string, entries: readonly (readonly [unknown, unknown])[]) => (entries.length === 0 ? PersistentAccountStateMap.empty(name as never) : PersistentAccountStateMap.fromEntries(name as never, entries as never));
/** A rewrite Account tx as og's `{ type, data }` (HTLC txs by hand, the rest through the rewrite's wire codec). */
const ogTx = (tx: any, self: EntityId, peer: EntityId): any => {
  if (tx.type === "htlc_resolve") return { type: "htlc_resolve", data: tx.outcome === "secret" ? { lockId: tx.lockId, outcome: "secret", secret: tx.secret } : { lockId: tx.lockId, outcome: "error", ...(tx.reason === undefined ? {} : { reason: tx.reason }) } };
  if (tx.type === "htlc_lock") return { type: "htlc_lock", data: { lockId: tx.lockId, hashlock: tx.hashlock, timelock: tx.timelock, revealBeforeHeight: Number(tx.revealBeforeHeight), amount: tx.amount, tokenId: Number(tx.tokenId), ...(tx.envelope === undefined ? {} : { envelope: tx.envelope }) } };
  if (tx.type === "swap_offer") return { type: "swap_offer", data: { offerId: tx.offerId, ...(tx.crossJurisdiction === undefined ? {} : { crossJurisdiction: tx.crossJurisdiction }) } };
  if (tx.type === "swap_resolve" || tx.type === "swap_cancel_request") return { type: tx.type, data: { offerId: tx.offerId } };
  const id = unwrap(accountId(self, peer));
  return unwrap(wireTx(tx, id, isLeft(self, id)) as never);
};

type Row = { readonly left: bigint; readonly right: bigint; readonly requested: bigint };
const rwAccount = (self: EntityId, peer: EntityId, row: Row, offers: ReadonlyMap<string, SwapOffer>): AccountReplica => {
  const base = unwrap(genesisReplica(unwrap(accountId(self, peer)), TERMS));
  const deltas = new Map([[tk(1), { tokenId: tk(1), collateral: 0n, ondelta: 0n, offdelta: 0n, leftCreditLimit: row.left, rightCreditLimit: row.right }]]);
  return { ...base, state: { ...base.state, account: { ...base.state.account, deltas }, offers, ...(row.requested > 0n ? { requested: new Map([[tk(1), row.requested]]) } : {}) } } as AccountReplica;
};
/** og's frame-candidate Account map (Account shells over an empty committed map), so the work index and candidate writes behave as in a frame. */
const ogAccounts = (self: EntityId, rows: readonly (readonly [EntityId, any])[]): any => {
  const accounts = new EntityAccountCandidateMap(PersistentEntityAccountMap.fromEntries([], self, () => ("0x" + "00".repeat(32)) as never));
  for (const [peer, account] of rows) accounts.set(peer, account);
  return accounts;
};
const ogOffer = (o: SwapOffer): any => ({ ...o, giveTokenId: Number(o.giveTokenId), wantTokenId: Number(o.wantTokenId) });
const ogAccount = (self: EntityId, peer: EntityId, row: Row, offers: ReadonlyMap<string, SwapOffer>): any => {
  const left = self < peer ? self : peer, right = self < peer ? peer : self;
  return {
    state: { leftEntity: left, rightEntity: right, domain: { chainId: JUR.chainId, depositoryAddress: JUR.depositoryAddress }, deltas: PA("deltas", [[1, { tokenId: 1, collateral: 0n, ondelta: 0n, offdelta: 0n, leftCreditLimit: row.left, rightCreditLimit: row.right, leftAllowance: 0n, rightAllowance: 0n, leftHold: 0n, rightHold: 0n }]]),
      swapOffers: new Map([...offers].map(([k, o]) => [k, ogOffer(o)])), requestedRebalance: new Map(row.requested > 0n ? [[1, row.requested]] : []) },
    status: "active", mempool: [], proofHeader: { fromEntity: self, toEntity: peer, nextProofNonce: 1 },
  };
};

describe(seedTag("followup-order: committed-frame followups of one accountInput (og committed-input.ts applySuccessfulAccountInput)"), () => {
  test("MATCH: 600 random inputs committing our frame and the peer's (lending, HTLC resolve / lock, same-j and cross-j swaps, direct forwards) -- og's accept / refuse, returned Account txs in mempool order, worklist order, runtime and swap events, lending book, paybook", async () => {
    const seen = new Map<string, number>(), bump = (k: string) => seen.set(k, (seen.get(k) ?? 0) + 1);
    for (let i = 0; i < 600; i++) {
      const self = BOB, peer = pick([ALICE, CAROL]), other = (peer === ALICE ? CAROL : ALICE) as EntityId, ts = 5_000_000 + ri(1000), isHub = rng() < 0.85;
      const hasOwn = rng() < 0.75, hasReceived = !hasOwn || rng() < 0.75;
      // ---- lending: open pools lent by the peer, an opening and an active loan borrowed by the peer ----
      const pools = new Map<string, any>(), loans = new Map<string, any>();
      for (const p of [1, 2]) if (rng() < 0.7) pools.set(`lend-${hex16(p)}`, { positionId: `lend-${hex16(p)}`, hubEntityId: self, lenderEntityId: peer, tokenId: 1, principalAmount: 500n, availableAmount: pick([60n, 300n, 500n]), borrowedAmount: 0n,
        interestBps: pick([0, 100]), termId: "1h", termMs: 3_600_000, createdAt: 1, updatedAt: 1, status: "open" });
      for (const [n, status] of [[1, "opening"], [2, "active"]] as const) if (rng() < 0.5) loans.set(`loan-${hex16(n)}`, { requestId: `borrow-${hex16(n)}`, loanId: `loan-${hex16(n)}`, hubEntityId: self, borrowerEntityId: peer, lenderEntityId: peer,
        positionId: `lend-${hex16(1)}`, tokenId: 1, principalAmount: 40n, interestAmount: 1n, repaymentAmount: 41n, repaidAmount: 0n, interestBps: 100, termId: "1h", termMs: 3_600_000, openedAt: 1, dueAt: 3_600_001, updatedAt: 1, status });
      // og opens a lending book only on a hub
      const book: LendingBook | undefined = isHub && pools.size + loans.size > 0 ? ({ pools, loans } as LendingBook) : undefined;
      const lendingTx = (proposer: EntityId): AccountTx => {
        if (proposer === self) {
          const loan = pick([...loans.values(), undefined]);
          return { type: "lending_credit", action: loan?.status === "active" ? "revoke" : "grant", loanId: loan?.loanId ?? `loan-${hex16(9)}`, hubEntityId: self, borrowerEntityId: peer, tokenId: tk(1), creditLimit: pick([40n, 100n]) } as AccountTx;
        }
        switch (ri(3)) {
          case 0: return { type: "lending_fund", positionId: `lend-${hex16(10 + ri(1000))}`, hubEntityId: self, lenderEntityId: peer, tokenId: tk(1), amount: pick([100n, 400n]), termId: "1h", interestBps: pick([0, 50]) } as AccountTx;
          case 1: return { type: "lending_borrow_request", requestId: `borrow-${hex16(10 + ri(1000))}`, hubEntityId: self, borrowerEntityId: peer, tokenId: tk(1), amount: pick([10n, 50n, 60n]), termId: "1h", maxInterestBps: 10_000 } as AccountTx;
          default: return { type: "lending_repay", loanId: `loan-${hex16(2)}`, hubEntityId: self, borrowerEntityId: peer, tokenId: tk(1), amount: 41n } as AccountTx;
        }
      };
      // ---- HTLC: a random paybook, committed resolves in either frame, receiver locks (with prepared outcomes) in the peer's frame ----
      const secrets = Array.from({ length: 4 }, () => hex(32)), locks = secrets.map((s) => hashHtlcSecret(s) as string);
      const entries0 = new Map<string, PaybookEntry>();
      for (let j = 0; j < 4; j++) {
        if (rng() < 0.4) continue;
        entries0.set(locks[j] as string, { hashlock: locks[j] as string, tokenId: 1, amount: BigInt(1 + ri(1000)), createdTimestamp: 5, ...(rng() < 0.4 ? { originated: true as const } : {}), ...(rng() < 0.7 ? { inboundEntity: pick([peer, other]) } : {}),
          ...(rng() < 0.6 ? { outboundEntity: pick([peer, other]) } : {}), ...(rng() < 0.4 ? { pendingFee: BigInt(ri(5)) } : {}), ...(rng() < 0.3 ? { description: "d" } : {}) });
      }
      const prepared: PreparedHtlcEntry[] = [];
      const htlcTx = (viaNewFrame: boolean, stateHash: string, height: number): AccountTx => {
        const j = ri(4);
        if (!viaNewFrame || rng() < 0.5) return (rng() < 0.55 ? { type: "htlc_resolve", lockId: locks[j], outcome: "secret", secret: secrets[j] } : { type: "htlc_resolve", lockId: locks[j], outcome: "error", reason: pick(["timeout", "downstream_error"]) }) as AccountTx;
        const amount = BigInt(10 + ri(500)), envelope = unwrap(encryptOpaqueHtlc(bytes(40), RECIPIENT.pub, hex(32), keyPair().priv));
        const lock = { type: "htlc_lock", lockId: locks[j], hashlock: locks[j], timelock: 10n ** 12n + BigInt(ri(1e6)), revealBeforeHeight: BigInt(100 + ri(50)), amount, tokenId: tk(1), envelope };
        const outcome = pick(["forward", "final", "reject"]) === "forward" ? { kind: "forward", nextHopEntityId: pick([peer, other]), forwardAmount: amount - BigInt(ri(5)), innerEnvelope: envelope }
          : rng() < 0.5 ? { kind: "final", secret: secrets[j] } : { kind: "reject", reason: "next_hop_offline" };
        prepared.push({ binding: { fromEntityId: peer, toEntityId: self, domain: { chainId: JUR.chainId, depositoryAddress: JUR.depositoryAddress.toLowerCase() }, accountFrameHash: stateHash, accountHeight: height, envelopeHash: htlcEnvelopeHash(envelope) as string,
          hashlock: locks[j] as string, tokenId: 1, amount, timelock: lock.timelock, revealBeforeHeight: Number(lock.revealBeforeHeight) }, outcome } as PreparedHtlcEntry);
        return lock as unknown as AccountTx;
      };
      // ---- swaps: offers on the peer's Account (same-j or cross-j), committed offer / resolve / cancel request ----
      const offerIds = ["o-1", "o-2", "o-3", "o-4"], crossOf = new Map(offerIds.map((o) => [o, rng() < 0.4]));
      const offerOf = (id: string, give = 100n): SwapOffer => ({ offerId: id, giveTokenId: tk(1), giveTokenDecimals: 18, giveAmount: give, wantTokenId: tk(2), wantTokenDecimals: 6, wantAmount: give * 2n, maxFee: 1n, minNetReceive: 0n, priceTicks: 7n,
        ...(rng() < 0.3 ? { timeInForce: 1 } : {}), makerIsLeft: rng() < 0.5, createdHeight: 3, quantizedGive: give, quantizedWant: give * 2n, ...(crossOf.get(id) ? { crossJurisdiction: { orderId: `x-${id}` } as never } : {}) });
      const offers = new Map(offerIds.map((o) => [o, offerOf(o)]));
      const effects: Effect[] = [], ogOutputs: any[] = [];
      const [left, right] = self < peer ? [self, peer] : [peer, self];
      const swapTx = (): AccountTx => {
        const id = pick(offerIds), cross = crossOf.get(id) === true, kind = cross ? pick(["offer", "cancel"]) : pick(["offer", "resolve", "cancel"]);
        if (kind === "cancel") {
          effects.push({ _tag: "swap_cancel_requested", offerId: id });
          if (!cross) ogOutputs.push({ kind: "swapCancelRequest", offerId: id });
          return { type: "swap_cancel_request", offerId: id } as AccountTx;
        }
        if (kind === "resolve" && rng() < 0.4) {
          effects.push({ _tag: "swap_cancelled", offerId: id, makerId: left });
          ogOutputs.push({ kind: "swapOfferRemove", offerId: id });
          return { type: "swap_resolve", offerId: id } as AccountTx;
        }
        if (!cross) {
          const o = offerOf(id, BigInt(1 + ri(99)));
          effects.push({ _tag: "swap_offer_upsert", offer: o, left, right } as Effect);
          const { crossJurisdiction: _c, ...snap } = ogOffer(o);
          ogOutputs.push({ kind: "swapOfferUpsert", offer: { ...snap, leftEntity: left, rightEntity: right, accountOutputVerified: true } });
        }
        return (kind === "resolve" ? { type: "swap_resolve", offerId: id } : { type: "swap_offer", offerId: id, ...(cross ? { crossJurisdiction: offers.get(id)?.crossJurisdiction } : {}) }) as AccountTx;
      };
      const frameOf = (viaNewFrame: boolean, height: number, genesis = false): AccountFrame => {
        const stateHash = hex(32), proposer = viaNewFrame ? peer : self, txs: AccountTx[] = genesis ? pick([[1], [2], [2, 1], [1, 2, 1]]).map((t) => ({ type: "add_delta", tokenId: tk(t) }) as AccountTx) : [];
        for (let n = 1 + ri(5); n > 0; n--) {
          const k = ri(3);
          txs.push(k === 0 && isHub ? lendingTx(proposer) : k === 1 ? htlcTx(viaNewFrame, stateHash, height) : swapTx());
        }
        return { height: BigInt(height), timestamp: BigInt(ts - 5 + height), jHeight: 0n, stateHash, txs } as unknown as AccountFrame;
      };
      const createdAcc = hasReceived && !hasOwn && rng() < 0.3, own = hasOwn ? frameOf(false, 3) : undefined, received = hasReceived ? frameOf(true, createdAcc ? 1 : 4, createdAcc) : undefined;
      // og setHubConfig marks the hub and commits its config together
      const hubCfg = isHub ? { policyVersion: 1 + ri(3), rebalanceLiquidityFeeBps: BigInt(ri(50)) } : undefined, lastRun = pick([0, ts - 1, ts, ts + 1]);
      const forwards = Array.from({ length: rng() < 0.5 ? 0 : 1 + ri(2) }, () => ({ tokenId: 1, amount: BigInt(1 + ri(100)), route: [self, pick([peer, other]), ...(rng() < 0.5 ? [hex(32)] : [])], ...(rng() < 0.5 ? { description: "fwd" } : {}), trustedGatewayEntityId: self }));
      for (const f of forwards) {
        effects.push({ _tag: "direct_payment_forward", ...f } as Effect);
        ogOutputs.push({ kind: "directPaymentForward", ...f, deliveryMode: "trusted" });
      }
      const rows = new Map<EntityId, Row>([[peer, { left: pick([0n, 100n]), right: pick([0n, 100n]), requested: pick([0n, 0n, 5n]) }], [other, { left: 0n, right: 0n, requested: 0n }]]);
      // ---- the rewrite ----
      const replicas = new Map<EntityId, AccountReplica>([[peer, rwAccount(self, peer, rows.get(peer) as Row, offers)], [other, rwAccount(self, other, rows.get(other) as Row, new Map())]]);
      const created = unwrap(createEntity({ id: self, jurisdiction: JUR, threshold: 1n, members: new Map([[aliceAddr, { shares: 1n }]]), committed: { ...(isHub ? { profile: { isHub: true } } : {}), ...(hubCfg === undefined ? {} : { hubRebalanceConfig: hubCfg as never }), ...(book === undefined ? {} : { lending: structuredClone(book) as never }) } } as never)).state;
      const jName = pick([undefined, "", "  ", " Arrakis "]), active = pick([undefined, "", "local", " eth-main "]);
      const crontab0 = { tasks: new Map([["hubRebalance", { method: "hubRebalance", intervalMs: 1000, lastRun, enabled: true, params: {} }]]), hooks: new Map() } as Crontab;
      const state0 = { ...withCrontab(created, crontab0), ...(jName === undefined ? {} : { jurisdictionConfig: { ...(created.jurisdictionConfig ?? {}), name: jName } }), accounts: new Map([...replicas].map(([p, c]) => [p, c.state.account])), paybook: { entries: new Map([...entries0].map(([h, e]) => [h, { ...e }])), feesEarned: 0n } };
      const d0 = { state: state0, accountReplicas: replicas, outputs: [] } as unknown as Draft;
      const rw = committedFollowups(d0, peer, own, received === undefined ? undefined : { frame: received, from: peer, to: self, domain: JUR }, effects, { verify: (() => true) as never, timestamp: BigInt(ts), htlc: { ...EMPTY_HTLC_INFRA, entries: prepared }, ...(active === undefined ? {} : { activeJurisdiction: active }) }, createdAcc);
      // ---- og: applySuccessfulAccountInput on the same committed frames and Account outputs ----
      const ogFrame = (f: AccountFrame) => ({ height: Number(f.height), timestamp: Number(f.timestamp), stateHash: f.stateHash, accountTxs: f.txs.map((t) => ogTx(t, self, peer)) });
      const selfIsLeft = self < peer, committedFrames = [...(own ? [{ frame: ogFrame(own), proposerIsLeft: selfIsLeft, committedViaNewFrame: false }] : []), ...(received ? [{ frame: ogFrame(received), proposerIsLeft: !selfIsLeft, committedViaNewFrame: true }] : [])];
      const program = createBookIntentProgram(), slot = program.openSlot();
      const ogState: any = { entityId: self, timestamp: ts, config: jName === undefined ? {} : { jurisdiction: { name: jName } }, messages: [], crontabState: { tasks: new Map(crontab0.tasks), hooks: new Map() }, ...(hubCfg === undefined ? {} : { hubRebalanceConfig: hubCfg }), ...(isHub ? { profile: { isHub: true } } : {}), ...(book === undefined ? {} : { lending: structuredClone(book) }),
        paybook: { entries: new Map([...entries0].map(([h, e]) => [h, { ...e }])), feesEarned: 0n }, accounts: ogAccounts(self, [[peer, ogAccount(self, peer, rows.get(peer) as Row, offers)], [other, ogAccount(self, other, rows.get(other) as Row, new Map())]]) };
      const effectsOg: any = { outputs: [], accountTxs: [], swapOffersCreated: [], swapCancelRequests: [], swapOffersCancelled: [], candidateEffects: [], hashesToSign: [] };
      const input = { kind: "ack_frame", fromEntityId: peer, toEntityId: self, domain: JUR, ...(own ? { ack: { height: 3 } } : {}), ...(received ? { proposal: { frame: ogFrame(received) } } : {}) };
      const byBinding = new Map(prepared.map((e) => [`${e.binding.accountFrameHash}:${e.binding.hashlock}`, e]));
      const timedOutHashlocks = [own, received].flatMap((f) => (f?.txs ?? []).flatMap((t: any) => (t.type === "htlc_resolve" && t.outcome === "error" ? [t.lockId] : [])));
      const revealedSecrets = (received?.txs ?? []).flatMap((t: any) => (t.type === "htlc_resolve" && t.outcome === "secret" ? [{ secret: t.secret, hashlock: t.lockId }] : []));
      let refused: string | undefined;
      try {
        await applySuccessfulAccountInput({
          env: { info: () => {}, ...(active === undefined ? {} : { activeJurisdiction: active }) } as never, state: ogState, input: input as never, account: ogState.accounts.get(peer), counterpartyId: peer, createdAccount: createdAcc,
          result: { events: [], committedFrames, candidateEffects: ogOutputs, timedOutHashlocks, revealedSecrets } as never, effects: effectsOg,
          options: { bookIntentSlot: slot, infraContext: {}, preparedHtlcEntriesByBinding: byBinding, storageChanges: [] } as never, checkpointProfile: () => {},
        });
        applyBookIntentProgram(ogState, program);
      } catch (e) { refused = (e as Error).message; }
      expect(`${i}:${rw.ok ? "ok" : "refused"}`).toBe(`${i}:${refused === undefined ? "ok" : "refused"}`);
      bump(refused === undefined ? "accepted" : refused.split(/[:\s]/)[0] ?? "");
      if (!rw.ok) continue;
      // og applyEntityTxReturnedEffects -> applyLocalAccountEffects: each returned tx is admitted alone, in order; an admitting Account is marked proposable
      const d = rw.value, ogTargets: any[] = effectsOg.accountTxs, marked: string[] = [peer];
      for (const t of ogTargets) {
        const account = ogState.accounts.get(t.accountId.toLowerCase());
        if (account !== undefined && admitLocalAccountTx(account, t.tx, {} as never)) marked.push(t.accountId.toLowerCase());
      }
      // returned Account txs: each Account's mempool, in og's order
      for (const p of [peer, other]) expect(sortedJson((d.accountReplicas.get(p)?.mempool ?? []).map((t) => ogTx(t, self, p)))).toBe(sortedJson(ogState.accounts.get(p).mempool));
      // the worklist: the input's Account, then each Account a returned tx was admitted to, in admission order
      expect([...new Set<string>(d.touched ?? [])]).toEqual([...new Set(marked)]);
      expect(sortedJson((d.runtimeEvents ?? []).map((e) => ({ eventName: e.eventName, data: e.data })))).toBe(sortedJson(effectsOg.candidateEffects.filter((e: any) => e.kind === "runtimeEvent").map((e: any) => ({ eventName: e.eventName, data: e.data }))));
      // swap events in og's order, including og's same-j `accountOutputVerified` marker (followup-order #11)
      expect(sortedJson({ created: d.swaps?.created ?? [], cancelled: d.swaps?.cancelled ?? [], cancelRequests: d.swaps?.cancelRequests ?? [] }))
        .toBe(sortedJson({ created: effectsOg.swapOffersCreated, cancelled: effectsOg.swapOffersCancelled, cancelRequests: effectsOg.swapCancelRequests }));
      expect(sortedJson(ogOf(d.state)["lending"])).toBe(sortedJson(ogState.lending));
      expect(sortedJson(d.state.paybook)).toBe(sortedJson(ogState.paybook));
      // og scheduleCommittedAccountWork: the hub-rebalance-kick hook
      expect(sortedJson(unwrap(crontabOf(d.state)).hooks)).toBe(sortedJson(ogState.crontabState.hooks));
      if (ogState.crontabState.hooks.size > 0) bump("kick");
      if (createdAcc) bump(`created:${ogTargets.some((t) => t.tx.type === "rebalance_policy")}`);
      if (own && received && ogTargets.length > 0) bump("both-frames-with-targets");
      if (new Set(ogTargets.map((t) => t.tx.type)).size > 1) bump("mixed-targets");
      if (effectsOg.swapOffersCreated.some((e: any) => e.crossJurisdiction) && effectsOg.swapOffersCreated.some((e: any) => !e.crossJurisdiction)) bump("mixed-created");
      for (const t of ogTargets) bump(t.tx.type);
      for (const e of effectsOg.candidateEffects) if (e.kind === "runtimeEvent" && e.data.jurisdictionId !== undefined) bump(`jid:${e.data.jurisdictionId}`);
    }
    for (const k of ["accepted", "both-frames-with-targets", "mixed-targets", "mixed-created", "lending_credit", "htlc_resolve", "htlc_lock", "direct_payment"]) expect([k, (seen.get(k) ?? 0) > 3]).toEqual([k, true]);
    for (const k of ["jid:Arrakis", "jid:local", "jid:eth-main"]) expect([k, (seen.get(k) ?? 0) > 0]).toEqual([k, true]);
  }, 120_000);
});
