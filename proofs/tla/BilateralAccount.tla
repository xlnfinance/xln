------------------------------- MODULE BilateralAccount -------------------------------
(***************************************************************************
 * C3: TLA+/TLC model of the bilateral Account-frame consensus (narrow scope:
 * one account, two replicas L and R). Does NOT model the Runtime->Entity->
 * Account cascade. Parity sources encoded here:
 *
 *   TS   core/account/consensus/incoming/collision.ts
 *        core/account/consensus/incoming/preflight.ts   (GATE A / stale / chain)
 *        core/account/consensus/incoming/replay.ts      (duplicate re-ACK)
 *        core/account/consensus/incoming/ack-commit.ts  (proposer ACK commit)
 *        core/account/consensus/index.ts                (dispatch: ack first,
 *                                                         then bundled frame)
 *   Rust rscore/crates/engine/src/consensus/incoming/apply.rs
 *        (apply_incoming_frame_with_authority, apply_incoming_ack_with_authority)
 *        rscore/crates/engine/src/consensus/replica.rs
 *        (rollback_pending, commit_from_ack, commit_from_peer)
 *
 * KNOWN DIVERGENCE (proofs/readme.md): rollback-duplicate guard.
 *   TS   collision.ts:196  lastRollbackFrameHash === receivedFrame.stateHash
 *                         -> return undefined  == CONTINUE normal processing
 *                            (frame validated + committed, pending NOT rolled
 *                             back, ACK emitted)
 *   Rust apply.rs:652      -> rejected("ACCOUNT_PEER_FRAME_ROLLBACK_DUPLICATE")
 *                         == REJECT, no state change, no ACK
 *   CONSTANT TS_ROLLBACK_DUP selects the variant; both are checked.
 *
 * Reachability of that guard requires pending.height == frame.height AND
 * lastRollbackFrameHash == frame.hash. Since stateHash covers (height, prev,
 * byLeft, txs), the only frame matching the stored hash is an exact retransmit
 * of the previous rollback winner W at height h - which requires current to be
 * back at h-1, i.e. the W commit was lost while the rollback envelope
 * (lastRollbackFrameHash) persisted. That is the "post-rollback/pre-commit"
 * WAL-boundary window named in proofs/readme.md. It is modeled by the
 * DeliverPartial action (a crash between the rollback envelope persistence and
 * the peer-frame commit projection), gated on CrashEnabled. With
 * CrashEnabled = FALSE the rollback-duplicate branch is unreachable and TLC
 * must confirm that via the RbNotReached probe.
 *
 * Abstractions (all documented in proofs/tla/report.md):
 *   - Signatures/Hanko validity are environment-granted: every message in net
 *     is assumed well-signed and authenticated (no forgery actions).
 *   - stateHash is an injective function HashOf(side, height, txs, prev) of the
 *     frame content and its parent hash; matches the real preimage coverage
 *     (computeCanonicalAccountFrameHash covers height, prevFrameHash, byLeft,
 *     txs, deltas, stateRoot).
 *   - Propose flushes the entire mempool into one frame (ordering inside the
 *     mempool is irrelevant to every property checked here; rollback restore
 *     "to the front" is therefore set union).
 *   - Network: at-least-once, reordering, duplication. Fresh frame sends,
 *     copies and bundles are bounded by the frame message budget MaxMsgId; ACK
 *     emissions by a separate budget MaxAckId; Cap bounds in-flight redundant
 *     copies (Retransmit/Resend). Resend re-injects the ORIGINAL message
 *     record (tracked in fsent), so scheduled resends consume no budget.
 *   - Crash: CrashVolatile is crash+restore between actions - all tracked
 *     replica fields are durable in the real engines, and restore re-derives
 *     the pending proposal bit-for-bit, so it is a controlled stutter
 *     (RestoreIsNoop). DeliverPartial additionally models the WAL-boundary
 *     crash inside the rollback handler (envelope persisted, commit lost),
 *     which is the only crash with an observable effect here.
 *
 * TLC type-compatibility: sentinels are type-shaped (NOFRAME record, NONE_H
 * tuple, NOACK record) so equality never crosses value shapes.
 ***************************************************************************)

EXTENDS Naturals, FiniteSets

CONSTANTS
    \* @type: "string";
    TS_ROLLBACK_DUP,        \* "continue" (TS engine) | "reject" (Rust engine)
    \* @type: "Set";
    Tx,                     \* tx universe, |Tx| <= 4
    \* @type: "Nat";
    MaxHeight,              \* frame height bound, <= 3
    \* @type: "Nat";
    Cap,                    \* max in-flight redundant copies, <= 4
    \* @type: "Nat";
    MaxMsgId,               \* total frame/copy message budget per behavior
    \* @type: "Nat";
    MaxAckId,               \* total ACK-emission budget per behavior
    \* @type: "Bool";
    CrashEnabled            \* enable CrashVolatile + DeliverPartial

Side == {"L", "R"}
Peer(s) == IF s = "L" THEN "R" ELSE "L"
IsLeft(s) == s = "L"

\* Injective abstract frame hash: covers side, height, txs, parent hash.
HashOf(s, h, txs, prev) == << "h", s, h, txs, prev >>
\* Tuple-shaped so nested record equality never crosses value shapes (TLC).
Genesis == << "genesis" >>

\* Sentinels (type-shaped for TLC equality).
NOFRAME == [height |-> 0, byLeft |-> FALSE, txs |-> {}, prev |-> Genesis,
            hash |-> Genesis]
NONE_H == << "none" >>
NOACK == [h |-> 0, fh |-> NONE_H]

CurHeight(f) == f.height
CurHash(f) == IF f.height = 0 THEN Genesis ELSE f.hash

Frame(s, h, txs, prev) ==
    [ height  |-> h,
      byLeft  |-> IsLeft(s),
      txs     |-> txs,
      prev    |-> prev,
      hash    |-> HashOf(s, h, txs, prev) ]

(***************************************************************************
 * Frame handler (receiver side). Pure function of (side, receiver state,
 * frame) -> next receiver state + optional ACK emission + sticky probe.
 *   rbdup: TRUE exactly when the rollback-duplicate guard fires (collision
 *          AND lastRollbackFrameHash = frame.hash); reachability probe for
 *          the TS/Rust divergence.
 *   sendAck: NOACK or [h |-> height, fh |-> frameHash] of an ACK to emit.
 *   add: NOFRAME or the frame being installed into `current`/`committed`.
 ***************************************************************************)

NoopR(cur, pend, mem, r, lb, lo) ==
    [ cur |-> cur, pend |-> pend, mem |-> mem, rc |-> r, lrb |-> lb,
      loa |-> lo, sendAck |-> NOACK, add |-> NOFRAME, rbdup |-> FALSE ]

DoFrame(s, cur, pend, mem, r, lb, lo, F) ==
    LET h   == F.height
        fh  == F.hash
        ch  == CurHeight(cur)
        dup == cur.height # 0 /\ h = cur.height /\ fh = cur.hash
        collision == pend.height # 0 /\ pend.height = h
    IN
    \* GATE A (replay.ts buildDuplicateCommittedFrameAck / apply.rs Duplicate):
    \* exact retransmit of the currently committed frame -> re-ACK, no mutation.
    IF dup THEN
        [ cur |-> cur, pend |-> pend, mem |-> mem, rc |-> r, lrb |-> lb,
          loa |-> h, sendAck |-> [h |-> h, fh |-> fh], add |-> NOFRAME,
          rbdup |-> FALSE ]
    \* Stale ancestor frame: applied no-op, no ACK (TS stale_ignored / Rust Stale).
    ELSE IF h < ch THEN NoopR(cur, pend, mem, r, lb, lo)
    \* Equal height, different hash: parity reject (TS CHAIN_INVALID / Rust HEIGHT_GAP).
    ELSE IF cur.height # 0 /\ h = ch THEN NoopR(cur, pend, mem, r, lb, lo)
    \* Height gap: reject.
    ELSE IF h > ch + 1 THEN NoopR(cur, pend, mem, r, lb, lo)
    \* Broken chain (prevFrameHash mismatch): reject.
    ELSE IF F.prev # CurHash(cur) THEN NoopR(cur, pend, mem, r, lb, lo)
    \* byLeft must equal the proposer's (peer's) side: reject otherwise.
    ELSE IF F.byLeft # IsLeft(Peer(s)) THEN NoopR(cur, pend, mem, r, lb, lo)
    \* Collision, local side is LEFT: LEFT-wins ignore, no state change, no ACK.
    ELSE IF collision /\ IsLeft(s) THEN NoopR(cur, pend, mem, r, lb, lo)
    \* Collision on RIGHT and the frame is an exact retransmit of the previous
    \* rollback winner: THE DIVERGENCE. Variant selected by TS_ROLLBACK_DUP.
    ELSE IF collision /\ lb = fh /\ TS_ROLLBACK_DUP = "reject" THEN
        [ cur |-> cur, pend |-> pend, mem |-> mem, rc |-> r, lrb |-> lb,
          loa |-> lo, sendAck |-> NOACK, add |-> NOFRAME, rbdup |-> TRUE ]
    ELSE IF collision /\ lb = fh /\ TS_ROLLBACK_DUP = "continue" THEN
        \* TS path: return undefined -> preflight continues without rollback;
        \* frame validated + committed; pendingFrame is NOT touched by
        \* commitIncomingFrameOnRealState (stays in place, orphaned); ACK sent.
        [ cur |-> F, pend |-> pend, mem |-> mem, rc |-> r, lrb |-> lb,
          loa |-> h, sendAck |-> [h |-> h, fh |-> fh], add |-> F,
          rbdup |-> TRUE ]
    \* Fresh collision on RIGHT: rollback own pending to mempool front, accept
    \* the LEFT winner, commit it, ACK it (collision.ts applySameHeightIncoming
    \* FrameRollback + commitIncomingFrameOnRealState + buildAckResponse).
    ELSE IF collision THEN
        [ cur |-> F, pend |-> NOFRAME, mem |-> pend.txs \cup mem,
          rc |-> r + 1, lrb |-> fh, loa |-> h,
          sendAck |-> [h |-> h, fh |-> fh], add |-> F, rbdup |-> FALSE ]
    \* Plain accept (no pending, or pending orphaned at a lower height):
    \* commit + ACK; pending is NOT cleared by the receiver commit path.
    ELSE
        [ cur |-> F, pend |-> pend, mem |-> mem, rc |-> r, lrb |-> lb,
          loa |-> h, sendAck |-> [h |-> h, fh |-> fh], add |-> F,
          rbdup |-> FALSE ]

(***************************************************************************
 * ACK handler (proposer side). ack-commit.ts handlePendingFrameAck +
 * installPendingFrameCommit / apply.rs apply_incoming_ack_with_authority.
 * Commits the pending iff heights match AND the certificate hash matches.
 * NOTE: neither engine guards pending.height > current.height here; an
 * orphaned pending (height <= current.height) can still be installed by a
 * matching ACK. rollbackCount decrements; lastRollbackFrameHash drops only at
 * 0; lastOutboundFrameAck is dropped when older than the committed height.
 ***************************************************************************)

NoopA(cur, pend, r, lb, lo) ==
    [ cur |-> cur, pend |-> pend, rc |-> r, lrb |-> lb, lo |-> lo,
      add |-> NOFRAME ]

DoAck(cur, pend, r, lb, lo, h, fh) ==
    IF pend.height # 0 /\ pend.height = h /\ pend.hash = fh THEN
        LET nr == IF r > 0 THEN r - 1 ELSE 0 IN
        [ cur |-> pend, pend |-> NOFRAME, rc |-> nr,
          lrb |-> IF nr = 0 THEN NONE_H ELSE lb,
          lo |-> IF lo # 0 /\ lo < h THEN 0 ELSE lo,
          add |-> pend ]
    ELSE NoopA(cur, pend, r, lb, lo)

(***************************************************************************)

VARIABLES
    mempool,        \* per side: SUBSET Tx (persisted)
    pending,        \* per side: NOFRAME | Frame  (volatile: cleared on crash)
    current,        \* per side: NOFRAME | Frame  (persisted committed head)
    rc,             \* per side: rollbackCount  (persisted)
    lrb,            \* per side: NONE_H | hash (persisted lastRollbackFrameHash)
    loa,            \* per side: 0 | height    (persisted lastOutboundFrameAck)
    committed,      \* per side: history set of Frames ever installed as current
    acked,          \* per side: history set of <<h, fh>> ever ACKed
    admitted,       \* global: txs ever admitted to any mempool
    removed,        \* global: explicit tx removal set (no removal path here)
    net,            \* set of in-flight messages
    nid,            \* next fresh frame/copy message id (budget MaxMsgId)
    anid,           \* next fresh ACK message id (budget MaxAckId; separate so
                    \* that fair resend churn can never disable the ACK a
                    \* resolving delivery must emit)
    fsent,          \* per side: set of [fr, id] proposals ever sent; Resend
                    \* re-injects the ORIGINAL message record (same id), so
                    \* scheduled resends consume no budget and cannot starve
                    \* the peer side's resends
    rbdup           \* sticky probe: rollback-duplicate guard ever fired

vars == << mempool, pending, current, rc, lrb, loa, committed, acked,
           admitted, removed, net, nid, anid, fsent, rbdup >>

Init ==
    /\ mempool    = [s \in Side |-> {}]
    /\ pending    = [s \in Side |-> NOFRAME]
    /\ current    = [s \in Side |-> NOFRAME]
    /\ rc         = [s \in Side |-> 0]
    /\ lrb        = [s \in Side |-> NONE_H]
    /\ loa        = [s \in Side |-> 0]
    /\ committed  = [s \in Side |-> {}]
    /\ acked      = [s \in Side |-> {}]
    /\ admitted   = {}
    /\ removed    = {}
    /\ net        = {}
    /\ nid        = 0
    /\ anid       = 0
    /\ fsent      = [s \in Side |-> {}]
    /\ rbdup      = FALSE

(*************************** actions ***************************)

\* Environment admits a tx to one side's mempool (each tx admitted once).
Submit(s, t) ==
    /\ t \in Tx /\ t \notin admitted
    /\ mempool' = [mempool EXCEPT ![s] = @ \cup {t}]
    /\ admitted' = admitted \cup {t}
    /\ UNCHANGED << pending, current, rc, lrb, loa, committed, acked,
                    removed, net, nid, anid, fsent, rbdup >>

\* Flush the whole mempool into a pending frame at current+1 and send it.
Propose(s) ==
    /\ pending[s] = NOFRAME
    /\ mempool[s] # {}
    /\ current[s].height + 1 <= MaxHeight
    /\ LET h == current[s].height + 1
             F == Frame(s, h, mempool[s], CurHash(current[s]))
       IN  /\ pending' = [pending EXCEPT ![s] = F]
           /\ mempool' = [mempool EXCEPT ![s] = {}]
           /\ net' = net \cup { [id |-> nid, kind |-> "frame",
                                 from |-> s, to |-> Peer(s), fr |-> F] }
           /\ fsent' = [fsent EXCEPT ![s] = @ \cup {[fr |-> F, id |-> nid]}]
           /\ nid' = nid + 1
    /\ UNCHANGED << current, rc, lrb, loa, committed, acked, admitted,
                    removed, anid, rbdup >>

\* Scheduled resend of the un-ACKed own proposal (liveness assumption).
\* Idempotent: no copy while an identical proposal is already in flight (the
\* engine's outbox keeps the original delivery until ACKed). Re-injects the
\* ORIGINAL message record (same id), consuming no budget: fair resends by
\* one side can never exhaust the budget and starve the other side's resends.
Resend(s) ==
    /\ pending[s] # NOFRAME
    /\ Cardinality(net) < Cap
    /\ \E r \in fsent[s] : r.fr = pending[s]
    /\ ~ \E f2 \in net :
           f2.kind = "frame" /\ f2.from = s /\ f2.to = Peer(s)
           /\ f2.fr = pending[s]
    /\ LET r == CHOOSE x \in fsent[s] : x.fr = pending[s] IN
       net' = net \cup { [id |-> r.id, kind |-> "frame",
                          from |-> s, to |-> Peer(s), fr |-> pending[s]] }
    /\ UNCHANGED << mempool, pending, current, rc, lrb, loa, committed,
                    acked, admitted, removed, nid, anid, fsent, rbdup >>

\* Network duplication of any in-flight message (at-least-once with dups).
\* Idempotent: at most one in-flight copy per payload.
Retransmit(m) ==
    /\ m \in net
    /\ Cardinality(net) < Cap
    /\ nid < MaxMsgId
    /\ ~ \E c \in net :
           c # m /\ c.kind = m.kind /\ c.from = m.from /\ c.to = m.to
           /\ (m.kind = "frame" => c.fr = m.fr)
           /\ (m.kind # "frame" => c.ah = m.ah /\ c.ahash = m.ahash
                             /\ (m.kind = "fa" => c.fr = m.fr))
    /\ net' = net \cup { [m EXCEPT !.id = nid] }
    /\ nid' = nid + 1
    /\ UNCHANGED << mempool, pending, current, rc, lrb, loa, committed,
                    acked, admitted, removed, anid, fsent, rbdup >>

\* Merge an in-flight ACK and frame from the same sender into one frame_ack
\* bundle (models the responder flushing ACK + proposal together).
Bundle(a, f) ==
    /\ a \in net /\ f \in net /\ a # f
    /\ a.kind = "ack" /\ f.kind = "frame"
    /\ a.from = f.from /\ a.to = f.to
    /\ nid < MaxMsgId
    /\ net' = (net \ {a, f}) \cup
              { [id |-> nid, kind |-> "fa", from |-> a.from, to |-> a.to,
                  ah |-> a.ah, ahash |-> a.ahash, fr |-> f.fr] }
    /\ nid' = nid + 1
    /\ UNCHANGED << mempool, pending, current, rc, lrb, loa, committed,
                    acked, admitted, removed, anid, fsent, rbdup >>

\* Delivery of any message. Bundles ("fa") process the ACK part FIRST, then
\* the frame part - the dispatch order of index.ts (handlePendingFrameAck
\* before handleIncomingAccountFrame). The ACK commit therefore survives even
\* when the bundled frame is subsequently rejected (AckDurability ordering).
Deliver(m) ==
    /\ m \in net
    /\ LET s == m.to
             postAck == IF m.kind \in {"ack", "fa"}
                        THEN DoAck(current[s], pending[s], rc[s], lrb[s],
                                   loa[s], m.ah, m.ahash)
                        ELSE NoopA(current[s], pending[s], rc[s], lrb[s], loa[s])
             postFrame == IF m.kind \in {"frame", "fa"}
                          THEN DoFrame(s, postAck.cur, postAck.pend, mempool[s],
                                       postAck.rc, postAck.lrb, postAck.lo, m.fr)
                          ELSE NoopR(postAck.cur, postAck.pend, mempool[s],
                                     postAck.rc, postAck.lrb, postAck.lo)
             ackMsg == IF postFrame.sendAck.h = 0 THEN {}
                       ELSE IF \E a2 \in net :
                                  a2.kind = "ack" /\ a2.from = s
                                  /\ a2.ah = postFrame.sendAck.h
                                  /\ a2.ahash = postFrame.sendAck.fh
                            THEN {}   \* lastOutboundFrameAck response cache:
                            \* reuse the in-flight identical ACK (idempotent)
                       ELSE { [id |-> MaxMsgId + 1 + anid, kind |-> "ack", from |-> s,
                               to |-> Peer(s), ah |-> postFrame.sendAck.h,
                               ahash |-> postFrame.sendAck.fh] }
       IN  /\ (postFrame.sendAck.h = 0 \/ anid < MaxAckId)
           /\ net' = (net \ {m}) \cup ackMsg
           /\ anid' = IF postFrame.sendAck.h = 0 THEN anid ELSE anid + 1
           /\ nid' = nid
           /\ current' = [current EXCEPT ![s] = postFrame.cur]
           /\ pending' = [pending EXCEPT ![s] = postFrame.pend]
           /\ mempool' = [mempool EXCEPT ![s] = postFrame.mem]
           /\ rc'      = [rc EXCEPT ![s] = postFrame.rc]
           /\ lrb'     = [lrb EXCEPT ![s] = postFrame.lrb]
           /\ loa'     = [loa EXCEPT ![s] = postFrame.loa]
           /\ committed' = [committed EXCEPT ![s] =
                              @ \cup (IF postAck.add = NOFRAME THEN {} ELSE {postAck.add})
                                     \cup (IF postFrame.add = NOFRAME THEN {} ELSE {postFrame.add})]
           /\ acked' = [acked EXCEPT ![s] =
                          IF postFrame.sendAck.h = 0 THEN @
                          ELSE @ \cup {<< postFrame.sendAck.h,
                                          postFrame.sendAck.fh >>}]
           /\ rbdup' = (rbdup \/ postFrame.rbdup)
    /\ UNCHANGED << admitted, removed, fsent >>

\* WAL-boundary crash inside the RIGHT rollback handler: the rollback
\* envelope persisted (mempool restored, pending cleared, rollbackCount++,
\* lastRollbackFrameHash set) but the winning frame's commit and the ACK were
\* lost. This is the "post-rollback/pre-commit" window of proofs/readme.md;
\* it is the only reachable opener of the rollback-duplicate guard.
DeliverPartial(m) ==
    /\ CrashEnabled
    /\ m \in net /\ m.kind = "frame"
    /\ LET s == m.to
             ch == current[s].height
       IN  /\ s = "R"
           /\ m.fr.height = ch + 1
           /\ m.fr.prev = CurHash(current[s])
           /\ m.fr.byLeft = IsLeft(Peer(s))
           /\ pending[s].height # 0
           /\ pending[s].height = m.fr.height
           /\ lrb[s] # m.fr.hash
       /\ net' = net \ {m}
       /\ pending' = [pending EXCEPT !["R"] = NOFRAME]
       /\ mempool' = [mempool EXCEPT !["R"] = @ \cup pending["R"].txs]
       /\ rc' = [rc EXCEPT !["R"] = @ + 1]
       /\ lrb' = [lrb EXCEPT !["R"] = m.fr.hash]
    /\ UNCHANGED << current, loa, committed, acked, admitted, removed, nid,
                    anid, fsent, rbdup >>

\* Crash + restore between actions. Every replica field this model tracks is
\* durable in the real engines (core/storage/schema/account-field-tags.ts:
\* pendingFrame tag 16, rollbackCount 23, lastRollbackFrameHash 24; the Rust
\* persisted-fields list in replica.rs), and restore RE-DERIVES the pending
\* proposal deterministically from the persisted mempool - same height, same
\* parent, same txs, therefore the same stateHash (RestoreIsNoop). The action
\* is kept explicit as the replay: it reproduces pending bit-for-bit, so it is
\* a controlled stutter (no new states), matching "restore not changing
\* currentFrame/mempool semantics". Dropping the pending instead (treating it
\* as volatile) lets the peer's competing same-height frame be accepted after
\* restore and violates Agreement IDENTICALLY in both engine variants - an
\* artifact of that stronger fault model, not of either implementation; the
\* real engines persist pendingFrame, so that fault is out of model here.
\* The only crash with an observable effect is the WAL-boundary DeliverPartial.
CrashVolatile(s) ==
    /\ CrashEnabled
    /\ pending[s] # NOFRAME
    /\ pending' = [pending EXCEPT ![s] =
                       Frame(s, pending[s].height, pending[s].txs,
                             pending[s].prev)]
    /\ UNCHANGED << mempool, current, rc, lrb, loa, committed, acked,
                    admitted, removed, net, nid, anid, fsent, rbdup >>

Next ==
    \/ \E s \in Side : \/ Propose(s)
                       \/ Resend(s)
                       \/ CrashVolatile(s)
    \/ \E m \in net  : \/ Deliver(m)
                       \/ DeliverPartial(m)
                       \/ Retransmit(m)
    \/ \E a, f \in net : Bundle(a, f)
    \/ \E s \in Side, t \in Tx : Submit(s, t)

Spec == Init /\ [][Next]_vars

\* Message budgets (frame/copy ids 0..MaxMsgId, ACK ids above): bound
\* behaviors via the .cfg state constraint.
StateConstraint == nid =< MaxMsgId /\ anid =< MaxAckId

(*************************** properties ***************************)

PendTxs(s) == IF pending[s] = NOFRAME THEN {} ELSE pending[s].txs
AllCommittedTxs == UNION {f.txs : f \in (committed["L"] \cup committed["R"])}

\* Type/bound sanity. (The total message budget nid =< MaxMsgId is enforced
\* as the .cfg state constraint StateConstraint, which prunes beyond-budget
\* states instead of reporting them.)
TypeOK ==
    /\ \A s \in Side :
        /\ mempool[s] \subseteq Tx
        /\ rc[s] >= 0
        /\ loa[s] >= 0
        /\ \A f \in committed[s] : f.height >= 1 /\ f.height =< MaxHeight

\* SAFETY 1: no two committed frames at one height with different stateHash on
\* either side (checked over the full commit history, so a regression that
\* re-installs a different hash at an already-committed height is caught), and
\* both sides' currentFrame agree whenever they sit at the same height.
Agreement ==
    /\ \A s \in Side :
        \A f1, f2 \in committed[s] :
            f1.height = f2.height => f1.hash = f2.hash
    /\ (current["L"].height # 0 /\ current["R"].height # 0 /\
        current["L"].height = current["R"].height) =>
        current["L"].hash = current["R"].hash

\* SAFETY 2: every ACK ever emitted by s references a frame that was committed
\* by s at emission time and remains in the (monotone) commit history; every
\* in-flight ACK likewise. Combined with the ACK-before-frame bundle order in
\* Deliver this is the model form of "a valid committed ACK stays committed
\* even when the bundled frame is rejected".
AckDurability ==
    /\ \A s \in Side :
        \A a \in acked[s] :
            \E f \in committed[s] : f.height = a[1] /\ f.hash = a[2]
    /\ \A m \in net :
        (m.kind = "ack" \/ m.kind = "fa") =>
            \E f \in committed[m.from] : f.height = m.ah /\ f.hash = m.ahash

\* SAFETY 3: every admitted tx is accounted for at every state: in a committed
\* frame, in some mempool, in some pending frame, or explicitly removed.
NoLostTx == admitted \subseteq (AllCommittedTxs \cup mempool["L"] \cup
    mempool["R"] \cup PendTxs("L") \cup PendTxs("R") \cup removed)

\* SAFETY 4 (probe): a pending frame is only valid while it extends current;
\* a pending at height <= current.height is an orphan created by the TS
\* "continue" path committing a same-height peer frame without rollback.
OrphanPending ==
    \A s \in Side :
        pending[s] # NOFRAME =>
            pending[s].height = current[s].height + 1

\* SAFETY 5 (probe, expected to VIOLATE when the window is modeled): TRUE
\* until the rollback-duplicate guard fires at least once. A violation is not
\* a defect - it is the reachability proof (TLC prints the witness trace).
RbNotReached == rbdup = FALSE

\* Restore determinism: every pending frame and every in-flight frame hashes
\* to exactly HashOf of its content - replaying the same (side, height, txs,
\* parent) reproduces the same frame hash, so restore/re-proposal cannot
\* invent a different state root at the same point (RestoreIsNoop content;
\* the crash actions leaving durable state untouched is structural).
RestoreIsNoop ==
    /\ \A s \in Side :
        pending[s] # NOFRAME =>
            pending[s].hash = HashOf(s, pending[s].height, pending[s].txs,
                                     pending[s].prev)
    /\ \A m \in net :
        (m.kind = "frame" \/ m.kind = "fa") =>
            m.fr.hash = HashOf(m.from, m.fr.height, m.fr.txs, m.fr.prev)

(*************************** liveness ***************************)

\* Per-instance delivery: once a message with id i is in net and stays
\* deliverable, it is eventually delivered (at-least-once + fair transport).
DeliverById(i) == \E m \in net : m.id = i /\ Deliver(m)

\* Weak fairness assumptions (the "explicit weak fairness of delivery +
\* scheduled resend" the property is stated under):
\*  - every in-flight message is eventually delivered, per instance (ids are
\*    unique per created message);
\*  - each side's scheduled resend of its un-ACKed proposal stays active.
\* Per-instance fairness is required: WF of the existential disjunction alone
\* is satisfied by one instance cycling forever while another is starved.
\* Crashes and partial-WAL faults get NO fairness: liveness must not depend
\* on a fault firing.
SpecLive == Spec
    /\ \A i \in 0..(MaxMsgId + MaxAckId + 1) : WF_vars(DeliverById(i))
    /\ \A s \in Side : WF_vars(Resend(s))

\* LIVENESS: under the fairness assumptions above, both sides cannot keep
\* same-height competing pendings forever - every collision eventually
\* resolves (one pending is committed or discarded).
CollisionTermination ==
    []( (pending["L"] # NOFRAME /\ pending["R"] # NOFRAME /\
         pending["L"].height = pending["R"].height)
        => <>( pending["L"] = NOFRAME \/ pending["R"] = NOFRAME ) )

=============================================================================
