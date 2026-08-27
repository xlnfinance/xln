//! Building, executing and signing our own account frame.
//!
//! Parity target: core/account/consensus/proposal/{propose,frame,transactions}.ts.
//! The window is the whole mempool; a transaction that its own handler rejects
//! is dropped from the frame rather than failing the proposal, and the frame
//! commits the candidate state the surviving transactions produced.

use crate::consensus::frame::hash::AccountFrame;
use crate::consensus::replica::{AccountConsensus, PendingFrame};
use crate::consensus::signing::SigningIdentity;
use crate::error::StateError;
use crate::tx::apply::{AccountVerdict, SequentialAccountEngine};
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
/// The frame's own effects stay with the pending frame until the peer acks
/// it. What travels here instead is what the proposer publishes the moment it
/// signs: the transactions' events, and the outputs its Entity acts on before
/// any acknowledgement exists — a revealed secret, a resting order.
#[derive(Debug)]
pub struct ProposedFrame {
    pub frame: AccountFrame,
    pub state_hash: [u8; 32],
    pub hanko: Vec<u8>,
    pub dropped: Vec<DroppedTx>,
    /// The recovery proof this proposal travels with, when it carries one.
    pub dispute: Option<crate::consensus::replica::DisputeDraft>,
    /// This draft was already certified by the parent Entity. The exact raw
    /// Hanko must accompany a resend; the payment/swap-only RRS profile does
    /// not retain those bytes yet and therefore refuses this output loudly.
    pub dispute_requires_existing_hanko: bool,
    pub events: Vec<String>,
    pub outputs: Vec<AccountOutput>,
    /// Exact outputs of each applied transaction in `frame.txs` order.
    /// Entity follow-ups are transaction-scoped; the flattened `outputs`
    /// field cannot recover that binding when a frame contains repeated tx
    /// kinds or optional outputs.
    pub outputs_by_tx: Vec<Vec<AccountOutput>>,
    /// The acknowledgement this proposal carries, when it carries one. The
    /// publisher sends `frame_ack` rather than `frame` in that case, and must
    /// be told so by the verdict.
    pub bundled_ack: Option<crate::consensus::replica::OutboundAck>,
    /// Same unsupported reuse condition for the ACK half of a frame_ack.
    pub bundled_ack_dispute_requires_existing_hanko: bool,
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
    pub outputs: Vec<AccountOutput>,
    pub outputs_by_tx: Vec<Vec<AccountOutput>>,
    /// What each applied transaction said it did, in transaction order. The
    /// Entity frame commits these strings, so they are part of the transition,
    /// not a log: a cutover that dropped them would sign a different frame.
    pub events: Vec<String>,
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
    let mut outputs = Vec::new();
    let mut outputs_by_tx = Vec::with_capacity(window.len());
    let mut events = Vec::new();
    let mut dropped = Vec::new();
    for (index, admitted_tx) in window.into_iter().enumerate() {
        let tx = prepare_transaction(&candidate, admitted_tx)?;
        let transition =
            SequentialAccountEngine::apply_with_context(&candidate, proposer, &tx, context)
                .map_err(|error| StateError::TransitionFailed(error.to_string()))?;
        match transition.verdict() {
            AccountVerdict::Applied => {
                let tx_outputs = transition.outputs().to_vec();
                let tx_events = transition.events().to_vec();
                let committed = transition.committed().ok_or_else(|| {
                    StateError::TransitionFailed(
                        "ACCOUNT_APPLIED_TRANSITION_WITHOUT_CANDIDATE".to_string(),
                    )
                })?;
                outputs.extend_from_slice(&tx_outputs);
                outputs_by_tx.push(tx_outputs);
                events.extend(tx_events);
                candidate = committed;
                applied.push(tx);
            }
            AccountVerdict::Rejected(rejection) => {
                let rejection = rejection.clone();
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
                        outputs,
                        outputs_by_tx,
                        events,
                        dropped,
                    });
                }
            }
        }
    }
    Ok(WindowExecution {
        candidate,
        applied,
        outputs,
        outputs_by_tx,
        events,
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
    );
    let proposer = account.replica().owner_side();
    let execution = execute_window(account.replica(), proposer, window, &context, false)?;
    let WindowExecution {
        mut candidate,
        applied,
        outputs,
        outputs_by_tx,
        events: _,
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
    let account_state_root = candidate.refresh_account_state_root()?;
    // The recovery proof for the state this frame commits to. Not part of the
    // frame — the counterparty checks the state root, not our proof — but the
    // Entity commits it in the account leaf, so a frame that moved the state
    // and left last frame's proof standing is a leaf nobody else computes.
    //
    // A mirror session carries no transformer address and builds no proof: it
    // is handed each frame and told what it was.
    let certified_dispute_before = account.certified_local_dispute().cloned();
    let proposal_dispute = match candidate.delta_transformer().copied() {
        None => None,
        Some(transformer) => account.refresh_dispute_draft(&candidate, &transformer)?,
    };
    let dispute_requires_existing_hanko = proposal_dispute
        .as_ref()
        .is_some_and(|draft| certified_dispute_before.as_ref() == Some(draft));
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
    let hanko = identity.sign_frame(&state_hash)?;
    // TypeScript publishes only this proposal status line. Transaction
    // handler events are speculative and never enter a later ACK frame.
    let published_events = vec![format!(
        "🚀 Proposed frame {height} with {} transactions",
        transaction_count,
    )];
    let published_outputs = outputs.clone();
    let published_outputs_by_tx = outputs_by_tx.clone();
    account.set_pending(PendingFrame {
        // `set_pending` decides whether this proposal carries the ack we owe.
        bundled_ack: None,
        proposal_dispute: proposal_dispute.clone(),
        frame: frame.clone(),
        state_hash,
        hanko: hanko.clone(),
        candidate,
        outputs,
        outputs_by_tx,
    });
    let bundled_ack = account
        .pending()
        .and_then(|pending| pending.bundled_ack.clone());
    let bundled_ack_dispute_requires_existing_hanko = bundled_ack
        .as_ref()
        .and_then(|ack| ack.dispute.as_ref())
        .is_some_and(|draft| certified_dispute_before.as_ref() == Some(draft));
    Ok(ProposalOutcome::Proposed(Box::new(ProposedFrame {
        frame,
        state_hash,
        hanko,
        dropped,
        dispute: proposal_dispute,
        dispute_requires_existing_hanko,
        events: published_events,
        outputs: published_outputs,
        outputs_by_tx: published_outputs_by_tx,
        bundled_ack,
        bundled_ack_dispute_requires_existing_hanko,
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
