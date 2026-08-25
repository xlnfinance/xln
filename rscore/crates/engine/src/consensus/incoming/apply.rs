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
    counterparty_dispute_requirement_error, proof_body_hash, validate_counterparty_dispute_shape,
    verify_counterparty_dispute,
};
use crate::error::StateError;
use crate::input::mempool::ACCOUNT_MEMPOOL_SIZE;
use crate::{AccountExecutionContext, AccountOutput, AccountTx, Side};

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
#[derive(Clone, Copy, Debug)]
pub struct ReceiverClock {
    pub entity_timestamp: u64,
    pub finalized_j_height: u64,
}

/// A frame as it arrives from the peer: the fields they signed, plus the
/// Hanko over the frame hash.
#[derive(Clone, Debug)]
pub struct IncomingFrame {
    pub height: u64,
    pub timestamp: u64,
    pub j_height: u64,
    pub txs: Vec<AccountTx>,
    pub prev_frame_hash: String,
    pub account_state_root: [u8; 32],
    pub by_left: bool,
    pub state_hash: [u8; 32],
    pub hanko: Vec<u8>,
    /// The proposer's own recovery proof for the state this frame commits to,
    /// when their message carried one.
    pub dispute: Option<crate::consensus::replica::CounterpartyDispute>,
}

#[derive(Debug)]
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

#[derive(Debug)]
pub enum AckOutcome {
    /// The peer acknowledged our pending frame; it is committed on both sides,
    /// and only now may its effects leave the account.
    Committed {
        height: u64,
        state_hash: [u8; 32],
        outputs: Vec<AccountOutput>,
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

/// Apply a peer's proposal.
pub fn apply_incoming_frame(
    account: &mut AccountConsensus,
    identity: &SigningIdentity,
    counterparty_entity_id: &[u8; 32],
    clock: ReceiverClock,
    incoming: IncomingFrame,
    swap_market: &std::sync::Arc<crate::SwapMarketPolicy>,
) -> Result<IncomingOutcome, StateError> {
    // SECURITY: the signer must be this account's counterparty. A Hanko only
    // proves who signed; without this, any entity that can sign could author
    // frames into an account it is not a party to.
    //
    // Parity target: `validateIncomingFrameProposer`
    // (core/account/consensus/incoming/preflight.ts).
    if counterparty_entity_id != account.replica().counterparty().as_bytes() {
        return Ok(rejected("ACCOUNT_PEER_FRAME_PROPOSER_INVALID"));
    }
    if let Some(dispute) = incoming.dispute.as_ref() {
        validate_counterparty_dispute_shape(dispute)?;
    }
    // SECURITY: authenticate before touching any state, exactly as preflight
    // does. An unsigned frame is not evidence of anything.
    verify_frame_hanko(
        &incoming.hanko,
        &incoming.state_hash,
        counterparty_entity_id,
    )?;
    if incoming.txs.len() > MAX_ACCOUNT_FRAME_TXS {
        return Ok(rejected(format!(
            "ACCOUNT_PEER_FRAME_STRUCTURE_INVALID:txs:{}",
            incoming.txs.len()
        )));
    }
    if incoming.timestamp
        > clock
            .entity_timestamp
            .saturating_add(MAX_FRAME_FUTURE_SKEW_MS)
    {
        return Ok(rejected(format!(
            "ACCOUNT_PEER_FRAME_STRUCTURE_INVALID:skew:{}",
            incoming.timestamp - clock.entity_timestamp
        )));
    }

    let current_height = account.current_height();
    if incoming.height <= current_height {
        let committed = account.current();
        let duplicate = committed.is_some_and(|frame| {
            frame.frame.height == incoming.height && frame.state_hash == incoming.state_hash
        });
        if duplicate {
            return Ok(IncomingOutcome::Duplicate {
                height: incoming.height,
                state_hash: incoming.state_hash,
                ack_hanko: identity.sign_frame(&incoming.state_hash)?,
            });
        }
        // Delivery is at-least-once, so an ancestor frame arriving again is
        // ordinary traffic, not peer misbehaviour.
        //
        // Parity target: `handleStaleIncomingFrame`
        // (core/account/consensus/incoming/preflight.ts), which returns an
        // applied no-op.
        return Ok(IncomingOutcome::Stale {
            height: incoming.height,
            current_height,
        });
    }

    // TypeScript's at-least-once replay gate runs before dispute-witness
    // validation: an exact duplicate or stale ancestor is a no-op even if its
    // obsolete optional witness cannot be decoded under today's board. Every
    // input that can still move consensus authenticates the witness here,
    // before replay or collision handling mutates anything.
    if let Some(dispute) = incoming.dispute.as_ref() {
        verify_counterparty_dispute(account.replica(), counterparty_entity_id, dispute)?;
    }

    // Each side may propose once at a height. If both race, the LEFT entity's
    // frame wins: the loser's proposal never acquired the counterparty Hanko
    // it would need to be enforceable. Nothing is rolled back yet — a frame
    // that fails validation below must leave our own proposal standing.
    let collides = account
        .pending()
        .is_some_and(|pending| pending.frame.height == incoming.height);
    if collides {
        if account.replica().owner_side() == Side::Left {
            return Ok(IncomingOutcome::CollisionIgnored {
                height: incoming.height,
            });
        }
        if account.last_rollback_frame_hash() == Some(&incoming.state_hash) {
            return Ok(rejected(format!(
                "ACCOUNT_PEER_FRAME_ROLLBACK_DUPLICATE:{}",
                incoming.height
            )));
        }
    }

    if incoming.height != current_height + 1 {
        return Ok(rejected(format!(
            "ACCOUNT_PEER_FRAME_HEIGHT_GAP:{}:{current_height}",
            incoming.height
        )));
    }
    if incoming.prev_frame_hash != account.prev_frame_hash() {
        return Ok(rejected(format!(
            "ACCOUNT_PEER_FRAME_PREV_MISMATCH:{}",
            incoming.prev_frame_hash
        )));
    }
    if incoming.by_left != (account.replica().owner_side() == Side::Right) {
        // `byLeft` is the proposer's side, and the proposer is our
        // counterparty. A frame claiming our own side would let one entity
        // author both directions of the account.
        return Ok(rejected(format!(
            "ACCOUNT_PEER_FRAME_BY_LEFT_MISMATCH:{}",
            incoming.by_left
        )));
    }

    // The committed clock is the peer's — it is what they signed — but
    // enforcement is judged on our own clock, so a backdated frame cannot
    // decide our timeouts for us.
    let context = AccountExecutionContext::with_market(
        incoming.timestamp,
        clock.entity_timestamp,
        clock.finalized_j_height,
        current_height,
        incoming.j_height,
        std::sync::Arc::clone(swap_market),
    );
    let proposer = account.replica().owner_side().opposite();
    let execution = execute_window(
        account.replica(),
        proposer,
        incoming.txs.clone(),
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
    if applied.len() != incoming.txs.len() {
        return Ok(rejected("ACCOUNT_PEER_FRAME_TX_COUNT_MISMATCH"));
    }

    let account_state_root = candidate.refresh_account_state_root()?;
    if account_state_root != incoming.account_state_root {
        return Ok(rejected("ACCOUNT_PEER_FRAME_STATE_ROOT_MISMATCH"));
    }
    let frame = AccountFrame {
        height: incoming.height,
        timestamp: incoming.timestamp,
        j_height: incoming.j_height,
        txs: applied,
        prev_frame_hash: incoming.prev_frame_hash.clone(),
        account_state_root,
        by_left: incoming.by_left,
        deltas: collect_frame_deltas(&candidate),
    };
    let state_hash = frame.hash()?;
    if state_hash != incoming.state_hash {
        // The signature was over their bytes; ours differ, so the two sides
        // do not agree on what this frame says.
        return Ok(rejected("ACCOUNT_PEER_FRAME_HASH_MISMATCH"));
    }

    let expected_proof_body_hash = candidate
        .delta_transformer()
        .map(|transformer| proof_body_hash(&candidate, transformer))
        .transpose()?;
    if let Some(reason) = counterparty_dispute_requirement_error(
        expected_proof_body_hash.as_ref(),
        account.counterparty_dispute(),
        candidate.state().j_nonce(),
        incoming.dispute.as_ref(),
    ) {
        return Ok(rejected(reason));
    }

    // Only now, with the frame proven to be one we can commit, does our own
    // proposal give way to it.
    //
    // Parity target: `applySameHeightIncomingFrameRollback`
    // (core/account/consensus/index.ts), which runs after the replay.
    let rolled_back_txs = if collides {
        account.rollback_pending(incoming.state_hash)?
    } else {
        0
    };

    let ack_hanko = identity.sign_frame(&state_hash)?;
    // Their proof of the state they just proposed was authenticated against
    // the reconstructed Solidity digest before replay, then checked against
    // this exact candidate proof body above. Only now may it be retained.
    if let Some(dispute) = incoming.dispute.clone() {
        account.store_counterparty_dispute(dispute);
    }
    // Our own proof of the same state, which the acknowledgement carries. It
    // is built for the side that proposed the frame, because that is the side
    // the jurisdiction checks it against.
    let ack_dispute = match candidate.delta_transformer().copied() {
        None => None,
        Some(transformer) => {
            account.refresh_ack_dispute_draft(&candidate, &transformer, incoming.by_left)?
        }
    };
    account.commit_from_peer(
        candidate,
        &frame,
        state_hash,
        incoming.hanko,
        ack_hanko.clone(),
    );
    // The ack this outcome carries is one the Entity commits in the account
    // leaf until a later proposal carries it, so the account remembers sending
    // it rather than the wire remembering for it.
    account.note_outbound_ack(frame.height, state_hash, ack_dispute);
    Ok(IncomingOutcome::Committed {
        height: frame.height,
        state_hash,
        ack_hanko,
        outputs,
        rolled_back_txs,
    })
}

/// Apply the peer's ack of our pending frame.
pub fn apply_incoming_ack(
    account: &mut AccountConsensus,
    counterparty_entity_id: &[u8; 32],
    height: u64,
    state_hash: &[u8; 32],
    hanko: &[u8],
    dispute: Option<crate::consensus::replica::CounterpartyDispute>,
) -> Result<AckOutcome, StateError> {
    // SECURITY: an ack is only evidence when it comes from the party bound to
    // this account.
    //
    // Parity target: the `proofHeader.toEntity` check in
    // core/account/consensus/incoming/ack-commit.ts.
    if counterparty_entity_id != account.replica().counterparty().as_bytes() {
        return Ok(AckOutcome::Rejected {
            reason: "ACCOUNT_PEER_ACK_SIGNER_INVALID".to_string(),
        });
    }
    if let Some(dispute) = dispute.as_ref() {
        validate_counterparty_dispute_shape(dispute)?;
    }
    let Some(pending) = account.pending() else {
        if height > account.current_height()
            && let Some(dispute) = dispute.as_ref()
        {
            verify_counterparty_dispute(account.replica(), counterparty_entity_id, dispute)?;
        }
        return Ok(AckOutcome::Stale { height });
    };
    if height < pending.frame.height {
        return Ok(AckOutcome::Stale { height });
    }
    if let Some(dispute) = dispute.as_ref() {
        verify_counterparty_dispute(account.replica(), counterparty_entity_id, dispute)?;
    }
    if pending.frame.height != height {
        return Ok(AckOutcome::Rejected {
            reason: format!(
                "ACCOUNT_PEER_ACK_UNMATCHED:{height}:{}",
                pending.frame.height
            ),
        });
    }
    if let Some(reason) = counterparty_dispute_requirement_error(
        account.dispute().map(|draft| &draft.proof_body_hash),
        account.counterparty_dispute(),
        account.replica().state().j_nonce(),
        dispute.as_ref(),
    ) {
        return Ok(AckOutcome::Rejected { reason });
    }
    if &pending.state_hash != state_hash {
        return Ok(AckOutcome::Rejected {
            reason: "ACCOUNT_PEER_ACK_HASH_MISMATCH".to_string(),
        });
    }
    verify_frame_hanko(hanko, state_hash, counterparty_entity_id)?;
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
        hanko.to_vec(),
        pending.hanko,
    );
    Ok(AckOutcome::Committed {
        height,
        state_hash: pending.state_hash,
        outputs,
    })
}
