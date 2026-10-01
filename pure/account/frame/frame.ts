// The bilateral round of one Account (spec: Arrival account/frames.scm, Quint account.qnt): a replica proposes a frame
// of its mempool on top of its head, the peer commits it and answers with an ack, and the proposer commits on the ack.
// Every function takes a replica and returns a replica; none throws and none halts anything: a message that is not
// the next one, or that does not apply, is refused and changes nothing (R-X1). What a tx is, how it applies and how a
// frame is named come in as `Rules`, so the same round runs on the Account's txs and on the spec page's abstract ones.
import { foldResult, map, type Result } from "../../kernel/core/result.ts";
import type { Brand, Tagged } from "../../kernel/core/tagged.ts";
import { other, type Side } from "../model.ts";

/** The name of a frame: equal frames have equal hashes, so equal heads mean equal histories. */
export type FrameHash = Brand<string, "FrameHash">;

/**
 * A frame names its parent by hash (R-PARENT): it is the next frame only on a replica whose head is that parent. It
 * names its author too, because a tx means what its author's side says: the same bytes written by the other side are
 * another frame, and a frame handed back to its own author is not the peer's (Quint `acceptable`: `f.author != self`).
 */
export type Frame<Tx> = Readonly<{ author: Side; parent: FrameHash; txs: readonly Tx[] }>;

export type Msg<Tx> = Tagged<"frame", { frame: Frame<Tx> }> | Tagged<"ack", { hash: FrameHash }>;

/** What a frame is made of. `apply` is the author's tx on the judging replica's state, by that replica's view. */
export type Rules<Tx, S, F> = Readonly<{
  apply: (state: S, author: Side, tx: Tx) => Result<S, F>;
  hash: (frame: Frame<Tx>) => FrameHash;
}>;

/** A tx that stopped applying, with the refusal its owner is told (R-NOTICE): it is never dropped silently. */
export type Refused<Tx, F> = Readonly<{ tx: Tx; fault: F }>;

type Proposed<Tx, S> = Readonly<{ frame: Frame<Tx>; after: S }>;

/** One side of the Account: its committed head and the state that head made, and the txs it has not committed yet. */
export type Replica<Tx, S, F> = Readonly<{
  side: Side;
  head: FrameHash;
  state: S;
  mempool: readonly Tx[];
  pending: Proposed<Tx, S> | undefined;
  refused: readonly Refused<Tx, F>[];
}>;

export const replica = <Tx, S, F>(side: Side, head: FrameHash, state: S): Replica<Tx, S, F> =>
  ({ side, head, state, mempool: [], pending: undefined, refused: [] });

export type Out<Tx, S, F> = Readonly<{ replica: Replica<Tx, S, F>; sent: readonly Msg<Tx>[] }>;

/** Which rule answered a message, so a test (and a log) can say why a replica did what it did. */
export type Outcome<F> =
  | Tagged<"accepted">
  | Tagged<"accepted_over_own">
  | Tagged<"re_acked">
  | Tagged<"kept_own">
  | Tagged<"refused_invalid", { fault: F }>
  | Tagged<"refused_own">
  | Tagged<"refused_empty">
  | Tagged<"refused_not_next">
  | Tagged<"committed_own">
  | Tagged<"ack_ignored">;

export type Heard<Tx, S, F> = Out<Tx, S, F> & Readonly<{ outcome: Outcome<F> }>;

const ack = <Tx>(hash: FrameHash): Msg<Tx> => ({ _tag: "ack", hash });
const frameMsg = <Tx>(frame: Frame<Tx>): Msg<Tx> => ({ _tag: "frame", frame });

const applyAll = <Tx, S, F>(rules: Rules<Tx, S, F>, state: S, author: Side, txs: readonly Tx[]): Result<S, F> =>
  foldResult(txs, state, (s, tx) => rules.apply(s, author, tx));

type Split<Tx, S, F> = Readonly<{ state: S; valid: readonly Tx[]; refused: readonly Refused<Tx, F>[] }>;

/** Each tx is checked against the state plus the valid txs ahead of it; one that no longer holds is refused. */
const splitValid = <Tx, S, F>(rules: Rules<Tx, S, F>, side: Side, state: S, txs: readonly Tx[]): Split<Tx, S, F> =>
  txs.reduce<Split<Tx, S, F>>((acc, tx) => {
    const next = rules.apply(acc.state, side, tx);
    return next.ok
      ? { ...acc, state: next.value, valid: [...acc.valid, tx] }
      : { ...acc, refused: [...acc.refused, { tx, fault: next.error }] };
  }, { state, valid: [], refused: [] });

/** The state a new tx must apply to: the committed state, the pending frame, and the queued txs that still hold. */
const planned = <Tx, S, F>(rules: Rules<Tx, S, F>, r: Replica<Tx, S, F>): S =>
  splitValid(rules, r.side, r.pending?.after ?? r.state, r.mempool).state;

/** Queues a tx without the guard at the door; the propose guard (and the peer's) still checks it. */
export const queue = <Tx, S, F>(r: Replica<Tx, S, F>, tx: Tx): Replica<Tx, S, F> =>
  ({ ...r, mempool: [...r.mempool, tx] });

/** R-ADMIT, the first guard: a tx that can never apply on top of everything queued is refused at once. */
export const submit = <Tx, S, F>(
  rules: Rules<Tx, S, F>, r: Replica<Tx, S, F>, tx: Tx,
): Result<Replica<Tx, S, F>, F> => map(rules.apply(planned(rules, r), r.side, tx), () => queue(r, tx));

const NO_MESSAGES: readonly never[] = [];

/**
 * R-ADMIT, the second guard: the mempool is checked against the committed head and what no longer holds is refused with
 * notice (R-NOTICE). The valid txs become one pending frame on the head and go to the peer; with none, nothing is sent.
 */
export const propose = <Tx, S, F>(rules: Rules<Tx, S, F>, r: Replica<Tx, S, F>): Out<Tx, S, F> => {
  if (r.pending !== undefined || r.mempool.length === 0) return { replica: r, sent: NO_MESSAGES };
  const split = splitValid(rules, r.side, r.state, r.mempool);
  const frame = { author: r.side, parent: r.head, txs: split.valid };
  const pending = split.valid.length === 0 ? undefined : { frame, after: split.state };
  const proposed = { ...r, mempool: [], refused: [...r.refused, ...split.refused], pending };
  return { replica: proposed, sent: pending === undefined ? NO_MESSAGES : [frameMsg(pending.frame)] };
};

/** A timeout: the proposer sends its pending frame again, so a lost frame or a lost ack cannot wedge it. */
export const resend = <Tx, S, F>(r: Replica<Tx, S, F>): readonly Msg<Tx>[] =>
  (r.pending === undefined ? NO_MESSAGES : [frameMsg(r.pending.frame)]);

const heard = <Tx, S, F>(
  r: Replica<Tx, S, F>, sent: readonly Msg<Tx>[], outcome: Outcome<F>,
): Heard<Tx, S, F> => ({ replica: r, sent, outcome });

/** Rolls the pending frame back: its txs go ahead of the mempool, to be checked again at the next propose. */
const withoutPending = <Tx, S, F>(r: Replica<Tx, S, F>): Replica<Tx, S, F> =>
  ({ ...r, mempool: [...(r.pending?.frame.txs ?? []), ...r.mempool], pending: undefined });

/** The peer's frame is the next one and holds: commit it (a pending frame of mine rolls back) and ack. */
const accept = <Tx, S, F>(r: Replica<Tx, S, F>, hash: FrameHash, after: S): Heard<Tx, S, F> => {
  const base = r.pending === undefined ? r : withoutPending(r);
  const committed = { ...base, head: hash, state: after };
  return heard(committed, [ack(hash)], r.pending === undefined ? { _tag: "accepted" } : { _tag: "accepted_over_own" });
};

const onFrame = <Tx, S, F>(rules: Rules<Tx, S, F>, r: Replica<Tx, S, F>, f: Frame<Tx>): Heard<Tx, S, F> => {
  if (f.author === r.side) return heard(r, NO_MESSAGES, { _tag: "refused_own" });
  if (f.txs.length === 0) return heard(r, NO_MESSAGES, { _tag: "refused_empty" });
  if (f.parent === r.head) {
    // Same-height collision: LEFT WINS (R-A1). Left keeps its own frame and ignores the peer's; Right yields.
    if (r.pending !== undefined && r.side === "left") return heard(r, NO_MESSAGES, { _tag: "kept_own" });
    const after = applyAll(rules, r.state, f.author, f.txs);
    return after.ok
      ? accept(r, rules.hash(f), after.value)
      : heard(r, NO_MESSAGES, { _tag: "refused_invalid", fault: after.error });
  }
  // R-REACK: a repeat of the frame at my head is answered with the same ack, whatever else I hold.
  if (rules.hash(f) === r.head) return heard(r, [ack(r.head)], { _tag: "re_acked" });
  return heard(r, NO_MESSAGES, { _tag: "refused_not_next" });
};

const onAck = <Tx, S, F>(rules: Rules<Tx, S, F>, r: Replica<Tx, S, F>, hash: FrameHash): Heard<Tx, S, F> => {
  const pending = r.pending;
  if (pending === undefined || rules.hash(pending.frame) !== hash) {
    return heard(r, NO_MESSAGES, { _tag: "ack_ignored" });
  }
  const committed = { ...r, head: hash, state: pending.after, pending: undefined };
  return heard(committed, NO_MESSAGES, { _tag: "committed_own" });
};

/** One message from the peer. Whatever it is, the answer is a replica: nothing here can halt the Runtime (R-X1). */
export const receive = <Tx, S, F>(rules: Rules<Tx, S, F>, r: Replica<Tx, S, F>, m: Msg<Tx>): Heard<Tx, S, F> =>
  (m._tag === "frame" ? onFrame(rules, r, m.frame) : onAck(rules, r, m.hash));
