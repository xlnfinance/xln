//! Building, executing and signing our own account frame.
//!
//! Parity target: core/account/consensus/proposal/{propose,frame,transactions}.ts.
//! The window is the whole mempool; a transaction that its own handler rejects
//! is dropped from the frame rather than failing the proposal, and the frame
//! commits the candidate state the surviving transactions produced.

use std::sync::Arc;

use crate::consensus::frame::hash::AccountFrame;
use crate::consensus::replica::{AccountConsensus, PendingFrame};
use crate::consensus::signing::SigningIdentity;
use crate::error::StateError;
use crate::tx::apply::apply_to_candidate;
use crate::tx::apply_types::{AccountConsensusEffect, MutationDecision};
use crate::{
    AccountExecutionContext, AccountOutput, AccountRejection, AccountReplica, AccountTx, Side,
};

/// One transaction the proposer could not include, with the reason its own
/// handler gave. The runtime reports these to the payer; they are not frame
/// failures.
#[derive(Clone, Debug)]
pub struct DroppedTx {
    pub index: usize,
    pub tx: AccountTx,
    pub rejection: AccountRejection,
    /// What became of it: back on the queue, or gone.
    pub disposition: Disposition,
}

/// Parity target: `ACCOUNT_TX_FAILURE_DISPOSITIONS`
/// (core/account/consensus/proposal/transactions.ts).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Disposition {
    /// Requeued for the next frame — the rejection was a "not yet".
    Deferred,
    /// Dropped from the queue: the rejection was about the transaction.
    Removed,
}

/// Whether a rejected transaction goes back on the queue or is dropped.
///
/// Parity target: `proposalFailureDisposition`
/// (core/account/consensus/proposal/transactions.ts): a capacity rejection is
/// a "not yet", so the transaction is deferred to the next frame rather than
/// deleted. Everything else is a decision about the transaction itself.
const fn is_retryable(rejection: &AccountRejection) -> bool {
    matches!(rejection, AccountRejection::HtlcLockCapacity { .. })
}

/// Transactions whose rejection is a fault of the machine that queued them,
/// not of the payer.
///
/// Parity target: `throwCriticalProposalFailure` (same file). A rejected
/// `swap_resolve` comes from the deterministic matcher: dropping it would
/// commit a matched book while discarding its bilateral settlement, which
/// diverges the two sides permanently. Fail the proposal instead.
fn critical_kind(tx: &AccountTx) -> Option<&'static str> {
    match tx {
        AccountTx::SwapResolve { .. } => Some("swap_resolve"),
        _ => None,
    }
}

/// A frame this side built, signed, and is waiting to have acknowledged.
///
/// The frame's own effects stay with the pending frame until the peer acks it.
/// The shared per-tx rows below exist for the TS Account-cutover wire response;
/// resident Entity execution does not release them before acknowledgement.
#[derive(Debug)]
pub struct ProposedFrame {
    pub frame: AccountFrame,
    pub state_hash: [u8; 32],
    /// Raw signature created together with `hanko`. The parent Entity reuses
    /// these exact bytes in its manifest instead of signing the same Account
    /// digest a second time on the coordinator thread.
    pub signature: [u8; 65],
    pub hanko: Vec<u8>,
    /// Dispute witness authored on the same resident Account worker. The
    /// Entity manifest consumes these bytes after the worker result returns.
    pub dispute_signature: Option<[u8; 65]>,
    pub dispute_hanko: Option<Vec<u8>>,
    pub dropped: Vec<DroppedTx>,
    /// The recovery proof this proposal travels with, when it carries one.
    pub dispute: Option<crate::consensus::replica::DisputeDraft>,
    pub events: Vec<String>,
    /// Sole exact effect representation in `frame.txs` order. The old flat
    /// mirror is derived only while encoding the TS process boundary.
    pub outputs_by_tx: Arc<Vec<Vec<AccountOutput>>>,
    /// The acknowledgement this proposal carries, when it carries one. The
    /// publisher sends `ack_frame` rather than `frame` in that case, and must
    /// be told so by the verdict.
    pub bundled_ack: Option<crate::consensus::replica::OutboundAck>,
}

#[derive(Debug)]
pub enum ProposalOutcome {
    /// Nothing to propose: an empty queue, a frame already in flight, or a
    /// window where every transaction was rejected.
    Idle {
        dropped: Vec<DroppedTx>,
    },
    Proposed(Box<ProposedFrame>),
}

/// Execute a window against a candidate, keeping the transactions that apply.
pub(crate) struct WindowExecution {
    pub candidate: AccountReplica,
    pub applied: Vec<AccountTx>,
    pub outputs_by_tx: Vec<Vec<AccountOutput>>,
    /// What each applied transaction said it did, in transaction order. The
    /// Entity frame commits these strings, so they are part of the transition,
    /// not a log: a cutover that dropped them would sign a different frame.
    pub events: Vec<String>,
    pub consensus_effects: Vec<AccountConsensusEffect>,
    pub dropped: Vec<DroppedTx>,
}

pub(crate) fn execute_window(
    base: &AccountReplica,
    proposer: Side,
    window: Vec<AccountTx>,
    context: &AccountExecutionContext,
    stop_on_rejection: bool,
) -> Result<WindowExecution, StateError> {
    let mut candidate = base.clone();
    let mut applied = Vec::with_capacity(window.len());
    let mut outputs_by_tx = Vec::with_capacity(window.len());
    let mut events = Vec::new();
    let mut consensus_effects = Vec::new();
    let mut dropped = Vec::new();
    for (index, admitted_tx) in window.into_iter().enumerate() {
        let tx = prepare_transaction(&candidate, admitted_tx)?;
        // Incoming signed frames are atomic: one rejected tx rejects the whole
        // frame, so no per-tx rollback copy is observable or useful. Locally
        // authored windows still need a trial copy because one rejected tx is
        // removed/deferred while later txs continue against the prior state.
        let mut trial = (!stop_on_rejection).then(|| candidate.clone());
        let target = trial.as_mut().unwrap_or(&mut candidate);
        let decision = apply_to_candidate(target, proposer, &tx, Some(context))
            .map_err(|error| StateError::TransitionFailed(error.to_string()))?;
        match decision {
            MutationDecision::Applied {
                events: tx_events,
                outputs: tx_outputs,
                consensus_effects: tx_effects,
            } => {
                if let Some(committed) = trial {
                    candidate = committed;
                }
                outputs_by_tx.push(tx_outputs);
                events.extend(tx_events);
                consensus_effects.extend(tx_effects);
                applied.push(tx);
            }
            MutationDecision::Rejected {
                rejection,
                events: _,
            } => {
                let disposition = if is_retryable(&rejection) {
                    Disposition::Deferred
                } else {
                    Disposition::Removed
                };
                dropped.push(DroppedTx {
                    index,
                    tx,
                    rejection,
                    disposition,
                });
                if stop_on_rejection {
                    return Ok(WindowExecution {
                        candidate,
                        applied,
                        outputs_by_tx,
                        events,
                        consensus_effects,
                        dropped,
                    });
                }
            }
        }
    }
    Ok(WindowExecution {
        candidate,
        applied,
        outputs_by_tx,
        events,
        consensus_effects,
        dropped,
    })
}

fn prepare_transaction(candidate: &AccountReplica, tx: AccountTx) -> Result<AccountTx, StateError> {
    let AccountTx::JEventClaim(claim) = tx else {
        return Ok(tx);
    };
    let carried = candidate.state().carried();
    Ok(AccountTx::JEventClaim(crate::prepare_claim_tx(
        candidate.state().identity(),
        &carried.left_pending_j_claims,
        &carried.right_pending_j_claims,
        &claim,
        candidate.state().j_claim_store(),
    )?))
}

/// Propose the next frame for this account.
pub fn propose_account_frame(
    account: &mut AccountConsensus,
    identity: &SigningIdentity,
    entity_timestamp: u64,
    j_height: u64,
    // Registry tables, not account state: the caller installs the same market
    // the runtime would, or a swap would price itself differently here than
    // in TypeScript.
    swap_market: &std::sync::Arc<crate::SwapMarketPolicy>,
) -> Result<ProposalOutcome, StateError> {
    if account.pending().is_some() {
        // One proposal per height. The peer either acks it or wins the
        // collision; a second frame here would fork our own chain.
        return Ok(ProposalOutcome::Idle {
            dropped: Vec::new(),
        });
    }
    let window = account.take_mempool();
    if window.is_empty() {
        return Ok(ProposalOutcome::Idle {
            dropped: Vec::new(),
        });
    }
    // Dual Runtime peers may observe the same bilateral Account at different
    // Entity clocks. The canonical TypeScript proposer never lets a new frame
    // move behind the already committed Account watermark: doing so would
    // produce a frame the receiver rejects even though both sides agree on
    // the previous state. Keep this clamp here, inside the Account machine,
    // so every caller (resident, batch and replay) uses the same rule.
    let timestamp = account.current().map_or(entity_timestamp, |current| {
        entity_timestamp.max(current.frame.timestamp)
    });
    let height = account.current_height() + 1;
    let context = AccountExecutionContext::with_market(
        timestamp,
        timestamp,
        j_height,
        account.current_height(),
        j_height,
        std::sync::Arc::clone(swap_market),
    )
    .with_settlement(account.settlement_execution_context(account.local_board_authority()));
    let proposer = account.replica().owner_side();
    let execution = execute_window(account.replica(), proposer, window, &context, false)?;
    let WindowExecution {
        mut candidate,
        applied,
        outputs_by_tx,
        events: _,
        consensus_effects,
        dropped,
    } = execution;
    // A rejection the machine itself caused is not a dropped transaction.
    if let Some(dropped_tx) = dropped
        .iter()
        .find(|dropped| critical_kind(&dropped.tx).is_some())
    {
        let kind = critical_kind(&dropped_tx.tx).unwrap_or("unknown");
        return Err(StateError::CriticalProposalFailure {
            kind,
            reason: dropped_tx.rejection.message(),
        });
    }
    // Capacity rejections go back on the queue, in their original order and
    // ahead of anything admitted since, so the next frame retries them.
    let deferred: Vec<AccountTx> = dropped
        .iter()
        .filter(|dropped| dropped.disposition == Disposition::Deferred)
        .map(|dropped| dropped.tx.clone())
        .collect();
    if !deferred.is_empty() {
        account.restore_mempool_front(deferred)?;
    }
    if applied.is_empty() {
        return Ok(ProposalOutcome::Idle { dropped });
    }
    account.apply_consensus_effects(&consensus_effects)?;
    let account_state_root = candidate.refresh_account_state_root()?;
    // The recovery proof for the state this frame commits to. Not part of the
    // frame — the counterparty checks the state root, not our proof — but the
    // Entity commits it in the account leaf, so a frame that moved the state
    // and left last frame's proof standing is a leaf nobody else computes.
    //
    // A jurisdiction without a transformer requires no dispute proof.
    let proposal_dispute = match candidate.delta_transformer().copied() {
        None => None,
        Some(transformer) => account.refresh_dispute_draft(&candidate, &transformer)?,
    };
    let (dispute_signature, dispute_hanko) = match proposal_dispute.as_ref() {
        Some(dispute) if dispute.hanko.is_none() => {
            let (signature, hanko) = identity.sign_frame_with_raw(&dispute.hash)?;
            (Some(signature), Some(hanko))
        }
        Some(_) | None => (None, None),
    };
    let transaction_count = applied.len();
    let frame = AccountFrame {
        height,
        timestamp,
        j_height,
        txs: applied,
        prev_frame_hash: account.prev_frame_hash(),
        account_state_root,
    };
    let state_hash = frame.hash()?;
    let (signature, hanko) = identity.sign_frame_with_raw(&state_hash)?;
    // TypeScript publishes only this proposal status line. Transaction
    // handler events are speculative and never enter a later ACK frame.
    let published_events = vec![format!(
        "🚀 Proposed frame {height} with {} transactions",
        transaction_count,
    )];
    // Pending consensus and this transient proposal view need the same exact
    // effects. Share the immutable vectors until the proposal view is dropped;
    // the later ACK then recovers sole ownership without copying their bodies.
    let outputs_by_tx = Arc::new(outputs_by_tx);
    account.set_pending(PendingFrame {
        // `set_pending` decides whether this proposal carries the ack we owe.
        bundled_ack: None,
        proposal_dispute: proposal_dispute.clone(),
        frame: frame.clone(),
        state_hash,
        hanko: hanko.clone(),
        candidate,
        outputs_by_tx: Arc::clone(&outputs_by_tx),
    });
    // The worker that created this witness already owns the Account envelope.
    // Retain it here instead of launching another sharded round after Entity
    // certification merely to copy the same bytes back into this Account.
    // The returned dispute below remains the pre-attach clone, so Entity keeps
    // the exact same secondary manifest entry and presigned witness.
    if let (Some(dispute), Some(hanko)) = (&proposal_dispute, &dispute_hanko) {
        account.attach_locally_signed_dispute_hanko(dispute.hash, hanko.clone())?;
    }
    let bundled_ack = account
        .pending()
        .and_then(|pending| pending.bundled_ack.clone());
    Ok(ProposalOutcome::Proposed(Box::new(ProposedFrame {
        frame,
        state_hash,
        signature,
        hanko,
        dispute_signature,
        dispute_hanko,
        dropped,
        dispute: proposal_dispute,
        events: published_events,
        outputs_by_tx,
        bundled_ack,
    })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use num_bigint::BigInt;

    /// The matcher's own transactions are never dropped from a window: a
    /// rejected `swap_resolve` would commit a matched book without its
    /// bilateral settlement.
    #[test]
    fn the_matchers_transactions_are_critical() {
        let resolve = AccountTx::SwapResolve {
            offer_id: "offer-1".to_string(),
            fill_ratio: 10_000,
            fill_numerator: None,
            fill_denominator: None,
            cancel_remainder: false,
            comment: None,
            fee_token_id: None,
            fee_amount: None,
            execution_give_amount: None,
            execution_want_amount: None,
            resting_give_token_id: None,
            resting_want_token_id: None,
            resting_price_ticks: None,
            resting_give_amount: None,
            resting_want_amount: None,
            resting_quantized_give: None,
            resting_quantized_want: None,
        };
        assert_eq!(critical_kind(&resolve), Some("swap_resolve"));

        let payment = AccountTx::DirectPayment {
            token_id: crate::TokenId::new(1).expect("token"),
            amount: BigInt::from(1),
            route: Vec::new(),
            description: None,
            from_entity_id: format!("0x{}", "11".repeat(32)),
            to_entity_id: format!("0x{}", "22".repeat(32)),
            delivery_mode: crate::DeliveryMode::Direct,
            trusted_gateway_entity_id: None,
        };
        assert_eq!(critical_kind(&payment), None);
    }

    /// Only a capacity rejection is a retry; a payer's own invalid transaction
    /// is not requeued for ever.
    #[test]
    fn only_capacity_is_retried() {
        assert!(is_retryable(&AccountRejection::HtlcLockCapacity {
            maximum: 32
        }));
        assert!(!is_retryable(&AccountRejection::DeltaRowLimitExceeded {
            attempted: 9,
            maximum: 8
        }));
    }
}
