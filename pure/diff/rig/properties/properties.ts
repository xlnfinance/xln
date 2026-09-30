// Properties the rewrite must hold whatever og does (design/account-model.md section 5). The lane compares the
// rewrite with og; these compare it with the definition of correct, so they stay meaningful where og is wrong.
//
//   P2 credit-bounded: every committed Account, per token, stays within RCPAN in the worst case over its open clauses,
//      now and after its signed settlement lands.
//   P4 agreed: no Entity signs two different ProofBodies at one proof nonce of one Account, across the whole run, and
//      two replicas of one Account at the same frame height hold the same deltas.
//
// A check reads only committed state: each Entity's Account replicas (their committed body and dispute witnesses).
import { committedView, stableJson } from "../../../xln.ts";
import type { AccountReplica, DisputeHanko, EntityId, EntityReplica, Runtime } from "../../../xln.ts";

/** One Account as one Entity holds it. */
type Held = { readonly self: EntityId; readonly peer: EntityId; readonly replica: AccountReplica };
/** Every (Account, signer, proof nonce) the run has seen signed, and the ProofBody hash it signed. */
export type Signed = ReadonlyMap<string, string>;
export type Checked = { readonly signed: Signed; readonly violations: readonly string[] };
export const NOTHING_SIGNED: Signed = new Map();

const pairKey = (a: string, b: string): string => (a < b ? `${a}/${b}` : `${b}/${a}`);

/** One replica per Entity (a board's members hold the same committed state; the lane compares them with og). */
const entitiesOf = (rt: Runtime): readonly EntityReplica[] =>
  [...new Map([...rt.entities.values()].map((e) => [e.state.id, e] as const)).values()];

const accountsOf = (rt: Runtime): readonly Held[] =>
  entitiesOf(rt).flatMap((e) =>
    [...e.accountReplicas].map(([peer, replica]) => ({ self: e.state.id, peer, replica })));

// ---- P2 ----
// RCPAN from the contract's side (Depository._applyAccountDelta): with Δ = ondelta + offdelta, Left can owe at most
// the credit Right extends (Δ ≥ −leftCredit) and Right at most collateral + the credit Left extends
// (Δ ≤ collateral + rightCredit), in the worst case over the open clauses: every lock, same-j swap offer and pull
// paying out on its payer's side. A co-signed settlement (ready_to_submit) moves collateral and ondelta on chain (Account._settleDiffs),
// so the state after it must hold RCPAN too. Its reserve legs are not the Account's: a negative leftDiff spends
// Left's reserve, not its room (og holds it against the room anyway, a stricter local policy).

type Clauses = ReadonlyMap<number, { readonly left: bigint; readonly right: bigint }>;
type Owed = { readonly tokenId: number; readonly onLeft: boolean; readonly amount: bigint };
const clauseRows = (b: AccountReplica["state"]): readonly Owed[] => [
  ...[...b.locks.values()].map((l) => ({ tokenId: Number(l.tokenId), onLeft: l.senderIsLeft, amount: l.amount })),
  ...[...b.offers.values()].filter((o) => o.crossJurisdiction === undefined)
    .map((o) => ({ tokenId: Number(o.giveTokenId), onLeft: o.makerIsLeft, amount: o.giveAmount })),
  ...[...(b.pulls?.values() ?? [])]
    .map((p) => ({ tokenId: p.tokenId, onLeft: p.amount < 0n, amount: p.amount < 0n ? -p.amount : p.amount })),
];
const clausesOf = (b: AccountReplica["state"]): Clauses => clauseRows(b).reduce<Clauses>((m, o) => {
  const had = m.get(o.tokenId) ?? { left: 0n, right: 0n };
  const next = o.onLeft ? { ...had, left: had.left + o.amount } : { ...had, right: had.right + o.amount };
  return new Map([...m, [o.tokenId, next]]);
}, new Map());

type Ledger = {
  readonly collateral: bigint; readonly delta: bigint; readonly leftCredit: bigint; readonly rightCredit: bigint;
};
const breach = (at: string, l: Ledger, owes: { readonly left: bigint; readonly right: bigint }): readonly string[] => {
  const left = l.delta + l.leftCredit - owes.left;
  const right = l.collateral + l.rightCredit - l.delta - owes.right;
  return left >= 0n && right >= 0n
    ? []
    : [`${at}: room left ${left} right ${right} (collateral ${l.collateral} Δ ${l.delta} credit `
      + `${l.leftCredit}/${l.rightCredit} clauses ${owes.left}/${owes.right})`];
};
const overdrawn = (h: Held): readonly string[] => {
  const b = h.replica.state;
  const clauses = clausesOf(b);
  // only a settlement both sides have signed can land: a half-signed workspace is still the approver's to refuse
  const signed = b.settlement?.status === "ready_to_submit" ? b.settlement.compiledDiffs ?? [] : [];
  return [...b.account.deltas.values()].flatMap((d) => {
    const tokenId = Number(d.tokenId);
    const owes = clauses.get(tokenId) ?? { left: 0n, right: 0n };
    const now: Ledger = {
      collateral: d.collateral, delta: d.ondelta + d.offdelta,
      leftCredit: d.leftCreditLimit, rightCredit: d.rightCreditLimit,
    };
    const settle = signed.find((x) => x.tokenId === tokenId);
    const after = settle === undefined
      ? []
      : breach(`P2 ${h.self}→${h.peer} token ${tokenId} after its signed settlement (collateral ${settle.collateralDiff >= 0n ? "+" : ""}${settle.collateralDiff}, ondelta ${settle.ondeltaDiff >= 0n ? "+" : ""}${settle.ondeltaDiff}, workspace ${b.settlement?.status}, from collateral ${now.collateral} Δ ${now.delta})`,
        { ...now, collateral: now.collateral + settle.collateralDiff, delta: now.delta + settle.ondeltaDiff }, owes);
    return [...breach(`P2 ${h.self}→${h.peer} token ${tokenId}`, now, owes), ...after];
  });
};

// ---- P4 ----

/** The hankos an Entity holds on one Account: its own (`current`) and its peer's (`counterparty`), by signer. */
const signaturesOf = (h: Held): readonly (readonly [EntityId, DisputeHanko])[] => [
  ...(h.replica.dispute.current === undefined ? [] : [[h.self, h.replica.dispute.current] as const]),
  ...(h.replica.dispute.counterparty === undefined ? [] : [[h.peer, h.replica.dispute.counterparty] as const]),
];
const signedKey = (h: Held, signer: EntityId, w: DisputeHanko): string =>
  `${pairKey(h.self, h.peer)} signer ${signer} nonce ${w.proofNonce}`;

/** Each hanko held on one Account, keyed by Account, signer and nonce, with the ProofBody hash it signs. */
const signedRows = (h: Held): readonly (readonly [string, string])[] =>
  signaturesOf(h).map(([signer, w]) => [signedKey(h, signer, w), w.proofBodyHash.toLowerCase()]);
const recordSigned = (before: Signed, held: readonly Held[]): Checked =>
  held.flatMap(signedRows).reduce<Checked>((acc, [key, body]) => {
    const seen = acc.signed.get(key);
    if (seen === undefined) return { ...acc, signed: new Map([...acc.signed, [key, body]]) };
    return seen === body ? acc : { ...acc, violations: [...acc.violations, `P4 ${key}: signed ${seen} and ${body}`] };
  }, { signed: before, violations: [] });

const heightOf = (r: AccountReplica): bigint => r.head.height;
const deltasOf = (r: AccountReplica): string => {
  const view = committedView(r.state);
  return view.ok ? stableJson([...view.value.deltas.values()]) : "refused";
};
/** Both sides of an Account at one committed height hold the same deltas. */
const disagreeing = (held: readonly Held[]): readonly string[] => {
  const byKey = new Map(held.map((h) => [`${h.self}→${h.peer}`, h] as const));
  return held.filter((h) => h.self < h.peer).flatMap((h) => {
    const other = byKey.get(`${h.peer}→${h.self}`);
    if (other === undefined || heightOf(other.replica) !== heightOf(h.replica)) return [];
    const [mine, theirs] = [deltasOf(h.replica), deltasOf(other.replica)];
    return mine === theirs ? [] : [`P4 ${pairKey(h.self, h.peer)} height ${heightOf(h.replica)}: ${mine} vs ${theirs}`];
  });
};

/** Every property over one committed Runtime, given what the run has signed so far. */
export const checkProperties = (rt: Runtime, signed: Signed): Checked => {
  const held = accountsOf(rt);
  const recorded = recordSigned(signed, held);
  return {
    signed: recorded.signed,
    violations: [...held.flatMap(overdrawn), ...recorded.violations, ...disagreeing(held)],
  };
};
