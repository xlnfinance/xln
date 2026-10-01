// The bilateral round of one Account (spec: Arrival account/frames.scm, Quint account.qnt): a replica proposes a frame
// of its mempool on top of its head, the peer commits it and answers with an ack, and the proposer commits on the ack.
// Every function takes a replica and returns a replica; none throws and none halts anything: a message that is not
// the next one, or that does not apply, is refused and changes nothing (R-X1). What a tx is, how it applies and how a
// frame is named come in as `Rules`, so the same round runs on the Account's txs and on the spec page's abstract ones.
import { foldResult, map, mapErr, type Result } from "../../kernel/core/result.ts";
import { match, type Brand, type Tagged } from "../../kernel/core/tagged.ts";
import { other, type Side } from "../model.ts";

/** The name of a frame: equal frames have equal hashes, so equal heads mean equal histories. */
export type FrameHash = Brand<string, "FrameHash">;

/**
 * A frame names its parent by hash (R-PARENT): it is the next frame only on a replica whose head is that parent. It
 * names its author too, because a tx means what its author's side says: the same bytes written by the other side are
 * another frame, and a frame handed back to its own author is not the peer's (Quint `acceptable`: `f.author != self`).
 * `attempt` counts the refusals its proposer has handled on this head (R-FRAME-REFUSAL): a retry of a refused frame is
 * a new frame, so the receiver can judge it afresh and still never commit one it refused.
 */
export type Frame<Tx> = Readonly<{ author: Side; parent: FrameHash; attempt: number; txs: readonly Tx[] }>;

/** A proposer that has had MAX_ATTEMPTS frames refused on one head stops retrying: that peer is not catching up. */
export const MAX_ATTEMPTS = 8;

/** The fault a receiver names when a frame's attempt is below what it has already refused on this head. */
export const STALE_ATTEMPT = "stale_attempt";

/**
 * `refusal` is R-FRAME-REFUSAL: the answer to a frame the receiver cannot apply. It names the frame, the index of the
 * first tx that does not apply and the tag of the fault, so the proposer can take the frame back and either retry the
 * tx later or drop it, instead of waiting. `mark` is the receiver's memory for this head, the highest attempt it has
 * refused: the proposer's next attempt is above it, so a proposer whose count is behind (a restart) catches up in one
 * round trip.
 */
type Refusal = Readonly<{ hash: FrameHash; index: number; fault: string; mark: number }>;

export type Msg<Tx> =
  | Tagged<"frame", { frame: Frame<Tx> }>
  | Tagged<"ack", { hash: FrameHash }>
  | Tagged<"refusal", Refusal>;

/**
 * What a frame is made of. `apply` is the author's tx on the judging replica's state, by that replica's view. `tag` is
 * what a refusal says of a fault, and `retryable` says whether a fault with that tag can pass with the peer's view of
 * the chain (a tx the peer finds too early or too far ahead), so the tx is tried again, and not for good.
 */
export type Rules<Tx, S, F> = Readonly<{
  apply: (state: S, author: Side, tx: Tx) => Result<S, F>;
  hash: (frame: Frame<Tx>) => FrameHash;
  tag: (fault: F) => string;
  retryable: (tag: string) => boolean;
}>;

/** The peer refused the frame this tx was in and named it (R-FRAME-REFUSAL); `fault` is the tag the peer gave. */
export type PeerRefused = Tagged<"peer_refused", { fault: string }>;

/** A tx that stopped applying, with the refusal its owner is told (R-NOTICE): it is never dropped silently. */
export type Refused<Tx, F> = Readonly<{ tx: Tx; fault: F | PeerRefused }>;

/**
 * The highest attempt of the peer's that this replica refused on its current head, and why. A frame at or below it is
 * refused without a look: what was refused stays refused, whatever the view of J does later, and the memory is one row.
 */
type Declined<F> = Readonly<{ attempt: number; index: number; fault: F }>;

type Proposed<Tx, S> = Readonly<{ frame: Frame<Tx>; after: S }>;

/** One side of the Account: its committed head and the state that head made, and the txs it has not committed yet. */
export type Replica<Tx, S, F> = Readonly<{
  side: Side;
  head: FrameHash;
  state: S;
  mempool: readonly Tx[];
  pending: Proposed<Tx, S> | undefined;
  refused: readonly Refused<Tx, F>[];
  attempt: number;
  declined: Declined<F> | undefined;
}>;

export const replica = <Tx, S, F>(side: Side, head: FrameHash, state: S): Replica<Tx, S, F> =>
  ({ side, head, state, mempool: [], pending: undefined, refused: [], attempt: 0, declined: undefined });

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
  | Tagged<"refused_attempt">
  | Tagged<"refused_stale">
  | Tagged<"committed_own">
  | Tagged<"ack_ignored">
  | Tagged<"rolled_back">
  | Tagged<"refusal_ignored">;

export type Heard<Tx, S, F> = Out<Tx, S, F> & Readonly<{ outcome: Outcome<F> }>;

const ack = <Tx>(hash: FrameHash): Msg<Tx> => ({ _tag: "ack", hash });
const refusal = <Tx>(r: Refusal): Msg<Tx> => ({ _tag: "refusal", ...r });
const frameMsg = <Tx>(frame: Frame<Tx>): Msg<Tx> => ({ _tag: "frame", frame });

/** The txs one after another on a state; a tx that does not apply names its index and its fault. */
const applyAll = <Tx, S, F>(
  rules: Rules<Tx, S, F>, state: S, author: Side, txs: readonly Tx[],
): Result<S, Readonly<{ index: number; fault: F }>> =>
  foldResult(txs.map((tx, index) => ({ tx, index })), state, (s, { tx, index }) =>
    mapErr(rules.apply(s, author, tx), (fault) => ({ index, fault })));

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
  const frame = { author: r.side, parent: r.head, attempt: r.attempt, txs: split.valid };
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
  const committed = { ...base, head: hash, state: after, attempt: 0, declined: undefined };
  return heard(committed, [ack(hash)], r.pending === undefined ? { _tag: "accepted" } : { _tag: "accepted_over_own" });
};

const refuseWith = <Tx, S, F>(
  rules: Rules<Tx, S, F>, r: Replica<Tx, S, F>, name: FrameHash, d: Declined<F>,
): Heard<Tx, S, F> =>
  heard(r, [refusal({ hash: name, index: d.index, fault: rules.tag(d.fault), mark: d.attempt })],
    { _tag: "refused_invalid", fault: d.fault });

/**
 * R-FRAME-REFUSAL: a frame that does not apply is answered with a refusal naming it, its first tx at fault and the
 * fault, and its attempt is remembered for as long as this head lasts. The memory is what makes the refusal safe: the
 * proposer takes the frame back on the refusal, so a replica that refused a frame must never commit it later, however
 * its view of J moves. The proposer's next frame on this head has a higher attempt, so it is judged afresh.
 */
const decline = <Tx, S, F>(
  rules: Rules<Tx, S, F>, r: Replica<Tx, S, F>, name: FrameHash, f: Frame<Tx>,
  failure: Readonly<{ index: number; fault: F }>,
): Heard<Tx, S, F> => {
  const d: Declined<F> = { attempt: f.attempt, ...failure };
  return refuseWith(rules, { ...r, declined: d }, name, d);
};

/**
 * A peer's attempt is a whole number it can count without loss, whatever its decoder let through. MAX_ATTEMPTS bounds
 * the proposer's retries, not the receiver: the proposer keeps counting past it, and a frame at any such number is
 * judged (the memory is one row whatever the number).
 */
const wellNumbered = (attempt: number): boolean => Number.isSafeInteger(attempt) && attempt >= 0;

const onFrame = <Tx, S, F>(rules: Rules<Tx, S, F>, r: Replica<Tx, S, F>, f: Frame<Tx>): Heard<Tx, S, F> => {
  if (f.author === r.side) return heard(r, NO_MESSAGES, { _tag: "refused_own" });
  if (f.txs.length === 0) return heard(r, NO_MESSAGES, { _tag: "refused_empty" });
  if (!wellNumbered(f.attempt)) return heard(r, NO_MESSAGES, { _tag: "refused_attempt" });
  const name = rules.hash(f);
  if (f.parent !== r.head) {
    // R-REACK: a repeat of the frame at my head is answered with the same ack, whatever else I hold.
    return name === r.head
      ? heard(r, [ack(r.head)], { _tag: "re_acked" })
      : heard(r, NO_MESSAGES, { _tag: "refused_not_next" });
  }
  const declined = r.declined;
  if (declined !== undefined && f.attempt <= declined.attempt) {
    return f.attempt === declined.attempt
      ? refuseWith(rules, r, name, declined)
      : heard(r, [refusal({ hash: name, index: 0, fault: STALE_ATTEMPT, mark: declined.attempt })],
        { _tag: "refused_stale" });
  }
  // Same-height collision: LEFT WINS (R-A1). Left keeps its own frame and ignores the peer's; Right yields.
  if (r.pending !== undefined && r.side === "left") return heard(r, NO_MESSAGES, { _tag: "kept_own" });
  const after = applyAll(rules, r.state, f.author, f.txs);
  return after.ok ? accept(r, name, after.value) : decline(rules, r, name, f, after.error);
};

const onAck = <Tx, S, F>(rules: Rules<Tx, S, F>, r: Replica<Tx, S, F>, hash: FrameHash): Heard<Tx, S, F> => {
  const pending = r.pending;
  if (pending === undefined || rules.hash(pending.frame) !== hash) {
    return heard(r, NO_MESSAGES, { _tag: "ack_ignored" });
  }
  const committed = { ...r, head: hash, state: pending.after, pending: undefined, attempt: 0, declined: undefined };
  return heard(committed, NO_MESSAGES, { _tag: "committed_own" });
};

/**
 * R-FRAME-REFUSAL, the proposer's side: the refusal names my pending, unacked frame, so I take it back. A fault that
 * can pass with the peer's view of the chain (`retryable`) sends every tx back ahead of the mempool, to be proposed
 * again at the next attempt; any other fault drops the tx the peer named, with notice (R-NOTICE; it releases its payer,
 * R-REFUSED-RELEASES-PAYER), and queues the rest. After MAX_ATTEMPTS refusals on one head nothing is retried, except
 * a stale attempt, which judged nothing and so costs no tx. The next attempt is above the receiver's mark. A refusal
 * for any other frame is ignored: one for a frame I have already committed (the peer answers a committed frame with the
 * ack, never a refusal), a stale or repeated one, or one whose index is not a tx of the frame.
 */
const onRefusal = <Tx, S, F>(
  rules: Rules<Tx, S, F>, r: Replica<Tx, S, F>, { hash, index, fault, mark }: Refusal,
): Heard<Tx, S, F> => {
  const pending = r.pending;
  const named = Number.isInteger(index) ? pending?.frame.txs[index] : undefined;
  const counted = Number.isSafeInteger(mark) && mark >= 0 && mark < Number.MAX_SAFE_INTEGER;
  if (pending === undefined || named === undefined || !counted || rules.hash(pending.frame) !== hash) {
    return heard(r, NO_MESSAGES, { _tag: "refusal_ignored" });
  }
  const retry = fault === STALE_ATTEMPT || (rules.retryable(fault) && r.attempt < MAX_ATTEMPTS);
  const kept = retry ? pending.frame.txs : pending.frame.txs.filter((_, i) => i !== index);
  const refused = retry ? r.refused : [...r.refused, { tx: named, fault: { _tag: "peer_refused", fault } as const }];
  const attempt = Math.max(r.attempt, mark) + 1;
  const rolled = { ...r, mempool: [...kept, ...r.mempool], pending: undefined, refused, attempt };
  return heard(rolled, NO_MESSAGES, { _tag: "rolled_back" });
};

/** One message from the peer. Whatever it is, the answer is a replica: nothing here can halt the Runtime (R-X1). */
export const receive = <Tx, S, F>(rules: Rules<Tx, S, F>, r: Replica<Tx, S, F>, m: Msg<Tx>): Heard<Tx, S, F> =>
  match(m, {
    frame: (x) => onFrame(rules, r, x.frame),
    ack: (x) => onAck(rules, r, x.hash),
    refusal: (x) => onRefusal(rules, r, x),
  });
