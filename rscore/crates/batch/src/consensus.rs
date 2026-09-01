//! The authoritative account store: replicas the engine itself drives.
//!
//! The engine owns Account mempools, frames and signatures. Its commitment is
//! the canonical radix-16 Patricia tree keyed by account id, with the Entity's
//! Account leaf as each value digest.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, OnceLock};

use xln_rscore_engine::{
    AccountConsensus, AccountDomain, AccountEnvelope, AccountFrame, AccountIdentity,
    AccountInputEnvelope, AccountOutput, AccountReplica, AccountState, AccountTx, AckFrameOutcome,
    AckFramePhase, AckOutcome, BoardDelays, BoardHankoRefreshInput, CertifiedBoardAuthority,
    CommittedFrameEvidence, CounterpartyDispute, Disposition, IncomingAck, IncomingFrame,
    IncomingFrameSecurityContext, IncomingOutcome, ProposalOutcome, SignedIncomingFrame,
    SigningIdentity, StandaloneInputOutcome, StateError, apply_board_hanko_refresh,
    apply_incoming_ack_frame_with_authority, apply_incoming_ack_with_authority,
    apply_incoming_frame_with_authority, apply_standalone_dispute, canonical_tx_digest,
    classify_incoming_frame_without_mutation,
};
use xln_rscore_protocol::{CanonicalNumber, CanonicalValue};

use crate::checkpoint::AccountRestore;
use crate::{AccountId, AccountSeed, BatchError};

/// What arrives for one account. `AckFrame` is the only proposal-carrying
/// input. Its ACK is optional; when present, the two phases execute ACK-first:
/// a valid ACK commits even if the bundled proposal is rejected, matching the
/// TypeScript bilateral machine.
#[derive(Clone, Debug)]
pub enum AccountInputKind {
    Ack(IncomingAck),
    AckFrame {
        ack: Option<IncomingAck>,
        frame: Box<IncomingFrame>,
    },
    Dispute(CounterpartyDispute),
    BoardHankoRefresh(BoardHankoRefreshInput),
}

#[derive(Clone, Debug)]
pub struct AccountInput {
    pub envelope: AccountInputEnvelope,
    pub kind: AccountInputKind,
}

#[derive(Clone, Debug)]
pub struct AccountInputRow {
    pub operation_index: u64,
    pub account_id: AccountId,
    /// Trusted owner policy used only when this exact row is an authenticated
    /// H=1 proposal for an Account absent from the resident forest.
    pub genesis_policy: Option<crate::EntityAccountGenesisPolicy>,
    /// Exact current board hash certified by the parent Entity for the peer.
    /// It is local verification context, never copied from the Account input envelope.
    pub certified_board_authority: AccountInputBoardAuthority,
    /// Exact current/previous board record certified by the parent Entity for
    /// the Account owner. Duplicate-frame ACK reuse authenticates this local
    /// historical Hanko independently of the peer authority above.
    pub local_certified_board_authority: AccountInputBoardAuthority,
    pub input: AccountInput,
}

/// Parent-resolved board authority for one untrusted Account input.
///
/// `Unresolved` is deliberately distinct from `Lazy`: absence in peer bytes
/// proves nothing about registration. Only the parent Entity registry may
/// turn it into `Lazy` or `Certified`, and Account execution fails loudly if
/// that resolution step was skipped.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AccountInputBoardAuthority {
    Unresolved,
    Lazy,
    Certified(CertifiedBoardAuthority),
}

impl AccountInputBoardAuthority {
    pub(crate) fn certified(&self) -> Result<Option<&CertifiedBoardAuthority>, BatchError> {
        match self {
            Self::Unresolved => Err(BatchError::BoardAuthorityUnresolved),
            Self::Lazy => Ok(None),
            Self::Certified(authority) => Ok(Some(authority)),
        }
    }
}

/// Parent Entity authority lookup. Implementations resolve only from the
/// Entity-certified registry keyed by the peer; AccountInput bytes never
/// participate in this decision.
pub trait CertifiedBoardAuthorityResolver {
    type Error;

    fn resolve_certified_board(
        &self,
        peer_entity_id: &[u8; 32],
    ) -> Result<AccountInputBoardAuthority, Self::Error>;
}

impl AccountInputRow {
    pub fn resolve_certified_boards<R>(&mut self, resolver: &R) -> Result<(), R::Error>
    where
        R: CertifiedBoardAuthorityResolver,
    {
        self.certified_board_authority =
            resolver.resolve_certified_board(&self.input.envelope.from_entity_id)?;
        self.local_certified_board_authority =
            resolver.resolve_certified_board(&self.input.envelope.to_entity_id)?;
        Ok(())
    }
}

#[derive(Clone, Debug)]
pub enum AccountInputVerdict {
    FrameCommitted {
        height: u64,
        state_hash: [u8; 32],
        /// Raw owner signature paired with `ack_hanko`, retained only until
        /// the parent Entity builds this Runtime frame's signature manifest.
        ack_signature: [u8; 65],
        ack_hanko: Vec<u8>,
        ack_dispute_signature: Option<[u8; 65]>,
        ack_dispute_hanko: Option<Vec<u8>>,
        /// Exactly what the committed transactions said they did. The Entity
        /// frame hashes these strings, so a publisher that re-derived them
        /// would be signing its own guess.
        events: Vec<String>,
        rolled_back: Option<xln_rscore_engine::RolledBackProposal>,
        committed_frame: Box<CommittedFrameEvidence>,
        /// The recovery proof the acknowledgement this frame produced carries,
        /// so the publisher can send it without reading the account back.
        ack_dispute: Option<xln_rscore_engine::DisputeDraft>,
    },
    FrameCollisionIgnored {
        height: u64,
        /// What this side still holds while it waits to be acknowledged. The
        /// publisher names the count in an event the Entity frame commits.
        queued: usize,
    },
    FrameDuplicate {
        height: u64,
        state_hash: [u8; 32],
        ack_hanko: Vec<u8>,
        ack_dispute: Option<xln_rscore_engine::DisputeDraft>,
    },
    FrameStale {
        height: u64,
        current_height: u64,
    },
    FrameDisputeRequired {
        reason: String,
        evidence_secrets: Vec<xln_rscore_engine::HtlcEvidenceSecret>,
        signed_frame: SignedIncomingFrame,
    },
    FrameRejected {
        reason: String,
    },
    AckCommitted {
        height: u64,
        state_hash: [u8; 32],
        /// The pending frame's own events, released on the same ACK as its
        /// outputs.
        events: Vec<String>,
        committed_frame: Box<CommittedFrameEvidence>,
    },
    AckAccepted {
        height: u64,
    },
    AckRejected {
        reason: String,
    },
    AckFrameApplied {
        ack: Box<AccountInputVerdict>,
        frame: Box<AccountInputVerdict>,
    },
    AckFrameRejected {
        phase: AckFramePhase,
        reason: String,
    },
    DisputeApplied,
    DisputeRejected {
        reason: String,
    },
    BoardHankoRefreshApplied {
        events: Vec<String>,
    },
    BoardHankoRefreshRejected {
        reason: String,
    },
    /// The account is not in this engine, or its transition faulted. The
    /// runtime decides what to do; the engine never guesses.
    Failed(String),
}

#[derive(Clone, Debug)]
pub struct AccountInputResult {
    pub operation_index: u64,
    pub account_id: AccountId,
    pub verdict: AccountInputVerdict,
    /// Transient same-round response control. `Some(true)` forces the ACK
    /// produced by an accepted/duplicate proposal, `Some(false)` cancels an
    /// earlier force after our pending frame was ACKed, and `None` preserves
    /// the earlier decision. No ACK bytes or durable state live here.
    pub force_ack: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AccountAdmissionVerdict {
    Admitted { count: usize },
    Rejected { code: String, message: String },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountAdmissionResult {
    pub operation_index: u64,
    pub account_id: AccountId,
    pub verdict: AccountAdmissionVerdict,
}

/// One attempt to propose, whether or not it produced a frame. A window where
/// every transaction was rejected still moves the account — the mempool is
/// part of the leaf — so the attempt is reported with no frame rather than
/// not reported at all, or the two engines would silently disagree about a
/// tree they both changed.
#[derive(Clone)]
pub struct ProposalRow {
    pub account_id: AccountId,
    /// Exact Entity-local AccountInput authored by Account consensus. Runtime
    /// may add only the destination signer/runtime route; it must never
    /// reconstruct domain, dispute config, watch seed, ACK or proposal bytes.
    pub outbound_input: Option<AccountInput>,
    /// The signed frame, absent when nothing survived the window.
    ///
    /// It carries no outputs: what the frame produced is released with the
    /// peer's ack, never before.
    pub proposed: Option<ProposedRow>,
    /// Every transaction the window could not include, named by the digest of
    /// its canonical form. A count would say that something was dropped
    /// without saying what, which is not enough to compare two engines.
    pub dropped: Vec<DroppedRow>,
    /// Non-retryable HTLC locks the parent Entity must resolve in this same
    /// Entity frame. The exact hashlock and rejection reason are Account
    /// outputs; the parent must not infer them from a digest or log string.
    pub failed_htlc_locks: Vec<FailedHtlcLockRow>,
}

/// The frame an attempt produced.
#[derive(Clone)]
pub struct ProposedRow {
    /// Certification needs only the signed frame height. The complete frame
    /// already lives in `ProposalRow::outbound_input`; retaining it here made
    /// a second full copy of every proposed Account transaction vector.
    pub frame_height: u64,
    pub state_hash: [u8; 32],
    /// Raw owner signature paired with `hanko`, for the parent Entity's
    /// manifest. It is ephemeral and never changes the Account wire shape.
    pub signature: [u8; 65],
    pub hanko: Vec<u8>,
    /// Ephemeral worker-authored dispute witness for the parent Entity
    /// manifest. It never enters the Account replica or durable leaf.
    pub dispute_signature: Option<[u8; 65]>,
    pub dispute_hanko: Option<Vec<u8>>,
    /// The recovery proof the proposal travels with, when it carries one.
    pub dispute: Option<xln_rscore_engine::DisputeDraft>,
    /// The proposal status strings the Entity frame commits.
    pub events: Vec<String>,
    /// Sole exact effect representation in `frame.txs` order. The process
    /// encoder streams its existing flat wire field from these rows; resident
    /// Entity does not release proposal effects before acknowledgement.
    pub outputs_by_tx: Arc<Vec<Vec<AccountOutput>>>,
    /// Present when this proposal also carries the acknowledgement this side
    /// owed, which makes it a `ack_frame` on the wire.
    pub bundled_ack: Option<xln_rscore_engine::OutboundAck>,
}

impl ProposalRow {
    /// Borrow the exact frame carried to the counterparty.
    pub fn incoming_ref(&self) -> Option<&xln_rscore_engine::IncomingFrame> {
        match &self.outbound_input.as_ref()?.kind {
            AccountInputKind::AckFrame { frame, .. } => Some(frame),
            AccountInputKind::Ack(_)
            | AccountInputKind::Dispute(_)
            | AccountInputKind::BoardHankoRefresh(_) => None,
        }
    }

    /// The frame as the counterparty receives it, or `None` when the attempt
    /// produced none.
    pub fn incoming(&self) -> Option<xln_rscore_engine::IncomingFrame> {
        self.incoming_ref().cloned()
    }
}

/// One transaction the proposal window rejected.
#[derive(Clone)]
pub struct DroppedRow {
    pub index: usize,
    pub tx_digest: [u8; 32],
    pub code: &'static str,
    pub message: String,
    pub disposition: Disposition,
}

#[derive(Clone)]
pub struct FailedHtlcLockRow {
    pub hashlock: [u8; 32],
    pub lock_id: String,
    pub reason: String,
    pub upstream_resolution: Option<UpstreamHtlcResolutionRow>,
}

#[derive(Clone)]
pub struct UpstreamHtlcResolutionRow {
    pub account_id: AccountId,
    pub lock_id: String,
    pub reason: String,
}

fn failed_htlc_locks(dropped: &[xln_rscore_engine::DroppedTx]) -> Vec<FailedHtlcLockRow> {
    dropped
        .iter()
        .filter_map(|dropped| match (&dropped.tx, dropped.disposition) {
            (
                xln_rscore_engine::AccountTx::HtlcLock(lock),
                xln_rscore_engine::Disposition::Removed,
            ) => Some(FailedHtlcLockRow {
                hashlock: *lock.hashlock.bytes(),
                lock_id: lock.lock_id.clone(),
                reason: dropped.rejection.message(),
                upstream_resolution: None,
            }),
            _ => None,
        })
        .collect()
}

fn dropped_rows(
    account_id: AccountId,
    dropped: &[xln_rscore_engine::DroppedTx],
) -> Result<Vec<DroppedRow>, BatchError> {
    static PROFILE_DROPS: OnceLock<bool> = OnceLock::new();
    let profile_drops = *PROFILE_DROPS
        .get_or_init(|| std::env::var("XLN_RSCORE_PROFILE_ENTITY").as_deref() == Ok("1"));
    dropped
        .iter()
        .map(|dropped| {
            let row = DroppedRow {
                index: dropped.index,
                tx_digest: canonical_tx_digest(&dropped.tx)
                    .map_err(|error| state_error(account_id, &error))?,
                code: dropped.rejection.code(),
                message: dropped.rejection.message(),
                disposition: dropped.disposition,
            };
            if profile_drops {
                let (kind, operation_id) = match &dropped.tx {
                    AccountTx::SwapOffer { offer_id, .. } => ("swapOffer", offer_id.as_str()),
                    AccountTx::SwapResolve { offer_id, .. } => ("swapResolve", offer_id.as_str()),
                    AccountTx::SwapCancelRequest { offer_id } => {
                        ("swapCancel", offer_id.as_str())
                    }
                    AccountTx::HtlcLock(lock) => ("htlcLock", lock.lock_id.as_str()),
                    AccountTx::HtlcResolve(resolve) => ("htlcResolve", resolve.lock_id.as_str()),
                    _ => ("other", "-"),
                };
                eprintln!(
                    "RSCORE_ACCOUNT_TX_DROPPED account={} kind={} operationId={} code={} disposition={:?}",
                    account_id, kind, operation_id, row.code, row.disposition,
                );
            }
            Ok(row)
        })
        .collect()
}

fn outgoing_envelope(account: &AccountConsensus) -> AccountInputEnvelope {
    let replica = account.replica();
    AccountInputEnvelope {
        from_entity_id: *replica.owner().as_bytes(),
        to_entity_id: *replica.counterparty().as_bytes(),
        domain: replica.state().identity().domain().clone(),
        dispute_config: replica.state().dispute_config(),
        watch_seed: Some(replica.state().identity().watch_seed().clone()),
    }
}

fn dispute_input(
    draft: &xln_rscore_engine::DisputeDraft,
) -> xln_rscore_engine::CounterpartyDispute {
    xln_rscore_engine::CounterpartyDispute {
        hanko: draft.hanko.clone(),
        hash: draft.hash,
        proof_body_hash: draft.proof_body_hash,
        nonce: draft.nonce,
        proposer_is_left: draft.proposer_is_left,
    }
}

fn outgoing_account_input(
    account: &AccountConsensus,
    frame: AccountFrame,
    state_hash: [u8; 32],
    hanko: Vec<u8>,
    dispute: Option<&xln_rscore_engine::DisputeDraft>,
    bundled_ack: Option<&xln_rscore_engine::OutboundAck>,
) -> AccountInput {
    let envelope = outgoing_envelope(account);
    let frame = IncomingFrame {
        frame,
        state_hash,
        frame_hanko: Some(hanko),
        dispute: dispute.map(dispute_input),
    };
    let kind = match bundled_ack {
        Some(ack) => AccountInputKind::AckFrame {
            ack: Some(IncomingAck {
                height: ack.height,
                frame_hash: ack.frame_hash,
                frame_hanko: Some(ack.frame_hanko.clone()),
                dispute: ack.dispute.as_ref().map(dispute_input),
            }),
            frame: Box::new(frame),
        },
        None => AccountInputKind::AckFrame {
            ack: None,
            frame: Box::new(frame),
        },
    };
    AccountInput { envelope, kind }
}

pub(crate) fn outbound_ack_input(account: &AccountConsensus) -> Option<AccountInput> {
    account.outbound_ack().map(|ack| AccountInput {
        envelope: outgoing_envelope(account),
        kind: AccountInputKind::Ack(IncomingAck {
            height: ack.height,
            frame_hash: ack.frame_hash,
            frame_hanko: Some(ack.frame_hanko.clone()),
            dispute: ack.dispute.as_ref().map(dispute_input),
        }),
    })
}

/// Retry the exact Account input which still owns the acknowledgement.
///
/// If a pending H+1 proposal originally carried ACK(H), reducing its retry to
/// standalone ACK(H) creates new wire bytes. The peer may already have
/// committed H+1, in which case those newly-created old bytes are necessarily
/// unmatched. Re-carry the pending proposal until it is committed or rolled
/// back; only the retained ACK remains after that terminal.
pub(crate) fn outbound_ack_retry_input(account: &AccountConsensus) -> Option<AccountInput> {
    if let Some(pending) = account.pending()
        && let Some(bundled_ack) = pending.bundled_ack()
    {
        return Some(outgoing_account_input(
            account,
            pending.frame.clone(),
            pending.state_hash,
            pending.hanko.clone(),
            pending.proposal_dispute(),
            Some(bundled_ack),
        ));
    }
    outbound_ack_input(account)
}

pub(crate) fn force_ack_directive(pure_ack: bool, verdict: &AccountInputVerdict) -> Option<bool> {
    let requires_ack = match verdict {
        AccountInputVerdict::FrameCommitted { .. } | AccountInputVerdict::FrameDuplicate { .. } => {
            true
        }
        AccountInputVerdict::AckFrameApplied { frame, .. } => {
            force_ack_directive(false, frame).unwrap_or(false)
        }
        _ => false,
    };
    if requires_ack {
        Some(true)
    } else if pure_ack && matches!(verdict, AccountInputVerdict::AckCommitted { .. }) {
        Some(false)
    } else {
        None
    }
}

pub(crate) fn proposal_row(
    account_id: AccountId,
    outcome: ProposalOutcome,
    account: &AccountConsensus,
) -> Result<ProposalRow, BatchError> {
    Ok(match outcome {
        ProposalOutcome::Idle { dropped } => ProposalRow {
            account_id,
            outbound_input: None,
            proposed: None,
            failed_htlc_locks: failed_htlc_locks(&dropped),
            dropped: dropped_rows(account_id, &dropped)?,
        },
        ProposalOutcome::Proposed(proposed) => {
            let proposed = *proposed;
            let failed_htlc_locks = failed_htlc_locks(&proposed.dropped);
            let dropped = dropped_rows(account_id, &proposed.dropped)?;
            let frame_height = proposed.frame.height;
            let outbound_input = Some(outgoing_account_input(
                account,
                proposed.frame,
                proposed.state_hash,
                proposed.hanko.clone(),
                proposed.dispute.as_ref(),
                proposed.bundled_ack.as_ref(),
            ));
            let proposed = ProposedRow {
                frame_height,
                state_hash: proposed.state_hash,
                signature: proposed.signature,
                hanko: proposed.hanko,
                dispute_signature: proposed.dispute_signature,
                dispute_hanko: proposed.dispute_hanko,
                dispute: proposed.dispute,
                events: proposed.events,
                outputs_by_tx: proposed.outputs_by_tx,
                bundled_ack: proposed.bundled_ack,
            };
            ProposalRow {
                account_id,
                outbound_input,
                proposed: Some(proposed),
                dropped,
                failed_htlc_locks,
            }
        }
    })
}

pub(crate) fn apply_one(
    account_id: AccountId,
    account: &mut AccountConsensus,
    identity: &SigningIdentity,
    input: AccountInput,
    security: IncomingFrameSecurityContext<'_>,
    swap_market: &std::sync::Arc<xln_rscore_engine::SwapMarketPolicy>,
) -> (AccountInputVerdict, bool) {
    if let Some(verdict) =
        apply_one_without_mutation(account_id, account, identity, &input, security)
    {
        return (verdict, false);
    }
    let clock = security.clock;
    let peer_authority = security.peer_certified_board_authority;
    let local_authority = security.local_certified_board_authority;
    let verdict = match input.kind {
        AccountInputKind::Ack(ack) => {
            match apply_incoming_ack_with_authority(
                account,
                &input.envelope,
                clock,
                ack,
                peer_authority,
            ) {
                Ok(outcome) => ack_verdict(outcome),
                Err(error) => AccountInputVerdict::Failed(error.to_string()),
            }
        }
        AccountInputKind::AckFrame { ack, frame } => match ack {
            Some(ack) => match apply_incoming_ack_frame_with_authority(
                account,
                identity,
                &input.envelope,
                ack,
                *frame,
                swap_market,
                IncomingFrameSecurityContext {
                    clock,
                    peer_certified_board_authority: peer_authority,
                    local_certified_board_authority: local_authority,
                },
            ) {
                Ok(outcome) => ack_frame_verdict(outcome),
                Err(error) => AccountInputVerdict::Failed(error.to_string()),
            },
            None => match apply_incoming_frame_with_authority(
                account,
                identity,
                &input.envelope,
                *frame,
                swap_market,
                IncomingFrameSecurityContext {
                    clock,
                    peer_certified_board_authority: peer_authority,
                    local_certified_board_authority: local_authority,
                },
            ) {
                Ok(outcome) => incoming_verdict(outcome),
                Err(error) => AccountInputVerdict::Failed(error.to_string()),
            },
        },
        AccountInputKind::Dispute(dispute) => {
            match apply_standalone_dispute(account, &input.envelope, clock, dispute, peer_authority)
            {
                Ok(outcome) => standalone_dispute_verdict(outcome),
                Err(error) => AccountInputVerdict::Failed(error.to_string()),
            }
        }
        AccountInputKind::BoardHankoRefresh(refresh) => {
            match apply_board_hanko_refresh(
                account,
                &input.envelope,
                clock,
                refresh,
                peer_authority,
            ) {
                Ok(outcome) => board_hanko_refresh_verdict(outcome),
                Err(error) => AccountInputVerdict::Failed(error.to_string()),
            }
        }
    };
    let changed = verdict_changes_account(&verdict);
    (verdict, changed)
}

/// Return only outcomes which are guaranteed not to mutate Account state.
///
/// The resident path uses this against its borrowed head before allocating a
/// mutable candidate. `apply_one` calls the same classifier, so the fast path
/// cannot drift into an alternate replay/rejection formula.
pub(crate) fn apply_one_without_mutation(
    account_id: AccountId,
    account: &AccountConsensus,
    identity: &SigningIdentity,
    input: &AccountInput,
    security: IncomingFrameSecurityContext<'_>,
) -> Option<AccountInputVerdict> {
    if account_id.as_bytes() != &input.envelope.from_entity_id {
        return Some(AccountInputVerdict::Failed(
            "ACCOUNT_INPUT_ACCOUNT_ID_MISMATCH".to_string(),
        ));
    }
    if !account.accepts_external_input() {
        // TypeScript drops frozen AccountInput before ACK/replay or board
        // verification can mutate the Account. J finality remains available
        // through the separate Entity-owned envelope-update path.
        return Some(AccountInputVerdict::Failed(
            "ACCOUNT_INPUT_STATUS_FROZEN".to_string(),
        ));
    }
    if let Some(authority) = security.peer_certified_board_authority
        && let Err(error) = authority.assert_entity(&input.envelope.from_entity_id)
    {
        return Some(AccountInputVerdict::Failed(error.to_string()));
    }
    let AccountInputKind::AckFrame { ack: None, frame } = &input.kind else {
        return None;
    };
    match classify_incoming_frame_without_mutation(
        account,
        identity,
        &input.envelope,
        frame,
        security,
    ) {
        Ok(Some(outcome)) => Some(incoming_verdict(outcome)),
        Ok(None) => None,
        Err(error) => Some(AccountInputVerdict::Failed(error.to_string())),
    }
}

fn standalone_dispute_verdict(outcome: StandaloneInputOutcome) -> AccountInputVerdict {
    match outcome {
        StandaloneInputOutcome::Applied { .. } => AccountInputVerdict::DisputeApplied,
        StandaloneInputOutcome::Rejected { reason } => {
            AccountInputVerdict::DisputeRejected { reason }
        }
    }
}

fn board_hanko_refresh_verdict(outcome: StandaloneInputOutcome) -> AccountInputVerdict {
    match outcome {
        StandaloneInputOutcome::Applied { events } => {
            AccountInputVerdict::BoardHankoRefreshApplied { events }
        }
        StandaloneInputOutcome::Rejected { reason } => {
            AccountInputVerdict::BoardHankoRefreshRejected { reason }
        }
    }
}

fn incoming_verdict(outcome: IncomingOutcome) -> AccountInputVerdict {
    match outcome {
        IncomingOutcome::Committed {
            height,
            state_hash,
            ack_signature,
            ack_hanko,
            ack_dispute_signature,
            ack_dispute_hanko,
            events,
            rolled_back,
            committed_frame,
            ack_dispute,
        } => AccountInputVerdict::FrameCommitted {
            height,
            state_hash,
            ack_signature,
            ack_hanko,
            ack_dispute_signature: ack_dispute_signature.map(|signature| *signature),
            ack_dispute_hanko,
            events,
            rolled_back,
            committed_frame,
            ack_dispute: ack_dispute.map(|draft| *draft),
        },
        IncomingOutcome::CollisionIgnored { height, queued } => {
            AccountInputVerdict::FrameCollisionIgnored { height, queued }
        }
        IncomingOutcome::Duplicate {
            height,
            state_hash,
            ack_hanko,
            ack_dispute,
        } => AccountInputVerdict::FrameDuplicate {
            height,
            state_hash,
            ack_hanko,
            ack_dispute: ack_dispute.map(|draft| *draft),
        },
        IncomingOutcome::Stale {
            height,
            current_height,
        } => AccountInputVerdict::FrameStale {
            height,
            current_height,
        },
        IncomingOutcome::DisputeRequired {
            reason,
            evidence_secrets,
            signed_frame,
        } => AccountInputVerdict::FrameDisputeRequired {
            reason,
            evidence_secrets,
            signed_frame: *signed_frame,
        },
        IncomingOutcome::Rejected { reason } => AccountInputVerdict::FrameRejected { reason },
    }
}

fn ack_verdict(outcome: AckOutcome) -> AccountInputVerdict {
    match outcome {
        AckOutcome::Committed {
            height,
            state_hash,
            events,
            committed_frame,
        } => AccountInputVerdict::AckCommitted {
            height,
            state_hash,
            events,
            committed_frame,
        },
        AckOutcome::Accepted { height } => AccountInputVerdict::AckAccepted { height },
        AckOutcome::Rejected { reason } => AccountInputVerdict::AckRejected { reason },
    }
}

fn ack_frame_verdict(outcome: AckFrameOutcome) -> AccountInputVerdict {
    match outcome {
        AckFrameOutcome::Replay { frame } => incoming_verdict(*frame),
        AckFrameOutcome::Applied { ack, frame } => AccountInputVerdict::AckFrameApplied {
            ack: Box::new(ack_verdict(*ack)),
            frame: Box::new(incoming_verdict(*frame)),
        },
        AckFrameOutcome::Rejected { phase, reason } => {
            AccountInputVerdict::AckFrameRejected { phase, reason }
        }
    }
}

fn verdict_changes_account(verdict: &AccountInputVerdict) -> bool {
    match verdict {
        AccountInputVerdict::FrameCommitted { .. }
        | AccountInputVerdict::AckCommitted { .. }
        | AccountInputVerdict::DisputeApplied
        | AccountInputVerdict::BoardHankoRefreshApplied { .. } => true,
        AccountInputVerdict::AckFrameApplied { ack, frame } => {
            verdict_changes_account(ack) || verdict_changes_account(frame)
        }
        AccountInputVerdict::FrameCollisionIgnored { .. }
        | AccountInputVerdict::FrameDuplicate { .. }
        | AccountInputVerdict::FrameStale { .. }
        | AccountInputVerdict::FrameDisputeRequired { .. }
        | AccountInputVerdict::FrameRejected { .. }
        | AccountInputVerdict::AckAccepted { .. }
        | AccountInputVerdict::AckRejected { .. }
        | AccountInputVerdict::AckFrameRejected { .. }
        | AccountInputVerdict::DisputeRejected { .. }
        | AccountInputVerdict::BoardHankoRefreshRejected { .. }
        | AccountInputVerdict::Failed(_) => false,
    }
}

pub(crate) fn verdict_commits_genesis(verdict: &AccountInputVerdict) -> bool {
    match verdict {
        AccountInputVerdict::FrameCommitted { height: 1, .. } => true,
        AccountInputVerdict::AckFrameApplied { frame, .. } => verdict_commits_genesis(frame),
        AccountInputVerdict::FrameCommitted { .. }
        | AccountInputVerdict::FrameCollisionIgnored { .. }
        | AccountInputVerdict::FrameDuplicate { .. }
        | AccountInputVerdict::FrameStale { .. }
        | AccountInputVerdict::FrameDisputeRequired { .. }
        | AccountInputVerdict::FrameRejected { .. }
        | AccountInputVerdict::AckCommitted { .. }
        | AccountInputVerdict::AckAccepted { .. }
        | AccountInputVerdict::AckRejected { .. }
        | AccountInputVerdict::AckFrameRejected { .. }
        | AccountInputVerdict::DisputeApplied
        | AccountInputVerdict::DisputeRejected { .. }
        | AccountInputVerdict::BoardHankoRefreshApplied { .. }
        | AccountInputVerdict::BoardHankoRefreshRejected { .. }
        | AccountInputVerdict::Failed(_) => false,
    }
}

/// Accept only the pre-input Account genesis that the Entity itself creates.
///
/// Comparing against a Rust-constructed empty state is intentionally stronger
/// than a hand-maintained list of "must be empty" sections. When AccountState
/// gains another committed financial section, its root changes and Create is
/// fail-closed until that section is canonically empty too.
pub(crate) fn validate_genesis_seed(
    owner_entity_id: [u8; 32],
    seed: &AccountSeed,
) -> Result<AccountConsensus, BatchError> {
    let account_id = seed.account_id;
    if seed.replica.owner().as_bytes() != &owner_entity_id {
        return Err(BatchError::WaveAccountOwner {
            account_id,
            entity_id: hex_of(&owner_entity_id),
        });
    }
    if seed.replica.counterparty().as_bytes() != account_id.as_bytes() {
        return Err(BatchError::WaveCreateCounterparty {
            account_id,
            counterparty: hex_of(seed.replica.counterparty().as_bytes()),
        });
    }
    if seed.consensus.is_some() {
        return Err(BatchError::WaveCreateConsensus(account_id));
    }
    let mempool_len = seed.replica.envelope().mempool_len();
    if mempool_len != 0 {
        return Err(BatchError::WaveCreateMempool {
            account_id,
            actual: mempool_len,
        });
    }
    let delta_transformer = seed
        .replica
        .delta_transformer()
        .copied()
        .ok_or(BatchError::WaveCreateTransformer(account_id))?;

    let state = seed.replica.state();
    let expected_state =
        AccountState::new(state.identity().clone(), state.dispute_config(), Vec::new())
            .map_err(|error| state_error(account_id, &error))?;
    let expected = expected_state
        .payment_profile_account_state_root()
        .map_err(|error| state_error(account_id, &error))?;
    let actual = state
        .payment_profile_account_state_root()
        .map_err(|error| state_error(account_id, &error))?;
    if actual != expected {
        return Err(BatchError::WaveCreateNonGenesis {
            account_id,
            actual: hex_of(&actual),
            expected: hex_of(&expected),
        });
    }

    // The seed proves the Entity built the one canonical H=0 shell; it is not
    // a replica snapshot we trust. Rebuild the financial state and envelope
    // from Rust-owned constants so an unmodelled seed field can never become
    // authoritative merely because it happened to hash into the imported
    // leaf. Only status/public pin and the two validated empty collection
    // commitments survive as carried fields; consensus derives every H=0
    // height/frame/proof field itself.
    let envelope = validate_genesis_envelope(account_id, &seed.replica)?;
    let mut replica = AccountReplica::new(seed.replica.owner().clone(), expected_state)
        .map_err(|error| state_error(account_id, &error))?;
    replica.set_delta_transformer(delta_transformer);
    replica.set_envelope(envelope);
    Ok(AccountConsensus::new(replica))
}

fn validate_genesis_envelope(
    account_id: AccountId,
    replica: &AccountReplica,
) -> Result<AccountEnvelope, BatchError> {
    let fields = replica.envelope().fields();
    let mut actual: BTreeMap<&str, &CanonicalValue> = BTreeMap::new();
    for (name, value) in fields {
        if actual.insert(name.as_str(), value).is_some() {
            return Err(create_envelope_error(
                account_id,
                format!("DUPLICATE_FIELD:{name}"),
            ));
        }
    }
    let public_pinned = match actual.get("publicPinned") {
        None => false,
        Some(CanonicalValue::Bool(true)) => true,
        Some(_) => {
            return Err(create_envelope_error(
                account_id,
                "PUBLIC_PINNED_NON_CANONICAL".to_string(),
            ));
        }
    };
    let policy_root = validate_genesis_shadow(account_id, actual.get("shadow").copied())?;
    let expected = genesis_envelope_fields(replica, public_pinned, &policy_root);
    if actual.len() != expected.len() {
        let expected_names: BTreeSet<&str> =
            expected.iter().map(|(name, _)| name.as_str()).collect();
        if let Some(extra) = actual.keys().find(|name| !expected_names.contains(**name)) {
            return Err(create_envelope_error(
                account_id,
                format!("EXTRA_FIELD:{extra}"),
            ));
        }
        if let Some(missing) = expected
            .iter()
            .map(|(name, _)| name.as_str())
            .find(|name| !actual.contains_key(name))
        {
            return Err(create_envelope_error(
                account_id,
                format!("MISSING_FIELD:{missing}"),
            ));
        }
        return Err(create_envelope_error(account_id, "FIELD_COUNT".to_string()));
    }
    for (name, expected_value) in &expected {
        let Some(actual_value) = actual.get(name.as_str()) else {
            return Err(create_envelope_error(
                account_id,
                format!("MISSING_FIELD:{name}"),
            ));
        };
        if !canonical_exact_eq(actual_value, expected_value) {
            return Err(create_envelope_error(
                account_id,
                format!("FIELD_NON_CANONICAL:{name}"),
            ));
        }
    }

    let carried = expected
        .into_iter()
        .filter(|(name, _)| {
            matches!(
                name.as_str(),
                "status" | "publicPinned" | "pendingWithdrawals" | "shadow"
            )
        })
        .collect();
    AccountEnvelope::new_with_rebalance_shadow_rows(
        carried,
        Vec::new(),
        replica.envelope().rebalance_shadow_policy_rows(),
        Vec::new(),
    )
    .map_err(|error| create_envelope_error(account_id, error.to_string()))
}

/// Build the one canonical locally-opened H=0 Account shell. Entity code
/// supplies intent; the Account layer owns every shell byte and validates the
/// result through the same Create gate used by resident workers.
#[derive(Clone, Debug)]
pub struct LocalGenesisSeedParams {
    pub owner_entity_id: [u8; 32],
    pub account_id: AccountId,
    pub domain: AccountDomain,
    pub watch_seed: xln_rscore_engine::WatchSeed,
    pub dispute_config: xln_rscore_engine::AccountDisputeConfig,
    pub delta_transformer: [u8; 20],
    pub public_pinned: bool,
    pub policy_rows: Vec<(u32, CanonicalValue)>,
}

pub fn build_local_genesis_seed(params: LocalGenesisSeedParams) -> Result<AccountSeed, BatchError> {
    let LocalGenesisSeedParams {
        owner_entity_id,
        account_id,
        domain,
        watch_seed,
        dispute_config,
        delta_transformer,
        public_pinned,
        policy_rows,
    } = params;
    let owner =
        parse_entity_id(owner_entity_id).map_err(|error| state_error(account_id, &error))?;
    let peer =
        parse_entity_id(*account_id.as_bytes()).map_err(|error| state_error(account_id, &error))?;
    if owner == peer {
        return Err(BatchError::WaveCreateCounterparty {
            account_id,
            counterparty: hex_of(account_id.as_bytes()),
        });
    }
    let (left, right) = if owner < peer {
        (owner.clone(), peer)
    } else {
        (peer, owner.clone())
    };
    let identity = AccountIdentity::new(domain, left, right, watch_seed)
        .map_err(|error| state_error(account_id, &error))?;
    let state = AccountState::new(identity, dispute_config, Vec::new())
        .map_err(|error| state_error(account_id, &error))?;
    let mut replica =
        AccountReplica::new(owner, state).map_err(|error| state_error(account_id, &error))?;
    replica.set_delta_transformer(delta_transformer);
    let empty_root = format!("0x{}", hex_of(&[0_u8; 32]));
    let fields = genesis_envelope_fields(&replica, public_pinned, &empty_root);
    let envelope = AccountEnvelope::new(fields, Vec::new())
        .map_err(|error| create_envelope_error(account_id, error.to_string()))?;
    replica.set_envelope(envelope);
    for (token_id, policy) in policy_rows {
        let token = xln_rscore_engine::TokenId::new(token_id)
            .map_err(|error| state_error(account_id, &error))?;
        replica
            .set_rebalance_shadow_policy(token, policy)
            .map_err(|error| state_error(account_id, &error))?;
    }
    let seed = AccountSeed {
        account_id,
        replica,
        consensus: None,
    };
    let canonical = validate_genesis_seed(owner_entity_id, &seed)?;
    Ok(AccountSeed {
        account_id,
        replica: canonical.replica().clone(),
        consensus: None,
    })
}

fn genesis_envelope_fields(
    replica: &AccountReplica,
    public_pinned: bool,
    policy_root: &str,
) -> Vec<(String, CanonicalValue)> {
    let zero_root = CanonicalValue::String(format!("0x{}", hex_of(&[0_u8; 32])));
    let mut fields = vec![(
        "status".to_string(),
        CanonicalValue::String("active".to_string()),
    )];
    if public_pinned {
        fields.push(("publicPinned".to_string(), CanonicalValue::Bool(true)));
    }
    fields.extend([
        (
            "currentHeight".to_string(),
            CanonicalValue::Number(CanonicalNumber::from_u32(0)),
        ),
        (
            "rollbackCount".to_string(),
            CanonicalValue::Number(CanonicalNumber::from_u32(0)),
        ),
        (
            "proofHeader".to_string(),
            CanonicalValue::Object(vec![
                (
                    "fromEntity".to_string(),
                    CanonicalValue::String(replica.owner().to_string()),
                ),
                (
                    "toEntity".to_string(),
                    CanonicalValue::String(replica.counterparty().to_string()),
                ),
                (
                    "nextProofNonce".to_string(),
                    CanonicalValue::Number(CanonicalNumber::from_u32(1)),
                ),
            ]),
        ),
        (
            "currentFrameHash".to_string(),
            CanonicalValue::String(String::new()),
        ),
        ("pendingWithdrawals".to_string(), zero_root.clone()),
        (
            "shadow".to_string(),
            CanonicalValue::Object(vec![(
                "rebalance".to_string(),
                CanonicalValue::Object(vec![
                    (
                        "policyRoot".to_string(),
                        CanonicalValue::String(policy_root.to_string()),
                    ),
                    ("submittedAtByTokenRoot".to_string(), zero_root),
                ]),
            )]),
        ),
    ]);
    fields
}

/// The rebalance routing policy is Entity-owned rather than an Account
/// financial transition, so Create carries its already-computed Patricia
/// root. The protocol fingerprint binds this exact two-root projection; this
/// validator admits no quote/request/evidence bodies and requires the
/// submitted-at tree to still be empty at H=0. A later typed CreateSpec can
/// carry the policy rows and let Rust recompute this root, without widening
/// today's seed surface.
fn validate_genesis_shadow(
    account_id: AccountId,
    shadow: Option<&CanonicalValue>,
) -> Result<String, BatchError> {
    let Some(CanonicalValue::Object(shadow)) = shadow else {
        return Err(create_envelope_error(
            account_id,
            "FIELD_NON_CANONICAL:shadow".to_string(),
        ));
    };
    let [(rebalance_name, CanonicalValue::Object(rebalance))] = shadow.as_slice() else {
        return Err(create_envelope_error(
            account_id,
            "FIELD_NON_CANONICAL:shadow".to_string(),
        ));
    };
    if rebalance_name != "rebalance" {
        return Err(create_envelope_error(
            account_id,
            "FIELD_NON_CANONICAL:shadow".to_string(),
        ));
    }
    let [
        (policy_name, CanonicalValue::String(policy_root)),
        (submitted_name, submitted_root),
    ] = rebalance.as_slice()
    else {
        return Err(create_envelope_error(
            account_id,
            "FIELD_NON_CANONICAL:shadow.rebalance".to_string(),
        ));
    };
    if policy_name != "policyRoot"
        || !is_canonical_root_text(policy_root)
        || submitted_name != "submittedAtByTokenRoot"
        || !canonical_exact_eq(
            submitted_root,
            &CanonicalValue::String(format!("0x{}", hex_of(&[0_u8; 32]))),
        )
    {
        return Err(create_envelope_error(
            account_id,
            "FIELD_NON_CANONICAL:shadow.rebalance".to_string(),
        ));
    }
    Ok(policy_root.clone())
}

fn is_canonical_root_text(value: &str) -> bool {
    value.len() == 66
        && value.starts_with("0x")
        && value
            .as_bytes()
            .iter()
            .skip(2)
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
}

fn canonical_exact_eq(actual: &CanonicalValue, expected: &CanonicalValue) -> bool {
    match (actual, expected) {
        (CanonicalValue::Null, CanonicalValue::Null) => true,
        (CanonicalValue::Bool(left), CanonicalValue::Bool(right)) => left == right,
        (CanonicalValue::Number(left), CanonicalValue::Number(right)) => left == right,
        (CanonicalValue::BigInt(left), CanonicalValue::BigInt(right)) => left == right,
        (CanonicalValue::String(left), CanonicalValue::String(right)) => left == right,
        (CanonicalValue::Array(left), CanonicalValue::Array(right))
        | (CanonicalValue::Set(left), CanonicalValue::Set(right)) => {
            left.len() == right.len()
                && left
                    .iter()
                    .zip(right)
                    .all(|(left, right)| canonical_exact_eq(left, right))
        }
        (CanonicalValue::Map(left), CanonicalValue::Map(right)) => {
            left.len() == right.len()
                && left.iter().zip(right).all(
                    |((left_key, left_value), (right_key, right_value))| {
                        canonical_exact_eq(left_key, right_key)
                            && canonical_exact_eq(left_value, right_value)
                    },
                )
        }
        (CanonicalValue::Object(left), CanonicalValue::Object(right)) => {
            left.len() == right.len()
                && left.iter().zip(right).all(
                    |((left_name, left_value), (right_name, right_value))| {
                        left_name == right_name && canonical_exact_eq(left_value, right_value)
                    },
                )
        }
        _ => false,
    }
}

fn create_envelope_error(account_id: AccountId, detail: String) -> BatchError {
    BatchError::WaveCreateEnvelope { account_id, detail }
}

pub(crate) fn active(account: &AccountConsensus) -> Result<bool, BatchError> {
    Ok(
        match account
            .replica()
            .envelope()
            .fields()
            .iter()
            .find(|(name, _)| name == "status")
            .map(|(_, value)| value)
        {
            None => true,
            Some(CanonicalValue::String(value)) => value == "active",
            Some(_) => false,
        },
    )
}

pub(crate) fn proposable(account: &AccountConsensus) -> Result<bool, BatchError> {
    if account.pending().is_some() {
        return Ok(false);
    }
    if !active(account)? {
        return Ok(false);
    }
    let locks_full = account.replica().state().htlc_slots_full();
    Ok(account
        .mempool()
        .iter()
        .any(|tx| !locks_full || !matches!(tx, AccountTx::HtlcLock(_))))
}

/// Rebuild one restored account using the same canonical path as the legacy
/// forest. Resident workers call this before taking ownership of the value;
/// keeping the constructor here prevents the two stores from drifting on
/// pending-frame replay or swap-market validation.
pub(crate) fn restore_seed_account(
    seed: AccountSeed,
    swap_market: &std::sync::Arc<xln_rscore_engine::SwapMarketPolicy>,
) -> Result<(AccountId, AccountConsensus, [u8; 32]), BatchError> {
    let account_id = seed.account_id;
    let account = match seed.consensus {
        None => AccountConsensus::new(seed.replica),
        Some(snapshot) => {
            AccountConsensus::restore_from_checkpoint(seed.replica, snapshot, swap_market).map_err(
                |error| BatchError::SeedRestore {
                    account_id,
                    detail: error.to_string(),
                },
            )?
        }
    };
    let leaf = leaf_root(account_id, &account)?;
    Ok((account_id, account, leaf))
}

pub(crate) struct RestoredCheckpointAccount {
    pub account_id: AccountId,
    pub account: AccountConsensus,
    pub leaf: [u8; 32],
    pub owner: [u8; 32],
    pub signer_id: String,
}

/// Reconstruct and authenticate one exact checkpoint row. Both resident and
/// legacy forests use this one path, so pending-frame replay, retained Hanko
/// validation, and the claimed leaf cannot drift between restore backends.
pub(crate) fn restore_checkpoint_account(
    row: AccountRestore,
    swap_market: &std::sync::Arc<xln_rscore_engine::SwapMarketPolicy>,
) -> Result<RestoredCheckpointAccount, BatchError> {
    let account_id = row.account_id;
    let owner = *row.replica.owner().as_bytes();
    if let Some(pending) = row.consensus.pending.as_ref() {
        xln_rscore_engine::verify_frame_hanko(&pending.hanko, &pending.state_hash, &owner)
            .map_err(|error| state_error(account_id, &error))?;
    }
    if let (Some(current), Some(counterparty_hanko)) = (
        row.consensus.current.as_ref(),
        row.consensus.counterparty_frame_hanko.as_ref(),
    ) {
        xln_rscore_engine::verify_frame_hanko(
            counterparty_hanko,
            &current.state_hash,
            row.replica.counterparty().as_bytes(),
        )
        .map_err(|error| state_error(account_id, &error))?;
    }
    if let (Some(current), Some(local_hanko)) = (
        row.consensus.current.as_ref(),
        row.consensus.local_committed_frame_hanko.as_ref(),
    ) {
        xln_rscore_engine::verify_frame_hanko(local_hanko, &current.state_hash, &owner)
            .map_err(|error| state_error(account_id, &error))?;
    }
    let claimed_leaf = row.account_leaf;
    let account =
        AccountConsensus::restore_from_checkpoint(row.replica, row.consensus, swap_market)
            .map_err(|error| state_error(account_id, &error))?;
    let leaf = leaf_root(account_id, &account)?;
    if leaf != claimed_leaf {
        return Err(BatchError::CheckpointAccountLeaf {
            account_id,
            actual: hex_of(&leaf),
            expected: hex_of(&claimed_leaf),
        });
    }
    Ok(RestoredCheckpointAccount {
        account_id,
        account,
        leaf,
        owner,
        signer_id: row.signer_id,
    })
}

/// Construct the exact local H=0 shell for a previously unknown peer, using
/// owner policy for every field the peer is not allowed to choose. This value
/// is only a replay candidate: the caller must authenticate and commit the H=1
/// frame before inserting it into the resident forest.
pub(crate) fn inbound_genesis_account(
    account_id: AccountId,
    owner_entity_id: [u8; 32],
    input: &AccountInput,
    policy: &crate::EntityAccountGenesisPolicy,
) -> Result<AccountConsensus, BatchError> {
    if policy.public_pinned {
        return Err(BatchError::InboundGenesis {
            account_id,
            detail: "PUBLIC_PINNED_FORBIDDEN".to_string(),
        });
    }
    let envelope = &input.envelope;
    if envelope.from_entity_id != *account_id.as_bytes()
        || envelope.to_entity_id != owner_entity_id
        || envelope.from_entity_id == envelope.to_entity_id
    {
        return Err(BatchError::InboundGenesis {
            account_id,
            detail: "PARTIES".to_string(),
        });
    }
    if envelope.domain != policy.expected_domain {
        return Err(BatchError::InboundGenesis {
            account_id,
            detail: "DOMAIN_POLICY".to_string(),
        });
    }
    let Some(watch_seed) = envelope.watch_seed.clone() else {
        return Err(BatchError::InboundGenesis {
            account_id,
            detail: "WATCH_SEED_REQUIRED".to_string(),
        });
    };
    let frame_height = match &input.kind {
        AccountInputKind::AckFrame { frame, .. } => frame.frame.height,
        AccountInputKind::Ack(_)
        | AccountInputKind::Dispute(_)
        | AccountInputKind::BoardHankoRefresh(_) => {
            return Err(BatchError::InboundGenesis {
                account_id,
                detail: "FRAME_REQUIRED".to_string(),
            });
        }
    };
    if frame_height != 1 {
        return Err(BatchError::InboundGenesis {
            account_id,
            detail: "HEIGHT_NOT_ONE".to_string(),
        });
    }
    let seed = build_local_genesis_seed(LocalGenesisSeedParams {
        owner_entity_id,
        account_id,
        domain: policy.expected_domain.clone(),
        watch_seed,
        dispute_config: envelope.dispute_config,
        delta_transformer: policy.delta_transformer,
        public_pinned: false,
        policy_rows: policy.shadow_policy_rows.clone(),
    })?;
    let actual_root = validate_genesis_shadow(account_id, seed.replica.envelope().field("shadow"))?;
    if actual_root != format!("0x{}", hex_of(&policy.shadow_policy_root)) {
        return Err(BatchError::InboundGenesis {
            account_id,
            detail: "POLICY_ROWS_ROOT".to_string(),
        });
    }
    Ok(AccountConsensus::new(seed.replica))
}

fn parse_entity_id(bytes: [u8; 32]) -> Result<xln_rscore_engine::EntityId, StateError> {
    xln_rscore_engine::EntityId::parse(&format!("0x{}", hex_of(&bytes)))
}

/// Derive and verify the sole signer identity accepted by both Account stores.
/// The key is usable only when it actually defines this lazy Entity; accepting
/// an arbitrary owner here would produce valid signatures for the wrong board.
pub(crate) fn build_signing_identity(
    entity_id: [u8; 32],
    private_key: [u8; 32],
    signer_id: &str,
) -> Result<SigningIdentity, BatchError> {
    let identity = SigningIdentity::from_key(
        private_key,
        signer_id,
        entity_id,
        1,
        1,
        BoardDelays::default(),
    );
    if !identity.binds_lazy_entity() {
        return Err(BatchError::SignerUnknownEntity {
            entity_id: hex_of(&entity_id),
        });
    }
    Ok(identity)
}

/// The leaf commits agreed Account state plus durable lifecycle authority.
/// Local queue, pending proposal, ACK retry and rollback coordination stay in
/// the resident/checkpoint envelope and therefore cannot move this tree.
pub(crate) fn leaf_root(
    account_id: AccountId,
    account: &AccountConsensus,
) -> Result<[u8; 32], BatchError> {
    account
        .entity_account_leaf()
        .map_err(|error| BatchError::AccountsTree {
            account_id,
            detail: error.to_string(),
        })
}

pub(crate) fn state_error(account_id: AccountId, error: &StateError) -> BatchError {
    BatchError::AccountsTree {
        account_id,
        detail: error.to_string(),
    }
}

fn hex_of(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(output, "{byte:02x}");
    }
    output
}
