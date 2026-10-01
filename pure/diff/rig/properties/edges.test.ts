// Reviewer A of #69: tests that kill the mutants of the property code the first tests left alive (mutate.py, unit-mutants.txt).
// Each test plants the one state a mutant would miss: an edge exactly on a bound, a clause on the other side or in another token,
// a second Account, a second row, a debt to a third party.
import { expect, test } from "bun:test";
import { unwrap } from "../../../xln_run.ts";
import { accountId, genesisReplica, tokenId } from "../../../xln.ts";
import type { AccountReplica, DisputeHanko, EntityId, Runtime } from "../../../xln.ts";
import { before, payoutLines, type ChainView } from "./enforce.ts";
import { checkProperties, NOTHING_SIGNED } from "./properties.ts";

const L = `0x${"1".padStart(64, "0")}` as EntityId;
const R = `0x${"2".padStart(64, "0")}` as EntityId;
const Z = `0x${"3".padStart(64, "0")}` as EntityId;
const T1 = unwrap(tokenId("1"));
const T2 = unwrap(tokenId("2"));
const TERMS = {
  domain: { chainId: 31337, depositoryAddress: `0x${"d".repeat(40)}` },
  watchSeed: `0x${"ab".repeat(32)}`,
  disputeConfig: { leftResponseSeconds: 60, rightResponseSeconds: 60 },
};
const genesis = unwrap(genesisReplica(unwrap(accountId(L, R)), TERMS));

type Row = { collateral: bigint; ondelta?: bigint; offdelta: bigint; leftCreditLimit: bigint; rightCreditLimit: bigint };
const replica = (rows: ReadonlyMap<typeof T1, Row>, body: Record<string, unknown> = {}, over: Partial<AccountReplica> = {}): AccountReplica => ({
  ...genesis,
  ...over,
  state: {
    ...genesis.state,
    ...body,
    account: {
      ...genesis.state.account,
      deltas: new Map([...rows].map(([tokenId, r]) => [tokenId, { ondelta: 0n, ...r, tokenId }])),
    },
  },
} as AccountReplica);
const runtimeOf = (...held: readonly (readonly [EntityId, EntityId, AccountReplica])[]): Runtime => ({
  entities: new Map([...new Set(held.map(([self]) => self))].map((self) =>
    [`${self}:a`, {
      state: { id: self },
      accountReplicas: new Map(held.filter(([s]) => s === self).map(([, peer, r]) => [peer, r] as const)),
    }] as const)),
}) as unknown as Runtime;
const both = (r: AccountReplica): Runtime => runtimeOf([L, R, r], [R, L, r]);
const p2 = (r: AccountReplica): readonly string[] => checkProperties(both(r), NOTHING_SIGNED).violations.filter((v) => v.startsWith("P2"));

/** Collateral 100, Left owes 30 (Δ = -30) against credit 50 from Right, Right extends nothing: Left has 20 room, Right 130. */
const base: Row = { collateral: 100n, offdelta: -30n, leftCreditLimit: 50n, rightCreditLimit: 0n };
const one = (row: Row = base, body: Record<string, unknown> = {}): AccountReplica => replica(new Map([[T1, row]]), body);
const lock = (senderIsLeft: boolean, amount: bigint, token = T1) => ({ tokenId: BigInt(token), senderIsLeft, amount });
const locks = (...ls: readonly ReturnType<typeof lock>[]) => ({ locks: new Map(ls.map((l, i) => [`k${i}`, l])) });

// ---- P2: the bounds are inclusive, and every term of RCPAN is read
test("P2 edges: exactly on each bound is clean, one past is red", () => {
  expect(p2(one({ ...base, offdelta: -50n }))).toEqual([]); // Δ = -credit
  expect(p2(one({ ...base, offdelta: -51n })).length).toBeGreaterThan(0);
  expect(p2(one({ ...base, offdelta: 100n }))).toEqual([]); // Δ = collateral
  expect(p2(one({ ...base, offdelta: 101n })).length).toBeGreaterThan(0);
});

test("P2: the credit Left extends adds to Right's room, and collateral to it too", () => {
  const row = { ...base, offdelta: 110n, rightCreditLimit: 10n };
  expect(p2(one(row))).toEqual([]); // 100 + 10 - 110 = 0
  expect(p2(one({ ...row, offdelta: 111n })).length).toBeGreaterThan(0);
  expect(p2(one({ ...row, collateral: 99n })).length).toBeGreaterThan(0); // collateral counts
});

test("P2: Δ is ondelta plus offdelta, not either alone", () => {
  expect(p2(one({ ...base, ondelta: -40n, offdelta: 0n }))).toEqual([]);
  expect(p2(one({ ...base, ondelta: -60n, offdelta: 0n })).length).toBeGreaterThan(0); // on-chain part alone breaches
  expect(p2(one({ ...base, ondelta: -40n, offdelta: -11n })).length).toBeGreaterThan(0); // only the sum breaches
});

test("P2: a lock pays out on its sender's side, in the worst case", () => {
  expect(p2(one(base, locks(lock(true, 20n))))).toEqual([]); // Left room 20, lock 20
  expect(p2(one(base, locks(lock(true, 21n)))).length).toBeGreaterThan(0); // Left's side, not Right's
  expect(p2(one(base, locks(lock(false, 130n))))).toEqual([]); // Right room 130
  expect(p2(one(base, locks(lock(false, 131n)))).length).toBeGreaterThan(0);
  expect(p2(one(base, locks(lock(true, 20n), lock(true, 1n)))).length).toBeGreaterThan(0); // clauses add up
});

test("P2: a clause is held against its own token", () => {
  const two = (body: Record<string, unknown>) => replica(new Map([[T1, base], [T2, base]]), body);
  const second = p2(two(locks(lock(true, 21n, T2))));
  expect(second).toHaveLength(2);
  expect(second.every((v) => v.includes("token 2"))).toBe(true);
  expect(p2(two(locks(lock(true, 21n, T1)))).every((v) => v.includes("token 1"))).toBe(true);
});

const offer = (makerIsLeft: boolean, giveAmount: bigint, over: Record<string, unknown> = {}) =>
  ({ makerIsLeft, giveAmount, giveTokenId: 1n, wantTokenId: 2n, ...over });
const offers = (...os: readonly ReturnType<typeof offer>[]) => ({ offers: new Map(os.map((o, i) => [`o${i}`, o])) });

test("P2: a same-J swap offer pays out its give on the maker's side, in the give token", () => {
  expect(p2(one(base, offers(offer(true, 20n))))).toEqual([]);
  expect(p2(one(base, offers(offer(true, 21n)))).length).toBeGreaterThan(0); // maker Left, not Right
  expect(p2(one(base, offers(offer(false, 130n))))).toEqual([]);
  expect(p2(one(base, offers(offer(false, 131n)))).length).toBeGreaterThan(0);
  const wanted = p2(replica(new Map([[T1, base], [T2, base]]), offers(offer(true, 21n))));
  expect(wanted.every((v) => v.includes("token 1"))).toBe(true); // the give token, not the want token
  expect(wanted.length).toBeGreaterThan(0);
});

test("P2: a cross-jurisdiction offer is not this Account's to hold", () => {
  expect(p2(one(base, offers(offer(true, 10_000n, { crossJurisdiction: { routeId: "r" } }))))).toEqual([]);
});

const pull = (amount: bigint, token = 1) => ({ tokenId: token, amount });
const pulls = (...ps: readonly ReturnType<typeof pull>[]) => ({ pulls: new Map(ps.map((p, i) => [`p${i}`, p])) });

test("P2: a pull pays out on Left's side when its amount is negative, Right's when positive", () => {
  expect(p2(one(base, pulls(pull(-20n))))).toEqual([]);
  expect(p2(one(base, pulls(pull(-21n)))).length).toBeGreaterThan(0);
  expect(p2(one(base, pulls(pull(130n))))).toEqual([]);
  expect(p2(one(base, pulls(pull(131n)))).length).toBeGreaterThan(0);
});

/** A co-signed settlement workspace over these token diffs. */
const settling = (r: AccountReplica, diffs: readonly { tokenId: number; collateralDiff: bigint; ondeltaDiff: bigint }[]): AccountReplica => ({
  ...r,
  state: {
    ...r.state,
    settlement: {
      workspaceHash: "0x", ops: [], status: "ready_to_submit", revision: 1, createdAt: 0, lastUpdatedAt: 0, lastModifiedByLeft: true, executorIsLeft: true,
      compiledDiffs: diffs.map((d) => ({ leftDiff: 0n, rightDiff: 0n, ...d })),
    },
  },
} as AccountReplica);

test("P2 after settlement: the collateral it takes out counts even when ondelta does not move", () => {
  const r = settling(one({ ...base, offdelta: 50n }), [{ tokenId: 1, collateralDiff: -60n, ondeltaDiff: 0n }]);
  expect(p2(r).some((v) => v.includes("after its signed settlement"))).toBe(true); // 40 collateral left against Δ 50
  expect(p2(settling(one({ ...base, offdelta: 50n }), [{ tokenId: 1, collateralDiff: -50n, ondeltaDiff: 0n }]))).toEqual([]);
});

test("P2 after settlement: the diff of a token is read for that token, over every token", () => {
  const two = replica(new Map([[T1, base], [T2, base]]));
  const harmless = { tokenId: 1, collateralDiff: 0n, ondeltaDiff: 0n };
  const breaching = { tokenId: 2, collateralDiff: 0n, ondeltaDiff: -60n };
  const lines = p2(settling(two, [harmless, breaching]));
  expect(lines.filter((v) => v.includes("after its signed settlement"))).toHaveLength(2);
  expect(lines.every((v) => v.includes("token 2"))).toBe(true);
  expect(p2(settling(two, [breaching, harmless])).filter((v) => v.includes("token 2"))).toHaveLength(2);
});

test("P2 after settlement: a breach that exists now is reported once, before the settlement lands, and none is borrowed from it", () => {
  const now = p2(settling(one({ ...base, offdelta: -51n }), [{ tokenId: 1, collateralDiff: 0n, ondeltaDiff: 0n }]));
  expect(now.some((v) => !v.includes("after its signed settlement"))).toBe(true);
  expect(now.some((v) => v.includes("after its signed settlement"))).toBe(true);
});

test("P2: a breach in the second token is found as well as one in the first", () => {
  const second = p2(replica(new Map([[T1, base], [T2, { ...base, offdelta: -51n }]])));
  expect(second.length).toBeGreaterThan(0);
  expect(second.every((v) => v.includes("token 2"))).toBe(true);
});

// ---- P4
const body = (c: string): string => `0x${c.repeat(64)}`;
const witness = (proofBodyHash: string, proofNonce = 4): DisputeHanko =>
  ({ hanko: "0x", hash: `0x${"0".repeat(64)}`, proofBodyHash, proofNonce, proposerIsLeft: true });
const held = (dispute: Partial<AccountReplica["dispute"]>, rows: ReadonlyMap<typeof T1, Row> = new Map([[T1, base]]), over: Partial<AccountReplica> = {}): AccountReplica =>
  replica(rows, {}, { dispute: { nextProofNonce: 9, ...dispute }, ...over } as never);
const p4 = (rt: Runtime, signed = NOTHING_SIGNED) => checkProperties(rt, signed);

test("P4: the peer signing two bodies at one nonce is red as well (its hanko, as we hold it)", () => {
  const first = p4(runtimeOf([L, R, held({ counterparty: witness(body("a")) })]));
  expect(first.violations).toEqual([]);
  const later = p4(runtimeOf([L, R, held({ counterparty: witness(body("b")) })]), first.signed);
  expect(later.violations.filter((v) => v.startsWith("P4"))).toHaveLength(1);
  expect(later.violations[0]).toContain(`signer ${R}`);
});

test("P4: our own hanko is judged as ours, not as the peer's", () => {
  const first = p4(runtimeOf([L, R, held({ current: witness(body("a")) })]));
  const swapped = p4(runtimeOf([L, R, held({ counterparty: witness(body("b")) })]), first.signed); // the peer at the same nonce: another signer
  expect(swapped.violations).toEqual([]);
});

test("P4: one signer's different bodies at different nonces are fine", () => {
  const first = p4(runtimeOf([L, R, held({ current: witness(body("a"), 4) })]));
  const next = p4(runtimeOf([L, R, held({ current: witness(body("b"), 5) })]), first.signed);
  expect(next.violations).toEqual([]);
});

test("P4: two different Accounts of one signer may sign different bodies at one nonce", () => {
  const withR = held({ current: witness(body("a")) });
  const withZ = held({ current: witness(body("b")) });
  expect(p4(runtimeOf([L, R, withR], [L, Z, withZ])).violations).toEqual([]);
});

test("P4: the same body hash in another letter case is the same body", () => {
  const first = p4(runtimeOf([L, R, held({ current: witness("0xAB".padEnd(66, "C")) })]));
  const again = p4(runtimeOf([L, R, held({ current: witness("0xab".padEnd(66, "c")) })]), first.signed);
  expect(again.violations).toEqual([]);
});

test("P4: a hanko seen on one frame is still remembered on the next", () => {
  const first = p4(runtimeOf([L, R, held({ current: witness(body("a")) })]));
  expect(first.signed.size).toBe(1);
  const silent = p4(runtimeOf([L, R, held({})]), first.signed); // a frame where the witness is not held
  expect(silent.signed.size).toBe(1);
});

const at = (height: bigint): Partial<AccountReplica> => ({ head: { ...genesis.head, height } as never });
test("P4: replicas at different heights are not compared; at one height they must agree", () => {
  const mine = replica(new Map([[T1, base]]), {}, at(5n));
  const theirs = replica(new Map([[T1, { ...base, offdelta: -29n }]]), {}, at(6n));
  expect(p4(runtimeOf([L, R, mine], [R, L, theirs])).violations).toEqual([]);
  const sameHeight = replica(new Map([[T1, { ...base, offdelta: -29n }]]), {}, at(5n));
  expect(p4(runtimeOf([L, R, mine], [R, L, sameHeight])).violations.filter((v) => v.startsWith("P4"))).toHaveLength(1);
});

test("P4: two sides at one height disagreeing only in a second token, or in a field other than the count, are red", () => {
  const rows = new Map([[T1, base], [T2, base]]);
  const other = new Map([[T1, base], [T2, { ...base, leftCreditLimit: 49n }]]);
  const v = p4(runtimeOf([L, R, replica(rows)], [R, L, replica(other)])).violations.filter((x) => x.startsWith("P4"));
  expect(v).toHaveLength(1);
});

// ---- P1
type Books = {
  collateral: Record<number, bigint>; ondelta: Record<number, bigint>;
  reserves: Record<string, bigint>; debts: Record<string, { creditor: string; amount: bigint }[]>;
};
const chainOf = (books: Books): ChainView => ({
  getCollateral: async (_l: string, _r: string, token: number) => ({ collateral: books.collateral[token] ?? 0n, ondelta: books.ondelta[token] ?? 0n }),
  getReserves: async (id: string, token: number) => books.reserves[`${id}/${token}`] ?? 0n,
  getDebts: async (id: string) => books.debts[id] ?? [],
} as unknown as ChainView);
const reserves = (l1: bigint, r1: bigint, l2 = 0n, r2 = 0n) => ({ [`${L}/1`]: l1, [`${R}/1`]: r1, [`${L}/2`]: l2, [`${R}/2`]: r2 });

test("P1: Δ is the chain's ondelta plus the Account's offdelta", async () => {
  const account = one({ ...base, ondelta: 0n, offdelta: -30n });
  const books: Books = { collateral: { 1: 100n }, ondelta: { 1: 40n }, reserves: reserves(1000n, 1000n), debts: {} };
  const rows = await before(chainOf(books), account);
  books.collateral = { 1: 0n };
  books.reserves = reserves(1010n, 1090n); // Δ = 10: Left is paid 10, Right 90
  expect(await payoutLines(chainOf(books), rows)).toEqual([]);
  books.reserves = reserves(970n, 1130n); // what offdelta alone would say
  expect(await payoutLines(chainOf(books), rows)).toHaveLength(1);
});

test("P1: every token is checked, not the first", async () => {
  const account = replica(new Map([[T1, base], [T2, base]]));
  const books: Books = { collateral: { 1: 100n, 2: 100n }, ondelta: {}, reserves: reserves(1000n, 1000n, 1000n, 1000n), debts: {} };
  const rows = await before(chainOf(books), account);
  books.collateral = { 1: 0n, 2: 0n };
  books.reserves = reserves(970n, 1130n, 970n, 1100n); // token 2: Right paid 30 short
  const lines = await payoutLines(chainOf(books), rows);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("token 2");
});

test("P1: a debt to a third party is not a debt to the peer", async () => {
  const account = one();
  const books: Books = { collateral: { 1: 100n }, ondelta: {}, reserves: reserves(1000n, 1000n), debts: {} };
  const rows = await before(chainOf(books), account);
  books.collateral = { 1: 0n };
  books.reserves = reserves(1000n, 1100n);
  books.debts = { [L]: [{ creditor: Z, amount: 30n }] }; // Left's shortfall booked to Z: Right was never paid its 30
  expect((await payoutLines(chainOf(books), rows)).length).toBeGreaterThan(0);
});

test("P1: a creditor's address in another letter case is the same creditor", async () => {
  const account = one();
  const books: Books = { collateral: { 1: 100n }, ondelta: {}, reserves: reserves(1000n, 1000n), debts: {} };
  const rows = await before(chainOf(books), account);
  books.collateral = { 1: 0n };
  books.reserves = reserves(1000n, 1100n);
  books.debts = { [L]: [{ creditor: R.toUpperCase().replace("0X", "0x"), amount: 30n }] };
  expect(await payoutLines(chainOf(books), rows)).toEqual([]);
});

test("P1: a chain paying both sides right, but with no rows to check, says nothing; with a row it is judged", async () => {
  const books: Books = { collateral: { 1: 100n }, ondelta: {}, reserves: reserves(1000n, 1000n), debts: {} };
  expect(await before(chainOf(books), replica(new Map()))).toEqual([]);
});

// ---- P-BELIEF
const withTagged = (rt: Runtime, _tag: AccountReplica["_tag"]): Runtime => {
  const [entity] = [...rt.entities.values()];
  const [peer, r] = [...entity!.accountReplicas][0]!;
  return ({ entities: new Map([[`${L}:a`, { ...entity!, accountReplicas: new Map([[peer, { ...r, _tag }]]) }]]) }) as unknown as Runtime;
};
import { checkBelief, lagging, NOTHING_SEEN, type CollateralView, type Trail } from "./belief.ts";

const believing = (rows: ReadonlyMap<typeof T1, readonly [bigint, bigint]>, _tag: "open" | "disputed" = "open"): Runtime => {
  const r = replica(new Map([...rows].map(([tk, [collateral, ondelta]]) => [tk, { collateral, ondelta, offdelta: 0n, leftCreditLimit: 0n, rightCreditLimit: 0n }])), {}, { _tag } as never);
  return ({ entities: new Map([[`${L}:a`, { state: { id: L }, accountReplicas: new Map([[R, r]]) }]]) }) as unknown as Runtime;
};
const chainOfRows = (rows: ReadonlyMap<typeof T1, readonly [bigint, bigint]>): CollateralView => ({
  getCollateral: async (_l, _r, token) => { const [collateral, ondelta] = [...rows].find(([tk]) => Number(tk) === token)?.[1] ?? [0n, 0n]; return { collateral, ondelta }; },
});
const rowsOf = (...r: readonly (readonly [typeof T1, bigint, bigint])[]) => new Map(r.map(([t, c, o]) => [t, [c, o] as const] as const));
const tick = (chain: ReadonlyMap<typeof T1, readonly [bigint, bigint]>, belief: ReadonlyMap<typeof T1, readonly [bigint, bigint]>, trail: Trail, _tag: "open" | "disputed" = "open") =>
  checkBelief(chainOfRows(chain), believing(belief, _tag), trail);

test("P-BELIEF: an ondelta the chain never held is red even when the collateral is right", async () => {
  const frame = await tick(rowsOf([T1, 100n, 5n]), rowsOf([T1, 100n, 6n]), NOTHING_SEEN);
  expect(frame.violations).toHaveLength(1);
});

test("P-BELIEF: an Account with no row for a token the chain holds is red", async () => {
  const frame = await checkBelief(chainOfRows(rowsOf([T1, 100n, 0n])), believing(new Map()), NOTHING_SEEN);
  expect(frame.violations).toEqual([]); // the check walks the Account's own tokens: none, so nothing to compare
  const withOther = await checkBelief(chainOfRows(rowsOf([T1, 0n, 0n], [T2, 100n, 0n])), believing(rowsOf([T1, 0n, 0n])), NOTHING_SEEN);
  expect(withOther.violations).toEqual([]); // and a token it has no row for is not walked either
});

test("P-BELIEF: the trail is remembered from frame to frame, so an older chain value the belief still holds is lag, not a violation", async () => {
  const a = await tick(rowsOf([T1, 100n, 0n]), rowsOf([T1, 100n, 0n]), NOTHING_SEEN);
  const b = await tick(rowsOf([T1, 250n, 0n]), rowsOf([T1, 100n, 0n]), a.trail); // the chain moved on, the event is not applied yet
  expect([a, b].flatMap((x) => x.violations)).toEqual([]);
  const c = await tick(rowsOf([T1, 250n, 0n]), rowsOf([T1, 250n, 0n]), b.trail);
  expect(c.violations).toEqual([]);
  const d = await tick(rowsOf([T1, 250n, 0n]), rowsOf([T1, 100n, 0n]), c.trail); // and now going back is red
  expect(d.violations).toHaveLength(1);
});

test("P-BELIEF: a disputed Account is judged every frame too (only the rest check leaves it out)", async () => {
  const frame = await tick(rowsOf([T1, 100n, 0n]), rowsOf([T1, 200n, 0n]), NOTHING_SEEN, "disputed");
  expect(frame.violations).toHaveLength(1);
});

test("P-BELIEF: every token is judged, not the first", async () => {
  const frame = await tick(rowsOf([T1, 100n, 0n], [T2, 100n, 0n]), rowsOf([T1, 100n, 0n], [T2, 7n, 0n]), NOTHING_SEEN);
  expect(frame.violations).toHaveLength(1);
  expect(frame.violations[0]).toContain("token 2");
});

test("P-BELIEF at rest: every token is judged, and only an Account whose dispute is live or finalized is skipped (H4)", async () => {
  const chain = chainOfRows(rowsOf([T1, 100n, 0n], [T2, 100n, 0n]));
  const behind = rowsOf([T1, 100n, 0n], [T2, 0n, 0n]); // the second token lags
  const tagged = (tag: "open" | "proposed" | "received" | "preparing" | "disputed") => lagging(chain, withTagged(believing(behind), tag));
  expect((await Promise.all((["open", "proposed", "received", "preparing"] as const).map(tagged))).map((l) => l.length)).toEqual([1, 1, 1, 1]);
  expect((await tagged("disputed")).length).toBe(0);
});

test("P-BELIEF at rest: an ondelta behind the chain is lag too, with the collateral right", async () => {
  expect(await lagging(chainOfRows(rowsOf([T1, 100n, 5n])), believing(rowsOf([T1, 100n, 0n])))).toHaveLength(1);
  expect(await lagging(chainOfRows(rowsOf([T1, 100n, 5n])), believing(rowsOf([T1, 100n, 5n])))).toEqual([]);
});
