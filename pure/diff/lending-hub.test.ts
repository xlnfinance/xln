// Behavioural diff: og hub-side lending (core/entity/tx/handlers/account/committed-lending-followup.ts, committed-lending-close.ts,
// extensions/lending.ts) and the Htlc* runtime events' jurisdictionId (committed-frame-followups.ts, committed-htlc-followups.ts) vs pure/xln.ts.
// "MATCH:" tests run og live on the same inputs and assert the same accept / refuse, lending book, returned Account txs and events.
import { describe, expect, test } from "bun:test";
import { seedOf, seedTag } from "./seed.ts";
import {
  accountId, applyRuntime, convertOutput, wireTx, createEntity, createRuntime, genesisReplica, lendingFollowups, lendingInterest, lendingLoanId, localScheduledWake, replicaKey, resolveFollowup, secretFollowup, spawn, tokenId,
  type AccountReplica, type AccountTx, type EntityId, type EntityOutput, type EntityState, type EntityTx, type LendingBook, type LendingFrame, type LendingLoan, type LendingPool, type Runtime, type RoutedEntityInput,
} from "../xln.ts";
import { ALICE, BOB, CAROL, NOW, TERMS, UNREGISTERED_J, aliceAddr, bobAddr, carolAddr, unwrap, verifiers } from "../xln_run.ts";
import { applyCommittedLendingFollowup } from "../../core/entity/tx/handlers/account/committed-lending-followup.ts";
import { buildLendingLoanId, computeLendingInterest, LENDING_TERM_MS } from "../../core/extensions/lending.ts";
import { applyCommittedAccountFrameFollowups } from "../../core/entity/tx/handlers/account/committed-frame-followups.ts";
import { applyHtlcSecretFollowups } from "../../core/entity/tx/handlers/account/committed-htlc-followups.ts";
import { createBookIntentProgram, applyBookIntentProgram } from "../../core/entity/books/book-intents.ts";
import { hashHtlcSecret } from "../../core/protocol/htlc/utils.ts";
import { PersistentAccountStateMap } from "../../core/account/state/persistent-state-map.ts";

let seed = seedOf(71);
/** mulberry32: a full-period 32-bit generator (the float LCG loses its low bits past 2^53 and cycles early). */
const rng = (): number => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const ri = (n: number): number => Math.floor(rng() * n);
const pick = <T>(xs: readonly T[]): T => xs[ri(xs.length)] as T;
const PA = (name: string, entries: readonly (readonly [unknown, unknown])[] = []) => (entries.length === 0 ? PersistentAccountStateMap.empty(name as never) : PersistentAccountStateMap.fromEntries(name as never, entries as never));
const tk = (n: number) => unwrap(tokenId(String(n)));
const hex16 = (n: number): string => n.toString(16).padStart(16, "0");
const JUR = TERMS.domain;

/** The rewrite's flat Account tx as og's `{ type, data }` with a numeric tokenId. */
const ogTx = (tx: AccountTx): any => unwrap(wireTx(tx, unwrap(accountId(ALICE, BOB)), true));
const cloneBook = (b: LendingBook | undefined): any => (b === undefined ? undefined : { pools: new Map([...b.pools].map(([k, v]) => [k, { ...v }])), loans: new Map([...b.loans].map(([k, v]) => [k, { ...v }])) });

// ---- the lending followup over random committed frames, og applyCommittedLendingFollowup live ----
type Row = { readonly t: number; readonly collateral: bigint; readonly ondelta: bigint; readonly offdelta: bigint; readonly left: bigint; readonly right: bigint; readonly hubHold: bigint };
const rwReplica = (hub: EntityId, peer: EntityId, rows: readonly Row[], mempool: readonly AccountTx[]): AccountReplica => {
  const base = unwrap(genesisReplica(unwrap(accountId(hub, peer)), TERMS)), hubIsLeft = hub < peer;
  const locks = new Map(rows.filter((r) => r.hubHold > 0n).map((r) => [`lock-${r.t}`, { lockId: `lock-${r.t}`, hashlock: `0x${"ab".repeat(32)}`, timelock: 10n ** 13n, revealBeforeHeight: 100n, amount: r.hubHold, tokenId: tk(r.t), senderIsLeft: hubIsLeft, createdHeight: 1n, createdTimestamp: 1n }]));
  const deltas = new Map(rows.map((r) => [tk(r.t), { tokenId: tk(r.t), collateral: r.collateral, ondelta: r.ondelta, offdelta: r.offdelta, leftCreditLimit: r.left, rightCreditLimit: r.right }]));
  return { ...base, state: { ...base.state, account: { ...base.state.account, deltas }, locks }, mempool } as AccountReplica;
};
const ogReplica = (hub: EntityId, peer: EntityId, rows: readonly Row[], mempool: readonly AccountTx[]): any => {
  const left = hub < peer ? hub : peer, right = hub < peer ? peer : hub, hubIsLeft = hub < peer;
  return {
    state: { leftEntity: left, rightEntity: right, deltas: PA("deltas", rows.map((r) => [r.t, { tokenId: r.t, collateral: r.collateral, ondelta: r.ondelta, offdelta: r.offdelta, leftCreditLimit: r.left, rightCreditLimit: r.right,
      leftAllowance: 0n, rightAllowance: 0n, leftHold: hubIsLeft ? r.hubHold : 0n, rightHold: hubIsLeft ? 0n : r.hubHold }])) },
    status: "active", mempool: mempool.map(ogTx), proofHeader: { fromEntity: hub, toEntity: peer, nextProofNonce: 1 },
  };
};

describe(seedTag("lending-hub: committed lending followup (og committed-lending-followup.ts, committed-lending-close.ts)"), () => {
  test("MATCH: 3000 random hub lending books and committed frames -- og's accept / refuse message, lending book and returned lending_credit / lending_close_payout", () => {
    const seen = new Map<string, number>(), bump = (k: string) => seen.set(k, (seen.get(k) ?? 0) + 1);
    for (let i = 0; i < 3000; i++) {
      const hub = pick([ALICE, BOB, CAROL]), peer = pick([ALICE, BOB, CAROL].filter((p) => p !== hub)) as EntityId, isHub = rng() < 0.92, ts = 5_000_000 + ri(1000);
      const lim = (): bigint => pick([0n, 50n, 100n, 1_000n]);
      const rows: Row[] = [1, 3].filter(() => rng() < 0.9).map((t) => ({ t, collateral: pick([0n, 100n, 1_000n]), ondelta: pick([0n, 300n, -300n]), offdelta: pick([0n, 40n, -40n, 900n]), left: lim(), right: lim(), hubHold: rng() < 0.15 ? pick([10n, 500n]) : 0n }));
      const mempool: AccountTx[] = rng() < 0.3 ? [rng() < 0.5 ? { type: "set_credit_limit", tokenId: tk(pick([1, 3])), limit: lim() } : { type: "lending_credit", action: "grant", loanId: `loan-${hex16(999)}`, hubEntityId: hub, borrowerEntityId: peer, tokenId: tk(pick([1, 3])), creditLimit: lim() }] : [];
      const positions = [`lend-${hex16(1)}`, `lend-${hex16(2)}`, `lend-${hex16(3)}`], requests = [`borrow-${hex16(4)}`, `borrow-${hex16(5)}`];
      const pools = new Map<string, LendingPool>(), loans = new Map<string, LendingLoan>();
      if (rng() < 0.8) {
        for (const p of positions.filter(() => rng() < 0.5)) pools.set(p, { positionId: p, hubEntityId: hub, lenderEntityId: pick([peer, peer, hub]), tokenId: pick([1, 1, 3]), principalAmount: 500n, availableAmount: pick([0n, 60n, 300n, 500n, 500n]), borrowedAmount: pick([0n, 0n, 40n, 200n]),
          interestBps: pick([0, 3, 100, 500]), termId: pick(["1h", "1h", "1d"]), termMs: 3_600_000, createdAt: pick([1, 2]), updatedAt: 1, status: pick(["open", "open", "open", "open", "open", "closing", "closed"] as const) });
        for (let l = 0, n = 1 + ri(3); l < n; l++) {
          const loanId = `loan-${hex16(100 + l)}`, principal = pick([10n, 40n, 60n]);
          loans.set(loanId, { requestId: pick(requests), loanId, hubEntityId: hub, borrowerEntityId: pick([peer, peer, hub]), lenderEntityId: peer, positionId: pick([...positions, "lend-missing"]), tokenId: pick([1, 3]), principalAmount: principal,
            interestAmount: 1n, repaymentAmount: principal + 1n, repaidAmount: pick([0n, 0n, 5n]), interestBps: 100, termId: "1h", termMs: 3_600_000, openedAt: 1, dueAt: 3_600_001, updatedAt: 1, status: pick(["opening", "active", "active", "active", "closing", "repaid", "defaulted"] as const) });
        }
      }
      const book: LendingBook | undefined = pools.size + loans.size > 0 || rng() < 0.5 ? { pools, loans } : undefined;
      const loanIds = [...loans.keys(), `loan-${hex16(777)}`];
      const randomTx = (proposer: EntityId): AccountTx => {
        const other = proposer === hub ? peer : hub, hubRef = pick([hub, hub, hub, hub.toUpperCase().replace("0X", "0x"), other]);
        const t = tk(pick([1, 1, 3])), amount = pick([10n, 10n, 40n, 41n, 60n, 61n, 200n, 500n]);
        switch (rng() < 0.2 ? ri(6) : proposer === hub ? pick([3, 5]) : pick([0, 1, 2, 4])) {
          case 0: return { type: "lending_fund", positionId: pick([...positions, `lend-${hex16(9)}`]), hubEntityId: hubRef, lenderEntityId: pick([proposer, proposer, other]), tokenId: t, amount, termId: pick(["1h", "1d", "1m"]), interestBps: pick([0, 3, 100, 800]) };
          case 1: {
            // half the time aim at an open pool, so borrows open loans and grant credit
            const open = [...pools.values()].filter((p) => p.status === "open");
            if (open.length > 0 && rng() < 0.5) {
              const p = pick(open);
              return { type: "lending_borrow_request", requestId: pick([...requests, `borrow-${hex16(6)}`]), hubEntityId: hub, borrowerEntityId: proposer, tokenId: tk(p.tokenId), amount: pick([p.availableAmount, 10n]), termId: p.termId, maxInterestBps: pick([100, 10_000]) };
            }
          }
          // falls through
          case 6: return { type: "lending_borrow_request", requestId: pick([...requests, `borrow-${hex16(6)}`]), hubEntityId: pick([hub, hubRef]), borrowerEntityId: pick([proposer, proposer, proposer, other]), tokenId: t, amount, termId: pick(["1h", "1h", "1d"]), maxInterestBps: pick([0, 100, 10_000, 10_000]) };
          case 2: {
            const active = [...loans.values()].filter((l) => l.status === "active" && l.borrowerEntityId === proposer);
            if (active.length > 0 && rng() < 0.6) {
              const l = pick(active);
              return { type: "lending_repay", loanId: l.loanId, hubEntityId: hub, borrowerEntityId: proposer, tokenId: tk(l.tokenId), amount: l.repaymentAmount - l.repaidAmount };
            }
          }
          // falls through
          case 7: return { type: "lending_repay", loanId: pick(loanIds), hubEntityId: hubRef, borrowerEntityId: pick([proposer, proposer, other]), tokenId: t, amount: pick([amount, 11n, 41n, 61n, 36n]) };
          case 3: {
            const closing = [...loans.values()].filter((l) => l.status === "closing" || l.status === "opening" || l.status === "defaulted");
            if (closing.length > 0 && rng() < 0.5) {
              const l = pick(closing);
              return { type: "lending_credit", action: l.status === "opening" ? "grant" : "revoke", loanId: l.loanId, hubEntityId: hub, borrowerEntityId: other, tokenId: tk(l.tokenId), creditLimit: amount };
            }
          }
          // falls through
          case 9: return { type: "lending_credit", action: pick(["grant", "revoke"] as const), loanId: pick(loanIds), hubEntityId: pick([proposer, hubRef]), borrowerEntityId: other, tokenId: t, creditLimit: amount };
          case 4: {
            const idle = [...pools.values()].filter((p) => p.status === "open" && p.lenderEntityId === proposer && p.borrowedAmount === 0n);
            if (idle.length > 0 && rng() < 0.6) return { type: "lending_close_request", positionId: pick(idle).positionId, hubEntityId: hub, lenderEntityId: proposer };
          }
          // falls through
          case 8: return { type: "lending_close_request", positionId: pick(positions), hubEntityId: hubRef, lenderEntityId: pick([proposer, proposer, other]) };
          default: return { type: "lending_close_payout", positionId: pick(positions), hubEntityId: pick([proposer, hubRef]), lenderEntityId: other, tokenId: t, amount: pick([0n, 60n, 300n, 500n]) };
        }
      };
      const frames: LendingFrame[] = Array.from({ length: 1 + ri(2) }, (_, f) => {
        const proposer = pick([hub, peer]) as EntityId;
        return { frame: { timestamp: BigInt(ts - 5 + f * pick([0, 9])), txs: [...Array.from({ length: rng() < 0.7 ? 1 : 2 + ri(2) }, () => randomTx(proposer)), ...(rng() < 0.2 ? [{ type: "set_credit_limit", tokenId: tk(1), limit: 7n } as AccountTx] : [])] }, proposer };
      });
      const withAccount = rng() < 0.95;
      const replicas = new Map(withAccount ? [[peer, rwReplica(hub, peer, rows, mempool)]] : []);
      const state0 = unwrap(createEntity({ id: hub, jurisdiction: JUR, threshold: 1n, members: new Map([[aliceAddr, { shares: 1n }]]), committed: { ...(isHub ? { profile: { isHub: true } } : {}), ...(book === undefined ? {} : { lending: cloneBook(book) }) } })).state;
      const rw = lendingFollowups(state0, replicas, peer, frames, BigInt(ts));
      const og: any = { entityId: hub, timestamp: ts, profile: isHub ? { isHub: true } : undefined, accounts: new Map(withAccount ? [[peer, ogReplica(hub, peer, rows, mempool)]] : []), ...(book === undefined ? {} : { lending: cloneBook(book) }) };
      const accountTxs: any[] = [];
      let refused: string | undefined;
      try {
        for (const { frame, proposer } of frames) {
          const ogFrame = { height: 1, timestamp: Number(frame.timestamp), accountTxs: frame.txs.map(ogTx) };
          for (const tx of ogFrame.accountTxs) applyCommittedLendingFollowup(og, peer, tx as never, ogFrame as never, proposer === (hub < peer ? hub : peer), accountTxs);
        }
      } catch (e) { refused = (e as Error).message; }
      expect(`${i}:${rw.ok ? "ok" : rw.error._tag === "entity_invariant" ? rw.error.reason : rw.error._tag}`).toBe(`${i}:${refused ?? "ok"}`);
      bump(refused === undefined ? "accepted" : refused.split(/[:\s]/)[0] ?? "");
      if (!rw.ok) continue;
      expect(rw.value.state.committed["lending"]).toEqual(og.lending);
      expect(rw.value.accountTxs.map(({ accountId: a, tx }) => ({ accountId: a, tx: ogTx(tx) }))).toEqual(accountTxs);
      for (const t of accountTxs) bump(`${t.tx.type}:${t.tx.data.action ?? ""}`);
      for (const l of og.lending?.loans.values() ?? []) if (!loans.has(l.loanId)) bump("loan-opened"); else if (l.status !== loans.get(l.loanId)?.status) bump(`loan-${l.status}`);
    }
    for (const k of ["accepted", "loan-opened", "loan-active", "loan-closing", "loan-repaid", "lending_credit:grant", "lending_credit:revoke", "lending_close_payout:", "LENDING_FUND_PROPOSER_MISMATCH", "LENDING_LIQUIDITY_UNAVAILABLE", "LENDING_REPAYMENT_MISMATCH", "LENDING_CLOSE_PAYOUT_CAPACITY", "LENDING_CREDIT_PROPOSER_MISMATCH",
      "LENDING_GRANT_STATUS_INVALID", "LENDING_REVOKE_STATUS_INVALID", "LENDING_PAYOUT_MISMATCH", "LENDING_CLOSE_ACTIVE_LOANS", "LENDING_ACCOUNT_MISSING", "LENDING_POSITION_ALREADY_EXISTS"]) expect([k, (seen.get(k) ?? 0) > 2]).toEqual([k, true]);
  }, 60_000);

  test("MATCH: og buildLendingLoanId and computeLendingInterest", () => {
    for (let i = 0; i < 200; i++) {
      const input = { hubEntityId: pick([ALICE, BOB.toUpperCase().replace("0X", "0x")]), borrowerEntityId: pick([CAROL, BOB]), tokenId: ri(5), amount: BigInt(ri(1e9)), termId: pick(["1h", "1d", "1m"]), openedAt: ri(1e13), ...(rng() < 0.8 ? { requestId: `borrow-${hex16(ri(1e9))}` } : {}) };
      expect(lendingLoanId(input)).toBe(buildLendingLoanId(input as never));
      const principal = pick([-1n, 0n, 1n, 99n, 10_001n, BigInt(ri(1e9))]), bps = pick([-1, 0, 1, 100, 10_000]);
      expect(lendingInterest(principal, bps)).toBe(computeLendingInterest(principal, bps));
    }
  });
});

// ---- end-to-end: entity lendingOffer / Borrow / Repay / ClosePosition -> Account lending txs -> hub followup -> lending_overdue default ----
describe(seedTag("lending-hub: end-to-end lending lifecycle through the Runtime"), () => {
  const T = tk(1);
  const openTo = (target: EntityId, creditAmount: bigint): EntityTx =>
    ({ type: "openAccount", data: { targetEntityId: target, accountDomain: { ...TERMS.domain }, watchSeed: TERMS.watchSeed, disputeConfig: { ...TERMS.disputeConfig }, tokenId: T, creditAmount } }) as EntityTx;
  const signers = new Map<EntityId, string>([[ALICE, aliceAddr], [BOB, bobAddr], [CAROL, carolAddr]]);
  let rt: Runtime, now: bigint = NOW;
  const replica = (e: EntityId) => { const r = rt.entities.get(replicaKey(e, signers.get(e) as string)); if (r === undefined) throw new Error("no replica"); return r; };
  const book = (): LendingBook => replica(BOB).state.committed["lending"] as unknown as LendingBook;
  const pump = (first: readonly RoutedEntityInput[], local?: ReadonlySet<EntityTx>): void => {
    let inputs = first;
    for (let round = 0; inputs.length > 0; round++) {
      if (round > 40) throw new Error("runtime did not settle");
      now += 1n;
      const out = unwrap(applyRuntime(rt, { runtimeTxs: [], entityInputs: inputs.map((i) => (i.input.kind === "txs" ? { ...i, input: { ...i.input, timestamp: now } } : i)) }, round === 0 && local !== undefined ? { ...verifiers, local } : verifiers));
      expect(out.rejected).toEqual([]);
      rt = out.runtime;
      inputs = out.outbox.map((o: EntityOutput) => unwrap(convertOutput(rt, o, ("tx" in o ? (o.tx.data as { fromEntityId: EntityId }).fromEntityId : o.to), now)));
    }
  };
  const run = (e: EntityId, ...txs: EntityTx[]): void => pump([{ entityId: e, signerId: signers.get(e) as string, input: { kind: "txs", timestamp: now, txs } }]);
  /** The credit `from` grants `to` (og peerCreditLimit of `from`), read on `viewer`'s copy of their Account. */
  const credit = (from: EntityId, to: EntityId, viewer: EntityId = from): bigint => {
    const d = replica(viewer).accountReplicas.get(viewer === from ? to : from)?.state.account.deltas.get(T);
    if (d === undefined) return -1n;
    return from < to ? d.rightCreditLimit : d.leftCreditLimit;
  };

  test("MATCH: fund -> borrow -> grant -> repay -> revoke -> close -> payout, then an unpaid loan defaults at its derived deadline -- og's loan id, interest, term and book", () => {
    rt = [ALICE, BOB, CAROL].reduce((r, e) => spawn(r, unwrap(createEntity({ id: e, jurisdiction: JUR, threshold: 1n, members: new Map([[signers.get(e) as never, { shares: 1n }]]), jurisdictionConfig: UNREGISTERED_J }))), createRuntime());
    run(BOB, { type: "setHubConfig", data: {} } as EntityTx);
    expect((replica(BOB).state.committed["profile"] as { isHub?: boolean }).isHub).toBe(true);
    run(ALICE, openTo(BOB, 10_000n));
    run(CAROL, openTo(BOB, 10_000n));
    // the hub pays each side from the credit it was given, so the lender owns funds and the borrower can pay interest
    run(BOB, { type: "directPayment", data: { targetEntityId: ALICE, tokenId: T, amount: 1_000n, route: [BOB, ALICE], deliveryMode: "direct" } } as EntityTx,
      { type: "directPayment", data: { targetEntityId: CAROL, tokenId: T, amount: 100n, route: [BOB, CAROL], deliveryMode: "direct" } } as EntityTx);
    const positionId = `lend-${hex16(0xa1)}`;
    run(ALICE, { type: "lendingOffer", data: { positionId, hubEntityId: BOB, tokenId: T, amount: 500n, termId: "1h", interestBps: 100 } } as EntityTx);
    expect(book().pools.get(positionId)).toMatchObject({ positionId, lenderEntityId: ALICE, tokenId: 1, principalAmount: 500n, availableAmount: 500n, borrowedAmount: 0n, termMs: LENDING_TERM_MS["1h"], status: "open" });
    const creditBefore = credit(BOB, CAROL), borrowAt = now, requestId = `borrow-${hex16(0xb2)}`;
    run(CAROL, { type: "lendingBorrow", data: { requestId, hubEntityId: BOB, tokenId: T, amount: 200n, termId: "1h", maxInterestBps: 500 } } as EntityTx);
    const [loan] = [...book().loans.values()];
    if (loan === undefined) throw new Error("no loan");
    // og now = max(Account frame time, the hub Entity frame time): Carol frames the borrow at +1, the hub commits it in its own frame at +2
    expect(loan.openedAt).toBe(Number(borrowAt + 2n));
    expect(loan.loanId).toBe(buildLendingLoanId({ hubEntityId: BOB, borrowerEntityId: CAROL, tokenId: 1, amount: 200n, termId: "1h", openedAt: loan.openedAt, requestId }));
    expect(loan).toMatchObject({ status: "active", principalAmount: 200n, interestAmount: computeLendingInterest(200n, 100), repaymentAmount: 202n, dueAt: loan.openedAt + LENDING_TERM_MS["1h"], positionId });
    expect(book().pools.get(positionId)).toMatchObject({ availableAmount: 300n, borrowedAmount: 200n });
    expect([credit(BOB, CAROL), credit(BOB, CAROL, CAROL)]).toEqual([creditBefore + 200n, creditBefore + 200n]);
    run(CAROL, { type: "lendingRepay", data: { hubEntityId: BOB, loanId: loan.loanId, tokenId: T, amount: 202n } } as EntityTx);
    expect(book().loans.get(loan.loanId)).toMatchObject({ status: "repaid", repaidAmount: 202n });
    expect(book().pools.get(positionId)).toMatchObject({ availableAmount: 502n, borrowedAmount: 0n, status: "open" });
    expect(credit(BOB, CAROL)).toBe(creditBefore);
    run(ALICE, { type: "lendingClosePosition", data: { hubEntityId: BOB, positionId } } as EntityTx);
    expect(book().pools.get(positionId)).toMatchObject({ availableAmount: 0n, status: "closed" });
    // a second loan runs past its term: the hub's derived deadline defaults it, releases the pool and calls the credit line in
    const second = `lend-${hex16(0xa2)}`;
    run(ALICE, { type: "lendingOffer", data: { positionId: second, hubEntityId: BOB, tokenId: T, amount: 300n, termId: "1h", interestBps: 50 } } as EntityTx);
    run(CAROL, { type: "lendingBorrow", data: { requestId: `borrow-${hex16(0xb3)}`, hubEntityId: BOB, tokenId: T, amount: 120n, termId: "1h" } } as EntityTx);
    const unpaid = [...book().loans.values()].find((l) => l.status === "active");
    if (unpaid === undefined) throw new Error("no active loan");
    now = BigInt(unpaid.dueAt);
    const wake = localScheduledWake(replica(BOB), now);
    expect(wake?.kind === "txs" ? wake.txs.map((t) => (t.type === "scheduledWake" ? t.data.jobs.map((j) => j.id) : [])) : []).toEqual([[`lending-overdue:${unpaid.loanId}`]]);
    // og runtime tick: the wake is this Runtime's own marked scheduledWake (external ingress is refused)
    pump([{ entityId: BOB, signerId: bobAddr, input: wake as never }], new Set(wake?.kind === "txs" ? wake.txs : []));
    expect(book().loans.get(unpaid.loanId)).toMatchObject({ status: "defaulted", repaidAmount: 0n });
    expect(book().pools.get(second)).toMatchObject({ availableAmount: 300n, borrowedAmount: 0n, status: "open" });
    expect([credit(BOB, CAROL), credit(BOB, CAROL, CAROL)]).toEqual([creditBefore, creditBefore]);
  }, 60_000);
});

// ---- Htlc* runtime events carry og's jurisdictionId (committed-frame-followups.ts jurisdictionIdFor, committed-htlc-followups.ts getJurisdictionId) ----
describe(seedTag("lending-hub: HtlcReceived / HtlcFinalized jurisdictionId (og protocol/htlc/events.ts)"), () => {
  test("MATCH: 400 random paybook routes resolved by a committed secret and revealed upstream -- og's events byte for byte (keys, order, jurisdictionId)", () => {
    const json = (v: unknown): string => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? `${x}n` : x));
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) {
      const self = BOB, peer = pick([ALICE, CAROL]), other = peer === ALICE ? CAROL : ALICE, ts = 9_000_000 + ri(1000);
      const secret = `0x${Array.from({ length: 64 }, () => "0123456789abcdef"[ri(16)]).join("")}`, hashlock = hashHtlcSecret(secret);
      const name = pick(["", "  ", "Arrakis", " eth-mainnet "]);
      const route: any = { hashlock, createdTimestamp: 1, ...(rng() < 0.5 ? { originated: true } : {}), ...(rng() < 0.6 ? { inboundEntity: pick([peer, other]) } : {}), ...(rng() < 0.8 ? { outboundEntity: pick([peer, other]) } : {}),
        ...(rng() < 0.8 ? { amount: BigInt(1 + ri(1e6)), tokenId: pick([1, 3]) } : {}), ...(rng() < 0.5 ? { description: pick(["", "coffee"]) } : {}), ...(rng() < 0.6 ? { startedAtMs: ts - ri(5000) } : {}) };
      const resolve = { type: "htlc_resolve", lockId: hashlock, outcome: "secret", secret } as const;
      // og: the committed resolve on the Account with `peer`, then the preimage revealed by that peer's frame
      const newState: any = { entityId: self, timestamp: ts, config: { jurisdiction: { name } }, paybook: { entries: new Map([[hashlock, { ...route }]]), feesEarned: 0n }, accounts: new Map() };
      const program = createBookIntentProgram(), slot = program.openSlot(), accountTxs: any[] = [], candidateEffects: any[] = [];
      applyCommittedAccountFrameFollowups(newState, peer, { height: 1, timestamp: ts, accountTxs: [{ type: "htlc_resolve", data: { lockId: hashlock, outcome: "secret", secret } }] } as never, true, accountTxs, {} as never, candidateEffects, slot);
      applyHtlcSecretFollowups({ env: {}, state: newState, newState, outputs: [], accountTxs, candidateEffects, bookIntentSlot: slot } as never, [{ secret, hashlock }]);
      applyBookIntentProgram(newState, program);
      const jid = name.trim(), f0 = { paybook: { entries: new Map([[hashlock, route]]), feesEarned: 0n }, queue: [] };
      const resolved = unwrap(resolveFollowup(f0, peer, resolve, self, ts, jid));
      const rw = secretFollowup(resolved, hashlock, secret, ts, self, jid);
      expect(json(rw.runtimeEvents ?? [])).toBe(json(candidateEffects.map((e) => ({ eventName: e.eventName, data: e.data }))));
      for (const e of candidateEffects) seen.add(`${e.eventName}:${"jurisdictionId" in e.data}`);
    }
    expect([...seen].sort()).toEqual(["HtlcFinalized:false", "HtlcFinalized:true", "HtlcReceived:false", "HtlcReceived:true"]);
  });
});
