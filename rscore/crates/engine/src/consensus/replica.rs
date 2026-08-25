//! The account replica as consensus sees it: financial state plus the frames
//! and the mempool around it.
//!
//! Parity target: the `AccountReplica` fields in core/types/account.ts that
//! Account consensus owns — `mempool`, `pendingFrame`, `currentFrame`,
//! `currentHeight`, `rollbackCount`, `lastRollbackFrameHash`. The financial
//! state stays in `AccountReplica` so executing a transaction never copies the
//! queue.

use xln_rscore_protocol::CanonicalValue;

use crate::consensus::frame::hash::{
    AccountFrame, GENESIS_PREV_FRAME_HASH, canonical_tx_value, is_frame_hashable, unsupported_kind,
};
use crate::consensus::proposal::propose::{WindowExecution, execute_window};
use crate::error::StateError;
use crate::input::mempool::{
    assert_mempool_admission, assert_mempool_within_limit, is_deduplicated_on_restore,
};
use crate::state::account_replica_shell::AccountEnvelope;
use crate::{AccountReplica, AccountTx};

/// An acknowledgement this side sent for the counterparty's frame, kept
/// because the Entity commits it in the account leaf: a proposal built right
/// after it carries it, and a retry of the ack must be the same bytes.
///
/// Parity target: `lastOutboundFrameAck` and the `ack` half of
/// `pendingAccountInput` (core/types/account.ts).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OutboundAck {
    pub height: u64,
    pub frame_hash: [u8; 32],
    /// The recovery proof the acknowledgement carried. The counterparty needs
    /// it to hold the state it just committed, and the leaf commits that it
    /// was sent.
    pub dispute: Option<DisputeDraft>,
}

/// The counterparty's own recovery proof, as it arrived and was checked.
///
/// Parity target: `counterpartyDisputeProofHanko`, `counterpartyDisputeHash`,
/// `counterpartyDisputeProofBodyHash`, `counterpartyDisputeProofNonce` and
/// `counterpartyDisputeProofProposerIsLeft` (core/types/account.ts), stored
/// together by `storeCounterpartyDisputeHanko`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CounterpartyDispute {
    pub hanko: Vec<u8>,
    pub proof_body_hash: [u8; 32],
    pub nonce: u64,
    pub proposer_is_left: bool,
}

/// The unsigned recovery proof this account currently stands behind: what a
/// validator would sign to start a dispute at this state.
///
/// Parity target: `currentDisputeHash`, `currentDisputeProofBodyHash`,
/// `currentDisputeProofNonce` and `currentDisputeProofProposerIsLeft`
/// (core/types/account.ts), replaced together by `replaceLocalDisputeDraft`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DisputeDraft {
    pub hash: [u8; 32],
    pub proof_body_hash: [u8; 32],
    pub nonce: u64,
    pub proposer_is_left: bool,
}

/// A frame both sides have committed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommittedFrame {
    /// The complete frame, not only its binding. Exact recovery must preserve
    /// the transaction/delta body the canonical Account document stores.
    pub frame: AccountFrame,
    pub state_hash: [u8; 32],
}

/// Our own proposal, signed and sent, waiting for the peer's ack. The
/// candidate is the state it commits to, kept so the ack applies without
/// replaying the frame.
#[derive(Clone)]
pub struct PendingFrame {
    pub frame: AccountFrame,
    pub state_hash: [u8; 32],
    pub hanko: Vec<u8>,
    pub(crate) candidate: AccountReplica,
    /// What the frame's transactions produced — forwards, revealed secrets,
    /// settlement effects. They are held here until the peer acks: an effect
    /// released before the counterparty commits is one the account cannot
    /// enforce.
    ///
    /// Parity target: `rememberProposalForAck`
    /// (core/account/consensus/proposal/propose.ts), which keeps
    /// `candidateEffects` in the prepared commit; the proposal result carries
    /// none, and the ACK path releases them.
    pub(crate) outputs: Vec<crate::AccountOutput>,
    /// The acknowledgement carried by the message that sent this proposal, if
    /// it carried one. Present means the message was a `frame_ack` rather than
    /// a `frame`, which the account leaf commits.
    pub(crate) bundled_ack: Option<OutboundAck>,
    /// The recovery proof this proposal travels with, when it does. The
    /// counterparty needs it to hold the state the frame commits to, and the
    /// account leaf commits the fact that it was sent.
    pub(crate) proposal_dispute: Option<DisputeDraft>,
}

#[derive(Clone)]
pub struct AccountConsensus {
    replica: AccountReplica,
    mempool: Vec<AccountTx>,
    pending: Option<PendingFrame>,
    current: Option<CommittedFrame>,
    rollback_count: u64,
    last_rollback_frame_hash: Option<[u8; 32]>,
    /// The counterparty's signature over the committed frame — their proposal
    /// Hanko when we accepted their frame, their ack when they accepted ours.
    /// It is the second half of the bilateral certificate, so a later board
    /// rotation can still prove both parties committed this height.
    counterparty_frame_hanko: Option<Vec<u8>>,
    /// The leaf commits the Hanko's digest. A Hanko is ~1.4 KB of hex and the
    /// leaf is recomputed on every tree put, so the digest is taken once, when
    /// the Hanko is stored — exact by identity, like the memo TypeScript keys
    /// on the Hanko string.
    counterparty_frame_hanko_digest: Option<String>,
    /// The last acknowledgement this side sent, kept for the same reasons
    /// TypeScript keeps it: the next proposal may carry it, and the leaf
    /// commits it until it does.
    last_outbound_ack: Option<OutboundAck>,
    /// The recovery proof this account stands behind, and the next dispute
    /// nonce it will spend. Both are committed in the account leaf, and a
    /// proposal that moves the state moves them with it.
    dispute: Option<DisputeDraft>,
    next_proof_nonce: u64,
    /// The counterparty's proof, and the digest of their signature over it —
    /// the leaf commits the digest, not the kilobyte of hex.
    counterparty_dispute: Option<CounterpartyDispute>,
    counterparty_dispute_hash: Option<[u8; 32]>,
    counterparty_dispute_hanko_digest: Option<String>,
    /// Our own certificate for the committed frame. It is not part of the
    /// Entity leaf, but canonical Account storage persists it and dispute
    /// recovery must not depend on re-signing historical evidence.
    local_committed_frame_hanko: Option<Vec<u8>>,
}

impl AccountConsensus {
    pub fn new(replica: AccountReplica) -> Self {
        Self {
            replica,
            mempool: Vec::new(),
            pending: None,
            current: None,
            rollback_count: 0,
            last_rollback_frame_hash: None,
            counterparty_frame_hanko: None,
            counterparty_frame_hanko_digest: None,
            last_outbound_ack: None,
            dispute: None,
            // TypeScript's canonical H=0 Account genesis starts at nonce 1.
            // Nonce 0 is not a usable proof nonce: proposal/ACK construction
            // already clamps against jNonce + 1, but the Entity account leaf
            // commits this value before the first proposal too.
            next_proof_nonce: 1,
            counterparty_dispute: None,
            counterparty_dispute_hash: None,
            counterparty_dispute_hanko_digest: None,
            local_committed_frame_hanko: None,
        }
    }

    pub const fn replica(&self) -> &AccountReplica {
        &self.replica
    }

    pub fn mempool(&self) -> &[AccountTx] {
        &self.mempool
    }

    pub const fn pending(&self) -> Option<&PendingFrame> {
        self.pending.as_ref()
    }

    pub const fn current(&self) -> Option<&CommittedFrame> {
        self.current.as_ref()
    }

    pub fn current_height(&self) -> u64 {
        self.current.as_ref().map_or(0, |frame| frame.frame.height)
    }

    pub const fn rollback_count(&self) -> u64 {
        self.rollback_count
    }

    /// What the next frame chains to: the literal `genesis` before any frame
    /// is committed, otherwise the committed frame's own hash.
    pub fn prev_frame_hash(&self) -> String {
        self.current.as_ref().map_or_else(
            || GENESIS_PREV_FRAME_HASH.to_string(),
            |frame| format!("0x{}", hex_of(&frame.state_hash)),
        )
    }

    /// Admit local intentions. The limit counts the proposed frame too, so an
    /// unresponsive peer cannot be used to grow the queue.
    pub fn admit_txs(
        &mut self,
        txs: Vec<AccountTx>,
        context: &'static str,
    ) -> Result<(), StateError> {
        assert_mempool_admission(
            self.mempool.len(),
            self.pending_tx_count(),
            txs.len(),
            context,
        )?;
        // A transaction the frame hash cannot express must never enter the
        // queue: it would fail every later proposal and every leaf digest,
        // with nothing to remove it.
        for tx in &txs {
            if !is_frame_hashable(tx) {
                return Err(StateError::UnsupportedFrameTx(unsupported_kind(tx)));
            }
        }
        self.mempool.extend(txs);
        Ok(())
    }

    fn pending_tx_count(&self) -> usize {
        self.pending
            .as_ref()
            .map_or(0, |pending| pending.frame.txs.len())
    }

    /// Take the whole queue as the proposal window. The caller returns what it
    /// could not use.
    pub(crate) fn take_mempool(&mut self) -> Vec<AccountTx> {
        std::mem::take(&mut self.mempool)
    }

    pub(crate) fn restore_mempool_front(&mut self, txs: Vec<AccountTx>) -> Result<(), StateError> {
        if txs.is_empty() {
            return Ok(());
        }
        let mut next = txs;
        next.extend(std::mem::take(&mut self.mempool));
        assert_mempool_within_limit(next.len(), 0, "accountConsensus:restore")?;
        self.mempool = next;
        Ok(())
    }

    /// Install our proposal, and decide what the message carrying it was: a
    /// bare frame, or a frame carrying the acknowledgement we owe for the
    /// counterparty's previous one. The account leaf commits that choice, so
    /// it is made here rather than at the wire.
    ///
    /// Parity target: `buildOutboundAccountInput`
    /// (core/account/consensus/proposal/finalize.ts) — bundle when the ack is
    /// for this counterparty, one height below the frame, and the account has
    /// committed exactly that height; and drop an ack older than the committed
    /// height, which no later proposal can carry.
    pub(crate) fn set_pending(&mut self, mut pending: PendingFrame) {
        let current_height = self.current_height();
        let bundle = self.last_outbound_ack.as_ref().is_some_and(|ack| {
            ack.height + 1 == pending.frame.height && current_height == ack.height
        });
        if bundle {
            pending.bundled_ack = self.last_outbound_ack.clone();
        } else if self
            .last_outbound_ack
            .as_ref()
            .is_some_and(|ack| ack.height < current_height)
        {
            self.last_outbound_ack = None;
        }
        self.pending = Some(pending);
    }

    /// Remember the acknowledgement we are sending for a frame we just
    /// committed from the counterparty.
    ///
    /// Parity target: `account.lastOutboundFrameAck = material.outboundAck`
    /// (core/account/consensus/index.ts).
    pub(crate) fn note_outbound_ack(
        &mut self,
        height: u64,
        frame_hash: [u8; 32],
        dispute: Option<DisputeDraft>,
    ) {
        self.last_outbound_ack = Some(OutboundAck {
            height,
            frame_hash,
            dispute,
        });
    }

    /// Keep the counterparty's proof. Its hash is recomputed from the message
    /// rather than taken from them: a signature is over one exact message, and
    /// the only one worth committing is the one this side can rebuild.
    ///
    /// Parity target: `storeCounterpartyDisputeHanko`
    /// (core/account/consensus/dispute/hanko.ts), whose `hash` is likewise the
    /// verifier's own.
    pub(crate) fn store_counterparty_dispute(&mut self, dispute: CounterpartyDispute) {
        let identity = self.replica.state().identity();
        self.counterparty_dispute_hash = Some(crate::dispute::dispute_proof_hash(
            identity.domain().chain_id(),
            identity.domain().depository_address().bytes(),
            identity
                .entity(crate::state::identity::Side::Left)
                .as_bytes(),
            identity
                .entity(crate::state::identity::Side::Right)
                .as_bytes(),
            dispute.nonce,
            dispute.proposer_is_left,
            &dispute.proof_body_hash,
            identity.watch_seed().bytes(),
        ));
        self.counterparty_dispute_hanko_digest = Some(hanko_leaf_digest(&dispute.hanko));
        self.counterparty_dispute = Some(dispute);
    }

    /// The proof this side sends with the acknowledgement of a frame it just
    /// committed, and the draft it stands behind afterwards.
    ///
    /// Parity target: `buildIncomingFrameAckMaterial` + `storeAckDisputeState`
    /// (core/account/consensus/index.ts). The proof is built for the side that
    /// proposed the frame, because that is the side the contract will check it
    /// against.
    pub(crate) fn refresh_ack_dispute_draft(
        &mut self,
        committed: &AccountReplica,
        delta_transformer: &[u8; 20],
        proposer_is_left: bool,
    ) -> Result<Option<DisputeDraft>, StateError> {
        let proof_body_hash = crate::dispute::proof_body_hash(committed, delta_transformer)?;
        let j_nonce = self.replica.state().j_nonce();
        let changed = self.dispute.as_ref().is_none_or(|draft| {
            draft.proof_body_hash != proof_body_hash
                || draft.proposer_is_left != proposer_is_left
                || draft.nonce <= j_nonce
        });
        let nonce = self.next_proof_nonce.max(j_nonce + 1);
        if !changed {
            // Nothing new to sign; a proof already certified for exactly this
            // body travels with the acknowledgement instead.
            let certified = self
                .replica
                .envelope()
                .has_field("currentDisputeProofHanko");
            return Ok(self.dispute.clone().filter(|_| certified));
        }
        let identity = self.replica.state().identity();
        let draft = DisputeDraft {
            hash: crate::dispute::dispute_proof_hash(
                identity.domain().chain_id(),
                identity.domain().depository_address().bytes(),
                identity
                    .entity(crate::state::identity::Side::Left)
                    .as_bytes(),
                identity
                    .entity(crate::state::identity::Side::Right)
                    .as_bytes(),
                nonce,
                proposer_is_left,
                &proof_body_hash,
                identity.watch_seed().bytes(),
            ),
            proof_body_hash,
            nonce,
            proposer_is_left,
        };
        self.dispute = Some(draft.clone());
        self.replica
            .forget_envelope_field("currentDisputeProofHanko");
        self.next_proof_nonce = nonce + 1;
        Ok(Some(draft))
    }

    /// Commit a frame: the candidate becomes live state and the frame becomes
    /// the chain head.
    /// Commit the counterparty's frame. Their proposal Hanko is the
    /// certificate; the rollback bookkeeping is untouched, because accepting
    /// their frame is not what settles a collision we lost.
    ///
    /// Parity target: the receiver commit in core/account/consensus/index.ts,
    /// which sets `counterpartyFrameHanko` and leaves `rollbackCount` and
    /// `lastRollbackFrameHash` alone.
    pub(crate) fn commit_from_peer(
        &mut self,
        candidate: AccountReplica,
        frame: &AccountFrame,
        state_hash: [u8; 32],
        counterparty_hanko: Vec<u8>,
        local_hanko: Vec<u8>,
    ) {
        self.install_commit(candidate, frame, state_hash);
        self.store_counterparty_hanko(counterparty_hanko);
        self.local_committed_frame_hanko = Some(local_hanko);
    }

    /// Commit our own frame on the peer's ack. Their ack is the certificate,
    /// and one rollback is settled by it.
    ///
    /// Parity target: `installPendingFrameCommit`
    /// (core/account/consensus/incoming/ack-commit.ts):
    /// `rollbackCount = max(0, rollbackCount - 1)`, and the rollback hash is
    /// dropped only when the count reaches zero.
    pub(crate) fn commit_from_ack(
        &mut self,
        candidate: AccountReplica,
        frame: &AccountFrame,
        state_hash: [u8; 32],
        ack_hanko: Vec<u8>,
        local_hanko: Vec<u8>,
    ) {
        self.install_commit(candidate, frame, state_hash);
        self.store_counterparty_hanko(ack_hanko);
        self.local_committed_frame_hanko = Some(local_hanko);
        // Parity target: the same drop in `installPendingFrameCommit`
        // (core/account/consensus/incoming/ack-commit.ts).
        if self
            .last_outbound_ack
            .as_ref()
            .is_some_and(|ack| ack.height < frame.height)
        {
            self.last_outbound_ack = None;
        }
        self.rollback_count = self.rollback_count.saturating_sub(1);
        if self.rollback_count == 0 {
            self.last_rollback_frame_hash = None;
        }
    }

    fn store_counterparty_hanko(&mut self, hanko: Vec<u8>) {
        self.counterparty_frame_hanko_digest = Some(hanko_leaf_digest(&hanko));
        self.counterparty_frame_hanko = Some(hanko);
    }

    fn install_commit(
        &mut self,
        candidate: AccountReplica,
        frame: &AccountFrame,
        state_hash: [u8; 32],
    ) {
        self.replica = candidate;
        self.current = Some(CommittedFrame {
            frame: frame.clone(),
            state_hash,
        });
        self.pending = None;
    }

    /// Discard our own unacknowledged proposal and put its transactions back
    /// at the front of the queue.
    ///
    /// Parity target: `applySameHeightIncomingFrameRollback`
    /// (core/account/consensus/incoming/collision.ts). Only the RIGHT entity
    /// ever reaches it, and only because the LEFT entity's frame won the
    /// collision — never because time passed.
    pub(crate) fn rollback_pending(
        &mut self,
        winner_state_hash: [u8; 32],
    ) -> Result<usize, StateError> {
        let Some(pending) = self.pending.as_ref() else {
            return Ok(0);
        };
        let mut restored: Vec<AccountTx> = Vec::with_capacity(pending.frame.txs.len());
        for tx in &pending.frame.txs {
            let duplicate = is_deduplicated_on_restore(tx)
                && (self.mempool.iter().any(|queued| queued == tx)
                    || restored.iter().any(|queued| queued == tx));
            if duplicate {
                continue;
            }
            restored.push(tx.clone());
        }
        // The queue check comes before the proposal is discarded: a rollback
        // that failed halfway would leave the transactions in neither place.
        assert_mempool_within_limit(
            restored.len() + self.mempool.len(),
            0,
            "accountConsensus:rollback",
        )?;
        self.pending = None;
        let count = restored.len();
        self.restore_mempool_front(restored)?;
        self.rollback_count = (self.rollback_count + 1).max(1);
        self.last_rollback_frame_hash = Some(winner_state_hash);
        Ok(count)
    }

    pub const fn dispute(&self) -> Option<&DisputeDraft> {
        self.dispute.as_ref()
    }

    pub const fn counterparty_dispute(&self) -> Option<&CounterpartyDispute> {
        self.counterparty_dispute.as_ref()
    }

    pub const fn next_proof_nonce(&self) -> u64 {
        self.next_proof_nonce
    }

    /// Stand behind a new recovery proof for the state this frame commits to.
    ///
    /// Parity target: `buildDisputeProjection` + `persistDisputeProjection`
    /// (core/account/consensus/proposal/proof.ts). A body identical to the one
    /// already signed, at a nonce the jurisdiction has not consumed, needs no
    /// new proof — and spending a nonce for nothing is what would make the two
    /// sides disagree about which proof is current.
    pub(crate) fn refresh_dispute_draft(
        &mut self,
        candidate: &AccountReplica,
        delta_transformer: &[u8; 20],
    ) -> Result<Option<DisputeDraft>, StateError> {
        let proof_body_hash = crate::dispute::proof_body_hash(candidate, delta_transformer)?;
        let j_nonce = candidate.state().j_nonce();
        let body_changed = self
            .dispute
            .as_ref()
            .is_none_or(|draft| draft.proof_body_hash != proof_body_hash);
        let nonce_consumed = self
            .dispute
            .as_ref()
            .is_none_or(|draft| draft.nonce <= j_nonce);
        let proposer_is_left = candidate.owner_side() == crate::state::identity::Side::Left;
        if !body_changed && !nonce_consumed {
            // Nothing new to sign, but a proof already certified for exactly
            // this body still travels with the frame.
            //
            // Parity target: the second branch of `resolveDisputeHanko`
            // (core/account/consensus/proposal/finalize.ts).
            let certified = self
                .replica
                .envelope()
                .has_field("currentDisputeProofHanko");
            return Ok(self.dispute.clone().filter(|draft| {
                certified
                    && draft.proof_body_hash == proof_body_hash
                    && draft.proposer_is_left == proposer_is_left
                    && draft.nonce > j_nonce
            }));
        }
        let nonce = self.next_proof_nonce.max(j_nonce + 1);
        let identity = candidate.state().identity();
        self.dispute = Some(DisputeDraft {
            hash: crate::dispute::dispute_proof_hash(
                identity.domain().chain_id(),
                identity.domain().depository_address().bytes(),
                identity
                    .entity(crate::state::identity::Side::Left)
                    .as_bytes(),
                identity
                    .entity(crate::state::identity::Side::Right)
                    .as_bytes(),
                nonce,
                proposer_is_left,
                &proof_body_hash,
                identity.watch_seed().bytes(),
            ),
            proof_body_hash,
            nonce,
            proposer_is_left,
        });
        // A Hanko certifies one exact hash, so the witness for the proof this
        // replaces does not carry over.
        //
        // Parity target: `replaceLocalDisputeDraft`
        // (core/account/consensus/dispute/hanko.ts).
        self.replica
            .forget_envelope_field("currentDisputeProofHanko");
        self.next_proof_nonce = nonce + 1;
        Ok(self.dispute.clone())
    }

    pub(crate) const fn last_rollback_frame_hash(&self) -> Option<&[u8; 32]> {
        self.last_rollback_frame_hash.as_ref()
    }
}

/// Our own unacknowledged proposal as a checkpoint saves it: the frame and the
/// signature over it. The candidate state it commits to is not saved — it is
/// exactly what replaying the frame produces, so a restore rebuilds it and
/// checks that it still hashes to the frame the signature covers.
#[derive(Clone, Debug)]
pub struct PendingFrameSnapshot {
    pub frame: AccountFrame,
    pub state_hash: [u8; 32],
    pub hanko: Vec<u8>,
    /// The acknowledgement the message carrying this proposal also carried,
    /// if any. It decides whether the leaf calls the message a `frame` or a
    /// `frame_ack`, so it is saved with the proposal rather than rederived.
    pub bundled_ack: Option<OutboundAck>,
    /// The recovery proof the proposal travelled with, if it carried one.
    pub proposal_dispute: Option<DisputeDraft>,
}

/// Everything consensus owns for one account, in a form a database can hold.
///
/// Parity target: the replica fields `mempool`, `currentFrame`,
/// `currentHeight`, `pendingFrame`, `rollbackCount` and
/// `lastRollbackFrameHash` that core/storage/schema/account-field-tags.ts
/// persists alongside the state trees.
#[derive(Clone, Debug)]
pub struct ConsensusSnapshot {
    pub mempool: Vec<AccountTx>,
    pub current: Option<CommittedFrame>,
    pub pending: Option<PendingFrameSnapshot>,
    pub rollback_count: u64,
    pub last_rollback_frame_hash: Option<[u8; 32]>,
    /// The bilateral certificate for the committed frame. It is committed in
    /// the account leaf, so losing it across a restart would change the leaf.
    pub counterparty_frame_hanko: Option<Vec<u8>>,
    /// The last acknowledgement this side sent. The leaf commits it until a
    /// proposal carries it, so a restore that dropped it would change the leaf.
    pub last_outbound_ack: Option<OutboundAck>,
    /// The recovery proof the account stands behind, and the next nonce it
    /// will spend. A restore that dropped them would sign a proof for a state
    /// the counterparty never saw, at a nonce the jurisdiction already spent.
    pub dispute: Option<DisputeDraft>,
    pub next_proof_nonce: u64,
    /// The counterparty's proof as it last arrived.
    pub counterparty_dispute: Option<CounterpartyDispute>,
    /// Our historical certificate for `current`. While a proposal is pending,
    /// `pending.hanko` is the canonical `currentFrameHanko`; otherwise this is.
    pub local_committed_frame_hanko: Option<Vec<u8>>,
}

impl AccountConsensus {
    /// What a checkpoint writes for this account, beside its state trees.
    pub fn consensus_snapshot(&self) -> ConsensusSnapshot {
        ConsensusSnapshot {
            mempool: self.mempool.clone(),
            current: self.current.clone(),
            pending: self.pending.as_ref().map(|pending| PendingFrameSnapshot {
                frame: pending.frame.clone(),
                state_hash: pending.state_hash,
                hanko: pending.hanko.clone(),
                bundled_ack: pending.bundled_ack.clone(),
                proposal_dispute: pending.proposal_dispute.clone(),
            }),
            rollback_count: self.rollback_count,
            last_rollback_frame_hash: self.last_rollback_frame_hash,
            counterparty_frame_hanko: self.counterparty_frame_hanko.clone(),
            last_outbound_ack: self.last_outbound_ack.clone(),
            dispute: self.dispute.clone(),
            next_proof_nonce: self.next_proof_nonce,
            counterparty_dispute: self.counterparty_dispute.clone(),
            local_committed_frame_hanko: self.local_committed_frame_hanko.clone(),
        }
    }

    /// Rebuild an account from a checkpoint: the committed replica as the
    /// database holds it, plus the consensus state around it.
    ///
    /// A pending frame is replayed rather than trusted. If the replay does not
    /// reproduce the state root and the frame hash the signature covers, the
    /// database and the frame disagree and the restore fails here rather than
    /// producing an account that would sign a fork.
    pub fn restore_from_checkpoint(
        replica: AccountReplica,
        snapshot: ConsensusSnapshot,
        swap_market: &std::sync::Arc<crate::SwapMarketPolicy>,
    ) -> Result<Self, StateError> {
        let ConsensusSnapshot {
            mempool,
            current,
            pending,
            rollback_count,
            last_rollback_frame_hash,
            counterparty_frame_hanko,
            last_outbound_ack,
            dispute,
            next_proof_nonce,
            counterparty_dispute,
            local_committed_frame_hanko,
        } = snapshot;
        match (
            &current,
            &counterparty_frame_hanko,
            &local_committed_frame_hanko,
        ) {
            (None, Some(_), _) | (None, _, Some(_)) => {
                return Err(StateError::CheckpointRestore(
                    "ORPHAN_COMMITTED_FRAME_HANKO".to_string(),
                ));
            }
            (Some(_), None, _) | (Some(_), _, None) => {
                return Err(StateError::CheckpointRestore(
                    "CURRENT_FRAME_CERTIFICATE_MISSING".to_string(),
                ));
            }
            _ => {}
        }
        if let Some(committed) = &current {
            if committed.frame.hash()? != committed.state_hash {
                return Err(StateError::CheckpointRestore(
                    "CURRENT_FRAME_HASH_MISMATCH".to_string(),
                ));
            }
            if committed.frame.account_state_root
                != replica.state().payment_profile_account_state_root()?
            {
                return Err(StateError::CheckpointRestore(
                    "CURRENT_STATE_ROOT_MISMATCH".to_string(),
                ));
            }
        }
        assert_mempool_within_limit(
            mempool.len(),
            pending
                .as_ref()
                .map_or(0, |pending| pending.frame.txs.len()),
            "accountConsensus:checkpointRestore",
        )?;
        let mut account = Self {
            replica,
            mempool,
            pending: None,
            current,
            rollback_count,
            last_rollback_frame_hash,
            counterparty_frame_hanko_digest: counterparty_frame_hanko
                .as_deref()
                .map(hanko_leaf_digest),
            counterparty_frame_hanko,
            last_outbound_ack,
            dispute,
            next_proof_nonce,
            counterparty_dispute_hash: None,
            counterparty_dispute_hanko_digest: None,
            counterparty_dispute: None,
            local_committed_frame_hanko,
        };
        if let Some(dispute) = counterparty_dispute {
            account.store_counterparty_dispute(dispute);
        }
        let Some(pending) = pending else {
            return Ok(account);
        };
        let expected_height = account.current_height() + 1;
        if pending.frame.height != expected_height {
            return Err(StateError::CheckpointRestore(format!(
                "PENDING_HEIGHT:{}:{expected_height}",
                pending.frame.height
            )));
        }
        if pending.frame.prev_frame_hash != account.prev_frame_hash() {
            return Err(StateError::CheckpointRestore(format!(
                "PENDING_PREV_FRAME_HASH:{}",
                pending.frame.prev_frame_hash
            )));
        }
        // The replay reproduces the effects too, so a restart does not lose
        // what the pending frame will release when it is acked.
        let (candidate, outputs) = replay_pending(&account.replica, &pending, swap_market)?;
        account.pending = Some(PendingFrame {
            frame: pending.frame,
            state_hash: pending.state_hash,
            hanko: pending.hanko,
            candidate,
            outputs,
            bundled_ack: pending.bundled_ack,
            proposal_dispute: pending.proposal_dispute,
        });
        Ok(account)
    }
}

/// Replay a saved proposal against the committed replica and prove it is the
/// same frame: same transactions applied, same account state root, same hash.
fn replay_pending(
    replica: &AccountReplica,
    pending: &PendingFrameSnapshot,
    swap_market: &std::sync::Arc<crate::SwapMarketPolicy>,
) -> Result<(AccountReplica, Vec<crate::AccountOutput>), StateError> {
    let context = crate::AccountExecutionContext::with_market(
        pending.frame.timestamp,
        pending.frame.timestamp,
        pending.frame.j_height,
        pending.frame.height.saturating_sub(1),
        pending.frame.j_height,
        std::sync::Arc::clone(swap_market),
    );
    let proposer = replica.owner_side();
    let WindowExecution {
        mut candidate,
        applied,
        outputs,
        ..
    } = execute_window(replica, proposer, pending.frame.txs.clone(), &context, true)?;
    if applied.len() != pending.frame.txs.len() {
        return Err(StateError::CheckpointRestore(format!(
            "PENDING_TX_REJECTED:{}:{}",
            applied.len(),
            pending.frame.txs.len()
        )));
    }
    let account_state_root = candidate.refresh_account_state_root()?;
    if account_state_root != pending.frame.account_state_root {
        return Err(StateError::CheckpointRestore(
            "PENDING_STATE_ROOT_MISMATCH".to_string(),
        ));
    }
    if pending.frame.hash()? != pending.state_hash {
        return Err(StateError::CheckpointRestore(
            "PENDING_FRAME_HASH_MISMATCH".to_string(),
        ));
    }
    Ok((candidate, outputs))
}

impl AccountConsensus {
    /// The Entity's account leaf for this replica, with everything consensus
    /// owns derived rather than carried.
    ///
    /// Parity target: `projectAccountConsensusState`
    /// (core/entity/consensus/state-root.ts). The engine now owns the queue,
    /// the chain head and the frame in flight, so it projects them itself;
    /// fields it does not model yet stay carried on the replica's envelope.
    pub fn entity_account_leaf(&self) -> Result<[u8; 32], StateError> {
        let account_state_root = self.replica.state().payment_profile_account_state_root()?;
        let envelope = self.projected_envelope()?;
        envelope
            .entity_account_leaf(&account_state_root)
            .map_err(|error| StateError::Envelope(error.to_string()))
    }

    /// The exact fields this account commits in the Entity's leaf. Read back
    /// by a runtime that found the leaf disagreeing and needs the field.
    pub fn projected_leaf_fields(&self) -> Result<Vec<(String, CanonicalValue)>, StateError> {
        Ok(self.projected_envelope()?.fields().to_vec())
    }

    /// Exact shell stored beside a checkpoint. The raw replica envelope is
    /// only the seed/carried subset; mempool and consensus-owned fields must
    /// be projected from the live candidate or RestoreExact cannot reproduce
    /// the Entity leaf that this same Account reports.
    pub fn checkpoint_envelope(&self) -> Result<AccountEnvelope, StateError> {
        self.projected_envelope()
    }

    fn projected_envelope(&self) -> Result<AccountEnvelope, StateError> {
        let mut mempool = Vec::with_capacity(self.mempool.len());
        for tx in &self.mempool {
            mempool.push(canonical_tx_value(tx)?);
        }
        let mut fields: Vec<(String, CanonicalValue)> = self
            .replica
            .envelope()
            .fields()
            .iter()
            .filter(|(name, _)| !DERIVED_CONSENSUS_FIELDS.contains(&name.as_str()))
            .cloned()
            .collect();
        fields.push((
            "currentHeight".to_string(),
            CanonicalValue::Number(self.current_height() as f64),
        ));
        fields.push((
            "rollbackCount".to_string(),
            CanonicalValue::Number(self.rollback_count as f64),
        ));
        // The TypeScript AccountReplica always has an H=0 currentFrame whose
        // stateHash is the empty string. Absence here would make a freshly
        // created Rust Account occupy a different Entity leaf before its first
        // proposal, even though both sides agree that no signed frame exists.
        fields.push((
            "currentFrameHash".to_string(),
            CanonicalValue::String(
                self.current
                    .as_ref()
                    .map_or_else(String::new, |current| hex_prefixed(&current.state_hash)),
            ),
        ));
        if let Some(pending) = &self.pending {
            fields.push((
                "pendingFrameHash".to_string(),
                CanonicalValue::String(hex_prefixed(&pending.state_hash)),
            ));
        }
        if let Some(hash) = &self.last_rollback_frame_hash {
            fields.push((
                "lastRollbackFrameHash".to_string(),
                CanonicalValue::String(hex_prefixed(hash)),
            ));
        }
        if let Some(pending) = &self.pending {
            fields.push((
                "pendingAccountInput".to_string(),
                self.outbound_proposal_binding(pending),
            ));
        }
        if let Some(draft) = &self.dispute {
            fields.push((
                "currentDisputeHash".to_string(),
                CanonicalValue::String(hex_prefixed(&draft.hash)),
            ));
            fields.push((
                "currentDisputeProofBodyHash".to_string(),
                CanonicalValue::String(hex_prefixed(&draft.proof_body_hash)),
            ));
            fields.push((
                "currentDisputeProofNonce".to_string(),
                CanonicalValue::Number(draft.nonce as f64),
            ));
            fields.push((
                "currentDisputeProofProposerIsLeft".to_string(),
                CanonicalValue::Bool(draft.proposer_is_left),
            ));
        }
        fields.push((
            "proofHeader".to_string(),
            CanonicalValue::Object(vec![
                (
                    "fromEntity".to_string(),
                    CanonicalValue::String(self.replica.owner().to_string()),
                ),
                (
                    "toEntity".to_string(),
                    CanonicalValue::String(self.replica.counterparty().to_string()),
                ),
                (
                    "nextProofNonce".to_string(),
                    CanonicalValue::Number(self.next_proof_nonce as f64),
                ),
            ]),
        ));
        if let Some(ack) = &self.last_outbound_ack {
            fields.push((
                "lastOutboundFrameAck".to_string(),
                CanonicalValue::Object(vec![
                    (
                        "height".to_string(),
                        CanonicalValue::Number(ack.height as f64),
                    ),
                    (
                        "counterpartyEntityId".to_string(),
                        CanonicalValue::String(self.replica.counterparty().to_string()),
                    ),
                    ("response".to_string(), self.ack_binding(ack)),
                ]),
            ));
        }
        if let (Some(dispute), Some(hash)) =
            (&self.counterparty_dispute, &self.counterparty_dispute_hash)
        {
            fields.push((
                "counterpartyDisputeHash".to_string(),
                CanonicalValue::String(hex_prefixed(hash)),
            ));
            fields.push((
                "counterpartyDisputeProofBodyHash".to_string(),
                CanonicalValue::String(hex_prefixed(&dispute.proof_body_hash)),
            ));
            fields.push((
                "counterpartyDisputeProofNonce".to_string(),
                CanonicalValue::Number(dispute.nonce as f64),
            ));
            fields.push((
                "counterpartyDisputeProofProposerIsLeft".to_string(),
                CanonicalValue::Bool(dispute.proposer_is_left),
            ));
        }
        if let Some(digest) = &self.counterparty_dispute_hanko_digest {
            fields.push((
                "counterpartyDisputeProofHanko".to_string(),
                CanonicalValue::String(digest.clone()),
            ));
        }
        if let Some(digest) = &self.counterparty_frame_hanko_digest {
            // The leaf commits the Hanko's digest, not its ~1.4 KB of hex.
            //
            // Parity target: `hankoLeafDigest` over `ACCOUNT_LEAF_HANKO_FIELDS`
            // (core/entity/consensus/state-root.ts): the digest is taken over
            // the UTF-8 of the `0x`-prefixed string, which is how TypeScript
            // holds a Hanko.
            fields.push((
                "counterpartyFrameHanko".to_string(),
                CanonicalValue::String(digest.clone()),
            ));
        }
        AccountEnvelope::new(fields, mempool)
            .map_err(|error| StateError::Envelope(error.to_string()))
    }

    /// The signed proposal still waiting for its ack, as the Entity commits
    /// it: which message carried it, between whom, and what it binds.
    ///
    /// Parity target: `compactAccountInputBinding`
    /// (core/entity/consensus/state-root.ts) over `pendingAccountInput`.
    fn outbound_proposal_binding(&self, pending: &PendingFrame) -> CanonicalValue {
        let mut fields = vec![
            (
                "kind".to_string(),
                CanonicalValue::String(
                    if pending.bundled_ack.is_some() {
                        "frame_ack"
                    } else {
                        "frame"
                    }
                    .to_string(),
                ),
            ),
            (
                "fromEntityId".to_string(),
                CanonicalValue::String(self.replica.owner().to_string()),
            ),
            (
                "toEntityId".to_string(),
                CanonicalValue::String(self.replica.counterparty().to_string()),
            ),
            ("proposal".to_string(), {
                let mut proposal = vec![
                    (
                        "height".to_string(),
                        CanonicalValue::Number(pending.frame.height as f64),
                    ),
                    (
                        "frameHash".to_string(),
                        CanonicalValue::String(hex_prefixed(&pending.state_hash)),
                    ),
                ];
                if let Some(draft) = &pending.proposal_dispute {
                    proposal.push(("disputeHanko".to_string(), dispute_binding(draft)));
                }
                CanonicalValue::Object(proposal)
            }),
        ];
        if let Some(ack) = &pending.bundled_ack {
            fields.push(("ack".to_string(), ack_fields(ack)));
        }
        CanonicalValue::Object(fields)
    }

    /// The standalone acknowledgement message this side sent, as the Entity
    /// commits it inside `lastOutboundFrameAck`.
    fn ack_binding(&self, ack: &OutboundAck) -> CanonicalValue {
        CanonicalValue::Object(vec![
            (
                "kind".to_string(),
                CanonicalValue::String("ack".to_string()),
            ),
            (
                "fromEntityId".to_string(),
                CanonicalValue::String(self.replica.owner().to_string()),
            ),
            (
                "toEntityId".to_string(),
                CanonicalValue::String(self.replica.counterparty().to_string()),
            ),
            ("ack".to_string(), ack_fields(ack)),
        ])
    }
}

/// The recovery proof as the leaf commits it: the four fields that identify
/// which proof, never the signature over it.
///
/// Parity target: `compactDisputeHanko` (core/entity/consensus/state-root.ts).
fn dispute_binding(draft: &DisputeDraft) -> CanonicalValue {
    CanonicalValue::Object(vec![
        (
            "hash".to_string(),
            CanonicalValue::String(hex_prefixed(&draft.hash)),
        ),
        (
            "proofBodyHash".to_string(),
            CanonicalValue::String(hex_prefixed(&draft.proof_body_hash)),
        ),
        (
            "proofNonce".to_string(),
            CanonicalValue::Number(draft.nonce as f64),
        ),
        (
            "proposerIsLeft".to_string(),
            CanonicalValue::Bool(draft.proposer_is_left),
        ),
    ])
}

fn ack_fields(ack: &OutboundAck) -> CanonicalValue {
    let mut fields = vec![
        (
            "height".to_string(),
            CanonicalValue::Number(ack.height as f64),
        ),
        (
            "frameHash".to_string(),
            CanonicalValue::String(hex_prefixed(&ack.frame_hash)),
        ),
    ];
    if let Some(draft) = &ack.dispute {
        fields.push(("disputeHanko".to_string(), dispute_binding(draft)));
    }
    CanonicalValue::Object(fields)
}

impl std::fmt::Debug for AccountConsensus {
    /// A summary: the replica behind it is the state, not something a log
    /// line should carry.
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AccountConsensus")
            .field("owner", &self.replica.owner().to_string())
            .field("currentHeight", &self.current_height())
            .field("mempool", &self.mempool.len())
            .field(
                "pending",
                &self.pending.as_ref().map(|frame| frame.frame.height),
            )
            .field("rollbackCount", &self.rollback_count)
            .finish()
    }
}

/// Projection fields the engine derives from its own consensus state. A
/// carried copy of any of them would let the authority's view of the queue or
/// the chain head override what this engine actually holds.
const DERIVED_CONSENSUS_FIELDS: [&str; 18] = [
    "counterpartyDisputeHash",
    "counterpartyDisputeProofBodyHash",
    "counterpartyDisputeProofNonce",
    "counterpartyDisputeProofProposerIsLeft",
    "counterpartyDisputeProofHanko",
    "pendingAccountInput",
    "lastOutboundFrameAck",
    "proofHeader",
    "currentDisputeHash",
    "currentDisputeProofBodyHash",
    "currentDisputeProofNonce",
    "currentDisputeProofProposerIsLeft",
    "counterpartyFrameHanko",
    "currentHeight",
    "rollbackCount",
    "currentFrameHash",
    "pendingFrameHash",
    "lastRollbackFrameHash",
];

/// `0x` + sha256 of the Hanko's own `0x`-prefixed hex text, which is the
/// exact preimage `computeIntegrityDigest` hashes on the TypeScript side.
fn hanko_leaf_digest(hanko: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let text = format!("0x{}", hex_of(hanko));
    let digest: [u8; 32] = Sha256::digest(text.as_bytes()).into();
    hex_prefixed(&digest)
}

fn hex_prefixed(bytes: &[u8; 32]) -> String {
    format!("0x{}", hex_of(bytes))
}

fn hex_of(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(output, "{byte:02x}");
    }
    output
}
