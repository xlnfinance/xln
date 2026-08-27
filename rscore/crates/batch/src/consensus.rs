//! The authoritative account store: replicas the engine itself drives.
//!
//! The mirror engine in `stateful.rs` applies transitions the runtime already
//! decided. This one owns the accounts instead — their mempools, their frames
//! and their signatures — so a wave costs one message rather than one replica
//! shell per frame. Both keep the same commitment: a radix-16 Patricia tree
//! keyed by account id, leaf digest = the Entity's account leaf.

use std::collections::{BTreeMap, BTreeSet};

use xln_rscore_engine::{
    AccountConsensus, AccountEnvelope, AccountFrame, AccountIdentity, AccountOutput,
    AccountPeerEnvelope, AccountReplica, AccountState, AccountTx, AckOutcome, BoardDelays,
    BoardHankoRefreshInput, CertifiedBoardAuthority, CommittedFrameEvidence, CounterpartyDispute,
    Disposition, FrameAckOutcome, FrameAckPhase, IncomingAck, IncomingFrame,
    IncomingFrameSecurityContext, IncomingOutcome, ProposalOutcome, SignedIncomingFrame,
    SigningIdentity, StandaloneInputOutcome, StateError, apply_board_hanko_refresh,
    apply_incoming_ack_with_authority, apply_incoming_frame_ack_with_authority,
    apply_incoming_frame_with_authority, apply_standalone_dispute, canonical_tx_digest,
};
use xln_rscore_protocol::{CanonicalNumber, CanonicalValue};

use crate::checkpoint::AccountRestore;
use crate::{AccountId, AccountSeed, BatchError};

/// What arrives for one account. `FrameAck` is one canonical wire input whose
/// phases execute ACK-first: a valid ACK commits even if the bundled frame is
/// rejected, matching the TypeScript bilateral machine.
#[derive(Clone, Debug)]
pub enum AccountInputKind {
    Frame(Box<IncomingFrame>),
    Ack(IncomingAck),
    FrameAck {
        ack: IncomingAck,
        frame: Box<IncomingFrame>,
    },
    Dispute(CounterpartyDispute),
    BoardHankoRefresh(BoardHankoRefreshInput),
}

#[derive(Clone, Debug)]
pub struct AccountPeerInput {
    pub envelope: AccountPeerEnvelope,
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
    /// It is local verification context, never copied from the peer envelope.
    pub certified_board_authority: PeerBoardAuthority,
    /// Exact current/previous board record certified by the parent Entity for
    /// the Account owner. Duplicate-frame ACK reuse authenticates this local
    /// historical Hanko independently of the peer authority above.
    pub local_certified_board_authority: PeerBoardAuthority,
    pub input: AccountPeerInput,
}

/// Parent-resolved board authority for one untrusted peer input.
///
/// `Unresolved` is deliberately distinct from `Lazy`: absence in peer bytes
/// proves nothing about registration. Only the parent Entity registry may
/// turn it into `Lazy` or `Certified`, and Account execution fails loudly if
/// that resolution step was skipped.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PeerBoardAuthority {
    Unresolved,
    Lazy,
    Certified(CertifiedBoardAuthority),
}

impl PeerBoardAuthority {
    pub(crate) fn certified(&self) -> Result<Option<&CertifiedBoardAuthority>, BatchError> {
        match self {
            Self::Unresolved => Err(BatchError::BoardAuthorityUnresolved),
            Self::Lazy => Ok(None),
            Self::Certified(authority) => Ok(Some(authority)),
        }
    }
}

/// Parent Entity authority lookup. Implementations resolve only from the
/// Entity-certified registry keyed by the peer; peer AccountInput bytes never
/// participate in this decision.
pub trait CertifiedBoardAuthorityResolver {
    type Error;

    fn resolve_certified_board(
        &self,
        peer_entity_id: &[u8; 32],
    ) -> Result<PeerBoardAuthority, Self::Error>;
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
        outputs: Vec<AccountOutput>,
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
        outputs: Vec<AccountOutput>,
        /// The pending frame's own events, released on the same ACK as its
        /// outputs.
        events: Vec<String>,
        committed_frame: Box<CommittedFrameEvidence>,
    },
    AckStale {
        height: u64,
    },
    AckRejected {
        reason: String,
    },
    FrameAckApplied {
        ack: Box<AccountInputVerdict>,
        frame: Box<AccountInputVerdict>,
    },
    FrameAckRejected {
        phase: FrameAckPhase,
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
    pub outbound_input: Option<AccountPeerInput>,
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
    pub frame: AccountFrame,
    pub state_hash: [u8; 32],
    /// Raw owner signature paired with `hanko`, for the parent Entity's
    /// manifest. It is ephemeral and never changes the Account wire shape.
    pub signature: [u8; 65],
    pub hanko: Vec<u8>,
    /// The recovery proof the proposal travels with, when it carries one.
    pub dispute: Option<xln_rscore_engine::DisputeDraft>,
    /// What the proposer publishes at signing time, before any ack exists.
    /// The frame's committed effects are released with the peer's ack; these
    /// are the strings the Entity frame commits and the outputs it acts on
    /// the moment the window executed.
    pub events: Vec<String>,
    pub outputs: Vec<AccountOutput>,
    /// Exact outputs of each transaction in `frame.txs` order. The process
    /// wire keeps its existing flattened output field; resident Entity
    /// composition consumes this lossless form directly.
    pub outputs_by_tx: Vec<Vec<AccountOutput>>,
    /// Present when this proposal also carries the acknowledgement this side
    /// owed, which makes it a `frame_ack` on the wire.
    pub bundled_ack: Option<xln_rscore_engine::OutboundAck>,
}

impl ProposalRow {
    /// The frame as the counterparty receives it, or `None` when the attempt
    /// produced none.
    pub fn incoming(&self) -> Option<xln_rscore_engine::IncomingFrame> {
        self.proposed
            .as_ref()
            .map(|proposed| xln_rscore_engine::IncomingFrame {
                frame: proposed.frame.clone(),
                state_hash: proposed.state_hash,
                frame_hanko: Some(proposed.hanko.clone()),
                // The proposer's signature over their proof is not modelled
                // here: this path hands one engine's own proposal to another
                // inside a test, where both sides build the same proof from
                // the same state.
                dispute: proposed.dispute.as_ref().map(|draft| {
                    xln_rscore_engine::CounterpartyDispute {
                        hanko: None,
                        hash: draft.hash,
                        proof_body_hash: draft.proof_body_hash,
                        nonce: draft.nonce,
                        proposer_is_left: draft.proposer_is_left,
                    }
                }),
            })
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
    dropped
        .iter()
        .map(|dropped| {
            Ok(DroppedRow {
                index: dropped.index,
                tx_digest: canonical_tx_digest(&dropped.tx)
                    .map_err(|error| state_error(account_id, &error))?,
                code: dropped.rejection.code(),
                message: dropped.rejection.message(),
                disposition: dropped.disposition,
            })
        })
        .collect()
}

fn outgoing_account_input(account: &AccountConsensus, proposed: &ProposedRow) -> AccountPeerInput {
    let replica = account.replica();
    let envelope = AccountPeerEnvelope {
        from_entity_id: *replica.owner().as_bytes(),
        to_entity_id: *replica.counterparty().as_bytes(),
        domain: replica.state().identity().domain().clone(),
        dispute_config: replica.state().dispute_config(),
        watch_seed: Some(replica.state().identity().watch_seed().clone()),
    };
    let frame = IncomingFrame {
        frame: proposed.frame.clone(),
        state_hash: proposed.state_hash,
        frame_hanko: Some(proposed.hanko.clone()),
        dispute: proposed
            .dispute
            .as_ref()
            .map(|draft| xln_rscore_engine::CounterpartyDispute {
                hanko: None,
                hash: draft.hash,
                proof_body_hash: draft.proof_body_hash,
                nonce: draft.nonce,
                proposer_is_left: draft.proposer_is_left,
            }),
    };
    let kind = match &proposed.bundled_ack {
        Some(ack) => AccountInputKind::FrameAck {
            ack: IncomingAck {
                height: ack.height,
                frame_hash: ack.frame_hash,
                frame_hanko: Some(ack.frame_hanko.clone()),
                dispute: ack
                    .dispute
                    .as_ref()
                    .map(|draft| xln_rscore_engine::CounterpartyDispute {
                        hanko: None,
                        hash: draft.hash,
                        proof_body_hash: draft.proof_body_hash,
                        nonce: draft.nonce,
                        proposer_is_left: draft.proposer_is_left,
                    }),
            },
            frame: Box::new(frame),
        },
        None => AccountInputKind::Frame(Box::new(frame)),
    };
    AccountPeerInput { envelope, kind }
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
            let failed_htlc_locks = failed_htlc_locks(&proposed.dropped);
            let dropped = dropped_rows(account_id, &proposed.dropped)?;
            let proposed = ProposedRow {
                frame: proposed.frame,
                state_hash: proposed.state_hash,
                signature: proposed.signature,
                hanko: proposed.hanko,
                dispute: proposed.dispute,
                events: proposed.events,
                outputs: proposed.outputs,
                outputs_by_tx: proposed.outputs_by_tx,
                bundled_ack: proposed.bundled_ack,
            };
            let outbound_input = Some(outgoing_account_input(account, &proposed));
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
    input: AccountPeerInput,
    security: IncomingFrameSecurityContext<'_>,
    swap_market: &std::sync::Arc<xln_rscore_engine::SwapMarketPolicy>,
) -> (AccountInputVerdict, bool) {
    let clock = security.clock;
    let peer_authority = security.peer_certified_board_authority;
    let local_authority = security.local_certified_board_authority;
    if account_id.as_bytes() != &input.envelope.from_entity_id {
        return (
            AccountInputVerdict::Failed("ACCOUNT_INPUT_ACCOUNT_ID_MISMATCH".to_string()),
            false,
        );
    }
    if let Some(authority) = peer_authority
        && let Err(error) = authority.assert_entity(&input.envelope.from_entity_id)
    {
        return (AccountInputVerdict::Failed(error.to_string()), false);
    }
    let verdict = match input.kind {
        AccountInputKind::Frame(frame) => {
            match apply_incoming_frame_with_authority(
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
            }
        }
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
        AccountInputKind::FrameAck { ack, frame } => match apply_incoming_frame_ack_with_authority(
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
            Ok(outcome) => frame_ack_verdict(outcome),
            Err(error) => AccountInputVerdict::Failed(error.to_string()),
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
            outputs,
            events,
            rolled_back,
            committed_frame,
            ack_dispute,
        } => AccountInputVerdict::FrameCommitted {
            height,
            state_hash,
            ack_signature,
            ack_hanko,
            outputs,
            events,
            rolled_back,
            committed_frame,
            ack_dispute,
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
            ack_dispute,
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
            outputs,
            events,
            committed_frame,
        } => AccountInputVerdict::AckCommitted {
            height,
            state_hash,
            outputs,
            events,
            committed_frame,
        },
        AckOutcome::Stale { height } => AccountInputVerdict::AckStale { height },
        AckOutcome::Rejected { reason } => AccountInputVerdict::AckRejected { reason },
    }
}

fn frame_ack_verdict(outcome: FrameAckOutcome) -> AccountInputVerdict {
    match outcome {
        FrameAckOutcome::Applied { ack, frame } => AccountInputVerdict::FrameAckApplied {
            ack: Box::new(ack_verdict(*ack)),
            frame: Box::new(incoming_verdict(*frame)),
        },
        FrameAckOutcome::Rejected { phase, reason } => {
            AccountInputVerdict::FrameAckRejected { phase, reason }
        }
    }
}

fn verdict_changes_account(verdict: &AccountInputVerdict) -> bool {
    match verdict {
        AccountInputVerdict::FrameCommitted { .. }
        | AccountInputVerdict::AckCommitted { .. }
        | AccountInputVerdict::DisputeApplied
        | AccountInputVerdict::BoardHankoRefreshApplied { .. } => true,
        AccountInputVerdict::FrameAckApplied { ack, frame } => {
            verdict_changes_account(ack) || verdict_changes_account(frame)
        }
        AccountInputVerdict::FrameCollisionIgnored { .. }
        | AccountInputVerdict::FrameDuplicate { .. }
        | AccountInputVerdict::FrameStale { .. }
        | AccountInputVerdict::FrameDisputeRequired { .. }
        | AccountInputVerdict::FrameRejected { .. }
        | AccountInputVerdict::AckStale { .. }
        | AccountInputVerdict::AckRejected { .. }
        | AccountInputVerdict::FrameAckRejected { .. }
        | AccountInputVerdict::DisputeRejected { .. }
        | AccountInputVerdict::BoardHankoRefreshRejected { .. }
        | AccountInputVerdict::Failed(_) => false,
    }
}

pub(crate) fn verdict_commits_genesis(verdict: &AccountInputVerdict) -> bool {
    match verdict {
        AccountInputVerdict::FrameCommitted { height: 1, .. } => true,
        AccountInputVerdict::FrameAckApplied { frame, .. } => verdict_commits_genesis(frame),
        AccountInputVerdict::FrameCommitted { .. }
        | AccountInputVerdict::FrameCollisionIgnored { .. }
        | AccountInputVerdict::FrameDuplicate { .. }
        | AccountInputVerdict::FrameStale { .. }
        | AccountInputVerdict::FrameDisputeRequired { .. }
        | AccountInputVerdict::FrameRejected { .. }
        | AccountInputVerdict::AckCommitted { .. }
        | AccountInputVerdict::AckStale { .. }
        | AccountInputVerdict::AckRejected { .. }
        | AccountInputVerdict::FrameAckRejected { .. }
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
    AccountEnvelope::new(carried, Vec::new())
        .map_err(|error| create_envelope_error(account_id, error.to_string()))
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

pub(crate) fn proposable(account: &AccountConsensus) -> Result<bool, BatchError> {
    if account.replica().settlement_workspace_present() {
        return Err(BatchError::ProposabilitySettlementUnrepresented);
    }
    if account.pending().is_some() {
        return Ok(false);
    }
    let active = match account
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
    };
    if !active {
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
    input: &AccountPeerInput,
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
        AccountInputKind::Frame(frame) | AccountInputKind::FrameAck { frame, .. } => {
            frame.frame.height
        }
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
    let owner = parse_entity_id(owner_entity_id).map_err(|_| BatchError::InboundGenesis {
        account_id,
        detail: "OWNER_ID".to_string(),
    })?;
    let peer =
        parse_entity_id(envelope.from_entity_id).map_err(|_| BatchError::InboundGenesis {
            account_id,
            detail: "PEER_ID".to_string(),
        })?;
    let (left, right) = if owner < peer {
        (owner.clone(), peer)
    } else {
        (peer, owner.clone())
    };
    let identity = AccountIdentity::new(policy.expected_domain.clone(), left, right, watch_seed)
        .map_err(|error| state_error(account_id, &error))?;
    let state = AccountState::new(identity, envelope.dispute_config, Vec::new())
        .map_err(|error| state_error(account_id, &error))?;
    let mut replica =
        AccountReplica::new(owner, state).map_err(|error| state_error(account_id, &error))?;
    replica.set_delta_transformer(policy.delta_transformer);
    let policy_root = format!("0x{}", hex_of(&policy.shadow_policy_root));
    let fields = genesis_envelope_fields(&replica, false, &policy_root);
    let full_envelope = AccountEnvelope::new(fields, Vec::new())
        .map_err(|error| create_envelope_error(account_id, error.to_string()))?;
    replica.set_envelope(full_envelope);
    validate_genesis_seed(
        owner_entity_id,
        &AccountSeed {
            account_id,
            replica,
            consensus: None,
        },
    )
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

/// The leaf commits the consensus state too, so a queued transaction or a new
/// frame moves the tree even when the financial root did not change.
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

