// The frame round on the Account's own txs: a tx applies by `applyTx`, and a frame is named by the keccak of an RLP of
// its parent and its txs. The name is the replica's own handle on a frame (head, parent, ack), not the signed bytes:
// the body both sides sign is the proof (A4) and the wire format is the transport's (T0). Numbers are spelled in
// decimal text so that naming a frame is total, whatever a peer wrote into it.
import { keccak256, bytesToHex, utf8 } from "../../kernel/encoding/bytes.ts";
import { rlp, type Rlp } from "../../kernel/encoding/rlp.ts";
import { match } from "../../kernel/core/tagged.ts";
import type { AccountFault, AccountState, Hold, Side } from "../model.ts";
import { emptyAccount } from "../state.ts";
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

/** A stand-in, not the signed bytes: A4 and T0 owe the real hash (R-FRAME-HASH-SIGNED). */
export const provisionalFrameHash = (f: Frame<AccountTx>): FrameHash =>
  bytesToHex(keccak256(rlp([utf8(f.parent), f.txs.map(txItem)]))) as FrameHash;

/** The rules a replica judges by: its own view of the J chain is in `judge` (R-HTLC-CLOCK). */
export const accountRules = (judge: Judge): AccountRules =>
  ({ apply: (s, author, tx) => applyTx(s, judge, author, tx), hash: provisionalFrameHash });

export const emptyReplica = (side: Side): AccountReplica => replica(side, GENESIS, emptyAccount);
