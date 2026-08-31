//! The account replica as consensus sees it: financial state plus the frames
//! and the mempool around it.
//!
//! Parity target: the `AccountReplica` fields in core/types/account.ts that
//! Account consensus owns — `mempool`, `pendingFrame`, `currentFrame`,
//! `currentHeight`, `rollbackCount`, `lastRollbackFrameHash`. The financial
//! state stays in `AccountReplica` so executing a transaction never copies the
//! queue.

use std::sync::Arc;

use xln_rscore_protocol::{CanonicalNumber, CanonicalValue};

use crate::consensus::frame::hash::{AccountFrame, GENESIS_PREV_FRAME_HASH, canonical_tx_value};
use crate::consensus::proposal::propose::{WindowExecution, execute_window};
use crate::error::StateError;
use crate::input::mempool::{
    assert_mempool_admission, assert_mempool_within_limit, is_deduplicated_on_restore,
};
use crate::j_claims::{LocalClaimPlan, QueuedClaimWitness, plan_local_claim};
use crate::state::account_replica_shell::AccountEnvelope;
use crate::{AccountRejection, AccountReplica, AccountTx};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountDisputeStartedFinality {
    pub active_dispute: CanonicalValue,
    pub j_nonce: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountDisputeFinality {
    pub finalized_j_nonce: u64,
    pub finalized_token_ids: Vec<crate::TokenId>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountDisputeFinalityResult {
    pub had_active_dispute: bool,
    pub had_settlement_workspace: bool,
    pub removed_settlement_txs: usize,
}

fn number(value: u64) -> Result<CanonicalValue, StateError> {
    CanonicalNumber::try_from_u64(value)
        .map(CanonicalValue::Number)
        .map_err(|error| StateError::Envelope(error.to_string()))
}

fn queued_claim_witness(claim: &crate::JEventClaimTx) -> Result<QueuedClaimWitness, StateError> {
    Ok(QueuedClaimWitness {
        j_height: claim.j_height,
        j_block_hash: claim.j_block_hash,
        events_hash: crate::j_claims::canonical_events_hash(&crate::j_claims::canonical_events(
            &claim.events,
        )?)?,
    })
}

fn is_truthy_canonical_value(value: &CanonicalValue) -> bool {
    match value {
        CanonicalValue::Null => false,
        CanonicalValue::Bool(value) => *value,
        CanonicalValue::Number(value) => value.as_str() != "0" && value.as_str() != "-0",
        CanonicalValue::BigInt(value) => value != &0.into(),
        CanonicalValue::String(value) => !value.is_empty(),
        CanonicalValue::Array(_)
        | CanonicalValue::Map(_)
        | CanonicalValue::Set(_)
        | CanonicalValue::Object(_) => true,
    }
}

fn is_dispute_evidence_tx(tx: &AccountTx) -> bool {
    match tx {
        AccountTx::SwapResolve { .. } => true,
        AccountTx::CrossPullClose { data } => {
            let CanonicalValue::Object(fields) = data else {
                return false;
            };
            let has_binary = fields.iter().any(|(name, value)| {
                name == "binary" && matches!(value, CanonicalValue::String(_))
            });
            let has_proof = fields
                .iter()
                .find_map(|(name, value)| (name == "proof").then_some(value))
                .is_some_and(is_truthy_canonical_value);
            has_binary && has_proof
        }
        _ => false,
    }
}

/// FX-3 (proofs/fixes.md, decision D4): one enqueue row rejected at
/// admission, reported as typed data while the rest of the batch is admitted.
/// The enqueue counterpart of the proposal path's `DroppedTx`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AdmissionRejection {
    pub index: usize,
    pub rejection: AccountRejection,
}

/// Summary of one local admission batch: how many rows entered the queue,
/// how many were idempotent duplicates, and the typed rejection for each
/// conflicting row. Malformed batches and store failures stay whole-batch
/// `Err`; only the adversarial-evidence verdict lives here, so the account
/// always continues.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AccountAdmission {
    pub admitted: usize,
    pub duplicates: usize,
    pub rejections: Vec<AdmissionRejection>,
}

/// An acknowledgement this side sent for the counterparty's frame, kept
/// because the Entity commits it in the account leaf: a proposal built right
/// after it carries it, and a retry of the ack must be the same bytes.
///
/// Parity target: `lastOutboundAckFrame` and the `ack` half of
/// `pendingAccountInput` (core/types/account.ts).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OutboundAck {
    pub height: u64,
    pub frame_hash: [u8; 32],
    /// The exact frame certificate this side sent to the counterparty.
    ///
    /// The Entity leaf deliberately commits only the compact ACK binding, not
    /// these raw bytes. Durable recovery still has to retain the certificate:
    /// a retry after a crash must resend the original Hanko rather than sign
    /// historical evidence again.
    pub frame_hanko: Vec<u8>,
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
    pub hanko: Option<Vec<u8>>,
    /// The exact digest claimed by the peer. Verification independently
    /// rebuilds it from the Account identity and rejects any mismatch before
    /// authenticating or retaining the witness.
    pub hash: [u8; 32],
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
    /// Exact local certificate once the parent Entity commits this proof.
    /// Absent only inside the in-flight Entity candidate before certification.
    /// The Account leaf deliberately excludes these bytes.
    pub hanko: Option<Vec<u8>>,
    pub hash: [u8; 32],
    pub proof_body_hash: [u8; 32],
    pub nonce: u64,
    pub proposer_is_left: bool,
}

fn attach_matching_dispute(
    slot: &mut Option<DisputeDraft>,
    hash: [u8; 32],
    hanko: &[u8],
) -> Result<bool, StateError> {
    let Some(draft) = slot.as_mut().filter(|draft| draft.hash == hash) else {
        return Ok(false);
    };
    match draft.hanko.as_deref() {
        Some(existing) if existing == hanko => Ok(false),
        Some(_) => Err(StateError::Signing(
            "LOCAL_DISPUTE_HANKO_CONFLICT".to_string(),
        )),
        None => {
            draft.hanko = Some(hanko.to_vec());
            Ok(true)
        }
    }
}

/// What a lost collision put back on the queue.
///
/// The publisher names it in the events the Entity frame commits, so the
/// counts travel with the verdict rather than being recomputed from a copy of
/// the account.
#[derive(Clone, Copy, Debug)]
pub struct RolledBackProposal {
    pub height: u64,
    pub restored: usize,
    pub proposed: usize,
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
    /// What each frame transaction produced, held until the peer acks: an
    /// effect released before the counterparty commits is unenforceable.
    /// Parity target: `rememberProposalForAck`
    /// (core/account/consensus/proposal/propose.ts), which keeps
    /// `candidateEffects` in the prepared commit; the proposal result carries
    /// none, and the ACK path releases them. Rows are rebuilt by replay on
    /// restore, so the checkpoint stores no duplicate effect payload.
    pub(crate) outputs_by_tx: Arc<Vec<Vec<crate::AccountOutput>>>,
    /// The acknowledgement carried by the message that sent this proposal, if
    /// it carried one. Present means the message was a `ack_frame` rather than
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
    // The committed frame is immutable until the next commit. Resident radix
    // candidates clone `AccountConsensus` to preserve the rollback head; an
    // owned frame here copied the complete transaction body on every inbound
    // and outbound visit. Share that immutable body and deep-copy it only at
    // the checkpoint serialization boundary.
    current: Option<Arc<CommittedFrame>>,
    rollback_count: u64,
    last_rollback_frame_hash: Option<[u8; 32]>,
    /// The counterparty's signature over the committed frame — their proposal
    /// Hanko when we accepted their frame, their ack when they accepted ours.
    /// It is the second half of the bilateral certificate, so a later board
    /// rotation can still prove both parties committed this height.
    // Immutable certificates are shared across resident rollback candidates.
    // The checkpoint boundary materializes owned bytes only when persistence
    // is actually due.
    counterparty_frame_hanko: Option<Arc<[u8]>>,
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
    local_committed_frame_hanko: Option<Arc<[u8]>>,
    /// Parent Entity-certified authority for the local owner during the
    /// current execution turn. This is verification context, not Account
    /// state: every parent call replaces it from the certified registry.
    local_board_authority: Option<crate::CertifiedBoardAuthority>,
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
            local_board_authority: None,
        }
    }

    pub fn set_local_board_authority(&mut self, authority: Option<crate::CertifiedBoardAuthority>) {
        self.local_board_authority = authority;
    }

    pub(crate) const fn local_board_authority(&self) -> Option<crate::CertifiedBoardAuthority> {
        self.local_board_authority
    }

    pub const fn replica(&self) -> &AccountReplica {
        &self.replica
    }

    pub fn set_rebalance_shadow_policy(
        &mut self,
        token_id: crate::TokenId,
        policy: crate::CanonicalValue,
    ) -> Result<(), StateError> {
        self.replica.set_rebalance_shadow_policy(token_id, policy)
    }

    pub fn clear_rebalance_active_quote(&mut self) -> Result<(), StateError> {
        self.replica.clear_rebalance_active_quote()
    }

    fn freeze_for_dispute(&mut self, retain_optional_evidence: bool) -> Result<(), StateError> {
        let retain_deferred_claims = matches!(
            self.replica.envelope().field("status"),
            Some(CanonicalValue::String(status)) if status == "dispute_preparing"
        );
        let retain = |tx: &AccountTx| {
            (retain_deferred_claims && matches!(tx, AccountTx::JEventClaim(_)))
                || (retain_optional_evidence && is_dispute_evidence_tx(tx))
        };
        let pending = self
            .pending
            .as_ref()
            .into_iter()
            .flat_map(|pending| pending.frame.txs.iter())
            .filter(|tx| retain(tx))
            .cloned()
            .collect::<Vec<_>>();
        self.mempool.retain(&retain);
        for tx in pending.into_iter().rev() {
            if !self.mempool.contains(&tx) {
                self.mempool.insert(0, tx);
            }
        }
        assert_mempool_within_limit(self.mempool.len(), 0, "accountConsensus:disputeFreeze")?;
        self.pending = None;
        self.rollback_count = 0;
        self.last_rollback_frame_hash = None;
        Ok(())
    }

    pub fn apply_entity_dispute_started(
        &mut self,
        finality: AccountDisputeStartedFinality,
    ) -> Result<(), StateError> {
        let j_nonce = self.replica.state().j_nonce().max(finality.j_nonce);
        self.replica.state_mut().set_j_nonce(j_nonce);
        self.set_entity_dispute_lifecycle("disputed", None, Some(finality.active_dispute))?;
        // On-chain DisputeStarted keeps optional transformer evidence, but J
        // claims are no longer deferred once the status is terminal.
        self.freeze_for_dispute(true)
    }

    pub fn apply_entity_dispute_finality(
        &mut self,
        finality: AccountDisputeFinality,
    ) -> Result<AccountDisputeFinalityResult, StateError> {
        let had_active_dispute = self.replica.envelope().field("activeDispute").is_some();
        let had_settlement_workspace = self.replica.state().settlement_workspace().is_some();
        let removed_settlement_txs = self
            .mempool
            .iter()
            .filter(|tx| matches!(tx, AccountTx::SettleTransition { .. }))
            .count();
        self.mempool
            .retain(|tx| !matches!(tx, AccountTx::SettleTransition { .. }));
        let finalized = finality.finalized_token_ids.into_iter().collect();
        self.replica
            .state_mut()
            .apply_dispute_finality(&finalized)?;
        self.replica
            .state_mut()
            .set_j_nonce(finality.finalized_j_nonce);
        self.next_proof_nonce = self.next_proof_nonce.max(
            finality
                .finalized_j_nonce
                .checked_add(1)
                .ok_or_else(|| StateError::TransitionFailed("J_NONCE_OVERFLOW".into()))?,
        );
        self.counterparty_dispute = None;
        self.counterparty_dispute_hash = None;
        self.counterparty_dispute_hanko_digest = None;
        self.set_entity_dispute_lifecycle("disputed", None, None)?;
        self.freeze_for_dispute(false)?;
        Ok(AccountDisputeFinalityResult {
            had_active_dispute,
            had_settlement_workspace,
            removed_settlement_txs,
        })
    }

    pub fn mempool(&self) -> &[AccountTx] {
        &self.mempool
    }

    pub fn settlement_hanko_draft(&self) -> Result<crate::SettlementHankoDraft, StateError> {
        crate::build_settlement_hanko_draft(&self.replica, &self.settlement_execution_context(None))
            .map_err(StateError::CheckpointRestore)
    }

    pub fn attach_certified_settlement_hanko(
        &mut self,
        draft: crate::SettlementHankoDraft,
        settlement_hanko: Option<&[u8]>,
        dispute_hanko: &[u8],
    ) -> Result<(), StateError> {
        let tx = crate::attach_settlement_hanko_witnesses(draft, settlement_hanko, dispute_hanko)
            .map_err(StateError::CheckpointRestore)?;
        let canonical = canonical_tx_value(&tx)?;
        let mut matched = self
            .mempool
            .iter()
            .enumerate()
            .filter_map(|(index, queued)| match canonical_tx_value(queued) {
                Ok(value) if value == canonical => Some(Ok(index)),
                Ok(_) => None,
                Err(error) => Some(Err(error)),
            })
            .collect::<Result<Vec<_>, _>>()?;
        if matched.len() != 1 {
            return Err(StateError::CheckpointRestore(format!(
                "SETTLEMENT_CERTIFIED_HANKO_UNSIGNED_TX_COUNT:{}",
                matched.len()
            )));
        }
        self.mempool[matched.remove(0)] = tx;
        Ok(())
    }

    pub const fn pending(&self) -> Option<&PendingFrame> {
        self.pending.as_ref()
    }

    /// Move the already-verified proposal into the ACK commit. Callers must
    /// finish every fallible authentication and binding check first; cloning
    /// this row copied its candidate state, frame, outputs and Hankos only to
    /// discard the resident original one instruction later.
    pub(crate) fn take_pending(&mut self) -> Option<PendingFrame> {
        self.pending.take()
    }

    pub fn current(&self) -> Option<&CommittedFrame> {
        self.current.as_deref()
    }

    /// Exact local certificate retained for the committed head. A pending
    /// proposal has its own Hanko and must never replace this historical ACK
    /// source.
    pub(crate) fn local_committed_frame_hanko(&self) -> Option<&[u8]> {
        self.local_committed_frame_hanko.as_deref()
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
    ///
    /// FX-3 (proofs/fixes.md, decision D4): malformed input (unhashable kind,
    /// out-of-range policyVersion) rejects the whole batch loudly, but a
    /// j-claim that conflicts with committed or earlier queued evidence
    /// rejects only its own row, as typed data — the account continues.
    /// Parity target: `applyAccountEnqueue`'s `admissionRejections`
    /// (core/account/input/local-tx-admission.ts).
    pub fn admit_txs(
        &mut self,
        txs: Vec<AccountTx>,
        context: &'static str,
    ) -> Result<AccountAdmission, StateError> {
        assert_mempool_admission(
            self.mempool.len(),
            self.pending_tx_count(),
            txs.len(),
            context,
        )?;
        // Validate through the canonical frame projection itself. Collapsing
        // every projection error into `UnsupportedFrameTx` hid typed field
        // failures such as an unsafe policyVersion and let admission disagree
        // with `AccountFrame::hash` about the same transaction.
        for tx in &txs {
            canonical_tx_value(tx)?;
        }
        let incoming_claim_heights: std::collections::BTreeSet<u64> = txs
            .iter()
            .filter_map(|tx| match tx {
                AccountTx::JEventClaim(claim) => Some(claim.j_height),
                _ => None,
            })
            .collect();
        let mut summary = AccountAdmission::default();
        let mut admitted: Vec<AccountTx> = Vec::with_capacity(txs.len());
        if incoming_claim_heights.is_empty() {
            summary.admitted = txs.len();
            self.mempool.extend(txs);
            return Ok(summary);
        }
        // Only queued claims at an incoming height can conflict, so the queue
        // is canonicalized for exactly those rows. A decode failure here is a
        // corrupt queue, not adversarial evidence: fail loud.
        let mut queued: Vec<QueuedClaimWitness> = self
            .mempool
            .iter()
            .chain(self.pending.iter().flat_map(|pending| &pending.frame.txs))
            .filter_map(|tx| match tx {
                AccountTx::JEventClaim(claim)
                    if incoming_claim_heights.contains(&claim.j_height) =>
                {
                    Some(queued_claim_witness(claim))
                }
                _ => None,
            })
            .collect::<Result<_, _>>()?;
        for (index, tx) in txs.into_iter().enumerate() {
            if let AccountTx::JEventClaim(claim) = &tx {
                let carried = self.replica.state().carried();
                let plan = plan_local_claim(
                    self.replica.state().identity(),
                    &carried.left_pending_j_claims,
                    &carried.right_pending_j_claims,
                    &queued,
                    claim,
                    self.replica.state().j_claim_store(),
                    self.replica.owner_side(),
                )?;
                match plan {
                    LocalClaimPlan::Admit => {}
                    LocalClaimPlan::Duplicate => {
                        summary.duplicates += 1;
                        continue;
                    }
                    LocalClaimPlan::Conflict(rejection) => {
                        summary.rejections.push(AdmissionRejection {
                            index,
                            rejection: AccountRejection::Validation(rejection),
                        });
                        continue;
                    }
                }
            }
            if let AccountTx::JEventClaim(claim) = &tx {
                queued.push(queued_claim_witness(claim)?);
            }
            admitted.push(tx);
        }
        summary.admitted = admitted.len();
        self.mempool.extend(admitted);
        Ok(summary)
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
    /// Parity target: `account.lastOutboundAckFrame = material.outboundAck`
    /// (core/account/consensus/index.ts).
    pub(crate) fn note_outbound_ack(
        &mut self,
        height: u64,
        frame_hash: [u8; 32],
        frame_hanko: Vec<u8>,
        dispute: Option<DisputeDraft>,
    ) {
        self.last_outbound_ack = Some(OutboundAck {
            height,
            frame_hash,
            frame_hanko,
            dispute,
        });
    }

    /// The acknowledgement this side still owes or already sent, if any.
    pub fn outbound_ack(&self) -> Option<&OutboundAck> {
        self.last_outbound_ack.as_ref()
    }

    /// Keep the counterparty's proof after the verifier proved that its exact
    /// supplied hash equals the independently rebuilt Account-bound digest.
    ///
    /// Parity target: `storeCounterpartyDisputeHanko`
    /// (core/account/consensus/dispute/hanko.ts), whose `hash` is likewise the
    /// verifier's own.
    pub(crate) fn store_counterparty_dispute(&mut self, dispute: CounterpartyDispute) {
        self.counterparty_dispute_hash = Some(dispute.hash);
        self.counterparty_dispute_hanko_digest = dispute.hanko.as_deref().map(hanko_leaf_digest);
        self.counterparty_dispute = Some(dispute);
    }

    /// Atomically install the witnesses and activation metadata accepted by a
    /// `board_hanko_refresh` control input. The metadata write is fallible, so
    /// it happens before either witness is replaced.
    pub(crate) fn install_counterparty_board_hanko_refresh(
        &mut self,
        frame_hanko: Vec<u8>,
        dispute: Option<CounterpartyDispute>,
        metadata: CanonicalValue,
    ) -> Result<(), StateError> {
        self.replica
            .set_envelope_field("counterpartyBoardHankoRefresh", metadata)?;
        self.store_counterparty_hanko(frame_hanko);
        if let Some(dispute) = dispute {
            self.store_counterparty_dispute(dispute);
        }
        Ok(())
    }

    /// The proof this side sends with the acknowledgement of a frame it just
    /// committed, and the draft it stands behind afterwards.
    ///
    /// Parity target: `buildIncomingAckFrameMaterial` + `storeAckDisputeState`
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
            return Ok(self.dispute.clone().filter(|draft| draft.hanko.is_some()));
        }
        let identity = self.replica.state().identity();
        let draft = DisputeDraft {
            hanko: None,
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
        self.local_committed_frame_hanko = Some(Arc::from(local_hanko));
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
        self.local_committed_frame_hanko = Some(Arc::from(local_hanko));
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
        self.counterparty_frame_hanko = Some(Arc::from(hanko));
    }

    fn install_commit(
        &mut self,
        candidate: AccountReplica,
        frame: &AccountFrame,
        state_hash: [u8; 32],
    ) {
        self.replica = candidate;
        self.current = Some(Arc::new(CommittedFrame {
            frame: frame.clone(),
            state_hash,
        }));
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
    ) -> Result<Option<RolledBackProposal>, StateError> {
        let Some(pending) = self.pending.as_ref() else {
            return Ok(None);
        };
        let discarded_height = pending.frame.height;
        let proposed = pending.frame.txs.len();
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
        Ok(Some(RolledBackProposal {
            height: discarded_height,
            restored: count,
            proposed,
        }))
    }

    pub const fn dispute(&self) -> Option<&DisputeDraft> {
        self.dispute.as_ref()
    }

    pub const fn counterparty_dispute(&self) -> Option<&CounterpartyDispute> {
        self.counterparty_dispute.as_ref()
    }

    fn set_entity_dispute_lifecycle(
        &mut self,
        status: &str,
        dispute_prepare: Option<CanonicalValue>,
        active_dispute: Option<CanonicalValue>,
    ) -> Result<(), StateError> {
        if !matches!(status, "active" | "dispute_preparing" | "disputed") {
            return Err(StateError::Envelope(format!(
                "ACCOUNT_DISPUTE_STATUS_INVALID:{status}"
            )));
        }
        self.replica
            .set_envelope_field("status", CanonicalValue::String(status.to_string()))?;
        match dispute_prepare {
            Some(value) => self.replica.set_envelope_field("disputePrepare", value)?,
            None => self.replica.forget_envelope_field("disputePrepare"),
        }
        match active_dispute {
            Some(value) => self.replica.set_envelope_field("activeDispute", value)?,
            None => self.replica.forget_envelope_field("activeDispute"),
        }
        Ok(())
    }

    /// Apply the Entity-owned dispute shell atomically to the resident Account.
    /// These fields are outside the bilateral AccountState, but are committed
    /// by the parent Entity leaf. Keeping one typed entry point prevents a
    /// generic Entity-side field writer from becoming a second Account path.
    pub fn replace_entity_dispute_lifecycle(
        &mut self,
        status: &str,
        dispute_prepare: Option<CanonicalValue>,
        active_dispute: Option<CanonicalValue>,
    ) -> Result<(), StateError> {
        let previous_status = self
            .replica
            .envelope()
            .field("status")
            .and_then(|value| match value {
                CanonicalValue::String(value) => Some(value.clone()),
                _ => None,
            })
            .unwrap_or_else(|| "active".into());
        self.set_entity_dispute_lifecycle(status, dispute_prepare, active_dispute)?;
        if previous_status == status {
            // Counter-dispute, hash-recovery and finalize-queued updates only
            // replace Entity metadata. Re-freezing an already disputed
            // Account would silently erase transformer evidence accumulated
            // after the initial freeze.
            return Ok(());
        }
        match status {
            // prepareDispute installs the preparation shell before it freezes,
            // so deferred J claims and optional transformer evidence survive.
            "dispute_preparing" => self.freeze_for_dispute(true),
            // A zero-cooldown prepare can proceed directly to local start. TS
            // freezes that terminal transition with no retained queue rows.
            "disputed" => self.freeze_for_dispute(false),
            "active" => Ok(()),
            _ => unreachable!("validated dispute lifecycle status"),
        }
    }

    /// Whether ordinary peer AccountInput may enter ACK/replay processing.
    /// Jurisdiction bookkeeping uses typed Entity-owned lifecycle/finality
    /// mutations and therefore does not cross this bilateral ingress gate.
    pub fn accepts_external_input(&self) -> bool {
        match self.replica.envelope().field("status") {
            None => true,
            Some(CanonicalValue::String(status)) => status == "active",
            Some(_) => false,
        }
    }

    /// Commit one authenticated remote-book removal ACK into the existing
    /// preparation shell. The exact pending list is Entity-owned; Account
    /// financial state and bilateral frame history are untouched.
    pub fn confirm_dispute_book_removal(&mut self, order_id: &str) -> Result<(), StateError> {
        let status = match self.replica.envelope().field("status") {
            Some(CanonicalValue::String(value)) => value.as_str(),
            _ => "active",
        };
        if status != "dispute_preparing" {
            return Err(StateError::Envelope(format!(
                "DISPUTE_BOOK_REMOVAL_ACCOUNT_NOT_PREPARING:{order_id}:{status}"
            )));
        }
        let mut preparation = self
            .replica
            .envelope()
            .field("disputePrepare")
            .cloned()
            .ok_or_else(|| StateError::Envelope("DISPUTE_PREPARE_MISSING".into()))?;
        let CanonicalValue::Object(fields) = &mut preparation else {
            return Err(StateError::Envelope("DISPUTE_PREPARE_OBJECT".into()));
        };
        let pending_index = fields
            .iter()
            .position(|(name, _)| name == "pendingOrderbookRemovalIds")
            .ok_or_else(|| {
                StateError::Envelope(format!("DISPUTE_BOOK_REMOVAL_NOT_PENDING:{order_id}"))
            })?;
        let CanonicalValue::Array(pending) = &mut fields[pending_index].1 else {
            return Err(StateError::Envelope(
                "DISPUTE_PENDING_ORDERBOOK_REMOVALS_ARRAY".into(),
            ));
        };
        let before = pending.len();
        pending
            .retain(|value| !matches!(value, CanonicalValue::String(value) if value == order_id));
        if pending.len() == before {
            return Err(StateError::Envelope(format!(
                "DISPUTE_BOOK_REMOVAL_NOT_PENDING:{order_id}"
            )));
        }
        if pending.is_empty() {
            fields.remove(pending_index);
        }
        self.replica
            .set_envelope_field("disputePrepare", preparation)
    }

    pub const fn next_proof_nonce(&self) -> u64 {
        self.next_proof_nonce
    }

    pub(crate) fn settlement_execution_context(
        &self,
        proposer_board_authority: Option<crate::CertifiedBoardAuthority>,
    ) -> crate::SettlementExecutionContext {
        crate::SettlementExecutionContext {
            next_proof_nonce: self.next_proof_nonce,
            current_dispute_proof_nonce: self.dispute.as_ref().map(|proof| proof.nonce),
            counterparty_dispute_proof_nonce: self
                .counterparty_dispute
                .as_ref()
                .map(|proof| proof.nonce),
            proposer_board_authority,
        }
    }

    pub(crate) fn apply_consensus_effects(
        &mut self,
        effects: &[crate::tx::apply_types::AccountConsensusEffect],
    ) -> Result<(), StateError> {
        for effect in effects {
            match effect {
                crate::tx::apply_types::AccountConsensusEffect::ActivatePostSettlementProof {
                    local,
                    counterparty,
                    next_proof_nonce,
                } => {
                    if let Some(current) =
                        self.dispute.as_ref().filter(|row| row.nonce == local.nonce)
                        && (current.hash != local.hash
                            || current.proof_body_hash != local.proof_body_hash
                            || current.proposer_is_left != local.proposer_is_left)
                    {
                        return Err(StateError::TransitionFailed(format!(
                            "POST_SETTLEMENT_LOCAL_PROOF_EQUIVOCATION:{}",
                            local.nonce
                        )));
                    }
                    if self.dispute.as_ref().map_or(0, |row| row.nonce) < local.nonce {
                        self.dispute = Some(local.clone());
                    }
                    if let Some(current) = self
                        .counterparty_dispute
                        .as_ref()
                        .filter(|row| row.nonce == counterparty.nonce)
                        && (current.hash != counterparty.hash
                            || current.proof_body_hash != counterparty.proof_body_hash
                            || current.proposer_is_left != counterparty.proposer_is_left)
                    {
                        return Err(StateError::TransitionFailed(format!(
                            "POST_SETTLEMENT_COUNTERPARTY_PROOF_EQUIVOCATION:{}",
                            counterparty.nonce
                        )));
                    }
                    if self
                        .counterparty_dispute
                        .as_ref()
                        .map_or(0, |row| row.nonce)
                        < counterparty.nonce
                    {
                        self.store_counterparty_dispute(counterparty.clone());
                    }
                    self.next_proof_nonce = self.next_proof_nonce.max(*next_proof_nonce);
                }
            }
        }
        Ok(())
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
            return Ok(self.dispute.clone().filter(|draft| {
                draft.hanko.is_some()
                    && draft.proof_body_hash == proof_body_hash
                    && draft.proposer_is_left == proposer_is_left
                    && draft.nonce > j_nonce
            }));
        }
        let nonce = self.next_proof_nonce.max(j_nonce + 1);
        let identity = candidate.state().identity();
        self.dispute = Some(DisputeDraft {
            hanko: None,
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

    /// Install the exact Hanko produced by the parent Entity manifest.
    /// Every retained copy of the same outbound proof is updated so later
    /// resends never re-sign historical evidence.
    pub fn attach_local_dispute_hanko(
        &mut self,
        hash: [u8; 32],
        hanko: Vec<u8>,
    ) -> Result<bool, StateError> {
        if hanko.is_empty() {
            return Err(StateError::Signing("LOCAL_DISPUTE_HANKO_EMPTY".to_string()));
        }
        crate::consensus::signing::verify_frame_hanko(
            &hanko,
            &hash,
            self.replica.owner().as_bytes(),
        )?;
        let mut changed = attach_matching_dispute(&mut self.dispute, hash, &hanko)?;
        if let Some(ack) = &mut self.last_outbound_ack {
            changed |= attach_matching_dispute(&mut ack.dispute, hash, &hanko)?;
        }
        if let Some(pending) = &mut self.pending {
            changed |= attach_matching_dispute(&mut pending.proposal_dispute, hash, &hanko)?;
            if let Some(ack) = &mut pending.bundled_ack {
                changed |= attach_matching_dispute(&mut ack.dispute, hash, &hanko)?;
            }
        }
        if !changed {
            return Err(StateError::Signing(
                "LOCAL_DISPUTE_HANKO_UNREFERENCED".to_string(),
            ));
        }
        Ok(changed)
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
    /// `ack_frame`, so it is saved with the proposal rather than rederived.
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
            current: self.current.as_deref().cloned(),
            pending: self.pending.as_ref().map(|pending| PendingFrameSnapshot {
                frame: pending.frame.clone(),
                state_hash: pending.state_hash,
                hanko: pending.hanko.clone(),
                bundled_ack: pending.bundled_ack.clone(),
                proposal_dispute: pending.proposal_dispute.clone(),
            }),
            rollback_count: self.rollback_count,
            last_rollback_frame_hash: self.last_rollback_frame_hash,
            counterparty_frame_hanko: self.counterparty_frame_hanko.as_deref().map(<[u8]>::to_vec),
            last_outbound_ack: self.last_outbound_ack.clone(),
            dispute: self.dispute.clone(),
            next_proof_nonce: self.next_proof_nonce,
            counterparty_dispute: self.counterparty_dispute.clone(),
            local_committed_frame_hanko: self
                .local_committed_frame_hanko
                .as_deref()
                .map(<[u8]>::to_vec),
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
        // Exact checkpoints are installed only after parent Entity
        // certification. An unsigned local draft at this boundary is corrupt,
        // not something restore may silently re-sign.
        for draft in dispute
            .iter()
            .chain(
                last_outbound_ack
                    .iter()
                    .filter_map(|ack| ack.dispute.as_ref()),
            )
            .chain(
                pending
                    .iter()
                    .filter_map(|pending| pending.proposal_dispute.as_ref()),
            )
            .chain(pending.iter().filter_map(|pending| {
                pending
                    .bundled_ack
                    .as_ref()
                    .and_then(|ack| ack.dispute.as_ref())
            }))
        {
            let hanko = draft.hanko.as_deref().ok_or_else(|| {
                StateError::CheckpointRestore("LOCAL_DISPUTE_HANKO_MISSING".to_string())
            })?;
            crate::consensus::signing::verify_frame_hanko(
                hanko,
                &draft.hash,
                replica.owner().as_bytes(),
            )
            .map_err(|error| {
                StateError::CheckpointRestore(format!("LOCAL_DISPUTE_HANKO_INVALID:{error}"))
            })?;
        }
        if let Some(ack) = last_outbound_ack.as_ref() {
            verify_restored_outbound_ack(&replica, ack)?;
        }
        if let Some(ack) = pending
            .as_ref()
            .and_then(|pending| pending.bundled_ack.as_ref())
        {
            verify_restored_outbound_ack(&replica, ack)?;
        }
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
            let restored_state_root = replica.state().payment_profile_account_state_root()?;
            if committed.frame.account_state_root != restored_state_root {
                return Err(StateError::CheckpointRestore(format!(
                    "CURRENT_STATE_ROOT_MISMATCH:expected={}:actual={}:deltas={}:locks={}:swaps={}:policies={}:pulls={}",
                    hex_of(&committed.frame.account_state_root),
                    hex_of(&restored_state_root),
                    hex_of(&replica.state().deltas_root()),
                    hex_of(&replica.state().htlc_locks_root()),
                    hex_of(&replica.state().swap_offers_root()),
                    hex_of(&replica.state().rebalance_fee_policies_root()),
                    hex_of(&replica.state().carried().pulls_root),
                )));
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
            current: current.map(Arc::new),
            rollback_count,
            last_rollback_frame_hash,
            counterparty_frame_hanko_digest: counterparty_frame_hanko
                .as_deref()
                .map(hanko_leaf_digest),
            counterparty_frame_hanko: counterparty_frame_hanko.map(Arc::from),
            last_outbound_ack,
            dispute,
            next_proof_nonce,
            counterparty_dispute_hash: None,
            counterparty_dispute_hanko_digest: None,
            counterparty_dispute: None,
            local_committed_frame_hanko: local_committed_frame_hanko.map(Arc::from),
            local_board_authority: None,
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
        let settlement = account.settlement_execution_context(None);
        let PendingReplay {
            candidate,
            outputs_by_tx,
        } = replay_pending(&account.replica, &pending, swap_market, settlement)?;
        account.pending = Some(PendingFrame {
            frame: pending.frame,
            state_hash: pending.state_hash,
            hanko: pending.hanko,
            candidate,
            outputs_by_tx: Arc::new(outputs_by_tx),
            bundled_ack: pending.bundled_ack,
            proposal_dispute: pending.proposal_dispute,
        });
        Ok(account)
    }
}

/// Raw ACK Hanko bytes stay outside the compact Entity leaf, so exact restore
/// authenticates them independently. Otherwise a storage bit flip could keep
/// every root unchanged yet leave the node unable to retry its historical ACK.
fn verify_restored_outbound_ack(
    replica: &AccountReplica,
    ack: &OutboundAck,
) -> Result<(), StateError> {
    crate::consensus::signing::verify_frame_hanko(
        &ack.frame_hanko,
        &ack.frame_hash,
        replica.owner().as_bytes(),
    )
}

/// Replay a saved proposal against the committed replica and prove it is the
/// same frame: same transactions applied, same account state root, same hash.
struct PendingReplay {
    candidate: AccountReplica,
    outputs_by_tx: Vec<Vec<crate::AccountOutput>>,
}

fn replay_pending(
    replica: &AccountReplica,
    pending: &PendingFrameSnapshot,
    swap_market: &std::sync::Arc<crate::SwapMarketPolicy>,
    settlement: crate::SettlementExecutionContext,
) -> Result<PendingReplay, StateError> {
    let context = crate::AccountExecutionContext::with_market(
        pending.frame.timestamp,
        pending.frame.timestamp,
        pending.frame.j_height,
        pending.frame.height.saturating_sub(1),
        pending.frame.j_height,
        std::sync::Arc::clone(swap_market),
    )
    .with_settlement(settlement);
    let proposer = replica.owner_side();
    let WindowExecution {
        mut candidate,
        applied,
        outputs_by_tx,
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
    Ok(PendingReplay {
        candidate,
        outputs_by_tx,
    })
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
        fields.push(("currentHeight".to_string(), number(self.current_height())?));
        fields.push(("rollbackCount".to_string(), number(self.rollback_count)?));
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
                self.outbound_proposal_binding(pending)?,
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
            fields.push(("currentDisputeProofNonce".to_string(), number(draft.nonce)?));
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
                ("nextProofNonce".to_string(), number(self.next_proof_nonce)?),
            ]),
        ));
        if let Some(ack) = &self.last_outbound_ack {
            fields.push((
                "lastOutboundAckFrame".to_string(),
                CanonicalValue::Object(vec![
                    ("height".to_string(), number(ack.height)?),
                    (
                        "counterpartyEntityId".to_string(),
                        CanonicalValue::String(self.replica.counterparty().to_string()),
                    ),
                    ("response".to_string(), self.ack_binding(ack)?),
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
                number(dispute.nonce)?,
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
        self.replica
            .envelope()
            .reproject(fields, mempool)
            .map_err(|error| StateError::Envelope(error.to_string()))
    }

    /// The signed proposal still waiting for its ack, as the Entity commits
    /// it: which message carried it, between whom, and what it binds.
    ///
    /// Parity target: `compactAccountInputBinding`
    /// (core/entity/consensus/state-root.ts) over `pendingAccountInput`.
    fn outbound_proposal_binding(
        &self,
        pending: &PendingFrame,
    ) -> Result<CanonicalValue, StateError> {
        let mut fields = vec![
            (
                "kind".to_string(),
                CanonicalValue::String(
                    if pending.bundled_ack.is_some() {
                        "ack_frame"
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
                    ("height".to_string(), number(pending.frame.height)?),
                    (
                        "frameHash".to_string(),
                        CanonicalValue::String(hex_prefixed(&pending.state_hash)),
                    ),
                ];
                if let Some(draft) = &pending.proposal_dispute {
                    proposal.push(("disputeHanko".to_string(), dispute_binding(draft)?));
                }
                CanonicalValue::Object(proposal)
            }),
        ];
        if let Some(ack) = &pending.bundled_ack {
            fields.push(("ack".to_string(), ack_fields(ack)?));
        }
        Ok(CanonicalValue::Object(fields))
    }

    /// The standalone acknowledgement message this side sent, as the Entity
    /// commits it inside `lastOutboundAckFrame`.
    fn ack_binding(&self, ack: &OutboundAck) -> Result<CanonicalValue, StateError> {
        Ok(CanonicalValue::Object(vec![
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
            ("ack".to_string(), ack_fields(ack)?),
        ]))
    }
}

/// The recovery proof as the leaf commits it: the four fields that identify
/// which proof, never the signature over it.
///
/// Parity target: `compactDisputeHanko` (core/entity/consensus/state-root.ts).
fn dispute_binding(draft: &DisputeDraft) -> Result<CanonicalValue, StateError> {
    Ok(CanonicalValue::Object(vec![
        (
            "hash".to_string(),
            CanonicalValue::String(hex_prefixed(&draft.hash)),
        ),
        (
            "proofBodyHash".to_string(),
            CanonicalValue::String(hex_prefixed(&draft.proof_body_hash)),
        ),
        ("proofNonce".to_string(), number(draft.nonce)?),
        (
            "proposerIsLeft".to_string(),
            CanonicalValue::Bool(draft.proposer_is_left),
        ),
    ]))
}

fn ack_fields(ack: &OutboundAck) -> Result<CanonicalValue, StateError> {
    let mut fields = vec![
        ("height".to_string(), number(ack.height)?),
        (
            "frameHash".to_string(),
            CanonicalValue::String(hex_prefixed(&ack.frame_hash)),
        ),
    ];
    if let Some(draft) = &ack.dispute {
        fields.push(("disputeHanko".to_string(), dispute_binding(draft)?));
    }
    Ok(CanonicalValue::Object(fields))
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
    "lastOutboundAckFrame",
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
    // Nibble table, not `write!`: the formatter machinery showed up in the
    // engine profile, and every frame formats its predecessor's hash.
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = Vec::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(DIGITS[usize::from(byte >> 4)]);
        output.push(DIGITS[usize::from(byte & 0x0f)]);
    }
    // Every byte written is an ASCII hex digit.
    String::from_utf8(output).unwrap_or_default()
}
