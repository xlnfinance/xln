//! Applying a counterparty's frame, and their ack of ours.
//!
//! Parity target: core/account/consensus/incoming/{preflight,collision,replay,
//! ack-commit,commit-root}.ts. Authentication comes first, then the structural
//! checks, then replay — and the frame commits only when our own replay
//! reproduces the exact account state root and frame hash the peer signed.

use crate::consensus::frame::hash::AccountFrame;
use crate::consensus::proposal::propose::{WindowExecution, collect_frame_deltas, execute_window};
use crate::consensus::replica::AccountConsensus;
use crate::consensus::signing::{SigningIdentity, verify_frame_hanko};
use crate::dispute::{
    counterparty_dispute_requirement_error, proof_body_hash, validate_counterparty_dispute_hash,
    validate_counterparty_dispute_shape, verify_counterparty_dispute,
};
use crate::error::StateError;
use crate::input::mempool::ACCOUNT_MEMPOOL_SIZE;
use crate::{AccountExecutionContext, AccountOutput, Side};

use super::types::{
    AccountPeerEnvelope, FrameAckOutcome, FrameAckPhase, IncomingAck, IncomingFrame,
    validate_peer_envelope,
};

/// `ACCOUNT_NETWORK_ALLOWANCE_MS` (core/account/consensus/constants.ts). A peer
/// chooses its own frame timestamp, so a frame from the future could satisfy
/// payer-side deadlines early. Old signed frames stay legal: exact
/// retransmission must survive an outage of any length.
const MAX_FRAME_FUTURE_SKEW_MS: u64 = 30_000;

/// `MAX_ACCOUNT_FRAME_TXS` (core/account/consensus/frame/hash.ts), which is
/// the mempool bound.
const MAX_ACCOUNT_FRAME_TXS: usize = ACCOUNT_MEMPOOL_SIZE;

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
    pub committed_via_new_frame: bool,
}

#[derive(Clone, Debug)]
pub enum IncomingOutcome {
    /// The frame is now the chain head; the ack is ours to send.
    Committed {
        height: u64,
        state_hash: [u8; 32],
        ack_hanko: Vec<u8>,
        outputs: Vec<AccountOutput>,
        /// Set when our own same-height proposal lost the collision and its
        /// transactions went back to the queue.
        rolled_back_txs: usize,
        committed_frame: CommittedFrameEvidence,
    },
    /// We are LEFT and the peer raced us at the same height: our proposal
    /// stands and their frame is ignored until they ack it.
    CollisionIgnored {
        height: u64,
    },
    /// Already committed at this height with this hash: re-ack, do not replay.
    Duplicate {
        height: u64,
        state_hash: [u8; 32],
        ack_hanko: Vec<u8>,
    },
    /// Already behind our chain head: an at-least-once retransmission, which
    /// is applied as a no-op rather than treated as a fault.
    Stale {
        height: u64,
        current_height: u64,
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
        outputs: Vec<AccountOutput>,
        committed_frame: CommittedFrameEvidence,
    },
    /// Nothing is pending at that height any more — a retransmitted ack.
    Stale {
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

/// Apply a peer's proposal.
pub fn apply_incoming_frame(
    account: &mut AccountConsensus,
    identity: &SigningIdentity,
    envelope: &AccountPeerEnvelope,
    clock: ReceiverClock,
    incoming: IncomingFrame,
    swap_market: &std::sync::Arc<crate::SwapMarketPolicy>,
) -> Result<IncomingOutcome, StateError> {
    if let Err(error) = validate_peer_envelope(account, envelope) {
        return Ok(rejected(error.to_string()));
    }
    let IncomingFrame {
        frame,
        state_hash,
        frame_hanko,
        dispute,
    } = incoming;
    if let Some(dispute) = dispute.as_ref()
        && let Err(error) = validate_counterparty_dispute_shape(dispute)
    {
        return Ok(rejected(error.to_string()));
    }

    // At-least-once replay is classified from the exact signed hash before
    // obsolete certificate material is inspected. TypeScript rebuilds an ACK
    // for an exact-current retry and ignores an older ancestor even when the
    // old proposal no longer carries a usable frame Hanko. Equal-height hash
    // conflicts deliberately fall through: they are not stale traffic.
    let current_height = account.current_height();
    if frame.height == current_height
        && account
            .current()
            .is_some_and(|committed| committed.state_hash == state_hash)
    {
        return Ok(IncomingOutcome::Duplicate {
            height: frame.height,
            state_hash,
            ack_hanko: identity.sign_frame(&state_hash)?,
        });
    }
    if frame.height < current_height {
        return Ok(IncomingOutcome::Stale {
            height: frame.height,
            current_height,
        });
    }

    let Some(frame_hanko) = frame_hanko else {
        return Ok(rejected("ACCOUNT_PEER_FRAME_HANKO_MISSING"));
    };
    if let Some(dispute) = dispute.as_ref()
        && let Err(error) =
            validate_counterparty_dispute_hash(account.replica(), &envelope.from_entity_id, dispute)
    {
        return Ok(rejected(error.to_string()));
    }
    // SECURITY: authenticate before touching any state, exactly as preflight
    // does. An unsigned frame is not evidence of anything.
    if let Err(error) = verify_frame_hanko(&frame_hanko, &state_hash, &envelope.from_entity_id) {
        return Ok(rejected(error.to_string()));
    }
    let received_hash = match frame.hash() {
        Ok(hash) => hash,
        Err(error) => return Ok(rejected(error.to_string())),
    };
    if received_hash != state_hash {
        return Ok(rejected("ACCOUNT_PEER_FRAME_HASH_MISMATCH"));
    }
    if frame.txs.len() > MAX_ACCOUNT_FRAME_TXS {
        return Ok(rejected(format!(
            "ACCOUNT_PEER_FRAME_STRUCTURE_INVALID:txs:{}",
            frame.txs.len()
        )));
    }
    if frame.timestamp
        > clock
            .entity_timestamp
            .saturating_add(MAX_FRAME_FUTURE_SKEW_MS)
    {
        return Ok(rejected(format!(
            "ACCOUNT_PEER_FRAME_STRUCTURE_INVALID:skew:{}",
            frame.timestamp - clock.entity_timestamp
        )));
    }

    // Every input that can still move consensus authenticates the witness
    // here, before replay or collision handling mutates anything.
    if let Some(dispute) = dispute.as_ref()
        && let Err(error) =
            verify_counterparty_dispute(account.replica(), &envelope.from_entity_id, dispute)
    {
        return Ok(rejected(error.to_string()));
    }

    // Each side may propose once at a height. If both race, the LEFT entity's
    // frame wins: the loser's proposal never acquired the counterparty Hanko
    // it would need to be enforceable. Nothing is rolled back yet — a frame
    // that fails validation below must leave our own proposal standing.
    let collides = account
        .pending()
        .is_some_and(|pending| pending.frame.height == frame.height);
    if collides {
        if account.replica().owner_side() == Side::Left {
            return Ok(IncomingOutcome::CollisionIgnored {
                height: frame.height,
            });
        }
        if account.last_rollback_frame_hash() == Some(&state_hash) {
            return Ok(rejected(format!(
                "ACCOUNT_PEER_FRAME_ROLLBACK_DUPLICATE:{}",
                frame.height
            )));
        }
    }

    if frame.height != current_height + 1 {
        return Ok(rejected(format!(
            "ACCOUNT_PEER_FRAME_HEIGHT_GAP:{}:{current_height}",
            frame.height
        )));
    }
    if frame.prev_frame_hash != account.prev_frame_hash() {
        return Ok(rejected(format!(
            "ACCOUNT_PEER_FRAME_PREV_MISMATCH:{}",
            frame.prev_frame_hash
        )));
    }
    if frame.by_left != (account.replica().owner_side() == Side::Right) {
        // `byLeft` is the proposer's side, and the proposer is our
        // counterparty. A frame claiming our own side would let one entity
        // author both directions of the account.
        return Ok(rejected(format!(
            "ACCOUNT_PEER_FRAME_BY_LEFT_MISMATCH:{}",
            frame.by_left
        )));
    }

    // The committed clock is the peer's — it is what they signed — but
    // enforcement is judged on our own clock, so a backdated frame cannot
    // decide our timeouts for us.
    let context = AccountExecutionContext::with_market(
        frame.timestamp,
        clock.entity_timestamp,
        clock.finalized_j_height,
        current_height,
        frame.j_height,
        std::sync::Arc::clone(swap_market),
    );
    let proposer = account.replica().owner_side().opposite();
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
        outputs,
        dropped,
    } = execution;
    if let Some(first) = dropped.first() {
        // The peer signed this transaction into the frame, so a rejection is a
        // disagreement about the whole frame, never a dropped transaction.
        return Ok(rejected(format!(
            "ACCOUNT_PEER_FRAME_TX_REJECTED:{}:{:?}",
            first.index, first.rejection
        )));
    }
    if applied != frame.txs {
        return Ok(rejected("ACCOUNT_PEER_FRAME_TX_COUNT_MISMATCH"));
    }

    let account_state_root = candidate.refresh_account_state_root()?;
    if account_state_root != frame.account_state_root {
        return Ok(rejected("ACCOUNT_PEER_FRAME_STATE_ROOT_MISMATCH"));
    }
    let derived_deltas = collect_frame_deltas(&candidate);
    if derived_deltas != frame.deltas {
        return Ok(rejected("ACCOUNT_PEER_FRAME_DELTAS_MISMATCH"));
    }

    let expected_proof_body_hash = candidate
        .delta_transformer()
        .map(|transformer| proof_body_hash(&candidate, transformer))
        .transpose()?;
    if let Some(reason) = counterparty_dispute_requirement_error(
        expected_proof_body_hash.as_ref(),
        account.counterparty_dispute(),
        candidate.state().j_nonce(),
        dispute.as_ref(),
    ) {
        return Ok(rejected(reason));
    }

    // Only now, with the frame proven to be one we can commit, does our own
    // proposal give way to it.
    //
    // Parity target: `applySameHeightIncomingFrameRollback`
    // (core/account/consensus/index.ts), which runs after the replay.
    let rolled_back_txs = if collides {
        account.rollback_pending(state_hash)?
    } else {
        0
    };

    let ack_hanko = identity.sign_frame(&state_hash)?;
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
            account.refresh_ack_dispute_draft(&candidate, &transformer, frame.by_left)?
        }
    };
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
    account.note_outbound_ack(frame.height, state_hash, ack_hanko.clone(), ack_dispute);
    Ok(IncomingOutcome::Committed {
        height: frame.height,
        state_hash,
        ack_hanko,
        outputs,
        rolled_back_txs,
        committed_frame: CommittedFrameEvidence {
            frame,
            committed_via_new_frame: true,
        },
    })
}

/// Apply the peer's ack of our pending frame.
pub fn apply_incoming_ack(
    account: &mut AccountConsensus,
    envelope: &AccountPeerEnvelope,
    incoming: IncomingAck,
) -> Result<AckOutcome, StateError> {
    if let Err(error) = validate_peer_envelope(account, envelope) {
        return Ok(AckOutcome::Rejected {
            reason: error.to_string(),
        });
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

    let current_height = account.current_height();
    let pending_height = account.pending().map(|pending| pending.frame.height);
    let has_certificate = frame_hanko.as_ref().is_some_and(|hanko| !hanko.is_empty());
    let replay_is_stale = height > 0
        && match pending_height {
            Some(pending_height) => height < pending_height,
            None => height <= current_height,
        };
    // TypeScript's first replay gate uses certificate *presence*, not
    // validity. A non-empty obsolete Hanko may be unverifiable after board
    // rotation and still remains an at-least-once no-op. Shape-invalid dispute
    // evidence was rejected above; its obsolete signature/hash are skipped.
    if has_certificate && replay_is_stale {
        return Ok(AckOutcome::Stale { height });
    }

    if let Some(dispute) = dispute.as_ref() {
        if let Err(error) =
            validate_counterparty_dispute_hash(account.replica(), &envelope.from_entity_id, dispute)
        {
            return Ok(ack_rejected(error.to_string()));
        }
        if let Err(error) =
            verify_counterparty_dispute(account.replica(), &envelope.from_entity_id, dispute)
        {
            return Ok(ack_rejected(error.to_string()));
        }
    }

    let Some(pending_height) = pending_height else {
        // Without the pending proposal, neither an old ACK nor the next ACK
        // can advance state. The next height is an ordinary early delivery;
        // anything beyond it is unmatched future traffic and must stay loud.
        if height > 0 && height <= current_height.saturating_add(1) {
            return Ok(AckOutcome::Stale { height });
        }
        return Ok(AckOutcome::Rejected {
            reason: format!("ACCOUNT_PEER_ACK_UNMATCHED:{height}:none"),
        });
    };
    if height != pending_height {
        if height > 0 && height <= current_height {
            return Ok(AckOutcome::Stale { height });
        }
        return Ok(AckOutcome::Rejected {
            reason: format!("ACCOUNT_PEER_ACK_UNMATCHED:{height}:{pending_height}"),
        });
    }

    let Some(frame_hanko) = frame_hanko.filter(|hanko| !hanko.is_empty()) else {
        return Ok(AckOutcome::Rejected {
            reason: "ACCOUNT_PEER_ACK_HANKO_MISSING".to_string(),
        });
    };
    let pending = account.pending().expect("pending height checked above");
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
            reason: "ACCOUNT_PEER_ACK_HASH_MISMATCH".to_string(),
        });
    }
    if let Err(error) = verify_frame_hanko(&frame_hanko, &frame_hash, &envelope.from_entity_id) {
        return Ok(ack_rejected(error.to_string()));
    }
    // Their proof of the state this ack commits, kept as it arrived.
    //
    // Parity target: `storeCounterpartyDisputeHanko` in
    // core/account/consensus/incoming/ack-commit.ts.
    if let Some(dispute) = dispute {
        account.store_counterparty_dispute(dispute);
    }
    let pending = account.pending().expect("pending checked above").clone();
    let outputs = pending.outputs;
    account.commit_from_ack(
        pending.candidate,
        &pending.frame,
        pending.state_hash,
        frame_hanko,
        pending.hanko,
    );
    Ok(AckOutcome::Committed {
        height,
        state_hash: pending.state_hash,
        outputs,
        committed_frame: CommittedFrameEvidence {
            frame: pending.frame,
            committed_via_new_frame: false,
        },
    })
}

/// Apply one canonical `frame_ack` input in ACK-before-proposal order.
///
/// Both phases run against a private Account candidate. A rejection or fault
/// publishes nothing, including an ACK commit that succeeded before a bad
/// proposal was examined.
pub fn apply_incoming_frame_ack(
    account: &mut AccountConsensus,
    identity: &SigningIdentity,
    envelope: &AccountPeerEnvelope,
    clock: ReceiverClock,
    ack: IncomingAck,
    frame: IncomingFrame,
    swap_market: &std::sync::Arc<crate::SwapMarketPolicy>,
) -> Result<FrameAckOutcome, StateError> {
    let mut candidate = account.clone();
    let ack = apply_incoming_ack(&mut candidate, envelope, ack)?;
    if let AckOutcome::Rejected { reason } = &ack {
        return Ok(FrameAckOutcome::Rejected {
            phase: FrameAckPhase::Ack,
            reason: reason.clone(),
        });
    }
    let frame = apply_incoming_frame(
        &mut candidate,
        identity,
        envelope,
        clock,
        frame,
        swap_market,
    )?;
    if let IncomingOutcome::Rejected { reason } = &frame {
        return Ok(FrameAckOutcome::Rejected {
            phase: FrameAckPhase::Frame,
            reason: reason.clone(),
        });
    }
    *account = candidate;
    Ok(FrameAckOutcome::Applied {
        ack: Box::new(ack),
        frame: Box::new(frame),
    })
}
