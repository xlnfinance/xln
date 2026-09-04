//! Applying a counterparty's frame, and their ack of ours.
//!
//! Parity target: core/account/consensus/incoming/{preflight,collision,replay,
//! ack-commit,commit-root}.ts. Authentication comes first, then the structural
//! checks, then replay — and the frame commits only when our own replay
//! reproduces the exact account state root and frame hash the peer signed.

use crate::consensus::frame::hash::{AccountFrame, parse_root_hex};
use crate::consensus::proposal::propose::{WindowExecution, execute_window};
use crate::consensus::rebalance::queue_post_commit_auto_rebalance;
use crate::consensus::replica::AccountConsensus;
use crate::consensus::signing::{
    CertifiedBoardAuthority, SigningIdentity, verify_ack_hanko_with_authority,
    verify_frame_hanko_with_authority,
};
use crate::dispute::{
    counterparty_dispute_requirement_error, proof_body_hash, validate_counterparty_dispute_hash,
    validate_counterparty_dispute_shape, verify_counterparty_dispute_with_authority,
};
use crate::error::StateError;
use crate::input::mempool::ACCOUNT_MEMPOOL_SIZE;
use crate::tx::account_tx_admission_error;
use crate::{AccountExecutionContext, AccountOutput, Side};

use super::types::{
    AccountInputEnvelope, AckFrameOutcome, AckFramePhase, BoardHankoRefreshInput, IncomingAck,
    IncomingFrame, StandaloneInputOutcome, validate_account_input_envelope,
};

use super::deadline::incoming_deadline_violation;
pub use super::deadline::{HtlcEvidenceSecret, IncomingDeadlineViolation};

/// `ACCOUNT_NETWORK_ALLOWANCE_MS` (core/account/consensus/constants.ts). A peer
/// chooses its own frame timestamp, so a frame from the future could satisfy
/// payer-side deadlines early. Old signed frames stay legal: exact
/// retransmission must survive an outage of any length.
const MAX_FRAME_FUTURE_SKEW_MS: u64 = 30_000;

/// `MAX_ACCOUNT_FRAME_TXS` (core/account/consensus/frame/hash.ts), which is
/// the mempool bound.
const MAX_ACCOUNT_FRAME_TXS: usize = ACCOUNT_MEMPOOL_SIZE;
const JS_MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// The receiver's own clock, which is what decides whether a lock has expired.
///
/// Parity target: `securityContext.entityTimestamp` / `finalizedJHeight`
/// (core/account/consensus/index.ts). The frame's own clock stays the
/// committed clock — it is what the peer signed — but enforcement is judged
/// here, or the proposer would own our timeouts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ReceiverClock {
    pub entity_timestamp: u64,
    pub finalized_j_height: u64,
}

/// Parent-owned verification context shared by both phases of `ack_frame`.
#[derive(Clone, Copy, Debug)]
pub struct IncomingFrameSecurityContext<'a> {
    pub clock: ReceiverClock,
    /// Transient parent Entity role. Hub replicas service requests; only user
    /// replicas may originate them automatically.
    pub owning_entity_is_hub: bool,
    pub peer_certified_board_authority: Option<&'a CertifiedBoardAuthority>,
    /// Parent-certified authority for the Account owner. Kept separate from
    /// the untrusted sender's record because duplicate ACKs authenticate our
    /// persisted historical Hanko, not the peer's proposal Hanko.
    pub local_certified_board_authority: Option<&'a CertifiedBoardAuthority>,
}

/// Authenticated frame evidence retained when the deadline policy requires a
/// dispute instead of accepting or rejecting the peer frame.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SignedIncomingFrame {
    pub frame: AccountFrame,
    pub state_hash: [u8; 32],
    pub frame_hanko: Vec<u8>,
}

/// The exact canonical frame whose bilateral commit an input completed.
///
/// Entity processing consumes the frame body, not only its hash: committed
/// transactions drive HTLC and swap follow-up work. The provenance bit keeps
/// the two commit paths distinct. A newly accepted peer frame is new work for
/// this replica, while an ACK only certifies the pending frame we already
/// proposed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommittedFrameEvidence {
    pub frame: AccountFrame,
    /// Canonical frame hash already authenticated (peer frame) or authored
    /// (our pending frame). Entity must bind to it, not hash the same body a
    /// second time after Account consensus has committed it.
    pub state_hash: [u8; 32],
    /// Domain of the resident Account that committed this frame. The frame
    /// body does not carry identity metadata, but Entity HTLC bindings require
    /// the exact domain and must not receive it as an unverified parent hint.
    pub domain: crate::AccountDomain,
    /// Exact outputs of each transaction in `frame.txs` order. Entity logic
    /// must not infer this association from output kind or cardinality.
    pub outputs_by_tx: Vec<Vec<AccountOutput>>,
    pub committed_via_new_frame: bool,
}

#[derive(Clone, Debug)]
pub enum IncomingOutcome {
    /// The frame is now the chain head; the ack is ours to send.
    Committed {
        height: u64,
        state_hash: [u8; 32],
        /// Raw signature created together with `ack_hanko`. The parent Entity
        /// commits it in the same manifest without repeating ECDSA signing.
        ack_signature: [u8; 65],
        ack_hanko: Vec<u8>,
        /// Worker-authored witness for the ACK dispute, when the draft still
        /// needs the parent Entity manifest to attach its Hanko.
        ack_dispute_signature: Option<Box<[u8; 65]>>,
        ack_dispute_hanko: Option<Vec<u8>>,
        /// What this frame's transactions said they did, in transaction order.
        /// The Entity frame commits them, so they travel with the verdict
        /// rather than being re-derived by whoever publishes it.
        events: Vec<String>,
        /// Set when our own same-height proposal lost the collision and its
        /// transactions went back to the queue.
        rolled_back: Option<crate::consensus::replica::RolledBackProposal>,
        committed_frame: Box<CommittedFrameEvidence>,
        /// The recovery proof our acknowledgement carries, when it carries
        /// one. It travels with the verdict because the acknowledgement is
        /// what the publisher sends, and it must not have to read the account
        /// back to learn what it just signed.
        ack_dispute: Option<Box<crate::consensus::replica::DisputeDraft>>,
    },
    /// We are LEFT and the peer raced us at the same height: our proposal
    /// stands and their frame is ignored until they ack it.
    CollisionIgnored {
        height: u64,
        /// Transactions still queued behind the proposal that won.
        queued: usize,
    },
    /// Already committed at this height with this hash: re-ack, do not replay.
    Duplicate {
        height: u64,
        state_hash: [u8; 32],
        ack_hanko: Vec<u8>,
        /// The same proof the original acknowledgement carried, replayed.
        ack_dispute: Option<Box<crate::consensus::replica::DisputeDraft>>,
    },
    /// Already behind our chain head: an at-least-once retransmission, which
    /// is applied as a no-op rather than treated as a fault.
    Stale {
        height: u64,
        current_height: u64,
    },
    /// The peer supplied a valid signed secret, but too little enforcement
    /// window remains to commit it off-chain safely. Runtime must open the
    /// canonical dispute with this exact evidence; treating it as an ordinary
    /// rejection can strand a valid preimage until expiry.
    DisputeRequired {
        reason: String,
        evidence_secrets: Vec<HtlcEvidenceSecret>,
        signed_frame: Box<SignedIncomingFrame>,
    },
    Rejected {
        reason: String,
    },
}

#[derive(Clone, Debug)]
pub enum AckOutcome {
    /// The peer acknowledged our pending frame; it is committed on both sides,
    /// and only now may its effects leave the account.
    Committed {
        height: u64,
        state_hash: [u8; 32],
        /// Canonical acknowledgement event. Transaction handler events were
        /// speculative and are not replayed into the ACK's Entity frame.
        events: Vec<String>,
        /// Boxed: an ACK outcome is mostly the tiny accepted/rejected cases, and
        /// the committed frame is the only large thing in the enum.
        committed_frame: Box<CommittedFrameEvidence>,
    },
    /// Exact authenticated acknowledgement of the committed head. It is
    /// accepted as a no-op because the frame is already committed.
    Accepted {
        height: u64,
    },
    Rejected {
        reason: String,
    },
}

fn rejected(reason: impl Into<String>) -> IncomingOutcome {
    IncomingOutcome::Rejected {
        reason: reason.into(),
    }
}

fn ack_rejected(reason: impl Into<String>) -> AckOutcome {
    AckOutcome::Rejected {
        reason: reason.into(),
    }
}

fn reusable_duplicate_ack_hanko(
    local_hanko: Option<&[u8]>,
    account_owner: &[u8; 32],
    identity: &SigningIdentity,
    state_hash: &[u8; 32],
    height: u64,
    clock: ReceiverClock,
    local_authority: Option<&CertifiedBoardAuthority>,
) -> Result<Vec<u8>, StateError> {
    if identity.entity_id() != account_owner {
        return Err(StateError::Signing(format!(
            "DUPLICATE_ACK_LOCAL_IDENTITY_MISMATCH:height={height}"
        )));
    }
    let hanko = local_hanko.ok_or_else(|| {
        StateError::Signing(format!(
            "DUPLICATE_ACK_LOCAL_COMMITTED_FRAME_HANKO_MISSING:height={height}"
        ))
    })?;
    if let Some(authority) = local_authority {
        authority.assert_entity(account_owner)?;
    }
    verify_ack_hanko_with_authority(
        hanko,
        state_hash,
        account_owner,
        local_authority,
        clock.entity_timestamp,
    )
    .map_err(|error| {
        StateError::Signing(format!(
            "DUPLICATE_ACK_LOCAL_COMMITTED_FRAME_HANKO_INVALID:height={height}:{error}"
        ))
    })?;
    Ok(hanko.to_vec())
}

fn standalone_rejected(reason: impl Into<String>) -> StandaloneInputOutcome {
    StandaloneInputOutcome::Rejected {
        reason: reason.into(),
    }
}

/// Apply a heightless recovery witness. Its proof nonce sequences it; no fake
/// frame height is introduced solely to fit the frame/ACK reducer.
pub fn apply_standalone_dispute(
    account: &mut AccountConsensus,
    envelope: &AccountInputEnvelope,
    clock: ReceiverClock,
    dispute: crate::CounterpartyDispute,
    authority: Option<&CertifiedBoardAuthority>,
) -> Result<StandaloneInputOutcome, StateError> {
    if let Err(error) = validate_account_input_envelope(account, envelope) {
        return Ok(standalone_rejected(error.to_string()));
    }
    if let Some(authority) = authority {
        authority.assert_entity(&envelope.from_entity_id)?;
    }
    if let Err(error) = validate_counterparty_dispute_shape(&dispute) {
        return Ok(standalone_rejected(error.to_string()));
    }
    if let Err(error) = verify_counterparty_dispute_with_authority(
        account.replica(),
        &envelope.from_entity_id,
        &dispute,
        authority,
        clock.entity_timestamp,
        true,
    ) {
        return Ok(standalone_rejected(error.to_string()));
    }
    if let Some(reason) = counterparty_dispute_requirement_error(
        account.dispute().map(|draft| &draft.proof_body_hash),
        account.counterparty_dispute(),
        account.replica().state().j_nonce(),
        Some(&dispute),
    ) {
        return Ok(standalone_rejected(reason));
    }
    account.store_counterparty_dispute(dispute);
    Ok(StandaloneInputOutcome::Applied { events: Vec::new() })
}

#[derive(Clone, Copy)]
struct StoredBoardHankoRefresh {
    activation_j_height: u64,
    activation_log_index: u64,
    frame_height: u64,
    frame_hash: [u8; 32],
}

fn canonical_u64(
    fields: &[(String, xln_rscore_protocol::CanonicalValue)],
    name: &str,
) -> Result<u64, StateError> {
    let Some((_, xln_rscore_protocol::CanonicalValue::Number(value))) =
        fields.iter().find(|(field, _)| field == name)
    else {
        return Err(StateError::Envelope(format!(
            "COUNTERPARTY_BOARD_HANKO_REFRESH_FIELD:{name}"
        )));
    };
    value
        .as_str()
        .parse::<u64>()
        .map_err(|_| StateError::Envelope(format!("COUNTERPARTY_BOARD_HANKO_REFRESH_U64:{name}")))
}

fn hex_of(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    bytes.iter().fold(String::new(), |mut text, byte| {
        let _ = write!(text, "{byte:02x}");
        text
    })
}

fn stored_board_hanko_refresh(
    account: &AccountConsensus,
) -> Result<Option<StoredBoardHankoRefresh>, StateError> {
    let Some(value) = account
        .replica()
        .envelope()
        .field("counterpartyBoardHankoRefresh")
    else {
        return Ok(None);
    };
    let xln_rscore_protocol::CanonicalValue::Object(fields) = value else {
        return Err(StateError::Envelope(
            "COUNTERPARTY_BOARD_HANKO_REFRESH_OBJECT".to_string(),
        ));
    };
    let Some((_, xln_rscore_protocol::CanonicalValue::String(frame_hash))) =
        fields.iter().find(|(field, _)| field == "frameHash")
    else {
        return Err(StateError::Envelope(
            "COUNTERPARTY_BOARD_HANKO_REFRESH_FIELD:frameHash".to_string(),
        ));
    };
    Ok(Some(StoredBoardHankoRefresh {
        activation_j_height: canonical_u64(fields, "activationJHeight")?,
        activation_log_index: canonical_u64(fields, "activationLogIndex")?,
        frame_height: canonical_u64(fields, "frameHeight")?,
        frame_hash: crate::parse_root_hex(frame_hash).ok_or_else(|| {
            StateError::Envelope("COUNTERPARTY_BOARD_HANKO_REFRESH_FRAME_HASH".to_string())
        })?,
    }))
}

fn refresh_metadata(
    input: &BoardHankoRefreshInput,
) -> Result<xln_rscore_protocol::CanonicalValue, StateError> {
    let number = |value| {
        xln_rscore_protocol::CanonicalNumber::try_from_u64(value)
            .map(xln_rscore_protocol::CanonicalValue::Number)
            .map_err(|error| StateError::Envelope(error.to_string()))
    };
    Ok(xln_rscore_protocol::CanonicalValue::Object(vec![
        (
            "activationJHeight".to_string(),
            number(input.board_activation_j_height)?,
        ),
        (
            "activationLogIndex".to_string(),
            number(input.board_activation_log_index)?,
        ),
        ("frameHeight".to_string(), number(input.height)?),
        (
            "frameHash".to_string(),
            xln_rscore_protocol::CanonicalValue::String(format!("0x{}", hex_of(&input.frame_hash))),
        ),
    ]))
}

/// Replace historical witnesses under the current certified board without
/// manufacturing a new Account frame or changing bilateral money.
pub fn apply_board_hanko_refresh(
    account: &mut AccountConsensus,
    envelope: &AccountInputEnvelope,
    clock: ReceiverClock,
    input: BoardHankoRefreshInput,
    authority: Option<&CertifiedBoardAuthority>,
) -> Result<StandaloneInputOutcome, StateError> {
    if let Err(error) = validate_account_input_envelope(account, envelope) {
        return Ok(standalone_rejected(error.to_string()));
    }
    let Some(authority) = authority else {
        return Ok(standalone_rejected(
            "ACCOUNT_BOARD_HANKO_REFRESH_CERTIFIED_BOARD_MISSING",
        ));
    };
    authority.assert_entity(&envelope.from_entity_id)?;
    if input.board_activation_j_height == 0 || input.board_activation_j_height > JS_MAX_SAFE_INTEGER
    {
        return Ok(standalone_rejected(format!(
            "ACCOUNT_BOARD_HANKO_REFRESH_ACTIVATION_HEIGHT_INVALID:{}",
            input.board_activation_j_height
        )));
    }
    if input.board_activation_log_index > JS_MAX_SAFE_INTEGER {
        return Ok(standalone_rejected(format!(
            "ACCOUNT_BOARD_HANKO_REFRESH_ACTIVATION_LOG_INDEX_INVALID:{}",
            input.board_activation_log_index
        )));
    }
    if input.board_activation_j_height != authority.activated_at_j_height
        || input.board_activation_log_index != authority.activation_log_index
    {
        return Ok(standalone_rejected(format!(
            "ACCOUNT_BOARD_HANKO_REFRESH_ACTIVATION_MISMATCH:{}:{}:{}:{}",
            input.board_activation_j_height,
            input.board_activation_log_index,
            authority.activated_at_j_height,
            authority.activation_log_index
        )));
    }
    if let Some(previous) = stored_board_hanko_refresh(account)? {
        let not_newer = input.board_activation_j_height < previous.activation_j_height
            || (input.board_activation_j_height == previous.activation_j_height
                && input.board_activation_log_index <= previous.activation_log_index);
        let exact_retry = input.board_activation_j_height == previous.activation_j_height
            && input.board_activation_log_index == previous.activation_log_index
            && input.height == previous.frame_height
            && input.frame_hash == previous.frame_hash;
        if not_newer && !exact_retry {
            return Ok(standalone_rejected(format!(
                "ACCOUNT_BOARD_HANKO_REFRESH_ACTIVATION_ORDER_INVALID:{}:{}:{}:{}",
                input.board_activation_j_height,
                input.board_activation_log_index,
                previous.activation_j_height,
                previous.activation_log_index
            )));
        }
    }
    let Some(current) = account.current() else {
        return Ok(standalone_rejected(format!(
            "ACCOUNT_BOARD_HANKO_REFRESH_HEIGHT_MISMATCH:{}:{}",
            input.height,
            account.current_height()
        )));
    };
    if input.height == 0
        || input.height > JS_MAX_SAFE_INTEGER
        || input.height != account.current_height()
        || input.height != current.frame.height
    {
        return Ok(standalone_rejected(format!(
            "ACCOUNT_BOARD_HANKO_REFRESH_HEIGHT_MISMATCH:{}:{}",
            input.height,
            account.current_height()
        )));
    }
    if input.frame_hash != current.state_hash {
        return Ok(standalone_rejected(format!(
            "ACCOUNT_BOARD_HANKO_REFRESH_FRAME_HASH_MISMATCH:0x{}:0x{}",
            hex_of(&input.frame_hash),
            hex_of(&current.state_hash)
        )));
    }
    let Some(frame_hanko) = input.frame_hanko.as_ref() else {
        return Ok(standalone_rejected(
            "ACCOUNT_BOARD_HANKO_REFRESH_FRAME_HANKO_MISSING",
        ));
    };
    if let Err(error) = verify_frame_hanko_with_authority(
        frame_hanko,
        &input.frame_hash,
        &envelope.from_entity_id,
        Some(authority),
    ) {
        return Ok(standalone_rejected(format!(
            "ACCOUNT_BOARD_HANKO_REFRESH_FRAME_HANKO_INVALID:{error}"
        )));
    }
    if let Some(dispute) = input.dispute.as_ref() {
        let matches_stored = account.counterparty_dispute().is_some_and(|stored| {
            dispute.hash == stored.hash
                && dispute.proof_body_hash == stored.proof_body_hash
                && dispute.nonce == stored.nonce
                && dispute.proposer_is_left == stored.proposer_is_left
        });
        if !matches_stored {
            return Ok(standalone_rejected(
                "ACCOUNT_BOARD_HANKO_REFRESH_DISPUTE_MISMATCH",
            ));
        }
        if let Err(error) = verify_counterparty_dispute_with_authority(
            account.replica(),
            &envelope.from_entity_id,
            dispute,
            Some(authority),
            clock.entity_timestamp,
            false,
        ) {
            return Ok(standalone_rejected(format!(
                "ACCOUNT_BOARD_HANKO_REFRESH_DISPUTE_INVALID:{error}"
            )));
        }
    }
    let metadata = refresh_metadata(&input)?;
    account.install_counterparty_board_hanko_refresh(
        frame_hanko.clone(),
        input.dispute,
        metadata,
    )?;
    Ok(StandaloneInputOutcome::Applied {
        events: vec![format!(
            "🔐 Refreshed Account frame {} Hankos under the current board",
            input.height
        )],
    })
}

/// Apply a peer's proposal.
pub fn apply_incoming_frame(
    account: &mut AccountConsensus,
    identity: &SigningIdentity,
    envelope: &AccountInputEnvelope,
    clock: ReceiverClock,
    incoming: IncomingFrame,
    swap_market: &std::sync::Arc<crate::SwapMarketPolicy>,
    owning_entity_is_hub: bool,
) -> Result<IncomingOutcome, StateError> {
    apply_incoming_frame_with_authority(
        account,
        identity,
        envelope,
        incoming,
        swap_market,
        IncomingFrameSecurityContext {
            clock,
            owning_entity_is_hub,
            peer_certified_board_authority: None,
            local_certified_board_authority: None,
        },
    )
}

/// Apply a peer proposal against the exact current certified board supplied
/// by Entity consensus. This is the production registered-Entity entrypoint.
pub fn apply_incoming_frame_with_authority(
    account: &mut AccountConsensus,
    identity: &SigningIdentity,
    envelope: &AccountInputEnvelope,
    incoming: IncomingFrame,
    swap_market: &std::sync::Arc<crate::SwapMarketPolicy>,
    security: IncomingFrameSecurityContext<'_>,
) -> Result<IncomingOutcome, StateError> {
    if let Some(outcome) =
        classify_incoming_frame_without_mutation(account, identity, envelope, &incoming, security)?
    {
        return Ok(outcome);
    }
    let clock = security.clock;
    let peer_authority = security.peer_certified_board_authority;
    let IncomingFrame {
        frame,
        state_hash,
        frame_hanko,
        dispute,
    } = incoming;
    let current_height = account.current_height();

    // FX-2 peer direction: an authenticated sender still cannot introduce a
    // transaction outside the production RRS profile. Classify this before
    // signature work or replay and leave the resident Account untouched.
    if let Some(error) = frame.txs.iter().find_map(account_tx_admission_error) {
        return Ok(rejected(error.to_string()));
    }

    let Some(frame_hanko) = frame_hanko else {
        return Ok(rejected("ACCOUNT_INPUT_FRAME_HANKO_MISSING"));
    };
    if let Some(dispute) = dispute.as_ref()
        && let Err(error) =
            validate_counterparty_dispute_hash(account.replica(), &envelope.from_entity_id, dispute)
    {
        return Ok(rejected(error.to_string()));
    }
    // SECURITY: authenticate before touching any state, exactly as preflight
    // does. An unsigned frame is not evidence of anything.
    if let Err(error) = verify_frame_hanko_with_authority(
        &frame_hanko,
        &state_hash,
        &envelope.from_entity_id,
        peer_authority,
    ) {
        return Ok(rejected(error.to_string()));
    }
    let received_hash = match frame.hash() {
        Ok(hash) => hash,
        Err(error) => return Ok(rejected(error.to_string())),
    };
    if received_hash != state_hash {
        return Ok(rejected("ACCOUNT_INPUT_FRAME_HASH_MISMATCH"));
    }
    if frame.txs.len() > MAX_ACCOUNT_FRAME_TXS {
        return Ok(rejected(format!(
            "ACCOUNT_INPUT_FRAME_STRUCTURE_INVALID:txs:{}",
            frame.txs.len()
        )));
    }
    if frame.timestamp
        > clock
            .entity_timestamp
            .saturating_add(MAX_FRAME_FUTURE_SKEW_MS)
    {
        return Ok(rejected(format!(
            "ACCOUNT_INPUT_FRAME_STRUCTURE_INVALID:skew:{}",
            frame.timestamp - clock.entity_timestamp
        )));
    }

    // Every input that can still move consensus authenticates the witness
    // here, before replay or collision handling mutates anything.
    if let Some(dispute) = dispute.as_ref()
        && let Err(error) = verify_counterparty_dispute_with_authority(
            account.replica(),
            &envelope.from_entity_id,
            dispute,
            peer_authority,
            clock.entity_timestamp,
            true,
        )
    {
        return Ok(rejected(error.to_string()));
    }

    if frame.height != current_height + 1 {
        return Ok(rejected(format!(
            "ACCOUNT_INPUT_FRAME_HEIGHT_GAP:{}:{current_height}",
            frame.height
        )));
    }
    if frame.prev_frame_hash != account.prev_frame_hash() {
        return Ok(rejected(format!(
            "ACCOUNT_INPUT_FRAME_PREV_MISMATCH:{}",
            frame.prev_frame_hash
        )));
    }
    let proposer = account.replica().owner_side().opposite();
    if let Some(violation) =
        incoming_deadline_violation(account.replica().state(), &frame, proposer, clock)
    {
        return Ok(match violation {
            IncomingDeadlineViolation::Reject { reason } => rejected(reason),
            IncomingDeadlineViolation::Dispute {
                reason,
                evidence_secrets,
            } => IncomingOutcome::DisputeRequired {
                reason,
                evidence_secrets,
                signed_frame: Box::new(SignedIncomingFrame {
                    frame,
                    state_hash,
                    frame_hanko,
                }),
            },
        });
    }

    // Each side may propose once at a height. If both race, the LEFT entity's
    // frame wins: the loser's proposal never acquired the counterparty Hanko
    // it would need to be enforceable. The full chain, certificate and
    // deadline preflight above runs first, matching TypeScript: malformed
    // same-height traffic is a rejection, not a collision decision.
    let collides = account
        .pending()
        .is_some_and(|pending| pending.frame.height == frame.height);
    if collides {
        if account.replica().owner_side() == Side::Left {
            return Ok(IncomingOutcome::CollisionIgnored {
                height: frame.height,
                queued: account.mempool().len(),
            });
        }
        if account.last_rollback_frame_hash() == Some(&state_hash) {
            return Ok(rejected(format!(
                "ACCOUNT_INPUT_FRAME_ROLLBACK_DUPLICATE:{}",
                frame.height
            )));
        }
    }

    // The committed clock is the peer's — it is what they signed — but
    // enforcement is judged on our own clock, so a backdated frame cannot
    // decide our timeouts for us.
    let settlement =
        account.settlement_execution_context(security.peer_certified_board_authority.copied());
    let context = AccountExecutionContext::with_market(
        frame.timestamp,
        clock.entity_timestamp,
        clock.finalized_j_height,
        current_height,
        frame.j_height,
        std::sync::Arc::clone(swap_market),
    )
    .with_settlement(settlement);
    let execution = execute_window(
        account.replica(),
        proposer,
        frame.txs.clone(),
        &context,
        true,
    )?;
    let WindowExecution {
        mut candidate,
        applied,
        outputs_by_tx,
        mut events,
        consensus_effects,
        dropped,
    } = execution;
    if let Some(first) = dropped.first() {
        // The peer signed this transaction into the frame, so a rejection is a
        // disagreement about the whole frame, never a dropped transaction.
        return Ok(rejected(format!(
            "ACCOUNT_INPUT_FRAME_TX_REJECTED:{}:{:?}",
            first.index, first.rejection
        )));
    }
    if applied != frame.txs {
        return Ok(rejected("ACCOUNT_INPUT_FRAME_TX_COUNT_MISMATCH"));
    }

    let account_state_root = candidate.refresh_account_state_root()?;
    if account_state_root != frame.account_state_root {
        return Ok(rejected("ACCOUNT_INPUT_FRAME_STATE_ROOT_MISMATCH"));
    }
    let expected_proof_body_hash = candidate
        .delta_transformer()
        .map(|transformer| proof_body_hash(&candidate, transformer))
        .transpose()?;
    let mut effect_preview = account.clone();
    effect_preview.apply_consensus_effects(&consensus_effects)?;
    if let Some(reason) = counterparty_dispute_requirement_error(
        expected_proof_body_hash.as_ref(),
        effect_preview.counterparty_dispute(),
        candidate.state().j_nonce(),
        dispute.as_ref(),
    ) {
        return Ok(rejected(reason));
    }
    account.apply_consensus_effects(&consensus_effects)?;

    // Only now, with the frame proven to be one we can commit, does our own
    // proposal give way to it.
    //
    // Parity target: `applySameHeightIncomingFrameRollback`
    // (core/account/consensus/index.ts), which runs after the replay.
    let rolled_back = if collides {
        account.rollback_pending(state_hash)?
    } else {
        None
    };

    let (ack_signature, ack_hanko) = identity.sign_frame_with_raw(&state_hash)?;
    // Their proof of the state they just proposed was authenticated against
    // the reconstructed Solidity digest before replay, then checked against
    // this exact candidate proof body above. Only now may it be retained.
    if let Some(dispute) = dispute {
        account.store_counterparty_dispute(dispute);
    }
    // Our own proof of the same state, which the acknowledgement carries. It
    // is built for the side that proposed the frame, because that is the side
    // the jurisdiction checks it against.
    let ack_dispute = match candidate.delta_transformer().copied() {
        None => None,
        Some(transformer) => {
            account.refresh_ack_dispute_draft(&candidate, &transformer, proposer == Side::Left)?
        }
    };
    let (ack_dispute_signature, ack_dispute_hanko) = match ack_dispute.as_ref() {
        Some(dispute) if dispute.hanko.is_none() => {
            let (signature, hanko) = identity.sign_frame_with_raw(&dispute.hash)?;
            (Some(signature), Some(hanko))
        }
        Some(_) | None => (None, None),
    };
    let domain = candidate.state().identity().domain().clone();
    account.commit_from_peer(
        candidate,
        &frame,
        state_hash,
        frame_hanko,
        ack_hanko.clone(),
    );
    // The ack this outcome carries is one the Entity commits in the account
    // leaf until a later proposal carries it, so the account remembers sending
    // it rather than the wire remembering for it.
    account.note_outbound_ack(
        frame.height,
        state_hash,
        ack_hanko.clone(),
        ack_dispute.clone(),
    );
    // Keep the freshly authored local proof during this existing worker visit.
    // The returned draft stays witness-free so Entity certification preserves
    // the same secondary manifest entry and signed bytes.
    if let (Some(dispute), Some(hanko)) = (&ack_dispute, &ack_dispute_hanko) {
        account.attach_locally_signed_dispute_hanko(dispute.hash, hanko.clone())?;
    }
    let queued = queue_post_commit_auto_rebalance(
        account,
        security.owning_entity_is_hub,
        "accountConsensus:postCommitAutoRebalance",
    )?;
    if queued > 0 {
        events.push(format!(
            "🔄 Auto-rebalance queued {queued} tx(s) after frame commit"
        ));
    }
    Ok(IncomingOutcome::Committed {
        height: frame.height,
        state_hash,
        ack_signature,
        ack_hanko,
        ack_dispute_signature: ack_dispute_signature.map(Box::new),
        ack_dispute_hanko,
        events,
        rolled_back,
        ack_dispute: ack_dispute.map(Box::new),
        committed_frame: Box::new(CommittedFrameEvidence {
            frame,
            state_hash,
            domain,
            outputs_by_tx,
            committed_via_new_frame: true,
        }),
    })
}

/// Classify proposal outcomes which provably cannot mutate Account state.
///
/// The resident forest calls this before creating a copy-on-write candidate,
/// and the canonical apply entrypoint calls the same function before its
/// mutating path. Keeping one classifier prevents the optimization from
/// becoming a second Account formula.
pub fn classify_incoming_frame_without_mutation(
    account: &AccountConsensus,
    identity: &SigningIdentity,
    envelope: &AccountInputEnvelope,
    incoming: &IncomingFrame,
    security: IncomingFrameSecurityContext<'_>,
) -> Result<Option<IncomingOutcome>, StateError> {
    if let Err(error) = validate_account_input_envelope(account, envelope) {
        return Ok(Some(rejected(error.to_string())));
    }
    if let Some(authority) = security.peer_certified_board_authority {
        authority.assert_entity(&envelope.from_entity_id)?;
    }
    if let Some(dispute) = incoming.dispute.as_ref()
        && let Err(error) = validate_counterparty_dispute_shape(dispute)
    {
        return Ok(Some(rejected(error.to_string())));
    }

    // At-least-once replay may re-ACK only the exact proposal certificate that
    // originally committed this head. The stored bytes were authenticated at
    // commit time, so byte equality is sufficient and remains valid across a
    // later board rotation; accepting a missing or freshly signed substitute
    // would turn equal (height, hash) into a second source of authority.
    // Equal-height hash conflicts deliberately fall through to active
    // validation: they are not stale traffic.
    let current_height = account.current_height();
    if incoming.frame.height == current_height
        && account
            .current()
            .is_some_and(|committed| committed.state_hash == incoming.state_hash)
    {
        // The supplied state_hash field is not self-authenticating. Bind it
        // back to the exact frame body before the duplicate fast path, or an
        // altered body carrying a copied hash would bypass normal validation.
        let received_hash = match incoming.frame.hash() {
            Ok(hash) => hash,
            Err(error) => return Ok(Some(rejected(error.to_string()))),
        };
        if received_hash != incoming.state_hash {
            return Ok(Some(rejected(format!(
                "DUPLICATE_FRAME_BYTES_CONFLICT:height={current_height}"
            ))));
        }
        let Some(frame_hanko) = incoming
            .frame_hanko
            .as_deref()
            .filter(|hanko| !hanko.is_empty())
        else {
            return Ok(Some(rejected("ACCOUNT_INPUT_FRAME_HANKO_MISSING")));
        };
        if account.counterparty_committed_frame_hanko() != Some(frame_hanko) {
            return Ok(Some(rejected("ACCOUNT_INPUT_FRAME_HANKO_CONFLICT")));
        }
        let ack_hanko = reusable_duplicate_ack_hanko(
            account.local_committed_frame_hanko(),
            account.replica().owner().as_bytes(),
            identity,
            &incoming.state_hash,
            incoming.frame.height,
            security.clock,
            security.local_certified_board_authority,
        )?;
        return Ok(Some(IncomingOutcome::Duplicate {
            height: incoming.frame.height,
            state_hash: incoming.state_hash,
            ack_hanko,
            // A re-sent acknowledgement carries the proof the original one
            // did, which the account still holds.
            ack_dispute: account
                .outbound_ack()
                .filter(|ack| ack.height == incoming.frame.height)
                .and_then(|ack| ack.dispute.clone())
                .map(Box::new),
        }));
    }
    if incoming.frame.height < current_height {
        return Ok(Some(IncomingOutcome::Stale {
            height: incoming.frame.height,
            current_height,
        }));
    }
    Ok(None)
}

/// Apply the peer's ack of our pending frame.
pub fn apply_incoming_ack(
    account: &mut AccountConsensus,
    envelope: &AccountInputEnvelope,
    incoming: IncomingAck,
    owning_entity_is_hub: bool,
) -> Result<AckOutcome, StateError> {
    apply_incoming_ack_with_authority(
        account,
        envelope,
        ReceiverClock {
            entity_timestamp: 0,
            finalized_j_height: 0,
        },
        incoming,
        None,
        owning_entity_is_hub,
    )
}

/// Apply an ACK as historical evidence for an already-authored pending frame.
/// The current board always verifies; the exact previous board verifies only
/// inside its certified grace window. Fresh incoming frames use the separate
/// current-board-only verifier above.
pub fn apply_incoming_ack_with_authority(
    account: &mut AccountConsensus,
    envelope: &AccountInputEnvelope,
    clock: ReceiverClock,
    incoming: IncomingAck,
    authority: Option<&CertifiedBoardAuthority>,
    owning_entity_is_hub: bool,
) -> Result<AckOutcome, StateError> {
    apply_incoming_ack_with_authority_mode(
        account,
        envelope,
        clock,
        incoming,
        authority,
        owning_entity_is_hub,
        true,
    )
}

fn apply_incoming_ack_with_authority_mode(
    account: &mut AccountConsensus,
    envelope: &AccountInputEnvelope,
    clock: ReceiverClock,
    incoming: IncomingAck,
    authority: Option<&CertifiedBoardAuthority>,
    owning_entity_is_hub: bool,
    allow_predecessor_noop: bool,
) -> Result<AckOutcome, StateError> {
    if let Err(error) = validate_account_input_envelope(account, envelope) {
        return Ok(AckOutcome::Rejected {
            reason: error.to_string(),
        });
    }
    if let Some(authority) = authority {
        authority.assert_entity(&envelope.from_entity_id)?;
    }
    let IncomingAck {
        height,
        frame_hash,
        frame_hanko,
        dispute,
    } = incoming;
    if let Some(dispute) = dispute.as_ref()
        && let Err(error) = validate_counterparty_dispute_shape(dispute)
    {
        return Ok(ack_rejected(error.to_string()));
    }

    if let Some(dispute) = dispute.as_ref() {
        if let Err(error) =
            validate_counterparty_dispute_hash(account.replica(), &envelope.from_entity_id, dispute)
        {
            return Ok(ack_rejected(error.to_string()));
        }
        if let Err(error) = verify_counterparty_dispute_with_authority(
            account.replica(),
            &envelope.from_entity_id,
            dispute,
            authority,
            clock.entity_timestamp,
            true,
        ) {
            return Ok(ack_rejected(error.to_string()));
        }
    }

    let current_height = account.current_height();
    if allow_predecessor_noop && current_height.checked_sub(1) == Some(height) && height > 0 {
        let Some(expected_hash) = account
            .current()
            .and_then(|current| parse_root_hex(&current.frame.prev_frame_hash))
        else {
            return Ok(ack_rejected("ACCOUNT_INPUT_ACK_PREDECESSOR_HASH_MISSING"));
        };
        if frame_hash != expected_hash {
            return Ok(ack_rejected("ACCOUNT_INPUT_ACK_HASH_MISMATCH"));
        }
        let Some(frame_hanko) = frame_hanko.filter(|hanko| !hanko.is_empty()) else {
            return Ok(ack_rejected("ACCOUNT_INPUT_ACK_HANKO_MISSING"));
        };
        if let Err(error) = verify_ack_hanko_with_authority(
            &frame_hanko,
            &frame_hash,
            &envelope.from_entity_id,
            authority,
            clock.entity_timestamp,
        ) {
            return Ok(ack_rejected(error.to_string()));
        }
        // The optional predecessor dispute witness was authenticated above,
        // but cannot replace current Account dispute evidence.
        return Ok(AckOutcome::Accepted { height });
    }

    let pending_height = account.pending().map(|pending| pending.frame.height);
    if height == current_height && height > 0 {
        let Some(current) = account.current() else {
            return Ok(ack_rejected("ACCOUNT_INPUT_ACK_CURRENT_FRAME_MISSING"));
        };
        if frame_hash != current.state_hash {
            return Ok(ack_rejected("ACCOUNT_INPUT_ACK_HASH_MISMATCH"));
        }
        let Some(frame_hanko) = frame_hanko.filter(|hanko| !hanko.is_empty()) else {
            return Ok(ack_rejected("ACCOUNT_INPUT_ACK_HANKO_MISSING"));
        };
        if account.counterparty_committed_frame_hanko() != Some(frame_hanko.as_slice()) {
            return Ok(ack_rejected("ACCOUNT_INPUT_ACK_HANKO_CONFLICT"));
        }
        if dispute
            .as_ref()
            .is_some_and(|incoming| account.counterparty_dispute() != Some(incoming))
        {
            return Ok(ack_rejected("ACCOUNT_INPUT_ACK_DISPUTE_HANKO_CONFLICT"));
        }
        if let Err(error) = verify_ack_hanko_with_authority(
            &frame_hanko,
            &frame_hash,
            &envelope.from_entity_id,
            authority,
            clock.entity_timestamp,
        ) {
            return Ok(ack_rejected(error.to_string()));
        }
        return Ok(AckOutcome::Accepted { height });
    }

    let Some(pending_height) = pending_height else {
        return Ok(AckOutcome::Rejected {
            reason: format!("ACCOUNT_INPUT_ACK_UNMATCHED:{height}:none"),
        });
    };
    if height != pending_height {
        return Ok(AckOutcome::Rejected {
            reason: format!("ACCOUNT_INPUT_ACK_UNMATCHED:{height}:{pending_height}"),
        });
    }

    let Some(frame_hanko) = frame_hanko.filter(|hanko| !hanko.is_empty()) else {
        return Ok(AckOutcome::Rejected {
            reason: "ACCOUNT_INPUT_ACK_HANKO_MISSING".to_string(),
        });
    };
    let pending = account.pending().ok_or_else(|| {
        StateError::TransitionFailed("ACCOUNT_PENDING_DISAPPEARED_DURING_ACK".to_string())
    })?;
    if let Some(reason) = counterparty_dispute_requirement_error(
        account.dispute().map(|draft| &draft.proof_body_hash),
        account.counterparty_dispute(),
        account.replica().state().j_nonce(),
        dispute.as_ref(),
    ) {
        return Ok(AckOutcome::Rejected { reason });
    }
    if pending.state_hash != frame_hash {
        return Ok(AckOutcome::Rejected {
            reason: "ACCOUNT_INPUT_ACK_HASH_MISMATCH".to_string(),
        });
    }
    if let Err(error) = verify_ack_hanko_with_authority(
        &frame_hanko,
        &frame_hash,
        &envelope.from_entity_id,
        authority,
        clock.entity_timestamp,
    ) {
        return Ok(ack_rejected(error.to_string()));
    }
    // Their proof of the state this ack commits, kept as it arrived.
    //
    // Parity target: `storeCounterpartyDisputeHanko` in
    // core/account/consensus/incoming/ack-commit.ts.
    if let Some(dispute) = dispute {
        account.store_counterparty_dispute(dispute);
    }
    // Authentication, dispute binding and frame binding are now complete.
    // Consume the resident pending row instead of cloning its full candidate
    // and output body before `commit_from_ack` clears it.
    let pending = account.take_pending().ok_or_else(|| {
        StateError::TransitionFailed("ACCOUNT_PENDING_DISAPPEARED_DURING_ACK".to_string())
    })?;
    let domain = pending.candidate.state().identity().domain().clone();
    let outputs_by_tx = std::sync::Arc::try_unwrap(pending.outputs_by_tx)
        .unwrap_or_else(|shared| shared.as_ref().clone());
    let mut events = vec![format!("✅ Frame {height} confirmed and committed")];
    account.commit_from_ack(
        pending.candidate,
        &pending.frame,
        pending.state_hash,
        frame_hanko,
        pending.hanko,
    );
    let queued = queue_post_commit_auto_rebalance(
        account,
        owning_entity_is_hub,
        "accountConsensus:ackAutoRebalance",
    )?;
    if queued > 0 {
        events.push(format!(
            "🔄 Auto-rebalance queued {queued} tx(s) after ACK commit"
        ));
    }
    Ok(AckOutcome::Committed {
        height,
        state_hash: pending.state_hash,
        events,
        committed_frame: Box::new(CommittedFrameEvidence {
            frame: pending.frame,
            state_hash: pending.state_hash,
            domain,
            outputs_by_tx,
            committed_via_new_frame: false,
        }),
    })
}

/// Apply one canonical `ack_frame` input in ACK-before-proposal order.
///
/// The phases mutate sequentially, exactly like TypeScript. A valid ACK is a
/// completed bilateral certificate and remains committed even when the bundled
/// proposal is invalid. Rolling it back would fork the two implementations at
/// the next height.
#[expect(
    clippy::too_many_arguments,
    reason = "the no-authority ACK+frame boundary keeps both ordered inputs and the transient owner role explicit; wrapping them would duplicate the canonical authority entrypoint"
)]
pub fn apply_incoming_ack_frame(
    account: &mut AccountConsensus,
    identity: &SigningIdentity,
    envelope: &AccountInputEnvelope,
    clock: ReceiverClock,
    ack: IncomingAck,
    frame: IncomingFrame,
    swap_market: &std::sync::Arc<crate::SwapMarketPolicy>,
    owning_entity_is_hub: bool,
) -> Result<AckFrameOutcome, StateError> {
    apply_incoming_ack_frame_with_authority(
        account,
        identity,
        envelope,
        ack,
        frame,
        swap_market,
        IncomingFrameSecurityContext {
            clock,
            owning_entity_is_hub,
            peer_certified_board_authority: None,
            local_certified_board_authority: None,
        },
    )
}

pub fn apply_incoming_ack_frame_with_authority(
    account: &mut AccountConsensus,
    identity: &SigningIdentity,
    envelope: &AccountInputEnvelope,
    ack: IncomingAck,
    frame: IncomingFrame,
    swap_market: &std::sync::Arc<crate::SwapMarketPolicy>,
    security: IncomingFrameSecurityContext<'_>,
) -> Result<AckFrameOutcome, StateError> {
    // Channel.ts emits one proposal and answers an exact retry with ACK only.
    // A bundled ACK is still peer-controlled evidence: authenticate it against
    // the known immediate predecessor before taking the duplicate-frame fast
    // path. Ignoring changed ACK bytes under an exact proposal would let a
    // valid frame hide a conflicting certificate.
    if frame.frame.height == account.current_height()
        && account
            .current()
            .is_some_and(|current| current.state_hash == frame.state_hash)
        && let Some(outcome) =
            classify_incoming_frame_without_mutation(account, identity, envelope, &frame, security)?
    {
        let Some(predecessor_height) = account.current_height().checked_sub(1) else {
            return Ok(AckFrameOutcome::Rejected {
                phase: AckFramePhase::Ack,
                reason: "ACCOUNT_INPUT_ACK_PREDECESSOR_HEIGHT_MISSING".to_string(),
            });
        };
        if predecessor_height == 0 || ack.height != predecessor_height {
            return Ok(AckFrameOutcome::Rejected {
                phase: AckFramePhase::Ack,
                reason: "ACCOUNT_INPUT_ACK_PREDECESSOR_HEIGHT_MISMATCH".to_string(),
            });
        }
        let replay_ack = apply_incoming_ack_with_authority_mode(
            account,
            envelope,
            security.clock,
            ack,
            security.peer_certified_board_authority,
            security.owning_entity_is_hub,
            true,
        )?;
        match replay_ack {
            AckOutcome::Accepted { .. } => {}
            AckOutcome::Rejected { reason } => {
                return Ok(AckFrameOutcome::Rejected {
                    phase: AckFramePhase::Ack,
                    reason,
                });
            }
            _ => {
                return Err(StateError::TransitionFailed(
                    "ACCOUNT_INPUT_ACK_REPLAY_MUTATION_INVARIANT".to_string(),
                ));
            }
        }
        return Ok(AckFrameOutcome::Replay {
            frame: Box::new(outcome),
        });
    }
    let ack = apply_incoming_ack_with_authority_mode(
        account,
        envelope,
        security.clock,
        ack,
        security.peer_certified_board_authority,
        security.owning_entity_is_hub,
        false,
    )?;
    if let AckOutcome::Rejected { reason } = &ack {
        return Ok(AckFrameOutcome::Rejected {
            phase: AckFramePhase::Ack,
            reason: reason.clone(),
        });
    }
    let frame = apply_incoming_frame_with_authority(
        account,
        identity,
        envelope,
        frame,
        swap_market,
        security,
    )?;
    Ok(AckFrameOutcome::Applied {
        ack: Box::new(ack),
        frame: Box::new(frame),
    })
}

#[cfg(test)]
mod authority_tests {
    use super::*;
    use crate::consensus::signing::{reset_test_sign_frame_calls, test_sign_frame_calls};
    use crate::verify_dispute_hanko_with_authority;
    use xln_rscore_hanko::{
        BoardDelays, BoardMember, SemanticClaim, build_single_signer_hanko, hash_hanko_board_claim,
    };

    fn board_hash(entity_id: [u8; 32], private_key: &[u8; 32]) -> [u8; 32] {
        let address = crate::address_of_private_key(private_key).expect("signer address");
        let mut member_entity = [0_u8; 32];
        member_entity[12..].copy_from_slice(&address);
        hash_hanko_board_claim(&SemanticClaim {
            entity_id,
            members: vec![BoardMember {
                entity_id: member_entity,
                weight: 2,
            }],
            threshold: 2,
            delays: BoardDelays::default(),
        })
    }

    #[test]
    fn duplicate_ack_reuses_verified_bytes_without_invoking_the_signer() {
        let private_key = [0x31_u8; 32];
        let digest = [0x47_u8; 32];
        let identity = SigningIdentity::lazy_from_key(
            private_key,
            "duplicate-ack",
            1,
            1,
            BoardDelays::default(),
        )
        .expect("identity");
        let persisted = identity.sign_frame(&digest).expect("initial ACK Hanko");
        reset_test_sign_frame_calls();
        let clock = ReceiverClock {
            entity_timestamp: 1_700_000_000_000,
            finalized_j_height: 0,
        };

        let reused = reusable_duplicate_ack_hanko(
            Some(&persisted),
            identity.entity_id(),
            &identity,
            &digest,
            7,
            clock,
            None,
        )
        .expect("verified cached Hanko");

        assert_eq!(reused, persisted);
        assert_eq!(test_sign_frame_calls(), 0);

        let missing = reusable_duplicate_ack_hanko(
            None,
            identity.entity_id(),
            &identity,
            &digest,
            7,
            clock,
            None,
        )
        .expect_err("missing cached Hanko must fail loud");
        assert_eq!(
            missing.to_string(),
            "ACCOUNT_SIGNING:DUPLICATE_ACK_LOCAL_COMMITTED_FRAME_HANKO_MISSING:height=7"
        );
        assert_eq!(test_sign_frame_calls(), 0);

        let corrupt = reusable_duplicate_ack_hanko(
            Some(&[0_u8]),
            identity.entity_id(),
            &identity,
            &digest,
            7,
            clock,
            None,
        )
        .expect_err("corrupt cached Hanko must fail loud");
        assert!(corrupt.to_string().starts_with(
            "ACCOUNT_SIGNING:DUPLICATE_ACK_LOCAL_COMMITTED_FRAME_HANKO_INVALID:height=7:"
        ));
        assert_eq!(test_sign_frame_calls(), 0);
    }

    #[test]
    fn duplicate_ack_accepts_local_previous_board_only_inside_grace_without_signing() {
        let current_key = [0x31_u8; 32];
        let previous_key = [0x32_u8; 32];
        let digest = [0x49_u8; 32];
        let registered_entity = [0x9c_u8; 32];
        let identity = SigningIdentity::from_key(
            current_key,
            "rotated-local",
            registered_entity,
            2,
            2,
            BoardDelays::default(),
        );
        let persisted = build_single_signer_hanko(
            &registered_entity,
            &digest,
            &previous_key,
            2,
            2,
            BoardDelays::default(),
        )
        .expect("previous local ACK Hanko");
        let valid_until = 1_700_604_800_u64;
        let local_authority = CertifiedBoardAuthority {
            entity_id: registered_entity,
            registered_board_hash: board_hash(registered_entity, &current_key),
            previous_board_hash: board_hash(registered_entity, &previous_key),
            previous_board_valid_until: valid_until,
            activated_at_j_height: 19,
            activation_log_index: 2,
        };
        let clock = |entity_timestamp| ReceiverClock {
            entity_timestamp,
            finalized_j_height: 0,
        };
        reset_test_sign_frame_calls();

        let reused = reusable_duplicate_ack_hanko(
            Some(&persisted),
            &registered_entity,
            &identity,
            &digest,
            7,
            clock(valid_until * 1_000 - 1),
            Some(&local_authority),
        )
        .expect("previous local board inside grace");
        assert_eq!(reused, persisted);
        assert_eq!(test_sign_frame_calls(), 0);

        for entity_timestamp in [valid_until * 1_000, (valid_until + 1) * 1_000] {
            let expired = reusable_duplicate_ack_hanko(
                Some(&persisted),
                &registered_entity,
                &identity,
                &digest,
                7,
                clock(entity_timestamp),
                Some(&local_authority),
            )
            .expect_err("expired previous local board must fail loud");
            assert!(expired.to_string().starts_with(
                "ACCOUNT_SIGNING:DUPLICATE_ACK_LOCAL_COMMITTED_FRAME_HANKO_INVALID:height=7:"
            ));
            assert_eq!(test_sign_frame_calls(), 0);
        }
    }

    #[test]
    fn a_registered_threshold_board_verifies_only_against_its_certified_hash() {
        let private_key = [0x31_u8; 32];
        let digest = [0x47_u8; 32];
        let registered_entity = [0x9a_u8; 32];
        let hanko = build_single_signer_hanko(
            &registered_entity,
            &digest,
            &private_key,
            2,
            2,
            BoardDelays::default(),
        )
        .expect("registered hanko");
        let registered_board_hash = board_hash(registered_entity, &private_key);

        assert!(matches!(
            verify_frame_hanko_with_authority(&hanko, &digest, &registered_entity, None),
            Err(StateError::BoardAuthorityUnavailable),
        ));
        verify_frame_hanko_with_authority(
            &hanko,
            &digest,
            &registered_entity,
            Some(&CertifiedBoardAuthority {
                entity_id: registered_entity,
                registered_board_hash,
                previous_board_hash: [0_u8; 32],
                previous_board_valid_until: 0,
                activated_at_j_height: 1,
                activation_log_index: 0,
            }),
        )
        .expect("certified current board");
        assert!(matches!(
            verify_frame_hanko_with_authority(
                &hanko,
                &digest,
                &registered_entity,
                Some(&CertifiedBoardAuthority {
                    entity_id: registered_entity,
                    registered_board_hash: [0x55_u8; 32],
                    previous_board_hash: [0_u8; 32],
                    previous_board_valid_until: 0,
                    activated_at_j_height: 1,
                    activation_log_index: 0,
                }),
            ),
            Err(StateError::BoardAuthorityUnavailable),
        ));
        let wrong_peer = CertifiedBoardAuthority {
            entity_id: [0x54_u8; 32],
            registered_board_hash,
            previous_board_hash: [0_u8; 32],
            previous_board_valid_until: 0,
            activated_at_j_height: 1,
            activation_log_index: 0,
        };
        assert!(matches!(
            verify_frame_hanko_with_authority(
                &hanko,
                &digest,
                &registered_entity,
                Some(&wrong_peer),
            ),
            Err(StateError::BoardAuthorityCounterpartyMismatch { .. }),
        ));
    }

    #[test]
    fn historical_ack_and_dispute_accept_the_exact_previous_board_before_exclusive_expiry() {
        let current_key = [0x31_u8; 32];
        let previous_key = [0x32_u8; 32];
        let digest = [0x48_u8; 32];
        let registered_entity = [0x9b_u8; 32];
        let previous_hanko = build_single_signer_hanko(
            &registered_entity,
            &digest,
            &previous_key,
            2,
            2,
            BoardDelays::default(),
        )
        .expect("previous-board hanko");
        let activated_at_seconds = 1_700_000_000_u64;
        let valid_until = activated_at_seconds + 7 * 24 * 60 * 60;
        let authority = CertifiedBoardAuthority {
            entity_id: registered_entity,
            registered_board_hash: board_hash(registered_entity, &current_key),
            previous_board_hash: board_hash(registered_entity, &previous_key),
            previous_board_valid_until: valid_until,
            activated_at_j_height: 77,
            activation_log_index: 4,
        };

        assert!(matches!(
            verify_frame_hanko_with_authority(
                &previous_hanko,
                &digest,
                &registered_entity,
                Some(&authority),
            ),
            Err(StateError::BoardAuthorityUnavailable),
        ));
        verify_ack_hanko_with_authority(
            &previous_hanko,
            &digest,
            &registered_entity,
            Some(&authority),
            valid_until * 1_000 - 1,
        )
        .expect("historical ACK inside grace");
        assert!(matches!(
            verify_ack_hanko_with_authority(
                &previous_hanko,
                &digest,
                &registered_entity,
                Some(&authority),
                valid_until * 1_000,
            ),
            Err(StateError::BoardAuthorityUnavailable),
        ));
        assert!(matches!(
            verify_ack_hanko_with_authority(
                &previous_hanko,
                &digest,
                &registered_entity,
                Some(&authority),
                (valid_until + 1) * 1_000,
            ),
            Err(StateError::BoardAuthorityUnavailable),
        ));
        verify_dispute_hanko_with_authority(
            &previous_hanko,
            &digest,
            &registered_entity,
            Some(&authority),
            valid_until * 1_000 - 1,
            true,
        )
        .expect("historical proof inside grace");
        assert!(matches!(
            verify_dispute_hanko_with_authority(
                &previous_hanko,
                &digest,
                &registered_entity,
                Some(&authority),
                valid_until * 1_000,
                true,
            ),
            Err(StateError::BoardAuthorityUnavailable),
        ));
        assert!(matches!(
            verify_dispute_hanko_with_authority(
                &previous_hanko,
                &digest,
                &registered_entity,
                Some(&authority),
                valid_until * 1_000 - 1,
                false,
            ),
            Err(StateError::BoardAuthorityUnavailable),
        ));
    }
}
