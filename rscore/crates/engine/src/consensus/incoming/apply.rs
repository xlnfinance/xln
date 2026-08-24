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
use crate::error::StateError;
use crate::{AccountExecutionContext, AccountOutput, AccountTx, Side};

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
    Rejected {
        reason: String,
    },
}

#[derive(Debug)]
pub enum AckOutcome {
    /// The peer acknowledged our pending frame; it is committed on both sides.
    Committed {
        height: u64,
        state_hash: [u8; 32],
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
    incoming: IncomingFrame,
) -> Result<IncomingOutcome, StateError> {
    // SECURITY: authenticate before touching any state, exactly as preflight
    // does. An unsigned frame is not evidence of anything.
    verify_frame_hanko(
        &incoming.hanko,
        &incoming.state_hash,
        counterparty_entity_id,
    )?;

    let current_height = account.current_height();
    if incoming.height <= current_height {
        let committed = account.current();
        let duplicate = committed.is_some_and(|frame| {
            frame.height == incoming.height && frame.state_hash == incoming.state_hash
        });
        if duplicate {
            return Ok(IncomingOutcome::Duplicate {
                height: incoming.height,
                state_hash: incoming.state_hash,
                ack_hanko: identity.sign_frame(&incoming.state_hash)?,
            });
        }
        return Ok(rejected(format!(
            "ACCOUNT_PEER_FRAME_STALE:{}:{current_height}",
            incoming.height
        )));
    }

    // Each side may propose once at a height. If both race, the LEFT entity's
    // frame wins: the loser's proposal never acquired the counterparty Hanko
    // it would need to be enforceable.
    let mut rolled_back_txs = 0;
    if let Some(pending) = account.pending()
        && pending.frame.height == incoming.height
    {
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
        rolled_back_txs = account.rollback_pending(incoming.state_hash)?;
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

    let context = AccountExecutionContext::new(
        incoming.timestamp,
        incoming.timestamp,
        incoming.j_height,
        current_height,
        incoming.j_height,
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

    let ack_hanko = identity.sign_frame(&state_hash)?;
    account.commit(candidate, &frame, state_hash);
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
) -> Result<AckOutcome, StateError> {
    let Some(pending) = account.pending() else {
        return Ok(AckOutcome::Stale { height });
    };
    if pending.frame.height != height {
        return Ok(AckOutcome::Rejected {
            reason: format!(
                "ACCOUNT_PEER_ACK_UNMATCHED:{height}:{}",
                pending.frame.height
            ),
        });
    }
    if &pending.state_hash != state_hash {
        return Ok(AckOutcome::Rejected {
            reason: "ACCOUNT_PEER_ACK_HASH_MISMATCH".to_string(),
        });
    }
    verify_frame_hanko(hanko, state_hash, counterparty_entity_id)?;
    let pending = account.pending().expect("pending checked above").clone();
    account.commit(pending.candidate, &pending.frame, pending.state_hash);
    Ok(AckOutcome::Committed {
        height,
        state_hash: pending.state_hash,
    })
}
