# Unclear points and the choices made

Format: **id**, the point, the options, **choice**, the source it rests on. An entry is closed when the coordinator
decides. Until then the spec follows the choice written here.

## Account layer (`account.qnt`)

**A1. Two frames at one height (collision).**
Options: (a) Left wins, Right rolls back and takes Left's; (b) both give way and retry with a back-off; (c) the lower
frame hash wins.
Choice: (a). Left keeps its frame and ignores Right's, Right discards its own frame, puts its txs back at the front
of its mempool and holds Left's frame. Source: R-A1, `Types.sol` equal-nonce rule (Left wins), `xln.ts:10644`.
Consequence stated: Right has already signed a proof at that nonce for its own frame, so one signer holds two
signatures at one nonce. They are different branches (`authorIsLeft` is in the signed hash), and the contract's
tie-break picks Left's. P4b is therefore per (signer, nonce, branch), not per (signer, nonce).

**A2. Liveness under message loss (Q-A2).**
Options: (a) the proposer resends its frame, the receiver answers a repeat idempotently; (b) each proposal carries the
previous ack so nothing is ever lost; (c) time-based retransmission in the spec.
Choice: (a). `resend` is enabled while a frame is in flight; a receiver that already committed that frame answers
with the same ack. When to resend is Runtime policy, not protocol. Source: `design/account-model.md` P4/P5, no og
retransmission exists (`collision.ts:117`).

**A3. Rejection of a peer frame (Q-A3).**
Options: (a) refuse silently and count it; (b) send a reject message; (c) treat as dispute evidence and freeze.
Choice: (a) for this layer. A frame is all-or-nothing: the first tx that does not apply refuses the whole frame, the
receiver's state is untouched, and no message is sent. Two honest sides never refuse each other's frames in this
model, so the case is only exercised by stale and duplicate frames. The Byzantine-peer case (a frame whose claimed
state does not replay) is deferred to the dispute layer, where (c) applies. Source: R-X1, Q-E2, Q-A3.

**A4. Frame shape (Q-A4).**
Options: (a) propose-then-ack as separate messages; (b) each proposal carries the counter-signature of the last.
Choice: (a). Piggybacking an ack on the next proposal (og's `ack_frame`) is a transport optimisation with no state
effect, so it is not modelled. Source: `xln.ts:9556`.

**A5. Who signs when.**
Choice: the proposer signs the frame and the resulting dispute proof when it proposes; the receiver signs both when it
acks. A side commits a frame when the counterparty's signature over it exists. So an un-acked proposal already
gives the counterparty a signed proof (design/account-model.md section 2, "signing a proposal is consent to it").

**A6. No parent hash in the frame.**
Options: (a) a frame names its parent by hash; (b) the receiver replays the txs on its own tip and compares the
claimed state.
Choice: (b). A frame built on a different tip either replays to a different state (refused) or to the same state
(harmless). The wire still needs a hash for framing; that is an encoding detail. Source: R-E1 discussion.

**A7. Same-view admission (Q-E1).**
Choice: yes, one view. A local tx is admitted against the state the side is planning (committed state, or the frame in
flight / held) plus everything already queued, so a tx that could never apply never enters the mempool. At
proposal time the proposer still drops any tx that no longer applies (the peer's frame may have changed the state).
Source: Q-E1 recommendation, B-X3.

**A8. Clocks and deadlines (Q-X2, Q-P1).**
Choice: each side has its own clock; the clocks never differ by more than `DRIFT` (an assumption, not a rule the
protocol can enforce). A frame carries the proposer's timestamp; the receiver refuses it unless it is within
`TOLERANCE` of its own clock and not before the previous frame. Every deadline rule reads the frame timestamp, never
a wall clock: a secret is accepted iff `ts <= deadline`; an HTLC expires iff `ts > deadline`. There is no
enforcement margin in the Account: a margin is Entity policy. Source: R-X2, `htlc-deadline.ts`.
Open: `TOLERANCE >= DRIFT` is needed for two honest sides to accept each other; the model does not prove the
Runtime keeps it.

**A9. HTLC deadline horizon (coordinator decision, policy).**
Choice: a side refuses a lock whose deadline is more than `LOCK_SLACK` after the frame's timestamp. It is a per-side
policy parameter, not a protocol constant; the contracts bound nothing here. Modelled as a global for now.

**A10. HTLC resolution rights.**
Choice: only the payee can resolve (reveal) or cancel a lock; anyone can expire it, after the deadline. A secret is
represented by an integer and a hashlock by `hashOf(secret)`; who knows which secret is not part of the Account (it
comes from routing) and is modelled as unconstrained, which over-approximates honest behaviour. Source:
`account-model.md` section 4.

**A11. Not yet in this layer** (each tracked in PROGRESS.md): cooperative settlement and the on-chain epoch (N1:
sign proofs only for the current epoch; pause payments until the new baseline proof is co-signed), account open
(Q-A1), windows fixed at open (N3), swaps, multiple tokens, a Byzantine peer.
