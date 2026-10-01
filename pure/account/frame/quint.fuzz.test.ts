// Differential fuzz of account/frame against the Quint frame rules (account.qnt and account_core.qnt, #44), transcribed
// by Review B of PR 82. One Quint action is one TS call and after every event the two worlds are compared: ledger,
// pending frame, mempool, refused txs, head. Modelling choices: Quint's received-then-ack is taken atomically (the TS
// commits on arrival); Quint's reviseMempool runs just before a propose (the TS drops stale txs at propose); frames
// reach only the author's peer. Quint has no refusal message (R-FRAME-REFUSAL is owed to the spec thread): where the TS
// answers a repeat of a frame it declined with that refusal, the Quint world takes the TS's answer and the case is
// counted apart, so the one known divergence is visible and any other one fails the run.
import { describe, expect, test } from "bun:test";
import { unwrapOr } from "../../kernel/core/result.ts";
import { clockParams } from "../clause/clock.ts";
import { draw, holdOf, secretOf, signing, tokenOf, viewOf } from "../fixtures.ts";
import { emptyLedger } from "../ledger.ts";
import { holdId, other, type Ledger, type Side } from "../model.ts";
import { emptyAccount, ledgerOf, withLedger } from "../state.ts";
import type { AccountTx } from "../tx.ts";
import { accountRules, GENESIS, frameName, type AccountReplica } from "./account.ts";
import { propose, queue, receive, replica, resend, submit, type FrameHash, type Msg } from "./frame.ts";

const COLLATERAL = 2n;
const MAX_AMOUNT = 5n;
const MAX_CREDIT = 5n;
const HORIZON = 4n;
const RESERVE = 1n;
const SLOTS: readonly bigint[] = [1n, 2n, 3n];
const MAX_MEMPOOL = 3;
const GOLD = tokenOf(1n);
const PARAMS = unwrapOr(clockParams(1n, RESERVE, HORIZON), () => expect.unreachable("params"));

type Sided<X> = Readonly<Record<Side, X>>;
type Lk = Readonly<{ on: boolean; payer: Side; amount: bigint; hashlock: number; deadline: bigint }>;
type B = Readonly<{ off: bigint; ll: bigint; lr: bigint; locks: Readonly<Record<string, Lk>> }>;
type Tx =
  | Readonly<{ k: "pay"; amount: bigint }>
  | Readonly<{ k: "credit"; limit: bigint }>
  | Readonly<{ k: "lock"; id: bigint; payer: Side; amount: bigint; s: number; deadline: bigint }>
  | Readonly<{ k: "resolve"; id: bigint; s: number }>
  | Readonly<{ k: "cancel"; id: bigint }>
  | Readonly<{ k: "expire"; id: bigint }>;

const NO: Lk = { on: false, payer: "left", amount: 0n, hashlock: 0, deadline: 0n };
const get = (b: B, i: bigint): Lk => b.locks[String(i)] ?? NO;
const withLock = (b: B, id: bigint, l: Lk): B => ({ ...b, locks: { ...b.locks, [String(id)]: l } });
const mx = (a: bigint, b: bigint) => (a > b ? a : b);
const held = (b: B, s: Side) =>
  SLOTS.reduce((a, i) => a + (get(b, i).on && get(b, i).payer === s ? get(b, i).amount : 0n), 0n);
const room = (b: B, s: Side) =>
  (s === "left" ? mx(0n, b.off + b.ll - held(b, "left")) : mx(0n, COLLATERAL + b.lr - b.off - held(b, "right")));
const creditHolds = (b: B) =>
  b.off >= -b.ll && b.off <= COLLATERAL + b.lr && b.off - held(b, "left") >= -b.ll
  && b.off + held(b, "right") <= COLLATERAL + b.lr;

/** Quint applyTx, line for line; pay and credit are always the author's. `null` is a refusal. */
const quint = (b: B, tx: Tx, author: Side, now: bigint): B | null => {
  const l = "id" in tx ? get(b, tx.id) : NO;
  const slotOk = "id" in tx && SLOTS.includes(tx.id);
  switch (tx.k) {
    case "pay":
      return tx.amount < 1n || tx.amount > MAX_AMOUNT || tx.amount > room(b, author)
        ? null : { ...b, off: author === "left" ? b.off - tx.amount : b.off + tx.amount };
    case "credit": {
      const nb = author === "right" ? { ...b, ll: tx.limit } : { ...b, lr: tx.limit };
      return tx.limit < 0n || tx.limit > MAX_CREDIT || !creditHolds(nb) ? null : nb;
    }
    case "lock":
      return !slotOk || tx.payer !== author || tx.amount < 1n || tx.amount > MAX_AMOUNT || l.on
        || SLOTS.some((i) => get(b, i).on && get(b, i).hashlock === tx.s)
        || tx.deadline <= now || tx.deadline > now + HORIZON + RESERVE || tx.amount > room(b, tx.payer)
        ? null : withLock(b, tx.id, { on: true, ...pick(tx) });
    case "resolve":
      return !slotOk || !l.on || other(l.payer) !== author || tx.s !== l.hashlock || now > l.deadline
        ? null : { ...withLock(b, tx.id, NO), off: l.payer === "left" ? b.off - l.amount : b.off + l.amount };
    case "cancel": return !slotOk || !l.on || other(l.payer) !== author ? null : withLock(b, tx.id, NO);
    case "expire": return !slotOk || !l.on || now <= l.deadline + RESERVE ? null : withLock(b, tx.id, NO);
  }
};

const pick = (t: Readonly<{ payer: Side; amount: bigint; s: number; deadline: bigint }>) =>
  ({ payer: t.payer, amount: t.amount, hashlock: t.s, deadline: t.deadline });

const replay = (b: B, txs: readonly Tx[], a: Side, now: bigint): B | null =>
  txs.reduce<B | null>((acc, tx) => (acc === null ? null : quint(acc, tx, a, now)), b);

type Kept = Readonly<{ body: B; txs: readonly Tx[]; dropped: readonly Tx[] }>;
const keepValid = (b: B, txs: readonly Tx[], a: Side, now: bigint): Kept =>
  txs.reduce<Kept>((acc, tx) => {
    const next = quint(acc.body, tx, a, now);
    return next === null ? { ...acc, dropped: [...acc.dropped, tx] } : { ...acc, body: next, txs: [...acc.txs, tx] };
  }, { body: b, txs: [], dropped: [] });

const holdArgs = (l: Lk, id: bigint) => [l.payer, l.amount, id, l.deadline, l.hashlock] as const;
const toLedger = (b: B): Ledger => ({
  ...emptyLedger, collateral: COLLATERAL, ondelta: 0n, offdelta: b.off, limit: { left: b.ll, right: b.lr },
  holds: SLOTS.filter((i) => get(b, i).on).map((i) => holdOf(...holdArgs(get(b, i), i))),
});
const sortedHolds = (l: Ledger) => ({ ...l, holds: l.holds.toSorted((a, b) => (a.id < b.id ? -1 : 1)) });
const plain = (_: string, v: unknown): unknown => {
  switch (true) {
    case typeof v === "bigint": return `${v}n`;
    case v instanceof Uint8Array: return Array.from(v);
    default: return v;
  }
};
const J = (x: unknown) => JSON.stringify(x, plain);

const toTs = (tx: Tx): AccountTx => {
  switch (tx.k) {
    case "pay": return { _tag: "pay", token: GOLD, amount: tx.amount };
    case "credit": return { _tag: "set_credit", token: GOLD, limit: tx.limit };
    case "lock": return { _tag: "lock", token: GOLD, hold: holdOf(tx.payer, tx.amount, tx.id, tx.deadline, tx.s) };
    case "resolve": return { _tag: "resolve", token: GOLD, id: holdId(tx.id), secret: secretOf(tx.s) };
    case "cancel": return { _tag: "cancel", token: GOLD, id: holdId(tx.id) };
    case "expire": return { _tag: "expire", token: GOLD, id: holdId(tx.id) };
  }
};

/** A frame in the Quint world: `fid` 0 is the genesis head, frames are numbered from 1 in the order proposed. */
type Frame = Readonly<{ height: number; parent: number; author: Side; txs: readonly Tx[]; after: B }>;
type Q = Readonly<{
  height: number; tip: B; lastFid: number; proposed: number; mempool: readonly Tx[]; refused: readonly Tx[];
}>;
type World = Readonly<{
  q: Sided<Q>; t: Sided<AccountReplica>; clock: Sided<bigint>;
  frames: readonly Frame[]; wire: readonly Msg<AccountTx>[]; heads: readonly FrameHash[];
  flying: readonly number[]; acks: readonly number[];
  stats: Readonly<Record<string, number>>; bad: readonly string[];
}>;
type Draw = (k: number, n: number) => number;

const GEN: B = { off: 0n, ll: 0n, lr: 0n, locks: {} };
const open = (): Q => ({ height: 0, tip: GEN, lastFid: 0, proposed: 0, mempool: [], refused: [] });
const START: AccountReplica["state"] = withLedger(emptyAccount, GOLD, { ...emptyLedger, collateral: COLLATERAL });
const newWorld = (): World => ({
  q: { left: open(), right: open() },
  t: { left: replica("left", GENESIS, START), right: replica("right", GENESIS, START) },
  clock: { left: 0n, right: 0n }, frames: [], wire: [], heads: [], flying: [], acks: [], stats: {}, bad: [],
});

const rulesOf = (w: World, s: Side) => accountRules({ clock: PARAMS, view: viewOf(w.clock[s]) }, signing);
const frameAt = (w: World, fid: number): Frame => w.frames[fid - 1] ?? expect.unreachable("no such frame");
const msgAt = (w: World, fid: number): Msg<AccountTx> => w.wire[fid - 1] ?? expect.unreachable("no such message");
const nameOf = (m: Msg<AccountTx>) => (m._tag === "frame" ? frameName(m.frame) : GENESIS);
/** The head a frame gave when it was proposed: the signed digest, the hash its ack carries. */
const headOf = (w: World, fid: number): FrameHash => w.heads[fid - 1] ?? expect.unreachable("no such head");
const fidsOf = (w: World, hash: string): readonly number[] => w.heads.flatMap((h, i) => (h === hash ? [i + 1] : []));
const key = (w: World, fid: number): string =>
  (fid === 0 ? "" : `${key(w, frameAt(w, fid).parent)}<${J(frameAt(w, fid).txs)}`);

const bump = (w: World, what: string): World => ({ ...w, stats: { ...w.stats, [what]: (w.stats[what] ?? 0) + 1 } });
const note = (w: World, why: string): World => bump({ ...w, bad: [...w.bad, why] }, `MISMATCH ${why.split(" ")[0]}`);
/** Each check is `[holds, what went wrong if it does not]`. */
const ensure = (w: World, checks: readonly (readonly [boolean, string])[]): World =>
  checks.filter(([ok]) => !ok).reduce((acc, [, why]) => note(acc, why), w);
const upd = (w: World, s: Side, q: Q, t: AccountReplica): World =>
  ({ ...w, q: { ...w.q, [s]: q }, t: { ...w.t, [s]: t } });
const planning = (w: World, q: Q): B => (q.proposed === 0 ? q.tip : frameAt(w, q.proposed).after);

const compareSide = (w: World, s: Side, when: string): readonly string[] => {
  const a = w.q[s];
  const b = w.t[s];
  const pendingTxs = a.proposed === 0 || b.pending === undefined
    || J(frameAt(w, a.proposed).txs.map(toTs)) === J(b.pending.frame.txs);
  const checks: readonly (readonly [string, boolean])[] = [
    ["state", J(sortedHolds(ledgerOf(b.state, GOLD))) === J(sortedHolds(toLedger(a.tip)))],
    ["pending", (a.proposed !== 0) === (b.pending !== undefined)],
    ["pending-txs", pendingTxs],
    ["mempool", J(a.mempool.map(toTs)) === J(b.mempool)],
    ["refused", J(a.refused.map(toTs)) === J(b.refused.map((x) => x.tx))],
    ["head", a.lastFid === 0 ? b.head === GENESIS : fidsOf(w, b.head).some((f) => key(w, f) === key(w, a.lastFid))],
    ["credit-holds", creditHolds(a.tip)],
  ];
  return checks.filter(([, ok]) => !ok).map(([what]) => `${what} ${when} ${s}`);
};
const compared = (w: World, when: string): World =>
  (["left", "right"] as const).reduce((acc, s) => compareSide(acc, s, when).reduce(note, acc), w);

const genTx = (w: World, s: Side, r: Draw): Tx => {
  const tip = w.q[s].tip;
  const k = r(2, 9);
  const id = SLOTS[r(3, 3)] ?? 1n;
  const live = SLOTS.filter((x) => get(tip, x).on);
  const pk = live.length > 0 && r(4, 4) > 0 ? live[r(5, live.length)] ?? id : id;
  const lk = get(tip, pk);
  switch (true) {
    case k <= 2: return { k: "pay", amount: BigInt(1 + r(6, 5)) };
    case k === 3: return { k: "credit", limit: BigInt(r(6, 6)) };
    case k <= 5: return {
      k: "lock", id, payer: r(7, 8) > 0 ? s : other(s), amount: BigInt(1 + r(8, 5)), s: 1 + r(9, 4),
      deadline: w.clock[s] + BigInt(r(10, 9)) - 1n,
    };
    case k === 6: return { k: "resolve", id: pk, s: lk.on && r(11, 5) > 0 ? lk.hashlock : 1 + r(12, 4) };
    case k === 7: return { k: "cancel", id: pk };
    default: return { k: "expire", id: pk };
  }
};

const tick = (w: World, s: Side): World =>
  (w.clock[s] + 1n - w.clock[other(s)] <= 1n ? { ...w, clock: { ...w.clock, [s]: w.clock[s] + 1n } } : w);

const SUBMIT_BOUND = "submit: quint mempool bound (TS has none)";
const SUBMIT_STALE = "submit: quint refuses over a stale mempool, TS plans over what still applies";

const submitGap = (q: Q, planned: B | null): string => {
  switch (true) {
    case q.mempool.length >= MAX_MEMPOOL: return SUBMIT_BOUND;
    case planned === null: return SUBMIT_STALE;
    default: return "submit: OTHER";
  }
};

const onSubmit = (w: World, s: Side, r: Draw): World => {
  const q = w.q[s];
  const tx = genTx(w, s, r);
  const planned = replay(planning(w, q), q.mempool, s, w.clock[s]);
  const qOk = q.mempool.length < MAX_MEMPOOL && planned !== null && quint(planned, tx, s, w.clock[s]) !== null;
  const sub = submit(rulesOf(w, s), w.t[s], toTs(tx));
  const queued = { ...q, mempool: [...q.mempool, tx] };
  if (qOk === sub.ok) return sub.ok ? bump(upd(w, s, queued, sub.value), "submit accepted") : bump(w, "submit refused");
  const excused = q.mempool.length >= MAX_MEMPOOL || planned === null;
  const counted = bump(w, submitGap(q, planned));
  const aligned = sub.ok ? upd(counted, s, queued, sub.value) : counted;
  return ensure(aligned, [[excused, `submit ${J([tx, s, qOk, sub.ok])}`]]);
};

const onPropose = (w: World, s: Side): World => {
  const q = w.q[s];
  if (q.proposed !== 0) return w;
  const sel = keepValid(q.tip, q.mempool, s, w.clock[s]);
  const revised: Q = { ...q, mempool: sel.txs, refused: [...q.refused, ...sel.dropped] };
  const out = propose(rulesOf(w, s), w.t[s]);
  const sent = out.sent[0];
  const head = out.replica.pending?.head;
  if (q.height >= 99 || sel.txs.length === 0) {
    const quiet = upd(w, s, revised, out.replica);
    const counted = q.mempool.length > 0 ? bump(quiet, "propose all refused") : quiet;
    return ensure(counted, [[out.sent.length === 0, `propose-sent ${s}`]]);
  }
  if (out.sent.length !== 1 || sent === undefined || head === undefined) {
    return note(w, `propose-sent ${s}`);
  }
  const fid = w.frames.length + 1;
  const frame: Frame = { height: q.height + 1, parent: q.lastFid, author: s, txs: sel.txs, after: sel.body };
  const next = upd(w, s, { ...revised, proposed: fid, mempool: [] }, out.replica);
  const logged = {
    ...next, frames: [...w.frames, frame], wire: [...w.wire, sent], heads: [...w.heads, head],
    flying: [...w.flying, fid],
  };
  return bump(logged, "propose");
};

const onResend = (w: World, s: Side): World => {
  const sent = resend(w.t[s]);
  return ensure(w, [[sent.length === (w.q[s].proposed === 0 ? 0 : 1), `resend ${s}`]]);
};

const advance = (q: Q, f: Frame, fid: number): Q =>
  ({ ...q, height: f.height, tip: f.after, lastFid: fid, proposed: 0 });

/** Quint's acceptable: the frame is the next one, by the other side, and replaying its txs gives the body it claims. */
const acceptable = (q: Q, now: bigint, f: Frame, self: Side): boolean => {
  const next = f.author !== self && f.parent === q.lastFid && f.height === q.height + 1;
  const b = next ? replay(q.tip, f.txs, f.author, now) : null;
  return b !== null && J(toLedger(b)) === J(toLedger(f.after));
};

type Heard = Readonly<{ kind: string; next: Q; ack: boolean }>;

/** Quint's onPropose for the replica `s` hearing frame `fid`. */
const quintHears = (w: World, s: Side, fid: number): Heard => {
  const q = w.q[s];
  const f = frameAt(w, fid);
  const now = w.clock[s];
  const own = q.proposed === 0 ? undefined : frameAt(w, q.proposed);
  const restored: Q = { ...q, proposed: 0, mempool: [...(own?.txs ?? []), ...q.mempool] };
  switch (true) {
    case q.lastFid !== 0 && q.lastFid === fid: return { kind: "re_acked", next: q, ack: true };
    case own === undefined && acceptable(q, now, f, s):
      return { kind: "accepted", next: advance(q, f, fid), ack: true };
    case own === undefined || own.height !== f.height || f.author === s:
      return { kind: "refused", next: q, ack: false };
    case s === "left": return { kind: "kept_own", next: q, ack: false };
    case acceptable(restored, now, f, s):
      return { kind: "accepted_over_own", next: advance(restored, f, fid), ack: true };
    default: return { kind: "refused", next: q, ack: false };
  }
};

const KINDS = ["accepted", "accepted_over_own", "re_acked", "kept_own"] as const;
const KNOWN = (quint: string) => `deliver: TS refuses a repeat of a declined frame, Quint says ${quint}`;

const OTHERS = ["kept_own", "accepted", "accepted_over_own"];

const onDeliver = (w: World, s: Side, r: Draw): World => {
  const cand = w.flying.filter((fid) => frameAt(w, fid).author !== s);
  const fid = cand[r(2, Math.max(cand.length, 1))];
  if (fid === undefined) return w;
  const quintSays = quintHears(w, s, fid);
  const heard = receive(rulesOf(w, s), w.t[s], msgAt(w, fid));
  const tsKind = KINDS.find((k) => k === heard.outcome._tag) ?? "refused";
  // a repeat is the very frame this replica already refused on this head; any other frame is judged afresh or stale
  const earlier = w.t[s].declined;
  const sent = msgAt(w, fid);
  const repeat = earlier !== undefined && sent._tag === "frame" && nameOf(sent) === earlier.hash;
  const known = repeat && heard.outcome._tag === "refused_invalid" && quintSays.kind !== "refused";
  const sameRefusal = earlier === undefined ? [] : [{
    _tag: "refusal", hash: nameOf(sent), index: earlier.index,
    fault: rulesOf(w, s).tag(earlier.fault), mark: earlier.attempt, floor: w.t[s].signed,
  }];
  const said: Heard = known ? { kind: tsKind, next: w.q[s], ack: false } : quintSays;
  const counted = bump(w, known ? KNOWN(quintSays.kind) : `deliver ${quintSays.kind}`);
  const ackSent = heard.sent.length === 1 && heard.sent[0]?._tag === "ack";
  const unknown = heard.sent.some((m) => m._tag === "ack" && fidsOf(w, m.hash).length === 0);
  const checked = ensure(counted, [
    [tsKind === said.kind, `deliver-outcome q=${said.kind} ts=${heard.outcome._tag} ${s} ${fid}`],
    [said.ack === ackSent, `ack-presence ${said.kind} ${s}`],
    [!unknown, "ack-unknown"],
    // the divergence is only this: the same refusal as the first time, and Quint's only other answers are these three
    [!known || OTHERS.includes(quintSays.kind), `known-other q=${quintSays.kind}`],
    [!known || J(heard.sent) === J(sameRefusal), `refusal-differs ${s} ${fid}`],
  ]);
  const moved = upd(checked, s, said.next, heard.replica);
  return said.ack ? { ...moved, acks: [...moved.acks, fid] } : moved;
};

const onAck = (w: World, s: Side, r: Draw): World => {
  const cand = w.acks.filter((fid) => frameAt(w, fid).author === s);
  const fid = cand[r(2, Math.max(cand.length, 1))];
  if (fid === undefined) return w;
  const q = w.q[s];
  const fits = q.proposed === fid;
  const heard = receive(rulesOf(w, s), w.t[s], { _tag: "ack", hash: headOf(w, fid) });
  const tsFits = heard.outcome._tag === "committed_own";
  const counted = bump(w, fits ? "ack commits" : "ack ignored");
  const checked = ensure(counted, [[fits === tsFits, `ack-fits q=${fits} ts=${heard.outcome._tag} ${s} ${fid}`]]);
  return upd(checked, s, fits ? advance(q, frameAt(w, fid), fid) : q, heard.replica);
};

const onLose = (w: World, r: Draw): World => {
  const dropFlying = r(2, 2) > 0 && w.flying.length > 0;
  const gone = dropFlying ? w.flying[r(3, w.flying.length)] : w.acks[r(3, Math.max(w.acks.length, 1))];
  return dropFlying
    ? { ...w, flying: w.flying.filter((x) => x !== gone) }
    : { ...w, acks: w.acks.filter((x) => x !== gone) };
};

const event = (w: World, seed: number, run: number, i: number): World => {
  const r: Draw = (k, n) => draw(seed, run, i, k, n);
  const ev = r(0, 12);
  const s: Side = r(1, 2) === 0 ? "left" : "right";
  switch (true) {
    case ev === 0: return tick(w, s);
    case ev <= 3: return onSubmit(w, s, r);
    case ev <= 5: return onPropose(w, s);
    case ev === 6: return onResend(w, s);
    case ev <= 9: return onDeliver(w, s, r);
    case ev === 10: return onAck(w, s, r);
    default: return onLose(w, r);
  }
};

const runOne = (seed: number, run: number, events: number): World =>
  Array.from({ length: events }, (_, i) => i).reduce(
    (w, i) => compared(event(w, seed, run, i), `run ${run} event ${i}`), newWorld(),
  );

type Total = Readonly<{ stats: Readonly<Record<string, number>>; bad: readonly string[] }>;
const totalOf = (seed: number, runs: number, events: number): Total =>
  Array.from({ length: runs }, (_, run) => runOne(seed, run, events)).reduce<Total>((acc, w) => ({
    bad: [...acc.bad, ...w.bad],
    stats: Object.entries(w.stats).reduce((s, [k, n]) => ({ ...s, [k]: (s[k] ?? 0) + n }), acc.stats),
  }), { stats: {}, bad: [] });

describe("account/frame the frame rules agree with the Quint model", () => {
  const total = totalOf(4242, 2000, 70);

  test("after every event the ledger, pending frame, mempool, refused txs and head match Quint's", () => {
    expect(total.bad.slice(0, 5)).toEqual([]);
  });

  test("the fuzz reaches every outcome of the round, and the one known divergence", () => {
    const seen = (k: string) => total.stats[k] ?? 0;
    ["propose", "ack commits", "ack ignored", "deliver accepted", "deliver re_acked", "deliver refused",
      "deliver kept_own", "deliver accepted_over_own", "submit accepted", "submit refused"]
      .forEach((k) => expect([k, seen(k) > 0]).toEqual([k, true]));
    ["kept_own", "accepted"].forEach((k) => expect([k, seen(KNOWN(k)) > 0]).toEqual([k, true]));
    const known = Object.keys(total.stats).filter((k) => k.startsWith(KNOWN("")));
    expect(known.toSorted()).toEqual(["kept_own", "accepted"].map(KNOWN).toSorted());
  });
});
