// The frame round on the Account's own txs: a tx applies by `applyTx`, and a frame has two names. Its content name is
// the keccak of an RLP of its author, parent, attempt and txs: it needs no state, so a refusal can name a frame that
// does not apply. The head it gives once committed is the digest its signers sign (proof/signing.ts,
// R-FRAME-HASH-SIGNED): the parent of the next frame and the hash an ack carries. The wire format is the transport's
// (T0). Numbers are spelled in decimal text so that naming a frame is total, whatever a peer wrote into it.
import { keccak256, bytesToHex, utf8 } from "../../kernel/encoding/bytes.ts";
import { err, flatMap, map, mapErr, ok, type Result } from "../../kernel/core/result.ts";
import { rlp, type Rlp } from "../../kernel/encoding/rlp.ts";
import { match } from "../../kernel/core/tagged.ts";
import type { AccountFault, AccountState, Hold, Side, TokenId } from "../model.ts";
import { emptyAccount } from "../state.ts";
import { unsignable } from "../proof/body.ts";
import { frameDigest, type SigningContext, type SigningFault } from "../proof/signing.ts";
import { applyTx, type AccountTx, type Judge } from "../tx.ts";
import { replica, type Frame, type FrameHash, type Replica, type Rules } from "./frame.ts";

export type AccountReplica = Replica<AccountTx, AccountState, AccountFault>;
export type AccountRules = Rules<AccountTx, AccountState, AccountFault>;

/** The head of a replica that has committed nothing. */
export const GENESIS = `0x${"00".repeat(32)}` as FrameHash;

const text = (x: bigint | string): Rlp => utf8(x.toString());

const holdItem = (h: Hold): Rlp => [text(h.id), text(h.payer), text(h.amount), text(h.hashlock), text(h.deadline)];

const txItem = (tx: AccountTx): Rlp =>
  match(tx, {
    pay: (t) => [text(t._tag), text(t.token), text(t.amount)],
    set_credit: (t) => [text(t._tag), text(t.token), text(t.limit)],
    lock: (t) => [text(t._tag), text(t.token), holdItem(t.hold)],
    resolve: (t) => [text(t._tag), text(t.token), text(t.id), t.secret],
    cancel: (t) => [text(t._tag), text(t.token), text(t.id)],
    expire: (t) => [text(t._tag), text(t.token), text(t.id)],
  });

/** What a frame says, not what it signs: a refusal and a repeat name a frame by it (R-FRAME-REFUSAL, R-REACK). */
export const frameName = (f: Frame<AccountTx>): FrameHash =>
  bytesToHex(keccak256(rlp([
    utf8(f.author), utf8(f.parent), text(BigInt(f.attempt)), text(BigInt(f.slot)), f.txs.map(txItem),
  ]))) as FrameHash;

/** A lock this side signed and the peer may still hold live: the proof it is in is signed and unsuperseded. */
export type LiveLock = Readonly<{ token: TokenId; hold: Hold; slot: number }>;

/**
 * R-SIGNED-IS-LIVE: the locks in proofs this side has signed that no committed frame above them has superseded. A
 * refusal or a yield does not end them: the peer holds the signature and may start a dispute with it, so what a lock
 * held upstream (a payer's funds) may be released on is a higher-slot frame without it committing, or the lock's own
 * deadline plus the reserve having passed, never the refusal. The Runtime reads this to hold and release (cut thread).
 */
export const liveLocks = (r: AccountReplica): readonly LiveLock[] =>
  r.unsuperseded.flatMap(({ slot, txs }) =>
    txs.flatMap((tx) => (tx._tag === "lock" ? [{ token: tx.token, hold: tx.hold, slot }] : [])));

/**
 * The faults that pass with the peer's view of the chain: it finds an expiry not yet due or a lock's deadline too far
 * ahead, because its view lags mine. Every other fault stays (a view that is ahead only makes a late tx later).
 */
const RETRYABLE: readonly string[] = ["not_expired", "deadline_too_far"];

const unsigned = (fault: SigningFault): AccountFault => ({ _tag: "unsignable", fault: fault._tag });

/** A tx that would leave a state with no proof body is refused, so two replicas never hold one (R-PROOF-BODY). */
const signable = (signing: SigningContext, after: AccountState): Result<AccountState, AccountFault> => {
  const bad = unsignable(signing.terms, after);
  return bad === undefined ? ok(after) : err(unsigned(bad));
};

/**
 * The rules a replica judges by: its own view of the J chain is in `judge` (R-HTLC-CLOCK), and where and under which
 * terms its frames are signed is in `signing`. A frame's head is its signed digest (R-FRAME-HASH-SIGNED).
 */
export const accountRules = (judge: Judge, signing: SigningContext): AccountRules => ({
  apply: (s, author, tx) => flatMap(applyTx(s, judge, author, tx), (after) => signable(signing, after)),
  name: frameName,
  seal: (f, after) =>
    map(mapErr(frameDigest(signing, f.slot, f.author, after), unsigned), (digest) => digest as FrameHash),
  tag: (fault) => fault._tag,
  retryable: (tag) => RETRYABLE.includes(tag),
});

export const emptyReplica = (side: Side): AccountReplica => replica(side, GENESIS, emptyAccount);
